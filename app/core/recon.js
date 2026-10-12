// Zeichnung -> 3D-B-Rep (Port von backend/recon.py) mit replicad/OpenCascade (WASM).
import { prim, Graph, ReconError, loopItems, loopBbox, loopArea, bbox, sample, dist, TOL, p0, p1 } from './geom.js';
import * as Dm from './dims.js';
import * as Ra from './raster.js';

let R = null, oc = null;
export function setLib(replicad, ocInstance) { R = replicad; oc = ocInstance; }

// ---------------------------------------------------------------- Ansichten
export function clusterViews(prims, gap = 3.0, minSize = 4.0) {
  const boxes = prims.map(bbox); const parent = prims.map((_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < prims.length; i++) for (let j = i + 1; j < prims.length; j++) {
    const [a0, a1] = boxes[i], [b0, b1] = boxes[j];
    if (a0[0] - gap <= b1[0] && b0[0] - gap <= a1[0] && a0[1] - gap <= b1[1] && b0[1] - gap <= a1[1]) parent[find(i)] = find(j);
  }
  const groups = new Map(); prims.forEach((_, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); });
  let views = [];
  for (const g of groups.values()) {
    const lo = [Math.min(...g.map(i => boxes[i][0][0])), Math.min(...g.map(i => boxes[i][0][1]))];
    const hi = [Math.max(...g.map(i => boxes[i][1][0])), Math.max(...g.map(i => boxes[i][1][1]))];
    if (Math.max(hi[0] - lo[0], hi[1] - lo[1]) < minSize) continue;
    views.push({ prims: g.map(i => prims[i]), lo, hi });
  }
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (const a of views) for (const b of views) {
      if (a !== b && a.lo[0] >= b.lo[0] - 0.01 && a.lo[1] >= b.lo[1] - 0.01 && a.hi[0] <= b.hi[0] + 0.01 && a.hi[1] <= b.hi[1] + 0.01) {
        b.prims.push(...a.prims); views = views.filter(v => v !== a); changed = true; break outer;
      }
    }
  }
  views.forEach(refresh);
  views.sort((a, b) => -a.c[1] + b.c[1] || a.c[0] - b.c[0]);
  return views;
}
export function refresh(v) {
  const bb = v.prims.map(bbox);
  v.lo = [Math.min(...bb.map(b => b[0][0])), Math.min(...bb.map(b => b[0][1]))];
  v.hi = [Math.max(...bb.map(b => b[1][0])), Math.max(...bb.map(b => b[1][1]))];
  v.c = [(v.lo[0] + v.hi[0]) / 2, (v.lo[1] + v.hi[1]) / 2]; v.size = [v.hi[0] - v.lo[0], v.hi[1] - v.lo[1]];
}
function assignHidden(views, hidden) {
  for (const v of views) v.hidden = [];
  for (const p of hidden) {
    const [lo, hi] = bbox(p);
    for (const v of views) if (lo[0] >= v.lo[0] - 1 && lo[1] >= v.lo[1] - 1 && hi[0] <= v.hi[0] + 1 && hi[1] <= v.hi[1] + 1) { v.hidden.push(p); break; }
  }
}

// ---------------------------------------------------------------- Anordnung
function findCircleView(views) {
  let best = null;
  views.forEach((v, i) => {
    const circles = v.prims.filter(p => p.kind === 'circle'); if (circles.length < 2) return;
    const conc = circles.filter(c => dist(c.center, v.c) < 0.6); if (conc.length < 2) return;
    const rmax = Math.max(...conc.map(c => c.r));
    if (Math.abs(2 * rmax - v.size[0]) < 1.2 && Math.abs(2 * rmax - v.size[1]) < 1.2) if (!best || circles.length > best[1]) best = [i, circles.length];
  });
  return best ? best[0] : null;
}
function neighbors(views, i, tol = 2.0) {
  const v = views[i]; const out = [];
  views.forEach((w, j) => {
    if (j === i) return;
    const row = Math.abs(w.c[1] - v.c[1]) < tol || (Math.abs(w.lo[1] - v.lo[1]) < tol && Math.abs(w.hi[1] - v.hi[1]) < tol) || Math.abs(w.lo[1] - v.lo[1]) < tol;
    const col = Math.abs(w.c[0] - v.c[0]) < tol || (Math.abs(w.lo[0] - v.lo[0]) < tol && Math.abs(w.hi[0] - v.hi[0]) < tol) || Math.abs(w.lo[0] - v.lo[0]) < tol;
    if (row || col) out.push([dist(w.c, v.c), row ? 'zeile' : 'spalte', j]);
  });
  return out.sort((a, b) => a[0] - b[0]);
}
function detectLayout(views) {
  const ci = findCircleView(views);
  if (ci != null) {
    const nb = neighbors(views, ci);
    if (!nb.length) throw new ReconError('Drehteil erkannt (konzentrische Kreise), aber keine zugeordnete Profilansicht gefunden.');
    const [, rel, pi] = nb[0]; const C = views[ci], P = views[pi];
    if (rel !== 'zeile') throw new ReconError('Drehteil mit senkrechter Achse wird nicht unterstützt (Profil- und Kreisansicht müssen nebeneinander liegen).');
    const ay = C.c[1];
    return { typ: 'dreh', profil: pi, kreis: ci, achse_y: ay, maps: { [pi]: { x: ['X', P.lo[0], 1], y: ['R', ay, 1] }, [ci]: { x: ['Q', C.c[0], 1], y: ['R', ay, 1] } } };
  }
  if (views.length === 1) return { typ: 'prisma', F: null, T: 0, S: null, maps: { 0: { x: ['X', views[0].lo[0], 1], y: ['Y', views[0].lo[1], 1] } } };
  let best = null; const meanY = views.reduce((s, w) => s + w.c[1], 0) / views.length;
  views.forEach((v, i) => {
    const nb = neighbors(views, i);
    const below = nb.filter(([, r, j]) => r === 'spalte' && views[j].c[1] < v.c[1]).map(x => x[2]);
    const side = nb.filter(([, r]) => r === 'zeile').map(x => x[2]);
    const score = (below.length ? 1 : 0) + (side.length ? 1 : 0) + (v.c[1] > meanY ? 0.1 : 0);
    if (!best || score > best[0]) best = [score, i, below, side];
  });
  const [, F, below, side] = best;
  const T = below.length ? below[0] : null, S = side.length ? side[0] : null;
  if (T == null && S == null) {
    let k = 0, kb = -1; views.forEach((w, i) => { const c = w.prims.filter(p => p.kind !== 'line').length; if (c > kb) { kb = c; k = i; } });
    return { typ: 'prisma', F: null, T: k, S: null, maps: { [k]: { x: ['X', views[k].lo[0], 1], y: ['Y', views[k].lo[1], 1] } } };
  }
  const Fv = views[F];
  const X0 = Math.min(...[F, T].filter(i => i != null).map(i => views[i].lo[0]));
  const Z0 = Math.min(...[F, S].filter(i => i != null).map(i => views[i].lo[1]));
  const maps = { [F]: { x: ['X', X0, 1], y: ['Z', Z0, 1] } };
  if (T != null) maps[T] = { x: ['X', X0, 1], y: ['Y', views[T].lo[1], 1] };
  if (S != null) { const Sv = views[S]; maps[S] = { x: Sv.c[0] > Fv.c[0] ? ['Y', Sv.hi[0], -1] : ['Y', Sv.lo[0], 1], y: ['Z', Z0, 1] }; }
  return { typ: 'prisma', F, T, S, maps };
}

// ---------------------------------------------------------------- CAD-Helfer
const V3 = a => [+a[0], +a[1], +a[2]];
function wireFromItems(items, f) {
  const edges = [];
  for (const it of items) {
    const P = it.pts.map(q => V3(f(q)));
    if (it.k === 'line') edges.push(R.makeLine(P[0], P[1]));
    else if (it.k === 'arc') edges.push(R.makeThreePointArc(P[0], P[1], P[2]));
    else {
      const m = Math.min(P.length, 25); const idx = [...new Set(Array.from({ length: m }, (_, i) => Math.round(i * (P.length - 1) / (m - 1))))];
      edges.push(R.makeBSplineApproximation(idx.map(i => P[i]), { tolerance: 0.05, degMax: 3, degMin: 2, smoothing: null }));
    }
  }
  const w = R.assembleWire(edges);
  if (!w.isClosed) throw new ReconError('Kontur ist nicht geschlossen.');
  return w;
}
const kindsOf = items => items.map(i => i.k);
const count = (a, k) => a.filter(x => x === k).length;
function onlySolid(sh) { const s = sh.solids || []; return s.length === 1 ? s[0] : sh; }
const vol = s => R.measureVolume(s);

// ---------------------------------------------------------------- Rekonstruktion
function viewLoops(view, tol) {
  const g = new Graph(view.prims, tol); const loops = [];
  for (const c of g.components()) {
    let lp; try { lp = g.outerWalk(c); } catch (e) { continue; }
    const [lo, hi] = loopBbox(lp); loops.push({ loop: lp, lo, hi, area: loopArea(lp) });
  }
  loops.sort((a, b) => b.area - a.area);
  const circles = view.prims.filter(p => p.kind === 'circle');
  if (!loops.length && !circles.length) throw new ReconError('Keine geschlossene Kontur in einer Ansicht gefunden.');
  return [loops, circles];
}
function pmap(ctx, vi) {
  const mx = ctx.amap(vi, 'x'), my = ctx.amap(vi, 'y');
  return p => ({ [mx[0]]: (p[0] - mx[1]) * mx[2] / ctx.s, [my[0]]: (p[1] - my[1]) * my[2] / ctx.s });
}
function clipUpper(prims, yaxis, tol) {
  const out = [];
  for (let p of prims) {
    if (p.kind === 'line') {
      const [[x0, y0], [x1, y1]] = p.pts;
      if (y0 < yaxis - tol && y1 < yaxis - tol) continue;
      if (Math.abs(y0 - yaxis) < tol && Math.abs(y1 - yaxis) < tol) continue;
      if ((y0 - yaxis) * (y1 - yaxis) < 0) { const t = (yaxis - y0) / (y1 - y0), xm = x0 + t * (x1 - x0); p = prim('line', { pts: y1 > yaxis ? [[xm, yaxis], [x1, y1]] : [[x0, y0], [xm, yaxis]] }); }
      else if (Math.abs(y0 - yaxis) < tol) p = prim('line', { pts: [[x0, yaxis], [x1, y1]] });
      else if (Math.abs(y1 - yaxis) < tol) p = prim('line', { pts: [[x0, y0], [x1, yaxis]] });
      out.push(p);
    } else if (p.kind === 'circle') continue;
    else if (Math.min(...sample(p, 8).map(q => q[1])) >= yaxis - tol) out.push(p);
  }
  return out;
}

function reconstructRevolve(ctx) {
  const L = ctx.layout, s = ctx.s; const P = ctx.views[L.profil], C = ctx.views[L.kreis]; const ay = L.achse_y;
  const up = clipUpper(P.prims, ay, ctx.tol);
  const xs = up.flatMap(p => [p0(p)[0], p1(p)[0]]);
  if (!xs.length) throw new ReconError('Profilkontur des Drehteils nicht gefunden.');
  up.push(prim('line', { pts: [[Math.min(...xs), ay], [Math.max(...xs), ay]] }));
  const g = new Graph(up, ctx.tol); const comps = g.components();
  if (!comps.length) throw new ReconError('Profilkontur des Drehteils nicht geschlossen.');
  const loop = g.outerWalk(comps.reduce((a, b) => b.length > a.length ? b : a));
  const x0 = P.lo[0]; const f = p => [(p[0] - x0) / s, (p[1] - ay) / s, 0];
  const items = loopItems(loop); const kinds = kindsOf(items);
  const hf = R.makeFace(wireFromItems(items, f));
  const Lx = (P.hi[0] - x0) / s, Rmax = (P.hi[1] - ay) / s;
  let solid = onlySolid(R.revolution(hf, [0, 0, 0], [1, 0, 0], 360));
  const rv = items.flatMap(it => [it.pts[0], it.pts[it.pts.length - 1]]).map(q => Math.abs((q[1] - ay) / s)).filter(r => r > 0.05);
  const rmin = rv.length ? Math.min(...rv) : 0;
  L.profil_radien = [...new Set(rv.map(r => Math.round(r * 1000) / 1000))].sort((a, b) => a - b);
  const feats = [{ typ: 'Drehung', text: `Rotationsprofil aus ${kinds.length} Konturelementen (${count(kinds, 'line')} Geraden, ${count(kinds, 'arc')} Bögen, ${count(kinds, 'spline')} Splines), Länge ${Lx.toFixed(2)} mm, Ø max ${(2 * Rmax).toFixed(2)} mm` }];
  const conc = C.prims.filter(c => c.kind === 'circle' && dist(c.center, C.c) < 0.6);
  const inner = conc.filter(c => c.r / s < rmin - 0.05);
  if (inner.length) {
    const rb = Math.max(...inner.map(c => c.r)) / s;
    solid = onlySolid(solid.cut(R.makeCylinder(rb, Lx + 2, [-1, 0, 0], [1, 0, 0])));
    feats.push({ typ: 'Bohrung', text: `Zentrische Durchgangsbohrung Ø${(2 * rb).toFixed(2)} mm` });
  }
  const off = C.prims.filter(c => c.kind === 'circle' && dist(c.center, C.c) >= 0.6);
  for (const c of off) {
    const du = (c.center[0] - C.c[0]) / s, dv = (c.center[1] - C.c[1]) / s;
    let rng = null;
    for (const h of P.hidden) {
      if (h.kind === 'line' && Math.abs(h.pts[0][1] - h.pts[1][1]) < 0.05) {
        const y = (h.pts[0][1] - ay) / s;
        if (Math.abs(Math.abs(y) - (Math.abs(dv) + c.r / s)) < 0.1 || Math.abs(Math.abs(y) - (Math.abs(dv) - c.r / s)) < 0.1) {
          const xx = [(h.pts[0][0] - x0) / s, (h.pts[1][0] - x0) / s].sort((a, b) => a - b);
          rng = rng ? [Math.min(rng[0], xx[0]), Math.max(rng[1], xx[1])] : xx;
        }
      }
    }
    const [a, b] = rng ? [rng[0] - (rng[0] < 0.1 ? 1 : 0), rng[1] + (rng[1] > Lx - 0.1 ? 1 : 0)] : [-1, Lx + 1];
    solid = onlySolid(solid.cut(R.makeCylinder(c.r / s, b - a, [a, du, dv], [1, 0, 0])));
  }
  if (off.length) {
    const rs = [...new Set(off.map(c => +(2 * c.r / s).toFixed(2)))].sort((a, b) => a - b);
    const pcd = [...new Set(off.map(c => +(2 * dist(c.center, C.c) / s).toFixed(2)))].sort((a, b) => a - b);
    feats.push({ typ: 'Bohrungsmuster', text: `${off.length} achsparallele Bohrungen Ø${rs.join('/')} mm auf Teilkreis Ø${pcd.join('/')} mm` });
  }
  return [solid, feats];
}

function depthRange(ctx, vi, lo, hi, dirAxis, silRange) {
  const s = ctx.s; const mView = ctx.layout.maps[vi];
  const shared = {}; for (const [ax, lh] of [['x', [lo[0], hi[0]]], ['y', [lo[1], hi[1]]]]) shared[mView[ax][0]] = [ax, lh];
  let rng = null;
  for (const [vjs, mp] of Object.entries(ctx.layout.maps)) {
    const vj = +vjs; if (vj === vi) continue;
    const axes = { [mp.x[0]]: 'x', [mp.y[0]]: 'y' };
    if (!(dirAxis in axes)) continue;
    const dax = axes[dirAxis], dk = dax === 'x' ? 0 : 1;
    const other = Object.keys(axes).find(A => A !== dirAxis);
    if (!(other in shared)) continue;
    const [sax, [plo, phi]] = shared[other];
    const mlo = (plo - mView[sax][1]) * mView[sax][2] / s, mhi = (phi - mView[sax][1]) * mView[sax][2] / s;
    const oax = axes[other], ok = oax === 'x' ? 0 : 1;
    const tgt = [mlo, mhi].map(m => mp[oax][1] + mp[oax][2] * m * s);
    for (const h of ctx.views[vj].hidden) {
      if (h.kind !== 'line') continue;
      if (Math.abs(h.pts[0][ok] - h.pts[1][ok]) > 0.1) continue;
      const c = h.pts[0][ok];
      if (Math.min(...tgt.map(t => Math.abs(c - t))) > 0.3) continue;
      const vals = h.pts.map(q => (q[dk] - mp[dax][1]) * mp[dax][2] / s).sort((a, b) => a - b);
      rng = rng ? [Math.min(rng[0], vals[0]), Math.max(rng[1], vals[1])] : vals;
    }
  }
  if (!rng) return null;
  let [a, b] = rng;
  if (ctx.raster) {
    const cs = [];
    for (const [vjs, mp] of Object.entries(ctx.layout.maps)) for (const [ax2, k2] of [['x', 0], ['y', 1]]) {
      if (mp[ax2][0] !== dirAxis) continue;
      for (const p of ctx.views[+vjs].prims) if (p.kind === 'line') for (const q of p.pts) cs.push((q[k2] - mp[ax2][1]) * mp[ax2][2] / s);
    }
    const loC = cs.filter(c => a - 3.5 <= c && c <= a + 0.3), hiC = cs.filter(c => b - 0.3 <= c && c <= b + 3.5);
    if (loC.length) a = Math.max(...loC); if (hiC.length) b = Math.min(...hiC);
  }
  if (a <= silRange[0] + 0.2) a = silRange[0] - 1;
  if (b >= silRange[1] - 0.2) b = silRange[1] + 1;
  return [a, b];
}

function reconstructPrism(ctx, msgs) {
  const L = ctx.layout; const s = ctx.s;
  const roles = ['F', 'T', 'S'].filter(r => L[r] != null).map(r => [r, L[r]]);
  const ext = {};
  for (const [, vi] of roles) {
    const v = ctx.views[vi], f = pmap(ctx, vi);
    for (const p of [v.lo, v.hi]) for (const [A, val] of Object.entries(f(p))) { const e = ext[A] || [1e9, -1e9]; ext[A] = [Math.min(e[0], val), Math.max(e[1], val)]; }
  }
  if (roles.length === 1) { ext.Z = [0, 10]; msgs.push('WARNUNG: Nur eine Ansicht – Dicke 10 mm angenommen (bitte in der Maßtabelle prüfen).'); }
  const dirs = { F: 'Y', T: 'Z', S: 'X' }; const names = { F: 'Vorderansicht', T: 'Draufsicht', S: 'Seitenansicht' };
  const feats = []; let solid = null; const info = {};
  const to3 = (f, dA, val) => p => { const m = f(p); m[dA] = val; return [m.X, m.Y, m.Z]; };
  const dvec = (dA, L) => dA === 'X' ? [L, 0, 0] : dA === 'Y' ? [0, L, 0] : [0, 0, L];
  for (const [r, vi] of roles) {
    const v = ctx.views[vi]; const [loops, circles] = viewLoops(v, ctx.tol); info[r] = [loops, circles];
    if (!loops.length) continue;
    const dA = dirs[r]; const a = ext[dA][0] - 1, b = ext[dA][1] + 1; const f = pmap(ctx, vi);
    const items = loopItems(loops[0].loop); const kinds = kindsOf(items);
    const w = wireFromItems(items, to3(f, dA, a));
    const pr = R.basicFaceExtrusion(R.makeFace(w), new R.Vector(dvec(dA, b - a)));
    if (globalThis.DBG) console.log('sil', r, dA, a, b, 'vol', vol(pr), JSON.stringify(ext), items.map(i => i.k + ':' + i.pts.map(q => q.map(x => x.toFixed(1)).join(',')).join(' ')).join(' | '));
    solid = solid ? onlySolid(solid.intersect(pr)) : pr;
    if (globalThis.DBG) console.log('  -> vol', vol(solid));
    feats.push({ typ: 'Silhouette', text: `${names[r]}: Umriss mit ${kinds.length} Elementen (${count(kinds, 'line')} Geraden, ${count(kinds, 'arc')} Bögen, ${count(kinds, 'spline')} Splines) entlang ${dA} extrudiert` });
  }
  if (!solid) throw new ReconError('Keine Außenkontur gefunden.');
  if (roles.length > 1) feats.unshift({ typ: 'Verschneidung', text: `Körper als Schnitt der ${roles.length} extrudierten Ansichts-Umrisse` });
  for (const [r, vi] of roles) {
    const [loops, circles] = info[r]; if (!loops.length) continue;
    const outer = loops[0]; const f = pmap(ctx, vi); const dA = dirs[r];
    const inside = (lo, hi) => lo[0] >= outer.lo[0] - TOL && lo[1] >= outer.lo[1] - TOL && hi[0] <= outer.hi[0] + TOL && hi[1] <= outer.hi[1] + TOL;
    const items = loops.slice(1).filter(l => inside(l.lo, l.hi)).map(l => ['schleife', l])
      .concat(circles.filter(c => c.center[0] > outer.lo[0] && c.center[1] > outer.lo[1] && c.center[0] < outer.hi[0] && c.center[1] < outer.hi[1]).map(c => ['kreis', c]));
    for (const [kind, it] of items) {
      let lo, hi;
      if (kind === 'kreis') { lo = [it.center[0] - it.r, it.center[1] - it.r]; hi = [it.center[0] + it.r, it.center[1] + it.r]; }
      else { lo = it.lo; hi = it.hi; }
      const rng = depthRange(ctx, vi, lo, hi, dA, ext[dA]);
      const durch = !rng || (rng[0] < ext[dA][0] && rng[1] > ext[dA][1]);
      const [a, b] = rng || [ext[dA][0] - 1, ext[dA][1] + 1];
      const dir = dvec(dA, 1); let tool, desc;
      if (kind === 'kreis') {
        const m = f(it.center); m[dA] = a;
        tool = R.makeCylinder(it.r / s, b - a, [m.X, m.Y, m.Z], dir); desc = `Bohrung Ø${(2 * it.r / s).toFixed(2)} mm`;
      } else {
        const li = loopItems(it.loop); const k = kindsOf(li);
        tool = R.basicFaceExtrusion(R.makeFace(wireFromItems(li, to3(f, dA, a))), new R.Vector(dvec(dA, b - a)));
        const bb = [(hi[0] - lo[0]) / s, (hi[1] - lo[1]) / s];
        desc = (count(k, 'arc') >= 2 && count(k, 'line') <= 2 ? 'Langloch' : 'Tasche/Durchbruch') + ` ${bb[0].toFixed(1)}×${bb[1].toFixed(1)} mm`;
      }
      const before = vol(solid);
      solid = onlySolid(solid.cut(tool));
      if (before - vol(solid) < 1e-3) continue;
      const tiefe = durch ? 'durchgehend' : `Tiefe ${(b - a - (a < ext[dA][0] ? 1 : 0) - (b > ext[dA][1] ? 1 : 0)).toFixed(2)} mm (aus verdeckten Kanten)`;
      feats.push({ typ: 'Ausschnitt', text: `${desc} in Richtung ${dA}, ${tiefe}` });
    }
  }
  return [solid, feats];
}

// ---------------------------------------------------------------- B-Rep-Analyse
const r3 = v => v.map(x => Math.round(x * 1000) / 1000);
const pnt = p => [p.X(), p.Y(), p.Z()];
function circle3(a, b, c) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  const n2 = n[0] ** 2 + n[1] ** 2 + n[2] ** 2; if (n2 < 1e-18) return null;
  const ab2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2, ac2 = ac[0] ** 2 + ac[1] ** 2 + ac[2] ** 2;
  const t1 = [n[1] * ab[2] - n[2] * ab[1], n[2] * ab[0] - n[0] * ab[2], n[0] * ab[1] - n[1] * ab[0]];
  const t2 = [ac[1] * n[2] - ac[2] * n[1], ac[2] * n[0] - ac[0] * n[2], ac[0] * n[1] - ac[1] * n[0]];
  const o = [0, 1, 2].map(i => (ac2 * t1[i] + ab2 * t2[i]) / (2 * n2));
  const c0 = [a[0] + o[0], a[1] + o[1], a[2] + o[2]]; const nl = Math.sqrt(n2);
  return { c: c0, r: Math.hypot(...o), n: n.map(x => x / nl) };
}
const canonDir = d => { const k = [0, 1, 2].reduce((a, b) => Math.abs(d[b]) > Math.abs(d[a]) ? b : a); return d[k] < 0 ? d.map(x => -x || 0) : d; };

function faceInfo(face) {
  const ad = new oc.BRepAdaptor_Surface(face.wrapped, true); const t = face.geomType; let d;
  try {
    if (t === 'PLANE') { const pl = ad.Plane(); d = { typ: 'Ebene', typ_en: 'plane', punkt: r3(pnt(pl.Location())), normale: r3(pnt(pl.Axis().Direction())) }; }
    else if (t === 'CYLINDER' || t === 'CYLINDRE') { const c = ad.Cylinder(); d = { typ: 'Zylinder', typ_en: 'cylinder', radius: +c.Radius().toFixed(3), achse: r3(pnt(c.Axis().Direction())), punkt: r3(pnt(c.Location())) }; }
    else if (t === 'CONE') {
      const u0 = ad.FirstUParameter();
      const at = (u, v) => pnt(ad.Value(u, v));
      const A = circle3(at(u0, 0), at(u0 + 2, 0), at(u0 + 4, 0)), B = circle3(at(u0, 1), at(u0 + 2, 1), at(u0 + 4, 1));
      const ax = [B.c[0] - A.c[0], B.c[1] - A.c[1], B.c[2] - A.c[2]]; const h = Math.hypot(...ax);
      const alpha = Math.atan2(B.r - A.r, h); const dir = ax.map(x => x / h);
      const apex = A.c.map((x, i) => x - dir[i] * A.r / Math.tan(alpha));
      d = { typ: 'Kegel', typ_en: 'cone', ref_radius: +A.r.toFixed(3), halbwinkel_grad: +Math.abs(alpha * 180 / Math.PI).toFixed(3), achse: r3(canonDir(dir)), spitze: r3(apex) };
    } else if (t === 'TORUS') {
      const u0 = ad.FirstUParameter(); const at = (u, v) => pnt(ad.Value(u, v));
      const A = circle3(at(u0, 0), at(u0 + 2, 0), at(u0 + 4, 0)), B = circle3(at(u0, Math.PI), at(u0 + 2, Math.PI), at(u0 + 4, Math.PI));
      d = { typ: 'Torus', typ_en: 'torus', R: +((A.r + B.r) / 2).toFixed(3), r: +(Math.abs(A.r - B.r) / 2).toFixed(3), achse: r3(canonDir(A.n)), zentrum: r3(A.c) };
    } else if (t === 'SPHERE') { d = { typ: 'Kugel', typ_en: 'sphere', radius: +ad.Sphere().Radius().toFixed(3) }; }
    else if (t === 'BSPLINE_SURFACE' || t === 'BEZIER_SURFACE') d = { typ: 'B-Spline-Fläche', typ_en: 'bspline', grad_u: ad.UDegree(), grad_v: ad.VDegree(), pole: `${ad.NbUPoles()}x${ad.NbVPoles()}` };
    else if (t === 'EXTRUSION_SURFACE' || t === 'EXTRUSION') {
      const bc = ad.BasisCurve(); const isB = bc.GetType() === oc.GeomAbs_CurveType.GeomAbs_BSplineCurve;
      d = { typ: isB ? 'Extrusionsfläche (B-Spline)' : 'Extrusionsfläche', typ_en: 'extrusion', richtung: r3(pnt(ad.Direction())) };
      if (isB) { d.grad = bc.Degree(); d.pole = bc.NbPoles(); }
    } else if (t === 'REVOLUTION_SURFACE' || t === 'REVOLUTION') d = { typ: 'Rotationsfläche', typ_en: 'revolution' };
    else d = { typ: 'sonstige', typ_en: 'other' };
  } catch (e) { d = { typ: 'sonstige', typ_en: 'other', fehler: 'Parameter nicht lesbar (' + t + ')' }; if (globalThis.DBG) console.log('faceInfo', t, e); } finally { ad.delete(); }
  d.flaeche_mm2 = +R.measureArea(face).toFixed(2);
  const c = face.center; d.zentrum_flaeche = r3([c.x, c.y, c.z]);
  return d;
}
function edgeInfo(edge) {
  const ad = new oc.BRepAdaptor_Curve(edge.wrapped); const t = edge.geomType; let d;
  try {
    if (t === 'LINE') d = { typ: 'Gerade', typ_en: 'line' };
    else if (t === 'CIRCLE') { const c = ad.Circle(); d = { typ: edge.isClosed ? 'Kreis' : 'Kreisbogen', typ_en: 'circle', radius: +c.Radius().toFixed(3), zentrum: r3(pnt(c.Location())), achse: r3(pnt(c.Axis().Direction())) }; }
    else if (t === 'ELLIPSE') { const c = ad.Ellipse(); d = { typ: 'Ellipse', typ_en: 'ellipse', a: +c.MajorRadius().toFixed(3), b: +c.MinorRadius().toFixed(3) }; }
    else if (t === 'BSPLINE_CURVE' || t === 'BEZIER_CURVE') d = { typ: 'B-Spline-Kurve', typ_en: 'bspline', grad: ad.Degree(), pole: ad.NbPoles() };
    else d = { typ: 'sonstige', typ_en: 'other' };
  } catch (e) { d = { typ: 'sonstige', typ_en: 'other' }; if (globalThis.DBG) console.log('edgeInfo', t, e); } finally { ad.delete(); }
  d.laenge_mm = +edge.length.toFixed(3);
  return d;
}
function hash8(str) {
  let h1 = 0x811c9dc5, h2 = 0x12345678;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 2246822519) ^ (h2 >>> 13); }
  return (((h1 >>> 0) ^ (h2 >>> 0)) >>> 0).toString(16).padStart(8, '0');
}
function stableId(prefix, info, extra = '') {
  const keys = Object.keys(info).filter(k => k !== 'flaeche_mm2' && k !== 'laenge_mm').sort();
  return prefix + hash8(prefix + '|' + keys.map(k => `${k}=${JSON.stringify(info[k])}`).join('|') + extra);
}

export function analyse(solid) {
  const faces = [], edges = []; const seen = new Set();
  const dbg = (n, f) => { try { return f(); } catch (e) { if (globalThis.DBG) console.log('analyse FAIL', n); throw e; } };
  const bbx = dbg('bbox', () => solid.boundingBox.bounds); const dg = Math.hypot(bbx[1][0] - bbx[0][0], bbx[1][1] - bbx[0][1], bbx[1][2] - bbx[0][2]);
  const mtol = Math.min(0.5, Math.max(0.02, dg / 2000));
  const m = dbg('mesh', () => solid.mesh({ tolerance: mtol, angularTolerance: 0.25 }));
  const fl = solid.faces;
  fl.forEach((f, i) => {
    const info = dbg('face' + i, () => faceInfo(f)); let sid = stableId('F', info); while (seen.has(sid)) sid += 'b'; seen.add(sid);
    faces.push({ id: i, sid, ...info });
  });
  // Dreiecke je Fläche
  m.faceGroups.forEach((g, gi) => { const F = faces[gi]; if (F) { F.tri = [g.start, g.count]; } });
  const em = dbg('medges', () => solid.meshEdges({ tolerance: mtol, angularTolerance: 0.25 }));
  solid.edges.forEach((e, i) => {
    const info = dbg('edge' + i, () => edgeInfo(e)); const mid = dbg('pointAt' + i, () => e.pointAt(0.5)); const midA = r3([mid.x, mid.y, mid.z]);
    let sid = stableId('K', info, JSON.stringify(midA)); while (seen.has(sid)) sid += 'b'; seen.add(sid);
    const n = info.typ_en === 'line' ? 2 : 48; const p = [];
    for (let k = 0; k < n; k++) { const q = e.pointAt(k / (n - 1)); p.push(+q.x.toFixed(4), +q.y.toFixed(4), +q.z.toFixed(4)); }
    edges.push({ id: i, sid, p, mitte: midA, ...info });
  });
  return { faces, edges, mesh: { vertices: Float32Array.from(m.vertices), normals: Float32Array.from(m.normals), triangles: Uint32Array.from(m.triangles), groups: m.faceGroups }, edgeMesh: em };
}

const AX = { X: 0, Y: 1, Z: 2 };
function pmiItems(dims, faces, bboxC, diag) {
  const items = [];
  const planesAt = (A, val) => { const k = AX[A]; return faces.filter(f => f.typ_en === 'plane' && Math.abs(Math.abs(f.normale[k]) - 1) < 1e-3 && Math.abs(f.punkt[k] - val) < 0.05); };
  const cylAxisAt = (A, val) => { const k = AX[A]; return faces.filter(f => f.typ_en === 'cylinder' && Math.abs(f.achse[k]) < 1e-3 && Math.abs(f.punkt[k] - val) < 0.05); };
  for (const d of dims) {
    const a = d.anker;
    if (!a || (a.art === 'info' && !['tiefe', 'tasche', 'winkel'].includes(d.typ))) continue;
    let refs = [], typ = null, note = '';
    if (a.art === 'linear') {
      const A = a.achse in AX ? a.achse : null; if (!A) continue;
      for (const val of [a.m0, a.m1]) {
        const ps = planesAt(A, val);
        if (ps.length) refs.push(ps.map(p => p.sid));
        else { const cs = cylAxisAt(A, val); if (cs.length) { refs.push(cs.map(c => c.sid)); note = 'Bezug auf Bohrungsachse'; } }
      }
      typ = 'Abstand';
    } else if (a.art === 'kreis' || a.art === 'radial') { const cs = faces.filter(f => f.typ_en === 'cylinder' && Math.abs(f.radius - d.wert / 2) < 0.05); refs = cs.length ? [cs.map(c => c.sid)] : []; typ = 'Durchmesser'; }
    else if (a.art === 'bogen') { const cs = faces.filter(f => (f.typ_en === 'torus' && Math.abs(f.r - d.wert) < 0.05) || (f.typ_en === 'cylinder' && Math.abs(f.radius - d.wert) < 0.05)); refs = cs.length ? [cs.map(c => c.sid)] : []; typ = 'Radius'; }
    else if (a.art === 'teilkreis') { const cs = faces.filter(f => f.typ_en === 'cylinder' && Math.abs(Math.hypot(f.punkt[1], f.punkt[2]) - d.wert / 2) < 0.05); refs = cs.length ? [cs.map(c => c.sid)] : []; typ = 'Teilkreis (Lagemaß)'; }
    else if (a.art === 'fase') { const cs = faces.filter(f => f.typ_en === 'cone' && Math.abs(f.halbwinkel_grad - 45) < 0.5); refs = cs.length ? [cs.map(c => c.sid)] : []; typ = 'Fase'; }
    else if (d.typ === 'tiefe') {
      typ = 'Tiefe';
      outer: for (const f of faces) if (f.typ_en === 'plane') for (const g of faces) if (g.typ_en === 'cylinder' && Math.abs(Math.PI * g.radius ** 2 - f.flaeche_mm2) < 0.02 * f.flaeche_mm2) { refs = [[g.sid], [f.sid]]; break outer; }
    } else if (d.typ === 'tasche') { const A = d.wert * (d.wert2 || 0); const ps = faces.filter(f => f.typ_en === 'plane' && Math.abs(f.flaeche_mm2 - A) < 0.02 * d.wert * (d.wert2 || 1)); refs = ps.length ? [ps.map(p => p.sid)] : []; typ = 'Tasche (Größe)'; }
    else if (d.typ === 'winkel') { const cs = faces.filter(f => f.typ_en === 'cone' && (Math.abs(f.halbwinkel_grad - d.wert) < 0.5 || Math.abs(2 * f.halbwinkel_grad - d.wert) < 0.5)); refs = cs.length ? [cs.map(c => c.sid)] : []; typ = 'Winkel'; }
    else continue;
    const ids = refs.flat(); if (!ids.length) continue;
    const cents = faces.filter(f => ids.includes(f.sid)).map(f => f.zentrum_flaeche);
    const m = [0, 1, 2].map(k => cents.reduce((s, c) => s + c[k], 0) / cents.length);
    let dv = m.map((x, k) => x - bboxC[k]); let n = Math.hypot(...dv); if (n < 1e-6) { dv = [0, 0, 1]; n = 1; }
    const label = m.map((x, k) => x + dv[k] / n * 0.28 * diag + (k === 2 ? 0.04 * diag : 0));
    items.push({ id: 'PMI-' + d.id, masz: d.id, typ, nennmass: d.wert, einheit: typ === 'Winkel' ? '°' : 'mm', tol_oben: d.tol_o ?? null, tol_unten: d.tol_u ?? null,
      passung: d.passung ?? null, text: d.text, bezuege: refs.map((g, i) => ({ rolle: `Element ${i + 1}`, flaechen: g })), hinweis: note, anker_3d: r3(m), label_3d: r3(label) });
  }
  return items;
}

// ---------------------------------------------------------------- STEP
export function stepText(solid, schema = 'AP214IS') {
  const ok = oc.Interface_Static.SetCVal('write.step.schema', schema);
  oc.Interface_Static.SetCVal('write.step.unit', 'MM');
  const w = new oc.STEPControl_Writer(); const pr = new oc.Message_ProgressRange();
  w.Transfer(solid.wrapped, oc.STEPControl_StepModelType.STEPControl_AsIs, true, pr);
  const done = w.Write('/export.step'); w.delete(); pr.delete();
  if (done !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error('STEP-Schreiben fehlgeschlagen');
  const data = oc.FS.readFile('/export.step', { encoding: 'utf8' }); oc.FS.unlink('/export.step');
  const m = data.replace(/\s+/g, ' ').match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/);
  return { text: data, schema: m ? m[1] : '?', setOk: ok };
}
export function isValid(solid) { const a = new oc.BRepCheck_Analyzer(solid.wrapped, true, false); const v = a.IsValid_2 ? a.IsValid_2() : a.IsValid(); a.delete(); return v; }

// ---------------------------------------------------------------- Hauptfunktion
/** dr: Zwischenformat (Vektor oder Raster); edits: {M1: wert}; Rückgabe: Ergebnis + solid. */
export function processDrawing(dr, edits, log = () => {}) {
  const msgs = [...dr.msgs]; const raster = dr.kind === 'raster';
  if (!dr.thick.length) throw new ReconError('Keine sichtbaren Körperkanten (breite Volllinien) gefunden.');
  const views = clusterViews(dr.thick, raster ? 2.0 : 3.0, raster ? 8.0 : 4.0);
  if (!views.length) throw new ReconError('Keine Ansichten erkannt.');
  assignHidden(views, dr.hidden);
  let s, tol;
  if (raster) {
    const vals = dr.phrases.flatMap(ph => Dm.parsePhrase(ph.text)).filter(sp => sp.typ === 'laenge' || sp.typ === 'durchmesser').map(sp => sp.wert);
    // OCR liest „Ø“ oft als „8“: Variante ohne führende 8 zusätzlich anbieten
    for (const ph of dr.phrases) { const m = ph.text.match(/^8(\d{2,}(?:[.,]\d+)?)$/); if (m) vals.push(Dm.f2(m[1])); }
    let src; [s, src] = Ra.voteScale(dr, views, vals);
    Ra.snapGeometry(views, s, vals); views.forEach(refresh);
    msgs.push(`Maßstab: ${src}`); tol = 0.15;
  } else { s = dr.scale; tol = TOL; msgs.push(`Maßstab ${Ra.fmtScale(s)} (${dr.scale_src})`); }
  const layout = detectLayout(views);
  const ctx = new Dm.Ctx(views, layout, s); ctx.tol = tol; ctx.raster = raster;
  if (layout.typ === 'dreh') {
    const P = views[layout.profil]; const set = new Set();
    for (const p of P.prims) if (p.kind === 'line' || p.kind === 'arc') for (const q of p.pts) if (Math.abs(q[1] - layout.achse_y) > 0.05) set.add(Math.round(Math.abs(q[1] - layout.achse_y) / s * 1000) / 1000);
    layout.profil_radien = [...set].sort((a, b) => a - b);
  }
  const rollen = {};
  if (layout.typ === 'dreh') { rollen[layout.profil] = 'Profilansicht'; rollen[layout.kreis] = 'Stirnansicht (Kreise)'; }
  else for (const [r, n] of [['F', 'Vorderansicht'], ['T', 'Draufsicht'], ['S', 'Seitenansicht']]) if (layout[r] != null) rollen[layout[r]] = n;
  msgs.push(`${views.length} Ansicht(en): ` + Object.values(rollen).join(', '));
  const dims = Dm.associate(dr, ctx);
  let aend = [];
  if (edits && Object.keys(edits).length) { aend = Dm.applyEdits(ctx, dims, edits); views.forEach(refresh); }
  log('Volumenmodell (OpenCascade) …');
  let solid, feats, strategy;
  if (layout.typ === 'dreh') { [solid, feats] = reconstructRevolve(ctx); strategy = 'Drehteil (Rotation des Profils)'; }
  else {
    [solid, feats] = reconstructPrism(ctx, msgs);
    strategy = 'Prismatisches Teil (' + (['F', 'T', 'S'].filter(r => layout[r] != null).length > 1 ? 'Verschneidung mehrerer Ansichten' : 'Extrusion') + ')';
  }
  if (globalThis.DBG) console.log('vor simplify', solid.constructor.name, vol(solid), isValid(solid), solid.faces.length);
  try { solid = solid.simplify(); } catch (e) { /* ignorieren */ }
  if (globalThis.DBG) console.log('nach simplify', solid.constructor.name, vol(solid), isValid(solid), solid.faces.length);
  const gueltig = isValid(solid);
  if (!gueltig) msgs.push('WARNUNG: Das B-Rep ist laut OpenCASCADE nicht gültig.');
  log('B-Rep-Analyse …');
  const an = analyse(solid);
  const bb = solid.boundingBox.bounds; const [x0, y0, z0] = bb[0], [x1, y1, z1] = bb[1];
  const bbc = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]; const diag = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
  const pmi = pmiItems(dims, an.faces, bbc, diag);
  const stats = {}, estats = {};
  for (const f of an.faces) stats[f.typ] = (stats[f.typ] || 0) + 1;
  for (const e of an.edges) estats[e.typ] = (estats[e.typ] || 0) + 1;
  const viewBoxes = views.map((v, i) => ({ lo: r3(v.lo), hi: r3(v.hi), rolle: rollen[i] || '' }));
  for (const d of dims) { delete d.linie; delete d.spitze; if (d.anker) for (const k in d.anker) if (typeof d.anker[k] === 'number') d.anker[k] = Math.round(d.anker[k] * 1000) / 1000; }
  return {
    solid, result: {
      ok: true, quelle: dr.kind, strategie: strategy, meldungen: msgs, aenderungen: aend, merkmale: feats, massstab: s, massstab_schriftfeld: dr.scale_txt ?? null, dpi_bekannt: dr.dpi_known ?? null,
      volumen_mm3: Math.round(vol(solid) * 10) / 10, bbox: r3([x1 - x0, y1 - y0, z1 - z0]), bbox_lo: r3([x0, y0, z0]), gueltig,
      ansichten: viewBoxes, page_w: dr.page_w, page_h: dr.page_h, masse: dims, pmi, flaechen: an.faces, kanten: an.edges,
      flaechen_statistik: stats, kanten_statistik: estats,
    }, mesh: an.mesh, edgeMesh: an.edgeMesh,
  };
}
