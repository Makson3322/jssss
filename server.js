const express = require('express');
const http = require('http');
const path = require('path');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;
const DEFAULT_RESOLUTION = { w: 1920, h: 1080 };

app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));
app.use(cookieParser());
app.use(session({
  secret: 'poltergeist_secret_key_change_me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Пользователи ----------
const USERS_FILE = path.join(__dirname, 'users.json');

function hashPassword(pwd) {
  return crypto.createHash('sha256').update(pwd).digest('hex');
}

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    const streamerPassword = 'maksim3210?!#$!!';
    const streamerHash = hashPassword(streamerPassword);
    const defaultUsers = {
      devmaks: {
        username: 'devmaks',
        passwordHash: streamerHash,
        role: 'streamer',
        plainPassword: null
      }
    };
    fs.writeFileSync(USERS_FILE, JSON.stringify(defaultUsers, null, 2));
    console.log(`✅ Создан пользователь streamer: devmaks / ${streamerPassword}`);
    return defaultUsers;
  }
  try {
    const data = fs.readFileSync(USERS_FILE, 'utf8');
    return JSON.parse(data);
  } catch(e) {
    return {};
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

let users = loadUsers();
const onlineUsers = new Map();

function generateRandomPassword(len = 10) {
  return crypto.randomBytes(len).toString('hex').slice(0, len);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.redirect('/login');
}

function requireStreamer(req, res, next) {
  if (req.session?.user?.role === 'streamer') return next();
  res.status(403).json({ error: 'Доступ только для стримера' });
}

function requireModerator(req, res, next) {
  const role = req.session?.user?.role;
  if (role === 'streamer' || role === 'moderator') return next();
  res.status(403).json({ error: 'Необходима авторизация' });
}

// ---------- Маршруты ----------
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Заполните оба поля' });
  }
  const user = users[username];
  if (!user || user.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  req.session.user = { username: user.username, role: user.role };
  res.json({ ok: true, role: user.role });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/api/me', (req, res) => {
  if (req.session.user) {
    res.json({ username: req.session.user.username, role: req.session.user.role });
  } else {
    res.status(401).json({ error: 'Не авторизован' });
  }
});

app.get('/admin.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/obs.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'obs.html'));
});

app.get('/api/moderators', requireModerator, (req, res) => {
  const moderators = Object.values(users)
    .filter(u => u.role === 'moderator')
    .map(u => ({
      username: u.username,
      role: u.role,
      online: Array.from(onlineUsers.values()).includes(u.username),
      plainPassword: (req.session.user.role === 'streamer' && u.plainPassword) || null
    }));
  res.json(moderators);
});

app.post('/api/moderators', requireStreamer, (req, res) => {
  let { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Введите никнейм' });
  username = username.trim().toLowerCase();
  if (users[username]) return res.status(400).json({ error: 'Пользователь уже существует' });
  const plainPassword = generateRandomPassword(10);
  const passwordHash = hashPassword(plainPassword);
  users[username] = { username, passwordHash, plainPassword, role: 'moderator' };
  saveUsers(users);
  res.json({ ok: true, username, password: plainPassword });
});

app.delete('/api/moderators/:username', requireStreamer, (req, res) => {
  const username = req.params.username.toLowerCase();
  if (username === 'devmaks') return res.status(403).json({ error: 'Нельзя удалить главного стримера' });
  if (!users[username] || users[username].role !== 'moderator') return res.status(404).json({ error: 'Модератор не найден' });
  delete users[username];
  saveUsers(users);
  for (let [sid, uname] of onlineUsers.entries()) {
    if (uname === username) {
      const sock = io.sockets.sockets.get(sid);
      if (sock) sock.disconnect(true);
      onlineUsers.delete(sid);
    }
  }
  io.emit('moderators_update');
  res.json({ ok: true });
});

app.get('/api/moderators/:username/password', requireStreamer, (req, res) => {
  const username = req.params.username.toLowerCase();
  const user = users[username];
  if (!user || user.role !== 'moderator') return res.status(404).json({ error: 'Модератор не найден' });
  res.json({ password: user.plainPassword || 'Пароль не сохранён' });
});

// ---------- Состояние комнат (in-memory) ----------
const roomsState = {};

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function ensureRoom(room) {
  const name = String(room || 'default').trim() || 'default';
  if (!roomsState[name]) {
    roomsState[name] = {
      meta: { 
        resolution: { ...DEFAULT_RESOLUTION }, 
        currentLayer: '1', 
        logs: [], 
        moderators: [], 
        scenes: {}, 
        presets: {}, 
        sounds: [] 
      },
      objects: {}
    };
  }
  return roomsState[name];
}

function log(room, actor, message) {
  const state = ensureRoom(room);
  const entry = { 
    id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`, 
    ts: Date.now(), 
    actor: String(actor || 'system'), 
    message: String(message || '') 
  };
  state.meta.logs.unshift(entry);
  state.meta.logs = state.meta.logs.slice(0, 50);
  io.to(String(room)).emit('log_added', entry);
  return entry;
}

function normalizeUrl(input) {
  let url = String(input || '').trim();
  if (!url) return '';
  if (/^(javascript|data|vbscript|blob):/i.test(url)) return 'about:blank';
  if (/^about:blank$/i.test(url)) return 'about:blank';
  if (/^https?:\/\//i.test(url)) return url;
  if (/^\/\//.test(url)) return `https:${url}`;
  return `https://${url.replace(/^\/*/, '')}`;
}

function normalizeObject(input) {
  const o = { ...(input || {}) };
  o.id = String(o.id || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`);
  o.type = String(o.type || 'text');
  o.name = String(o.name || o.type);
  o.text = String(o.text ?? '');
  if (o.type === 'image') o.src = String(o.src ?? '');
  else if (o.type === 'browser' || o.type === 'video') o.src = normalizeUrl(o.src);
  else o.src = String(o.src ?? '');
  o.left = Number(o.left) || 0;
  o.top = Number(o.top) || 0;
  o.width = Math.max(16, Number(o.width) || 320);
  o.height = Math.max(16, Number(o.height) || 180);
  o.scaleX = Number(o.scaleX) || 1;
  o.scaleY = Number(o.scaleY) || 1;
  o.angle = Number(o.angle) || 0;
  o.opacity = Math.min(1, Math.max(0, Number(o.opacity) || 1));
  o.layer = String(o.layer || '1');
  o.visible = o.visible !== false;
  o.locked = !!o.locked;
  o.zIndex = Number(o.zIndex) || 0;
  o.color = String(o.color || '#ffffff');
  o.bg = String(o.bg || 'rgba(0,0,0,.2)');
  o.borderColor = String(o.borderColor || '#7b2cbf');
  o.borderWidth = Number(o.borderWidth) || 2;
  o.radius = Number(o.radius) || 10;
  o.fontSize = Number(o.fontSize) || 42;
  o.fontWeight = Number(o.fontWeight) || 800;
  o.align = String(o.align || 'center');
  o.qrText = String(o.qrText ?? o.text ?? o.src ?? '');
  o.items = Array.isArray(o.items) ? o.items : [];
  o.data = (o.data && typeof o.data === 'object') ? o.data : {};
  o.muted = !!o.muted;
  o.volume = Math.min(1, Math.max(0, Number(o.volume) || 1));
  o.playing = !!o.playing;
  if (o.type === 'timer') {
    o.timerDuration = Math.max(0, Number(o.timerDuration) || 300000);
    o.timerStatus = ['running','paused','stopped'].includes(o.timerStatus) ? o.timerStatus : 'stopped';
    o.timerRemaining = Math.max(0, Number(o.timerRemaining) || o.timerDuration);
    o.endsAt = o.timerStatus === 'running' ? (Date.now() + o.timerRemaining) : null;
  }
  return o;
}

function broadcastRoomState(room) { 
  io.to(String(room)).emit('room_state', clone(ensureRoom(room))); 
}

function scaleObjectsForResolution(state, nextRes) {
  const prev = state.meta.resolution || DEFAULT_RESOLUTION;
  const rx = nextRes.w / prev.w, ry = nextRes.h / prev.h;
  Object.values(state.objects).forEach(o => {
    o.left = Math.round(o.left * rx); 
    o.top = Math.round(o.top * ry);
    o.width = Math.max(16, Math.round(o.width * rx)); 
    o.height = Math.max(16, Math.round(o.height * ry));
    if (typeof o.fontSize === 'number') o.fontSize = Math.max(8, Math.round(o.fontSize * ry));
  });
}

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  console.log('🔌 Клиент подключился:', socket.id);
  let currentUser = null;
  let currentRoom = 'default';

  socket.on('auth', (data) => {
    const username = data?.username;
    console.log(`🔐 Auth от ${username}`);
    if (username && users[username]) {
      currentUser = username;
      onlineUsers.set(socket.id, currentUser);
      io.emit('moderators_update');
      socket.emit('auth_response', { role: users[username].role });
    }
  });

  socket.on('join_room', (payload, ack) => {
    const room = String(payload?.room || 'default').trim() || 'default';
    currentRoom = room;
    socket.join(room);
    console.log(`🏠 Клиент ${socket.id} присоединился к комнате: ${room}`);
    const state = ensureRoom(room);
    socket.emit('room_state', clone(state));
    if (typeof ack === 'function') ack({ ok: true, room });
  });

  const canModify = () => {
    if (!currentUser) return false;
    const role = users[currentUser]?.role;
    return role === 'streamer' || role === 'moderator';
  };

  socket.on('add_element', (payload, ack) => {
    if (!canModify()) {
      console.log('❌ Нет прав на добавление');
      if (typeof ack === 'function') ack({ ok: false, error: 'no_permission' });
      return;
    }
    const room = currentRoom;
    console.log(`➕ Добавление элемента в комнату ${room}:`, payload.type);
    const state = ensureRoom(room);
    const obj = normalizeObject(payload);
    state.objects[obj.id] = obj;
    io.to(room).emit('element_added', clone(obj));
    log(room, currentUser, `Spawned ${String(obj.type).toUpperCase()}`);
    if (typeof ack === 'function') ack({ ok: true, object: clone(obj) });
  });

  socket.on('update_element', (payload, ack) => {
    if (!canModify()) return;
    const room = currentRoom;
    const state = ensureRoom(room);
    const id = String(payload.id || '');
    if (!state.objects[id]) {
      if (typeof ack === 'function') ack({ ok: false, error: 'not_found' });
      return;
    }
    const merged = normalizeObject({ ...state.objects[id], ...payload, id });
    state.objects[id] = merged;
    io.to(room).emit('element_updated', clone(merged));
    if (typeof ack === 'function') ack({ ok: true, object: clone(merged) });
  });

  socket.on('remove_element', (payload, ack) => {
    if (!canModify()) return;
    const room = currentRoom;
    const state = ensureRoom(room);
    const id = String(payload.id || '');
    if (state.objects[id]) {
      delete state.objects[id];
      io.to(room).emit('element_removed', { id });
      log(room, currentUser, 'Deleted element');
      if (typeof ack === 'function') ack({ ok: true });
    }
  });

  socket.on('clear_canvas', (payload, ack) => {
    if (!canModify()) return;
    const room = currentRoom;
    const state = ensureRoom(room);
    state.objects = {};
    io.to(room).emit('canvas_cleared', {});
    log(room, currentUser, 'Cleared canvas');
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('set_resolution', (payload, ack) => {
    if (!canModify()) return;
    const room = currentRoom;
    const state = ensureRoom(room);
    const nextRes = { 
      w: Math.max(640, Math.round(payload.w || 1920)), 
      h: Math.max(360, Math.round(payload.h || 1080)) 
    };
    scaleObjectsForResolution(state, nextRes);
    state.meta.resolution = nextRes;
    broadcastRoomState(room);
    log(room, currentUser, `Resolution changed to ${nextRes.w}x${nextRes.h}`);
    if (typeof ack === 'function') ack({ ok: true, resolution: nextRes });
  });

  socket.on('set_layer', (payload, ack) => {
    if (!canModify()) return;
    const room = currentRoom;
    const state = ensureRoom(room);
    state.meta.currentLayer = String(payload.layer || '1');
    io.to(room).emit('meta_updated', clone(state.meta));
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('save_scene', (payload, ack) => {
    if (!canModify()) return;
    const room = currentRoom;
    const state = ensureRoom(room);
    const name = String(payload.name || '').trim();
    if (!name) return;
    state.meta.scenes[name] = { 
      name, 
      resolution: clone(state.meta.resolution), 
      objects: clone(state.objects), 
      createdAt: Date.now() 
    };
    io.to(room).emit('meta_updated', clone(state.meta));
    log(room, currentUser, `Saved scene "${name}"`);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('load_scene', (payload, ack) => {
    if (!canModify()) return;
    const room = currentRoom;
    const state = ensureRoom(room);
    const name = String(payload.name || '').trim();
    const scene = state.meta.scenes[name];
    if (!scene) return;
    state.meta.resolution = clone(scene.resolution);
    state.objects = {};
    Object.values(scene.objects || {}).forEach(o => { state.objects[o.id] = normalizeObject(o); });
    broadcastRoomState(room);
    log(room, currentUser, `Loaded scene "${name}"`);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('save_preset', (payload, ack) => {
    if (!canModify()) return;
    const room = currentRoom;
    const state = ensureRoom(room);
    const name = String(payload.name || '').trim();
    if (!name) return;
    state.meta.presets[name] = { name, objects: clone(state.objects), createdAt: Date.now() };
    io.to(room).emit('meta_updated', clone(state.meta));
    log(room, currentUser, `Saved preset "${name}"`);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('load_preset', (payload, ack) => {
    if (!canModify()) return;
    const room = currentRoom;
    const state = ensureRoom(room);
    const name = String(payload.name || '').trim();
    const preset = state.meta.presets[name];
    if (!preset) return;
    state.objects = {};
    Object.values(preset.objects || {}).forEach(o => { state.objects[o.id] = normalizeObject(o); });
    broadcastRoomState(room);
    log(room, currentUser, `Loaded preset "${name}"`);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('save_sound', (payload, ack) => {
    if (!canModify()) return;
    const room = currentRoom;
    const state = ensureRoom(room);
    const name = String(payload.name || 'Sound').trim() || 'Sound';
    const url = normalizeUrl(payload.url || '');
    if (!url) return;
    const sound = { 
      id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`, 
      name, url, volume: 1 
    };
    state.meta.sounds.push(sound);
    io.to(room).emit('meta_updated', clone(state.meta));
    log(room, currentUser, `Added sound "${name}"`);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('remove_sound', (payload, ack) => {
    if (!canModify()) return;
    const room = currentRoom;
    const state = ensureRoom(room);
    const id = String(payload.id || '');
    state.meta.sounds = state.meta.sounds.filter(s => s.id !== id);
    io.to(room).emit('meta_updated', clone(state.meta));
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('play_sound', (payload, ack) => {
    const room = currentRoom;
    const state = ensureRoom(room);
    const id = String(payload.id || '');
    const sound = state.meta.sounds.find(s => s.id === id);
    if (sound) io.to(room).emit('sound_play', clone(sound));
    if (typeof ack === 'function') ack({ ok: !!sound });
  });

  socket.on('stop_sounds', (payload, ack) => {
    const room = currentRoom;
    io.to(room).emit('sounds_stop', {});
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('disconnect', () => {
    if (currentUser) {
      onlineUsers.delete(socket.id);
      io.emit('moderators_update');
      console.log(`👋 Пользователь ${currentUser} отключился`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
  console.log(`🔐 Логин: http://localhost:${PORT}/login`);
  console.log(`📺 OBS: http://localhost:${PORT}/obs.html`);
});
