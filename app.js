/* VYBE 2.0 — application / UI layer (shared by the web build and the Android WebView) */
(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const S = VStore.settings, Hist = VStore.History;
  const NATIVE = !!window.VybeNative;
  const engine = NATIVE ? new VEngine.NativeEngine() : new VEngine.WebEngine($('#vhost'));
  const root = document.documentElement, player = $('#player');
  if (NATIVE) root.classList.add('native');

  /* ───────────────────────── helpers ───────────────────────── */
  const NS = 'http://www.w3.org/2000/svg';
  function h(tag, attrs) {
    const e = document.createElement(tag);
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (k === 'class') e.className = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (let i = 2; i < arguments.length; i++) [].concat(arguments[i]).forEach(x => { if (x != null && x !== false) e.append(x.nodeType ? x : document.createTextNode(x)); });
    return e;
  }
  function ico(n, cls) {
    const s = document.createElementNS(NS, 'svg'), u = document.createElementNS(NS, 'use');
    s.setAttribute('class', 'i' + (cls ? ' ' + cls : '')); u.setAttribute('href', '#i-' + n); s.append(u); return s;
  }
  function setIcon(btn, n) { btn.querySelector('use').setAttribute('href', '#i-' + n); }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmt = t => {
    if (!isFinite(t) || t < 0) t = 0;
    const hh = Math.floor(t / 3600), mm = Math.floor(t % 3600 / 60), ss = String(Math.floor(t % 60)).padStart(2, '0');
    return hh ? hh + ':' + String(mm).padStart(2, '0') + ':' + ss : mm + ':' + ss;
  };
  const bytes = b => !b ? '' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB';
  const base = n => n.replace(/\.[^.]+$/, '').toLowerCase();
  const isSub = n => /\.(srt|vtt|ass|ssa)$/i.test(n);
  const isVideo = f => /^video\//.test(f.type) || /\.(mp4|m4v|mkv|webm|mov|avi|ts|flv|wmv|3gp|ogv|mpg|mpeg)$/i.test(f.name);
  let toastT;
  function toast(msg, ms) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms || 2400);
  }

  /* ───────────────────────── state ───────────────────────── */
  const Q = { items: [], i: -1, shuffle: false, repeat: 'off', order: [] };
  let uid = 0, view = 'home', locked = false, playing = false;
  let subs = { list: [], active: null, delay: 0, native: '' };
  let ab = { a: null, b: null };
  let tracks = { audio: [], text: [] };
  let sleepT = null, sleepAt = 0, sleepEnd = false;
  let thumbOf = {}, lastSave = 0, rafId = 0, orient = 'auto';
  const cur = () => Q.items[Q.i];

  /* ───────────────────────── queue ───────────────────────── */
  const itemFromFile = f => ({ id: ++uid, key: 'f:' + f.name + ':' + f.size + ':' + f.lastModified, name: f.name, size: f.size, kind: 'file', file: f });
  function itemFromUrl(u) {
    let name = u; try { name = decodeURIComponent(new URL(u).pathname.split('/').pop()) || u; } catch (e) {}
    return { id: ++uid, key: 'u:' + u, name, kind: 'url', url: u };
  }
  const itemFromNative = n => ({ id: ++uid, key: 'n:' + n.uri, name: n.name || 'Video', size: n.size, kind: 'native', uri: n.uri, mime: n.mime });

  function enqueue(items, play) {
    const first = Q.items.length;
    items.forEach(it => { if (!Q.items.some(x => x.key === it.key)) Q.items.push(it); else if (play && it === items[0]) items[0] = Q.items.find(x => x.key === it.key); });
    renderHome();
    if (play && items.length) playIndex(Q.items.indexOf(items[0]) >= 0 ? Q.items.indexOf(items[0]) : first);
  }

  async function addFiles(fileList, opts) {
    opts = opts || {};
    const files = [].slice.call(fileList);
    const vids = files.filter(f => !isSub(f.name) && isVideo(f)), sf = files.filter(f => isSub(f.name));
    if (!vids.length && !sf.length) { toast('No supported video files selected'); return; }
    const items = vids.map(itemFromFile);
    if (items.length) enqueue(items, opts.play !== false && Q.i < 0 || opts.play === true);
    if (sf.length) {
      // match by name to the video that was just added, else to the current video
      for (const f of sf) await loadSubFile(f, { quiet: sf.length > 1 && !items.length, auto: items.length > 0 });
      if (items.length && Q.i >= 0) { /* subs attached once playback starts */ }
    }
    pendingSubs = sf.concat(pendingSubs).filter((f, i, a) => a.indexOf(f) === i);
  }
  let pendingSubs = [];

  function nextIndex(dir) {
    const n = Q.items.length; if (!n) return -1;
    if (Q.shuffle && n > 1) {
      if (dir > 0) { let j; do { j = Math.floor(Math.random() * n); } while (j === Q.i); return j; }
      return Q.hist && Q.hist.length ? Q.hist.pop() : Q.i;
    }
    const j = Q.i + dir;
    if (j >= 0 && j < n) return j;
    return Q.repeat === 'all' ? (j + n) % n : -1;
  }

  /* ───────────────────────── playback ───────────────────────── */
  function setView(v) {
    view = v; root.dataset.view = v;
    if (v === 'player') {
      history.pushState({ v: 'player' }, '');
      if (!rafId) rafId = requestAnimationFrame(tick);
    } else { cancelAnimationFrame(rafId); rafId = 0; }
    if (NATIVE) engine.call('immersive', { on: v === 'player' });
  }

  async function playIndex(i, opts) {
    const it = Q.items[i]; if (!it) return;
    opts = opts || {};
    if (view === 'player' && Q.i >= 0) saveProgress(true);
    if (Q.i >= 0 && Q.i !== i) (Q.hist = Q.hist || []).push(Q.i);
    Q.i = i;
    ab = { a: null, b: null }; updateAB();
    subs.list = []; subs.active = null; subs.delay = 0; subs.native = ''; $('#subs').innerHTML = ''; subKey = '';
    tracks = { audio: [], text: [] };
    zoom = 1; engine.setZoom(1);
    engine.setAspect(S.aspect); updateAspectBtn();
    $('#errbox').hidden = true;
    $('#nowTitle').textContent = it.name;
    $('#nowMeta').textContent = [bytes(it.size), NATIVE ? 'Native' : it.kind === 'url' ? 'Stream' : 'Local file'].filter(Boolean).join(' · ');
    $('#tDur').textContent = '0:00'; $('#tCur').textContent = '0:00';
    $('#seekFill').style.transform = 'scaleX(0)'; $('#seekBuf').style.transform = 'scaleX(0)'; $('#seekKnob').style.left = '0';
    if (view !== 'player') { setView('player'); enterFullscreen(); }
    showUI(true);
    const rec = Hist.find(it.key);
    let start = opts.start;
    if (start == null) start = (S.resume && rec && rec.pos > 5 && rec.dur && rec.pos < rec.dur - 10) ? rec.pos : 0;
    Hist.touch(it.key, { name: it.name, size: it.size, kind: it.kind, url: it.url, uri: it.uri, mime: it.mime }, true);
    renderHome();
    await engine.load(it, { start, autoplay: true });
    engine.setRate(engine.rate);
    applyAudioPrefs();
    if (start > 0) toast('Resumed from ' + fmt(start));
    attachPendingSubs(it);
    setupMediaSession();
  }

  function leavePlayer() {
    saveProgress(true);
    engine.pause();
    if (!NATIVE && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    setView('home'); sheet.close(); locked = false; player.classList.remove('locked');
    wake(false); renderHome();
    if (history.state && history.state.v === 'player') history.back();
  }

  function saveProgress(force) {
    const it = cur(); if (!it || !engine.duration) return;
    const now = Date.now(); if (!force && now - lastSave < 5000) return;
    lastSave = now;
    const t = engine.time, d = engine.duration;
    Hist.touch(it.key, { pos: t > d - 8 ? 0 : t, dur: d });
  }

  function togglePlay() { if (!cur()) return; engine.paused ? engine.play() : engine.pause(); }
  function skip(dt) { const d = engine.duration; engine.seek(clamp(engine.time + dt, 0, d || 1e9)); }
  function playNext(auto) {
    const j = nextIndex(1);
    if (j < 0) { if (auto) { showUI(true); } else toast('End of queue'); return; }
    playIndex(j);
  }
  function playPrev() {
    if (engine.time > 4) { engine.seek(0); return; }
    const j = nextIndex(-1); if (j >= 0) playIndex(j); else engine.seek(0);
  }

  /* ───────────────────────── engine events ───────────────────────── */
  engine.on('state', e => {
    playing = e.playing;
    setIcon($('#btnPlay'), playing ? 'pause' : 'play');
    wake(playing);
    if ('mediaSession' in navigator && !NATIVE) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    if (playing) scheduleHide(); else showUI(true);
    if (!playing) saveProgress(true);
  });
  engine.on('buffering', e => { $('#spinner').hidden = !e.on; });
  engine.on('ready', e => {
    $('#errbox').hidden = true; $('#spinner').hidden = true;
    const live = !isFinite(e.duration);
    $('#tDur').textContent = live ? 'LIVE' : fmt(e.duration);
    const it = cur();
    if (it && e.w) $('#nowMeta').textContent = [bytes(it.size), e.w + '×' + e.h, NATIVE ? 'Native' : it.kind === 'url' ? 'Stream' : 'Local file'].filter(Boolean).join(' · ');
    if (it) { Hist.touch(it.key, { dur: e.duration }); if (!Hist.find(it.key).thumb) makeThumb(it); }
    applyPrevMode();
  });
  engine.on('ended', () => {
    const it = cur(); if (it) Hist.touch(it.key, { pos: 0 });
    if (sleepEnd) { sleepEnd = false; toast('Sleep timer: stopped'); showUI(true); return; }
    if (Q.repeat === 'one') { engine.seek(0); engine.play(); return; }
    if (S.autoNext) playNext(true); else showUI(true);
  });
  engine.on('error', e => {
    $('#spinner').hidden = true;
    $('#errText').textContent = e.msg || 'Playback failed.';
    $('#errbox').hidden = false; showUI(true);
  });
  engine.on('tracks', t => { tracks = t; if (sheet.cur && sheet.cur.name === 'audio') sheet.refresh(); });
  engine.on('cue', c => { subs.native = (c && c.text) || ''; });

  /* ───────────────────────── frame tick (seekbar + subtitles) ───────────────────────── */
  let lastSec = -1, subKey = '', scrubbing = false;
  function tick() {
    rafId = requestAnimationFrame(tick);
    const t = engine.time, d = engine.duration;
    if (!scrubbing) {
      const sec = Math.floor(t);
      if (sec !== lastSec) { lastSec = sec; $('#tCur').textContent = fmt(t); }
      if (d && isFinite(d)) {
        const p = clamp(t / d, 0, 1);
        $('#seekFill').style.transform = 'scaleX(' + p + ')';
        $('#seekKnob').style.left = p * 100 + '%';
        $('#seekBuf').style.transform = 'scaleX(' + clamp(engine.buffered / d, 0, 1) + ')';
      }
    }
    if (ab.a != null && ab.b != null && t >= ab.b) engine.seek(ab.a);
    renderSubs(t);
    if (playing) saveProgress(false);
  }

  /* ───────────────────────── subtitles ───────────────────────── */
  function renderSubs(t) {
    let html = '', key = '';
    const act = subs.active;
    if (act === 'native') { html = subs.native ? '<span>' + subs.native.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>') + '</span>' : ''; key = html; }
    else if (act != null) {
      const tr = subs.list.find(s => s.id === act);
      if (tr) {
        const cs = VSubs.at(tr.cues, t - subs.delay);
        key = cs.map(c => c.s).join(',') + '|' + subs.delay;
        if (key !== subKey) html = cs.map(c => '<div><span>' + c.t + '</span></div>').join('');
      }
    }
    if (key === subKey) return;
    subKey = key; $('#subs').innerHTML = html;
  }
  function applySubStyle() {
    const st = root.style;
    st.setProperty('--sub-size', S.subSize); st.setProperty('--sub-color', S.subColor);
    st.setProperty('--sub-bg', S.subBg / 100); st.setProperty('--sub-bottom', S.subBottom);
  }
  async function loadSubFile(file, o) {
    o = o || {};
    try {
      const cues = VSubs.parse(VSubs.decode(await file.arrayBuffer()));
      if (!cues.length) { toast('No subtitles found in ' + file.name); return false; }
      const id = 'x' + (++uid);
      subs.list.push({ id, name: file.name, cues });
      subs.active = id; subKey = '';
      if (!o.quiet) toast('Subtitles: ' + file.name);
      return true;
    } catch (e) { toast('Could not read subtitle file'); return false; }
  }
  function attachPendingSubs(it) {
    const mine = pendingSubs.filter(f => base(f.name) === base(it.name) || base(f.name).indexOf(base(it.name)) === 0);
    const use = mine.length ? mine : (pendingSubs.length === 1 && Q.items.length === 1 ? pendingSubs : []);
    use.forEach(f => loadSubFile(f, { quiet: true }));
    pendingSubs = pendingSubs.filter(f => use.indexOf(f) < 0);
  }

  /* ───────────────────────── audio prefs ───────────────────────── */
  function applyAudioPrefs() {
    engine.setVolume(S.volume);
    if (S.boost > 100) engine.setBoost(S.boost);
    if (eqGains.some(Boolean)) engine.setEq(eqGains);
  }
  let eqGains = [0, 0, 0, 0, 0], eqPreset = 'Flat';

  /* ───────────────────────── thumbnails ───────────────────────── */
  function makeThumb(it) {
    if (NATIVE) { if (it.kind === 'native') engine.call('thumb', { uri: it.uri, key: it.key, ms: Math.round(Math.min(engine.duration * 0.1, 10) * 1000) }); return; }
    if (!it.file) return;
    snapshotFile(it.file, Math.min(engine.duration * 0.1 || 1, 10), 224, 126, .6).then(d => { if (d) { Hist.touch(it.key, { thumb: d }); renderHome(); } });
  }
  window.VBus.on('thumb', p => { if (p && p.data) { Hist.touch(p.key, { thumb: p.data }); renderHome(); } });

  let pv = null;
  function previewVideo() {
    const it = cur(); if (!it || !it.file) return null;
    if (!pv || pv.id !== it.id) {
      if (pv) { pv.v.removeAttribute('src'); URL.revokeObjectURL(pv.url); }
      const v = document.createElement('video'); v.muted = true; v.preload = 'auto';
      const url = URL.createObjectURL(it.file); v.src = url;
      pv = { id: it.id, v, url, busy: false, want: null };
      v.addEventListener('seeked', () => {
        const c = $('#bubbleCv').getContext('2d');
        try { c.drawImage(v, 0, 0, 160, 90); } catch (e) {}
        pv.busy = false; if (pv.want != null) { const t = pv.want; pv.want = null; previewAt(t); }
      });
    }
    return pv;
  }
  function previewAt(t) {
    const p = previewVideo(); if (!p) return;
    if (p.busy) { p.want = t; return; }
    p.busy = true; p.v.currentTime = t;
  }
  function snapshotFile(file, t, w, hgt, q) {
    return new Promise(res => {
      const v = document.createElement('video'), url = URL.createObjectURL(file);
      const done = d => { URL.revokeObjectURL(url); v.removeAttribute('src'); res(d); };
      v.muted = true; v.preload = 'auto'; v.src = url;
      v.addEventListener('loadedmetadata', () => { v.currentTime = t; });
      v.addEventListener('seeked', () => {
        try { const c = document.createElement('canvas'); c.width = w; c.height = hgt; c.getContext('2d').drawImage(v, 0, 0, w, hgt); done(c.toDataURL('image/jpeg', q)); } catch (e) { done(null); }
      });
      v.addEventListener('error', () => done(null));
      setTimeout(() => done(null), 8000);
    });
  }

  /* ───────────────────────── controls visibility ───────────────────────── */
  let hideT = 0;
  function showUI(stay) {
    player.classList.add('ui-on'); player.classList.remove('nocursor');
    clearTimeout(hideT); if (!stay) scheduleHide();
  }
  function scheduleHide() {
    clearTimeout(hideT);
    hideT = setTimeout(() => {
      if (!playing || scrubbing || !$('#sheet').hidden || !$('#errbox').hidden) return;
      player.classList.remove('ui-on'); player.classList.add('nocursor');
    }, 3200);
  }
  function toggleUI() { player.classList.contains('ui-on') ? (player.classList.remove('ui-on'), clearTimeout(hideT)) : showUI(); }

  /* ───────────────────────── HUD ───────────────────────── */
  let hudT;
  function hud(text, sub) {
    const el = $('#hudC'); el.innerHTML = ''; el.append(text); if (sub) el.append(h('small', 0, sub));
    el.classList.add('show'); clearTimeout(hudT); hudT = setTimeout(() => el.classList.remove('show'), 800);
  }
  const barT = {};
  function hudBar(side, frac, label) {
    const el = $(side === 'L' ? '#hudL' : '#hudR');
    el.querySelector('.fill').style.height = clamp(frac, 0, 1) * 100 + '%';
    el.querySelector('span').textContent = label;
    el.classList.add('show'); clearTimeout(barT[side]); barT[side] = setTimeout(() => el.classList.remove('show'), 700);
  }

  /* ───────────────────────── seekbar ───────────────────────── */
  (function seekbar() {
    const el = $('#seek'), bubble = $('#bubble');
    const ratio = e => { const r = el.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
    const show = (e, p) => {
      const d = engine.duration, t = p * d, r = el.getBoundingClientRect();
      const half = 90, x = clamp(p * r.width, half, r.width - half);
      bubble.style.left = x + 'px'; $('#bubbleT').textContent = fmt(t);
      bubble.classList.toggle('nopv', !engine.caps.previews || !cur() || !cur().file);
      if (engine.caps.previews && cur() && cur().file) previewAt(t);
    };
    el.addEventListener('pointerdown', e => {
      const d = engine.duration; if (!d || !isFinite(d)) return;
      el.setPointerCapture(e.pointerId); scrubbing = true; el.classList.add('drag'); showUI(true);
      const p = ratio(e); $('#seekFill').style.transform = 'scaleX(' + p + ')'; $('#seekKnob').style.left = p * 100 + '%'; $('#tCur').textContent = fmt(p * d); show(e, p);
    });
    el.addEventListener('pointermove', e => {
      const d = engine.duration; if (!d || !isFinite(d)) return;
      const p = ratio(e);
      if (scrubbing) { $('#seekFill').style.transform = 'scaleX(' + p + ')'; $('#seekKnob').style.left = p * 100 + '%'; $('#tCur').textContent = fmt(p * d); }
      if (scrubbing || e.pointerType === 'mouse') { el.classList.add('hover'); show(e, p); }
    });
    el.addEventListener('pointerleave', () => { if (!scrubbing) el.classList.remove('hover'); });
    const end = e => {
      if (!scrubbing) return;
      scrubbing = false; el.classList.remove('drag', 'hover');
      engine.seek(ratio(e) * engine.duration); scheduleHide();
    };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', () => { scrubbing = false; el.classList.remove('drag'); });
  })();

  /* ───────────────────────── gestures ───────────────────────── */
  let zoom = 1;
  function applyZoom(z) { zoom = clamp(z, 1, 4); engine.setZoom(zoom); }
  (function gestures() {
    const g = $('#gesture'), pts = new Map();
    let st = {}, lastTap = { t: 0, x: 0 }, tapT = 0, holdPrev = 1, accum = 0, accumT = 0;
    const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };

    g.addEventListener('pointerdown', e => {
      if (locked) { player.classList.toggle('ui-on'); scheduleHide(); return; }
      g.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) {
        st = { x0: e.clientX, y0: e.clientY, t0: performance.now(), mode: null, moved: false };
        st.hold = setTimeout(() => {
          if (!st.moved && pts.size === 1 && S.gestures && playing) { st.mode = 'hold'; holdPrev = engine.rate; engine.setRate(S.holdSpeed); hud(S.holdSpeed + '× speed', 'release to resume'); }
        }, 450);
      } else if (pts.size === 2) {
        clearTimeout(st.hold); if (st.mode === 'hold') engine.setRate(holdPrev);
        st.mode = 'pinch'; st.d0 = dist(); st.z0 = zoom;
      }
    });
    g.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (st.mode === 'pinch' && pts.size === 2) {
        let z = st.z0 * dist() / st.d0; if (Math.abs(z - 1) < 0.06) z = 1;
        applyZoom(z); hud(zoom.toFixed(1) + '× zoom'); return;
      }
      if (pts.size !== 1 || st.mode === 'hold' || st.mode === 'dead') return;
      const dx = e.clientX - st.x0, dy = e.clientY - st.y0, W = innerWidth, H = innerHeight;
      if (!st.mode) {
        if (Math.hypot(dx, dy) < 16) return;
        st.moved = true; clearTimeout(st.hold);
        if (!S.gestures) { st.mode = 'dead'; return; }
        if (Math.abs(dx) > Math.abs(dy)) {
          const d = engine.duration; if (!d || !isFinite(d)) { st.mode = 'dead'; return; }
          st.mode = 'seek'; st.base = engine.time;
        } else if (st.x0 < W / 2) { st.mode = 'bright'; st.base = engine.getBrightness(); }
        else { st.mode = 'vol'; st.base = engine.getVolume(); }
      }
      if (st.mode === 'seek') {
        const d = engine.duration, span = Math.min(d, 240);
        st.target = clamp(st.base + dx / W * span, 0, d);
        const delta = Math.round(st.target - st.base);
        hud((delta >= 0 ? '+' : '−') + fmt(Math.abs(delta)), fmt(st.target) + ' / ' + fmt(d));
      } else if (st.mode === 'bright') {
        const v = clamp(st.base - dy / (H * 0.75), 0, 1); engine.setBrightness(v); hudBar('L', v, Math.round(v * 100) + '%');
      } else if (st.mode === 'vol') {
        const v = clamp(st.base - dy / (H * 0.75), 0, 1); engine.setVolume(v); if (!NATIVE) { S.volume = v; } hudBar('R', v, Math.round(v * 100) + '%');
      }
    });
    const up = e => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId); clearTimeout(st.hold);
      if (st.mode === 'pinch') { if (pts.size === 0) st.mode = null; else st.mode = 'dead'; return; }
      if (pts.size) return;
      const mode = st.mode;
      if (mode === 'seek' && st.target != null) engine.seek(st.target);
      else if (mode === 'hold') engine.setRate(holdPrev);
      else if (mode === 'vol') VStore.save();
      else if (!st.moved && performance.now() - st.t0 < 350) tap(e.clientX);
      st.mode = null;
    };
    g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);

    function tap(x) {
      const now = performance.now(), W = innerWidth;
      if (now - lastTap.t < 300 && Math.abs(x - lastTap.x) < 90) {
        clearTimeout(tapT); lastTap.t = 0;
        const z = x / W;
        if (z < 0.35 || z > 0.65) {
          const dir = z < 0.5 ? -1 : 1;
          accum = (now - accumT < 900 ? accum : 0) + S.seekStep; accumT = now;
          skip(dir * S.seekStep); hud((dir < 0 ? '⏪ −' : '⏩ +') + accum + 's');
        } else togglePlay();
        return;
      }
      lastTap = { t: now, x };
      tapT = setTimeout(toggleUI, 280);
    }
  })();
  // double-click on desktop
  $('#gesture').addEventListener('dblclick', e => { if (e.pointerType === 'mouse' || !('ontouchstart' in window)) { const z = e.clientX / innerWidth; if (z > .35 && z < .65) enterFullscreen(true); } });

  /* ───────────────────────── fullscreen / orientation / pip ───────────────────────── */
  function enterFullscreen(toggle) {
    if (NATIVE) return;
    if (document.fullscreenElement) { if (toggle) document.exitFullscreen(); return; }
    if (!player.requestFullscreen) return;
    if (!toggle && !matchMedia('(pointer:coarse)').matches) return; // desktop: only on request
    player.requestFullscreen().then(() => {
      if (S.landscape && matchMedia('(pointer:coarse)').matches && screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
    }).catch(() => {});
  }
  document.addEventListener('fullscreenchange', () => {
    setIcon($('#btnFs'), 'fs');
    if (!document.fullscreenElement && screen.orientation && screen.orientation.unlock) try { screen.orientation.unlock(); } catch (e) {}
  });
  function rotate() {
    const order = ['auto', 'landscape', 'portrait'];
    orient = order[(order.indexOf(orient) + 1) % 3];
    if (NATIVE) engine.call('orientation', { mode: orient });
    else if (screen.orientation && screen.orientation.lock) {
      if (orient === 'auto') screen.orientation.unlock();
      else (document.fullscreenElement ? Promise.resolve() : (player.requestFullscreen ? player.requestFullscreen() : Promise.resolve())).then(() => screen.orientation.lock(orient)).catch(() => toast('Rotation lock isn’t available on this device'));
    } else { toast('Rotation lock isn’t available in this browser'); return; }
    hud('Orientation: ' + orient);
  }
  async function pip() { try { await engine.pip(); } catch (e) { toast('Picture-in-picture isn’t available here'); } }

  let wl = null;
  async function wake(on) {
    if (NATIVE) return;
    try {
      if (on && 'wakeLock' in navigator && !wl) { wl = await navigator.wakeLock.request('screen'); wl.addEventListener('release', () => { wl = null; }); }
      else if (!on && wl) { await wl.release(); wl = null; }
    } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && playing) wake(true); });

  /* ───────────────────────── A-B / sleep / aspect / speed ───────────────────────── */
  function updateAB() {
    const d = engine.duration || 1, A = $('#markA'), B = $('#markB');
    A.hidden = ab.a == null; B.hidden = ab.b == null;
    if (ab.a != null) A.style.left = ab.a / d * 100 + '%';
    if (ab.b != null) B.style.left = ab.b / d * 100 + '%';
    const b = $('#btnAB'); b.classList.toggle('on', ab.a != null);
    b.textContent = ab.a == null ? 'A-B' : ab.b == null ? 'A–?' : 'A–B';
  }
  function cycleAB() {
    const t = engine.time;
    if (ab.a == null) { ab.a = t; hud('A set', fmt(t)); }
    else if (ab.b == null) { if (t <= ab.a + 0.5) { toast('Pick B later than A'); return; } ab.b = t; hud('Looping A–B', fmt(ab.a) + ' → ' + fmt(t)); }
    else { ab = { a: null, b: null }; hud('A-B loop off'); }
    updateAB();
  }
  function setSleep(min) {
    clearTimeout(sleepT); sleepEnd = false; sleepAt = 0;
    if (min === 'end') { sleepEnd = true; toast('Will stop after this video'); return; }
    if (!min) { toast('Sleep timer off'); return; }
    sleepAt = Date.now() + min * 60000;
    sleepT = setTimeout(() => { engine.pause(); sleepAt = 0; toast('Sleep timer: paused'); showUI(true); }, min * 60000);
    toast('Sleep timer: ' + min + ' min');
  }
  const ASPECT_LABEL = { fit: 'Fit', fill: 'Crop to fill', stretch: 'Stretch', '16:9': '16:9', '4:3': '4:3', '21:9': '21:9', original: 'Original size' };
  function setAspect(m) { S.aspect = m; VStore.save(); engine.setAspect(m); updateAspectBtn(); hud('Aspect: ' + ASPECT_LABEL[m]); }
  function updateAspectBtn() { $('#btnAspect').title = 'Aspect: ' + ASPECT_LABEL[S.aspect]; }
  function setSpeed(r) {
    r = clamp(Math.round(r * 100) / 100, 0.25, 4); engine.setRate(r);
    $('#btnSpeed').textContent = r + '×'; $('#btnSpeed').classList.toggle('on', r !== 1);
    hud(r + '× speed');
  }
  function applyPrevMode() {
    const live = !isFinite(engine.duration);
    $('#seek').style.opacity = live ? .4 : 1;
  }

  /* ───────────────────────── media session (web) ───────────────────────── */
  function setupMediaSession() {
    if (!('mediaSession' in navigator) || NATIVE || !cur()) return;
    const it = cur(), rec = Hist.find(it.key);
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: it.name, artist: 'VYBE', artwork: rec && rec.thumb ? [{ src: rec.thumb, sizes: '224x126', type: 'image/jpeg' }] : [] });
      const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch (e) {} };
      set('play', () => engine.play()); set('pause', () => engine.pause());
      set('seekbackward', () => skip(-S.seekStep)); set('seekforward', () => skip(S.seekStep));
      set('previoustrack', playPrev); set('nexttrack', () => playNext());
      set('seekto', d => engine.seek(d.seekTime));
    } catch (e) {}
  }

  /* ───────────────────────── sheets ───────────────────────── */
  const sheet = {
    cur: null,
    open(name, title, build) {
      $('#sheetTitle').textContent = title; const b = $('#sheetBody'); b.innerHTML = ''; build(b);
      $('#sheet').hidden = false; sheet.cur = { name, title, build }; showUI(true);
    },
    refresh() { if (!sheet.cur) return; const y = $('.sheet').scrollTop, c = sheet.cur; sheet.open(c.name, c.title, c.build); $('.sheet').scrollTop = y; },
    close() { $('#sheet').hidden = true; sheet.cur = null; if (view === 'player') scheduleHide(); }
  };
  $('#sheetClose').onclick = $('#sheetBg').onclick = () => sheet.close();

  const gl = t => h('div', { class: 'gl' }, t);
  const row = o => h('button', { class: 'row' + (o.active ? ' active' : ''), onclick: o.onclick },
    o.icon ? ico(o.icon) : null, h('div', { class: 'rt' }, h('b', 0, o.label), o.sub ? h('span', 0, o.sub) : null), o.active ? ico('check', 'ck') : null);
  function chips(opts, val, fn) {
    return h('div', { class: 'chips' }, opts.map(o => { const v = Array.isArray(o) ? o[0] : o, l = Array.isArray(o) ? o[1] : o; return h('button', { class: 'chip' + (v === val ? ' on' : ''), onclick: () => fn(v) }, l); }));
  }
  function slider(label, min, max, step, val, fmtv, fn, end) {
    const out = h('output', 0, fmtv(val));
    const inp = h('input', { type: 'range', min, max, step, value: val });
    inp.addEventListener('input', () => { out.textContent = fmtv(+inp.value); fn(+inp.value); });
    if (end) inp.addEventListener('change', () => end(+inp.value));
    return h('div', { class: 'sl' }, h('label', 0, label), out, inp);
  }
  function toggle(label, val, fn) {
    const i = h('input', { type: 'checkbox', checked: val }); i.addEventListener('change', () => fn(i.checked));
    return h('label', { class: 'tg' }, h('span', 0, label), i);
  }

  function openSubs() {
    sheet.open('subs', 'Subtitles', b => {
      b.append(row({ icon: 'close', label: 'Off', active: subs.active == null, onclick: () => { subs.active = null; subKey = ''; if (NATIVE) engine.selectText(-1); sheet.refresh(); } }));
      tracks.text.forEach(t => b.append(row({ icon: 'cc', label: t.label, sub: 'Embedded', active: subs.active === 'native' && t.selected, onclick: () => { subs.active = 'native'; engine.selectText(t.id); sheet.refresh(); } })));
      subs.list.forEach(s => b.append(row({ icon: 'cc', label: s.name, sub: s.cues.length + ' lines', active: subs.active === s.id, onclick: () => { subs.active = s.id; subKey = ''; if (NATIVE) engine.selectText(-1); sheet.refresh(); } })));
      b.append(row({ icon: 'plus', label: 'Load subtitle file…', sub: '.srt  .vtt  .ass  .ssa', onclick: () => $('#fileSub').click() }));
      b.append(gl('Timing'));
      b.append(slider('Delay', -10, 10, 0.1, subs.delay, v => (v > 0 ? '+' : '') + v.toFixed(1) + ' s', v => { subs.delay = v; subKey = ''; }));
      b.append(gl('Appearance'));
      b.append(slider('Size', 50, 220, 5, S.subSize, v => v + '%', v => { S.subSize = v; applySubStyle(); }, () => VStore.save()));
      b.append(slider('Background', 0, 100, 5, S.subBg, v => v + '%', v => { S.subBg = v; applySubStyle(); }, () => VStore.save()));
      b.append(slider('Position', 3, 40, 1, S.subBottom, v => v + '%', v => { S.subBottom = v; applySubStyle(); }, () => VStore.save()));
      b.append(chips([['#ffffff', 'White'], ['#ffe066', 'Yellow'], ['#7cf5d6', 'Mint'], ['#9cc4ff', 'Blue']], S.subColor, c => { S.subColor = c; VStore.save(); applySubStyle(); sheet.refresh(); }));
    });
  }

  function openAudio() {
    sheet.open('audio', 'Audio', b => {
      b.append(gl('Track'));
      if (tracks.audio.length) tracks.audio.forEach(t => b.append(row({ icon: 'audio', label: t.label, sub: t.info, active: t.selected, onclick: () => { engine.selectAudio(t.id); } })));
      else b.append(h('div', { class: 'empty' }, NATIVE ? 'Only one audio track in this file.' : 'Track switching needs the Android app (native engine) or Safari.'));
      b.append(gl('Volume boost'));
      b.append(slider('Boost', 100, 300, 10, S.boost, v => v + '%', v => { if (!engine.setBoost(v)) { toast('Boost is available for local files only'); } S.boost = v; }, () => VStore.save()));
      b.append(gl('Equalizer'));
      b.append(chips(Object.keys(VEngine.EQ_PRESETS), eqPreset, p => { eqPreset = p; eqGains = VEngine.EQ_PRESETS[p].slice(); if (!engine.setEq(eqGains)) toast('Equalizer is available for local files only'); sheet.refresh(); }));
      const eq = h('div', { class: 'eq' });
      VEngine.EQ_FREQS.forEach((f, i) => {
        const inp = h('input', { type: 'range', min: -12, max: 12, step: 1, value: eqGains[i], orient: 'vertical' });
        inp.addEventListener('input', () => { eqGains[i] = +inp.value; eqPreset = ''; engine.setEq(eqGains); });
        eq.append(h('div', { class: 'band' }, inp, f >= 1000 ? f / 1000 + 'k' : f));
      });
      b.append(eq);
    });
  }

  function openSpeed() {
    sheet.open('speed', 'Playback speed', b => {
      b.append(chips([0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 4].map(x => [x, x + '×']), engine.rate, v => { setSpeed(v); sheet.refresh(); }));
      b.append(slider('Fine tune', 0.25, 4, 0.05, engine.rate, v => v.toFixed(2) + '×', v => setSpeed(v)));
    });
  }
  function openAspect() {
    sheet.open('aspect', 'Aspect ratio', b => engine.aspects.forEach(m => b.append(row({ icon: 'aspect', label: ASPECT_LABEL[m], active: S.aspect === m, onclick: () => { setAspect(m); sheet.refresh(); } }))));
  }

  function openQueue() {
    sheet.open('queue', 'Queue · ' + Q.items.length, b => {
      b.append(h('div', { class: 'chips' },
        h('button', { class: 'chip' + (Q.shuffle ? ' on' : ''), onclick: () => { toggleShuffle(); sheet.refresh(); } }, 'Shuffle'),
        h('button', { class: 'chip' + (Q.repeat !== 'off' ? ' on' : ''), onclick: () => { cycleRepeat(); sheet.refresh(); } }, 'Repeat: ' + Q.repeat),
        h('button', { class: 'chip', onclick: openAddMenu }, '＋ Add')));
      Q.items.forEach((it, i) => b.append(row({ icon: 'film', label: it.name, sub: bytes(it.size), active: i === Q.i, onclick: () => { sheet.close(); playIndex(i); } })));
      if (!Q.items.length) b.append(h('div', { class: 'empty' }, 'Queue is empty'));
    });
  }
  function openAddMenu() {
    sheet.open('add', 'Add to queue', b => {
      b.append(row({ icon: 'plus', label: 'Videos from device', onclick: () => { sheet.close(); pickVideos(false); } }));
      b.append(row({ icon: 'link', label: 'Network stream (URL)', onclick: openUrl }));
    });
  }
  function openUrl() {
    sheet.open('url', 'Network stream', b => {
      const inp = h('input', { class: 'field', type: 'url', placeholder: 'https://…/video.mp4  ·  .m3u8  ·  .mpd (Android)', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
      const go = () => { const u = inp.value.trim(); if (!/^https?:\/\//i.test(u)) { toast('Enter a full http(s) link'); return; } sheet.close(); enqueue([itemFromUrl(u)], true); };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
      b.append(inp, h('button', { class: 'btn primary', onclick: go }, 'Play'));
      b.append(h('p', { class: 'foot' }, 'Direct MP4/WebM links and HLS (.m3u8) work in the browser. Streams must allow cross-origin playback. DASH (.mpd) works in the Android app.'));
      setTimeout(() => inp.focus(), 50);
    });
  }

  function openInfo() {
    const it = cur(); if (!it) return;
    const info = engine.mediaInfo(), v = NATIVE ? null : engine.v;
    sheet.open('info', 'Media info', b => {
      const kv = { Name: it.name, Size: bytes(it.size) || '—', Duration: isFinite(engine.duration) ? fmt(engine.duration) : 'Live', Source: it.kind === 'url' ? it.url : it.kind === 'native' ? 'Device storage' : 'Local file' };
      Object.assign(kv, info);
      const dl = h('dl', { class: 'kv' });
      Object.keys(kv).forEach(k => dl.append(h('dt', 0, k), h('dd', 0, String(kv[k]))));
      b.append(dl);
    });
  }
  function openKeys() {
    sheet.open('keys', 'Keyboard shortcuts', b => {
      const rows = [['Space / K', 'Play · pause'], ['← → / J L', 'Seek ±' + S.seekStep + ' s'], ['↑ ↓', 'Volume'], ['M', 'Mute'], ['F', 'Fullscreen'], ['C', 'Subtitles'], ['G / H', 'Subtitle delay −/+'], ['[ ]  \\', 'Speed − / + / reset'], [', .', 'Frame step'], ['N / P', 'Next · previous'], ['Z', 'Cycle aspect ratio'], ['A', 'A-B loop'], ['S', 'Screenshot'], ['I', 'Media info'], ['0–9', 'Jump to 0–90 %']];
      const g = h('div', { class: 'kbd' }); rows.forEach(r => g.append(h('kbd', 0, r[0]), h('span', 0, r[1]))); b.append(g);
    });
  }

  function openMore() {
    sheet.open('more', 'More', b => {
      b.append(row({ icon: 'info', label: 'Media info', onclick: openInfo }));
      b.append(row({ icon: 'ab', label: 'A-B repeat', sub: ab.a == null ? 'Set a loop between two points' : 'Active — tap to change', onclick: () => { sheet.close(); cycleAB(); } }));
      b.append(row({ icon: 'moon', label: 'Sleep timer', sub: sleepAt ? 'Pauses in ' + Math.ceil((sleepAt - Date.now()) / 60000) + ' min' : sleepEnd ? 'After this video' : 'Off', onclick: openSleep }));
      if (engine.caps.step) b.append(row({ icon: 'step', label: 'Frame step', sub: 'Next frame (also “.” key)', onclick: () => { engine.step(1); } }));
      if (engine.caps.screenshot) b.append(row({ icon: 'camera', label: 'Screenshot', onclick: () => { sheet.close(); screenshot(); } }));
      b.append(row({ icon: 'repeat', label: 'Repeat: ' + Q.repeat, onclick: () => { cycleRepeat(); sheet.refresh(); } }));
      b.append(row({ icon: 'shuffle', label: 'Shuffle: ' + (Q.shuffle ? 'on' : 'off'), onclick: () => { toggleShuffle(); sheet.refresh(); } }));
      b.append(row({ icon: 'gear', label: 'Settings', onclick: openSettings }));
      if (!NATIVE) b.append(row({ icon: 'key', label: 'Keyboard shortcuts', onclick: openKeys }));
    });
  }
  function openSleep() {
    sheet.open('sleep', 'Sleep timer', b => {
      [[0, 'Off'], [15, '15 minutes'], [30, '30 minutes'], [45, '45 minutes'], [60, '1 hour'], [90, '90 minutes'], ['end', 'After this video']].forEach(o =>
        b.append(row({ icon: 'moon', label: o[1], onclick: () => { setSleep(o[0]); sheet.close(); } })));
    });
  }
  function openSettings() {
    sheet.open('settings', 'Settings', b => {
      b.append(gl('Playback'));
      b.append(toggle('Resume where you left off', S.resume, v => { S.resume = v; VStore.save(); }));
      b.append(toggle('Play next automatically', S.autoNext, v => { S.autoNext = v; VStore.save(); }));
      b.append(gl('Double-tap seek'));
      b.append(chips([5, 10, 15, 30].map(x => [x, x + ' s']), S.seekStep, v => { S.seekStep = v; VStore.save(); sheet.refresh(); }));
      b.append(gl('Hold to fast-forward'));
      b.append(chips([1.5, 2, 3, 4].map(x => [x, x + '×']), S.holdSpeed, v => { S.holdSpeed = v; VStore.save(); sheet.refresh(); }));
      b.append(gl('Touch'));
      b.append(toggle('Swipe gestures (brightness · volume · seek)', S.gestures, v => { S.gestures = v; VStore.save(); }));
      if (!NATIVE) b.append(toggle('Landscape on play (phones)', S.landscape, v => { S.landscape = v; VStore.save(); }));
      b.append(gl('Default aspect ratio'));
      b.append(chips(engine.aspects.map(m => [m, ASPECT_LABEL[m]]), S.aspect, v => { S.aspect = v; VStore.save(); sheet.refresh(); }));
      b.append(gl('Data'));
      b.append(row({ icon: 'trash', label: 'Clear watch history', onclick: () => { Hist.clear(); renderHome(); toast('History cleared'); } }));
    });
  }
  async function screenshot() {
    try {
      const blob = await engine.screenshot(), a = h('a', { href: URL.createObjectURL(blob), download: base(cur().name) + '-' + Math.floor(engine.time) + 's.png' });
      document.body.append(a); a.click(); a.remove(); toast('Screenshot saved');
    } catch (e) { toast('Screenshot isn’t available for this source'); }
  }
  function toggleShuffle() { Q.shuffle = !Q.shuffle; Q.hist = []; renderHome(); }
  function cycleRepeat() { Q.repeat = { off: 'all', all: 'one', one: 'off' }[Q.repeat]; renderHome(); }

  /* ───────────────────────── home ───────────────────────── */
  const FEATURES = [
    ['Gesture controls', 'Swipe for brightness, volume and seeking. Double-tap to skip, hold for 2×, pinch to zoom.'],
    ['Subtitles', 'SRT, WebVTT and ASS with delay, size, colour and position. Embedded tracks on Android.'],
    ['Audio tools', '5-band equalizer, volume boost up to 300 %, audio track switching (Android).'],
    ['Smart resume', 'Picks up exactly where you stopped, with a continue-watching shelf.'],
    ['Pro playback', '0.25×–4× speed, A-B repeat, frame step, sleep timer, aspect modes, PiP.'],
    ['Native engine', 'On Android, VYBE plays through Media3 ExoPlayer: hardware decoding, MKV, HEVC, HLS, DASH.']
  ];
  function renderHome() {
    $('#qCount').textContent = Q.items.length;
    $('#homeShuffle').classList.toggle('on', Q.shuffle); $('#homeRepeat').classList.toggle('on', Q.repeat !== 'off');
    const ql = $('#queueHome'); ql.innerHTML = '';
    if (!Q.items.length) ql.append(h('div', { class: 'empty' }, 'Your queue is empty.'));
    Q.items.forEach((it, i) => {
      const rec = Hist.find(it.key);
      ql.append(h('div', { class: 'track' + (i === Q.i ? ' active' : ''), role: 'button', tabindex: 0, onclick: () => playIndex(i), onkeydown: e => { if (e.key === 'Enter') playIndex(i); } },
        h('div', { class: 'thumb' }, ico('play')),
        h('div', { class: 'tt' }, h('div', { class: 'nm' }, it.name), h('div', { class: 'mt' }, [bytes(it.size), rec && rec.dur ? fmt(rec.dur) : ''].filter(Boolean).join(' · '))),
        h('button', { class: 'iconbtn', 'aria-label': 'Remove', onclick: e => { e.stopPropagation(); removeFromQueue(i); } }, ico('close'))));
    });
    const hist = Hist.list().filter(x => x.dur);
    $('#recentSec').hidden = !hist.length;
    const rc = $('#recent'); rc.innerHTML = '';
    hist.slice(0, 12).forEach(e => {
      const pct = e.dur ? clamp((e.pos || 0) / e.dur, 0, 1) * 100 : 0;
      const th = h('div', { class: 'th' }, e.thumb ? null : ico('film'));
      if (e.thumb) th.style.backgroundImage = 'url(' + e.thumb + ')';
      rc.append(h('div', { class: 'card', role: 'button', tabindex: 0, onclick: () => openRecent(e), onkeydown: ev => { if (ev.key === 'Enter') openRecent(e); } },
        th, h('div', { class: 'bar2' }, h('i', { style: 'width:' + pct + '%' })),
        h('div', { class: 'tx' }, h('div', { class: 'nm' }, e.name), h('div', { class: 'mt' }, pct > 1 ? fmt(e.pos) + ' / ' + fmt(e.dur) : fmt(e.dur))),
        h('button', { class: 'iconbtn x', 'aria-label': 'Remove from history', onclick: ev => { ev.stopPropagation(); Hist.remove(e.key); renderHome(); } }, ico('close'))));
    });
  }
  function removeFromQueue(i) {
    if (i === Q.i) { engine.pause(); Q.i = -1; } else if (i < Q.i) Q.i--;
    Q.items.splice(i, 1); renderHome();
  }
  function openRecent(e) {
    const inQ = Q.items.findIndex(x => x.key === e.key);
    if (inQ >= 0) return playIndex(inQ);
    if (e.kind === 'url') return enqueue([itemFromUrl(e.url)], true);
    if (e.kind === 'native' && e.uri) return enqueue([itemFromNative({ uri: e.uri, name: e.name, size: e.size, mime: e.mime })], true);
    toast('Select “' + e.name + '” again to resume', 3200); pickVideos(true);
  }

  /* ───────────────────────── picking files ───────────────────────── */
  function pickVideos(play) {
    if (NATIVE) { engine.call('pick', { play: play !== false }); return; }
    $('#fileVideo').click();
  }
  window.VBus.on('picked', p => {
    const list = (p && p.files) || []; if (!list.length) return;
    enqueue(list.map(itemFromNative), p.play !== false && (Q.i < 0 || view === 'home'));
  });
  window.VBus.on('external-open', f => { if (f && f.uri) enqueue([itemFromNative(f)], true); });
  window.VBus.on('back', () => {
    if (!$('#sheet').hidden) sheet.close();
    else if (view === 'player') leavePlayer();
    else engine.call('exit');
  });
  window.VBus.on('pip', p => { if (p && p.on) { player.classList.remove('ui-on'); } else showUI(); });

  $('#fileVideo').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
  $('#fileSub').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    if (await loadSubFile(f) && sheet.cur && sheet.cur.name === 'subs') sheet.refresh();
  });

  // drag & drop (desktop web)
  let dragN = 0;
  addEventListener('dragenter', e => { e.preventDefault(); dragN++; document.body.classList.add('dragging'); });
  addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; document.body.classList.remove('dragging'); } });
  addEventListener('dragover', e => e.preventDefault());
  addEventListener('drop', e => { e.preventDefault(); dragN = 0; document.body.classList.remove('dragging'); if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files, { play: view === 'home' ? Q.i < 0 || true : false }); });

  /* ───────────────────────── keyboard ───────────────────────── */
  addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') { if (!$('#sheet').hidden) sheet.close(); else if (view === 'player' && !document.fullscreenElement) leavePlayer(); return; }
    if (view !== 'player' || !$('#sheet').hidden || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range') return;
    const k = e.key.toLowerCase(); let used = true;
    switch (true) {
      case k === ' ' || k === 'k': if (e.target.tagName === 'BUTTON') return; togglePlay(); break;
      case k === 'arrowleft': skip(-5); hud('−5s'); break;
      case k === 'arrowright': skip(5); hud('+5s'); break;
      case k === 'j': skip(-S.seekStep); hud('−' + S.seekStep + 's'); break;
      case k === 'l': skip(S.seekStep); hud('+' + S.seekStep + 's'); break;
      case k === 'arrowup': { const v = clamp(engine.getVolume() + .05, 0, 1); engine.setVolume(v); S.volume = v; hudBar('R', v, Math.round(v * 100) + '%'); break; }
      case k === 'arrowdown': { const v = clamp(engine.getVolume() - .05, 0, 1); engine.setVolume(v); S.volume = v; hudBar('R', v, Math.round(v * 100) + '%'); break; }
      case k === 'm': engine.setMuted && engine.setMuted(!engine.muted); hud(engine.muted ? 'Muted' : 'Sound on'); break;
      case k === 'f': enterFullscreen(true); break;
      case k === 'c': { const ids = [null].concat(subs.list.map(s => s.id)); const n = ids[(ids.indexOf(subs.active) + 1) % ids.length]; subs.active = n; subKey = ''; hud(n ? 'Subtitles on' : 'Subtitles off'); break; }
      case k === 'g': subs.delay = Math.round((subs.delay - 0.1) * 10) / 10; subKey = ''; hud('Sub delay ' + subs.delay.toFixed(1) + 's'); break;
      case k === 'h': subs.delay = Math.round((subs.delay + 0.1) * 10) / 10; subKey = ''; hud('Sub delay ' + subs.delay.toFixed(1) + 's'); break;
      case k === '[': setSpeed(engine.rate - 0.25); break;
      case k === ']': setSpeed(engine.rate + 0.25); break;
      case k === '\\': setSpeed(1); break;
      case k === ',': engine.step(-1); break;
      case k === '.': engine.step(1); break;
      case k === 'n': playNext(); break;
      case k === 'p': playPrev(); break;
      case k === 'z': { const a = engine.aspects; setAspect(a[(a.indexOf(S.aspect) + 1) % a.length]); break; }
      case k === 'a': cycleAB(); break;
      case k === 's': if (engine.caps.screenshot) screenshot(); break;
      case k === 'i': openInfo(); break;
      case /^[0-9]$/.test(k): engine.seek(engine.duration * (+k) / 10); break;
      default: used = false;
    }
    if (used) { e.preventDefault(); showUI(); }
  });
  addEventListener('mousemove', () => { if (view === 'player' && !locked) showUI(); });

  /* ───────────────────────── button wiring ───────────────────────── */
  $('#btnOpen').onclick = () => pickVideos(true);
  $('#btnUrl').onclick = openUrl;
  $('#homeSettings').onclick = openSettings;
  $('#clearHistory').onclick = () => { Hist.clear(); renderHome(); };
  $('#homeShuffle').onclick = toggleShuffle; $('#homeRepeat').onclick = cycleRepeat;
  $('#homeClear').onclick = () => { if (Q.i >= 0) { engine.pause(); } Q.items = []; Q.i = -1; renderHome(); };
  $('#dropzone').onclick = () => pickVideos(true);

  $('#btnBack').onclick = leavePlayer;
  $('#btnPlay').onclick = togglePlay;
  $('#btnNext').onclick = () => playNext(); $('#btnPrev').onclick = playPrev;
  $('#btnSubs').onclick = openSubs; $('#btnAudio').onclick = openAudio; $('#btnQueue').onclick = openQueue; $('#btnMore').onclick = openMore;
  $('#btnSpeed').onclick = openSpeed; $('#btnAspect').onclick = openAspect; $('#btnAB').onclick = cycleAB;
  $('#btnRotate').onclick = rotate; $('#btnPip').onclick = pip;
  $('#btnFs').onclick = () => { if (NATIVE) rotate(); else enterFullscreen(true); };
  $('#btnLock').onclick = () => { locked = true; player.classList.add('locked'); showUI(); hud('Controls locked'); };
  $('#btnUnlock').onclick = () => { locked = false; player.classList.remove('locked'); showUI(); };
  $('#errSkip').onclick = () => playNext(); $('#errBack').onclick = leavePlayer;
  $('#player').addEventListener('click', e => { if (e.target.closest('.ui>*, .unlock, .errbox')) showUI(); });
  $('.ui').addEventListener('pointermove', () => { if (playing) showUI(); });
  if (!engine.caps.pip) $('#btnPip').hidden = true;
  if (NATIVE) setIcon($('#btnFs'), 'rotate'), $('#btnRotate').hidden = true;
  else if (!document.documentElement.requestFullscreen) $('#btnFs').hidden = true;

  addEventListener('popstate', () => { if (view === 'player') { sheet.close(); leavePlayer(); } });
  addEventListener('pagehide', () => saveProgress(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(true); });

  /* ───────────────────────── init ───────────────────────── */
  applySubStyle();
  $('#engineBadge').textContent = engine.label; $('#engineBadge').classList.toggle('native', NATIVE);
  $('#features').append.apply($('#features'), FEATURES.map(f => h('div', { class: 'feat' }, h('b', 0, f[0]), h('span', 0, f[1]))));
  if (NATIVE) { $('#dropzone').hidden = true; }
  root.dataset.view = 'home';
  renderHome();

  if ('launchQueue' in window) launchQueue.setConsumer(async p => { if (p.files && p.files.length) addFiles(await Promise.all(p.files.map(x => x.getFile())), { play: true }); });
  const qs = new URLSearchParams(location.search).get('url');
  if (qs && /^https?:\/\//i.test(qs)) enqueue([itemFromUrl(qs)], true);

  if (!NATIVE && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (NATIVE) engine.call('ready');

  // test / debug hook
  window.VYBE = { engine, Q, S, playIndex, addFiles, openSubs, openAudio, openMore, openSettings, sheet, subs: () => subs };
})();
