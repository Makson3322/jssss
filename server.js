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

// ----- Middleware -----
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

// ----- Пользователи -----
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
    console.log(`✅ Создан пользователь: devmaks / ${streamerPassword}`);
    return defaultUsers;
  }
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch(e) {
    return {};
  }
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

// ----- Маршруты -----
app.get('/', (req, res) => {
  res.redirect('/login');
});

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
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  res.json({ ok: true, username, password: plainPassword });
});

app.delete('/api/moderators/:username', requireStreamer, (req, res) => {
  const username = req.params.username.toLowerCase();
  if (username === 'devmaks') return res.status(403).json({ error: 'Нельзя удалить главного стримера' });
  if (!users[username] || users[username].role !== 'moderator') return res.status(404).json({ error: 'Модератор не найден' });
  delete users[username];
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
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

// ----- Комнаты -----
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

// ----- Socket.IO -----
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
    socket.emit('room_state', clone(ensureRoom(room)));
    if (typeof ack === 'function') ack({ ok: true, room });
  });

  const canModify = () => {
    if (!currentUser) return false;
    const role = users[currentUser]?.role;
    return role === 'streamer' || role === 'moderator';
  };

  socket.on('add_element', (payload, ack) => {
    if (!canModify()) return;
    const room = currentRoom;
    const state = ensureRoom(room);
    const obj = normalizeObject(payload);
    state.objects[obj.id] = obj;
    io.to(room).emit('element_added', clone(obj));
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('update_element', (payload, ack) => {
    if (!canModify()) return;
    const room = currentRoom;
    const state = ensureRoom(room);
    const id = String(payload.id || '');
    if (!state.objects[id]) return;
    state.objects[id] = normalizeObject({ ...state.objects[id], ...payload, id });
    io.to(room).emit('element_updated', clone(state.objects[id]));
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('remove_element', (payload, ack) => {
    if (!canModify()) return;
    const room = currentRoom;
    const state = ensureRoom(room);
    const id = String(payload.id || '');
    if (state.objects[id]) {
      delete state.objects[id];
      io.to(room).emit('element_removed', { id });
    }
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('clear_canvas', (payload, ack) => {
    if (!canModify()) return;
    const room = currentRoom;
    const state = ensureRoom(room);
    state.objects = {};
    io.to(room).emit('canvas_cleared', {});
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
