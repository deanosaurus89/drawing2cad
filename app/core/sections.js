// Schnitte (Schraffur, Schnittverlauf, Schnittbezeichnung) und Einzelheiten (Detailkreis, Maßstab) erkennen.
import { prim, sample, bbox, dist, Graph, pointInPoly, polyCrossY, loopItems, arcFrom3pts } from './geom.js';

const segDist = (p, a, b) => {
  const d = [b[0] - a[0], b[1] - a[1]]; const dd = Math.max(d[0] * d[0] + d[1] * d[1], 1e-12);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / dd));
  return Math.hypot(p[0] - (a[0] + t * d[0]), p[1] - (a[1] + t * d[1]));
};
export function distToPrim(q, p) {
  if (p.kind === 'line') return segDist(q, p.pts[0], p.pts[1]);
  if (p.kind === 'circle') return Math.abs(dist(q, p.center) - p.r);
  const s = sample(p, 24); let d = Infinity; for (let i = 1; i < s.length; i++) d = Math.min(d, segDist(q, s[i - 1], s[i])); return d;
}
const isHatchAngle = (a, b) => { let ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI; ang = ((ang % 180) + 180) % 180; return (ang > 25 && ang < 65) || (ang > 115 && ang < 155); };

/** Vektor: Schraffurlinien = schmale schräge Linien, deren beide Enden auf Körperkanten liegen. */
export function vectorHatch(thin, thick, tol = 0.35) {
  const out = [];
  const boxes = thick.map(bbox);
  const near = q => thick.some((p, i) => { const [lo, hi] = boxes[i]; if (q[0] < lo[0] - tol || q[0] > hi[0] + tol || q[1] < lo[1] - tol || q[1] > hi[1] + tol) return false; return distToPrim(q, p) < tol; });
  for (const p of thin) {
    if (p.kind !== 'line') continue; const [a, b] = p.pts; const L = dist(a, b);
    if (L < 0.8 || L > 150 || !isHatchAngle(a, b)) continue;
    if (near(a) && near(b)) out.push([a, b]);
  }
  return out;
}

/** Titel/Kennbuchstaben aus Textphrasen. */
export function parseLabels(phrases) {
  const sec = [], det = [], letters = [];
  for (const ph of phrases) {
    const t = ph.text.trim().replace(/[–—]/g, '-');
    let m;
    if ((m = t.match(/^(?:Schnitt\s*)?([A-Z])\s*-\s*([A-Z])$/)) && m[1] === m[2]) sec.push({ letter: m[1], at: [ph.x, ph.y], ph });
    else if ((m = t.match(/^(?:Einzelheit|Detail)?\s*([A-Z])\s*\(\s*(\d+(?:[.,]\d+)?)\s*:\s*(\d+(?:[.,]\d+)?)\s*\)$/))) det.push({ letter: m[1], k: parseFloat(m[2].replace(',', '.')) / parseFloat(m[3].replace(',', '.')), at: [ph.x, ph.y], ph });
    else if ((m = t.match(/^(?:Einzelheit|Detail)\s+([A-Z])$/))) det.push({ letter: m[1], k: null, at: [ph.x, ph.y], ph });
    else if ((m = t.match(/^([A-Z])$/))) letters.push({ letter: m[1], at: [ph.x, ph.y], ph });
  }
  return { sec, det, letters };
}
const boxDist = (p, v) => Math.hypot(Math.max(v.lo[0] - p[0], 0, p[0] - v.hi[0]), Math.max(v.lo[1] - p[1], 0, p[1] - v.hi[1]));

/**
 * Einzelheiten erkennen und aus der Ansichtsliste lösen.
 * views: Ansichten (Blatt-mm), circles: schmale Vollkreise, lab: parseLabels(...)
 * Liefert [{letter,k,view,cD,rD,cP,rP,parent}] – parent wird später (nach Ansichtszuordnung) gesetzt.
 */
export function findDetails(views, circles, lab, msgs) {
  const out = [];
  for (const t of lab.det) {
    // Detailansicht: nächstgelegene Ansicht zum Titel (Titel steht über/unter der Ansicht)
    let best = null;
    views.forEach((v, i) => { const d = boxDist(t.at, v); if (d < 25 && (!best || d < best[0])) best = [d, i]; });
    if (!best) { msgs.push(`Einzelheit ${t.letter}: keine zugehörige Ansicht gefunden.`); continue; }
    const v = views[best[1]];
    // Begrenzungskreis: schmaler Kreis, der die Detailansicht umschließt
    const bnd = circles.filter(c => c.r > 0.35 * Math.max(...v.size) && v.lo[0] >= c.center[0] - c.r - 1 && v.hi[0] <= c.center[0] + c.r + 1 && v.lo[1] >= c.center[1] - c.r - 1 && v.hi[1] <= c.center[1] + c.r + 1)
      .sort((a, b) => a.r - b.r)[0];
    if (!bnd) { msgs.push(`Einzelheit ${t.letter}: kein kreisförmiger Ausschnitt gefunden – Einzelheit wird nur angezeigt.`); continue; }
    // Detailkreis in der Elternansicht: schmaler Kreis mit gleichem Kennbuchstaben daneben
    let par = null;
    for (const c of circles) {
      if (c === bnd || c.r > bnd.r * 0.9) continue;
      const lt = lab.letters.filter(l => l.letter === t.letter && dist(l.at, c.center) < c.r + 10);
      if (!lt.length) continue;
      const ratio = bnd.r / c.r;
      const ok = !t.k || true; // Verhältnis wird gegen Maßstab geprüft, sobald der Hauptmaßstab bekannt ist
      const score = Math.min(...lt.map(l => dist(l.at, c.center) - c.r));
      if (ok && (!par || score < par[0])) par = [score, c, ratio];
    }
    if (!par) { msgs.push(`Einzelheit ${t.letter}: Detailkreis mit Kennbuchstabe „${t.letter}“ in der Hauptansicht nicht gefunden.`); continue; }
    out.push({ letter: t.letter, k: t.k, viewObj: v, cD: bnd.center, rD: bnd.r, cP: par[1].center, rP: par[1].r, ratio: par[2], title: t });
  }
  // Detailansichten aus der Liste entfernen
  const drop = new Set(out.map(d => d.viewObj));
  return [out, views.filter(v => !drop.has(v))];
}

function clipLineOutside(p, c, r) {
  const [a, b] = p.pts; const dx = b[0] - a[0], dy = b[1] - a[1]; const fx = a[0] - c[0], fy = a[1] - c[1];
  const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r; const disc = B * B - 4 * A * C;
  if (disc <= 0 || A < 1e-12) return [p];
  const t0 = (-B - Math.sqrt(disc)) / (2 * A), t1 = (-B + Math.sqrt(disc)) / (2 * A); const P = t => [a[0] + t * dx, a[1] + t * dy];
  const out = [];
  if (t0 > 1e-6) out.push(prim('line', { pts: [a, P(Math.min(1, t0))] }));
  if (t1 < 1 - 1e-6) out.push(prim('line', { pts: [P(Math.max(0, t1)), b] }));
  return out.filter(q => dist(q.pts[0], q.pts[1]) > 1e-4);
}
function clipLineInside(p, c, r) {
  const [a, b] = p.pts; const dx = b[0] - a[0], dy = b[1] - a[1]; const fx = a[0] - c[0], fy = a[1] - c[1];
  const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r; const disc = B * B - 4 * A * C;
  if (disc <= 0 || A < 1e-12) return null;
  const t0 = Math.max(0, (-B - Math.sqrt(disc)) / (2 * A)), t1 = Math.min(1, (-B + Math.sqrt(disc)) / (2 * A));
  if (t1 - t0 < 1e-6) return null;
  return prim('line', { pts: [[a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy]] });
}

/** Geometrie der Einzelheit in die Elternansicht übertragen (ersetzt Kontur innerhalb des Detailkreises). */
export function applyDetail(parent, det, snapTol) {
  const { cP, rP, cD, rD } = det; const f = rP / rD;
  const map = q => [cP[0] + (q[0] - cD[0]) * f, cP[1] + (q[1] - cD[1]) * f];
  const keep = [];
  for (const p of parent.prims) {
    if (p.kind === 'line') { keep.push(...clipLineOutside(p, cP, rP)); continue; }
    const s = sample(p, 12); const inside = s.filter(q => dist(q, cP) < rP).length;
    if (p.kind === 'circle' || inside < s.length / 2) keep.push(p);
  }
  const cutEnds = []; for (const p of keep) if (p.kind === 'line') for (const q of p.pts) if (Math.abs(dist(q, cP) - rP) < 1e-3) cutEnds.push(q);
  const add = [];
  for (const p of det.viewObj.prims) {
    let m;
    if (p.kind === 'line') { m = prim('line', { pts: p.pts.map(map) }); m = clipLineInside(m, cP, rP * (1 - 1e-6)); if (!m) continue; }
    else if (p.kind === 'arc') {
      m = prim('arc', { center: map(p.center), r: p.r * f, sweep: p.sweep, pts: p.pts.map(map) });
      if (dist(m.center, cP) > rP + m.r) continue;
    } else if (p.kind === 'circle') { m = prim('circle', { center: map(p.center), r: p.r * f }); if (dist(m.center, cP) > rP) continue; }
    else { m = prim('spline', p.beziers ? { beziers: p.beziers.map(b => b.map(map)) } : { poly: p.poly.map(map) }); }
    // Enden am Kreisrand auf die abgeschnittenen Enden der Hauptansicht ziehen
    if (m.pts) for (let i = 0; i < m.pts.length; i++) {
      const q = m.pts[i]; if (Math.abs(dist(q, cP) - rP) > Math.max(snapTol, 0.02 * rP)) continue;
      let bq = null; for (const e of cutEnds) { const d = dist(e, q); if (d < Math.max(3 * snapTol, 0.08 * rP) && (!bq || d < bq[0])) bq = [d, e]; }
      if (bq) m.pts[i] = bq[1].slice();
    }
    add.push(m);
  }
  parent.prims = keep.concat(add);
  return add.length;
}

/** Schnittverlauf aus kurzen breiten Strichen (Enden) neben einem Kennbuchstaben. */
export function findCutLine(strokes, lab, letter) {
  const ls = lab.letters.filter(l => l.letter === letter);
  const cands = strokes.filter(s => ls.some(l => boxDist(l.at, s) < 14));
  if (cands.length < 2) return null;
  // zwei Striche auf einer gemeinsamen Geraden
  let best = null;
  for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) {
    const a = cands[i], b = cands[j];
    const vert = Math.abs(a.c[0] - b.c[0]) < 1.0 && a.size[1] > a.size[0], hor = Math.abs(a.c[1] - b.c[1]) < 1.0 && a.size[0] > a.size[1];
    if (!vert && !hor) continue;
    const d = dist(a.c, b.c); if (!best || d > best[0]) best = [d, a, b, vert ? 'senkrecht' : 'waagerecht'];
  }
  if (!best) return null;
  const [, a, b, dir] = best;
  return { dir, p0: a.c, p1: b.c, pos: dir === 'senkrecht' ? (a.c[0] + b.c[0]) / 2 : (a.c[1] + b.c[1]) / 2 };
}

/** Ansicht, über deren Fläche der Schnittverlauf läuft. */
export function cutParent(views, cut) {
  let best = null;
  views.forEach((v, i) => {
    const inside = cut.dir === 'senkrecht' ? (cut.pos > v.lo[0] && cut.pos < v.hi[0] && Math.min(cut.p0[1], cut.p1[1]) < v.lo[1] && Math.max(cut.p0[1], cut.p1[1]) > v.hi[1])
      : (cut.pos > v.lo[1] && cut.pos < v.hi[1] && Math.min(cut.p0[0], cut.p1[0]) < v.lo[0] && Math.max(cut.p0[0], cut.p1[0]) > v.hi[0]);
    if (inside) { const a = v.size[0] * v.size[1]; if (!best || a < best[0]) best = [a, i]; }
  });
  return best ? best[1] : null;
}

/** Schnittansichten zuordnen: Titel „A-A“ -> Ansicht darunter/daneben, Schnittverlauf -> Elternansicht. */
export function findSections(views, strokes, lab, hatch, msgs) {
  const out = [];
  for (const t of lab.sec) {
    let best = null;
    views.forEach((v, i) => { const d = boxDist(t.at, v); const hatched = hatch.some(([a, b]) => { const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; return m[0] > v.lo[0] && m[0] < v.hi[0] && m[1] > v.lo[1] && m[1] < v.hi[1]; }); if (d < 20 && (!best || d - (hatched ? 5 : 0) < best[0])) best = [d - (hatched ? 5 : 0), i]; });
    if (!best) { msgs.push(`Schnitt ${t.letter}-${t.letter}: keine Ansicht unter der Bezeichnung gefunden.`); continue; }
    const cut = findCutLine(strokes, lab, t.letter);
    const parent = cut ? cutParent(views, cut) : null;
    out.push({ letter: t.letter, view: best[1], cut, parent, title: t });
  }
  // schraffierte Ansichten ohne Bezeichnung
  views.forEach((v, i) => {
    if (out.some(s => s.view === i)) return;
    const n = hatch.filter(([a, b]) => { const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; return m[0] > v.lo[0] && m[0] < v.hi[0] && m[1] > v.lo[1] && m[1] < v.hi[1]; }).length;
    if (n >= 3) out.push({ letter: null, view: i, cut: null, parent: null });
  });
  return out;
}

/** Schraffierte Flächen einer Primitivliste (Graph-Flächen mit Schraffur-Mittelpunkten). */
export function hatchedFaces(prims, hatch, tol) {
  const g = new Graph(prims, tol); const faces = g.faces();
  const mids = hatch.map(([a, b]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  const res = [];
  for (const f of faces) {
    let n = 0; for (const m of mids) if (pointInPoly(m, f.poly)) n++;
    if (n >= 1) res.push({ ...f, n });
  }
  // verschachtelte Flächen: kleinere Fläche innerhalb einer größeren mit Schraffur -> nur die innerste zählt
  return res;
}

/** Material entlang einer senkrechten Geraden x (Blatt) in den schraffierten Flächen: Liste [y0,y1]-Intervalle. */
export function materialAlong(faces, x) {
  const iv = [];
  for (const f of faces) { const ys = polyCrossY(f.poly, x); for (let i = 0; i + 1 < ys.length; i += 2) iv.push([ys[i], ys[i + 1]]); }
  return iv.sort((a, b) => a[0] - b[0]);
}

const r3p = p => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000];

/** Maßstabsfaktor aus „2:1“, „1:2“ oder einer Zahl. */
export function parseScaleText(text, fallback = null) {
  const t = String(text ?? '').trim().replace(',', '.');
  const m = t.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (m) { const a = parseFloat(m[1]), b = parseFloat(m[2]); if (a > 0 && b > 0) return a / b; }
  const v = parseFloat(t);
  return v > 0 ? v : fallback;
}
export function fmtScale(k) {
  if (!(k > 0)) return '–';
  return k >= 1 ? `${+k.toPrecision(6)}:1` : `1:${+(1 / k).toPrecision(6)}`;
}

export function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a[0] * b[1] - a[1] * b[0]; }
  return s / 2;
}
export function centroid(poly) {
  let a = 0, x = 0, y = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], c = p[0] * q[1] - q[0] * p[1];
    a += c; x += (p[0] + q[0]) * c; y += (p[1] + q[1]) * c;
  }
  if (Math.abs(a) < 1e-9) return poly.length ? poly[0].slice() : [0, 0];
  return [x / (3 * a), y / (3 * a)];
}

function sampleItemPts(it) {
  if (!it || !it.pts || !it.pts.length) return [];
  if (it.k === 'line') return it.pts.map(p => p.slice());
  if (it.k === 'arc' && it.pts.length >= 3) {
    const a = arcFrom3pts(it.pts[0], it.pts[1], it.pts[2]);
    if (a) return sample(a, 16);
  }
  return it.pts.map(p => p.slice());
}
export function polyFromItems(items) {
  const poly = [];
  for (const it of items) {
    const pts = sampleItemPts(it);
    if (!pts.length) continue;
    if (!poly.length) poly.push(pts[0]);
    for (let i = 1; i < pts.length; i++) poly.push(pts[i]);
  }
  if (poly.length > 1 && dist(poly[0], poly[poly.length - 1]) < 1e-4) poly.pop();
  return poly;
}
export function itemsFromPoly(poly) {
  const items = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if (dist(a, b) < 1e-4) continue;
    items.push({ k: 'line', pts: [a.slice(), b.slice()] });
  }
  return items;
}
export function closeItems(items) {
  if (!items || !items.length) return [];
  const out = items.map(it => ({ k: it.k, pts: it.pts.map(p => p.slice()) }));
  for (let i = 0; i < out.length; i++) {
    const prev = out[(i + out.length - 1) % out.length];
    const a = prev.pts[prev.pts.length - 1], b = out[i].pts[0];
    if (dist(a, b) > 1e-4 && dist(a, b) < 0.5) out[i].pts[0] = a.slice();
  }
  const a = out[0].pts[0], b = out[out.length - 1].pts[out[out.length - 1].pts.length - 1];
  if (dist(a, b) > 1e-3) out.push({ k: 'line', pts: [b.slice(), a.slice()] });
  return out;
}
export function orientItems(items, positive = true) {
  const s = signedArea(polyFromItems(items));
  if (Math.abs(s) < 1e-8) return items;
  if ((s > 0) === positive) return items;
  const rev = [];
  for (let i = items.length - 1; i >= 0; i--) rev.push({ k: items[i].k, pts: items[i].pts.map(p => p.slice()).reverse() });
  return rev;
}
function decimate(poly, tol = 0.15) {
  if (poly.length < 4) return poly.map(p => p.slice());
  const out = [poly[0].slice()];
  for (let i = 1; i < poly.length; i++) if (dist(out[out.length - 1], poly[i]) >= tol) out.push(poly[i].slice());
  if (out.length > 2 && dist(out[0], out[out.length - 1]) < tol) out.pop();
  return out.length >= 3 ? out : poly.map(p => p.slice());
}
function overlayPoly(items) { return decimate(polyFromItems(items), 0.2); }

/** Geschlossene Bahnen der Schnittansicht. Schraffur bewertet, filtert aber nicht hart:
 *  unschraffierte Nachbarflächen (Bohrung, Einstich) bleiben Kandidaten, damit die falsche Bahn abgewählt werden kann. */
export function proposeContours(prims, hatch, tol = 0.08) {
  let faces = [];
  try { faces = new Graph(prims, tol).faces(); } catch (e) { return []; }
  const mids = (hatch || []).map(([a, b]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  const out = [];
  for (const f of faces) {
    if (f.area < 2) continue;
    let n = 0; for (const m of mids) if (pointInPoly(m, f.poly)) n++;
    let items; try { items = loopItems(f.loop); } catch (e) { continue; }
    if (!items.length) continue;
    const poly = overlayPoly(items);
    if (poly.length < 3) continue;
    out.push({ items, poly, area: f.area, hatch: n, density: n / Math.max(f.area, 1e-6), quelle: 'kante' });
  }
  return out;
}

export function contourFromRegion(hr) {
  const items = [];
  for (const p of hr.prims || []) {
    if (p.kind === 'line') items.push({ k: 'line', pts: [p.pts[0].slice(), p.pts[1].slice()] });
    else if (p.kind === 'arc') { const sp = sample(p, 12); items.push({ k: 'arc', pts: [sp[0], sp[Math.floor(sp.length / 2)], sp[sp.length - 1]] }); }
    else { const sp = p.poly ? p.poly.map(q => q.slice()) : sample(p, 24); items.push({ k: 'spline', pts: sp }); }
  }
  if (!items.length) return null;
  const poly = overlayPoly(items);
  if (poly.length < 3) return null;
  const area = hr.area || Math.abs(signedArea(poly));
  const hatch = hr.n || 0;
  return { items, poly, area, hatch, density: hatch / Math.max(area, 1e-6), quelle: 'region' };
}

function rankContours(list) {
  const dedup = [];
  for (const c of list) {
    if (!c || !c.poly || c.poly.length < 3 || c.area < 2) continue;
    const cen = centroid(c.poly);
    const hit = dedup.find(d => Math.abs(d.area - c.area) / Math.max(d.area, 1) < 0.05 && dist(centroid(d.poly), cen) < 1.8);
    if (!hit) dedup.push(c);
    else if (c.hatch > hit.hatch || (c.hatch === hit.hatch && c.quelle === 'region' && hit.quelle !== 'region')) Object.assign(hit, c);
  }
  dedup.sort((a, b) => b.hatch - a.hatch || b.density - a.density || b.area - a.area);
  const hat = dedup.filter(c => c.hatch > 0), rest = dedup.filter(c => !c.hatch);
  return hat.concat(rest).slice(0, 8);
}

function roundItems(items) { return items.map(it => ({ k: it.k, pts: it.pts.map(r3p) })); }

/** Rotationsachse: Mittellinie in der Ansicht, sonst Symmetrie / erkannte Drehachse. */
export function proposeAxis(view, centers, layout) {
  const lines = (centers || []).filter(p => p.kind === 'line' && p.pts && p.pts.length >= 2);
  const cands = [];
  for (const p of lines) {
    const [a, b] = p.pts;
    const horiz = Math.abs(a[1] - b[1]) < 0.6, vert = Math.abs(a[0] - b[0]) < 0.6;
    if (!horiz && !vert) continue;
    const span = dist(a, b); if (span < Math.max(view.size[0], view.size[1]) * 0.35) continue;
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const pad = 8;
    if (mid[0] < view.lo[0] - pad || mid[0] > view.hi[0] + pad || mid[1] < view.lo[1] - pad || mid[1] > view.hi[1] + pad) continue;
    cands.push({ p0: a.slice(), p1: b.slice(), span, horiz, quelle: 'mittellinie' });
  }
  let best = null;
  const pool = layout && layout.typ === 'dreh' && cands.some(c => c.horiz) ? cands.filter(c => c.horiz) : cands;
  for (const c of pool) if (!best || c.span > best.span) best = c;
  if (best) return { p0: r3p(best.p0), p1: r3p(best.p1), quelle: best.quelle };
  let y = (view.lo[1] + view.hi[1]) / 2, quelle = 'ansichtsmitte';
  if (layout && layout.typ === 'dreh' && layout.achse_y >= view.lo[1] - 1 && layout.achse_y <= view.hi[1] + 1) { y = layout.achse_y; quelle = 'symmetrie'; }
  return { p0: r3p([view.lo[0], y]), p1: r3p([view.hi[0], y]), quelle };
}

/** Kandidaten je Schnittansicht, bester (meiste Schraffur) zuerst und als vorschlag markiert. */
export function collectContours(views, sections, opt = {}) {
  const out = []; let n = 0;
  for (const sec of sections || []) {
    const v = views[sec.view]; if (!v) continue;
    const raw = proposeContours(v.prims, sec.hatch || [], opt.tol ?? 0.08);
    for (const hr of sec.regions || []) { const c = contourFromRegion(hr); if (c) raw.push(c); }
    const ranked = rankContours(raw);
    if (!ranked.length) continue;
    const achse = proposeAxis(v, opt.centers, opt.layout);
    ranked.forEach((c, i) => {
      n++;
      const items = closeItems(roundItems(c.items));
      out.push({
        id: 'K' + n, ansicht: sec.view, buchstabe: sec.letter || null,
        items, poly: overlayPoly(items).map(r3p),
        flaeche: +c.area.toFixed(1), schraffur: c.hatch,
        vorschlag: i === 0, achse, quelle: c.quelle || 'kante',
      });
    });
  }
  const props = out.filter(c => c.vorschlag);
  if (props.length > 1) {
    props.sort((a, b) => b.schraffur - a.schraffur || b.flaeche - a.flaeche);
    for (const p of props.slice(1)) p.vorschlag = false;
  }
  return out;
}

/** Plattendicke aus einer benachbarten Ansicht gleicher Breite/Höhe, in Modell-mm. */
export function suggestDepth(views, sections, scale) {
  if (!sections || !sections.length || !(scale > 0)) return null;
  const vi = sections[0].view, v = views[vi]; if (!v) return null;
  let best = null, score = -1;
  views.forEach((w, i) => {
    if (i === vi) return;
    const sx = Math.abs(w.size[0] - v.size[0]) / Math.max(v.size[0], 1e-6);
    const sy = Math.abs(w.size[1] - v.size[1]) / Math.max(v.size[1], 1e-6);
    let d, sc;
    if (sx < 0.12) { d = w.size[1]; sc = 2; }
    else if (sy < 0.12) { d = w.size[0]; sc = 2; }
    else { d = Math.min(w.size[0], w.size[1]); sc = 1; }
    if (sc > score && d > 0.5) { score = sc; best = d / scale; }
  });
  return best ? +best.toFixed(2) : null;
}

function clipHalf(poly) {
  const out = []; const inside = p => p[1] >= -1e-7;
  const inter = (a, b) => { const t = (0 - a[1]) / (b[1] - a[1] || 1e-12); return [a[0] + t * (b[0] - a[0]), 0]; };
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const inA = inside(a), inB = inside(b);
    if (inA && inB) out.push(b.slice());
    else if (inA && !inB) out.push(inter(a, b));
    else if (!inA && inB) { out.push(inter(a, b)); out.push(b.slice()); }
  }
  return out.filter((p, i, arr) => i === 0 || dist(p, arr[i - 1]) > 1e-6);
}
function pappus(poly) {
  let Mr = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, r1] = poly[i], [x2, r2] = poly[(i + 1) % poly.length];
    const cr = x1 * r2 - x2 * r1; Mr += (r1 + r2) * cr / 6;
  }
  return Math.abs(2 * Math.PI * Mr);
}
function mapFrame(axis) {
  const p0 = axis && axis.p0, p1 = axis && axis.p1;
  if (!p0 || !p1) throw new Error('Rotationsachse fehlt.');
  let ux = p1[0] - p0[0], uy = p1[1] - p0[1]; const L = Math.hypot(ux, uy);
  if (L < 1e-4) throw new Error('Rotationsachse ist zu kurz.');
  ux /= L; uy /= L; const nx = -uy, ny = ux;
  return q => [((q[0] - p0[0]) * ux + (q[1] - p0[1]) * uy), ((q[0] - p0[0]) * nx + (q[1] - p0[1]) * ny)];
}
function reflectR(items) { return items.map(it => ({ k: it.k, pts: it.pts.map(p => [p[0], -p[1]]) })); }
function sideArea(items) {
  const poly = polyFromItems(items);
  return { up: Math.abs(signedArea(clipHalf(poly))), dn: Math.abs(signedArea(clipHalf(poly.map(p => [p[0], -p[1]])))) };
}
function crosses(items) {
  let neg = false, pos = false;
  for (const q of polyFromItems(items)) { if (q[1] > 0.05) pos = true; else if (q[1] < -0.05) neg = true; }
  return neg && pos;
}

/** Bestätigte Kontur + Achse + Maßstab -> Rotationsprofil in der Ebene (x axial, r ≥ 0), Modell-mm.
 *  side: 'auto' | 1 | -1. Volumen über die Guldinsche Regel (Näherung bei Bögen). */
export function revolveProfile(items, axis, scale, side = 'auto') {
  if (!(scale > 0)) throw new Error('Maßstab muss größer als 0 sein.');
  if (!items || !items.length) throw new Error('Keine Schnittkontur.');
  const map = mapFrame(axis);
  let mapped = closeItems(items).map(it => ({ k: it.k, pts: it.pts.map(p => { const q = map(p); return [q[0] / scale, q[1] / scale]; }) }));
  const areas = sideArea(mapped);
  let used = side === 'auto' || side == null ? (areas.dn > areas.up * 1.02 ? -1 : 1) : (side < 0 ? -1 : 1);
  if (used < 0) mapped = reflectR(mapped);
  if (crosses(mapped)) {
    const clipped = clipHalf(polyFromItems(mapped));
    if (clipped.length < 3) throw new Error('Kontur liegt nicht auf einer Seite der Achse.');
    mapped = itemsFromPoly(clipped);
  }
  mapped = orientItems(closeItems(mapped), true);
  const poly = polyFromItems(mapped);
  if (poly.length < 3 || Math.abs(signedArea(poly)) < 0.05) throw new Error('Schnittkontur hat keine Fläche.');
  const rs = poly.map(p => p[1]);
  const rmin = Math.max(0, Math.min(...rs)), rmax = Math.max(...rs);
  if (rmax < 0.05) throw new Error('Kontur liegt auf der Achse – nichts zu rotieren.');
  return { items: mapped, side: used, rmin, rmax, area: Math.abs(signedArea(poly)), volume: pappus(poly) };
}
