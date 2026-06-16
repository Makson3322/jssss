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
    panY: 0
  };

  function esc(v) {
    return String(v ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
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
      setTimeout(() => video.play().catch(() => {}), 50);
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

  function makeAsset(obj) {
    let el = world.querySelector(`.asset[data-id="${CSS.escape(obj.id)}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'asset';
      el.dataset.id = obj.id;
      el.innerHTML = '<div class="asset-inner"></div>';
      world.appendChild(el);
    }
    const inner = el.querySelector('.asset-inner');
    el.style.left = `${Math.round(obj.left)}px`;
    el.style.top = `${Math.round(obj.top)}px`;
    el.style.width = `${Math.round(obj.width)}px`;
    el.style.height = `${Math.round(obj.height)}px`;
    el.style.opacity = String(obj.opacity);
    el.style.transform = `rotate(${obj.angle || 0}deg)`;
    el.style.visibility = (obj.top < state.resolution.h && obj.visible) ? 'visible' : 'hidden';
    el.style.pointerEvents = 'none';
    renderAssetContent(obj, inner);
  }

  function render(roomState) {
    if (!roomState) return;
    state.meta = roomState.meta || state.meta;
    state.resolution = state.meta.resolution || state.resolution;
    const next = {};
    Object.values(roomState.objects || {}).forEach((o) => {
      const obj = normalizeObject(o);
      next[obj.id] = obj;
    });
    state.objects = next;

    // Clear removed elements
    $$(`.asset`, world).forEach(el => {
      if (!state.objects[el.dataset.id]) el.remove();
    });

    Object.values(state.objects).forEach(obj => {
      if (!obj.visible) return;
      makeAsset(obj);
    });
  }

  async function fetchState() {
    const res = await fetch(`/api/room-state?room=${encodeURIComponent(room)}`, { cache: 'no-store' });
    if (!res.ok) return;
    const roomState = await res.json();
    const h = stableHash(roomState);
    if (h === state.hash) return;
    state.hash = h;
    render(roomState);
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
  fetchState().catch(() => {});
  setInterval(() => fetchState().catch(() => {}), 80);
})();
