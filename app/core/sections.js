// Schnitte (Schraffur, Schnittverlauf, Schnittbezeichnung) und Einzelheiten (Detailkreis, Maßstab) erkennen.
import { prim, sample, bbox, dist, Graph, pointInPoly, polyCrossY } from './geom.js';

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
