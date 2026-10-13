// Maßeintragungen (Port von backend/dims.py): Parsen, Zuordnung, parametrische Änderungen.
import { prim, copyPrim, transform, points, sample, length, arcFrom3pts, dist, sub, solve2 } from './geom.js';

const N = String.raw`\d+(?:[.,]\d+)?`;
export const f2 = s => parseFloat(s.replace(',', '.'));
const SKIP = /Benennung|Zeichnungsnr|Werkstoff|Maßstab|MaBstab|Massstab|Projektion|Allgemeintol|ISO|Maße|DN\d|D2C|EN AW|S235|S355|C45/i;

const FITS = {
  H7: [[3, 10, 0], [6, 12, 0], [10, 15, 0], [18, 18, 0], [30, 21, 0], [50, 25, 0], [80, 30, 0], [120, 35, 0], [180, 40, 0]],
  H8: [[3, 14, 0], [6, 18, 0], [10, 22, 0], [18, 27, 0], [30, 33, 0], [50, 39, 0], [80, 46, 0], [120, 54, 0], [180, 63, 0]],
  h6: [[3, 0, -6], [6, 0, -8], [10, 0, -9], [18, 0, -11], [30, 0, -13], [50, 0, -16], [80, 0, -19], [120, 0, -22], [180, 0, -25]],
  h7: [[3, 0, -10], [6, 0, -12], [10, 0, -15], [18, 0, -18], [30, 0, -21], [50, 0, -25], [80, 0, -30], [120, 0, -35], [180, 0, -40]],
  g6: [[3, -2, -8], [6, -4, -12], [10, -5, -14], [18, -6, -17], [30, -7, -20], [50, -9, -25], [80, -10, -29], [120, -12, -34], [180, -14, -39]],
  k6: [[3, 6, 0], [6, 9, 1], [10, 10, 1], [18, 12, 1], [30, 15, 2], [50, 18, 2], [80, 21, 2], [120, 25, 3], [180, 28, 3]],
};
function fitLimits(code, nominal) {
  for (const [upto, es, ei] of FITS[code] || []) if (nominal <= upto) return [es / 1000, ei / 1000];
  return null;
}
function parseTol(rest, nominal) {
  rest = rest.trim(); let m;
  if ((m = rest.match(new RegExp(`^±\\s*(${N})`)))) { const v = f2(m[1]); return { tol_o: v, tol_u: -v }; }
  if ((m = rest.match(new RegExp(`^([+-]\\s*${N})\\s*/?\\s*([+-]\\s*${N})`)))) {
    const a = f2(m[1].replace(/ /g, '')), b = f2(m[2].replace(/ /g, '')); return { tol_o: Math.max(a, b), tol_u: Math.min(a, b) };
  }
  if ((m = rest.match(new RegExp(`^\\+\\s*(${N})$`)))) { const v = f2(m[1]); return { tol_o: v, tol_u: -v, hinweis: '„+“ als „±“ gelesen (OCR)' }; }
  if ((m = rest.match(/^([A-Za-z]{1,2}\d{1,2})\b/))) {
    const out = { passung: m[1] }; const lim = fitLimits(m[1], nominal);
    if (lim) { out.tol_o = lim[0]; out.tol_u = lim[1]; }
    return out;
  }
  return {};
}

export function parsePhrase(text) {
  const t = text.trim();
  if (!t || SKIP.test(t)) return [];
  const out = [], used = [];
  const add = (m, d) => { used.push([m.index, m.index + m[0].length]); d.text = t; out.push(d); };
  const inUsed = i => used.some(([a, b]) => a <= i && i < b);
  const cnt = t.match(/(\d+)\s*[x×]\s*(?=[ØR])/); const n = cnt ? parseInt(cnt[1]) : 1;
  for (const m of t.matchAll(new RegExp(`(Langloch|Tasche|Nut)\\s*(${N})\\s*[x×]\\s*(${N})`, 'g'))) add(m, { typ: 'tasche', wert: f2(m[2]), wert2: f2(m[3]), name: m[1] });
  for (const m of t.matchAll(new RegExp(`(${N})\\s*[x×]\\s*(\\d+)\\s*°`, 'g'))) add(m, { typ: 'fase', wert: f2(m[1]), winkel: f2(m[2]) });
  for (const m of t.matchAll(new RegExp(`TK\\s*Ø?\\s*(${N})`, 'g'))) add(m, { typ: 'teilkreis', wert: f2(m[1]) });
  for (const m of t.matchAll(new RegExp(`(?<!TK )(?<!TK)Ø\\s*(${N})(\\s*[A-Za-z]{1,2}\\d{1,2}|\\s*±\\s*${N}|\\s*[+-]\\s*${N}(?:\\s*/?\\s*[+-]\\s*${N})?)?`, 'g'))) {
    if (inUsed(m.index)) continue;
    const v = f2(m[1]); add(m, { typ: 'durchmesser', wert: v, anzahl: n, ...parseTol(m[2] || '', v) });
  }
  for (const m of t.matchAll(new RegExp(`(?<![A-Za-z])R\\s*(${N})`, 'g'))) add(m, { typ: 'radius', wert: f2(m[1]), anzahl: n });
  for (const m of t.matchAll(new RegExp(`(?<![A-Za-z])T\\s*(${N})`, 'g'))) add(m, { typ: 'tiefe', wert: f2(m[1]) });
  for (const m of t.matchAll(new RegExp(`(${N})\\s*°`, 'g'))) { if (inUsed(m.index)) continue; add(m, { typ: 'winkel', wert: f2(m[1]) }); }
  if (!out.length) {
    const m = t.match(new RegExp(`^[|\\s]*(${N})\\s*(.*)$`));
    if (m && m[2].length < 14) { const v = f2(m[1]); if (v > 0) out.push({ typ: 'laenge', wert: v, ...parseTol(m[2], v), text: t }); }
  }
  return out;
}

export function segDist(p, a, b) {
  const d = sub(b, a); const dd = Math.max(d[0] * d[0] + d[1] * d[1], 1e-12);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / dd));
  return Math.hypot(p[0] - (a[0] + t * d[0]), p[1] - (a[1] + t * d[1]));
}
const rectDist = (p, lo, hi) => Math.hypot(Math.max(lo[0] - p[0], 0, p[0] - hi[0]), Math.max(lo[1] - p[1], 0, p[1] - hi[1]));

function findAnnotations(dr) {
  const tips = dr.arrows.map(a => a.tip);
  const nearTip = p => tips.some(t => dist(p, t) < 0.4);
  const dimlines = [], leaders = [];
  for (const p of dr.thin) {
    if (p.kind !== 'line') continue;
    const [a, b] = p.pts; const ta = nearTip(a), tb = nearTip(b);
    if (ta && tb) dimlines.push(p);
    else if (ta || tb) {
      const [tip, q] = ta ? [a, b] : [b, a];
      const sh = dr.thin.filter(s => s.kind === 'line' && s !== p && dist(s.pts[0], q) < 0.1);
      leaders.push({ tip, q, shoulder: sh[0] || null });
    }
  }
  return [dimlines, leaders];
}

export class Ctx {
  constructor(views, layout, s) { this.views = views; this.layout = layout; this.s = s; }
  amap(vi, ax) { const m = this.layout.maps[vi]; return m ? m[ax] : undefined; }
  toModel(vi, ax, c) { const m = this.amap(vi, ax); if (!m) return null; return [m[0], (c - m[1]) * m[2] / this.s]; }
}

function viewOfDimline(views, a, b) {
  const horiz = Math.abs(a[1] - b[1]) < 0.05; let best = null;
  views.forEach((v, i) => {
    let d;
    if (horiz) {
      const lo = Math.min(a[0], b[0]), hi = Math.max(a[0], b[0]);
      if (lo < v.lo[0] - 0.5 || hi > v.hi[0] + 0.5) return;
      d = Math.max(v.lo[1] - a[1], a[1] - v.hi[1], 0);
    } else {
      const lo = Math.min(a[1], b[1]), hi = Math.max(a[1], b[1]);
      if (lo < v.lo[1] - 0.5 || hi > v.hi[1] + 0.5) return;
      d = Math.max(v.lo[0] - a[0], a[0] - v.hi[0], 0);
    }
    if (!best || d < best[0]) best = [d, i];
  });
  return best && best[0] < 40 ? best[1] : null;
}

function coordKind(view, ax, c, tol = 0.12) {
  const k = ax === 'x' ? 0 : 1;
  const edge = view.prims.some(p => (p.kind === 'line' || p.kind === 'arc') && p.pts.some(q => Math.abs(q[k] - c) < tol));
  const center = view.prims.some(p => p.kind === 'circle' && Math.abs(p.center[k] - c) < tol);
  return [edge, center];
}

export function anchorLin(ctx, vi, ax, a0, a1) {
  const v = ctx.views[vi];
  const [lo, hi] = [a0, a1].sort((x, y) => x - y);
  const [e0, c0] = coordKind(v, ax, lo), [e1, c1] = coordKind(v, ax, hi);
  const m0 = ctx.toModel(vi, ax, lo), m1 = ctx.toModel(vi, ax, hi);
  if (!m0) return null;
  const A = m0[0]; const [x0, x1] = [m0[1], m1[1]].sort((x, y) => x - y);
  const anc = { art: 'linear', achse: A, m0: x0, m1: x1, ansicht: vi };
  if ((c1 && !e1) || (c0 && !e0)) {
    const movLo = c0 && !e0 && !(c1 && !e1);
    const mc = movLo ? m0[1] : m1[1];
    Object.assign(anc, { modus: 'verschieben', fest: movLo ? m1[1] : m0[1], bewegt: mc });
  } else anc.modus = 'strecken';
  return anc;
}

function anchorByValue(ctx, d, raster) {
  const s = ctx.s, v = d.wert, tol = raster ? 0.015 * v + 0.06 : 0.03;
  const views = ctx.views, L = ctx.layout;
  const vc = w => [(w.lo[0] + w.hi[0]) / 2, (w.lo[1] + w.hi[1]) / 2];
  if (d.typ === 'durchmesser') {
    for (let vi = 0; vi < views.length; vi++) {
      const w = views[vi];
      const cs = w.prims.filter(p => p.kind === 'circle' && Math.abs(2 * p.r / s - v) < tol);
      if (cs.length && !(L.typ === 'dreh' && vi === L.kreis && cs.some(c => dist(c.center, w.c) < 0.5)
        && L.profil_radien && L.profil_radien.some(r => Math.abs(r - v / 2) < tol))) return { art: 'kreis', ansicht: vi, r: v / 2 };
    }
    if (L.typ === 'dreh' && (L.profil_radien || []).some(r => Math.abs(r - v / 2) < tol)) {
      const r = L.profil_radien.reduce((a, b) => Math.abs(b - v / 2) < Math.abs(a - v / 2) ? b : a); return { art: 'radial', r };
    }
    for (let vi = 0; vi < views.length; vi++)
      if (views[vi].prims.some(p => p.kind === 'circle' && Math.abs(2 * p.r / s - v) < tol)) return { art: 'kreis', ansicht: vi, r: v / 2 };
  }
  if (d.typ === 'radius') {
    for (let vi = 0; vi < views.length; vi++)
      if (views[vi].prims.some(p => p.kind === 'arc' && Math.abs(p.r / s - v) < tol)) return { art: 'bogen', ansicht: vi, r: v };
  }
  if (d.typ === 'fase') {
    for (const w of views) for (const p of w.prims) if (p.kind === 'line') {
      const dd = [(p.pts[1][0] - p.pts[0][0]) / s, (p.pts[1][1] - p.pts[0][1]) / s];
      if (Math.abs(Math.abs(dd[0]) - v) < tol && Math.abs(Math.abs(dd[1]) - v) < tol) return { art: 'fase', c: v };
    }
  }
  if (d.typ === 'laenge') {
    const cands = [];
    views.forEach((w, vi) => {
      for (const [ax, k] of [['x', 0], ['y', 1]]) {
        if (!ctx.amap(vi, ax)) continue;
        const set = new Set();
        for (const p of w.prims) { if (p.kind === 'line') for (const q of p.pts) set.add(Math.round(q[k] * 100) / 100); if (p.kind === 'circle') set.add(Math.round(p.center[k] * 100) / 100); }
        const cs = [...set].sort((a, b) => a - b); const base = w.lo[k];
        for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
          if (Math.abs((cs[j] - cs[i]) / s - v) < tol)
            cands.push([[Math.abs(cs[i] - base) < 0.2 ? 0 : 1, L.typ !== 'dreh' || ax === 'x' ? 0 : 1], vi, ax, cs[i], cs[j]]);
        }
      }
    });
    if (cands.length) {
      cands.sort((a, b) => a[0][0] - b[0][0] || a[0][1] - b[0][1]);
      const [, vi, ax, c0, c1] = cands[0]; return anchorLin(ctx, vi, ax, c0, c1);
    }
  }
  if (d.typ === 'teilkreis' && L.typ === 'dreh' && L.kreis != null) {
    const w = views[L.kreis];
    if (w.prims.some(p => p.kind === 'circle' && Math.abs(2 * dist(p.center, w.c) / s - v) < tol)) return { art: 'teilkreis', r: v / 2 };
  }
  if (['tiefe', 'tasche', 'winkel'].includes(d.typ)) return { art: 'info' };
  return null;
}

export function associate(dr, ctx) {
  const phrases = dr.phrases; const specs = [];
  phrases.forEach((ph, i) => { for (const sp of parsePhrase(ph.text)) specs.push([i, sp]); });
  const dims = [], used = new Set(); const raster = dr.kind === 'raster'; const s = ctx.s;
  if (!raster) {
    const [dimlines, leaders] = findAnnotations(dr);
    for (const dl of dimlines) {
      const [a, b] = dl.pts;
      const horiz = Math.abs(a[1] - b[1]) < 0.05, vert = Math.abs(a[0] - b[0]) < 0.05;
      if (!(horiz || vert)) continue;
      let best = null;
      specs.forEach(([pi, sp], k) => {
        if (used.has(k) || !['laenge', 'durchmesser'].includes(sp.typ)) return;
        const ph = phrases[pi]; if (ph.vertikal !== vert) return;
        const d = segDist([ph.x, ph.y], a, b);
        if (d < 5 && (!best || d < best[0])) best = [d, k];
      });
      if (!best) continue;
      used.add(best[1]); const sp = specs[best[1]][1];
      const vi = viewOfDimline(ctx.views, a, b); if (vi == null) continue;
      const ax = horiz ? 'x' : 'y', k = horiz ? 0 : 1;
      let anc;
      if (sp.typ === 'durchmesser' && ctx.layout.typ === 'dreh' && vi === ctx.layout.profil && vert) anc = { art: 'radial', r: Math.abs(a[1] - b[1]) / 2 / s };
      else anc = anchorLin(ctx, vi, ax, a[k], b[k]);
      dims.push({ ...sp, quelle: 'Maßlinie', anker: anc, gemessen: +(Math.abs(a[k] - b[k]) / s).toFixed(3), linie: [a, b] });
    }
    for (const ld of leaders) {
      const q = ld.q; let best = null;
      specs.forEach(([pi, sp], k) => {
        if (used.has(k)) return;
        const ph = phrases[pi]; let d = rectDist(q, ph.lo, ph.hi);
        if (ld.shoulder) d = Math.min(d, rectDist(ld.shoulder.pts[1], ph.lo, ph.hi));
        if (d < 4 && (!best || d < best[0] - 1e-9)) best = [d, pi];
      });
      if (!best) continue;
      const pi = best[1]; const tip = ld.tip;
      let near = null;
      ctx.views.forEach((w, vi) => {
        for (const p of w.prims) {
          let dd;
          if (p.kind === 'circle' || p.kind === 'arc') dd = Math.abs(dist(tip, p.center) - p.r);
          else { const sm = sample(p); dd = Infinity; for (let i = 1; i < sm.length; i++) dd = Math.min(dd, segDist(tip, sm[i - 1], sm[i])); }
          if (dd < 2.5 && (!near || dd < near[0])) near = [dd, vi, p];
        }
      });
      specs.forEach(([pj, sp], k) => {
        if (pj !== pi || used.has(k)) return;
        used.add(k); let anc = null, meas = null;
        if (near) {
          const [, vi, p] = near;
          if (sp.typ === 'durchmesser' && p.kind === 'circle') { anc = { art: 'kreis', ansicht: vi, r: p.r / s }; meas = 2 * p.r / s; }
          else if (sp.typ === 'radius' && p.kind === 'arc') { anc = { art: 'bogen', ansicht: vi, r: p.r / s }; meas = p.r / s; }
          else if (sp.typ === 'teilkreis') anc = anchorByValue(ctx, sp, raster);
          else anc = anchorByValue(ctx, sp, raster) || { art: 'info' };
        } else anc = anchorByValue(ctx, sp, raster);
        dims.push({ ...sp, quelle: 'Hinweislinie', anker: anc, gemessen: meas == null ? null : +meas.toFixed(3), spitze: tip });
      });
    }
  }
  specs.forEach(([pi, sp], k) => {
    if (used.has(k)) return;
    let anc = anchorByValue(ctx, sp, raster);
    const txt = phrases[pi].text; const m8 = txt.match(new RegExp(`^8(${N})`));
    if (raster && !anc && /^8\d{2,}/.test(txt) && m8) {
      const sp2 = { ...sp, typ: 'durchmesser', wert: f2(m8[1]) };
      const a2 = anchorByValue(ctx, sp2, raster);
      if (a2) { sp = { ...sp2, hinweis: '„8“ als „Ø“ gelesen (OCR)' }; anc = a2; }
    }
    dims.push({ ...sp, quelle: phrases[pi].detail ? `Einzelheit ${phrases[pi].detail}` : (raster ? 'OCR-Text' : 'Freitext'), anker: anc, gemessen: null });
  });
  dims.forEach((d, i) => {
    d.id = `M${i + 1}`; const a = d.anker;
    if (d.gemessen == null && a) {
      if (a.art === 'linear') d.gemessen = +(a.m1 - a.m0).toFixed(3);
      else if (['kreis', 'radial', 'teilkreis'].includes(a.art)) d.gemessen = +(2 * a.r).toFixed(3);
      else if (a.art === 'bogen') d.gemessen = +a.r.toFixed(3);
      else if (a.art === 'fase') d.gemessen = a.c;
    }
    if (!a) d.status = 'nicht zugeordnet';
    else if (a.art === 'info') d.status = 'Hinweis';
    else if (d.gemessen != null && Math.abs(d.gemessen - d.wert) < Math.max(0.05, 0.01 * d.wert)) d.status = 'geprüft';
    else if (d.gemessen != null) d.status = `Abweichung (Geometrie ${d.gemessen})`;
    else d.status = 'zugeordnet';
    d.editierbar = !!a && ['linear', 'kreis', 'radial', 'bogen', 'teilkreis', 'fase'].includes(a.art);
    if (a && a.art === 'linear' && a.modus === 'verschieben' && d.typ !== 'laenge') d.editierbar = false;
  });
  return dims;
}

// ---------------------------------------------------------------- parametrische Änderungen
function shiftPrim(p, fpt) {
  if (p.kind === 'circle') { const q = copyPrim(p); q.center = fpt(p.center); return q; }
  if (p.kind === 'arc') {
    const n0 = fpt(p.pts[0]), n1 = fpt(p.pts[1]);
    const d0 = sub(n0, p.pts[0]), d1 = sub(n1, p.pts[1]);
    const q = copyPrim(p); q.pts = [n0, n1];
    if (Math.hypot(d0[0] - d1[0], d0[1] - d1[1]) < 1e-9) q.center = [p.center[0] + d0[0], p.center[1] + d0[1]];
    else {
      const sm = sample(p); const m = sm[Math.floor(sm.length / 2)];
      const a = arcFrom3pts(n0, [m[0] + (d0[0] + d1[0]) / 2, m[1] + (d0[1] + d1[1]) / 2], n1);
      if (a) return a;
    }
    return q;
  }
  return transform(p, fpt);
}

function stretch(ctx, A, thr, delta) {
  const s = ctx.s;
  ctx.views.forEach((w, vi) => {
    for (const [ax, k] of [['x', 0], ['y', 1]]) {
      const m = ctx.amap(vi, ax); if (!m || m[0] !== A) continue;
      const pt = m[1] + m[2] * thr * s, dirn = m[2];
      const moving = q => dirn * (q[k] - pt) >= -0.05;
      const extra = [];
      for (const p of w.prims) if (p.kind === 'arc' && length(p) < 12 * s && moving(p.pts[0]) !== moving(p.pts[1])) extra.push(!moving(p.pts[0]) ? p.pts[0] : p.pts[1]);
      const f = q => { q = q.slice(); if (moving(q) || extra.some(e => Math.abs(q[0] - e[0]) < 0.08 && Math.abs(q[1] - e[1]) < 0.08)) q[k] += dirn * delta * s; return q; };
      w.prims = w.prims.map(p => shiftPrim(p, f));
      w.hidden = w.hidden.map(p => shiftPrim(p, f));
    }
  });
}

function moveFeature(ctx, A, c, delta) {
  const s = ctx.s;
  ctx.views.forEach((w, vi) => {
    for (const [ax, k] of [['x', 0], ['y', 1]]) {
      const m = ctx.amap(vi, ax); if (!m || m[0] !== A) continue;
      const pc = m[1] + m[2] * c * s, dp = m[2] * delta * s;
      const rr = w.prims.filter(p => p.kind === 'circle' && Math.abs(p.center[k] - pc) < 0.12).map(p => p.r);
      const R = rr.length ? Math.max(...rr) : 0;
      w.prims = w.prims.map(p => {
        if (p.kind === 'circle' && Math.abs(p.center[k] - pc) < 0.12) { const q = copyPrim(p); q.center[k] += dp; return q; }
        return p;
      });
      w.hidden = w.hidden.map(p => {
        const cs = points(p).map(q => q[k]);
        if (R && cs.every(x => pc - R - 0.12 <= x && x <= pc + R + 0.12) && p.kind === 'line' && Math.abs(p.pts[0][k] - p.pts[1][k]) < 0.05)
          return transform(p, q => q.map((v, i) => v + (i === k ? dp : 0)));
        return p;
      });
    }
  });
}

function hiddenFollow(ctx, srcVi, center, rOld, rNew) {
  const s = ctx.s;
  for (const [ax, k] of [['x', 0], ['y', 1]]) {
    const m = ctx.amap(srcVi, ax); if (!m) continue;
    const A = m[0], cm = (center[k] - m[1]) * m[2] / s;
    ctx.views.forEach((w, vj) => {
      if (vj === srcVi) return;
      for (const [ax2, k2] of [['x', 0], ['y', 1]]) {
        const m2 = ctx.amap(vj, ax2); if (!m2 || m2[0] !== A) continue;
        for (const sgn of [-1, 1]) {
          const old = m2[1] + m2[2] * (cm + sgn * rOld) * s, nw = m2[1] + m2[2] * (cm + sgn * rNew) * s;
          w.hidden = w.hidden.map(p => (p.kind === 'line' && p.pts.every(q => Math.abs(q[k2] - old) < 0.12))
            ? transform(p, q => q.map((v, i) => i === k2 ? nw : v)) : p);
        }
      }
    });
  }
}

function cornerScale(view, sel, factor) {
  const prims = view.prims; const moves = [];
  for (const p of prims) {
    if (!sel(p)) continue;
    const a = p.pts[0], b = p.pts[1];
    const neigh = pt => {
      for (const q of prims) {
        if (q === p || q.kind !== 'line') continue;
        for (const i of [0, 1]) if (dist(q.pts[i], pt) < 0.08) return [q.pts[1 - i], q.pts[i]];
      }
      return null;
    };
    const na = neigh(a), nb = neigh(b); if (!na || !nb) continue;
    const da = sub(na[1], na[0]), db = sub(nb[1], nb[0]);
    const t = solve2(da[0], -db[0], da[1], -db[1], nb[0][0] - na[0][0], nb[0][1] - na[0][1]); if (!t) continue;
    const K = [na[0][0] + t[0] * da[0], na[0][1] + t[0] * da[1]];
    const sc = q => [K[0] + (q[0] - K[0]) * factor, K[1] + (q[1] - K[1]) * factor];
    moves.push([a.slice(), sc(a)], [b.slice(), sc(b)]);
    if (p.kind === 'arc') { p.center = sc(p.center); p.r *= factor; }
  }
  const f = q => { for (const [k, v] of moves) if (dist(q, k) < 0.08) return v.slice(); return q.slice(); };
  view.prims = prims.map(p => {
    if (p.kind === 'line' || p.kind === 'arc') { const q = copyPrim(p); q.pts = p.pts.map(f); return q; }
    return p;
  });
  return moves.length / 2;
}

function radialEdit(ctx, rOld, rNew) {
  const L = ctx.layout, s = ctx.s; const P = ctx.views[L.profil], ay = L.achse_y;
  const dr = (rNew - rOld) * s;
  const key = q => `${Math.round(q[0] * 1000) / 1000},${Math.round(q[1] * 1000) / 1000}`;
  const moved = new Map();
  for (const p of P.prims) if (p.kind === 'line' || p.kind === 'arc') for (const q of p.pts) if (Math.abs(Math.abs(q[1] - ay) - rOld * s) < 0.1) moved.set(key(q), q.slice());
  for (const p of P.prims) {
    if ((p.kind === 'line' || p.kind === 'arc') && length(p) < 4.5) {
      const k = p.pts.map(key);
      if (moved.has(k[0]) !== moved.has(k[1])) {
        const d0 = Math.abs(p.pts[0][1] - ay), d1 = Math.abs(p.pts[1][1] - ay);
        if (Math.min(d0, d1) > 0.1 && Math.abs(d0 - d1) < 4.5) p.pts.forEach((q, i) => moved.set(k[i], q.slice()));
      }
    }
  }
  const mv = [...moved.values()];
  const f = q => (moved.has(key(q)) || mv.some(m => Math.abs(q[0] - m[0]) < 0.08 && Math.abs(q[1] - m[1]) < 0.08)) ? [q[0], q[1] + (q[1] > ay ? dr : -dr)] : q.slice();
  const oldR = [...new Set(mv.map(m => Math.round(Math.abs(m[1] - ay) * 1000) / 1000))];
  P.prims = P.prims.map(p => shiftPrim(p, f));
  if (L.kreis != null) {
    const C = ctx.views[L.kreis];
    for (const p of C.prims) if (p.kind === 'circle' && dist(p.center, C.c) < 0.5 && oldR.some(r => Math.abs(p.r - r) < 0.1)) p.r += dr;
  }
  L.profil_radien = (L.profil_radien || []).map(r => Math.abs(r - rOld) < 0.02 ? r + (rNew - rOld) : r);
}

export function applyEdits(ctx, dims, edits) {
  const log = [], s = ctx.s;
  for (const d of dims) {
    if (!(d.id in edits)) continue;
    const nw = parseFloat(edits[d.id]), old = d.wert;
    if (!isFinite(nw) || Math.abs(nw - old) < 1e-9) continue;
    const a = d.anker;
    if (!d.editierbar || !a) { log.push(`${d.id} (${d.text}): nicht parametrisch änderbar – ignoriert.`); continue; }
    if (nw <= 0) { log.push(`${d.id}: Wert muss positiv sein – ignoriert.`); continue; }
    const art = a.art;
    if (art === 'linear' && a.modus === 'strecken') {
      const delta = nw - (a.m1 - a.m0); let thr = a.m1; const rigid = [];
      for (const e of dims) {
        const b = e.anker;
        if (e !== d && b && b.art === 'linear' && b.modus === 'strecken' && b.achse === a.achse && Math.abs(b.m1 - a.m1) < 0.01 && b.m0 > a.m0 + 0.01) { thr = Math.min(thr, b.m0); rigid.push(e.id); }
      }
      stretch(ctx, a.achse, thr, delta);
      for (const e of dims) {
        const b = e.anker;
        if (b && b.art === 'linear' && b.achse === a.achse)
          for (const key of ['m0', 'm1', 'fest', 'bewegt']) if (key in b && b[key] >= thr - 1e-6 && !(e === d && key === 'm0')) b[key] += delta;
      }
      log.push(`${d.id}: ${old} → ${nw} (Geometrie ab ${thr.toFixed(2)} mm entlang ${a.achse} verschoben/gestreckt${rigid.length ? `, ${rigid.join(', ')} bleibt erhalten` : ''})`);
    } else if (art === 'linear') {
      const sign = a.bewegt > a.fest ? 1 : -1; const delta = sign * nw - (a.bewegt - a.fest);
      moveFeature(ctx, a.achse, a.bewegt, delta);
      const mvOld = a.bewegt;
      for (const e of dims) {
        const b = e.anker;
        if (b && b.art === 'linear' && b.achse === a.achse) for (const key of ['m0', 'm1', 'bewegt']) if (key in b && Math.abs(b[key] - mvOld) < 1e-6) b[key] += delta;
      }
      [a.m0, a.m1] = [a.fest, a.bewegt].sort((x, y) => x - y);
      log.push(`${d.id}: ${old} → ${nw} (Bohrung verschoben)`);
    } else if (art === 'kreis') {
      const w = ctx.views[a.ansicht], rOld = a.r, rNew = nw / 2;
      for (const p of w.prims) if (p.kind === 'circle' && Math.abs(p.r / s - rOld) < 0.05) { hiddenFollow(ctx, a.ansicht, p.center, rOld, rNew); p.r = rNew * s; }
      a.r = rNew; log.push(`${d.id}: Ø${old} → Ø${nw}`);
    } else if (art === 'radial') {
      radialEdit(ctx, a.r, nw / 2); a.r = nw / 2; log.push(`${d.id}: Ø${old} → Ø${nw} (Drehprofil)`);
    } else if (art === 'bogen') {
      const w = ctx.views[a.ansicht], rOld = a.r;
      const n = cornerScale(w, p => p.kind === 'arc' && Math.abs(p.r / s - rOld) < 0.05, nw / rOld);
      a.r = nw; log.push(`${d.id}: R${old} → R${nw} (${n} Rundung(en))`);
    } else if (art === 'fase') {
      const cOld = a.c; let n = 0;
      for (const w of ctx.views) n += cornerScale(w, p => p.kind === 'line' && Math.abs(Math.abs(p.pts[1][0] - p.pts[0][0]) / s - cOld) < 0.05 && Math.abs(Math.abs(p.pts[1][1] - p.pts[0][1]) / s - cOld) < 0.05, nw / cOld);
      a.c = nw; log.push(`${d.id}: Fase ${old} → ${nw} (${n} Fase(n))`);
    } else if (art === 'teilkreis') {
      const C = ctx.views[ctx.layout.kreis], P = ctx.views[ctx.layout.profil], ay = ctx.layout.achse_y;
      const rOld = a.r, rNew = nw / 2, f = rNew / rOld;
      for (const p of C.prims) if (p.kind === 'circle' && Math.abs(dist(p.center, C.c) / s - rOld) < 0.05) p.center = [C.c[0] + (p.center[0] - C.c[0]) * f, C.c[1] + (p.center[1] - C.c[1]) * f];
      const hr = C.prims.filter(pp => pp.kind === 'circle').map(pp => pp.r);
      P.hidden = P.hidden.map(p => {
        if (p.kind === 'line' && Math.abs(p.pts[0][1] - p.pts[1][1]) < 0.05) {
          const dy = p.pts[0][1] - ay;
          if (Math.abs(Math.abs(dy) - rOld * s) < Math.max(...hr, 0) + 0.2) { const sh = (rNew - rOld) * s * (dy > 0 ? 1 : -1); return transform(p, q => [q[0], q[1] + sh]); }
        }
        return p;
      });
      a.r = rNew; log.push(`${d.id}: Teilkreis Ø${old} → Ø${nw}`);
    }
    d.wert_alt = old; d.wert = nw; d.gemessen = nw; d.status = 'geändert';
  }
  return log;
}
