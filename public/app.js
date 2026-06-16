// REALTIME_INPUT_FIX
/* --- START OF FILE public/app.js --- */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const uid = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const room = new URLSearchParams(location.search).get('room') || 'default';
  const role = document.body.classList.contains('obs-only') ? 'obs' : 'admin';
  
  // Подключаемся по веб-сокетам на хостинге Bothost
  const socket = io(location.origin, { transports: ['websocket'] });

  let lastRealtimeEmit = 0;
let lastInspectorSyncAt = 0;

const state = {
    room, role, connected: false,
    resolution: { w: 1920, h: 1080 },
    meta: { logs: [], scenes: {}, presets: {}, sounds: [], currentLayer: '1' },
    objects: {},
    selected: new Set(),
    zoom: 1, panX: 0, panY: 0, fitZoom: 1,
    isPanning: false, panStart: null, drag: null, rotate: null, resize: null,
    selecting: false, selectionRect: null, spaceDown: false, lockView: false,
    spawnBusy: false, netCounter: 0, _netTimer: null, localEdits: new Set()
  };

  const INSPECTOR_FIELDS = ['inspX','inspY','inspW','inspH','inspAngle','inspOpacity','inspText','inspUrl','timerDurationInput'];
  function isInspectorFieldFocused(id) {
    const el = document.activeElement;
    return !!el && el.id === id;
  }


  let currentUsername = null;
  let currentRole = null;

  const world = $('#world');
  const viewport = $('#viewport');
  const selectionBox = $('#selectionBox');
  const netStatus = $('#netStatus');
  const roomPill = $('#roomPill');
  const layerPill = $('#layerPill');
  const zoomPill = $('#zoomPill');

  function assetEl(id) {
    if (!world) return null;
    try {
      return world.querySelector(`.asset[data-id="${String(id)}"]`);
    } catch {
      return Array.from(world.querySelectorAll('.asset')).find(el => el?.dataset?.id === String(id)) || null;
    }
  }

  function applyAssetStyle(el, obj) {
    if (!el || !obj) return;

    const left = Number(obj.left || 0);
    const top = Number(obj.top || 0);

    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.width = `${Math.round(Math.max(16, obj.width || 320))}px`;
    el.style.height = `${Math.round(Math.max(16, obj.height || 180))}px`;
    el.style.opacity = String(Math.max(0, Math.min(1, obj.opacity ?? 1)));
    el.style.zIndex = String(Number.isFinite(+obj.zIndex) ? +obj.zIndex : 10 + Math.round(left));
    el.style.transform = `translate3d(0,0,0) rotate(${Number(obj.angle || 0)}deg)`;
    el.style.willChange = 'transform,left,top,width,height';
    el.style.backfaceVisibility = 'hidden';
    el.style.transformOrigin = 'center center';
  }

  function isMediaLikeObject(obj) {
    return ['image', 'video', 'browser', 'mediashare'].includes(String(obj?.type || '').toLowerCase());
  }

  function contentKey(obj) {
    if (!obj) return '';
    return [
      obj.type, obj.src, obj.text, obj.qrText, obj.bg, obj.color, obj.fontSize, obj.fontWeight,
      obj.radius, obj.borderColor, obj.borderWidth, JSON.stringify(obj.items || []), JSON.stringify(obj.data || {})
    ].join('|');
  }

  function syncAssetView(el, obj, prev = null) {
    if (!el || !obj) return;
    applyAssetStyle(el, obj);
    const tag = el.querySelector('.name-tag');
    if (tag) tag.textContent = `${(obj.name || obj.type).toUpperCase()} • L${obj.layer}`;
    const inner = el.querySelector('.asset-inner');
    if (!prev || contentKey(prev) !== contentKey(obj)) {
      renderAssetContent(obj, inner);
    }
    if (state.role === 'obs') {
      el.classList.remove('selected');
      el.querySelectorAll('.handle').forEach(h => h.remove());
      el.style.pointerEvents = 'none';
    }
  }

  function createPlaceholderDataUrl(label = 'IMAGE') {
    const safe = String(label || 'IMAGE').replace(/[<>&"]/g, '');
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#1d1d27"/>
            <stop offset="100%" stop-color="#0b0b10"/>
          </linearGradient>
        </defs>
        <rect width="800" height="450" rx="28" fill="url(#g)"/>
        <rect x="24" y="24" width="752" height="402" rx="22" fill="none" stroke="#39ff14" stroke-opacity="0.45" stroke-width="4" stroke-dasharray="16 14"/>
        <text x="400" y="215" font-family="Arial, Helvetica, sans-serif" font-size="48" text-anchor="middle" fill="#39ff14" font-weight="700">${safe}</text>
        <text x="400" y="270" font-family="Arial, Helvetica, sans-serif" font-size="20" text-anchor="middle" fill="#ffffff" fill-opacity="0.7">No source provided</text>
      </svg>`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  }

  function qrNode(text) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:12px;background:#fff;color:#111;overflow:hidden;';
    const inner = document.createElement('div');
    inner.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center;border:2px solid #111;border-radius:14px;padding:10px;';
    const badge = document.createElement('div');
    badge.style.cssText = 'width:140px;height:140px;border-radius:12px;background:repeating-linear-gradient(90deg,#111 0 12px,#fff 12px 24px),repeating-linear-gradient(#111 0 12px,#fff 12px 24px);background-blend-mode:multiply;opacity:.88;';
    const txt = document.createElement('div');
    txt.style.cssText = 'font-size:11px;line-height:1.25;color:#111;word-break:break-word;';
    txt.textContent = text ? String(text) : 'QR';
    inner.appendChild(badge);
    inner.appendChild(txt);
    wrap.appendChild(inner);
    return wrap;
  }

  function getTimerRemaining(obj) {
    if (!obj) return 0;
    if (obj.timerStatus === 'running' && obj.endsAt) return Math.max(0, Number(obj.endsAt) - Date.now());
    return Math.max(0, Number(obj.timerRemaining ?? obj.timerDuration ?? 0));
  }

  function formatTimer(obj) {
    const total = Math.floor(getTimerRemaining(obj) / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const parts = h > 0 ? [h, String(m).padStart(2, '0'), String(s).padStart(2, '0')] : [m, String(s).padStart(2, '0')];
    return parts.join(':');
  }

  const spawnDefs = [
    ['text', '📝 New text'], ['shape', '🟦 Shape'], ['image', '🖼 Image'],
    ['browser', '🌐 Browser'], ['qr', '📱 QR code'], ['timer', '⏱ Timer'],
    ['ticker', '📜 Ticker'], ['progress', '📈 Progress goal'], ['eventlist', '📜 Event list'],
    ['alertbox', '🔔 Alert box'], ['todolist', '✅ To-do list'], ['mediashare', '📺 Media share'],
    ['customcode', '🧩 Custom code'], ['video', '🎬 Video']
  ];

  function normalizeUrl(input) {
    let url = String(input || '').trim();
    if (!url) return '';
    if (/^(javascript|vbscript):/i.test(url)) return 'about:blank';
    if (/^(data|blob):/i.test(url)) return url;
    if (/^about:blank$/i.test(url)) return 'about:blank';
    if (/^https?:\/\//i.test(url)) return url;
    if (/^\/\//.test(url)) return `https:${url}`;
    return `https://${url.replace(/^\/*/, '')}`;
  }

  
  function youtubeEmbedUrl(url){
    const s=String(url||'');
    const a=s.match(/(?:youtu\.be\/|v=|embed\/)([A-Za-z0-9_-]{11})/);
    return a?`https://www.youtube.com/embed/${a[1]}?autoplay=1&mute=1&loop=1&playlist=${a[1]}`:null;
  }

  function currentWorldHeight() {
    return state.resolution.h * (state.role === 'admin' ? 2 : 1);
  }

  function setRoomTexts() {
    if (roomPill) roomPill.textContent = `room: ${room}`;
    const obsLink = `${location.origin}/obs.html?room=${encodeURIComponent(room)}`;
    const obsText = $('#obsLinkText');
    if (obsText) obsText.textContent = obsLink;
  }

  function incNet() {
    state.netCounter++;
    if (netStatus) netStatus.textContent = `NET: ${state.netCounter}/s`;
    clearTimeout(state._netTimer);
    state._netTimer = setTimeout(() => {
      state.netCounter = Math.max(0, state.netCounter - 1);
      if (netStatus) netStatus.textContent = `NET: ${state.netCounter}/s`;
    }, 1000);
  }

  function applyView() {
    if (!world) return;
    document.documentElement.style.setProperty('--worldW', `${state.resolution.w}px`);
    document.documentElement.style.setProperty('--worldH', `${currentWorldHeight()}px`);
    document.documentElement.style.setProperty('--obsH', `${state.resolution.h}px`);
    world.style.width = `${state.resolution.w}px`;
    world.style.height = `${currentWorldHeight()}px`;
    world.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
    if (zoomPill) zoomPill.textContent = `Zoom: ${Math.round(state.zoom * 100)}%`;
  }

  function fitToScreen(forceCenter = true) {
    if (!viewport) return;
    if (state.role === 'obs') {
      state.zoom = 1;
      state.panX = 0;
      state.panY = 0;
      applyView();
      return;
    }
    const rect = viewport.getBoundingClientRect();
    const w = state.resolution.w;
    const h = currentWorldHeight();
    const scale = Math.min(rect.width / w, rect.height / h) * 0.95;
    state.fitZoom = scale;
    state.zoom = scale;
    if (forceCenter) {
      state.panX = (rect.width - w * scale) / 2;
      state.panY = (rect.height - h * scale) / 2;
    }
    applyView();
  }

  function screenToWorld(clientX, clientY) {
    if (!viewport) return { x: 0, y: 0 };
    const rect = viewport.getBoundingClientRect();
    return {
      x: (clientX - rect.left - state.panX) / state.zoom,
      y: (clientY - rect.top - state.panY) / state.zoom
    };
  }

  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function normalizeObject(o) {
    const base = {
      id: uid(), type: 'text', name: '', text: 'Text', src: '', left: 200, top: 120,
      width: 320, height: 180, scaleX: 1, scaleY: 1, angle: 0, opacity: 1,
      layer: state.meta.currentLayer || '1', locked: false, visible: true,
      color: '#ffffff', bg: 'rgba(0,0,0,.35)', borderColor: '#7b2cbf', borderWidth: 2,
      radius: 10, fontSize: 42, fontWeight: 700, align: 'center',
      timerMode: 'down', timerDuration: 300000, timerStatus: 'stopped',
      timerRemaining: 300000, endsAt: null, items: [], activeIndex: 0, data: {}
    };
    const obj = Object.assign(base, o || {});
    obj.type = String(obj.type || 'text');
    obj.name = String(obj.name || obj.type);
    obj.text = String(obj.text ?? '');
    obj.src = String(obj.src ?? '');
    obj.left = Number(obj.left || 0);
    obj.top = Number(obj.top || 0);
    obj.width = Math.max(16, Number(obj.width || 320));
    obj.height = Math.max(16, Number(obj.height || 180));
    obj.scaleX = Number.isFinite(+obj.scaleX) ? +obj.scaleX : 1;
    obj.scaleY = Number.isFinite(+obj.scaleY) ? +obj.scaleY : 1;
    obj.angle = Number.isFinite(+obj.angle) ? +obj.angle : 0;
    obj.opacity = Math.max(0, Math.min(1, Number.isFinite(+obj.opacity) ? +obj.opacity : 1));
    obj.layer = String(obj.layer || '1');
    obj.visible = obj.visible !== false;
    obj.locked = !!obj.locked;
    obj.color = String(obj.color || '#ffffff');
    obj.bg = String(obj.bg || 'rgba(0,0,0,.2)');
    obj.borderColor = String(obj.borderColor || '#7b2cbf');
    obj.borderWidth = Math.max(0, Number(obj.borderWidth || 2));
    obj.radius = Number(obj.radius || 10);
    obj.fontSize = Number(obj.fontSize || 42);
    obj.fontWeight = Number(obj.fontWeight || 700);
    obj.align = String(obj.align || 'center');
    obj.items = Array.isArray(obj.items) ? obj.items : [];
    obj.data = (obj.data && typeof obj.data === 'object') ? obj.data : {};
    obj.qrText = String(obj.qrText ?? obj.text ?? obj.src ?? '');
    if (obj.type === 'timer') {
      obj.timerDuration = Math.max(0, Number(obj.timerDuration || 300000));
      obj.timerStatus = ['running','paused','stopped'].includes(obj.timerStatus) ? obj.timerStatus : 'stopped';
      obj.timerRemaining = Math.max(0, Number(obj.timerRemaining || obj.timerDuration || 0));
      obj.endsAt = obj.timerStatus === 'running' ? Number(obj.endsAt || (Date.now() + obj.timerRemaining)) : null;
    }
    return obj;
  }

  function renderAssetContent(obj, inner) {
    if (!inner) return;
    inner.innerHTML = '';
    switch (obj.type) {
      case 'text':
        const box = document.createElement('div');
        box.style.cssText = `width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:12px;color:${obj.color || '#fff'};font-size:${obj.fontSize || 34}px;font-weight:${obj.fontWeight || 800};text-align:center;white-space:pre-wrap;`;
        box.textContent = obj.text || 'TEXT';
        inner.appendChild(box);
        break;

      case 'ticker':
        const tickerWrap = document.createElement('div');
        tickerWrap.style.cssText = `width:100%;height:100%;display:flex;align-items:center;overflow:hidden;background:${obj.bg || 'rgba(0,0,0,0.5)'};color:${obj.color || '#fff'};font-size:${obj.fontSize || 24}px;font-weight:bold;`;
        const marquee = document.createElement('marquee');
        marquee.scrollAmount = 6;
        marquee.style.width = '100%';
        marquee.textContent = obj.text || 'BREAKING NEWS...';
        tickerWrap.appendChild(marquee);
        inner.appendChild(tickerWrap);
        break;

      case 'progress':
        const progWrap = document.createElement('div');
        progWrap.style.cssText = `width:100%;height:100%;display:flex;flex-direction:column;justify-content:center;padding:16px;background:${obj.bg || 'rgba(0,0,0,0.4)'};border-radius:${obj.radius || 10}px;color:${obj.color || '#fff'};`;
        const progTitle = document.createElement('div');
        progTitle.style.cssText = `font-size:${obj.fontSize || 20}px;font-weight:bold;margin-bottom:8px;text-align:center;`;
        progTitle.textContent = isNaN(Number(obj.text)) ? (obj.text || 'Goal') : 'Goal Progress';
        const barBg = document.createElement('div');
        barBg.style.cssText = `width:100%;height:24px;background:rgba(255,255,255,0.1);border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,0.2);position:relative;`;
        const pct = isNaN(Number(obj.text)) ? (obj.data?.pct ?? 50) : Math.max(0, Math.min(100, Number(obj.text)));
        const barFill = document.createElement('div');
        barFill.style.cssText = `width:${pct}%;height:100%;background:${obj.borderColor || '#7b2cbf'};transition:width 0.3s ease;`;
        const barText = document.createElement('div');
        barText.style.cssText = `position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:900;color:#fff;text-shadow:0 1px 2px #000;`;
        barText.textContent = `${pct}%`;
        barBg.appendChild(barFill);
        barBg.appendChild(barText);
        progWrap.appendChild(progTitle);
        progWrap.appendChild(barBg);
        inner.appendChild(progWrap);
        break;

      case 'todolist':
        const todoWrap = document.createElement('div');
        todoWrap.style.cssText = `width:100%;height:100%;display:flex;flex-direction:column;padding:16px;background:${obj.bg || 'rgba(0,0,0,0.4)'};border-radius:${obj.radius || 10}px;color:${obj.color || '#fff'};overflow-y:auto;`;
        const todoTitle = document.createElement('div');
        todoTitle.style.cssText = `font-size:20px;font-weight:bold;margin-bottom:12px;border-bottom:1px solid rgba(255,255,255,0.2);padding-bottom:4px;`;
        todoTitle.textContent = 'To-Do List';
        const listContainer = document.createElement('div');
        listContainer.style.cssText = `display:flex;flex-direction:column;gap:8px;`;
        const todoItems = obj.text && isNaN(Number(obj.text)) ? obj.text.split(',').map(s => s.trim()) : (obj.items && obj.items.length ? obj.items : ['Task 1', 'Task 2']);
        todoItems.forEach((item, idx) => {
          const itemRow = document.createElement('div');
          itemRow.style.cssText = `display:flex;align-items:center;gap:10px;font-size:16px;`;
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.style.cssText = `width:18px;height:18px;accent-color:${obj.borderColor || '#7b2cbf'};cursor:pointer;`;
          checkbox.checked = !!obj.data?.checkedState?.[idx];
          if (state.role === 'admin') {
            checkbox.onchange = () => {
              const checkedState = obj.data?.checkedState || {};
              checkedState[idx] = checkbox.checked;
              setObject(obj.id, { data: { ...obj.data, checkedState } }, true);
            };
          } else {
            checkbox.disabled = true;
          }
          const label = document.createElement('span');
          label.textContent = item;
          if (checkbox.checked) {
            label.style.textDecoration = 'line-through';
            label.style.opacity = '0.5';
          }
          itemRow.appendChild(checkbox);
          itemRow.appendChild(label);
          listContainer.appendChild(itemRow);
        });
        todoWrap.appendChild(todoTitle);
        todoWrap.appendChild(listContainer);
        inner.appendChild(todoWrap);
        break;

      case 'eventlist':
        const evWrap = document.createElement('div');
        evWrap.style.cssText = `width:100%;height:100%;display:flex;flex-direction:column;padding:16px;background:${obj.bg || 'rgba(0,0,0,0.4)'};border-radius:${obj.radius || 10}px;color:${obj.color || '#fff'};overflow-y:auto;`;
        const evTitle = document.createElement('div');
        evTitle.style.cssText = `font-size:18px;font-weight:bold;margin-bottom:10px;text-transform:uppercase;color:${obj.borderColor || '#7b2cbf'};`;
        evTitle.textContent = 'Recent Events';
        const evContainer = document.createElement('div');
        evContainer.style.cssText = `display:flex;flex-direction:column;gap:6px;`;
        const evItems = obj.text && isNaN(Number(obj.text)) ? obj.text.split(',').map(s => s.trim()) : (obj.items && obj.items.length ? obj.items : ['★ New Follower: Alex', '♥ Donated $5.00 from Maria', '✔ Subscribed: StreamerFan']);
        evItems.forEach(item => {
          const evRow = document.createElement('div');
          evRow.style.cssText = `padding:8px 12px;background:rgba(255,255,255,0.05);border-left:3px solid ${obj.borderColor || '#7b2cbf'};font-size:14px;border-radius:4px;font-weight:500;`;
          evRow.textContent = item;
          evContainer.appendChild(evRow);
        });
        evWrap.appendChild(evTitle);
        evWrap.appendChild(evContainer);
        inner.appendChild(evWrap);
        break;

      case 'alertbox':
        const alertWrap = document.createElement('div');
        alertWrap.style.cssText = `width:100%;height:100%;display:flex;align-items:center;gap:16px;padding:16px;background:${obj.bg || 'rgba(0,0,0,0.6)'};border-radius:${obj.radius || 10}px;border:2px solid ${obj.borderColor || '#7b2cbf'};box-shadow:0 0 15px ${obj.borderColor || '#7b2cbf'};color:${obj.color || '#fff'};`;
        const alertIcon = document.createElement('div');
        alertIcon.style.cssText = `font-size:40px;`;
        alertIcon.textContent = '🔔';
        const alertTextContainer = document.createElement('div');
        alertTextContainer.style.cssText = `display:flex;flex-direction:column;`;
        const alertTitle = document.createElement('div');
        alertTitle.style.cssText = `font-size:14px;text-transform:uppercase;opacity:0.7;font-weight:bold;letter-spacing:1px;`;
        alertTitle.textContent = 'NEW ALERT';
        const alertMessage = document.createElement('div');
        alertMessage.style.cssText = `font-size:${obj.fontSize || 24}px;font-weight:900;`;
        alertMessage.textContent = obj.text || 'SUBSCRIBER!';
        alertTextContainer.appendChild(alertTitle);
        alertTextContainer.appendChild(alertMessage);
        alertWrap.appendChild(alertIcon);
        alertWrap.appendChild(alertTextContainer);
        inner.appendChild(alertWrap);
        break;

      case 'customcode':
        const codeContainer = document.createElement('div');
        codeContainer.style.cssText = `width:100%;height:100%;overflow:hidden;background:${obj.bg || 'transparent'};border-radius:${obj.radius || 10}px;`;
        if (obj.text && obj.text !== 'Custom code') {
          codeContainer.innerHTML = obj.text;
        } else {
          codeContainer.style.cssText += `display:flex;align-items:center;justify-content:center;color:#fff;border:1px dashed #555;padding:10px;font-size:14px;text-align:center;`;
          codeContainer.textContent = 'Double click / edit properties to insert HTML code here';
        }
        inner.appendChild(codeContainer);
        break;

      case 'mediashare':
        const msWrap = document.createElement('div');
        msWrap.style.cssText = `width:100%;height:100%;display:flex;flex-direction:column;background:#000;border-radius:${obj.radius || 10}px;overflow:hidden;position:relative;`;
        if (obj.src) {
          const iframe = document.createElement('iframe');
          iframe.src = normalizeUrl(obj.src);
          msWrap.appendChild(iframe);
        } else {
          const placeholder = document.createElement('div');
          placeholder.style.cssText = `width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#ff0033;font-size:18px;font-weight:bold;gap:10px;text-align:center;padding:10px;`;
          placeholder.innerHTML = `🎥 <span>Media Share Ready</span><span style="font-size:12px;color:#aaa;">Enter Video/YouTube URL in properties</span>`;
          msWrap.appendChild(placeholder);
        }
        inner.appendChild(msWrap);
        break;

      case 'shape':
        const shape = document.createElement('div');
        shape.style.cssText = `width:100%;height:100%;background:${obj.bg || '#7b2cbf'};border-radius:${obj.radius || 10}px;border:${obj.borderWidth || 2}px solid ${obj.borderColor || '#fff'}`;
        inner.appendChild(shape);
        break;
      case 'image': {
        const img = document.createElement('img');
        img.src = obj.src || createPlaceholderDataUrl('IMAGE');
        img.loading = 'eager';
        img.decoding = 'async';
        img.draggable = false;
        img.crossOrigin = 'anonymous';
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'contain';
        img.style.display = 'block';
        img.style.transform = 'translateZ(0)';
        img.style.backfaceVisibility = 'hidden';
        inner.appendChild(img);
        break;
      }
      case 'video': {
        if (obj.src) {
          const yt=youtubeEmbedUrl(obj.src);
          if(yt){
            const frame=document.createElement('iframe');
            frame.src=yt;
            frame.allow='autoplay; encrypted-media';
            frame.style.cssText='width:100%;height:100%;border:none;';
            inner.appendChild(frame);
            break;
          }
          const video = document.createElement('video');
          video.src = normalizeUrl(obj.src);
          video.autoplay = true;
          video.loop = true;
          video.muted = true;
          video.playsInline = true;
          video.webkitPlaysInline = true;
          video.preload = 'auto';
          video.load();
          video.controls = false;
          video.crossOrigin = 'anonymous';
          video.style.width = '100%';
          video.style.height = '100%';
          video.style.objectFit = 'contain';
          video.style.display = 'block';
          video.style.background='#000';
          video.style.transform = 'translateZ(0)';
          video.style.backfaceVisibility = 'hidden';
          video.addEventListener('loadedmetadata', () => video.play().catch(() => {}), { once: true });
          video.addEventListener('canplay', () => video.play().catch(() => {}), { once: true });
          video.addEventListener('loadeddata', () => video.play().catch(() => {}), { once: true });
          video.addEventListener('error', () => {
            // If the browser cannot play the source, show a visible fallback instead of a blank box.
            inner.innerHTML = '';
            const fallback = document.createElement('div');
            fallback.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;padding:12px;text-align:center;color:#fff;background:rgba(0,0,0,.55);font-size:14px;';
            fallback.innerHTML = '<strong>Видео не поддерживается браузером</strong><span style="font-size:12px;color:#bbb">Проверь прямую ссылку на файл или используй YouTube embed</span>';
            inner.appendChild(fallback);
          }, { once: true });
          inner.appendChild(video);
          // Best-effort start immediately
          Promise.resolve().then(() => video.play().catch(() => {}));
          setTimeout(() => { video.play().catch(() => {}); }, 50);
        } else inner.textContent = 'VIDEO';
        break;
      }
      case 'browser':
        const iframe = document.createElement('iframe');
        iframe.src = normalizeUrl(obj.src || 'about:blank');
        iframe.style.width = '100%'; iframe.style.height = '100%'; iframe.style.border = 'none';
        inner.appendChild(iframe);
        break;
      case 'qr':
        inner.appendChild(qrNode(obj.qrText || obj.text || obj.src || ''));
        break;
      case 'timer':
        const wrap = document.createElement('div');
        wrap.className = 'timer-content';
        wrap.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-weight:900;color:#ff0;font-size:42px;';
        wrap.textContent = formatTimer(obj);
        inner.appendChild(wrap);
        break;
      default:
        const def = document.createElement('div');
        def.style.cssText = `width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:${obj.color||'#fff'};font-size:${obj.fontSize||30}px;`;
        def.textContent = obj.text || obj.type;
        inner.appendChild(def);
    }
  }

  function buildAssetElement(obj) {
    if (!world) return null;
    let el = assetEl(obj.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'asset';
      el.dataset.id = obj.id;
      el.innerHTML = `
        <div class="asset-inner"></div>
        <div class="name-tag"></div>
        <div class="handle rot" data-handle="rot"></div>
        <div class="handle tl" data-handle="tl"></div>
        <div class="handle tc" data-handle="tc"></div>
        <div class="handle tr" data-handle="tr"></div>
        <div class="handle ml" data-handle="ml"></div>
        <div class="handle mr" data-handle="mr"></div>
        <div class="handle bl" data-handle="bl"></div>
        <div class="handle bc" data-handle="bc"></div>
        <div class="handle br" data-handle="br"></div>
      `;
      world.appendChild(el);
      if (state.role === 'admin') el.addEventListener('pointerdown', onPointerDown);
    }
    syncAssetView(el, obj);
    return el;
  }

  function renderSelection() {
    if (!world) return;
    $$('.asset', world).forEach(el => el.classList.remove('selected'));
    state.selected.forEach(id => { const el = assetEl(id); if (el) el.classList.add('selected'); });
    renderInspector();
  }

  function renderLists() {
    if (state.role !== 'admin') return;
    const logs = $('#actionLog');
    const scenes = $('#sceneList');
    const presets = $('#presetList');
    const sounds = $('#soundList');
    if (logs) logs.innerHTML = state.meta.logs.slice(0,50).map(e => `<div class="entry"><span class="ts">[${new Date(e.ts).toLocaleTimeString()}]</span><span class="actor">${esc(e.actor)}:</span><span>${esc(e.message)}</span></div>`).join('');
    if (scenes) scenes.innerHTML = Object.keys(state.meta.scenes).length ? Object.keys(state.meta.scenes).map(n => `<div class="item"><button class="btn sm row" data-load-scene="${esc(n)}"><span>${esc(n)}</span><span>load</span></button></div>`).join('') : '<div class="item">No scenes saved.</div>';
    if (presets) presets.innerHTML = Object.keys(state.meta.presets).length ? Object.keys(state.meta.presets).map(n => `<div class="item"><button class="btn sm row" data-load-preset="${esc(n)}"><span>${esc(n)}</span><span>load</span></button></div>`).join('') : '<div class="item">No presets saved.</div>';
    if (sounds) sounds.innerHTML = state.meta.sounds.length ? state.meta.sounds.map(s => `<div class="item"><div>${esc(s.name)}</div><div><button class="btn sm green" data-play-sound="${esc(s.id)}">Play</button><button class="btn sm red" data-remove-sound="${esc(s.id)}">Del</button></div></div>`).join('') : '<div class="item">No sounds added.</div>';
    if (layerPill) layerPill.textContent = `Layer ${state.meta.currentLayer || '1'}`;
  }

  function renderInspector() {
    const selectedCount = $('#selectedCount');
    const empty = $('#inspectorEmpty');
    const body = $('#inspectorBody');
    if (selectedCount) selectedCount.textContent = `${state.selected.size} selected`;
    if (!state.selected.size || state.role !== 'admin') {
      empty?.classList.remove('hidden'); body?.classList.add('hidden');
      return;
    }
    const obj = state.objects[[...state.selected][0]];
    if (!obj) { empty?.classList.remove('hidden'); body?.classList.add('hidden'); return; }
    
    empty?.classList.add('hidden'); body?.classList.remove('hidden');
    
    const inspType = $('#inspType'); if (inspType) inspType.textContent = obj.type;
    const inspX = $('#inspX'); if (inspX && !isInspectorFieldFocused('inspX')) inspX.value = Math.round(obj.left);
    const inspY = $('#inspY'); if (inspY && !isInspectorFieldFocused('inspY')) inspY.value = Math.round(obj.top);
    const inspW = $('#inspW'); if (inspW && !isInspectorFieldFocused('inspW')) inspW.value = Math.round(obj.width);
    const inspH = $('#inspH'); if (inspH && !isInspectorFieldFocused('inspH')) inspH.value = Math.round(obj.height);
    const inspAngle = $('#inspAngle'); if (inspAngle && !isInspectorFieldFocused('inspAngle')) inspAngle.value = Math.round(obj.angle || 0);
    const inspOpacity = $('#inspOpacity'); if (inspOpacity && !isInspectorFieldFocused('inspOpacity')) inspOpacity.value = Number(obj.opacity ?? 1);
    const inspText = $('#inspText'); if (inspText && !isInspectorFieldFocused('inspText')) inspText.value = obj.type === 'qr' ? (obj.qrText || obj.text || obj.src || '') : (obj.text || '');
    const inspUrl = $('#inspUrl'); if (inspUrl && !isInspectorFieldFocused('inspUrl')) inspUrl.value = ['browser','image','video','mediashare'].includes(obj.type) ? (obj.src || '') : '';

    const timerPanel = $('#timerPanel');
    if (obj.type === 'timer') {
      const timerFocused = isInspectorFieldFocused('timerDurationInput');
      timerPanel?.classList.remove('hidden');
      if (!timerFocused) timerPanel.innerHTML = `
        <div class="section-title" style="margin-top:12px"><span>Timer Controls</span></div>
        <table class="inspector-table" style="margin-bottom:8px">
          <tr>
            <th>Duration (sec)</th>
            <td><input id="timerDurationInput" type="number" class="field" value="${Math.round(obj.timerDuration / 1000)}"></td>
          </tr>
          <tr>
            <th>Status</th>
            <td><span class="pill ${obj.timerStatus === 'running' ? 'green' : 'gold'}">${obj.timerStatus.toUpperCase()}</span></td>
          </tr>
        </table>
        <div class="inspector-actions" style="grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 6px;">
          <button class="btn sm green" id="timerStartBtn">▶ Start</button>
          <button class="btn sm" id="timerPauseBtn">⏸ Pause</button>
        </div>
        <div class="inspector-actions" style="grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 6px;">
          <button class="btn sm red" id="timerStopBtn">⏹ Reset</button>
          <button class="btn sm purple" id="timerSetDurationBtn">Set Sec</button>
        </div>
        <div class="inspector-actions" style="grid-template-columns: 1fr 1fr; gap: 6px;">
          <button class="btn sm" id="timerAdd10Btn">+10s</button>
          <button class="btn sm" id="timerSub10Btn">-10s</button>
        </div>
      `;
      const tStart = $('#timerStartBtn'); if (tStart) tStart.onclick = () => timerAction('start');
      const tPause = $('#timerPauseBtn'); if (tPause) tPause.onclick = () => timerAction('pause');
      const tStop = $('#timerStopBtn'); if (tStop) tStop.onclick = () => timerAction('stop');
      const tSet = $('#timerSetDurationBtn'); if (tSet) tSet.onclick = () => timerAction('set-duration');
      const tDur = $('#timerDurationInput');
      if (tDur) {
        tDur.addEventListener('input', () => timerAction('set-duration'));
        tDur.addEventListener('change', () => timerAction('set-duration'));
      }
      const tAdd = $('#timerAdd10Btn'); if (tAdd) tAdd.onclick = () => timerAction('add10');
      const tSub = $('#timerSub10Btn'); if (tSub) tSub.onclick = () => timerAction('sub10');
    } else {
      timerPanel?.classList.add('hidden');
      timerPanel.innerHTML = '';
    }
  }

  function addObject(input, emit = true) {
    const obj = normalizeObject(input);
    state.objects[obj.id] = obj;
    buildAssetElement(obj);
    state.selected.clear(); state.selected.add(obj.id);
    renderSelection();
    if (emit && state.role === 'admin') socket.emit('add_element', obj);
    return obj;
  }

  function setObject(id, patch, emit = false) {
    const obj = state.objects[id];
    if (!obj) return null;
    const prev = { ...obj };
    Object.assign(obj, patch);
    if (emit && state.role === 'admin') {
      obj.rev = (Number(obj.rev) || 0) + 1;
      patch.rev = obj.rev;
    }
    const el = assetEl(id);
    if (el) syncAssetView(el, obj, prev);
    renderInspector();
    if (emit && state.role === 'admin') socket.emit('update_element', { ...obj });
    return obj;
  }

  function removeObject(id, emit = true) {
    const el = assetEl(id); if (el) el.remove();
    delete state.objects[id];
    state.selected.delete(id);
    renderSelection();
    if (emit && state.role === 'admin') socket.emit('remove_element', { id });
  }

  function createObjectByType(type, opts = {}) {
    if (state.spawnBusy) return null;
    state.spawnBusy = true;
    // STAGING AREA (non-stream zone)
    const STAGING_AREA = {
      left: 120,
      top: (state.resolution.h || 1080) + 120,
      width: Math.max(600, (state.resolution.w || 1920) - 240),
      height: Math.max(260, (state.resolution.h || 1080) - 240)
    };

    const baseX = Math.round(
      opts.left ?? (STAGING_AREA.left + STAGING_AREA.width / 2 - 210)
    );

    const baseY = Math.round(
      opts.top ?? (STAGING_AREA.top + STAGING_AREA.height / 2 - 120)
    );
    const common = {
      id: uid(), type, left: Math.round(opts.left ?? baseX), top: Math.round(opts.top ?? baseY),
      width: Math.round(opts.width ?? 420), height: Math.round(opts.height ?? 240), angle: 0,
      layer: state.meta.currentLayer || '1', name: opts.name || type,
      text: opts.text || '', src: opts.src || '', color: opts.color || '#fff',
      bg: opts.bg || 'rgba(123,44,191,.2)', borderColor: opts.borderColor || '#7b2cbf',
      borderWidth: opts.borderWidth ?? 2, radius: opts.radius ?? 12, fontSize: opts.fontSize ?? 36,
      fontWeight: opts.fontWeight ?? 800, align: opts.align || 'center', data: opts.data || {},
      items: opts.items || [], zIndex: Date.now() % 100000
    };
    if (type === 'text') { common.text = opts.text || prompt('Text:', 'New text') || 'New text'; common.width = 560; common.height = 180; common.bg = 'rgba(0,0,0,.18)'; }
    else if (type === 'shape') { common.width = 420; common.height = 240; common.bg = 'rgba(123,44,191,.85)'; common.borderColor = '#39ff14'; }
    else if (type === 'image') { common.src = opts.src || prompt('Image URL (blank for placeholder):', '') || createPlaceholderDataUrl('IMAGE'); common.width = 520; common.height = 300; }
    else if (type === 'video') { common.src = opts.src || prompt('Video URL (mp4/webm):', '') || ''; common.width = 540; common.height = 304; }
    else if (type === 'browser') { common.src = opts.src || prompt('Browser URL:', 'https://example.com') || 'about:blank'; common.width = 760; common.height = 480; }
    else if (type === 'qr') { common.qrText = opts.text || prompt('QR text / URL:', location.href) || location.href; common.width = 260; common.height = 260; common.bg = '#fff'; common.borderColor = '#000'; }
    else if (type === 'timer') { const seconds = parseInt(prompt('Timer duration in seconds:', '3600') || '3600', 10); common.width = 360; common.height = 160; common.bg = 'rgba(0,0,0,.4)'; common.color = '#ff0'; common.timerDuration = Math.max(1, seconds) * 1000; common.timerRemaining = common.timerDuration; common.timerStatus = 'stopped'; }
    else if (type === 'ticker') { common.text = opts.text || prompt('Ticker text:', 'Breaking news...') || 'Breaking news...'; common.width = 900; common.height = 100; }
    else if (type === 'progress') { common.text = opts.text || prompt('Percent goal (0-100) or Goal name:', '50') || '50'; common.width = 640; common.height = 180; }
    else if (type === 'eventlist') { common.text = opts.text || 'Alex (Follow), Maria ($5)'; common.width = 540; common.height = 320; }
    else if (type === 'alertbox') { common.text = opts.text || prompt('Alert text:', 'SUBSCRIBE!') || 'SUBSCRIBE!'; common.width = 760; common.height = 180; }
    else if (type === 'todolist') { common.text = opts.text || 'Item 1, Item 2, Item 3'; common.width = 420; common.height = 320; }
    else if (type === 'mediashare') { common.src = opts.src || prompt('Media Embed URL (YouTube share/embed):', '') || ''; common.width = 640; common.height = 360; }
    else if (type === 'customcode') { common.text = opts.text || '<h2>My HTML</h2>'; common.width = 560; common.height = 300; }
    const obj = addObject(common);
    setTimeout(() => { state.spawnBusy = false; }, 120);
    return obj;
  }

  function bindSpawnButtons() {
    try {
      const host = $('#spawnButtons');
      if (!host || host.dataset.bound === '1') return;
      host.dataset.bound = '1';
      host.innerHTML = spawnDefs.map(([type, label]) => `<button type="button" class="btn sm" data-spawn="${esc(type)}">${esc(label)}</button>`).join('');
      host.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-spawn]');
        if (btn) createObjectByType(btn.dataset.spawn);
      });
    } catch(e) {
      console.error('Error binding spawn buttons:', e);
    }
  }

  function selectOnly(id, additive = false) {
    if (!additive) state.selected.clear();
    if (id) { if (additive && state.selected.has(id)) state.selected.delete(id); else state.selected.add(id); }
    renderSelection();
  }

  function renderObject(obj) {
    if (!obj || !obj.visible) return;
    const el = assetEl(obj.id);
    if (el) syncAssetView(el, obj, obj);
    else buildAssetElement(obj);
  }

  function renderAll() {
    if (!world) return;
    world.querySelectorAll('.asset').forEach(el => {
      const id = el.dataset.id;
      const obj = state.objects[id];
      if (!obj || !obj.visible) el.remove();
    });
    Object.values(state.objects).forEach(obj => renderObject(obj));
    renderSelection(); renderLists(); applyView(); updateDynamicTimers();
  }

  function updateDynamicTimers() {
    Object.values(state.objects).forEach(obj => {
      if (obj.type !== 'timer') return;
      const el = assetEl(obj.id);
      if (el) { const tc = el.querySelector('.timer-content'); if (tc) tc.textContent = formatTimer(obj); }
    });
  }

  // Оптимизируем и сжимаем картинку на клиенте перед ее передачей по сокетам
  function addImageFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        // Ограничиваем максимальное разрешение до 1200 пикселей (более чем достаточно для FullHD оверлея)
        const MAX_WIDTH = 1200;
        const MAX_HEIGHT = 1200;
        let width = img.width;
        let height = img.height;
        
        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }
        
        canvas.width = width;
        canvas.height = height;
        ctx.drawImage(img, 0, 0, width, height);
        
        // Сжимаем в легкий JPEG с качеством 75%
        const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.75);
        createObjectByType('image', { src: compressedDataUrl });
      };
      img.src = String(e.target.result || '');
    };
    reader.readAsDataURL(file);
  }

  function addImageUrl() { const url = prompt('Image URL:', 'https://'); if (url) createObjectByType('image', { src: url.startsWith('data:') ? url : normalizeUrl(url) }); }

  function updateSelectedFromInputs() {
    const obj = state.objects[[...state.selected][0]]; if (!obj) return;
    const payload = {
      left: Number($('#inspX')?.value || 0),
      top: Number($('#inspY')?.value || 0),
      width: Math.max(16, Number($('#inspW')?.value || 16)),
      height: Math.max(16, Number($('#inspH')?.value || 16)),
      angle: Number($('#inspAngle')?.value || 0),
      opacity: Math.max(0, Math.min(1, Number($('#inspOpacity')?.value || 1)))
    };
    if (['browser','image','video','mediashare'].includes(obj.type)) payload.src = normalizeUrl($('#inspUrl')?.value || '');
    if (obj.type === 'qr') { payload.qrText = String($('#inspText')?.value || '').trim(); payload.text = payload.qrText; } else { payload.text = $('#inspText')?.value || ''; }

    // Локально обновляем сразу и сразу же отправляем в OBS/сервер.
    setObject(obj.id, payload, true);
  }

  function timerAction(action) {
    const obj = state.objects[[...state.selected][0]]; if (!obj || obj.type !== 'timer') return;
    const durMs = Math.max(0, Math.round(Number($('#timerDurationInput')?.value || 0) * 1000));
    if (action === 'set-duration') { obj.timerDuration = durMs; if (obj.timerStatus !== 'running') obj.timerRemaining = durMs; if (obj.timerStatus === 'running') obj.endsAt = Date.now() + durMs; }
    else if (action === 'start') { const remaining = obj.timerRemaining > 0 ? obj.timerRemaining : (obj.timerDuration || durMs || 0); obj.timerStatus = 'running'; obj.endsAt = Date.now() + remaining; obj.timerRemaining = remaining; }
    else if (action === 'pause') { if (obj.timerStatus === 'running') { obj.timerRemaining = getTimerRemaining(obj); obj.timerStatus = 'paused'; obj.endsAt = null; } }
    else if (action === 'stop' || action === 'reset') { obj.timerStatus = 'stopped'; obj.endsAt = null; obj.timerRemaining = obj.timerDuration || durMs || 0; }
    else if (action === 'add10') { obj.timerRemaining = Math.max(0, getTimerRemaining(obj) + 10000); obj.timerDuration = obj.timerRemaining; if (obj.timerStatus === 'running') obj.endsAt = Date.now() + obj.timerRemaining; }
    else if (action === 'sub10') { obj.timerRemaining = Math.max(0, getTimerRemaining(obj) - 10000); obj.timerDuration = obj.timerRemaining; if (obj.timerStatus === 'running') obj.endsAt = Date.now() + obj.timerRemaining; }
    setObject(obj.id, { timerDuration: obj.timerDuration, timerStatus: obj.timerStatus, timerRemaining: obj.timerRemaining, endsAt: obj.endsAt }, true);
    renderInspector();
  }

  function duplicateSelected() {
    if (!state.selected.size) return;
    const ids = [...state.selected];
    const next = [];
    ids.forEach(id => {
      const src = state.objects[id]; if (!src) return;
      const dup = normalizeObject(JSON.parse(JSON.stringify(src)));
      dup.id = uid(); dup.left += 20; dup.top += 20;
      if (dup.type === 'timer') { dup.endsAt = null; dup.timerStatus = 'stopped'; dup.timerRemaining = dup.timerDuration; }
      addObject(dup); next.push(dup.id);
    });
    state.selected = new Set(next); renderSelection();
  }

  function moveSelectedByScene(deltaY) {
    [...state.selected].forEach(id => { const obj = state.objects[id]; if (!obj) return; obj.top += deltaY; setObject(id, { top: obj.top }, true); });
  }

  function flashElement(id) {
    if (state.role !== 'admin') return;
    const el = assetEl(id);
    if (!el) return;
    el.style.transition = 'box-shadow 0.1s ease';
    el.style.boxShadow = '0 0 0 2px #39ff14, 0 0 0 4px rgba(57,255,20,0.5)';
    setTimeout(() => { if (el) el.style.boxShadow = ''; }, 300);
  }

  function onPointerDown(e) {
    if (state.role !== 'admin') return;
    const handle = e.target.closest('.handle');
    const asset = e.target.closest('.asset');
    const pt = screenToWorld(e.clientX, e.clientY);
    if (handle && asset) {
      const id = asset.dataset.id; const obj = state.objects[id]; if (!obj || obj.locked) return;
      selectOnly(id);
      
      // Поддержка 8-ми векторов изменения размера
      if (['br','tl','tr','bl','tc','bc','ml','mr'].includes(handle.dataset.handle)) { 
        state.resize = { id, start: pt, handle: handle.dataset.handle, startObj: { ...obj } };
        state.localEdits.add(id);
      }
      else if (handle.dataset.handle === 'rot') { 
        const cx = obj.left + obj.width/2, cy = obj.top + obj.height/2; 
        state.rotate = { id, center: { x: cx, y: cy }, startAngle: obj.angle || 0, startMouseAngle: Math.atan2(pt.y-cy, pt.x-cx) };
        state.localEdits.add(id);
      }
      e.preventDefault(); return;
    }
    if (asset) {
      const id = asset.dataset.id; const obj = state.objects[id]; if (!obj) return;
      if (e.shiftKey) { if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id); renderSelection(); return; }
      selectOnly(id); if (obj.locked) return;
      state.drag = { id, start: pt, startObj: { left: obj.left, top: obj.top } };
      state.localEdits.add(id);
      e.preventDefault(); return;
    }
    selectOnly(null);
    if (e.button === 1 || state.spaceDown) {
      state.isPanning = true; state.panStart = { x: e.clientX, y: e.clientY, panX: state.panX, panY: state.panY };
      if (viewport) viewport.style.cursor = 'grabbing'; e.preventDefault();
    } else {
      state.selecting = true; const rect = viewport.getBoundingClientRect();
      state.selectionRect = { x1: e.clientX - rect.left, y1: e.clientY - rect.top, x2: e.clientX - rect.left, y2: e.clientY - rect.top };
      selectionBox.style.display = 'block'; selectionBox.style.left = `${state.selectionRect.x1}px`; selectionBox.style.top = `${state.selectionRect.y1}px`;
      selectionBox.style.width = '0px'; selectionBox.style.height = '0px'; e.preventDefault();
    }
  }

  function onPointerMove(e) {
    if (state.role !== 'admin') return;
    const pt = screenToWorld(e.clientX, e.clientY);
    if (state.drag) {
      const obj = state.objects[state.drag.id]; if (!obj) return;
      obj.left = Math.round(state.drag.startObj.left + (pt.x - state.drag.start.x));
      obj.top = Math.round(state.drag.startObj.top + (pt.y - state.drag.start.y));
      setObject(obj.id, { left: obj.left, top: obj.top }, false);
      const now = performance.now();
      const emitEvery = isMediaLikeObject(obj) ? 24 : 40;
      if (now - lastRealtimeEmit > emitEvery) {
        lastRealtimeEmit = now;
        socket.emit('update_element', { ...obj });
      }
    } else if (state.resize) {
      const obj = state.objects[state.resize.id]; if (!obj) return;
      const dx = pt.x - state.resize.start.x, dy = pt.y - state.resize.start.y;
      const h = state.resize.handle;
      
      // Угловые растягивания
      if (h === 'br') { obj.width = Math.max(24, Math.round(state.resize.startObj.width + dx)); obj.height = Math.max(24, Math.round(state.resize.startObj.height + dy)); }
      if (h === 'tl') { obj.width = Math.max(24, Math.round(state.resize.startObj.width - dx)); obj.height = Math.max(24, Math.round(state.resize.startObj.height - dy)); obj.left = Math.round(state.resize.startObj.left + dx); obj.top = Math.round(state.resize.startObj.top + dy); }
      if (h === 'tr') { obj.width = Math.max(24, Math.round(state.resize.startObj.width + dx)); obj.height = Math.max(24, Math.round(state.resize.startObj.height - dy)); obj.top = Math.round(state.resize.startObj.top + dy); }
      if (h === 'bl') { obj.width = Math.max(24, Math.round(state.resize.startObj.width - dx)); obj.height = Math.max(24, Math.round(state.resize.startObj.height + dy)); obj.left = Math.round(state.resize.startObj.left + dx); }
      
      // Боковые и вертикальные растягивания (по середине сторон)
      if (h === 'tc') { obj.height = Math.max(24, Math.round(state.resize.startObj.height - dy)); obj.top = Math.round(state.resize.startObj.top + dy); }
      if (h === 'bc') { obj.height = Math.max(24, Math.round(state.resize.startObj.height + dy)); }
      if (h === 'ml') { obj.width = Math.max(24, Math.round(state.resize.startObj.width - dx)); obj.left = Math.round(state.resize.startObj.left + dx); }
      if (h === 'mr') { obj.width = Math.max(24, Math.round(state.resize.startObj.width + dx)); }
      
      setObject(obj.id, { left: obj.left, top: obj.top, width: obj.width, height: obj.height }, true);
      const now = performance.now();
      const emitEvery = isMediaLikeObject(obj) ? 24 : 40;
      if (now - lastRealtimeEmit > emitEvery) {
        lastRealtimeEmit = now;
        socket.emit('update_element', { ...obj });
      }
    } else if (state.rotate) {
      const obj = state.objects[state.rotate.id]; if (!obj) return;
      const angle = Math.atan2(pt.y - state.rotate.center.y, pt.x - state.rotate.center.x);
      const deg = Math.round((state.rotate.startAngle + ((angle - state.rotate.startMouseAngle) * 180 / Math.PI)) / 5) * 5;
      obj.angle = deg; setObject(obj.id, { angle: obj.angle }, true);
    } else if (state.isPanning) {
      state.panX = state.panStart.panX + (e.clientX - state.panStart.x); state.panY = state.panStart.panY + (e.clientY - state.panStart.y);
      applyView();
    } else if (state.selecting && state.selectionRect) {
      const rect = viewport.getBoundingClientRect();
      state.selectionRect.x2 = e.clientX - rect.left; state.selectionRect.y2 = e.clientY - rect.top;
      const x = Math.min(state.selectionRect.x1, state.selectionRect.x2), y = Math.min(state.selectionRect.y1, state.selectionRect.y2);
      const w = Math.abs(state.selectionRect.x2 - state.selectionRect.x1), h = Math.abs(state.selectionRect.y2 - state.selectionRect.y1);
      selectionBox.style.left = `${x}px`; selectionBox.style.top = `${y}px`; selectionBox.style.width = `${w}px`; selectionBox.style.height = `${h}px`;
      const p1 = screenToWorld(x + rect.left, y + rect.top), p2 = screenToWorld(x + w + rect.left, y + h + rect.top);
      const box = { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), w: Math.abs(p2.x - p1.x), h: Math.abs(p2.y - p1.y) };
      state.selected.clear();
      Object.values(state.objects).forEach(obj => { if (rectsOverlap({ x: obj.left, y: obj.top, w: obj.width, h: obj.height }, box)) state.selected.add(obj.id); });
      renderSelection();
    }
  }

  function onPointerUp() {
    if (state.role !== 'admin') return;
    selectionBox.style.display = 'none'; state.selecting = false; state.isPanning = false; state.selectionRect = null;
    if (viewport) viewport.style.cursor = 'default';
    if (state.drag) { const obj = state.objects[state.drag.id]; if (obj) socket.emit('update_element', { ...obj }); state.localEdits.delete(state.drag.id); state.drag = null; }
    if (state.resize) { const obj = state.objects[state.resize.id]; if (obj) socket.emit('update_element', { ...obj }); state.localEdits.delete(state.resize.id); state.resize = null; }
    if (state.rotate) { const obj = state.objects[state.rotate.id]; if (obj) socket.emit('update_element', { ...obj }); state.localEdits.delete(state.rotate.id); state.rotate = null; }
  }

  function onWheel(e) {
    if (state.role !== 'admin') return;
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const mouseX = e.clientX - rect.left, mouseY = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.08 : 0.92;
    const nextZoom = Math.max(0.08, Math.min(4, state.zoom * factor));
    const worldX = (mouseX - state.panX) / state.zoom, worldY = (mouseY - state.panY) / state.zoom;
    state.zoom = nextZoom; state.panX = mouseX - worldX * state.zoom; state.panY = mouseY - worldY * state.zoom;
    applyView();
  }

  function onKeyDown(e) {
    if (e.code === 'Space') state.spaceDown = true;
    const active = document.activeElement;
    const isTypingTarget = !!active && (
      active.tagName === 'INPUT' ||
      active.tagName === 'TEXTAREA' ||
      active.isContentEditable
    );
    if (state.role !== 'admin' || isTypingTarget) return;
    const selected = [...state.selected];
    if (e.key === 'Delete' || e.key === 'Backspace') selected.forEach(id => removeObject(id));
    const step = e.shiftKey ? 20 : 5;
    if (e.key === 'ArrowLeft' && selected.length) selected.forEach(id => setObject(id, { left: state.objects[id].left - step }, true));
    else if (e.key === 'ArrowRight' && selected.length) selected.forEach(id => setObject(id, { left: state.objects[id].left + step }, true));
    else if (e.key === 'ArrowUp' && selected.length) selected.forEach(id => setObject(id, { top: state.objects[id].top - step }, true));
    else if (e.key === 'ArrowDown' && selected.length) selected.forEach(id => setObject(id, { top: state.objects[id].top + step }, true));
    renderAll();
  }

  function onKeyUp(e) { if (e.code === 'Space') state.spaceDown = false; }

  function syncRoomState(roomState) {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
    state.meta = roomState.meta || state.meta;
    state.resolution = state.meta.resolution || state.resolution;
    const nextObjects = {};
    if (roomState.objects) Object.values(roomState.objects).forEach(obj => { nextObjects[obj.id] = normalizeObject(obj); });
    state.objects = nextObjects;
    renderAll();
  }

  async function loadModerators() {
    if (currentRole !== 'streamer') return;
    try {
      const res = await fetch('/api/moderators');
      const mods = await res.json();
      const container = $('#moderatorsTable');
      if (container) {
        container.innerHTML = mods.map(m => `<div class="item"><div style="display:flex;justify-content:space-between"><span><span class="status-dot ${m.online ? 'online' : 'offline'}"></span> ${esc(m.username)}</span><div><button class="btn sm purple info-moderator" data-username="${esc(m.username)}">Инфо</button><button class="btn sm red delete-moderator" data-username="${esc(m.username)}">Удалить</button></div></div></div>`).join('');
        $$('.info-moderator').forEach(btn => btn.onclick = () => showModeratorModal(btn.dataset.username));
        $$('.delete-moderator').forEach(btn => btn.onclick = async () => { if (confirm('Удалить?')) { await fetch(`/api/moderators/${btn.dataset.username}`, { method: 'DELETE' }); loadModerators(); } });
      }
    } catch(e) { console.error('Error loadModerators:', e); }
  }

  async function showModeratorModal(username) {
    try {
      const modal = $('#moderatorModal');
      if (!modal) return;
      $('#modalUsername').textContent = username;
      const res = await fetch('/api/moderators');
      const mods = await res.json();
      const found = mods.find(m => m.username === username);
      $('#modalStatus').textContent = found?.online ? '🟢 Онлайн' : '⚫ Оффлайн';
      if (currentRole === 'streamer') {
        const passRes = await fetch(`/api/moderators/${username}/password`);
        const passData = await passRes.json();
        const passSpan = $('#modalPassword');
        passSpan.textContent = '••••••••';
        passSpan.dataset.realPassword = passData.password || '';
      }
      modal.style.display = 'flex';
      modal.classList.remove('hidden');
    } catch(e) { console.error('Error in showModeratorModal:', e); }
  }

  async function initAuth() {
    if (state.role === 'obs') {
      currentUsername = 'obs_viewer'; currentRole = 'obs';
      socket.emit('auth', { username: currentUsername });
      socket.emit('join_room', { room, role: 'obs', username: currentUsername });
      setRoomTexts(); fitToScreen(true); renderAll();
      return;
    }
    try {
      const res = await fetch('/api/me');
      if (!res.ok) { window.location.href = '/login'; return; }
      const data = await res.json();
      currentUsername = data.username; currentRole = data.role;
      const userNameEl = $('#userName');
      if (userNameEl) userNameEl.textContent = currentUsername;
      const modSection = $('#moderatorsSection');
      if (modSection) {
        if (currentRole === 'streamer') {
          modSection.style.display = 'block';
          loadModerators();
          socket.on('moderators_update', loadModerators);
        } else modSection.style.display = 'none';
      }
      socket.emit('auth', { username: currentUsername });
      socket.emit('join_room', { room, role: 'admin', username: currentUsername });
      setRoomTexts(); fitToScreen(true); renderAll();
    } catch(err) { 
      console.error('Auth error:', err);
      window.location.href = '/login'; 
    }
  }

  function wireUI() {
    try {
      $('#fitBtn')?.addEventListener('click', () => fitToScreen(true));
    } catch(e) { console.error('Error fitBtn:', e); }
    
    try {
      $('#copyObsLinkBtn')?.addEventListener('click', () => { const txt = $('#obsLinkText')?.textContent || ''; navigator.clipboard?.writeText(txt); });
    } catch(e) { console.error('Error copyObsLinkBtn:', e); }

    try {
      $('#resolutionSelect')?.addEventListener('change', () => { const [w,h] = $('#resolutionSelect').value.split('x').map(Number); socket.emit('set_resolution', { w, h }); });
    } catch(e) { console.error('Error resolutionSelect:', e); }

    try {
      $('#layerSelect')?.addEventListener('change', () => { const layer = $('#layerSelect').value; socket.emit('set_layer', { layer }); });
    } catch(e) { console.error('Error layerSelect:', e); }

    try {
      $('#clearCanvasBtn')?.addEventListener('click', () => socket.emit('clear_canvas', {}));
      $('#clearAllBtn')?.addEventListener('click', () => socket.emit('clear_canvas', {}));
    } catch(e) { console.error('Error clear buttons:', e); }

    try {
      $('#deleteBtn')?.addEventListener('click', () => [...state.selected].forEach(id => removeObject(id)));
      $('#deleteSelectedBtn')?.addEventListener('click', () => [...state.selected].forEach(id => removeObject(id)));
    } catch(e) { console.error('Error delete buttons:', e); }

    try {
      $('#pushLiveBtn')?.addEventListener('click', () => moveSelectedByScene(-state.resolution.h));
      $('#swapBtn')?.addEventListener('click', () => moveSelectedByScene(state.resolution.h));
    } catch(e) { console.error('Error transition buttons:', e); }

    try {
      $('#saveSceneBtn')?.addEventListener('click', () => { const name = $('#sceneNameInput').value.trim(); if(name) socket.emit('save_scene', { name }); });
    } catch(e) { console.error('Error saveSceneBtn:', e); }

    try {
      $('#savePresetBtn')?.addEventListener('click', () => { const name = $('#presetNameInput').value.trim(); if(name) socket.emit('save_preset', { name }); });
    } catch(e) { console.error('Error savePresetBtn:', e); }

    try {
      $('#addSoundBtn')?.addEventListener('click', () => { const name = $('#soundNameInput').value.trim(); const url = $('#soundUrlInput').value.trim(); if(url) socket.emit('save_sound', { name, url }); });
    } catch(e) { console.error('Error addSoundBtn:', e); }

    try {
      $('#stopAllSoundBtn')?.addEventListener('click', () => socket.emit('stop_sounds', {}));
    } catch(e) { console.error('Error stopAllSoundBtn:', e); }

    try {
      $('#applyPropsBtn')?.addEventListener('click', updateSelectedFromInputs);
    } catch(e) { console.error('Error applyPropsBtn:', e); }

    try {
      $('#dupBtn')?.addEventListener('click', duplicateSelected);
    } catch(e) { console.error('Error dupBtn:', e); }

    try {
      $('#toLiveBtn')?.addEventListener('click', () => moveSelectedByScene(-state.resolution.h));
      $('#toStageBtn')?.addEventListener('click', () => moveSelectedByScene(state.resolution.h));
    } catch(e) { console.error('Error live/stage transition buttons:', e); }

    try {
      $('#addImageFileBtn')?.addEventListener('click', () => $('#imageFileInput')?.click());
      $('#imageFileInput')?.addEventListener('change', (e) => { const file = e.target.files?.[0]; if(file) addImageFile(file); e.target.value = ''; });
    } catch(e) { console.error('Error imageFileInput:', e); }

    try {
      $('#addImageUrlBtn')?.addEventListener('click', addImageUrl);
    } catch(e) { console.error('Error addImageUrlBtn:', e); }

    try {
      $('#sceneList')?.addEventListener('click', (e) => { const btn = e.target.closest('[data-load-scene]'); if(btn) socket.emit('load_scene', { name: btn.dataset.loadScene || btn.getAttribute('data-load-scene') }); });
    } catch(e) { console.error('Error sceneList:', e); }

    try {
      $('#presetList')?.addEventListener('click', (e) => { const btn = e.target.closest('[data-load-preset]'); if(btn) socket.emit('load_preset', { name: btn.dataset.loadPreset || btn.getAttribute('data-load-preset') }); });
    } catch(e) { console.error('Error presetList:', e); }

    try {
      $('#soundList')?.addEventListener('click', (e) => { const play = e.target.closest('[data-play-sound]'); const del = e.target.closest('[data-remove-sound]'); if(play) socket.emit('play_sound', { id: play.dataset.playSound || play.getAttribute('data-play-sound') }); if(del) socket.emit('remove_sound', { id: del.dataset.removeSound || del.getAttribute('data-remove-sound') }); });
    } catch(e) { console.error('Error soundList:', e); }

    try {
      $('#addModeratorBtn')?.addEventListener('click', async () => {
        const name = $('#newModeratorName').value.trim();
        if(!name) return alert('Введите никнейм');
        const res = await fetch('/api/moderators', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name }) });
        const data = await res.json();
        if(res.ok) { alert(`Модератор ${data.username} добавлен. Пароль: ${data.password}`); $('#newModeratorName').value = ''; loadModerators(); }
        else alert(data.error);
      });
    } catch(e) { console.error('Error addModeratorBtn:', e); }

    try {
      const modal = $('#moderatorModal');
      if(modal) {
        modal.style.display = 'none';
        $('.close', modal)?.addEventListener('click', () => {
          modal.style.display = 'none';
          modal.classList.add('hidden');
        });
        $('#closeModalBtn', modal)?.addEventListener('click', () => {
          modal.style.display = 'none';
          modal.classList.add('hidden');
        });
        $('#togglePasswordBtn', modal)?.addEventListener('click', () => {
          const passSpan = $('#modalPassword');
          if(passSpan.dataset.realPassword) {
            if(passSpan.textContent === '••••••••') passSpan.textContent = passSpan.dataset.realPassword;
            else passSpan.textContent = '••••••••';
          }
        });
      }
    } catch(e) { console.error('Error moderatorModal:', e); }

    try {
      const inspectorHandler = (e) => {
        const id = e.target && e.target.id;
        if (id && INSPECTOR_FIELDS.includes(id)) updateSelectedFromInputs();
      };
      document.addEventListener('input', inspectorHandler, true);
      document.addEventListener('change', inspectorHandler, true);
      document.addEventListener('keyup', inspectorHandler, true);
      $$('#inspX,#inspY,#inspW,#inspH,#inspAngle,#inspOpacity,#inspText,#inspUrl').forEach(el => {
        el?.addEventListener('input', updateSelectedFromInputs);
        el?.addEventListener('change', updateSelectedFromInputs);
        el?.addEventListener('keyup', updateSelectedFromInputs);
      });
    } catch(e) { console.error('Error inspector inputs:', e); }

    try {
      if (world) {
        world.addEventListener('pointerdown', onPointerDown);
      }
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    } catch(e) { console.error('Error world pointers:', e); }

    try {
      if (viewport) {
        viewport.addEventListener('wheel', onWheel, { passive: false });
      }
    } catch(e) { console.error('Error viewport wheel:', e); }

    try {
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('resize', () => fitToScreen(false));
    } catch(e) { console.error('Error window listeners:', e); }
  }

  socket.on('connect', () => { state.connected = true; });
  socket.on('room_state', syncRoomState);
  socket.on('meta_updated', (meta) => { state.meta = meta; state.resolution = meta.resolution; renderLists(); renderInspector(); });
  socket.on('element_added', (obj) => {
    const next = normalizeObject(obj);
    const cur = state.objects[next.id];
    if (cur && Number(cur.rev || 0) > Number(next.rev || 0)) return;
    state.objects[next.id] = next;
    buildAssetElement(state.objects[next.id]);
    if (state.role === 'admin') renderSelection();
    flashElement(next.id);
  });
  socket.on('element_updated', (obj) => {
    if (state.role === 'admin' && state.localEdits.has(obj.id)) return;
    const prev = state.objects[obj.id] ? { ...state.objects[obj.id] } : null;
    if (prev && Number(prev.rev || 0) > Number(obj.rev || 0)) return;
    state.objects[obj.id] = normalizeObject({ ...(state.objects[obj.id] || {}), ...obj });
    const el = assetEl(obj.id);
    if (el) {
      syncAssetView(el, state.objects[obj.id], prev);
      flashElement(obj.id);
    } else {
      buildAssetElement(state.objects[obj.id]);
    }
    if(state.role === 'admin') renderSelection();
  });
  socket.on('element_removed', ({ id }) => { removeObject(id, false); renderAll(); });
  socket.on('canvas_cleared', () => { state.objects = {}; state.selected.clear(); renderAll(); });
  socket.on('log_added', (entry) => { state.meta.logs.unshift(entry); state.meta.logs = state.meta.logs.slice(0,50); renderLists(); });
  socket.on('sound_play', (payload) => { if(state.role === 'obs') return; const audio = new Audio(payload.url); audio.volume = payload.volume || 1; audio.play().catch(()=>{}); });
  socket.on('sounds_stop', () => {});

  try {
    const modal = document.getElementById('moderatorModal');
    if (modal) modal.style.display = 'none';
  } catch(e) {}

  bindSpawnButtons();
  wireUI();
  initAuth();
  setInterval(() => { updateDynamicTimers(); if(state.role === 'admin' && state.selected.size === 1) renderInspector(); }, 1000);
})();
/* --- END OF FILE public/app.js --- */