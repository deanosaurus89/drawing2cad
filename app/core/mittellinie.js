// Mittellinie: erkennen, aus einer angeklickten Linie übernehmen, aus zwei Kanten ableiten.
import { dist, Graph } from './geom.js';

const r3 = p => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000];

export function segmentOf(p) {
  if (!p) return null;
  if (p.kind === 'line' && p.pts && p.pts.length >= 2) return [p.pts[0].slice(), p.pts[1].slice()];
  if ((p.kind === 'arc' || p.k === 'arc') && p.pts && p.pts.length >= 2) return [p.pts[0].slice(), p.pts[p.pts.length - 1].slice()];
  if (p.kind === 'circle' && p.center && p.r > 0) return [[p.center[0] - p.r, p.center[1]], [p.center[0] + p.r, p.center[1]]];
  if (p.pts && p.pts.length >= 2) return [p.pts[0].slice(), p.pts[p.pts.length - 1].slice()];
  return null;
}

export function distPointSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy || 1e-12;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function frame(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy) || 1;
  return { a, b, ux: dx / L, uy: dy / L, nx: -dy / L, ny: dx / L, L };
}

function along(fr, p) { return (p[0] - fr.a[0]) * fr.ux + (p[1] - fr.a[1]) * fr.uy; }
function side(fr, p) { return (p[0] - fr.a[0]) * fr.nx + (p[1] - fr.a[1]) * fr.ny; }
function at(fr, t, n) { return [fr.a[0] + fr.ux * t + fr.nx * n, fr.a[1] + fr.uy * t + fr.ny * n]; }

/** Mittelachse zwischen zwei ungefähr parallelen Linien. Überdeckung bestimmt die Länge. */
export function axisBetween(p, q) {
  const sa = segmentOf(p), sb = segmentOf(q);
  if (!sa || !sb) return null;
  if (dist(sa[0], sa[1]) < 2 || dist(sb[0], sb[1]) < 2) return null;
  const d1 = Math.atan2(sa[1][1] - sa[0][1], sa[1][0] - sa[0][0]);
  const d2 = Math.atan2(sb[1][1] - sb[0][1], sb[1][0] - sb[0][0]);
  let dw = Math.abs(d1 - d2) * 180 / Math.PI % 180;
  if (dw > 90) dw = 180 - dw;
  if (dw > 12) return null;
  const A = frame(sa[0], sa[1]);
  const tb = [along(A, sb[0]), along(A, sb[1])].sort((x, y) => x - y);
  const lo = Math.max(0, tb[0]), hi = Math.min(A.L, tb[1]);
  const spanLo = hi - lo >= 4 ? lo : Math.min(0, tb[0]);
  const spanHi = hi - lo >= 4 ? hi : Math.max(A.L, tb[1]);
  if (spanHi - spanLo < 4) return null;
  const midN = (side(A, sb[0]) + side(A, sb[1])) / 4;
  return {
    p0: r3(at(A, spanLo, midN)),
    p1: r3(at(A, spanHi, midN)),
    quelle: 'abgeleitet',
  };
}

/** Die angeklickte Linie oder Kurve wird selbst zur Mittellinie (bei Bögen die Sehne). */
export function axisFromPrim(p) {
  const s = segmentOf(p);
  if (!s || dist(s[0], s[1]) < 2) return null;
  return { p0: r3(s[0]), p1: r3(s[1]), quelle: 'markiert' };
}

export function naechsteLinie(prims, point, tol = 2.4) {
  let best = null;
  for (const p of prims || []) {
    const s = segmentOf(p);
    if (!s) continue;
    const d = distPointSeg(point, s[0], s[1]);
    if (d <= tol && (!best || d < best.d)) best = { d, prim: p };
  }
  return best ? best.prim : null;
}

export function linienPool(dr) {
  if (!dr) return [];
  return [].concat(dr.center || [], dr.thin || [], dr.hidden || [], dr.thick || []);
}

function overlaps(ax, view, pad = 10) {
  if (!view) return true;
  const m = [(ax.p0[0] + ax.p1[0]) / 2, (ax.p0[1] + ax.p1[1]) / 2];
  return m[0] >= view.lo[0] - pad && m[0] <= view.hi[0] + pad && m[1] >= view.lo[1] - pad && m[1] <= view.hi[1] + pad;
}

/** Kollineare Stücke einer Strich-Mittellinie zu einer Achse zusammenfassen. */
function chainAxes(lines, gapMax = 8, lateral = 0.55) {
  const segs = [];
  for (const p of lines) {
    const s = segmentOf(p);
    if (!s || dist(s[0], s[1]) < 1.2) continue;
    segs.push(s);
  }
  const used = new Array(segs.length).fill(false);
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const base = frame(segs[i][0], segs[i][1]);
    let lo = 0, hi = base.L, nSum = 0, nN = 2;
    const take = [i];
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < segs.length; j++) {
        if (used[j]) continue;
        const lat = Math.max(Math.abs(side(base, segs[j][0])), Math.abs(side(base, segs[j][1])));
        if (lat > lateral) continue;
        const ts = [along(base, segs[j][0]), along(base, segs[j][1])].sort((a, b) => a - b);
        if (ts[0] > hi + gapMax || ts[1] < lo - gapMax) continue;
        used[j] = true; take.push(j); grew = true;
        lo = Math.min(lo, ts[0]); hi = Math.max(hi, ts[1]);
        nSum += side(base, segs[j][0]) + side(base, segs[j][1]); nN += 2;
      }
    }
    const n = nSum / nN;
    if (hi - lo < 8) continue;
    out.push({ p0: r3(at(base, lo, n)), p1: r3(at(base, hi, n)), quelle: 'mittellinie', span: hi - lo, n: take.length });
  }
  return out;
}

/**
 * Dünne, fluchtende Kurz-lang-Stücke: CAD hat die Mittellinie ohne Strichmuster exportiert.
 * Einzelne Körperkanten (ein langes Stück) zählen nicht.
 */
function explodedCenterlines(lines) {
  const segs = [];
  for (const p of lines || []) {
    if (p.kind && p.kind !== 'line') continue;
    const s = segmentOf(p);
    if (!s) continue;
    const L = dist(s[0], s[1]);
    if (L < 0.4 || L > 80) continue;
    segs.push({ s, L });
  }
  const used = new Array(segs.length).fill(false);
  const groups = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    const base = frame(segs[i].s[0], segs[i].s[1]);
    const g = [segs[i]];
    used[i] = true;
    for (let j = 0; j < segs.length; j++) {
      if (used[j]) continue;
      const lat = Math.max(Math.abs(side(base, segs[j].s[0])), Math.abs(side(base, segs[j].s[1])));
      if (lat > 0.4) continue;
      used[j] = true;
      g.push(segs[j]);
    }
    if (g.length >= 4) groups.push({ base, g });
  }
  const out = [];
  for (const { base, g } of groups) {
    const lens = g.map(x => x.L).sort((a, b) => a - b);
    const spanPts = g.flatMap(x => [along(base, x.s[0]), along(base, x.s[1])]);
    const span = Math.max(...spanPts) - Math.min(...spanPts);
    const short = lens.filter(L => L < 4).length;
    const long = lens.filter(L => L >= 4).length;
    if (span < 18 || short < 2 || long < 2) continue;
    const lo = Math.min(...spanPts), hi = Math.max(...spanPts);
    out.push({ kind: 'line', pts: [at(base, lo, 0), at(base, hi, 0)] });
  }
  return out;
}

/** Beste Mittellinie in oder an einer Ansicht. */
export function erkenneMittellinie(view, pools = {}) {
  const dashed = chainAxes(pools.center || []);
  const exploded = chainAxes(explodedCenterlines([].concat(pools.thin || [], pools.hidden || [])), 4, 0.4);
  let best = null;
  for (const ax of dashed.concat(exploded)) {
    if (view && !overlaps(ax, view)) continue;
    const need = view ? Math.max(12, Math.max(view.size[0], view.size[1]) * 0.22) : 12;
    if (ax.span < need) continue;
    const bonus = ax.n > 1 ? 4 : 0;
    const score = ax.span + bonus;
    if (!best || score > best.score) best = { ...ax, score };
  }
  if (!best) return null;
  return { p0: best.p0, p1: best.p1, quelle: 'mittellinie' };
}

/** Ansicht, deren Außenbahn gedreht oder extrudiert wird: die mit den meisten Kanten, nicht die reine Kreisansicht. */
export function ansichtFuerBahn(analyse) {
  if (!analyse) return null;
  const liste = (analyse.views && analyse.views.length ? analyse.views : analyse.alle || [])
    .filter(v => v && v.rolle !== 'isometrie' && v.rolle !== 'schriftfeld' && v.rolle !== 'ignorieren');
  const mitKante = liste.filter(v => (v.prims || []).some(p => p.kind !== 'circle'));
  const pool = mitKante.length ? mitKante : liste;
  return pool.slice().sort((a, b) => (b.prims || []).length - (a.prims || []).length)[0] || null;
}

/** Außenbahn einer Ansicht, wie sie gedreht oder extrudiert wird. */
export function bahnAusAnsicht(view, tol = 0.15) {
  if (!view || !view.prims) return null;
  const prims = view.prims.filter(p => p.kind !== 'circle');
  if (prims.length < 3) return null;
  try {
    const g = new Graph(prims, tol);
    const comps = g.components();
    if (!comps.length) return null;
    const comp = comps.reduce((a, b) => b.length > a.length ? b : a);
    const loop = g.outerWalk(comp);
    const poly = [];
    for (const [e, rev] of loop) {
      const pts = (rev ? [...e.poly].reverse() : e.poly);
      for (const q of pts) {
        if (!poly.length || dist(poly[poly.length - 1], q) > 0.05) poly.push(q.slice());
      }
    }
    if (poly.length > 2 && dist(poly[0], poly[poly.length - 1]) < 0.2) poly.pop();
    return poly.length >= 3 ? poly.map(r3) : null;
  } catch { return null; }
}

/** true, wenn die Kontur nur auf einer Seite der Mittellinie liegt (Halbschnitt). */
export function eineSeite(pts, axis, tol = 0.35) {
  if (!axis || !axis.p0 || !axis.p1 || !pts || pts.length < 3) return false;
  const fr = frame(axis.p0, axis.p1);
  let pos = 0, neg = 0;
  for (const p of pts) {
    const s = side(fr, p);
    if (s > tol) pos++;
    else if (s < -tol) neg++;
  }
  return (pos === 0) !== (neg === 0) && (pos + neg) >= 1;
}

export function spiegelUeberAchse(pts, axis) {
  const fr = frame(axis.p0, axis.p1);
  return pts.map(p => {
    const t = along(fr, p), n = side(fr, p);
    return r3(at(fr, t, -n));
  });
}

/** Halbe Kontur an der Mittellinie zur vollen Kontur ergänzen. Sonst null. */
export function symmetrieren(items, axis) {
  if (!items || !axis || !axis.p0 || !axis.p1) return null;
  const seq = [];
  for (const it of items) for (const p of it.pts || []) {
    if (!seq.length || dist(seq[seq.length - 1], p) > 1e-4) seq.push(p);
  }
  if (!eineSeite(seq, axis)) return null;
  const fr = frame(axis.p0, axis.p1);
  const probe = seq.find(p => Math.abs(side(fr, p)) > 0.35) || seq[0];
  const sign = side(fr, probe) >= 0 ? 1 : -1;
  const keep = seq.filter(p => side(fr, p) * sign >= -0.3);
  if (keep.length < 2) return null;
  const mir = keep.slice().reverse().map(p => at(fr, along(fr, p), -side(fr, p)));
  return keep.concat(mir).map(r3);
}
