(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const room = new URLSearchParams(location.search).get('room') || 'default';

  const viewport = $('#viewport');
  const world = $('#world');

  const state = {
    resolution: { w: 1920, h: 1080 },
    meta: { currentLayer: '1' },
    objects: {},
    hash: '',
    zoom: 1,
    panX: 0,
    panY: 0,
    socketReady: false,
    pollTimer: null,
    fallbackTimer: null,
    renderQueued: false,
    pendingFullSync: false
  };

  function normalizeUrl(input) {
    let url = String(input || '').trim();
    if (!url) return '';
    if (/^(javascript|data|vbscript|blob):/i.test(url)) return 'about:blank';
    if (/^about:blank$/i.test(url)) return 'about:blank';
    if (/^https?:\/\//i.test(url)) return url;
    if (/^\/\//.test(url)) return `https:${url}`;
    return `https://${url.replace(/^\/*/, '')}`;
  }

  function youtubeEmbedUrl(url) {
    const s = String(url || '');
    const m = s.match(/(?:youtu\.be\/|v=|embed\/)([A-Za-z0-9_-]{11})/);
    return m ? `https://www.youtube.com/embed/${m[1]}?autoplay=1&mute=1&loop=1&playlist=${m[1]}` : null;
  }

  function stableHash(v) {
    try { return JSON.stringify(v || {}); } catch { return String(Date.now()); }
  }

  function normalizeObject(o) {
    const obj = { ...(o || {}) };
    obj.id = String(obj.id || '');
    obj.type = String(obj.type || 'text');
    obj.name = String(obj.name || obj.type);
    obj.text = String(obj.text ?? '');
    obj.src = String(obj.src ?? '');
    obj.left = Number(obj.left || 0);
    obj.top = Number(obj.top || 0);
    obj.width = Math.max(16, Number(obj.width || 320));
    obj.height = Math.max(16, Number(obj.height || 180));
    obj.angle = Number(obj.angle || 0);
    obj.opacity = Math.max(0, Math.min(1, Number.isFinite(+obj.opacity) ? +obj.opacity : 1));
    obj.visible = obj.visible !== false;
    obj.layer = String(obj.layer || '1');
    obj.color = String(obj.color || '#fff');
    obj.bg = String(obj.bg || 'rgba(0,0,0,.2)');
    obj.borderColor = String(obj.borderColor || '#7b2cbf');
    obj.borderWidth = Number(obj.borderWidth || 2);
    obj.radius = Number(obj.radius || 10);
    obj.fontSize = Number(obj.fontSize || 42);
    obj.fontWeight = Number(obj.fontWeight || 700);
    obj.align = String(obj.align || 'center');
    obj.data = (obj.data && typeof obj.data === 'object') ? obj.data : {};
    obj.items = Array.isArray(obj.items) ? obj.items : [];
    obj.activeIndex = Number(obj.activeIndex || 0);
    obj.qrText = String(obj.qrText ?? obj.text ?? obj.src ?? '');
    return obj;
  }

  function isMediaLike(obj) {
    return ['image', 'video', 'browser', 'mediashare'].includes(String(obj?.type || '').toLowerCase());
  }

  function contentKey(obj) {
    if (!obj) return '';
    return [
      obj.type, obj.src, obj.text, obj.qrText, obj.bg, obj.color,
      obj.fontSize, obj.fontWeight, obj.radius, obj.borderColor, obj.borderWidth,
      JSON.stringify(obj.items || []), JSON.stringify(obj.data || {})
    ].join('|');
  }

  function renderAssetContent(obj, inner) {
    if (!inner) return;
    inner.innerHTML = '';
    const type = String(obj.type || '').toLowerCase();

    if (type === 'image') {
      const img = document.createElement('img');
      img.src = obj.src || '';
      img.alt = obj.name || 'image';
      img.draggable = false;
      img.loading = 'eager';
      img.decoding = 'async';
      img.crossOrigin = 'anonymous';
      img.referrerPolicy = 'no-referrer';
      img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;background:transparent;';
      inner.appendChild(img);
      return;
    }

    if (type === 'video') {
      const yt = youtubeEmbedUrl(obj.src);
      if (yt) {
        const frame = document.createElement('iframe');
        frame.src = yt;
        frame.allow = 'autoplay; encrypted-media; fullscreen';
        frame.style.cssText = 'width:100%;height:100%;border:none;display:block;background:transparent;';
        inner.appendChild(frame);
        return;
      }
      const video = document.createElement('video');
      video.src = normalizeUrl(obj.src);
      video.autoplay = true;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.webkitPlaysInline = true;
      video.preload = 'auto';
      video.controls = false;
      video.style.cssText = 'width:100%;height:100%;display:block;object-fit:contain;background:#000;';
      video.addEventListener('loadedmetadata', () => video.play().catch(() => {}), { once: true });
      video.addEventListener('canplay', () => video.play().catch(() => {}), { once: true });
      video.addEventListener('loadeddata', () => video.play().catch(() => {}), { once: true });
      video.addEventListener('error', () => {
        inner.innerHTML = '';
        const fallback = document.createElement('div');
        fallback.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#fff;background:rgba(0,0,0,.55);font:700 16px/1.2 sans-serif;text-align:center;padding:12px;';
        fallback.textContent = 'Видео не удалось загрузить';
        inner.appendChild(fallback);
      }, { once: true });
      inner.appendChild(video);
      setTimeout(() => video.play().catch(() => {}), 30);
      return;
    }

    if (type === 'browser' || type === 'mediashare') {
      const frame = document.createElement('iframe');
      frame.src = normalizeUrl(obj.src);
      frame.allow = 'autoplay; fullscreen';
      frame.style.cssText = 'width:100%;height:100%;border:none;display:block;background:transparent;';
      inner.appendChild(frame);
      return;
    }

    const wrap = document.createElement('div');
    wrap.style.cssText = `width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:12px;color:${obj.color || '#fff'};font-size:${obj.fontSize || 34}px;font-weight:${obj.fontWeight || 700};text-align:center;white-space:pre-wrap;`;
    wrap.textContent = obj.text || obj.name || obj.type;
    inner.appendChild(wrap);
  }

  function ensureAsset(obj) {
    if (!obj || !obj.id) return null;
    let el = world.querySelector(`.asset[data-id="${CSS.escape(obj.id)}"]`);
    const prev = el ? el._obj : null;

    if (!el) {
      el = document.createElement('div');
      el.className = 'asset';
      el.dataset.id = obj.id;
      el.innerHTML = '<div class="asset-inner"></div>';
      world.appendChild(el);
    }

    const changed = !prev || contentKey(prev) !== contentKey(obj);
    el._obj = { ...obj };

    el.style.left = `${Math.round(obj.left)}px`;
    el.style.top = `${Math.round(obj.top)}px`;
    el.style.width = `${Math.round(obj.width)}px`;
    el.style.height = `${Math.round(obj.height)}px`;
    el.style.opacity = String(obj.opacity);
    el.style.transform = `translate3d(0,0,0) rotate(${obj.angle || 0}deg)`;
    el.style.visibility = (obj.visible && obj.top < state.resolution.h) ? 'visible' : 'hidden';
    el.style.pointerEvents = 'none';
    el.style.willChange = 'transform,left,top,width,height';

    if (changed) {
      renderAssetContent(obj, el.querySelector('.asset-inner'));
    }

    return el;
  }

  function removeAsset(id) {
    const el = world.querySelector(`.asset[data-id="${CSS.escape(String(id))}"]`);
    if (el) el.remove();
    delete state.objects[String(id)];
  }

  function applyFullState(roomState) {
    if (!roomState) return;
    state.meta = roomState.meta || state.meta;
    state.resolution = state.meta.resolution || state.resolution;

    const nextObjects = {};
    Object.values(roomState.objects || {}).forEach((o) => {
      const obj = normalizeObject(o);
      nextObjects[obj.id] = obj;
    });
    state.objects = nextObjects;

    $$('.asset', world).forEach(el => {
      if (!state.objects[el.dataset.id]) el.remove();
    });

    Object.values(state.objects).forEach((obj) => {
      if (!obj.visible) return;
      ensureAsset(obj);
    });
  }

  function scheduleRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(() => {
      state.renderQueued = false;
      Object.values(state.objects).forEach(obj => {
        if (!obj.visible) return;
        ensureAsset(obj);
      });
    });
  }

  function onRoomState(roomState) {
    const h = stableHash(roomState);
    if (h === state.hash) return;
    state.hash = h;
    applyFullState(roomState);
  }

  function upsertObject(obj) {
    const next = normalizeObject(obj);
    const cur = state.objects[next.id];
    state.objects[next.id] = next;

    if (cur) {
      const el = ensureAsset(next);
      if (el) {
        el._obj = { ...next };
      }
    } else {
      ensureAsset(next);
    }
  }

  function refreshObject(obj) {
    if (!obj || !obj.id) return;
    const next = normalizeObject(obj);
    const cur = state.objects[next.id];
    if (!cur || Number(next.rev || 0) >= Number(cur.rev || 0)) {
      state.objects[next.id] = next;
      ensureAsset(next);
    }
  }

  function syncRemove(id) {
    removeAsset(id);
  }

  async function fetchState() {
    try {
      const res = await fetch(`/api/room-state?room=${encodeURIComponent(room)}`, { cache: 'no-store' });
      if (!res.ok) return;
      const roomState = await res.json();
      const h = stableHash(roomState);
      if (h === state.hash) return;
      state.hash = h;
      applyFullState(roomState);
    } catch {}
  }

  function connectSocket() {
    if (typeof io !== 'function') return null;
    const socket = io(location.origin, {
      transports: ['websocket', 'polling'],
      upgrade: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      timeout: 20000
    });

    socket.on('connect', () => {
      state.socketReady = true;
      socket.emit('join_room', { room, role: 'obs', username: 'obs_viewer' });
      fetchState().catch(() => {});
    });

    socket.on('disconnect', () => {
      state.socketReady = false;
    });

    socket.on('room_state', onRoomState);
    socket.on('meta_updated', (meta) => {
      state.meta = meta || state.meta;
      state.resolution = state.meta.resolution || state.resolution;
      scheduleRender();
    });
    socket.on('element_added', (obj) => upsertObject(obj));
    socket.on('element_updated', (obj) => refreshObject(obj));
    socket.on('element_removed', ({ id }) => syncRemove(id));
    socket.on('canvas_cleared', () => {
      state.objects = {};
      $$('.asset', world).forEach(el => el.remove());
    });

    return socket;
  }

  function fit() {
    const vw = viewport.clientWidth || window.innerWidth;
    const vh = viewport.clientHeight || window.innerHeight;
    const zoom = Math.min(vw / state.resolution.w, vh / state.resolution.h);
    state.zoom = zoom;
    state.panX = 0;
    state.panY = 0;
    world.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
    world.style.transformOrigin = '0 0';
  }

  window.addEventListener('resize', fit);

  fit();
  const socket = connectSocket();

  fetchState().catch(() => {});
  setInterval(() => {
    if (!state.socketReady) fetchState().catch(() => {});
  }, 500);

  // Safety net: if socket emits updates but a browser source misses a frame, keep DOM in sync.
  setInterval(() => {
    if (state.socketReady) scheduleRender();
  }, 1000 / 30);
})();
