// Zeichnung -> 3D-B-Rep (Port von backend/recon.py) mit replicad/OpenCascade (WASM).
import { prim, Graph, ReconError, loopItems, loopBbox, loopArea, bbox, sample, dist, TOL, p0, p1 } from './geom.js';
import * as Dm from './dims.js';
import * as Ra from './raster.js';
import * as Sx from './sections.js';

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
export function detectLayout(views) {
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
      // Raster-Splines: Rücksprünge/Zacken (Hinweislinien an der Kontur) entfernen, sonst entstehen ungültige Flächen
      for (let pass = 0; pass < 3; pass++) for (let i = 1; i + 1 < P.length; i++) {
        const a = [0, 1, 2].map(k => P[i][k] - P[i - 1][k]), b = [0, 1, 2].map(k => P[i + 1][k] - P[i][k]);
        const la = Math.hypot(...a), lb = Math.hypot(...b);
        if (la < 1e-6 || lb < 1e-6 || (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb) < -0.2) { P.splice(i, 1); i--; }
      }
      if (P.length < 3) { edges.push(R.makeLine(P[0], P[P.length - 1])); continue; }
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

function revolveSectionRegions(ctx, sec) {
  // Raster: schraffierte Flächen direkt als Pixelgebiete (inkl. Innenkontur: Bohrung, Rillen, Senkung, Radien)
  const L = ctx.layout, s = ctx.s; const P = ctx.views[L.profil]; const ay = L.achse_y;
  const up = sec.regions.filter(r => (r.lo[1] + r.hi[1]) / 2 > ay), dn = sec.regions.filter(r => (r.lo[1] + r.hi[1]) / 2 < ay);
  const flip = dn.reduce((a, r) => a + r.area, 0) > up.reduce((a, r) => a + r.area, 0) * 1.05;
  const use = flip ? dn : up; if (!use.length) return null;
  const fy = q => [q[0], flip ? 2 * ay - q[1] : q[1]];
  // Maßzahlen vor Pixelmaß: Radien auf bemaßte Ø/2 und die Länge auf die Profillänge der Hauptansicht ziehen
  const rDim = [...new Set((ctx.phrases || []).flatMap(ph => { try { return Dm.parsePhrase(ph.text); } catch (e) { return []; } }).filter(sp => sp.typ === 'durchmesser').map(sp => sp.wert / 2))];
  const xs = use.flatMap(r => r.prims.flatMap(p => sample(p, 4).map(q => q[0]))); const xa = Math.min(...xs), xb = Math.max(...xs);
  const Lp = ctx.views[ctx.layoutMain ? ctx.layoutMain.profil : L.profil].size[0] / s;
  const kx = Lp > 0 && Math.abs((xb - xa) / s / Lp - 1) < 0.03 ? Lp / ((xb - xa) / s) : 1;
  const snapR = r => { let b = r, bd = 0.12; for (const q of rDim) if (Math.abs(q - r) < bd) { bd = Math.abs(q - r); b = q; } return b; };
  // Länge auf Profillänge: Differenz symmetrisch auf beide Enden verteilen (Endkanten im Raster gleich unsicher)
  const dx = kx !== 1 ? (Lp - (xb - xa) / s) / 2 : 0;
  const x0 = xa; const f = p => [(p[0] - x0) / s + dx, snapR(Math.max(0, (p[1] - ay) / s)), 0];
  let solid = null; const kinds = [], rv = [], faces = [];
  for (const r of use) {
    const prims = r.prims.map(p => { const c = JSON.parse(JSON.stringify(p)); if (c.pts) c.pts = c.pts.map(fy); if (c.center) c.center = fy(c.center); if (c.sweep && flip) c.sweep = -c.sweep; if (c.poly) c.poly = c.poly.map(fy); return c; });
    // fitContour liefert eine geordnete geschlossene Kette -> direkt in Kantenfolge wandeln, Stöße schließen
    const items = prims.map(p => {
      if (p.kind === 'line') return { k: 'line', pts: [p.pts[0].slice(), p.pts[1].slice()] };
      const sp = sample(p, 24); if (p.kind === 'arc') return { k: 'arc', pts: [sp[0], sp[Math.floor(sp.length / 2)], sp[sp.length - 1]] };
      return { k: 'spline', pts: sp };
    }).filter(it => dist(it.pts[0], it.pts[it.pts.length - 1]) > 1e-4);
    for (let i = 0; i < items.length; i++) { const pr = items[(i + items.length - 1) % items.length]; items[i].pts[0] = pr.pts[pr.pts.length - 1].slice(); }
    const fc = { items };
    kinds.push(...kindsOf(items));
    for (const it of items) for (const q of [it.pts[0], it.pts[it.pts.length - 1]]) { const rr = Math.abs((q[1] - ay) / s); if (rr > 0.05) rv.push(rr); }
    try {
      const rs = onlySolid(R.revolution(R.makeFace(wireFromItems(items, f)), [0, 0, 0], [1, 0, 0], 360));
      solid = solid ? onlySolid(solid.fuse(rs)) : rs; faces.push(fc);
    } catch (e) { ctx.msgs && ctx.msgs.push('WARNUNG: Schnittfläche nicht rotierbar (' + (e.message || e) + ')'); }
  }
  return solid ? { solid, faces, kinds, rv, flip, regions: true } : null;
}

function revolveSection(ctx, sec) {
  const L = ctx.layout, s = ctx.s; const P = ctx.views[L.profil]; const ay = L.achse_y;
  if (ctx.raster && sec.regions && sec.regions.length) { const r = revolveSectionRegions(ctx, sec); if (r) return r; }
  const below = sec.hatch.filter(([a, b]) => (a[1] + b[1]) / 2 < ay).length, above = sec.hatch.length - below;
  const flip = below > above; const fy = q => [q[0], flip ? 2 * ay - q[1] : q[1]];
  const prims = flip ? P.prims.map(p => { const c = JSON.parse(JSON.stringify(p)); if (c.pts) c.pts = c.pts.map(fy); if (c.center) c.center = fy(c.center); if (c.sweep) c.sweep = -c.sweep; if (c.beziers) c.beziers = c.beziers.map(b => b.map(fy)); if (c.poly) c.poly = c.poly.map(fy); return c; }) : P.prims;
  const hatch = sec.hatch.map(([a, b]) => [fy(a), fy(b)]);
  const up = clipUpper(prims, ay, ctx.tol);
  const xs = up.flatMap(p => [p0(p)[0], p1(p)[0]]);
  up.push(prim('line', { pts: [[Math.min(...xs), ay], [Math.max(...xs), ay]] }));
  const faces = Sx.hatchedFaces(up, hatch, ctx.tol);
  if (!faces.length) return null;
  const x0 = P.lo[0]; const f = p => [(p[0] - x0) / s, (p[1] - ay) / s, 0];
  let solid = null; let nItems = 0; const kinds = []; const rv = [];
  for (const fc of faces) {
    const items = loopItems(fc.loop); nItems += items.length; kinds.push(...kindsOf(items));
    for (const it of items) for (const q of [it.pts[0], it.pts[it.pts.length - 1]]) { const r = Math.abs((q[1] - ay) / s); if (r > 0.05) rv.push(r); }
    const rs = onlySolid(R.revolution(R.makeFace(wireFromItems(items, f)), [0, 0, 0], [1, 0, 0], 360));
    solid = solid ? onlySolid(solid.fuse(rs)) : rs;
  }
  return { solid, faces, kinds, rv, flip };
}

function reconstructRevolve(ctx) {
  const L = ctx.layout, s = ctx.s; const P = ctx.views[L.profil], C = ctx.views[L.kreis]; const ay = L.achse_y;
  let sec = (ctx.sections || []).find(x => x.view === L.profil && (x.hatch.length || (x.regions && x.regions.length)));
  let sctx = ctx;
  if (!sec) {
    // eigenständige Vollschnitt-Ansicht desselben Drehteils (gleiche Größe nach Maßstabsangleich)
    sec = (ctx.sections || []).find(x => (x.hatch.length >= 3 || (x.regions && x.regions.length)) && x.view !== L.kreis && Math.abs(ctx.views[x.view].size[0] / P.size[0] - 1) < 0.04 && Math.abs(ctx.views[x.view].size[1] / P.size[1] - 1) < 0.15);
    if (sec) {
      const S = ctx.views[sec.view];
      // Achse der Schnittansicht: Mittellinie (Ansicht symmetrisch zur Achse)
      let ayS = (S.lo[1] + S.hi[1]) / 2;
      if (sec.regions && sec.regions.length >= 2) { const y0 = Math.min(...sec.regions.map(r => r.lo[1])), y1 = Math.max(...sec.regions.map(r => r.hi[1])); ayS = (y0 + y1) / 2; }
      sctx = Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { layout: Object.assign({}, L, { profil: sec.view, achse_y: ayS }) });
    }
  }
  if (sec) {
    sctx.layoutMain = L; const r = revolveSection(sctx, sec);
    if (r) {
      let solid = r.solid; const kinds = r.kinds;
      const Lx = (P.hi[0] - P.lo[0]) / s, Rmax = (Math.max(P.hi[1] - ay, ay - P.lo[1])) / s;
      const extra = [];
      // Raster: Innenkanten im Schnitt werden nicht vektorisiert -> Bohrung aus Stirnansichtskreis, wenn innerhalb keine Schraffur liegt
      if (ctx.raster && C && !r.regions) {
        const S = sctx.views[sctx.layout.profil], ayS = sctx.layout.achse_y;
        const conc = C.prims.filter(c => c.kind === 'circle' && dist(c.center, C.c) < 0.6 && c.r / s < Rmax * 0.95).sort((a, b) => b.r - a.r);
        for (const c of conc) {
          const rr = c.r;
          const inside = sec.hatch.filter(([a, b]) => Math.max(Math.abs(a[1] - ayS), Math.abs(b[1] - ayS)) < rr * 0.9).length;
          if (inside === 0 && sec.hatch.length >= 4) {
            solid = onlySolid(solid.cut(R.makeCylinder(rr / s, Lx + 2, [-1, 0, 0], [1, 0, 0])));
            extra.push({ typ: 'Bohrung', text: `Zentrische Durchgangsbohrung Ø${(2 * rr / s).toFixed(2)} mm (Stirnansicht; Schnitt ohne Schraffur innerhalb)` });
            break;
          }
        }
      }
      L.profil_radien = [...new Set(r.rv.map(x => Math.round(x * 1000) / 1000))].sort((a, b) => a - b);
      const rin = Math.min(...r.rv);
      const feats = [{ typ: 'Drehung (Schnitt)', text: `${sec.letter ? 'Schnitt ' + sec.letter + '-' + sec.letter : 'Schnittansicht'}: ${r.faces.length} schraffierte Fläche(n) als Rotationsprofil (${kinds.length} Konturelemente: ${count(kinds, 'line')} Geraden, ${count(kinds, 'arc')} Bögen, ${count(kinds, 'spline')} Splines), ${r.flip ? 'untere' : 'obere'} Hälfte, Länge ${Lx.toFixed(2)} mm, Ø max ${(2 * Rmax).toFixed(2)} mm, kleinster Innen-Ø ${(2 * rin).toFixed(2)} mm` }];
      return [solid, feats.concat(extra)];
    }
    ctx.msgs && ctx.msgs.push('WARNUNG: Schnitt erkannt, aber keine geschlossene schraffierte Fläche – Profil ohne Schnittauswertung.');
  }
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
  let inner = conc.filter(c => c.r / s < rmin - 0.05);
  // separate Schnittansicht mit Schraffur innerhalb dieses Radius -> keine Durchgangsbohrung (Sackbohrungen nicht aus dem Raster lesbar)
  const secS = ctx.raster && (ctx.sections || []).filter(x => x.hatch.length >= 3 && x.view !== L.kreis).sort((a, b) => b.hatch.length - a.hatch.length)[0];
  if (secS && inner.length) {
    const S = ctx.views[secS.view], ayS = (S.lo[1] + S.hi[1]) / 2, rb0 = Math.max(...inner.map(c => c.r));
    if (secS.hatch.some(([a, b]) => Math.min(Math.abs(a[1] - ayS), Math.abs(b[1] - ayS)) < rb0 * 0.9 || (a[1] - ayS) * (b[1] - ayS) < 0)) {
      ctx.msgs && ctx.msgs.push(`Zentrischer Kreis Ø${(2 * rb0 / s).toFixed(2)} in der Stirnansicht: laut Schnitt keine Durchgangsbohrung – Sackbohrung/Gewinde nicht modelliert (Tiefe im Rasterbild nicht sicher lesbar).`);
      inner = [];
    }
  }
  if (inner.length) {
    const rb = Math.max(...inner.map(c => c.r)) / s;
    solid = onlySolid(solid.cut(R.makeCylinder(rb, Lx + 2, [-1, 0, 0], [1, 0, 0])));
    feats.push({ typ: 'Bohrung', text: `Zentrische Durchgangsbohrung Ø${(2 * rb).toFixed(2)} mm` });
  }
  const off = C.prims.filter(c => c.kind === 'circle' && dist(c.center, C.c) >= 0.6);
  // Lochkreis vervollständigen, wenn die Zeichnung „x4“/„4x“ angibt und Bohrungen fehlen (z. B. von Text verdeckt)
  let ergaenzt = 0;
  if (off.length >= 2) {
    const r0 = off[0].r, pc = dist(off[0].center, C.c);
    if (off.every(c => Math.abs(c.r / r0 - 1) < 0.05 && Math.abs(dist(c.center, C.c) / pc - 1) < 0.03)) {
      const ns = (ctx.phrases || []).flatMap(ph => [...ph.text.matchAll(/(?:^|\s)(?:[x×]\s?(\d{1,2})|(\d{1,2})\s?[x×])(?=\s|$)/g)].map(m => +(m[1] || m[2])));
      const n = ns.find(n => n > off.length && n <= 12);
      if (n) {
        const step = 2 * Math.PI / n, a0 = Math.atan2(off[0].center[1] - C.c[1], off[0].center[0] - C.c[0]);
        const angs = off.map(c => Math.atan2(c.center[1] - C.c[1], c.center[0] - C.c[0]));
        const fits = angs.every(a => { const q = (a - a0) / step; return Math.abs(q - Math.round(q)) < 0.03; });
        if (fits) for (let k = 0; k < n; k++) {
          const a = a0 + k * step;
          if (!angs.some(b => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 0.1)) { off.push(prim('circle', { center: [C.c[0] + pc * Math.cos(a), C.c[1] + pc * Math.sin(a)], r: r0 })); ergaenzt++; }
        }
      }
    }
  }
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
    feats.push({ typ: 'Bohrungsmuster', text: `${off.length} achsparallele Bohrungen Ø${rs.join('/')} mm auf Teilkreis Ø${pcd.join('/')} mm` + (ergaenzt ? ` (${ergaenzt} nicht sichtbare Bohrung(en) gemäß Anzahlangabe ergänzt)` : '') });
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

function sectionDepth(ctx, secs, vi, lo, hi, dA, er) {
  const s = ctx.s; const fm = pmap(ctx, vi); const mlo = fm(lo), mhi = fm(hi);
  for (const sec of secs) {
    if (sec.view === vi || !sec.faces || !sec.faces.length || !sec.plane) continue;
    const mp = ctx.layout.maps[sec.view]; const axes = { [mp.x[0]]: 'x', [mp.y[0]]: 'y' };
    if (!(dA in axes)) continue;
    const A = sec.plane.A; if (!(A in mlo)) continue;
    const pl = Math.min(mlo[A], mhi[A]), ph = Math.max(mlo[A], mhi[A]);
    if (sec.plane.val < pl - 1e-6 || sec.plane.val > ph + 1e-6) continue;
    const B = Object.keys(axes).find(k => k !== dA); if (!(B in mlo)) continue;
    const bc = (mlo[B] + mhi[B]) / 2; const bax = axes[B], dax = axes[dA];
    const sheetB = mp[bax][1] + mp[bax][2] * bc * s / 1;
    const swap = bax === 'y';
    const faces = swap ? sec.faces.map(f => ({ poly: f.poly.map(q => [q[1], q[0]]) })) : sec.faces;
    const iv = Sx.materialAlong(faces, sheetB).map(([u0, u1]) => [u0, u1].map(c => (c - mp[dax][1]) * mp[dax][2] / s).sort((x, y) => x - y));
    if (!iv.length) return { rng: [er[0] - 1, er[1] + 1], letter: sec.letter };
    const top = Math.max(...iv.map(x => x[1])), bot = Math.min(...iv.map(x => x[0]));
    if (top < er[1] - 0.05) return { rng: [top, er[1] + 1], letter: sec.letter };
    if (bot > er[0] + 0.05) return { rng: [er[0] - 1, bot], letter: sec.letter };
    if (sec.plane.geraten) continue;
    return 'voll';
  }
  return null;
}

// G1-Prüfung an Übergängen mit Bögen (2D, aus den Konturelementen; Bögen als 3-Punkt-Kreise)
function tangentCheck(items) {
  const tan = (it, atEnd) => {
    const P = it.pts; if (P.length < 2) return null;
    if (it.k === 'arc' && P.length >= 3) {
      const c = circumC(P[0], P[1], P[2]); if (!c) return null; const q = atEnd ? P[P.length - 1] : P[0];
      const rx = q[0] - c[0], ry = q[1] - c[1]; let t = [-ry, rx];
      const ref = atEnd ? [P[P.length - 1][0] - P[P.length - 2][0], P[P.length - 1][1] - P[P.length - 2][1]] : [P[1][0] - P[0][0], P[1][1] - P[0][1]];
      if (t[0] * ref[0] + t[1] * ref[1] < 0) t = [ry, -rx]; const l = Math.hypot(...t); return [t[0] / l, t[1] / l];
    }
    const a = atEnd ? P[P.length - 2] : P[0], b = atEnd ? P[P.length - 1] : P[1]; const l = Math.hypot(b[0] - a[0], b[1] - a[1]); return l > 1e-9 ? [(b[0] - a[0]) / l, (b[1] - a[1]) / l] : null;
  };
  let n = 0, t = 0, ecken = 0, max = 0;
  for (let i = 0; i < items.length; i++) {
    const A = items[i], B = items[(i + 1) % items.length];
    if (!((A.k === 'arc' && B.k !== 'spline') || (B.k === 'arc' && A.k !== 'spline'))) continue;
    const ta = tan(A, true), tb = tan(B, false); if (!ta || !tb) continue;
    const w = Math.acos(Math.max(-1, Math.min(1, ta[0] * tb[0] + ta[1] * tb[1]))) * 180 / Math.PI;
    if (w < 8) { n++; if (w < 3) t++; max = Math.max(max, w); } else ecken++;
  }
  return { n, t, ecken, max };
}
function circumC(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1])); if (Math.abs(d) < 1e-12) return null;
  const A = a[0] ** 2 + a[1] ** 2, B = b[0] ** 2 + b[1] ** 2, C = c[0] ** 2 + c[1] ** 2;
  return [(A * (b[1] - c[1]) + B * (c[1] - a[1]) + C * (a[1] - b[1])) / d, (A * (c[0] - b[0]) + B * (a[0] - c[0]) + C * (b[0] - a[0])) / d];
}

// Lochkreis aus starken + schwachen Kreisen (gleicher Radius, gemeinsamer Mittelpunkt, gleiche Teilung); fehlende ergänzen
function boltPattern(strong, weak, s) {
  const all = strong.map(c => ({ c, w: false })).concat(weak.map(c => ({ c, w: true })));
  let best = null;
  for (const seed of all) {
    if (seed.w || seed.c.r > 4) continue;
    const grp = all.filter(o => Math.abs(o.c.r - seed.c.r) < 0.15 * seed.c.r);
    if (grp.length < 3) continue;
    const [m, R, rms] = Ra.fitCircleFn(grp.map(o => o.c.center));
    if (!(R > 2 * seed.c.r) || rms > 0.04 * R) continue;
    const ang = grp.map(o => Math.atan2(o.c.center[1] - m[1], o.c.center[0] - m[0]));
    let N = null;
    for (let k = 3; k <= 12 && N == null; k++) {
      const st = 2 * Math.PI / k; const ok = ang.every(a => { const d = ((a - ang[0]) / st) % 1; const e = Math.min(Math.abs(d), 1 - Math.abs(d)); return e * st < 0.06; });
      if (ok && k >= grp.length) N = k;
    }
    if (N == null) continue;
    if (!best || grp.length > best.grp.length) best = { grp, m, R, N, a0: ang[0], r: grp.filter(o => !o.w).reduce((a, o) => a + o.c.r, 0) / grp.filter(o => !o.w).length };
  }
  if (!best) return null;
  const holes = []; const st = 2 * Math.PI / best.N;
  for (let k = 0; k < best.N; k++) { const a = best.a0 + k * st; holes.push(prim('circle', { center: [best.m[0] + best.R * Math.cos(a), best.m[1] + best.R * Math.sin(a)], r: best.r })); }
  const hub = weak.filter(c => Math.hypot(c.center[0] - best.m[0], c.center[1] - best.m[1]) < 0.1 * best.R);
  return { holes, m: best.m, pcd: 2 * best.R / s, N: best.N, gefunden: best.grp.length, schwach: best.grp.filter(o => o.w).length, hub };
}

// Tiefe einer Bohrung/Senkung aus den schraffierten Pixelgebieten eines (Raster-)Schnitts: Materialspalten bei Mitte ± 0,5r/0,8r
function sectionColumn(ctx, secs, vi, it, dA, er) {
  const s = ctx.s; const mF = ctx.layout.maps[vi];
  for (const sec of secs) {
    if (sec.view === vi || !sec.regions || sec.regions.length < 2) continue;
    const mS = ctx.layout.maps[sec.view]; if (!mS || mS.y[0] !== dA || mS.x[0] !== mF.x[0]) continue;
    const faces = sec.regions.map(r => ({ poly: r.prims.flatMap(p => sample(p, 12)) }));
    const partX = q => (q - mF.x[1]) * mF.x[2] / s, sheetX = X => mS.x[1] + X * s * mS.x[2], depth = y => (y - mS.y[1]) * mS.y[2] / s;
    const X0 = partX(it.center[0]), R = it.r / s;
    const v = ctx.views[sec.view]; if (sheetX(X0 - R) < v.lo[0] || sheetX(X0 + R) > v.hi[0]) continue;
    const cols = [-0.8, -0.5, 0.5, 0.8].map(k => Sx.materialAlong(faces, sheetX(X0 + k * R)).map(([a, b]) => [depth(a), depth(b)].sort((x, y) => x - y)));
    // Wand prüfen: knapp außerhalb des Kreises muss (mehr) Material liegen, sonst liegt das Element nicht im Schnitt
    const T0 = er[1] - er[0]; const span = c => c.reduce((a, [x, y]) => a + (y - x), 0);
    const outs = [-1.2, 1.2].map(k => span(Sx.materialAlong(faces, sheetX(X0 + k * R)).map(([a, b]) => [depth(a), depth(b)].sort((x, y) => x - y))));
    const ins = Math.max(...cols.map(span));
    if (!outs.every(o => o > ins + 0.2 * T0)) return null;
    if (cols.some(c => !c.length)) { if (cols.every(c => !c.length)) return { rng: null, letter: sec.letter }; return null; }
    const top = cols.map(c => Math.max(...c.map(x => x[1]))), bot = cols.map(c => Math.min(...c.map(x => x[0])));
    const T = er[1] - er[0];
    const tol = 0.06 * T;
    if (Math.max(...top) - Math.min(...top) > tol || Math.max(...bot) - Math.min(...bot) > tol) return null; // schräg (Kegel) -> keine Stufe
    const t = top.reduce((a, b) => a + b) / 4, b = bot.reduce((a, b) => a + b) / 4;
    if (t < er[1] - 0.1 * T && b <= er[0] + 0.06 * T) return { rng: [t, er[1] + 1], letter: sec.letter };
    if (b > er[0] + 0.1 * T && t >= er[1] - 0.06 * T) return { rng: [er[0] - 1, b], letter: sec.letter };
    return 'voll';
  }
  return null;
}

// Schräge/Fase am Umfang: in der Hauptansicht begleitet eine dünne Tangentialkante die Umrissbögen im konstanten Abstand w.
// Modell: Fase entlang dieser Bögen auf einer Plattenseite (Abstand w in der Plattenebene, Winkel aus Angabe 120° bzw. Annahme).
function peripheralChamfer(ctx, solid, outerLoop, vi, dA, ext) {
  const dr = ctx.dr, s = ctx.s; const items = loopItems(outerLoop.loop);
  const poly = items.flatMap(it => it.pts);
  const inside = q => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < (b[0] - a[0]) * (q[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  const arcs = [];
  for (const it of items) {
    if (it.k !== 'arc' || it.pts.length < 3) continue;
    const P = it.pts, c = circumC(P[0], P[Math.floor(P.length / 2)], P[P.length - 1]); if (!c) continue;
    const r = Math.hypot(P[0][0] - c[0], P[0][1] - c[1]); if (r < 5) continue;
    const a0 = Math.atan2(P[0][1] - c[1], P[0][0] - c[0]), am = Math.atan2(P[Math.floor(P.length / 2)][1] - c[1], P[Math.floor(P.length / 2)][0] - c[0]), a1 = Math.atan2(P[P.length - 1][1] - c[1], P[P.length - 1][0] - c[0]);
    let sw = a1 - a0; const ccw = ((am - a0 + 4 * Math.PI) % (2 * Math.PI)) < ((a1 - a0 + 4 * Math.PI) % (2 * Math.PI)); sw = ccw ? (sw + 4 * Math.PI) % (2 * Math.PI) : -((a0 - a1 + 4 * Math.PI) % (2 * Math.PI));
    const offs = [];
    for (let k = 1; k < 16; k++) {
      const a = a0 + sw * k / 16; const p = [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]; let n = [Math.cos(a), Math.sin(a)];
      if (!inside([p[0] + 0.5 * n[0], p[1] + 0.5 * n[1]])) n = [-n[0], -n[1]];
      for (let t = 0.7; t < 4; t += 0.02) if (dr.thinAt(p[0] + t * n[0], p[1] + t * n[1])) { let t2 = t; while (t2 < 4.5 && dr.thinAt(p[0] + t2 * n[0], p[1] + t2 * n[1])) t2 += 0.02; offs.push((t + t2 - 0.02) / 2); break; }
    }
    if (offs.length < 10) continue;
    offs.sort((x, y) => x - y); const med = offs[Math.floor(offs.length / 2)];
    const good = offs.filter(o => Math.abs(o - med) < 0.25).length; if (good < 0.6 * 15) continue;
    const convex = inside([c[0] + (P[0][0] - c[0]) * 0.9, c[1] + (P[0][1] - c[1]) * 0.9]);
    arcs.push({ c, r, w: med, len: Math.abs(sw) * r, a0, sw, convex });
  }
  if (!arcs.length) return null;
  const w = arcs.map(a => a.w).sort((x, y) => x - y)[Math.floor(arcs.length / 2)] / s;
  const ang = (ctx.phrases || []).some(ph => /(^|\D)120\s?[,.]?0?\s?°/.test(ph.text)) ? 'gelesen' : 'angenommen';
  const f = pmap(ctx, vi); const k = AX[dA]; const top = ext[dA][1]; const d = w * Math.tan(60 * Math.PI / 180);
  const v3 = m => [m.X ?? 0, m.Y ?? 0, m.Z ?? 0];
  const before = vol(solid); let out = solid;
  for (const a of arcs) {
    const C = v3(f(a.c)); C[k] = top; const ex = v3(f([a.c[0] + 1, a.c[1]])).map((x, i) => x - v3(f(a.c))[i]), ey = v3(f([a.c[0], a.c[1] + 1])).map((x, i) => x - v3(f(a.c))[i]);
    const axis = [ex[1] * ey[2] - ex[2] * ey[1], ex[2] * ey[0] - ex[0] * ey[2], ex[0] * ey[1] - ex[1] * ey[0]];
    const R0 = a.r / s, uu = ex.map((x, i) => x * Math.cos(a.a0) + ey[i] * Math.sin(a.a0)); const down = [0, 0, 0]; down[k] = -1;
    const at = (rr, dd) => C.map((x, i) => x + uu[i] * rr + down[i] * dd);
    const pe = at(R0 + (a.convex ? 0.02 : -0.02), -0.02), pi = at(a.convex ? R0 - w : R0 + w, -0.02), pd = at(R0 + (a.convex ? 0.02 : -0.02), d);
    const wire = R.assembleWire([R.makeLine(pe, pi), R.makeLine(pi, pd), R.makeLine(pd, pe)]);
    const tool = onlySolid(R.revolution(R.makeFace(wire), C, axis, a.sw * 180 / Math.PI));
    out = onlySolid(out.cut(tool));
  }
  const dv = before - vol(out); if (!(dv > 0) || !isValid(out)) return null;
  const L = arcs.reduce((x, a) => x + a.len, 0) / s;
  return { solid: out, feat: { typ: 'Schräge', text: `Schräge am Umfang entlang ${arcs.length} Umrissbögen (≈ ${L.toFixed(0)} mm): Breite ${w.toFixed(2)} mm aus Tangentialkante der Hauptansicht, Winkel 120° (${ang === 'gelesen' ? 'aus Maßtext' : 'Maßtext nicht gelesen – Normwert angenommen'}), Volumen −${dv.toFixed(0)} mm³` } };
}

// G1-Prüfung am fertigen B-Rep: Schnitt in halber Dicke, Tangenten an gemeinsamen Endpunkten (mind. ein Kreisbogen beteiligt)
function g1BRep(solid, dA, ext) {
  const k = AX[dA]; const mid = (ext[dA][0] + ext[dA][1]) / 2; const lo = [-1e4, -1e4, -1e4], hi = [1e4, 1e4, 1e4]; lo[k] = mid - 0.001; hi[k] = mid + 0.001;
  const sec = solid.intersect(R.makeBox(lo, hi));
  const P = v => [v.x, v.y, v.z];
  const es = sec.edges.filter(e => Math.abs(P(e.startPoint)[k] - lo[k]) < 1e-4 && Math.abs(P(e.endPoint)[k] - lo[k]) < 1e-4)
    .map(e => ({ circ: e.geomType === 'CIRCLE', s: P(e.startPoint), e: P(e.endPoint), ts: P(e.tangentAt(0)), te: P(e.tangentAt(1)) }));
  const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-3;
  const ang = (a, b) => { const l = Math.hypot(...a) * Math.hypot(...b); return Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / l))) * 180 / Math.PI; };
  let n = 0, t = 0, maxT = 0;
  for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) {
    const A = es[i], B = es[j]; if (!A.circ && !B.circ) continue;
    let w = null;
    if (same(A.e, B.s)) w = ang(A.te, B.ts); else if (same(B.e, A.s)) w = ang(B.te, A.ts);
    else if (same(A.e, B.e)) w = ang(A.te, B.te.map(x => -x)); else if (same(A.s, B.s)) w = ang(A.ts.map(x => -x), B.ts);
    if (w == null || w > 170) continue; n++; if (w < 0.5) { t++; maxT = Math.max(maxT, w); }
  }
  return { n, t, maxT };
}

function projectionMethod(phrases) {
  const t = (phrases || []).map(p => p.text.toUpperCase()).join(' | ');
  if (/FIRST\s*ANGLE|PROJEKTIONSMETHODE\s*1\b|ERSTWINKEL|METHODE\s*E\b/.test(t)) return 1;
  if (/THIRD\s*ANGLE|PROJEKTIONSMETHODE\s*3\b|DRITTWINKEL|METHODE\s*A\b/.test(t)) return 3;
  return null;
}
function reconstructPrism(ctx, msgs) {
  const L = ctx.layout; const s = ctx.s;
  {
    const pm = projectionMethod(ctx.phrases);
    if (pm === 1) msgs.push('Projektionsmethode 1 (Erstwinkel, „FIRST ANGLE“) aus dem Schriftfeld: Ansicht unterhalb = Draufsicht, rechts = Seitenansicht von links.');
    else if (pm === 3 && L.maps) {
      msgs.push('Projektionsmethode 3 (Drittwinkel, „THIRD ANGLE“) aus dem Schriftfeld: Ansicht unterhalb = Untersicht, rechts = Seitenansicht von rechts – Tiefenrichtung der Nebenansichten gespiegelt.');
      if (L.T != null && L.maps[L.T]) { const v = ctx.views[L.T]; L.maps[L.T] = { ...L.maps[L.T], y: [L.maps[L.T].y[0], v.hi[1], -1] }; }
      if (L.S != null && L.maps[L.S]) { const v = ctx.views[L.S], m = L.maps[L.S]; L.maps[L.S] = { ...m, x: m.x[2] === -1 ? [m.x[0], v.lo[0], 1] : [m.x[0], v.hi[0], -1] }; }
    } else msgs.push('Projektionsmethode nicht im Schriftfeld gefunden – Erstwinkel (DIN) angenommen.');
  }
  const roles = ['F', 'T', 'S'].filter(r => L[r] != null).map(r => [r, L[r]]);
  const ext = {};
  for (const [, vi] of roles) {
    const v = ctx.views[vi], f = pmap(ctx, vi);
    for (const p of [v.lo, v.hi]) for (const [A, val] of Object.entries(f(p))) { const e = ext[A] || [1e9, -1e9]; ext[A] = [Math.min(e[0], val), Math.max(e[1], val)]; }
  }
  if (roles.length === 1) { ext.Z = [0, 10]; msgs.push('WARNUNG: Nur eine Ansicht – Dicke 10 mm angenommen (bitte in der Maßtabelle prüfen).'); }
  const dirs = { F: 'Y', T: 'Z', S: 'X' }; const names = { F: 'Vorderansicht', T: 'Draufsicht', S: 'Seitenansicht' };
  const feats = []; let solid = null; const info = {};
  // Konturpunkte nahe den Gesamtabmessungen exakt auf die Grenze legen: koplanare Flächen verschiedener Ansichten
  // sind dann identisch (OCC-Boolesche Operationen scheitern an fast-, aber nicht exakt koplanaren Flächen)
  const snapE = (A, x) => { const e = ext[A]; if (!e) return x; if (Math.abs(x - e[0]) < 0.08) return e[0]; if (Math.abs(x - e[1]) < 0.08) return e[1]; return x; };
  const to3 = (f, dA, val) => p => { const m = f(p); for (const A of ['X', 'Y', 'Z']) if (A !== dA) m[A] = snapE(A, m[A]); m[dA] = val; return [m.X, m.Y, m.Z]; };
  const dvec = (dA, L) => dA === 'X' ? [L, 0, 0] : dA === 'Y' ? [0, L, 0] : [0, 0, L];
  const secs = (ctx.sections || []).filter(x => x.hatch.length && roles.some(([, vi]) => vi === x.view));
  for (const sec of secs) {
    const v = ctx.views[sec.view];
    sec.faces = Sx.hatchedFaces(v.prims, sec.hatch, ctx.tol);
    // Lage der Schnittebene
    const r = roles.find(([, vi]) => vi === sec.view)[0]; const nA = dirs[r];
    if (sec.cut && sec.parent != null && L.maps[sec.parent]) {
      const mp = L.maps[sec.parent]; const ax = sec.cut.dir === 'senkrecht' ? 'x' : 'y';
      if (mp[ax][0] === nA) sec.plane = { A: nA, val: (sec.cut.pos - mp[ax][1]) * mp[ax][2] / s };
    }
    if (!sec.plane) { sec.plane = { A: nA, val: (ext[nA][0] + ext[nA][1]) / 2, geraten: true }; msgs.push(`Schnitt ${sec.letter || ''}: Schnittverlauf nicht zugeordnet – Schnittebene in Bauteilmitte angenommen.`); }
    msgs.push(`Schnitt ${sec.letter || ''}: ${sec.faces.length} schraffierte Fläche(n), Schnittebene ${sec.plane.A} = ${sec.plane.val.toFixed(2)} mm`);
  }
  const isSec = vi => secs.some(x => x.view === vi && x.faces.length);
  for (const [r, vi] of roles) {
    const v = ctx.views[vi]; const [loops, circles] = viewLoops(v, ctx.tol); info[r] = [loops, circles];
    if (!loops.length) continue;
    if (isSec(vi) && roles.length > 1) { feats.push({ typ: 'Schnitt', text: `${names[r]} ist ein Schnitt – Umriss nicht extrudiert, Tiefen von Taschen/Bohrungen aus der Schnittfläche` }); continue; }
    const dA = dirs[r]; const a = ext[dA][0] - 1, b = ext[dA][1] + 1; const f = pmap(ctx, vi);
    const items = loopItems(loops[0].loop); const kinds = kindsOf(items);
    const w = wireFromItems(items, to3(f, dA, a));
    const pr = R.basicFaceExtrusion(R.makeFace(w), new R.Vector(dvec(dA, b - a)));
    solid = solid ? onlySolid(solid.intersect(pr)) : pr;
    const g1 = tangentCheck(items); if (g1.n) feats.push({ typ: 'Tangentialität', text: `${names[r]}: ${g1.t} von ${g1.n} Übergängen Gerade/Bogen tangential (G1, max. Knick ${g1.max.toFixed(1)}°)` + (g1.ecken ? `, ${g1.ecken} echte Ecke(n)` : '') });
    feats.push({ typ: 'Silhouette', text: `${names[r]}: Umriss mit ${kinds.length} Elementen (${count(kinds, 'line')} Geraden, ${count(kinds, 'arc')} Bögen, ${count(kinds, 'spline')} Splines) entlang ${dA} extrudiert` });
  }
  if (!solid) throw new ReconError('Keine Außenkontur gefunden.');
  if (secs.some(x => x.faces.length) && roles.length > 1) {
    // Schnittansicht nicht extrudiert: auf Gesamtabmessungen begrenzen
    solid = onlySolid(solid.intersect(R.makeBox([ext.X[0], ext.Y[0], ext.Z[0]], [ext.X[1], ext.Y[1], ext.Z[1]])));
  }
  if (roles.length > 1) feats.unshift({ typ: 'Verschneidung', text: `Körper als Schnitt der ${roles.length} extrudierten Ansichts-Umrisse` });
  for (const [r, vi] of roles) {
    const [loops, circles] = info[r]; if (!loops.length) continue;
    if (isSec(vi)) continue;
    const outer = loops[0]; const f = pmap(ctx, vi); const dA = dirs[r];
    const inside = (lo, hi) => lo[0] >= outer.lo[0] - TOL && lo[1] >= outer.lo[1] - TOL && hi[0] <= outer.hi[0] + TOL && hi[1] <= outer.hi[1] + TOL;
    const items = loops.slice(1).filter(l => inside(l.lo, l.hi)).map(l => ['schleife', l])
      .concat(circles.filter(c => c.center[0] > outer.lo[0] && c.center[1] > outer.lo[1] && c.center[0] < outer.hi[0] && c.center[1] < outer.hi[1]).map(c => ['kreis', c]));
    const skipC = new Set(), skipCol = new Set();
    {
      const bp = boltPattern(circles, ctx.views[vi].weak || [], s);
      if (bp) {
        const near = (a, b) => Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]) < 0.5 * a.r;
        const neu = bp.holes.filter(h => !circles.some(c => near(h, c)));
        // gefundene starke Kreise des Musters auf exakte Lage setzen
        for (const h of bp.holes) { const c = circles.find(c => near(h, c)); if (c) { c.center = h.center; c.r = h.r; } }
        for (const h of neu.concat(bp.hub.filter(hc => !circles.some(c => near(hc, c) && Math.abs(c.r - hc.r) < 0.15 * hc.r)))) items.push(['kreis', h]);
        feats.push({ typ: 'Bohrungsmuster', text: `Lochkreis Ø${bp.pcd.toFixed(2)} mm mit ${bp.N} Bohrungen Ø${(2 * bp.holes[0].r / s).toFixed(2)} mm (${bp.gefunden} erkannt, davon ${bp.schwach} nur teilweise sichtbar; ${neu.length} ergänzt aus Teilung)` + (bp.hub.length ? `, ${bp.hub.length} Kreis(e) im Lochkreismittelpunkt aus Teilkonturen` : '') });
      }
    }
    for (const [kind, it] of items) {
      if (skipC.has(it)) continue;
      let lo, hi;
      if (kind === 'kreis') { lo = [it.center[0] - it.r, it.center[1] - it.r]; hi = [it.center[0] + it.r, it.center[1] + it.r]; }
      else { lo = it.lo; hi = it.hi; }
      let rng = depthRange(ctx, vi, lo, hi, dA, ext[dA]); let ausSchnitt = null;
      if (!rng) { const sd = sectionDepth(ctx, secs, vi, lo, hi, dA, ext[dA]); if (sd === 'voll') continue; if (sd) { rng = sd.rng; ausSchnitt = sd.letter; } }
      if (!rng && kind === 'kreis' && !skipCol.has(it)) { const sc = sectionColumn(ctx, secs, vi, it, dA, ext[dA]); if (sc && sc !== 'voll' && sc.rng) { rng = sc.rng; ausSchnitt = sc.letter; } }
      // Bereich ohne Außenfläche oder fast ohne Tiefe ist als Bohrung aus der Ansicht unplausibel -> durchgehend
      if (rng && kind === "kreis" && (Math.min(rng[1], ext[dA][1]) - Math.max(rng[0], ext[dA][0]) < 0.05 * (ext[dA][1] - ext[dA][0]))) { rng = null; ausSchnitt = null; }
      const durch = !rng || (rng[0] < ext[dA][0] && rng[1] > ext[dA][1]);
      const [a, b] = rng || [ext[dA][0] - 1, ext[dA][1] + 1];
      const dir = dvec(dA, 1); let tool, desc;
      if (kind === 'kreis') {
        const m = f(it.center); m[dA] = a;
        tool = R.makeCylinder(it.r / s, b - a, [m.X, m.Y, m.Z], dir); desc = `Bohrung Ø${(2 * it.r / s).toFixed(2)} mm`;
        // Kegelloch: konzentrischer kleinerer Kreis + Winkelangabe, Kegelwinkel aus Radien/Dicke passt zur Angabe
        const inn = circles.find(c => c !== it && c.r < it.r * 0.9 && c.r > it.r * 0.2 && dist(c.center, it.center) < 0.1 * it.r);
        const T = ext[dA][1] - ext[dA][0];
        if (inn && durch) {
          const PH = ctx.phrases || [];
          const grad = PH.filter(ph => /°/.test(ph.text));
          const winkel = [...new Set(PH.flatMap(ph => [...ph.text.matchAll(/(\d{2,3})\s?°/g)].map(q => +q[1]))
            .concat(PH.filter(ph => /^\d{2,3}$/.test(ph.text.trim()) && grad.some(g => g !== ph && Math.hypot(g.x - ph.x, g.y - ph.y) < 15)).map(ph => +ph.text.trim())))].filter(w => [60, 82, 90, 100, 120].includes(w));
          const w = 2 * Math.atan((it.r - inn.r) / s / T) * 180 / Math.PI;
          const wa = winkel.find(q => Math.abs(q - w) < 6);
          if (wa != null) {
            const r0 = it.r / s, r1 = Math.max(0.1, r0 - T * Math.tan(wa * Math.PI / 360));
            const O = f(it.center); O[dA] = ext[dA][0]; const o = [O.X, O.Y, O.Z];
            const ax = ['X', 'Y', 'Z'].indexOf(dA); const d = [0, 0, 0]; d[ax] = 1; const e = [0, 0, 0]; e[(ax + 1) % 3] = 1;
            const P = (t, r) => o.map((v, k) => v + d[k] * t + e[k] * r);
            const pts = [P(0, 0), P(0, r0), P(T, r1), P(T, 0)];
            const wire = R.assembleWire(pts.map((q, k) => R.makeLine(q, pts[(k + 1) % 4])));
            tool = onlySolid(R.revolution(R.makeFace(wire), o, d, 360));
            desc = `Kegelloch ${wa}° Ø${(2 * r0).toFixed(2)}→Ø${(2 * r1).toFixed(2)} mm (Kegelwinkel aus Kreisen ${w.toFixed(1)}°, Angabe ${wa}°)`;
            skipC.add(inn);
          }
        }
      } else {
        const li = loopItems(it.loop); const k = kindsOf(li);
        tool = R.basicFaceExtrusion(R.makeFace(wireFromItems(li, to3(f, dA, a))), new R.Vector(dvec(dA, b - a)));
        const bb = [(hi[0] - lo[0]) / s, (hi[1] - lo[1]) / s];
        desc = (count(k, 'arc') >= 2 && count(k, 'line') <= 2 ? 'Langloch' : 'Tasche/Durchbruch') + ` ${bb[0].toFixed(1)}×${bb[1].toFixed(1)} mm`;
      }
      const before = vol(solid);
      solid = onlySolid(solid.cut(tool));
      if (before - vol(solid) < 1e-3) continue;
      const tiefe = durch ? 'durchgehend' + (ausSchnitt != null ? ' (laut Schnitt)' : '') : `Tiefe ${(b - a - (a < ext[dA][0] ? 1 : 0) - (b > ext[dA][1] ? 1 : 0)).toFixed(2)} mm (${ausSchnitt != null ? 'aus Schnitt ' + (ausSchnitt || '') : 'aus verdeckten Kanten'})`;
      feats.push({ typ: 'Ausschnitt', text: `${desc} in Richtung ${dA}, ${tiefe}` });
    }
  }
  if (ctx.raster && ctx.dr && ctx.dr.thinAt && L.F != null && info.F && info.F[0].length) {
    try { const pc = peripheralChamfer(ctx, solid, info.F[0][0], L.F, dirs.F, ext); if (pc) { solid = pc.solid; feats.push(pc.feat); } }
    catch (e) { msgs.push('Schräge am Umfang erkannt, aber nicht modellierbar (' + (e.message || e) + ').'); }
  }
  try { const g = g1BRep(solid, dirs.F && L.F != null ? 'Y' : (L.T != null ? 'Z' : 'X'), ext); if (g.n) feats.push({ typ: 'Tangentialität (B-Rep)', text: `Geprüft am B-Rep (Schnitt in halber Dicke): ${g.t} von ${g.n} Übergängen mit Kreisbögen tangential G1 (Knick < 0,5°${g.t ? ', max. ' + g.maxT.toFixed(2) + '°' : ''}), ${g.n - g.t} Ecken` }); } catch (e) { if (globalThis.DBG) console.log('g1', e); }
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
function pmiItems(dims, faces, bboxC, diag, bb) {
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
    const klasse = Dm.dimKlasse(d);
    let masslinie = null, hilfslinien = null;
    if (a.art === 'linear' && bb && a.achse in { X: 1, Y: 1, Z: 1 }) {
      masslinie = Dm.masslinieAbstand(a.achse, a.m0, a.m1, bb[0], bb[1]);
      if (masslinie) hilfslinien = Dm.hilfslinienAbstand(a.achse, a.m0, a.m1, bb[0], bb[1], masslinie);
    }
    items.push({ id: 'PMI-' + d.id, masz: d.id, typ, klasse, nennmass: d.wert, einheit: typ === 'Winkel' ? '°' : 'mm', tol_oben: d.tol_o ?? null, tol_unten: d.tol_u ?? null,
      passung: d.passung ?? null, text: d.text, bezuege: refs.map((g, i) => ({ rolle: `Element ${i + 1}`, flaechen: g })), hinweis: note, anker_3d: r3(m), label_3d: r3(label),
      masslinie, hilfslinien });
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

/** Volumen nur aus bestätigter Schnittkontur, Achse und Maßstab (Drehen) bzw. Tiefe (Extrudieren). */
export function modelFromConfirmedSection(spec) {
  if (!R) throw new ReconError('CAD-Kern nicht bereit.');
  const scale = +spec.scale;
  if (!(scale > 0)) throw new ReconError('Maßstab muss größer als 0 sein.');
  const items0 = spec.items;
  if (!items0 || !items0.length) throw new ReconError('Keine Schnittkontur.');
  let solid, strategy, feats;
  if (spec.mode === 'extrudieren') {
    const depth = +spec.depth;
    if (!(depth > 0)) throw new ReconError('Extrusionstiefe muss größer als 0 sein.');
    const items = Sx.orientItems(Sx.closeItems(items0));
    const pts = items.flatMap(it => it.pts);
    const x0 = spec.origin ? +spec.origin[0] : Math.min(...pts.map(p => p[0]));
    const y0 = spec.origin ? +spec.origin[1] : Math.min(...pts.map(p => p[1]));
    const dir = spec.dir === 'y' ? [0, depth, 0] : spec.dir === 'x' ? [depth, 0, 0] : [0, 0, depth];
    const f = p => {
      const x = (p[0] - x0) / scale, y = (p[1] - y0) / scale;
      if (spec.dir === 'y') return [x, 0, y];
      if (spec.dir === 'x') return [0, y, x];
      return [x, y, 0];
    };
    try { solid = onlySolid(R.basicFaceExtrusion(R.makeFace(wireFromItems(items, f)), new R.Vector(dir))); }
    catch (e) { throw new ReconError('Extrusion der bestätigten Kontur fehlgeschlagen (' + (e.message || e) + '). Kontur prüfen (geschlossen, ohne Kreuzung).'); }
    strategy = 'Platte (bestätigte Schnittkontur)';
    feats = [{ typ: 'Extrusion (bestätigt)', text: `${spec.label || 'Schnittkontur'} extrudiert, Tiefe ${depth.toFixed(2)} mm entlang ${spec.dir === 'y' ? 'Y' : spec.dir === 'x' ? 'X' : 'Z'}, Maßstab ${Sx.fmtScale(scale)}` }];
  } else {
    let prof;
    try { prof = Sx.revolveProfile(items0, spec.axis, scale, spec.side || 'auto'); }
    catch (e) { throw new ReconError(e.message || String(e)); }
    try { solid = onlySolid(R.revolution(R.makeFace(wireFromItems(prof.items, p => [p[0], p[1], 0])), [0, 0, 0], [1, 0, 0], 360)); }
    catch (e) { throw new ReconError('Rotation der bestätigten Kontur fehlgeschlagen (' + (e.message || e) + '). Achse und Kontur prüfen.'); }
    strategy = 'Drehteil (bestätigte Schnittkontur)';
    feats = [{ typ: 'Drehung (bestätigt)', text: `${spec.label || 'Schnittkontur'} um die bestätigte Achse rotiert, Profil ${prof.area.toFixed(1)} mm², Radius ${prof.rmin.toFixed(2)}…${prof.rmax.toFixed(2)} mm, Maßstab ${Sx.fmtScale(scale)}` }];
  }
  try { solid = solid.simplify(); } catch (e) { /* ignorieren */ }
  const gueltig = isValid(solid);
  const an = analyse(solid);
  const bb = solid.boundingBox.bounds; const [x0, y0, z0] = bb[0], [x1, y1, z1] = bb[1];
  const stats = {}, estats = {};
  for (const f of an.faces) stats[f.typ] = (stats[f.typ] || 0) + 1;
  for (const e of an.edges) estats[e.typ] = (estats[e.typ] || 0) + 1;
  const meldungen = ['Modell aus der bestätigten Schnittkontur (nicht aus der automatischen Bahnwahl).'];
  if (!gueltig) meldungen.push('WARNUNG: Das B-Rep ist laut OpenCASCADE nicht gültig.');
  return {
    solid, result: {
      ok: true, quelle: 'schnitt', strategie: strategy, meldungen, aenderungen: [], merkmale: feats,
      massstab: scale, massstab_schriftfeld: null, dpi_bekannt: null,
      volumen_mm3: Math.round(vol(solid) * 10) / 10, bbox: r3([x1 - x0, y1 - y0, z1 - z0]), bbox_lo: r3([x0, y0, z0]), gueltig,
      texte: [], ansichten: [], schnitte: [], einzelheiten: [], schnitt_konturen: [], page_w: null, page_h: null,
      masse: [], pmi: [], flaechen: an.faces, kanten: an.edges, flaechen_statistik: stats, kanten_statistik: estats,
      teil_typ: spec.mode === 'extrudieren' ? 'prisma' : 'dreh',
    }, mesh: an.mesh, edgeMesh: an.edgeMesh,
  };
}

function sheetOrigin(items) {
  const pts = (items || []).flatMap(it => it.pts || []);
  if (!pts.length) return null;
  return [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1]))];
}
function turnedRadius(solid) {
  const bb = solid.boundingBox.bounds;
  return Math.max(Math.abs(bb[0][1]), Math.abs(bb[1][1]), Math.abs(bb[0][2]), Math.abs(bb[1][2]));
}
function chamferTool(xEnd, sign, radius, c, angleDeg) {
  const ang = Math.max(15, Math.min(75, angleDeg || 45)) * Math.PI / 180;
  const axial = c, radial = c * Math.tan(ang);
  const xA = xEnd - sign * 0.02, xB = xEnd + sign * axial;
  const p1 = [xA, radius + 0.15, 0], p2 = [xB, radius + 0.15, 0], p3 = [xA, Math.max(0.05, radius - radial), 0];
  const wire = R.assembleWire([R.makeLine(p1, p2), R.makeLine(p2, p3), R.makeLine(p3, p1)]);
  return onlySolid(R.revolution(R.makeFace(wire), [0, 0, 0], [1, 0, 0], 360));
}
function applyChamfer(solid, spec) {
  const c = +spec.c;
  if (!(c > 0)) return null;
  const bb = solid.boundingBox.bounds;
  const radius = turnedRadius(solid);
  const radial = c * Math.tan(Math.max(15, Math.min(75, spec.winkel || 45)) * Math.PI / 180);
  if (radius <= radial + 0.2) return null;
  const before = vol(solid);
  let out = solid;
  try {
    out = onlySolid(out.cut(chamferTool(bb[0][0], 1, radius, c, spec.winkel)));
    out = onlySolid(out.cut(chamferTool(bb[1][0], -1, radius, c, spec.winkel)));
  } catch (e) { return null; }
  const dv = before - vol(out);
  if (!(dv > 0.05)) return null;
  return { solid: out, text: `Fase ${c} × ${spec.winkel || 45}° an beiden äußeren Stirnkanten, Volumen −${dv.toFixed(1)} mm³` };
}
function countersinkTool(xEnd, sign, radius, bore, angleDeg) {
  const half = (angleDeg || 90) * Math.PI / 360;
  const depth = (radius - bore) / Math.tan(half);
  if (!(depth > 0.05)) return null;
  const x0 = xEnd - sign * 0.02, x1 = xEnd + sign * depth;
  const pts = [[x0, 0, 0], [x0, radius, 0], [x1, Math.max(0, bore), 0], [x1, 0, 0]];
  const wire = R.assembleWire(pts.map((q, k) => R.makeLine(q, pts[(k + 1) % pts.length])));
  return onlySolid(R.revolution(R.makeFace(wire), [0, 0, 0], [1, 0, 0], 360));
}
function applyCountersink(solid, spec) {
  const radius = +spec.durchmesser / 2;
  const bore = spec.bohrung > 0 ? +spec.bohrung / 2 : Math.max(0.2, radius * 0.5);
  if (!(radius > bore + 0.05)) return null;
  const bb = solid.boundingBox.bounds;
  const before = vol(solid);
  let best = null;
  for (const [x, sign, name] of [[bb[0][0], 1, 'der einen Stirnseite'], [bb[1][0], -1, 'der anderen Stirnseite']]) {
    let tool, next;
    try { tool = countersinkTool(x, sign, radius, bore, spec.winkel); if (!tool) continue; next = onlySolid(solid.cut(tool)); }
    catch (e) { continue; }
    const dv = before - vol(next);
    if (dv > 0.5 && dv < before * 0.35 && (!best || dv > best.dv)) best = { solid: next, dv, name };
  }
  if (!best) return null;
  return { solid: best.solid, text: `Senkung ${spec.winkel || 90}° Ø${(2 * radius).toFixed(2)} an ${best.name}, Volumen −${best.dv.toFixed(1)} mm³` };
}
function booleanOp(solid, tool, op) {
  const once = s => op === 'add' ? onlySolid(s.fuse(tool)) : onlySolid(s.cut(tool));
  try { return once(solid); }
  catch (e) {
    try { return once(solid.simplify()); }
    catch (e2) { throw e; }
  }
}
function packStack(solid, fields) {
  try { solid = solid.simplify(); } catch (e) { /* ignorieren */ }
  const gueltig = isValid(solid);
  const an = analyse(solid);
  const bb = solid.boundingBox.bounds; const [x0, y0, z0] = bb[0], [x1, y1, z1] = bb[1];
  const bbc = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  const diag = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
  const dims = fields.dims || [];
  const pmi = dims.length ? pmiItems(dims, an.faces, bbc, diag, bb) : [];
  const stats = {}, estats = {};
  for (const f of an.faces) stats[f.typ] = (stats[f.typ] || 0) + 1;
  for (const e of an.edges) estats[e.typ] = (estats[e.typ] || 0) + 1;
  const meldungen = fields.meldungen.slice();
  if (!gueltig) meldungen.push('WARNUNG: Das B-Rep ist laut OpenCASCADE nicht gültig.');
  const ziel = dims.filter(d => d.anker && d.anker.art && d.anker.art !== 'info').length;
  if (ziel && pmi.length < ziel) meldungen.push('Hinweis: Nicht jedes Maß hat am Feature-Stack eine passende Bezugsfläche. Bohrungsdurchmesser und Abstände stehen weiter in der Maßliste.');
  return {
    solid, result: {
      ok: true, quelle: 'stack', strategie: fields.strategy, meldungen, aenderungen: [], merkmale: fields.feats,
      massstab: fields.scale, massstab_schriftfeld: null, dpi_bekannt: null,
      volumen_mm3: Math.round(vol(solid) * 10) / 10, bbox: r3([x1 - x0, y1 - y0, z1 - z0]), bbox_lo: r3([x0, y0, z0]), gueltig,
      texte: [], ansichten: [], schnitte: [], einzelheiten: [], schnitt_konturen: [], page_w: null, page_h: null,
      masse: dims, pmi, flaechen: an.faces, kanten: an.edges, flaechen_statistik: stats, kanten_statistik: estats,
      teil_typ: fields.teil, stack_bericht: fields.bericht, sicherheit: fields.sicherheit || null, sicherheit_grund: fields.sicherheit_grund || null,
    }, mesh: an.mesh, edgeMesh: an.edgeMesh,
  };
}

/** Mehrere bestätigte Schritte: Basis (Drehen/Extrudieren), dann Add/Cut, Fase, Senkung. */
export function modelFromFeatureStack(spec) {
  if (!R) throw new ReconError('CAD-Kern nicht bereit.');
  const steps = (spec && spec.steps) || [];
  const base = steps.find(s => s.op === 'drehen' || s.op === 'extrudieren');
  if (!base || !base.spec) throw new ReconError('Kein Basisvolumen. Bitte den Hauptschnitt bestätigen.');
  base.spec.mode = base.op === 'extrudieren' ? 'extrudieren' : 'drehen';
  if (base.spec.mode === 'extrudieren') {
    const origin = sheetOrigin(base.spec.items);
    if (origin) base.spec.origin = origin;
    if (!(base.spec.depth > 0)) throw new ReconError('Extrusionstiefe fehlt. Bitte die Tiefe eintragen und den Schritt bestätigen.');
  }
  let built;
  try { built = modelFromConfirmedSection(base.spec); }
  catch (e) { throw new ReconError('Basis nicht baubar: ' + (e.message || e)); }
  let solid = built.solid;
  const feats = built.result.merkmale.slice();
  const meldungen = ['Feature-Stack: ' + built.result.strategie + '.'];
  const bericht = [{ id: base.id, ok: true, text: 'Basisvolumen ' + built.result.volumen_mm3.toLocaleString('de-DE') + ' mm³' }];
  for (const st of steps) {
    if (!st || st === base || st.id === base.id) continue;
    if (st.op !== 'add' && st.op !== 'cut' && st.op !== 'fase' && st.op !== 'senkung') continue;
    try {
      if (st.op === 'add' || st.op === 'cut') {
        const sp = Object.assign({}, st.spec);
        if (sp.mode === 'extrudieren' || base.spec.mode === 'extrudieren') {
          sp.mode = 'extrudieren';
          sp.origin = base.spec.origin || sheetOrigin(base.spec.items);
          sp.depth = base.spec.depth;
          sp.dir = base.spec.dir || sp.dir;
          sp.scale = base.spec.scale || sp.scale;
        } else {
          sp.mode = 'drehen';
          sp.axis = base.spec.axis || sp.axis;
          sp.scale = base.spec.scale || sp.scale;
          sp.side = base.spec.side || sp.side || 'auto';
        }
        const tool = modelFromConfirmedSection(sp).solid;
        const before = vol(solid);
        solid = booleanOp(solid, tool, st.op);
        const dv = vol(solid) - before;
        const text = (st.op === 'add' ? 'Add' : 'Cut') + ` „${st.titel}“: ΔV ${dv.toFixed(1)} mm³`;
        if (Math.abs(dv) < 1e-2) meldungen.push(text + ' – Volumen fast unverändert. Kontur und Lage prüfen.');
        feats.push({ typ: st.op === 'add' ? 'Boolean Add' : 'Boolean Cut', text });
        bericht.push({ id: st.id, ok: true, text });
      } else if (st.op === 'fase') {
        const r = applyChamfer(solid, st.spec || {});
        if (!r) {
          const text = `Fase „${st.titel}“ nicht geschnitten: keine passende Außenkante am Drehteil.`;
          meldungen.push(text); bericht.push({ id: st.id, ok: false, text });
        } else { solid = r.solid; feats.push({ typ: 'Fase', text: r.text }); bericht.push({ id: st.id, ok: true, text: r.text }); }
      } else if (st.op === 'senkung') {
        const r = applyCountersink(solid, st.spec || {});
        if (!r) {
          const text = `Senkung „${st.titel}“ nicht geschnitten: Kegel trifft das Volumen nicht. Lage prüfen.`;
          meldungen.push(text); bericht.push({ id: st.id, ok: false, text });
        } else { solid = r.solid; feats.push({ typ: 'Senkung', text: r.text }); bericht.push({ id: st.id, ok: true, text: r.text }); }
      }
    } catch (e) {
      const text = `Schritt „${st.titel}“ nicht angewendet: ${e.message || e}. Der bisherige Körper bleibt.`;
      meldungen.push(text); bericht.push({ id: st.id, ok: false, text });
    }
  }
  return packStack(solid, {
    dims: spec.dims || [], meldungen, feats, bericht,
    strategy: 'Feature-Stack (' + (base.spec.mode === 'extrudieren' ? 'Extrusion' : 'Drehung') + ' und Boolean)',
    scale: base.spec.scale, teil: base.spec.mode === 'extrudieren' ? 'prisma' : 'dreh',
    sicherheit: spec.sicherheit || null, sicherheit_grund: spec.sicherheit_grund || null,
  });
}

// ---------------------------------------------------------------- Hauptfunktion
/** dr: Zwischenformat (Vektor oder Raster); edits: {M1: wert}; Rückgabe: Ergebnis + solid. */
export function processDrawing(dr, edits, log = () => {}) {
  const msgs = [...dr.msgs]; const raster = dr.kind === 'raster';
  if (!dr.thick.length) throw new ReconError('Keine sichtbaren Körperkanten (breite Volllinien) gefunden.');
  if (raster) {
    // fast geschlossene Bögen (Kreis von Hinweislinie angeschnitten) -> Vollkreis
    const drop = new Set();
    for (const a of dr.thick) if (a.kind === 'arc' && Math.abs(a.sweep) > 2 * Math.PI * 0.93) {
      const gap = dist(a.pts[0], a.pts[1]);
      for (const l of dr.thick) if (l.kind === 'line' && Math.hypot(l.pts[0][0] - l.pts[1][0], l.pts[0][1] - l.pts[1][1]) < gap + 0.6
        && [a.pts[0], a.pts[1]].every(q => Math.min(dist(q, l.pts[0]), dist(q, l.pts[1])) < 0.3)) drop.add(l);
      a.kind = 'circle'; delete a.pts; delete a.sweep;
    }
    dr.thick = dr.thick.filter(p => !drop.has(p));
  }
  let views = clusterViews(dr.thick, raster ? 2.0 : 3.0, 4.0);
  // kurze breite Striche = Enden eines Schnittverlaufs
  const strokes = (dr.strokes || []).slice();
  // kleine Ansichten vollständig innerhalb einer größeren (z. B. Bohrungen der Stirnansicht) zusammenführen
  if (raster) {
    for (const v of views.slice()) {
      const host = views.find(w => w !== v && Math.max(...w.size) > Math.max(...v.size) * 2 && v.lo[0] >= w.lo[0] && v.hi[0] <= w.hi[0] && v.lo[1] >= w.lo[1] && v.hi[1] <= w.hi[1]);
      if (host) { host.prims.push(...v.prims); views.splice(views.indexOf(v), 1); refresh(host); }
    }
  }
  views = views.filter(v => {
    const st = Math.max(...v.size) < 12 && Math.min(...v.size) < 1.5 && v.prims.length <= 2 && v.prims.every(p => p.kind === 'line');
    if (st) strokes.push(v);
    return !st && !(raster && Math.max(...v.size) < 8);
  });
  if (!views.length) throw new ReconError('Keine Ansichten erkannt.');
  const lab = Sx.parseLabels(dr.phrases);
  const hatch = dr.hatch || [];
  // Einzelheiten: aus der Ansichtsliste lösen und in die Elternansicht übertragen
  let details; [details, views] = Sx.findDetails(views, dr.thinCircles || [], lab, msgs);
  const detailInfo = [];
  for (const d of details) {
    const pi = views.findIndex(v => d.cP[0] >= v.lo[0] - d.rP && d.cP[0] <= v.hi[0] + d.rP && d.cP[1] >= v.lo[1] - d.rP && d.cP[1] <= v.hi[1] + d.rP);
    const inBnd = q => dist(q, d.cD) < d.rD * 1.25;
    // Maße/Hilfslinien der Einzelheit nicht für Maßlinien der Hauptansichten verwenden
    dr.thin = dr.thin.filter(p => !(sample(p, 4).every(inBnd)));
    dr.arrows = (dr.arrows || []).filter(a => !inBnd(a.tip));
    for (const ph of dr.phrases) if (inBnd([ph.x, ph.y])) ph.detail = d.letter;
    if (pi < 0) { msgs.push(`Einzelheit ${d.letter}: Elternansicht nicht gefunden.`); continue; }
    const kMain = raster ? null : dr.scale;
    const kTxt = d.k && kMain ? d.k / kMain : null;
    if (kTxt && Math.abs(d.ratio / kTxt - 1) > 0.05) msgs.push(`WARNUNG: Einzelheit ${d.letter}: Kreisverhältnis ${d.ratio.toFixed(2)} passt nicht zum Maßstab ${Ra.fmtScale(d.k)} – verwende das Kreisverhältnis.`);
    const n = Sx.applyDetail(views[pi], d, raster ? 0.15 : 0.02); refresh(views[pi]);
    d.parentObj = views[pi];
    msgs.push(`Einzelheit ${d.letter}${d.k ? ' (' + Ra.fmtScale(d.k) + ')' : ''}: ${n} Konturelemente in die Hauptansicht übernommen (Vergrößerung ${d.ratio.toFixed(2)}×).`);
    detailInfo.push(d);
  }
  assignHidden(views, dr.hidden);
  let s, tol, scaleSrc;
  if (raster) {
    const vals = dr.phrases.flatMap(ph => Dm.parsePhrase(ph.text)).filter(sp => sp.typ === 'laenge' || sp.typ === 'durchmesser').map(sp => sp.wert);
    // OCR liest „Ø“ oft als „8“: Variante ohne führende 8 zusätzlich anbieten
    for (const ph of dr.phrases) { const m = ph.text.match(/^8(\d{2,}(?:[.,]\d+)?)$/); if (m) vals.push(Dm.f2(m[1])); }
    let src;
    const pv = !dr.dpi_known ? Ra.perViewScales(dr, views, vals) : null;
    if (pv) {
      const big = views.reduce((a, b, i) => b.size[0] * b.size[1] > views[a].size[0] * views[a].size[1] ? i : a, 0);
      const fine = Ra.fineScale(views[big], vals, pv[big]); if (fine) { for (let i = 0; i < pv.length; i++) pv[i] /= fine.f; msgs.push(`Maßstab-Feinabgleich über ${fine.n} Maßzahlen: Faktor ${fine.f.toFixed(4)} (Bildauflösung geraten, Maßzahlen haben Vorrang)`); }
      s = pv[big]; const Fs = dr.sheet_f || 1;
      src = Fs !== 1 ? `Blatt laut ${dr.sheet_fmt != null ? 'Formatangabe A' + dr.sheet_fmt : 'Schriftfeld-Maßstab + Maßzahlen'} ${Math.round(dr.page_w * Fs)}×${Math.round(dr.page_h * Fs)} mm (DPI-Schätzung korrigiert), Maßstab ${Ra.fmtScale(s * Fs)}`
        : `Normblatt ${Math.round(dr.page_w)}×${Math.round(dr.page_h)} mm, Normmaßstab ${Ra.fmtScale(s)}` + (dr.scale_txt && Math.abs(dr.scale_txt / s - 1) < 1e-6 ? ' (Schriftfeld, durch Maßzahlen bestätigt)' : ' aus den Maßzahlen');
      views.forEach((v, i) => {
        if (pv[i] === s) return;
        const f = s / pv[i], c = [(v.lo[0] + v.hi[0]) / 2, (v.lo[1] + v.hi[1]) / 2], T = q => [c[0] + (q[0] - c[0]) * f, c[1] + (q[1] - c[1]) * f];
        for (const p of v.prims.concat(v.hidden || [])) { if (p.pts) p.pts = p.pts.map(T); if (p.center) { p.center = T(p.center); p.r *= f; } if (p.poly) p.poly = p.poly.map(T); if (p.beziers) p.beziers = p.beziers.map(b => b.map(T)); }
        // Schraffur dieser Ansicht mitskalieren
        if (dr.hatch) dr.hatch = dr.hatch.map(([a, b]) => { const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; return (m[0] > v.lo[0] - 1 && m[0] < v.hi[0] + 1 && m[1] > v.lo[1] - 1 && m[1] < v.hi[1] + 1) ? [T(a), T(b)] : [a, b]; });
        if (dr.hatchRegions) for (const hr of dr.hatchRegions) {
          const m = [(hr.lo[0] + hr.hi[0]) / 2, (hr.lo[1] + hr.hi[1]) / 2];
          if (m[0] > v.lo[0] - 1 && m[0] < v.hi[0] + 1 && m[1] > v.lo[1] - 1 && m[1] < v.hi[1] + 1) {
            for (const p of hr.prims) { if (p.pts) p.pts = p.pts.map(T); if (p.center) { p.center = T(p.center); p.r *= f; } if (p.poly) p.poly = p.poly.map(T); }
            hr.lo = T(hr.lo); hr.hi = T(hr.hi);
          }
        }
        v.eigenerMassstab = pv[i] * (dr.sheet_f || 1); v.blattBox = [v.lo.slice(), v.hi.slice()]; refresh(v);
        msgs.push(`Ansicht ${i + 1}: eigener Maßstab ${Ra.fmtScale(pv[i] * (dr.sheet_f || 1))} (auf ${Ra.fmtScale(s * (dr.sheet_f || 1))} umgerechnet)`);
      });
    } else [s, src] = Ra.voteScale(dr, views, vals);
    scaleSrc = src;
    Ra.snapGeometry(views, s, vals); views.forEach(refresh);
    msgs.push(`Maßstab: ${src}`); tol = 0.15;
  } else { s = dr.scale; tol = TOL; scaleSrc = dr.scale_src || ''; msgs.push(`Maßstab ${Ra.fmtScale(s)} (${dr.scale_src})`); }
  if (globalThis.DBG) for (const v of views) console.log('VIEW', JSON.stringify(v.prims.map(p=>[p.kind, p.r&&+p.r.toFixed(2), p.sweep&&+p.sweep.toFixed(2), (p.pts||[]).map(q=>q.map(x=>+x.toFixed(1)))])).slice(0,600), v.lo.map(x => x.toFixed(1)), v.hi.map(x => x.toFixed(1)), v.prims.length, v.prims.filter(p => p.kind === 'circle').map(c => c.r.toFixed(2) + '@' + c.center.map(x => x.toFixed(1))).join(' '));
  for (const v of views) { v.weak = v.prims.filter(p => p.weak); v.prims = v.prims.filter(p => !p.weak); }
  const layout = detectLayout(views);
  if (globalThis.DBG) console.log('LAYOUT', JSON.stringify(layout));
  const ctx = new Dm.Ctx(views, layout, s); ctx.tol = tol; ctx.phrases = dr.phrases; ctx.msgs = msgs; ctx.raster = raster; ctx.dr = dr;
  const sections = Sx.findSections(views, strokes, lab, hatch, msgs);
  for (const sec of sections) sec.hatch = hatch.filter(([a, b]) => { const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], v = views[sec.view]; return m[0] > v.lo[0] - 1 && m[0] < v.hi[0] + 1 && m[1] > v.lo[1] - 1 && m[1] < v.hi[1] + 1; });
  // Raster: vereinzelte „Schraffur“-Treffer (Textreste, Pfeile) sind kein Schnitt
  if (raster) for (let i = sections.length - 1; i >= 0; i--) { const v = views[sections[i].view]; const hasReg = (dr.hatchRegions || []).some(hr => hr.lo[0] > v.lo[0] - 1 && hr.hi[0] < v.hi[0] + 1 && hr.lo[1] > v.lo[1] - 1 && hr.hi[1] < v.hi[1] + 1); if (sections[i].hatch.length < 5 && !sections[i].letter && !hasReg) sections.splice(i, 1); }
  for (const sec of sections) { const v = views[sec.view]; sec.regions = (dr.hatchRegions || []).filter(hr => hr.lo[0] > v.lo[0] - 1 && hr.hi[0] < v.hi[0] + 1 && hr.lo[1] > v.lo[1] - 1 && hr.hi[1] < v.hi[1] + 1); }
  ctx.sections = sections;
  if (layout.typ === 'dreh') {
    const P = views[layout.profil]; const set = new Set();
    for (const p of P.prims) if (p.kind === 'line' || p.kind === 'arc') for (const q of p.pts) if (Math.abs(q[1] - layout.achse_y) > 0.05) set.add(Math.round(Math.abs(q[1] - layout.achse_y) / s * 1000) / 1000);
    layout.profil_radien = [...set].sort((a, b) => a - b);
  }
  const rollen = {};
  if (layout.typ === 'dreh') { rollen[layout.profil] = 'Profilansicht'; rollen[layout.kreis] = 'Stirnansicht (Kreise)'; }
  else for (const [r, n] of [['F', 'Vorderansicht'], ['T', 'Draufsicht'], ['S', 'Seitenansicht']]) if (layout[r] != null) rollen[layout[r]] = n;
  for (const sec of sections) {
    const nm = sec.letter ? `Schnitt ${sec.letter}-${sec.letter}` : 'Schnitt (ohne Bezeichnung)';
    rollen[sec.view] = `${nm} (${rollen[sec.view] || 'Ansicht'})`;
    const par = sec.parent != null ? (rollen[sec.parent] || 'Ansicht').replace(/ \(.*/, '') : null;
    msgs.push(`${nm}: ${sec.hatch.length} Schraffurlinien` + (sec.cut ? `, Schnittverlauf ${sec.cut.dir} in ${par || '?'}` : ', kein Schnittverlauf gefunden'));
  }
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
  const pmi = pmiItems(dims, an.faces, bbc, diag, bb);
  const stats = {}, estats = {};
  for (const f of an.faces) stats[f.typ] = (stats[f.typ] || 0) + 1;
  for (const e of an.edges) estats[e.typ] = (estats[e.typ] || 0) + 1;
  const viewBoxes = views.map((v, i) => ({ lo: r3(v.blattBox ? v.blattBox[0] : v.lo), hi: r3(v.blattBox ? v.blattBox[1] : v.hi), rolle: (rollen[i] || '') + (v.eigenerMassstab ? ` ${Ra.fmtScale(v.eigenerMassstab)}` : ''), art: sections.some(x => x.view === i) ? 'schnitt' : 'ansicht' }));
  for (const d of detailInfo) {
    const v = d.viewObj; viewBoxes.push({ lo: r3([d.cD[0] - d.rD, d.cD[1] - d.rD]), hi: r3([d.cD[0] + d.rD, d.cD[1] + d.rD]), rolle: `Einzelheit ${d.letter}${d.k ? ' (' + Ra.fmtScale(d.k) + ')' : ''}`, art: 'einzelheit' });
    viewBoxes.push({ lo: r3([d.cP[0] - d.rP, d.cP[1] - d.rP]), hi: r3([d.cP[0] + d.rP, d.cP[1] + d.rP]), rolle: d.letter, art: 'detailkreis' });
  }
  for (const sec of sections) if (sec.cut) viewBoxes.push({ lo: r3([Math.min(sec.cut.p0[0], sec.cut.p1[0]), Math.min(sec.cut.p0[1], sec.cut.p1[1])]), hi: r3([Math.max(sec.cut.p0[0], sec.cut.p1[0]), Math.max(sec.cut.p0[1], sec.cut.p1[1])]), rolle: sec.letter, art: 'schnittverlauf' });
  for (const d of dims) { delete d.linie; delete d.spitze; if (d.anker) for (const k in d.anker) if (typeof d.anker[k] === 'number') d.anker[k] = Math.round(d.anker[k] * 1000) / 1000; }
  const schnittKonturen = Sx.collectContours(views, sections, { tol, centers: dr.center, layout, scale: s });
  const schnittTiefe = Sx.suggestDepth(views, sections, s);
  return {
    solid, result: {
      ok: true, quelle: dr.kind, strategie: strategy, meldungen: msgs, aenderungen: aend, merkmale: feats, massstab: s, massstab_schriftfeld: dr.scale_txt ?? null, massstab_quelle: scaleSrc, dpi_bekannt: dr.dpi_known ?? null,
      volumen_mm3: Math.round(vol(solid) * 10) / 10, bbox: r3([x1 - x0, y1 - y0, z1 - z0]), bbox_lo: r3([x0, y0, z0]), gueltig,
      texte: (dr.phrases || []).map(p => p.text), ansichten: viewBoxes, schnitte: sections.map(x => ({ buchstabe: x.letter, ansicht: rollen[x.view], schraffurlinien: x.hatch.length, verlauf: x.cut ? x.cut.dir : null, eltern: x.parent != null ? rollen[x.parent] : null })), einzelheiten: detailInfo.map(d => ({ buchstabe: d.letter, massstab: d.k, vergroesserung: +d.ratio.toFixed(3) })), page_w: dr.page_w, page_h: dr.page_h, masse: dims, pmi, flaechen: an.faces, kanten: an.edges,
      flaechen_statistik: stats, kanten_statistik: estats, teil_typ: layout.typ, schnitt_konturen: schnittKonturen, schnitt_tiefe: schnittTiefe,
    }, mesh: an.mesh, edgeMesh: an.edgeMesh,
  };
}
