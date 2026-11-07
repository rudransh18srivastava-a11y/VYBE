/* VYBE 2.0 — persistent settings + watch history (localStorage, fail-safe) */
(function (w) {
  'use strict';
  const P = 'vybe2:';
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(P + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(P + k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  };

  const DEFAULTS = {
    seekStep: 10, gestures: true, resume: true, autoNext: true, holdSpeed: 2,
    aspect: 'fit', landscape: true,
    subSize: 100, subColor: '#ffffff', subBg: 45, subBottom: 9,
    boost: 100, volume: 1
  };
  const settings = Object.assign({}, DEFAULTS, ls.get('settings', {}));
  const save = () => ls.set('settings', settings);

  let hist = ls.get('history', []);
  function persist() {
    if (ls.set('history', hist)) return;
    // quota hit: drop thumbnails from older entries and retry
    hist.slice(6).forEach(e => delete e.thumb);
    if (!ls.set('history', hist)) { hist = hist.slice(0, 10); ls.set('history', hist); }
  }
  const History = {
    list: () => hist,
    find: k => hist.find(x => x.key === k),
    touch(key, patch, bump) {
      let e = hist.find(x => x.key === key);
      if (!e) { e = { key }; hist.unshift(e); bump = false; }
      Object.assign(e, patch, { at: Date.now() });
      if (bump) { hist = [e].concat(hist.filter(x => x !== e)); }
      if (hist.length > 40) hist.length = 40;
      persist();
      return e;
    },
    remove(key) { hist = hist.filter(x => x.key !== key); persist(); },
    clear() { hist = []; persist(); }
  };

  w.VStore = { settings, save, DEFAULTS, History };
})(window);
