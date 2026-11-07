/* VYBE 2.0 — subtitle parsing (SRT / WebVTT / ASS-SSA) and cue lookup */
(function (w) {
  'use strict';

  function decode(buf) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch (e) { return new TextDecoder('windows-1252').decode(buf); }
  }

  function seconds(s) {
    const p = s.trim().replace(',', '.').split(':').map(parseFloat);
    if (p.some(isNaN)) return NaN;
    return p.reduce((a, v) => a * 60 + v, 0);
  }

  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // keep only <i> <b> <u>; everything else is stripped/escaped (safe for innerHTML)
  function clean(text) {
    text = text.replace(/\{[^}]*\}/g, '')                     // ASS/SSA override tags
      .replace(/<(?!\/?(?:i|b|u)>)[^>]*>/gi, '');             // other markup (VTT <c>, <v>, <font>)
    return esc(text).replace(/&lt;(\/?(?:i|b|u))&gt;/gi, '<$1>');
  }

  function parseSrtVtt(text) {
    const cues = [];
    const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
    const re = /([\d:.,]+)\s*-->\s*([\d:.,]+)/;
    for (const b of blocks) {
      const lines = b.split('\n');
      const i = lines.findIndex(l => re.test(l));
      if (i < 0) continue;
      const m = lines[i].match(re);
      const s = seconds(m[1]), e = seconds(m[2]);
      const t = clean(lines.slice(i + 1).join('\n').trim());
      if (t && !isNaN(s) && !isNaN(e)) cues.push({ s, e, t });
    }
    return cues;
  }

  function parseAss(text) {
    const cues = [];
    let inEvents = false, cols = null;
    for (const raw of text.replace(/\r/g, '').split('\n')) {
      const line = raw.trim();
      if (/^\[events\]/i.test(line)) { inEvents = true; continue; }
      if (/^\[/.test(line)) { inEvents = false; continue; }
      if (!inEvents) continue;
      if (/^format:/i.test(line)) { cols = line.slice(7).split(',').map(x => x.trim().toLowerCase()); continue; }
      if (!/^dialogue:/i.test(line) || !cols) continue;
      const n = cols.length;
      const parts = line.slice(9).split(',');
      const head = parts.slice(0, n - 1);
      const body = parts.slice(n - 1).join(',');
      const s = seconds(head[cols.indexOf('start')] || ''), e = seconds(head[cols.indexOf('end')] || '');
      const t = clean(body.replace(/\\N/gi, '\n').replace(/\\h/g, ' ').trim());
      if (t && !isNaN(s) && !isNaN(e)) cues.push({ s, e, t });
    }
    return cues;
  }

  function parse(text) {
    const cues = /\[script info\]|\[events\]/i.test(text) ? parseAss(text) : parseSrtVtt(text);
    cues.sort((a, b) => a.s - b.s);
    return cues;
  }

  // cues active at time t (handles overlaps)
  function at(cues, t) {
    let lo = 0, hi = cues.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].s <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const out = [];
    for (let i = idx; i >= 0 && i > idx - 8; i--) if (cues[i].e > t) out.unshift(cues[i]);
    return out;
  }

  w.VSubs = { decode, parse, at };
})(window);
