// Linienzüge aus tessellierten CAD-Exporten zu Geraden, Kreisbögen und Kreisen.
// Lange Einzelkanten bleiben unverändert, damit bestehende Beispiele nicht umgeschrieben werden.
import { prim, dist, sub, dot, cross2, arcFrom3pts, TAU } from './geom.js';

const cellOf = (p, cell) => Math.floor(p[0] / cell) + ',' + Math.floor(p[1] / cell);

function solve3(A, b) {
  const M = A.map((r, i) => r.concat(b[i]));
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    if (p !== c) { const t = M[c]; M[c] = M[p]; M[p] = t; }
    const div = M[c][c];
    for (let k = c; k < 4; k++) M[c][k] /= div;
    for (let r = 0; r < 3; r++) if (r !== c) {
      const f = M[r][c];
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  return [M[0][3], M[1][3], M[2][3]];
}

/** Algebraischer Kreis. err = größter radialer Abstand. */
export function fitCircle(pts) {
  const n = pts.length;
  if (n < 3) return null;
  let Su = 0, Sv = 0, Suu = 0, Svv = 0, Suv = 0, Suuu = 0, Svvv = 0, Suvv = 0, Svuu = 0;
  for (const p of pts) {
    const u = p[0], v = p[1];
    Su += u; Sv += v; Suu += u * u; Svv += v * v; Suv += u * v;
    Suuu += u * u * u; Svvv += v * v * v; Suvv += u * v * v; Svuu += v * u * u;
  }
  const x = solve3(
    [[Suu, Suv, Su], [Suv, Svv, Sv], [Su, Sv, n]],
    [Suuu + Suvv, Svvv + Svuu, Suu + Svv],
  );
  if (!x) return null;
  const c = [x[0] / 2, x[1] / 2];
  const r2 = c[0] * c[0] + c[1] * c[1] + x[2];
  if (!(r2 > 0)) return null;
  const r = Math.sqrt(r2);
  if (r < 0.2 || r > 5000) return null;
  let err = 0;
  for (const p of pts) err = Math.max(err, Math.abs(dist(p, c) - r));
  return { c, r, err };
}

function lineDev(pts) {
  const a = pts[0], b = pts[pts.length - 1];
  const L = dist(a, b) || 1;
  const d = sub(b, a);
  let err = 0;
  for (const p of pts) err = Math.max(err, Math.abs(cross2(d, sub(p, a))) / L);
  return err;
}

function angleStep(prev, cur, next) {
  const a = sub(cur, prev), b = sub(next, cur);
  const la = Math.hypot(a[0], a[1]), lb = Math.hypot(b[0], b[1]);
  if (la < 1e-9 || lb < 1e-9) return 0;
  const c = Math.max(-1, Math.min(1, dot(a, b) / (la * lb)));
  return Math.acos(c) * 180 / Math.PI;
}

/** Punkte an Knicken (> maxDeg) trennen. Tessellierte Bögen bleiben zusammen. */
export function splitSmooth(pts, maxDeg = 32) {
  if (pts.length < 3) return [pts];
  const runs = [];
  let cur = [pts[0], pts[1]];
  for (let i = 1; i + 1 < pts.length; i++) {
    if (angleStep(pts[i - 1], pts[i], pts[i + 1]) > maxDeg) {
      runs.push(cur);
      cur = [pts[i]];
    }
    cur.push(pts[i + 1]);
  }
  if (cur.length) runs.push(cur);
  return runs.filter(r => r.length >= 2);
}

function arcSweep(c, pts) {
  const ang = p => Math.atan2(p[1] - c[1], p[0] - c[0]);
  let sw = 0;
  for (let i = 1; i < pts.length; i++) {
    let d = ang(pts[i]) - ang(pts[i - 1]);
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    sw += d;
  }
  return sw;
}

function asArcOrCircle(pts, circ, join) {
  const closed = dist(pts[0], pts[pts.length - 1]) <= Math.max(join, 0.2);
  const sw = arcSweep(circ.c, pts);
  if (closed && Math.abs(Math.abs(sw) - TAU) < 0.35) return { prim: prim('circle', { center: circ.c.slice(), r: circ.r }), kind: 'circle' };
  const arc = prim('arc', { center: circ.c.slice(), r: circ.r, sweep: sw, pts: [pts[0].slice(), pts[pts.length - 1].slice()] });
  return { prim: arc, kind: 'arc' };
}

/**
 * Ein glatter Lauf: Gerade, Kreis oder Kreisbogen.
 * Ellipsen werden als wenige Kreisbögen genähert (der Volumenkern kennt Bögen, keine Ellipsenfläche).
 */
export function fitRun(pts, join) {
  if (pts.length < 2) return null;
  const uniq = [pts[0].slice()];
  for (const p of pts) if (dist(uniq[uniq.length - 1], p) > 0.05) uniq.push(p.slice());
  if (uniq.length < 2) return null;
  const lens = [];
  for (let i = 1; i < uniq.length; i++) lens.push(dist(uniq[i - 1], uniq[i]));
  const med = lens.slice().sort((a, b) => a - b)[lens.length >> 1];
  const tess = uniq.length >= 8 && med < 0.8;
  const closed = dist(uniq[0], uniq[uniq.length - 1]) <= Math.max(join, 0.25);
  const dev = lineDev(uniq);
  if (!closed && dev <= 0.15 && (uniq.length >= 4 || tess)) {
    return { prims: [prim('line', { pts: [uniq[0].slice(), uniq[uniq.length - 1].slice()] })], lines: 1, arcs: 0, circles: 0, ellipses: 0 };
  }
  if (!tess && uniq.length < 8) return null;
  const circ = fitCircle(uniq);
  const tol = Math.max(0.18, (circ ? circ.r : 10) * 0.012);
  if (circ && circ.err <= tol) {
    const one = asArcOrCircle(uniq, circ, join);
    const bb = bboxOf(uniq);
    const aspect = Math.min(bb.w, bb.h) / Math.max(bb.w, bb.h, 1e-6);
    const ellipse = aspect < 0.82 && circ.err > 0.05;
    return {
      prims: [one.prim],
      lines: 0, arcs: one.kind === 'arc' && !ellipse ? 1 : 0, circles: one.kind === 'circle' && !ellipse ? 1 : 0,
      ellipses: ellipse ? 1 : 0,
    };
  }
  // Ellipsenbogen oder unruhiger Zug: in Kreisbögen zerlegen, jeder über arcFrom3pts geprüft.
  const pieces = coverWithArcs(uniq, tol * 1.4);
  if (!pieces) return null;
  const bb = bboxOf(uniq);
  const aspect = Math.min(bb.w, bb.h) / Math.max(bb.w, bb.h, 1e-6);
  const ellipse = aspect < 0.82 && pieces.every(p => p.kind === 'arc');
  return {
    prims: pieces.map(p => p.prim),
    lines: pieces.filter(p => p.kind === 'line').length,
    arcs: ellipse ? 0 : pieces.filter(p => p.kind === 'arc').length,
    circles: 0,
    ellipses: ellipse ? 1 : 0,
  };
}

function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  return { w: x1 - x0, h: y1 - y0 };
}

function coverWithArcs(pts, tol) {
  const out = [];
  let i = 0;
  while (i < pts.length - 1) {
    let best = null;
    for (let j = pts.length - 1; j >= i + 2; j--) {
      const a = pts[i], c = pts[(i + j) >> 1], b = pts[j];
      const arc = arcFrom3pts(a, c, b);
      if (!arc) continue;
      let err = 0;
      for (let k = i; k <= j; k++) err = Math.max(err, Math.abs(dist(pts[k], arc.center) - arc.r));
      if (err <= tol) { best = { j, arc }; break; }
    }
    if (!best) {
      const a = pts[i], b = pts[Math.min(pts.length - 1, i + 1)];
      if (dist(a, b) < 1e-4) { i++; continue; }
      if (lineDev(pts.slice(i, Math.min(pts.length, i + 2))) > 0.2) return null;
      out.push({ kind: 'line', prim: prim('line', { pts: [a.slice(), b.slice()] }) });
      i += 1;
      continue;
    }
    out.push({ kind: 'arc', prim: best.arc });
    i = best.j;
    if (out.length > 12) return null;
  }
  return out.length ? out : null;
}

function chainLines(lines, tol) {
  const n = lines.length;
  if (!n) return [];
  const cell = Math.max(tol * 2, 0.25);
  const buckets = new Map();
  const put = (p, idx, end) => {
    const k = cellOf(p, cell);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push([idx, end]);
  };
  for (let i = 0; i < n; i++) { put(lines[i].pts[0], i, 0); put(lines[i].pts[1], i, 1); }
  const best = Array.from({ length: n }, () => [null, null]);
  for (let i = 0; i < n; i++) for (const end of [0, 1]) {
    const p = lines[i].pts[end];
    const Li = dist(lines[i].pts[0], lines[i].pts[1]);
    const ix = Math.floor(p[0] / cell), iy = Math.floor(p[1] / cell);
    let pick = null;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const g = buckets.get((ix + dx) + ',' + (iy + dy));
      if (!g) continue;
      for (const [j, e2] of g) {
        if (j === i) continue;
        const gap = dist(p, lines[j].pts[e2]);
        const Lj = dist(lines[j].pts[0], lines[j].pts[1]);
        const limit = Math.min(tol, Math.max(0.08, 0.45 * Math.min(Li, Lj)));
        if (gap <= limit && (!pick || gap < pick.gap)) pick = { j, e2, gap };
      }
    }
    best[i][end] = pick;
  }
  const adj = Array.from({ length: n }, () => [[], []]);
  const seen = new Set();
  for (let i = 0; i < n; i++) for (const end of [0, 1]) {
    const pick = best[i][end];
    if (!pick) continue;
    const back = best[pick.j][pick.e2];
    if (!back || back.j !== i) continue;
    const key = i < pick.j ? i + ':' + pick.j : pick.j + ':' + i;
    if (seen.has(key)) continue;
    seen.add(key);
    adj[i][end].push([pick.j, pick.e2]);
    adj[pick.j][pick.e2].push([i, end]);
  }
  const deg = adj.map(a => a[0].length + a[1].length);
  const used = new Array(n).fill(false);
  const chains = [];
  function grow(start, at) {
    const pts = [];
    let i = start;
    while (i != null && !used[i] && deg[i] <= 2) {
      used[i] = true;
      const other = 1 - at;
      if (!pts.length) pts.push(lines[i].pts[at].slice());
      pts.push(lines[i].pts[other].slice());
      const nxt = adj[i][other].filter(([j]) => !used[j] && deg[j] <= 2);
      if (nxt.length !== 1) break;
      at = nxt[0][1];
      i = nxt[0][0];
    }
    return pts;
  }
  for (let i = 0; i < n; i++) {
    if (used[i] || deg[i] === 2 || deg[i] > 2) continue;
    const at = adj[i][0].length === 0 ? 0 : 1;
    const pts = grow(i, at);
    if (pts.length >= 2) chains.push(pts);
  }
  for (let i = 0; i < n; i++) {
    if (used[i]) continue;
    if (deg[i] === 2) {
      const pts = grow(i, 0);
      if (pts.length >= 2) chains.push(pts);
    } else {
      used[i] = true;
      chains.push([lines[i].pts[0].slice(), lines[i].pts[1].slice()]);
    }
  }
  return chains;
}

/**
 * @param {object[]} prims
 * @param {{ join?: number, schliessen?: boolean }} [opt]
 * join: Endpunkte bis zu diesem Abstand (mm auf dem Blatt) verbinden.
 * schliessen: fast geschlossene Züge mit einer Geraden schließen, wenn die Lücke <= join.
 */
export function fitPrimitives(prims, opt = {}) {
  const join = opt.join > 0 ? opt.join : 0.45;
  const kept = [];
  const short = [];
  for (const p of prims || []) {
    if (!p || p.kind !== 'line') { kept.push(p); continue; }
    const L = dist(p.pts[0], p.pts[1]);
    if (L >= 6) kept.push(p);
    else short.push(p);
  }
  const chains = chainLines(short, join);
  let lines = 0, arcs = 0, circles = 0, ellipses = 0, raw = 0, closed = 0;
  for (const pts0 of chains) {
    let pts = pts0;
    const gap = dist(pts[0], pts[pts.length - 1]);
    const peri = pts.reduce((s, p, i) => i ? s + dist(pts[i - 1], p) : 0, 0);
    if (opt.schliessen && gap > 0.08 && gap <= join && peri > gap * 4) {
      pts = pts.concat([pts[0].slice()]);
      closed++;
    }
    const runs = splitSmooth(pts);
    let fitted = [];
    let ok = true;
    const acc = { lines: 0, arcs: 0, circles: 0, ellipses: 0 };
    for (const run of runs) {
      const one = fitRun(run, join);
      if (!one) { ok = false; break; }
      fitted = fitted.concat(one.prims);
      acc.lines += one.lines; acc.arcs += one.arcs; acc.circles += one.circles; acc.ellipses += one.ellipses;
    }
    const worth = acc.circles + acc.arcs + acc.ellipses > 0 || (acc.lines > 0 && pts.length >= 6);
    if (ok && worth && fitted.length && fitted.length < pts.length - 1) {
      kept.push(...fitted);
      lines += acc.lines; arcs += acc.arcs; circles += acc.circles; ellipses += acc.ellipses;
    } else {
      for (let i = 1; i < pts.length; i++) {
        if (dist(pts[i - 1], pts[i]) > 0.05) kept.push(prim('line', { pts: [pts[i - 1].slice(), pts[i].slice()] }));
      }
      raw += Math.max(0, pts.length - 1);
    }
  }
  const changed = lines + arcs + circles + ellipses > 0;
  const text = changed
    ? `Geometrie-Fit: ${lines} Geraden, ${arcs} Kreisbögen, ${circles} Kreise`
      + (ellipses ? `, ${ellipses} Ellipsen als Bögen genähert` : '')
      + (closed ? `, ${closed} Kontur(en) geschlossen` : '')
      + (raw ? `. ${raw} kurze Kanten blieben Linien` : '') + '.'
    : '';
  return { prims: kept, changed, text, lines, arcs, circles, ellipses, raw, closed };
}
