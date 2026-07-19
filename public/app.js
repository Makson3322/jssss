(() => {
  console.log('🚀 APP.JS загружен');
  
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const uid = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  
  const urlParams = new URLSearchParams(location.search);
  const room = urlParams.get('room') || 'default';
  const role = document.body.classList.contains('obs-only') ? 'obs' : 'admin';
  
  console.log(`🏠 Комната: ${room}, Роль: ${role}`);
  
  const socket = io({ 
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 5
  });

  const state = {
    room, role,
    connected: false,
    resolution: { w: 1920, h: 1080 },
    meta: { logs: [], scenes: {}, presets: {}, sounds: [], currentLayer: '1' },
    objects: {},
    selected: new Set(),
    zoom: 1, panX: 0, panY: 0, fitZoom: 1,
    isPanning: false, panStart: null, drag: null, rotate: null, resize: null,
    selecting: false, selectionRect: null, spaceDown: false, lockView: false,
    spawnBusy: false, netCounter: 0, _netTimer: null,
    _updateTimer: null,
    _iframeCache: {}
  };

  let currentUsername = null;
  let currentRole = null;

  const world = $('#world');
  const viewport = $('#viewport');
  const selectionBox = $('#selectionBox');
  const netStatus = $('#netStatus');
  const roomPill = $('#roomPill');
  const layerPill = $('#layerPill');
  const zoomPill = $('#zoomPill');

  function setRoomTexts() {
    if (roomPill) roomPill.textContent = `room: ${room}`;
    const obsLink = `${location.origin}/obs.html?room=${encodeURIComponent(room)}`;
    const obsText = $('#obsLinkText');
    if (obsText) obsText.textContent = obsLink;
  }

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

  function currentWorldHeight() {
    return state.resolution.h * (state.role === 'admin' ? 2 : 1);
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
    document.documentElement.style.setProperty('--worldW', `${state.resolution.w}px`);
    document.documentElement.style.setProperty('--worldH', `${currentWorldHeight()}px`);
    document.documentElement.style.setProperty('--obsH', `${state.resolution.h}px`);
    if (world) {
      world.style.width = `${state.resolution.w}px`;
      world.style.height = `${currentWorldHeight()}px`;
      world.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
    }
    if (zoomPill) zoomPill.textContent = `Zoom: ${Math.round(state.zoom * 100)}%`;
  }

  function fitToScreen(forceCenter = true) {
    if (!viewport || !world) return;
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
      timerRemaining: 300000, endsAt: null, items: [], activeIndex: 0, data: {},
      stopwatchRunning: false, stopwatchStart: 0, stopwatchElapsed: 0
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
    if (obj.type === 'stopwatch') {
      obj.stopwatchRunning = !!obj.stopwatchRunning;
      obj.stopwatchStart = Number(obj.stopwatchStart) || 0;
      obj.stopwatchElapsed = Number(obj.stopwatchElapsed) || 0;
    }
    return obj;
  }

  function createPlaceholderDataUrl(label) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" rx="24" fill="#101016"/><rect x="18" y="18" width="924" height="504" rx="18" fill="#7b2cbf" opacity=".18"/><circle cx="140" cy="110" r="52" fill="#7b2cbf" opacity=".65"/><rect x="230" y="88" width="520" height="26" rx="8" fill="#fff" opacity=".18"/><rect x="230" y="130" width="350" height="16" rx="8" fill="#fff" opacity=".10"/><text x="40" y="500" fill="#fff" font-family="Arial, sans-serif" font-size="34" font-weight="700">${esc(label)}</text></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function qrNode(text) {
    if (window.QRCodeStyling) {
      try {
        const container = document.createElement('div');
        const qr = new window.QRCodeStyling({
          width: 256, height: 256, type: 'svg', data: String(text || ''),
          dotsOptions: { color: '#000000', type: 'rounded' },
          backgroundOptions: { color: 'transparent' }
        });
        qr.append(container);
        return container;
      } catch(e) {}
    }
    const img = document.createElement('img');
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(String(text || ''))}`;
    img.alt = 'QR';
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'contain';
    return img;
  }

  function getTimerRemaining(obj) {
    if (!obj) return 0;
    if (obj.timerStatus === 'running') return Math.max(0, Number(obj.endsAt || 0) - Date.now());
    return Math.max(0, Number(obj.timerRemaining || obj.timerDuration || 0));
  }

  function formatTimer(obj) {
    const remaining = getTimerRemaining(obj);
    const s = Math.max(0, Math.floor(remaining / 1000));
    return [Math.floor(s/3600), Math.floor((s%3600)/60), s%60].map(v=>v.toString().padStart(2,'0')).join(':');
  }

  function formatStopwatch(obj) {
    let elapsed = obj.stopwatchElapsed || 0;
    if (obj.stopwatchRunning) {
      elapsed += (Date.now() - (obj.stopwatchStart || 0));
    }
    const totalMs = Math.max(0, elapsed);
    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.floor((totalMs % 3600000) / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);
    const ms = Math.floor((totalMs % 1000) / 100);
    return `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}.${ms}`;
  }

  function assetEl(id) { return world ? world.querySelector(`.asset[data-id="${CSS.escape(id)}"]`) : null; }

  function applyAssetStyle(el, obj) {
    el.style.left = `${obj.left}px`;
    el.style.top = `${obj.top}px`;
    el.style.width = `${obj.width}px`;
    el.style.height = `${obj.height}px`;
    el.style.opacity = obj.opacity ?? 1;
    el.style.transform = `rotate(${obj.angle || 0}deg) scale(${obj.scaleX || 1}, ${obj.scaleY || 1})`;
    el.style.visibility = obj.visible ? 'visible' : 'hidden';
    el.style.zIndex = String(100 + (Number(obj.zIndex || 0) % 10000));
    el.classList.toggle('locked', !!obj.locked);
  }

  // ===== СОЗДАНИЕ IFRAME БЕЗ ЗВУКА =====
  function createIframeElement(obj) {
    const iframe = document.createElement('iframe');
    iframe.className = 'asset-content-iframe';
    iframe.allow = 'autoplay; encrypted-media; fullscreen; clipboard-read; clipboard-write; picture-in-picture; web-share';
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = 'no-referrer-when-downgrade';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';
    iframe.style.background = 'transparent';
    iframe.loading = 'lazy';
    iframe.sandbox = 'allow-scripts allow-same-origin allow-forms allow-popups allow-presentation';
    
    let url = obj.src || 'about:blank';
    let embedUrl = url;
    
    // YouTube - ВСЕГДА БЕЗ ЗВУКА (mute=1)
    if (url.includes('youtube.com/watch') || url.includes('youtu.be') || url.includes('youtube.com/embed')) {
      let videoId = null;
      const patterns = [
        /youtube\.com\/watch\?v=([^&\?]+)/,
        /youtu\.be\/([^&\?]+)/,
        /youtube\.com\/embed\/([^&\?]+)/
      ];
      for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) {
          videoId = match[1];
          break;
        }
      }
      if (videoId) {
        embedUrl = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&mute=1&enablejsapi=1&rel=0&controls=1&modestbranding=1&showinfo=0&origin=${encodeURIComponent(location.origin)}`;
      } else {
        embedUrl = url;
      }
    }
    // Twitch - БЕЗ ЗВУКА (muted=true)
    else if (url.includes('twitch.tv')) {
      const channel = url.match(/twitch\.tv\/([^\/\?]+)/);
      if (channel) {
        embedUrl = `https://player.twitch.tv/?channel=${channel[1]}&parent=${location.hostname}&muted=true&autoplay=true`;
      } else {
        embedUrl = url;
      }
    }
    // Vimeo - БЕЗ ЗВУКА (muted=1)
    else if (url.includes('vimeo.com')) {
      const videoId = url.match(/vimeo\.com\/(\d+)/);
      if (videoId) {
        embedUrl = `https://player.vimeo.com/video/${videoId[1]}?autoplay=1&muted=1&loop=0&title=0&byline=0&portrait=0`;
      } else {
        embedUrl = url;
      }
    }
    // Обычный URL - если вставляем просто ссылку, тоже без звука
    else if (url.startsWith('http')) {
      // Добавляем параметр muted если возможно
      if (url.includes('?')) {
        embedUrl = url + '&muted=1';
      } else {
        embedUrl = url + '?muted=1';
      }
    } else {
      embedUrl = 'about:blank';
    }
    
    iframe.src = embedUrl;
    return iframe;
  }

  function createAssetContent(obj, inner) {
    inner.innerHTML = '';
    const el = inner.parentElement;
    
    switch (obj.type) {
      case 'text': {
        const textBox = document.createElement('div');
        textBox.className = 'asset-content-text';
        textBox.style.cssText = `width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:12px;color:${obj.color || '#fff'};font-size:${obj.fontSize || 34}px;font-weight:${obj.fontWeight || 800};text-align:center;white-space:pre-wrap;word-break:break-word;`;
        textBox.textContent = obj.text || 'Text';
        inner.appendChild(textBox);
        break;
      }
        
      case 'shape': {
        const shape = document.createElement('div');
        shape.className = 'asset-content-shape';
        shape.style.cssText = `width:100%;height:100%;background:${obj.bg || '#7b2cbf'};border-radius:${obj.radius || 10}px;border:${obj.borderWidth || 2}px solid ${obj.borderColor || '#fff'}`;
        inner.appendChild(shape);
        break;
      }
        
      case 'image': {
        const img = document.createElement('img');
        img.className = 'asset-content-image';
        img.src = obj.src || createPlaceholderDataUrl('IMAGE');
        img.alt = obj.name || 'image';
        img.draggable = false;
        img.referrerPolicy = 'no-referrer';
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'contain';
        inner.appendChild(img);
        break;
      }
        
      case 'video':
      case 'browser': {
        let iframe = state._iframeCache[obj.id];
        if (!iframe) {
          iframe = createIframeElement(obj);
          state._iframeCache[obj.id] = iframe;
          if (el) el._iframe = iframe;
        } else {
          if (el) el._iframe = iframe;
        }
        inner.appendChild(iframe);
        break;
      }
        
      case 'qr': {
        inner.appendChild(qrNode(obj.qrText || obj.text || obj.src || ''));
        break;
      }
        
      case 'timer': {
        const wrap = document.createElement('div');
        wrap.className = 'asset-content-timer';
        wrap.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-weight:900;color:#ff0;font-size:42px;text-shadow:3px 3px 0 #000;';
        wrap.textContent = formatTimer(obj);
        inner.appendChild(wrap);
        break;
      }
        
      case 'stopwatch': {
        const wrap = document.createElement('div');
        wrap.className = 'asset-content-stopwatch';
        wrap.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-weight:900;color:#39ff14;font-size:42px;text-shadow:3px 3px 0 #000;font-family:monospace;';
        wrap.textContent = formatStopwatch(obj);
        inner.appendChild(wrap);
        break;
      }
        
      default: {
        const def = document.createElement('div');
        def.className = 'asset-content-default';
        def.style.cssText = `width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:${obj.color||'#fff'};font-size:${obj.fontSize||30}px;font-weight:${obj.fontWeight||700};text-align:center;padding:12px;word-break:break-word;`;
        def.textContent = obj.text || obj.type;
        inner.appendChild(def);
      }
    }
  }

  function updateAssetContent(obj, inner) {
    const textEl = inner.querySelector('.asset-content-text');
    if (textEl) {
      textEl.textContent = obj.text || 'Text';
      textEl.style.color = obj.color || '#ffffff';
      textEl.style.fontSize = (obj.fontSize || 34) + 'px';
      textEl.style.fontWeight = (obj.fontWeight || 800);
      return;
    }
    
    const shapeEl = inner.querySelector('.asset-content-shape');
    if (shapeEl) {
      shapeEl.style.background = obj.bg || '#7b2cbf';
      shapeEl.style.borderRadius = (obj.radius || 10) + 'px';
      shapeEl.style.border = `${obj.borderWidth || 2}px solid ${obj.borderColor || '#fff'}`;
      return;
    }
    
    const imgEl = inner.querySelector('.asset-content-image');
    if (imgEl) {
      if (imgEl.src !== obj.src && obj.src) {
        imgEl.src = obj.src;
      }
      return;
    }
    
    const timerEl = inner.querySelector('.asset-content-timer');
    if (timerEl) {
      timerEl.textContent = formatTimer(obj);
      return;
    }
    
    const stopwatchEl = inner.querySelector('.asset-content-stopwatch');
    if (stopwatchEl) {
      stopwatchEl.textContent = formatStopwatch(obj);
      return;
    }
    
    const defaultEl = inner.querySelector('.asset-content-default');
    if (defaultEl) {
      defaultEl.textContent = obj.text || obj.type;
      defaultEl.style.color = obj.color || '#ffffff';
      defaultEl.style.fontSize = (obj.fontSize || 30) + 'px';
      defaultEl.style.fontWeight = (obj.fontWeight || 700);
      return;
    }
  }

  function buildAssetElement(obj) {
    if (!world) return;
    let el = assetEl(obj.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'asset';
      el.dataset.id = obj.id;
      el.style.pointerEvents = 'none';
      el.innerHTML = `<div class="asset-inner" style="pointer-events:none;"></div><div class="name-tag"></div><div class="handle rot" data-handle="rot"></div><div class="handle tl" data-handle="tl"></div><div class="handle tr" data-handle="tr"></div><div class="handle bl" data-handle="bl"></div><div class="handle br" data-handle="br"></div>`;
      world.appendChild(el);
      if (state.role === 'admin') {
        el.style.pointerEvents = 'auto';
        el.addEventListener('pointerdown', onPointerDown);
        el.addEventListener('click', (e) => {
          if (!e.target.closest('.handle') && !e.target.closest('iframe')) {
            e.preventDefault();
            e.stopPropagation();
          }
        });
      }
    }
    applyAssetStyle(el, obj);
    const inner = el.querySelector('.asset-inner');
    const tag = el.querySelector('.name-tag');
    
    if (!inner.hasChildNodes()) {
      createAssetContent(obj, inner);
    } else {
      updateAssetContent(obj, inner);
    }
    
    tag.textContent = `${(obj.name || obj.type).toUpperCase()} • L${obj.layer}`;
    if (state.role === 'obs') {
      el.classList.remove('selected');
      el.querySelectorAll('.handle').forEach(h => h.remove());
      el.style.pointerEvents = 'none';
    }
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
    if (sounds) sounds.innerHTML = state.meta.sounds.length ? state.meta.sounds.map(s => `<div class="item"><div style="display:flex;justify-content:space-between;align-items:center;"><span>${esc(s.name)}</span></div><div style="display:flex;gap:6px;margin-top:6px;"><button class="btn sm green" data-play-sound="${esc(s.id)}">Play</button><button class="btn sm red" data-remove-sound="${esc(s.id)}">Del</button></div></div>`).join('') : '<div class="item">No sounds added.</div>';
    if (layerPill) layerPill.textContent = `Layer ${state.meta.currentLayer || '1'}`;
  }

  function renderInspector() {
    const selectedCount = $('#selectedCount');
    const empty = $('#inspectorEmpty');
    const body = $('#inspectorBody');
    const timerPanel = $('#timerPanel');
    const stopwatchPanel = $('#stopwatchPanel');
    
    if (selectedCount) selectedCount.textContent = `${state.selected.size} selected`;
    if (!state.selected.size || state.role !== 'admin') {
      empty?.classList.remove('hidden'); body?.classList.add('hidden');
      if (timerPanel) timerPanel.classList.add('hidden');
      if (stopwatchPanel) stopwatchPanel.classList.add('hidden');
      return;
    }
    const obj = state.objects[[...state.selected][0]];
    if (!obj) { empty?.classList.remove('hidden'); body?.classList.add('hidden'); return; }
    empty?.classList.add('hidden'); body?.classList.remove('hidden');
    
    $('#inspType').textContent = obj.type;
    $('#inspX').value = Math.round(obj.left);
    $('#inspY').value = Math.round(obj.top);
    $('#inspW').value = Math.round(obj.width);
    $('#inspH').value = Math.round(obj.height);
    $('#inspAngle').value = Math.round(obj.angle || 0);
    $('#inspOpacity').value = Number(obj.opacity ?? 1);
    
    const textInput = $('#inspText');
    const urlInput = $('#inspUrl');
    const colorInput = $('#inspColor');
    const fontSizeInput = $('#inspFontSize');
    const fontWeightInput = $('#inspFontWeight');
    
    if (textInput && !textInput.matches(':focus')) {
      textInput.value = obj.type === 'qr' ? (obj.qrText || obj.text || obj.src || '') : (obj.text || '');
    }
    if (urlInput && !urlInput.matches(':focus')) {
      urlInput.value = ['browser','image','video'].includes(obj.type) ? (obj.src || '') : '';
    }
    if (colorInput && !colorInput.matches(':focus')) {
      colorInput.value = obj.color || '#ffffff';
    }
    if (fontSizeInput && !fontSizeInput.matches(':focus')) {
      fontSizeInput.value = obj.fontSize || 42;
    }
    if (fontWeightInput && !fontWeightInput.matches(':focus')) {
      fontWeightInput.value = obj.fontWeight || 800;
    }
    
    if (timerPanel) {
      if (obj.type === 'timer') {
        timerPanel.classList.remove('hidden');
        $('#timerDurationInput').value = Math.max(0, Math.round((obj.timerDuration || 0) / 1000));
        $('#timerStatusText').textContent = obj.timerStatus || 'stopped';
        $('#timerRemainingText').textContent = formatTimer(obj);
      } else {
        timerPanel.classList.add('hidden');
      }
    }
    
    if (stopwatchPanel) {
      if (obj.type === 'stopwatch') {
        stopwatchPanel.classList.remove('hidden');
        $('#stopwatchStatusText').textContent = obj.stopwatchRunning ? '▶ Running' : '⏸ Stopped';
        $('#stopwatchTimeText').textContent = formatStopwatch(obj);
      } else {
        stopwatchPanel.classList.add('hidden');
      }
    }
  }

  function addObject(input, emit = true) {
    const obj = normalizeObject(input);
    state.objects[obj.id] = obj;
    buildAssetElement(obj);
    state.selected.clear(); state.selected.add(obj.id);
    renderSelection();
    if (emit && state.role === 'admin') {
      socket.emit('add_element', obj);
    }
    return obj;
  }

  function setObject(id, patch, emit = false) {
    const obj = state.objects[id];
    if (!obj) return null;
    
    Object.assign(obj, patch);
    const el = assetEl(id);
    if (el) {
      applyAssetStyle(el, obj);
      const inner = el.querySelector('.asset-inner');
      if (inner) {
        updateAssetContent(obj, inner);
      }
    }
    renderInspector();
    if (emit && state.role === 'admin') {
      socket.emit('update_element', obj);
    }
    return obj;
  }

  function removeObject(id, emit = true) {
    const el = assetEl(id); if (el) el.remove();
    delete state.objects[id];
    delete state._iframeCache[id];
    state.selected.delete(id);
    renderSelection();
    if (emit && state.role === 'admin') socket.emit('remove_element', { id });
  }

  const spawnDefs = [
    ['text', '📝 Text'], ['shape', '🟦 Shape'], ['image', '🖼 Image'],
    ['browser', '🌐 Browser'], ['video', '🎬 Video'],
    ['qr', '📱 QR code'], ['timer', '⏱ Timer'], ['stopwatch', '⏱️ Stopwatch'],
    ['ticker', '📜 Ticker'], ['progress', '📈 Progress'], ['eventlist', '📜 Event list'],
    ['alertbox', '🔔 Alert'], ['todolist', '✅ To-do'], ['mediashare', '📺 Media share'],
    ['customcode', '🧩 Custom code']
  ];

  function createObjectByType(type, opts = {}) {
    if (state.spawnBusy) return null;
    state.spawnBusy = true;
    
    const h = state.resolution.h;
    const stagingStart = h + 20;
    const stagingEnd = h * 2 - 100;
    const baseY = stagingStart + Math.random() * (stagingEnd - stagingStart - 200);
    const baseX = 50 + Math.random() * Math.max(100, state.resolution.w - 400);
    
    const common = {
      id: uid(), type, left: Math.round(opts.left ?? baseX), top: Math.round(opts.top ?? baseY),
      width: Math.round(opts.width ?? 420), height: Math.round(opts.height ?? 240), angle: 0,
      layer: state.meta.currentLayer || '1', name: opts.name || type,
      text: opts.text || '', src: opts.src || '', color: opts.color || '#ffffff',
      bg: opts.bg || 'rgba(123,44,191,.2)', borderColor: opts.borderColor || '#7b2cbf',
      borderWidth: opts.borderWidth ?? 2, radius: opts.radius ?? 12, fontSize: opts.fontSize ?? 36,
      fontWeight: opts.fontWeight ?? 800, align: opts.align || 'center', data: opts.data || {},
      items: opts.items || [], zIndex: Date.now() % 100000
    };
    
    if (type === 'text') {
      common.text = opts.text || prompt('Text:', 'New text') || 'New text';
      common.width = opts.width || 560; common.height = opts.height || 180;
      common.bg = 'rgba(0,0,0,.18)';
      common.color = opts.color || '#ffffff';
      common.fontSize = opts.fontSize || 42;
      common.fontWeight = opts.fontWeight || 800;
    } else if (type === 'shape') {
      common.width = opts.width || 420; common.height = opts.height || 240;
      common.bg = opts.bg || 'rgba(123,44,191,.85)'; common.borderColor = opts.borderColor || '#39ff14';
    } else if (type === 'image') {
      common.src = opts.src || prompt('Image URL (blank for placeholder):', '') || createPlaceholderDataUrl('IMAGE');
      common.width = opts.width || 520; common.height = opts.height || 300;
    } else if (type === 'video' || type === 'browser') {
      common.src = opts.src || prompt('URL (YouTube/Twitch/any):', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ') || 'about:blank';
      common.width = opts.width || 760; common.height = opts.height || 480;
    } else if (type === 'qr') {
      common.qrText = opts.text || prompt('QR text / URL:', location.href) || location.href;
      common.width = opts.width || 260; common.height = opts.height || 260;
      common.bg = '#fff'; common.borderColor = '#000';
    } else if (type === 'timer') {
      const seconds = parseInt(prompt('Timer duration in seconds:', '3600') || '3600', 10);
      common.width = opts.width || 360; common.height = opts.height || 160;
      common.bg = 'rgba(0,0,0,.4)'; common.color = '#ff0';
      common.timerDuration = Math.max(1, seconds) * 1000;
      common.timerRemaining = common.timerDuration;
      common.timerStatus = 'stopped';
    } else if (type === 'stopwatch') {
      common.width = opts.width || 360; common.height = opts.height || 160;
      common.bg = 'rgba(0,0,0,.4)'; common.color = '#39ff14';
      common.stopwatchRunning = false;
      common.stopwatchStart = 0;
      common.stopwatchElapsed = 0;
      common.text = '⏱️ Stopwatch';
    } else if (type === 'ticker') {
      common.text = opts.text || prompt('Ticker text:', 'Breaking news...') || 'Breaking news...';
      common.width = opts.width || 900; common.height = opts.height || 100;
    } else if (type === 'progress') {
      common.text = opts.text || prompt('Goal title:', 'Follower goal') || 'Follower goal';
      common.data.pct = Math.max(0, Math.min(100, parseInt(prompt('Percent 0-100:', '40') || '40', 10)));
      common.width = opts.width || 640; common.height = opts.height || 180;
    } else if (type === 'eventlist') {
      common.text = opts.text || 'Event list';
      common.items = opts.items || ['Event 1', 'Event 2', 'Event 3'];
      common.width = opts.width || 540; common.height = opts.height || 320;
    } else if (type === 'alertbox') {
      common.text = opts.text || prompt('Alert text:', 'SUBSCRIBE!') || 'SUBSCRIBE!';
      common.width = opts.width || 760; common.height = opts.height || 180;
    } else if (type === 'todolist') {
      common.text = opts.text || 'To-do';
      common.items = opts.items || ['Task one', 'Task two'];
      common.width = opts.width || 420; common.height = opts.height || 320;
    } else if (type === 'mediashare') {
      common.text = 'Media share';
      common.width = opts.width || 640; common.height = opts.height || 360;
    } else if (type === 'customcode') {
      common.text = opts.text || 'Custom code';
      common.width = opts.width || 560; common.height = opts.height || 300;
    }
    const obj = addObject(common);
    setTimeout(() => { state.spawnBusy = false; }, 120);
    return obj;
  }

  function bindSpawnButtons() {
    const host = $('#spawnButtons');
    if (!host || host.dataset.bound === '1') return;
    host.dataset.bound = '1';
    host.innerHTML = spawnDefs.map(([type, label]) => `<button type="button" class="btn sm" data-spawn="${esc(type)}">${esc(label)}</button>`).join('');
    host.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-spawn]');
      if (btn) {
        createObjectByType(btn.dataset.spawn);
      }
    });
  }

  function selectOnly(id, additive = false) {
    if (!additive) state.selected.clear();
    if (id) { if (additive && state.selected.has(id)) state.selected.delete(id); else state.selected.add(id); }
    renderSelection();
  }

  function renderObject(obj) {
    if (!obj || !obj.visible) return;
    if (state.role === 'obs' && obj.top >= state.resolution.h) return;
    buildAssetElement(obj);
  }

  function renderAll() {
    if (!world) return;
    world.querySelectorAll('.asset').forEach(el => { 
      const id = el.dataset.id; 
      const obj = state.objects[id]; 
      if (!obj || !obj.visible) {
        el.remove();
        delete state._iframeCache[id];
        return;
      }
      if (state.role === 'obs' && obj.top >= state.resolution.h) {
        el.remove();
        delete state._iframeCache[id];
        return;
      }
    });
    Object.values(state.objects).forEach(obj => renderObject(obj));
    renderSelection(); renderLists(); applyView(); updateDynamicTimers();
  }

  function updateDynamicTimers() {
    Object.values(state.objects).forEach(obj => {
      if (obj.type === 'timer') {
        const el = assetEl(obj.id);
        if (el) { 
          const tc = el.querySelector('.asset-content-timer');
          if (tc) tc.textContent = formatTimer(obj);
        }
        if (obj.timerStatus === 'running' && getTimerRemaining(obj) <= 0) {
          obj.timerStatus = 'stopped';
          obj.timerRemaining = 0;
          obj.endsAt = null;
          setObject(obj.id, { timerStatus: 'stopped', timerRemaining: 0, endsAt: null }, true);
        }
      }
      if (obj.type === 'stopwatch') {
        const el = assetEl(obj.id);
        if (el) { 
          const sw = el.querySelector('.asset-content-stopwatch');
          if (sw) sw.textContent = formatStopwatch(obj);
        }
      }
    });
  }

  function addImageFile(file) { if (!file) return; const reader = new FileReader(); reader.onload = () => createObjectByType('image', { src: String(reader.result || '') }); reader.readAsDataURL(file); }
  function addImageUrl() { const url = prompt('Image URL:', 'https://'); if (url) createObjectByType('image', { src: url.startsWith('data:') ? url : normalizeUrl(url) }); }

  function updateSelectedFromInputs() {
    const obj = state.objects[[...state.selected][0]]; 
    if (!obj) return;
    
    const textValue = $('#inspText')?.value || '';
    const urlValue = $('#inspUrl')?.value || '';
    
    obj.left = Number($('#inspX').value || 0);
    obj.top = Number($('#inspY').value || 0);
    obj.width = Math.max(16, Number($('#inspW').value || 16));
    obj.height = Math.max(16, Number($('#inspH').value || 16));
    obj.angle = Number($('#inspAngle').value || 0);
    obj.opacity = Math.max(0, Math.min(1, Number($('#inspOpacity').value || 1)));
    
    if (['browser','image','video'].includes(obj.type)) {
      obj.src = normalizeUrl(urlValue);
    }
    if (obj.type === 'qr') {
      obj.qrText = textValue.trim();
      obj.text = obj.qrText;
    } else {
      obj.text = textValue;
    }
    
    obj.color = $('#inspColor').value || '#ffffff';
    obj.fontSize = Number($('#inspFontSize').value) || 42;
    obj.fontWeight = Number($('#inspFontWeight').value) || 800;
    
    setObject(obj.id, { 
      left: obj.left, top: obj.top, width: obj.width, height: obj.height, angle: obj.angle, 
      opacity: obj.opacity, src: obj.src, text: obj.text, qrText: obj.qrText,
      color: obj.color, fontSize: obj.fontSize, fontWeight: obj.fontWeight
    }, true);
  }

  function timerAction(action) {
    const obj = state.objects[[...state.selected][0]]; 
    if (!obj || obj.type !== 'timer') return;
    const durMs = Math.max(0, Math.round(Number($('#timerDurationInput')?.value || 0) * 1000));
    if (action === 'set-duration') { 
      obj.timerDuration = durMs; 
      if (obj.timerStatus !== 'running') obj.timerRemaining = durMs; 
      if (obj.timerStatus === 'running') obj.endsAt = Date.now() + durMs; 
    }
    else if (action === 'start') { 
      const remaining = obj.timerRemaining > 0 ? obj.timerRemaining : (obj.timerDuration || durMs || 0); 
      obj.timerStatus = 'running'; 
      obj.endsAt = Date.now() + remaining; 
      obj.timerRemaining = remaining; 
    }
    else if (action === 'pause') { 
      if (obj.timerStatus === 'running') { 
        obj.timerRemaining = getTimerRemaining(obj); 
        obj.timerStatus = 'paused'; 
        obj.endsAt = null; 
      } 
    }
    else if (action === 'stop' || action === 'reset') { 
      obj.timerStatus = 'stopped'; 
      obj.endsAt = null; 
      obj.timerRemaining = obj.timerDuration || durMs || 0; 
    }
    else if (action === 'add10') { 
      obj.timerRemaining = Math.max(0, getTimerRemaining(obj) + 10000); 
      obj.timerDuration = obj.timerRemaining; 
      if (obj.timerStatus === 'running') obj.endsAt = Date.now() + obj.timerRemaining; 
    }
    else if (action === 'sub10') { 
      obj.timerRemaining = Math.max(0, getTimerRemaining(obj) - 10000); 
      obj.timerDuration = obj.timerRemaining; 
      if (obj.timerStatus === 'running') obj.endsAt = Date.now() + obj.timerRemaining; 
    }
    setObject(obj.id, { timerDuration: obj.timerDuration, timerStatus: obj.timerStatus, timerRemaining: obj.timerRemaining, endsAt: obj.endsAt }, true);
    renderInspector();
  }

  function stopwatchAction(action) {
    const obj = state.objects[[...state.selected][0]]; 
    if (!obj || obj.type !== 'stopwatch') return;
    
    if (action === 'start') {
      if (!obj.stopwatchRunning) {
        obj.stopwatchRunning = true;
        obj.stopwatchStart = Date.now();
      }
    }
    else if (action === 'pause') {
      if (obj.stopwatchRunning) {
        obj.stopwatchRunning = false;
        obj.stopwatchElapsed += (Date.now() - (obj.stopwatchStart || 0));
        obj.stopwatchStart = 0;
      }
    }
    else if (action === 'reset') {
      obj.stopwatchRunning = false;
      obj.stopwatchStart = 0;
      obj.stopwatchElapsed = 0;
    }
    setObject(obj.id, { 
      stopwatchRunning: obj.stopwatchRunning, 
      stopwatchStart: obj.stopwatchStart, 
      stopwatchElapsed: obj.stopwatchElapsed 
    }, true);
    renderInspector();
  }

  function duplicateSelected() {
    if (!state.selected.size) return;
    const ids = [...state.selected];
    const next = [];
    ids.forEach(id => {
      const src = state.objects[id]; if (!src) return;
      const dup = normalizeObject(JSON.parse(JSON.stringify(src)));
      dup.id = uid(); 
      dup.left += 20; 
      dup.top += 120 + Math.random() * 100;
      if (dup.type === 'timer') { dup.endsAt = null; dup.timerStatus = 'stopped'; dup.timerRemaining = dup.timerDuration; }
      if (dup.type === 'stopwatch') { dup.stopwatchRunning = false; dup.stopwatchStart = 0; dup.stopwatchElapsed = 0; }
      addObject(dup); next.push(dup.id);
    });
    state.selected = new Set(next); renderSelection();
  }

  function moveSelectedByScene(deltaY) {
    [...state.selected].forEach(id => { 
      const obj = state.objects[id]; 
      if (!obj) return; 
      obj.top += deltaY; 
      setObject(id, { top: obj.top }, true); 
    });
    renderAll();
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
    if (e.target.closest('iframe') || e.target.closest('video')) {
      return;
    }
    const handle = e.target.closest('.handle');
    const asset = e.target.closest('.asset');
    const pt = screenToWorld(e.clientX, e.clientY);
    if (handle && asset) {
      const id = asset.dataset.id; const obj = state.objects[id]; if (!obj || obj.locked) return;
      selectOnly(id);
      if (['br','tl','tr','bl'].includes(handle.dataset.handle)) { 
        state.resize = { id, start: pt, handle: handle.dataset.handle, startObj: { ...obj } }; 
      } else if (handle.dataset.handle === 'rot') { 
        const cx = obj.left + obj.width/2, cy = obj.top + obj.height/2; 
        state.rotate = { id, center: { x: cx, y: cy }, startAngle: obj.angle || 0, startMouseAngle: Math.atan2(pt.y-cy, pt.x-cx) }; 
      }
      e.preventDefault(); return;
    }
    if (asset) {
      const id = asset.dataset.id; const obj = state.objects[id]; if (!obj) return;
      if (e.shiftKey) { if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id); renderSelection(); return; }
      selectOnly(id); if (obj.locked) return;
      state.drag = { id, start: pt, startObj: { left: obj.left, top: obj.top } };
      e.preventDefault(); return;
    }
    selectOnly(null);
    if (e.button === 1 || state.spaceDown) {
      state.isPanning = true; state.panStart = { x: e.clientX, y: e.clientY, panX: state.panX, panY: state.panY };
      viewport.style.cursor = 'grabbing'; e.preventDefault();
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
      const obj = state.objects[state.drag.id]; 
      if (!obj) return;
      obj.left = Math.round(state.drag.startObj.left + (pt.x - state.drag.start.x));
      obj.top = Math.round(state.drag.startObj.top + (pt.y - state.drag.start.y));
      const el = assetEl(obj.id);
      if (el) {
        el.style.left = `${obj.left}px`;
        el.style.top = `${obj.top}px`;
      }
      if (state._updateTimer) clearTimeout(state._updateTimer);
      state._updateTimer = setTimeout(() => {
        if (state.drag) {
          socket.emit('update_element', obj);
        }
        state._updateTimer = null;
      }, 20);
    } else if (state.resize) {
      const obj = state.objects[state.resize.id]; 
      if (!obj) return;
      const dx = pt.x - state.resize.start.x, dy = pt.y - state.resize.start.y;
      const h = state.resize.handle;
      if (h === 'br') { obj.width = Math.max(24, Math.round(state.resize.startObj.width + dx)); obj.height = Math.max(24, Math.round(state.resize.startObj.height + dy)); }
      if (h === 'tl') { obj.width = Math.max(24, Math.round(state.resize.startObj.width - dx)); obj.height = Math.max(24, Math.round(state.resize.startObj.height - dy)); obj.left = Math.round(state.resize.startObj.left + dx); obj.top = Math.round(state.resize.startObj.top + dy); }
      if (h === 'tr') { obj.width = Math.max(24, Math.round(state.resize.startObj.width + dx)); obj.height = Math.max(24, Math.round(state.resize.startObj.height - dy)); obj.top = Math.round(state.resize.startObj.top + dy); }
      if (h === 'bl') { obj.width = Math.max(24, Math.round(state.resize.startObj.width - dx)); obj.height = Math.max(24, Math.round(state.resize.startObj.height + dy)); obj.left = Math.round(state.resize.startObj.left + dx); }
      const el = assetEl(obj.id);
      if (el) {
        el.style.left = `${obj.left}px`;
        el.style.top = `${obj.top}px`;
        el.style.width = `${obj.width}px`;
        el.style.height = `${obj.height}px`;
      }
      if (state._updateTimer) clearTimeout(state._updateTimer);
      state._updateTimer = setTimeout(() => {
        if (state.resize) {
          socket.emit('update_element', obj);
        }
        state._updateTimer = null;
      }, 20);
    } else if (state.rotate) {
      const obj = state.objects[state.rotate.id]; 
      if (!obj) return;
      const angle = Math.atan2(pt.y - state.rotate.center.y, pt.x - state.rotate.center.x);
      const deg = Math.round((state.rotate.startAngle + ((angle - state.rotate.startMouseAngle) * 180 / Math.PI)) / 5) * 5;
      obj.angle = deg;
      const el = assetEl(obj.id);
      if (el) {
        el.style.transform = `rotate(${obj.angle}deg) scale(${obj.scaleX || 1}, ${obj.scaleY || 1})`;
      }
      if (state._updateTimer) clearTimeout(state._updateTimer);
      state._updateTimer = setTimeout(() => {
        if (state.rotate) {
          socket.emit('update_element', obj);
        }
        state._updateTimer = null;
      }, 20);
    } else if (state.isPanning) {
      state.panX = state.panStart.panX + (e.clientX - state.panStart.x); 
      state.panY = state.panStart.panY + (e.clientY - state.panStart.y);
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
    selectionBox.style.display = 'none'; 
    state.selecting = false; 
    state.isPanning = false; 
    state.selectionRect = null;
    viewport.style.cursor = 'default';
    
    if (state.drag) {
      const obj = state.objects[state.drag.id];
      if (obj) {
        clearTimeout(state._updateTimer);
        socket.emit('update_element', obj);
      }
      state.drag = null;
    }
    if (state.resize) {
      const obj = state.objects[state.resize.id];
      if (obj) {
        clearTimeout(state._updateTimer);
        socket.emit('update_element', obj);
      }
      state.resize = null;
    }
    if (state.rotate) {
      const obj = state.objects[state.rotate.id];
      if (obj) {
        clearTimeout(state._updateTimer);
        socket.emit('update_element', obj);
      }
      state.rotate = null;
    }
    state._updateTimer = null;
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
    if (state.role !== 'admin') return;
    
    const activeElement = document.activeElement;
    const isInputFocused = activeElement && (
      activeElement.tagName === 'INPUT' ||
      activeElement.tagName === 'TEXTAREA' ||
      activeElement.tagName === 'SELECT' ||
      activeElement.isContentEditable
    );
    
    const selected = [...state.selected];
    
    if ((e.key === 'Delete' || e.key === 'Backspace') && !isInputFocused) {
      e.preventDefault();
      selected.forEach(id => removeObject(id));
      return;
    }
    
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && !isInputFocused) {
      const step = e.shiftKey ? 20 : 5;
      if (e.key === 'ArrowLeft' && selected.length) {
        selected.forEach(id => setObject(id, { left: state.objects[id].left - step }, true));
      } else if (e.key === 'ArrowRight' && selected.length) {
        selected.forEach(id => setObject(id, { left: state.objects[id].left + step }, true));
      } else if (e.key === 'ArrowUp' && selected.length) {
        selected.forEach(id => setObject(id, { top: state.objects[id].top - step }, true));
      } else if (e.key === 'ArrowDown' && selected.length) {
        selected.forEach(id => setObject(id, { top: state.objects[id].top + step }, true));
      }
      renderAll();
    }
  }

  function onKeyUp(e) { if (e.code === 'Space') state.spaceDown = false; }

  function syncRoomState(roomState) {
    state.meta = roomState.meta || state.meta;
    state.resolution = state.meta.resolution || state.resolution;
    state.objects = {};
    state._iframeCache = {};
    if (roomState.objects) Object.values(roomState.objects).forEach(obj => { state.objects[obj.id] = normalizeObject(obj); });
    renderAll();
  }

  async function loadModerators() {
    if (currentRole !== 'streamer') return;
    try {
      const res = await fetch('/api/moderators');
      const mods = await res.json();
      const container = $('#moderatorsTable');
      if (container) {
        container.innerHTML = mods.map(m => `<div class="item"><div style="display:flex;justify-content:space-between;align-items:center;"><span><span class="status-dot ${m.online ? 'online' : 'offline'}"></span> ${esc(m.username)}</span><div><button class="btn sm purple info-moderator" data-username="${esc(m.username)}">Инфо</button><button class="btn sm red delete-moderator" data-username="${esc(m.username)}">Удалить</button></div></div></div>`).join('');
        $$('.info-moderator').forEach(btn => btn.onclick = () => showModeratorModal(btn.dataset.username));
        $$('.delete-moderator').forEach(btn => btn.onclick = async () => { if (confirm('Удалить модератора?')) { await fetch(`/api/moderators/${btn.dataset.username}`, { method: 'DELETE' }); loadModerators(); } });
      }
    } catch(e) { console.error(e); }
  }

  async function showModeratorModal(username) {
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
    modal.classList.remove('hidden');
  }

  async function initAuth() {
    if (state.role === 'obs') {
      currentUsername = 'obs_viewer'; currentRole = 'obs';
      socket.emit('auth', { username: currentUsername });
      socket.emit('join_room', { room, role: 'obs', username: currentUsername });
      setRoomTexts(); fitToScreen(true); renderLists();
      return;
    }
    try {
      const res = await fetch('/api/me');
      if (!res.ok) { 
        window.location.href = '/login'; 
        return; 
      }
      const data = await res.json();
      currentUsername = data.username; currentRole = data.role;
      $('#userName').textContent = currentUsername;
      
      const modSection = $('#moderatorsSection');
      if (modSection) {
        if (currentRole === 'streamer') {
          modSection.style.display = 'block';
          loadModerators();
          socket.on('moderators_update', loadModerators);
        } else modSection.style.display = 'none';
      }
      
      socket.emit('auth', { username: currentUsername });
      socket.emit('join_room', { room, role: 'admin', username: currentUsername }, (ack) => {
        console.log('✅ Присоединился к комнате:', ack);
      });
      setRoomTexts(); fitToScreen(true); renderLists();
    } catch(err) { 
      console.error('Ошибка авторизации:', err);
      window.location.href = '/login'; 
    }
  }

  function wireUI() {
    $('#fitBtn')?.addEventListener('click', () => fitToScreen(true));
    $('#copyObsLinkBtn')?.addEventListener('click', () => { 
      const txt = $('#obsLinkText')?.textContent || ''; 
      navigator.clipboard?.writeText(txt); 
    });
    
    $('#resolutionSelect')?.addEventListener('change', () => { 
      const [w, h] = $('#resolutionSelect').value.split('x').map(Number); 
      socket.emit('set_resolution', { w, h }, (res) => {
        if (res?.ok) {
          state.resolution = res.resolution;
          fitToScreen(true);
        }
      }); 
    });
    
    $('#layerSelect')?.addEventListener('change', () => { 
      const layer = $('#layerSelect').value; 
      socket.emit('set_layer', { layer }); 
    });
    $('#clearCanvasBtn')?.addEventListener('click', () => socket.emit('clear_canvas', {}));
    $('#clearAllBtn')?.addEventListener('click', () => socket.emit('clear_canvas', {}));
    $('#deleteBtn')?.addEventListener('click', () => [...state.selected].forEach(id => removeObject(id)));
    $('#deleteSelectedBtn')?.addEventListener('click', () => [...state.selected].forEach(id => removeObject(id)));
    $('#pushLiveBtn')?.addEventListener('click', () => moveSelectedByScene(-state.resolution.h));
    $('#swapBtn')?.addEventListener('click', () => moveSelectedByScene(state.resolution.h));
    $('#saveSceneBtn')?.addEventListener('click', () => { 
      const name = $('#sceneNameInput').value.trim(); 
      if(name) socket.emit('save_scene', { name }); 
    });
    $('#savePresetBtn')?.addEventListener('click', () => { 
      const name = $('#presetNameInput').value.trim(); 
      if(name) socket.emit('save_preset', { name }); 
    });
    $('#addSoundBtn')?.addEventListener('click', () => { 
      const name = $('#soundNameInput').value.trim(); 
      const url = $('#soundUrlInput').value.trim(); 
      if(url) socket.emit('save_sound', { name, url }); 
    });
    $('#stopAllSoundBtn')?.addEventListener('click', () => socket.emit('stop_sounds', {}));
    $('#applyPropsBtn')?.addEventListener('click', updateSelectedFromInputs);
    $('#dupBtn')?.addEventListener('click', duplicateSelected);
    $('#toLiveBtn')?.addEventListener('click', () => moveSelectedByScene(-state.resolution.h));
    $('#toStageBtn')?.addEventListener('click', () => moveSelectedByScene(state.resolution.h));
    $('#addImageFileBtn')?.addEventListener('click', () => $('#imageFileInput')?.click());
    $('#imageFileInput')?.addEventListener('change', (e) => { 
      const file = e.target.files?.[0]; 
      if(file) addImageFile(file); 
      e.target.value = ''; 
    });
    $('#addImageUrlBtn')?.addEventListener('click', addImageUrl);
    $('#sceneList')?.addEventListener('click', (e) => { 
      const btn = e.target.closest('[data-load-scene]'); 
      if(btn) socket.emit('load_scene', { name: btn.dataset.loadScene || btn.getAttribute('data-load-scene') }); 
    });
    $('#presetList')?.addEventListener('click', (e) => { 
      const btn = e.target.closest('[data-load-preset]'); 
      if(btn) socket.emit('load_preset', { name: btn.dataset.loadPreset || btn.getAttribute('data-load-preset') }); 
    });
    $('#soundList')?.addEventListener('click', (e) => { 
      const play = e.target.closest('[data-play-sound]'); 
      const del = e.target.closest('[data-remove-sound]'); 
      if(play) socket.emit('play_sound', { id: play.dataset.playSound || play.getAttribute('data-play-sound') }); 
      if(del) socket.emit('remove_sound', { id: del.dataset.removeSound || del.getAttribute('data-remove-sound') }); 
    });
    $('#addModeratorBtn')?.addEventListener('click', async () => {
      const name = $('#newModeratorName').value.trim();
      if(!name) return alert('Введите никнейм');
      const res = await fetch('/api/moderators', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ username: name }) 
      });
      const data = await res.json();
      if(res.ok) { 
        alert(`Модератор ${data.username} добавлен. Пароль: ${data.password}`); 
        $('#newModeratorName').value = ''; 
        loadModerators(); 
      } else alert(data.error);
    });
    
    $('#timerSetDurationBtn')?.addEventListener('click', () => timerAction('set-duration'));
    $('#timerStartBtn')?.addEventListener('click', () => timerAction('start'));
    $('#timerPauseBtn')?.addEventListener('click', () => timerAction('pause'));
    $('#timerStopBtn')?.addEventListener('click', () => timerAction('stop'));
    $('#timerResetBtn')?.addEventListener('click', () => timerAction('reset'));
    $('#timerPlus10Btn')?.addEventListener('click', () => timerAction('add10'));
    $('#timerMinus10Btn')?.addEventListener('click', () => timerAction('sub10'));
    
    $('#stopwatchStartBtn')?.addEventListener('click', () => stopwatchAction('start'));
    $('#stopwatchPauseBtn')?.addEventListener('click', () => stopwatchAction('pause'));
    $('#stopwatchResetBtn')?.addEventListener('click', () => stopwatchAction('reset'));
    
    const modal = $('#moderatorModal');
    if(modal) {
      $('.close', modal)?.addEventListener('click', () => modal.classList.add('hidden'));
      $('#closeModalBtn', modal)?.addEventListener('click', () => modal.classList.add('hidden'));
      $('#togglePasswordBtn', modal)?.addEventListener('click', () => {
        const passSpan = $('#modalPassword');
        if(passSpan.dataset.realPassword) {
          if(passSpan.textContent === '••••••••') passSpan.textContent = passSpan.dataset.realPassword;
          else passSpan.textContent = '••••••••';
        }
      });
    }
    
    const textInput = $('#inspText');
    const urlInput = $('#inspUrl');
    const colorInput = $('#inspColor');
    const fontSizeInput = $('#inspFontSize');
    const fontWeightInput = $('#inspFontWeight');
    
    if (textInput) {
      textInput.addEventListener('input', () => {
        const obj = state.objects[[...state.selected][0]];
        if (!obj) return;
        if (obj.type === 'qr') {
          obj.qrText = textInput.value.trim();
          obj.text = obj.qrText;
        } else {
          obj.text = textInput.value;
        }
        const el = assetEl(obj.id);
        if (el) {
          const inner = el.querySelector('.asset-inner');
          if (inner) updateAssetContent(obj, inner);
        }
      });
      textInput.addEventListener('blur', updateSelectedFromInputs);
    }
    
    if (urlInput) {
      urlInput.addEventListener('input', () => {
        const obj = state.objects[[...state.selected][0]];
        if (!obj || !['browser','image','video'].includes(obj.type)) return;
        obj.src = urlInput.value;
        const el = assetEl(obj.id);
        if (el) {
          const inner = el.querySelector('.asset-inner');
          if (inner) updateAssetContent(obj, inner);
        }
      });
      urlInput.addEventListener('blur', updateSelectedFromInputs);
    }
    
    const numberFields = ['#inspX', '#inspY', '#inspW', '#inspH', '#inspAngle', '#inspOpacity'];
    numberFields.forEach(sel => {
      const el = document.querySelector(sel);
      if (el) el.addEventListener('change', updateSelectedFromInputs);
    });
    
    if (colorInput) colorInput.addEventListener('input', updateSelectedFromInputs);
    if (fontSizeInput) fontSizeInput.addEventListener('input', updateSelectedFromInputs);
    if (fontWeightInput) fontWeightInput.addEventListener('input', updateSelectedFromInputs);
    
    world?.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    viewport?.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('resize', () => fitToScreen(false));
  }

  socket.on('connect', () => { 
    state.connected = true; 
    console.log('✅ Socket.IO подключён');
  });

  socket.on('room_state', (roomState) => {
    syncRoomState(roomState);
  });

  socket.on('meta_updated', (meta) => { 
    state.meta = meta; 
    state.resolution = meta.resolution; 
    renderLists(); 
    renderInspector(); 
  });

  socket.on('element_added', (obj) => { 
    state.objects[obj.id] = normalizeObject(obj); 
    buildAssetElement(state.objects[obj.id]); 
    renderAll(); 
    flashElement(obj.id); 
  });

  socket.on('element_updated', (obj) => {
    state.objects[obj.id] = normalizeObject({ ...(state.objects[obj.id] || {}), ...obj });
    const el = assetEl(obj.id);
    if(el) { 
      applyAssetStyle(el, state.objects[obj.id]); 
      const inner = el.querySelector('.asset-inner'); 
      if(inner) updateAssetContent(state.objects[obj.id], inner);
      flashElement(obj.id); 
    } else {
      buildAssetElement(state.objects[obj.id]);
    }
    if(state.role === 'admin') renderSelection();
  });

  socket.on('element_removed', ({ id }) => { 
    removeObject(id, false); 
    renderAll(); 
  });

  socket.on('canvas_cleared', () => { 
    state.objects = {}; 
    state._iframeCache = {};
    state.selected.clear(); 
    renderAll(); 
  });

  socket.on('log_added', (entry) => { 
    state.meta.logs.unshift(entry); 
    state.meta.logs = state.meta.logs.slice(0,50); 
    renderLists(); 
  });

  socket.on('sound_play', (payload) => { 
    if(state.role === 'obs') return; 
    const audio = new Audio(payload.url); 
    audio.volume = payload.volume || 1; 
    audio.play().catch(()=>{}); 
  });

  socket.on('sounds_stop', () => {});

  bindSpawnButtons();
  wireUI();
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAuth);
  } else {
    initAuth();
  }
  
  setInterval(() => { 
    updateDynamicTimers(); 
    if(state.role === 'admin' && state.selected.size === 1) renderInspector(); 
  }, 100);
})();
