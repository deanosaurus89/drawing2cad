// 2D-Skizzen-Grundlagen (Port von backend/sketch.py): Primitive, Kantengraph, Konturverfolgung.
export const TOL = 0.08;
export class ReconError extends Error {}

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const mul = (a, k) => [a[0] * k, a[1] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const cross2 = (a, b) => a[0] * b[1] - a[1] * b[0];
export const norm = a => Math.hypot(a[0], a[1]);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const TAU = 2 * Math.PI;
export const mod = (a, m) => ((a % m) + m) % m;

export function prim(kind, kw) { return Object.assign({ kind }, kw); }

export function copyPrim(p) {
  const q = { ...p };
  if (p.pts) q.pts = p.pts.map(x => [x[0], x[1]]);
  if (p.center) q.center = [p.center[0], p.center[1]];
  if (p.beziers) q.beziers = p.beziers.map(b => b.map(x => [x[0], x[1]]));
  if (p.poly) q.poly = p.poly.map(x => [x[0], x[1]]);
  return q;
}
export const p0 = p => p.kind === 'spline' ? (p.beziers ? p.beziers[0][0] : p.poly[0]) : p.pts[0];
export const p1 = p => p.kind === 'spline' ? (p.beziers ? p.beziers[p.beziers.length - 1][3] : p.poly[p.poly.length - 1]) : p.pts[1];

export function sample(p, n = 24) {
  if (p.kind === 'line') return [p.pts[0].slice(), p.pts[1].slice()];
  if (p.kind === 'arc' || p.kind === 'circle') {
    const c = p.center; let a0, sw;
    if (p.kind === 'circle') { a0 = 0; sw = TAU; }
    else { a0 = Math.atan2(p.pts[0][1] - c[1], p.pts[0][0] - c[0]); sw = p.sweep; }
    const m = Math.max(8, Math.floor(Math.abs(sw) / TAU * 64));
    const out = [];
    for (let i = 0; i <= m; i++) { const a = a0 + sw * i / m; out.push([c[0] + p.r * Math.cos(a), c[1] + p.r * Math.sin(a)]); }
    if (p.kind === 'arc') { out[0] = p.pts[0].slice(); out[m] = p.pts[1].slice(); }
    return out;
  }
  if (p.poly) return p.poly.map(x => x.slice());
  const out = [];
  for (const B of p.beziers) {
    for (let i = out.length ? 1 : 0; i <= n; i++) {
      const t = i / n, s = 1 - t;
      out.push([0, 1].map(k => s * s * s * B[0][k] + 3 * s * s * t * B[1][k] + 3 * s * t * t * B[2][k] + t * t * t * B[3][k]));
    }
  }
  return out;
}

export function points(p) {
  const out = [];
  if (p.pts) out.push(...p.pts);
  if (p.center) out.push(p.center);
  if (p.beziers) for (const b of p.beziers) out.push(...b);
  if (p.poly) out.push(...p.poly);
  return out;
}

export function transform(p, f) {
  const q = copyPrim(p);
  if (q.pts) q.pts = q.pts.map(f);
  if (q.center) q.center = f(q.center);
  if (q.beziers) q.beziers = q.beziers.map(b => b.map(f));
  if (q.poly) q.poly = q.poly.map(f);
  return q;
}

export function bbox(p) {
  const s = sample(p, 8); const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const q of s) { lo[0] = Math.min(lo[0], q[0]); lo[1] = Math.min(lo[1], q[1]); hi[0] = Math.max(hi[0], q[0]); hi[1] = Math.max(hi[1], q[1]); }
  return [lo, hi];
}
export function length(p) { const s = sample(p, 16); let L = 0; for (let i = 1; i < s.length; i++) L += dist(s[i - 1], s[i]); return L; }

export function solve2(a11, a12, a21, a22, b1, b2) {
  const det = a11 * a22 - a12 * a21; if (Math.abs(det) < 1e-12) return null;
  return [(b1 * a22 - a12 * b2) / det, (a11 * b2 - b1 * a21) / det];
}

export function arcFrom3pts(a, b, c) {
  const d = 2 * cross2(sub(b, a), sub(c, a));
  if (Math.abs(d) < 1e-9) return null;
  const cen = solve2(2 * (b[0] - a[0]), 2 * (b[1] - a[1]), 2 * (c[0] - a[0]), 2 * (c[1] - a[1]), dot(b, b) - dot(a, a), dot(c, c) - dot(a, a));
  if (!cen) return null;
  const r = dist(a, cen);
  const a0 = Math.atan2(a[1] - cen[1], a[0] - cen[0]), a1 = Math.atan2(c[1] - cen[1], c[0] - cen[0]);
  let sw = mod(a1 - a0, TAU); if (!(d > 0)) sw -= TAU;
  return prim('arc', { center: cen, r, sweep: sw, pts: [a.slice(), c.slice()] });
}

export function bezierAsArc(b, rel = 0.004) {
  const [P0, P1, P2, P3] = b;
  const t0 = sub(P1, P0), t3 = sub(P3, P2);
  if (norm(t0) < 1e-9 || norm(t3) < 1e-9) return null;
  const n0 = [-t0[1], t0[0]], n3 = [-t3[1], t3[0]];
  const s = solve2(n0[0], -n3[0], n0[1], -n3[1], P3[0] - P0[0], P3[1] - P0[1]);
  if (!s) return null;
  const c = add(P0, mul(n0, s[0]));
  const r0 = dist(P0, c), r3 = dist(P3, c);
  const mid = [0, 1].map(k => 0.125 * (P0[k] + 3 * P1[k] + 3 * P2[k] + P3[k]));
  const rm = dist(mid, c);
  if (r0 < 1e-6 || Math.abs(r0 - r3) > rel * r0 + 0.01 || Math.abs(rm - r0) > rel * r0 + 0.01 || r0 > 5000) return null;
  const a0 = Math.atan2(P0[1] - c[1], P0[0] - c[0]), a3 = Math.atan2(P3[1] - c[1], P3[0] - c[0]);
  const cr = (P0[0] - c[0]) * t0[1] - (P0[1] - c[1]) * t0[0];
  let sw = a3 - a0;
  if (cr > 0) { while (sw <= 0) sw += TAU; } else { while (sw >= 0) sw -= TAU; }
  return [c, (r0 + r3) / 2, sw];
}

// ---------------------------------------------------------------- Kantengraph
export class Graph {
  constructor(prims, tol = TOL) {
    this.V = []; this.E = []; this.tol = tol;
    const lines = prims.filter(p => p.kind !== 'circle');
    const ends = lines.map(p0).concat(lines.map(p1));
    const split = [];
    for (const p of lines) {
      if (p.kind !== 'line') { split.push(p); continue; }
      const a = p.pts[0], b = p.pts[1], d = sub(b, a), L = norm(d);
      if (L < 1e-9) continue;
      const tsSet = new Set();
      for (const e of ends) {
        const t = dot(sub(e, a), d) / (L * L);
        if (tol / L < t && t < 1 - tol / L && Math.abs(cross2(d, sub(e, a))) / L < tol) tsSet.add(Math.round(t * 1e6) / 1e6);
      }
      const ts = [...tsSet].sort((x, y) => x - y);
      const pts = [a, ...ts.map(t => add(a, mul(d, t))), b];
      for (let i = 0; i + 1 < pts.length; i++) if (dist(pts[i], pts[i + 1]) > tol) split.push(prim('line', { pts: [pts[i].slice(), pts[i + 1].slice()] }));
    }
    const seen = [];
    for (const p of split) {
      const u = this.vid(p0(p)), v = this.vid(p1(p));
      const smp = sample(p, 4), mid = smp[Math.floor(smp.length / 2)];
      if (u === v) continue;
      if (seen.some(([uu, vv, mm]) => ((uu === u && vv === v) || (uu === v && vv === u)) && dist(mm, mid) < tol * 2)) continue;
      seen.push([u, v, mid]);
      this.E.push({ u, v, prim: p, poly: sample(p), V: this.V });
    }
    this.prune();
  }
  vid(p) {
    for (let i = 0; i < this.V.length; i++) if (dist(this.V[i], p) < this.tol) return i;
    this.V.push([p[0], p[1]]); return this.V.length - 1;
  }
  prune() {
    for (;;) {
      const deg = new Map();
      for (const e of this.E) { deg.set(e.u, (deg.get(e.u) || 0) + 1); deg.set(e.v, (deg.get(e.v) || 0) + 1); }
      const keep = this.E.filter(e => deg.get(e.u) >= 2 && deg.get(e.v) >= 2);
      if (keep.length === this.E.length) return;
      this.E = keep;
    }
  }
  components() {
    const adj = new Map();
    this.E.forEach((e, i) => { for (const k of [e.u, e.v]) { if (!adj.has(k)) adj.set(k, []); adj.get(k).push(i); } });
    const seen = new Set(), comps = [];
    for (const start of adj.keys()) {
      if (seen.has(start)) continue;
      const stack = [start], ce = new Set(); seen.add(start);
      while (stack.length) {
        const v = stack.pop();
        for (const ei of adj.get(v)) { ce.add(ei); const e = this.E[ei]; const w = e.u === v ? e.v : e.u; if (!seen.has(w)) { seen.add(w); stack.push(w); } }
      }
      comps.push([...ce].sort((a, b) => a - b));
    }
    return comps;
  }
  static dir(poly) {
    const P0 = poly[0]; let total = 0;
    for (let i = 1; i < poly.length; i++) total += dist(poly[i - 1], poly[i]);
    const need = Math.min(1.0, total / 3); let acc = 0;
    for (let i = 1; i < poly.length; i++) {
      acc += dist(poly[i - 1], poly[i]);
      if (acc >= need) { const d = sub(poly[i], P0); return Math.atan2(d[1], d[0]); }
    }
    const d = sub(poly[poly.length - 1], P0); return Math.atan2(d[1], d[0]);
  }
  outerWalk(comp) {
    const verts = new Set(); for (const ei of comp) { verts.add(this.E[ei].u); verts.add(this.E[ei].v); }
    let start = null;
    for (const i of verts) {
      if (start === null) { start = i; continue; }
      const a = Math.round(this.V[i][1] * 1000), b = Math.round(this.V[start][1] * 1000);
      if (a < b || (a === b && this.V[i][0] < this.V[start][0])) start = i;
    }
    const outDirs = new Map();
    for (const ei of comp) {
      const e = this.E[ei];
      if (!outDirs.has(e.u)) outDirs.set(e.u, []); if (!outDirs.has(e.v)) outDirs.set(e.v, []);
      outDirs.get(e.u).push([ei, false, Graph.dir(e.poly)]);
      outDirs.get(e.v).push([ei, true, Graph.dir([...e.poly].reverse())]);
    }
    let cur = start, back = -Math.PI / 2, path = [], first = null;
    for (let it = 0; it < 4 * comp.length + 10; it++) {
      let best = null; const od = outDirs.get(cur);
      for (const [ei, rev, a] of od) {
        let d = mod(a - back, TAU); if (d < 1e-6) d = TAU;
        if (path.length && ei === path[path.length - 1][0] && od.length > 1) continue;
        if (best === null || d < best[0]) best = [d, ei, rev];
      }
      if (!best) break;
      const [, ei, rev] = best;
      if (first !== null && first[0] === ei && first[1] === rev && cur === start) return path.map(([i, r]) => [this.E[i], r]);
      if (first === null) first = [ei, rev];
      path.push([ei, rev]);
      const e = this.E[ei]; const poly = rev ? [...e.poly].reverse() : e.poly;
      cur = rev ? e.u : e.v;
      back = Graph.dir([...poly].reverse());
    }
    throw new ReconError('Die Außenkontur einer Ansicht konnte nicht geschlossen verfolgt werden (offene oder überlappende Linien).');
  }
}

export function loopBbox(loop) {
  const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const [e] of loop) for (const q of e.poly) { lo[0] = Math.min(lo[0], q[0]); lo[1] = Math.min(lo[1], q[1]); hi[0] = Math.max(hi[0], q[0]); hi[1] = Math.max(hi[1], q[1]); }
  return [lo, hi];
}
export function loopArea(loop) {
  const pts = []; for (const [e, r] of loop) pts.push(...(r ? [...e.poly].reverse() : e.poly));
  let s = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - a[1] * b[0]; }
  return Math.abs(s) / 2;
}

/** Schleife -> Liste von Konturelementen [{k:'line'|'arc'|'spline', pts:[[x,y],...]}] (2D, Blatt). */
export function loopItems(loop) {
  const items = [];
  for (const [e, rev] of loop) {
    const p = e.prim;
    const poly = (rev ? [...e.poly].reverse() : e.poly).map(q => q.slice());
    poly[0] = e.V[rev ? e.v : e.u].slice(); poly[poly.length - 1] = e.V[rev ? e.u : e.v].slice();
    if (p.kind === 'line') {
      const a = poly[0], b = poly[poly.length - 1];
      const last = items[items.length - 1];
      if (last && last.k === 'line') {
        const [pa, pb] = last.pts; const d1 = sub(pb, pa), d2 = sub(b, a);
        if (Math.abs(cross2(d1, d2)) < 1e-6 * norm(d1) * norm(d2) && dot(d1, d2) > 0) { last.pts = [pa, b]; continue; }
      }
      items.push({ k: 'line', pts: [a, b] });
    } else if (p.kind === 'arc') {
      items.push({ k: 'arc', pts: [poly[0], poly[Math.floor(poly.length / 2)], poly[poly.length - 1]] });
    } else {
      const last = items[items.length - 1];
      if (last && last.k === 'spline') last.pts = last.pts.concat(poly.slice(1));
      else items.push({ k: 'spline', pts: poly });
    }
  }
  return items;
}
