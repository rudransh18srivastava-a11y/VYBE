/* VYBE 2.0 — playback engines
 *
 *  WebEngine    HTML5 <video> (+ hls.js for .m3u8, WebAudio EQ / volume boost)
 *  NativeEngine Android Media3 ExoPlayer, driven through the VybeNative JS bridge
 *
 * Both expose the same interface so the UI (app.js) never cares which one is active.
 *
 *   events:  ready {duration,w,h}   state {playing}   buffering {on}   ended   error {msg}
 *            tracks {audio:[],text:[]}   cue {text}   info {…}
 */
(function (w) {
  'use strict';

  class Emitter {
    constructor() { this.h = {}; }
    on(n, f) { (this.h[n] = this.h[n] || []).push(f); return this; }
    emit(n, d) { (this.h[n] || []).forEach(f => { try { f(d); } catch (e) { console.error(e); } }); }
  }

  // Native → JS events (picked files, back button, external "open with", …) arrive here.
  const Bus = new Emitter();
  w.VBus = Bus;
  w.__vybeEmit = function (type, json) {
    let p = json;
    if (typeof json === 'string') { try { p = json ? JSON.parse(json) : null; } catch (e) { p = json; } }
    Bus.emit(type, p);
  };

  const RATIOS = { '16:9': 16 / 9, '4:3': 4 / 3, '21:9': 21 / 9 };
  const EQ_FREQS = [60, 230, 910, 3600, 14000];
  const EQ_PRESETS = {
    Flat: [0, 0, 0, 0, 0], 'Bass boost': [6, 4, 0, 0, 0], Voice: [-2, 0, 4, 3, -1],
    Cinema: [4, 2, -1, 2, 4], Treble: [0, 0, 1, 4, 6], Loudness: [5, 2, -1, 2, 5]
  };

  /* ───────────────────────────── Web engine ───────────────────────────── */
  class WebEngine extends Emitter {
    constructor(host) {
      super();
      this.kind = 'web';
      this.label = 'Web engine · HTML5';
      this.host = host;
      this.caps = { boost: true, eq: true, pip: !!document.pictureInPictureEnabled, tracks: false,
        previews: true, screenshot: true, step: true, systemVolume: false };
      this.aspects = ['fit', 'fill', 'stretch', '16:9', '4:3', '21:9', 'original'];
      this.aspect = 'fit'; this.zoomLevel = 1; this.bright = 0.5;
      this.rate = 1; this.vol = 1; this.muted = false;
      this.item = null; this.url = null; this.hls = null; this.audio = null; this._start = 0;
      this.mount();
      if (w.ResizeObserver) new ResizeObserver(() => this.layout()).observe(host);
      else addEventListener('resize', () => this.layout());
    }

    mount() {
      if (this.v) { this.v.removeAttribute('src'); this.v.remove(); }
      this.resetAudio();
      const v = this.v = document.createElement('video');
      v.setAttribute('playsinline', ''); v.preload = 'metadata'; v.controls = false;
      v.playbackRate = this.rate; v.volume = this.vol; v.muted = this.muted;
      this.host.appendChild(v);
      const on = (n, f) => v.addEventListener(n, f);
      on('loadedmetadata', () => {
        if (this._start > 0) v.currentTime = this._start;
        this._start = 0;
        this.layout();
        this.emit('ready', { duration: v.duration, w: v.videoWidth, h: v.videoHeight });
        this.emit('tracks', this.tracks());
      });
      on('play', () => this.emit('state', { playing: true }));
      on('pause', () => this.emit('state', { playing: false }));
      on('ended', () => this.emit('ended'));
      on('waiting', () => this.emit('buffering', { on: true }));
      on('playing', () => this.emit('buffering', { on: false }));
      on('canplay', () => this.emit('buffering', { on: false }));
      on('error', () => this.emit('error', { msg: this.errorText(v.error) }));
      this.layout();
    }

    errorText(err) {
      if (!err) return 'Playback failed.';
      if (err.code === 4) return "This file's format or codec isn't supported by the browser. Try MP4/H.264, or use the VYBE Android app (native engine) for MKV, HEVC, AC3 and more.";
      if (err.code === 3) return 'The video could not be decoded (corrupt file or unsupported codec).';
      if (err.code === 2) return 'Network error while loading the video.';
      return 'Playback failed.';
    }

    layout() {
      const v = this.v, W = this.host.clientWidth, H = this.host.clientHeight;
      if (!W || !H) return;
      let wd = W, ht = H, fit = 'contain';
      const m = this.aspect;
      if (m === 'fill') fit = 'cover';
      else if (m === 'stretch') fit = 'fill';
      else if (m === 'original') fit = 'none';
      else if (RATIOS[m]) { const r = RATIOS[m]; wd = Math.min(W, H * r); ht = wd / r; fit = 'fill'; }
      Object.assign(v.style, {
        width: wd + 'px', height: ht + 'px', left: (W - wd) / 2 + 'px', top: (H - ht) / 2 + 'px',
        objectFit: fit, transform: 'scale(' + this.zoomLevel + ')',
        filter: 'brightness(' + (0.3 + 1.4 * this.bright).toFixed(3) + ')'
      });
    }

    async load(item, opts) {
      opts = opts || {};
      this.cleanup();
      this.item = item;
      if (item.kind === 'url' && this.audio) this.mount(); // graph on an old element would mute cross-origin media
      const v = this.v;
      this._start = opts.start || 0;
      if (item.file) {
        v.src = this.url = URL.createObjectURL(item.file);
      } else {
        const src = item.url;
        if (/\.mpd(\?|$)/i.test(src)) { this.emit('error', { msg: 'DASH streams are supported in the VYBE Android app (native engine).' }); return; }
        if (/\.m3u8(\?|$)/i.test(src) && !v.canPlayType('application/vnd.apple.mpegurl')) {
          try { await this.useHls(src); } catch (e) { this.emit('error', { msg: 'Could not start HLS playback: ' + e.message }); return; }
        } else v.src = src;
      }
      if (opts.autoplay !== false) v.play().catch(() => this.emit('state', { playing: false }));
    }

    useHls(src) {
      const start = () => {
        if (!w.Hls || !w.Hls.isSupported()) throw new Error('HLS is not supported in this browser');
        this.hls = new w.Hls({ enableWorker: true });
        this.hls.loadSource(src);
        this.hls.attachMedia(this.v);
        this.hls.on(w.Hls.Events.ERROR, (_, d) => { if (d.fatal) this.emit('error', { msg: 'Stream error: ' + d.details }); });
      };
      if (w.Hls) return Promise.resolve(start());
      return new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js';
        s.onload = () => { try { res(start()); } catch (e) { rej(e); } };
        s.onerror = () => rej(new Error('failed to load hls.js (offline?)'));
        document.head.appendChild(s);
      });
    }

    cleanup() {
      if (this.hls) { this.hls.destroy(); this.hls = null; }
      this.v.pause(); this.v.removeAttribute('src'); this.v.load();
      if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
    }

    play() { return this.v.play().catch(() => {}); }
    pause() { this.v.pause(); }
    seek(t) { const d = this.duration; this.v.currentTime = Math.max(0, isFinite(d) && d ? Math.min(t, d) : t); }
    get time() { return this.v.currentTime || 0; }
    get duration() { return this.v.duration || 0; }
    get paused() { return this.v.paused; }
    get buffered() {
      const b = this.v.buffered, t = this.v.currentTime;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) >= t) return b.end(i);
      return 0;
    }
    setRate(r) { this.rate = r; this.v.playbackRate = r; }
    setVolume(f) { this.vol = Math.max(0, Math.min(1, f)); this.v.volume = this.vol; if (this.vol > 0) { this.muted = false; this.v.muted = false; } }
    getVolume() { return this.muted ? 0 : this.vol; }
    setMuted(m) { this.muted = m; this.v.muted = m; }
    getBrightness() { return this.bright; }
    setBrightness(f) { this.bright = Math.max(0, Math.min(1, f)); this.layout(); }
    setAspect(m) { this.aspect = m; this.layout(); }
    setZoom(z) { this.zoomLevel = z; this.layout(); }
    step(dir) { this.v.pause(); this.v.currentTime = Math.max(0, this.v.currentTime + dir / 30); }

    tracks() {
      const at = this.v.audioTracks, audio = [];
      if (at && at.length > 1) for (let i = 0; i < at.length; i++) audio.push({ id: i, label: at[i].label || at[i].language || 'Track ' + (i + 1), selected: at[i].enabled });
      return { audio, text: [] };
    }
    selectAudio(id) { const at = this.v.audioTracks; if (at) for (let i = 0; i < at.length; i++) at[i].enabled = i === id; this.emit('tracks', this.tracks()); }
    selectText() {}

    /* WebAudio chain: source → 5-band EQ → gain (boost) → limiter → out. Local files only
       (cross-origin streams without CORS would be silenced by createMediaElementSource). */
    ensureAudio() {
      if (this.audio) { if (this.audio.ctx.state === 'suspended') this.audio.ctx.resume(); return true; }
      if (this.item && !this.item.file) return false;
      const AC = w.AudioContext || w.webkitAudioContext;
      if (!AC) return false;
      try {
        const ctx = new AC(), src = ctx.createMediaElementSource(this.v);
        const bands = EQ_FREQS.map((f, i) => {
          const b = ctx.createBiquadFilter();
          b.type = i === 0 ? 'lowshelf' : i === 4 ? 'highshelf' : 'peaking';
          b.frequency.value = f; b.Q.value = 1; b.gain.value = 0; return b;
        });
        const gain = ctx.createGain();
        const lim = ctx.createDynamicsCompressor();
        lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.003; lim.release.value = 0.1;
        let n = src; [...bands, gain, lim].forEach(x => { n.connect(x); n = x; }); n.connect(ctx.destination);
        this.audio = { ctx, bands, gain };
        if (ctx.state === 'suspended') ctx.resume();
        return true;
      } catch (e) { console.warn(e); return false; }
    }
    resetAudio() { if (this.audio) { try { this.audio.ctx.close(); } catch (e) {} this.audio = null; } }
    setBoost(pct) { if (pct <= 100 && !this.audio) return true; if (!this.ensureAudio()) return false; this.audio.gain.gain.value = pct / 100; return true; }
    setEq(g) { if (g.every(x => !x) && !this.audio) return true; if (!this.ensureAudio()) return false; g.forEach((x, i) => this.audio.bands[i].gain.value = x); return true; }

    async screenshot() {
      const v = this.v, c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      return new Promise(res => c.toBlob(res, 'image/png'));
    }
    async pip() {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await this.v.requestPictureInPicture();
    }
    mediaInfo() {
      const v = this.v;
      return { Engine: 'HTML5 <video>', Resolution: v.videoWidth ? v.videoWidth + ' × ' + v.videoHeight : '—' };
    }
  }

  /* ──────────────────────────── Native engine ──────────────────────────── */
  class NativeEngine extends Emitter {
    constructor() {
      super();
      this.kind = 'native';
      this.label = 'Native engine · Media3 ExoPlayer';
      this.caps = { boost: true, eq: true, pip: true, tracks: true, previews: false, screenshot: false, step: true, systemVolume: true };
      this.aspects = ['fit', 'fill', 'stretch', '16:9', '4:3', '21:9'];
      this.s = { t: 0, d: 0, b: 0, playing: false, at: 0 };
      this.rate = 1; this.item = null;
      Bus.on('time', p => { this.s = { t: p.t, d: p.d > 0 ? p.d : this.s.d, b: p.b, playing: this.s.playing, at: performance.now() }; });
      Bus.on('state', p => { this.s.t = p.t != null ? p.t : this.time; this.s.playing = !!p.playing; this.s.at = performance.now(); this.emit('state', p); });
      Bus.on('buffering', p => this.emit('buffering', p));
      Bus.on('ready', p => { const d = p.duration < 0 ? Infinity : p.duration; this.s.d = d; this.emit('ready', Object.assign({}, p, { duration: d })); });
      Bus.on('ended', () => this.emit('ended'));
      Bus.on('error', p => this.emit('error', p));
      Bus.on('tracks', p => this.emit('tracks', p));
      Bus.on('cue', p => this.emit('cue', p));
      Bus.on('info', p => { this._info = p; this.emit('info', p); });
    }
    call(m, a) {
      try { const r = w.VybeNative.invoke(m, JSON.stringify(a || {})); return r ? JSON.parse(r) : null; }
      catch (e) { console.error('VybeNative.' + m, e); return null; }
    }
    async load(item, o) {
      o = o || {};
      this.item = item; this.s = { t: o.start || 0, d: 0, b: 0, playing: false, at: performance.now() };
      this.call('load', { uri: item.uri || item.url, title: item.name, start: Math.round((o.start || 0) * 1000), autoplay: o.autoplay !== false });
    }
    play() { this.call('play'); }
    pause() { this.call('pause'); }
    seek(t) { this.s.t = t; this.s.at = performance.now(); this.call('seek', { ms: Math.round(t * 1000) }); }
    get time() { const s = this.s; return s.playing ? Math.min(s.d || Infinity, s.t + (performance.now() - s.at) / 1000 * this.rate) : s.t; }
    get duration() { return this.s.d || 0; }
    get paused() { return !this.s.playing; }
    get buffered() { return this.s.b; }
    setRate(r) { this.rate = r; this.call('rate', { v: r }); }
    setVolume(f) { this.call('volume', { v: f }); }
    getVolume() { const r = this.call('getVolume'); return r ? r.v : 1; }
    setMuted() {}
    getBrightness() { const r = this.call('getBrightness'); return r ? r.v : 0.5; }
    setBrightness(f) { this.call('brightness', { v: f }); }
    setAspect(m) { this.call('aspect', { mode: m }); }
    setZoom(z) { this.call('zoom', { v: z }); }
    step(dir) { this.call('step', { dir }); }
    selectAudio(id) { this.call('audioTrack', { id }); }
    selectText(id) { this.call('textTrack', { id: id == null ? -1 : id }); }
    setBoost(p) { this.call('boost', { v: p }); return true; }
    setEq(g) { this.call('eq', { g }); return true; }
    pip() { this.call('pip'); }
    mediaInfo() { return Object.assign({ Engine: 'Media3 ExoPlayer' }, this._info || {}); }
  }

  w.VEngine = { WebEngine, NativeEngine, EQ_PRESETS, EQ_FREQS };
})(window);
