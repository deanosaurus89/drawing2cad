// Vektor-PDF (über pdf.js-Operatorliste) -> Zeichnungs-Zwischenformat (Port von backend/vector_in.py).
import { vectorHatch } from './sections.js';
import { prim, bezierAsArc, bbox, dist, ReconError, TAU } from './geom.js';

export const PT = 25.4 / 72;
export const SCALE_RE = /(?:Maßstab|Massstab|MaBstab|Scale|M)\s*:?\s*(\d+(?:[.,]\d+)?)\s*:\s*(\d+(?:[.,]\d+)?)/;
const OPS = { setLineWidth: 2, setDash: 6, save: 10, restore: 11, transform: 12, moveTo: 13, lineTo: 14, curveTo: 15, curveTo2: 16, curveTo3: 17,
  closePath: 18, rectangle: 19, stroke: 20, closeStroke: 21, fill: 22, eoFill: 23, fillStroke: 24, eoFillStroke: 25, closeFillStroke: 26,
  closeEOFillStroke: 27, endPath: 28, paintImageXObject: 85, paintInlineImageXObject: 86, paintImageMaskXObject: 83, constructPath: 91 };

const mmul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];

/** Zeichenpfade aus der Operatorliste (wie PyMuPDF get_drawings). */
export function extractDrawings(ol) {
  const out = []; let images = 0;
  let gs = { ctm: [1, 0, 0, 1, 0, 0], width: 1, dash: [] }; const stack = [];
  let items = [], cur = null, startPt = null;
  const P = (x, y) => { const m = gs.ctm; return [(m[0] * x + m[2] * y + m[4]) * PT, (m[1] * x + m[3] * y + m[5]) * PT]; };
  const scaleW = w => w * Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2]));
  const pathOp = (op, a, i) => {
    switch (op) {
      case OPS.moveTo: cur = P(a[i], a[i + 1]); startPt = cur; return 2;
      case OPS.lineTo: { const q = P(a[i], a[i + 1]); items.push(['l', cur, q]); cur = q; return 2; }
      case OPS.curveTo: { const c1 = P(a[i], a[i + 1]), c2 = P(a[i + 2], a[i + 3]), q = P(a[i + 4], a[i + 5]); items.push(['c', cur, c1, c2, q]); cur = q; return 6; }
      case OPS.curveTo2: { const c2 = P(a[i], a[i + 1]), q = P(a[i + 2], a[i + 3]); items.push(['c', cur, cur, c2, q]); cur = q; return 4; }
      case OPS.curveTo3: { const c1 = P(a[i], a[i + 1]), q = P(a[i + 2], a[i + 3]); items.push(['c', cur, c1, q, q]); cur = q; return 4; }
      case OPS.closePath: if (cur && startPt && dist(cur, startPt) > 1e-6) items.push(['l', cur, startPt]); cur = startPt; return 0;
      case OPS.rectangle: { const x = a[i], y = a[i + 1], w = a[i + 2], h = a[i + 3];
        const c = [P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h)];
        for (let k = 0; k < 4; k++) items.push(['l', c[k], c[(k + 1) % 4]]); cur = c[0]; startPt = c[0]; return 4; }
    }
    return 0;
  };
  const paint = type => { if (items.length) out.push({ type, items, width: scaleW(gs.width) * PT, dash: gs.dash.map(scaleW) }); items = []; };
  for (let k = 0; k < ol.fnArray.length; k++) {
    const fn = ol.fnArray[k], args = ol.argsArray[k];
    switch (fn) {
      case OPS.save: stack.push({ ...gs, dash: gs.dash.slice() }); break;
      case OPS.restore: gs = stack.pop() || gs; break;
      case OPS.transform: gs.ctm = mmul(args, gs.ctm); break;
      case OPS.setLineWidth: gs.width = args[0]; break;
      case OPS.setDash: gs.dash = Array.from(args[0] || []); break;
      case OPS.constructPath: {
        const ops = args[0], co = args[1]; let j = 0;
        for (const op of ops) j += pathOp(op, co, j);
        break;
      }
      case OPS.moveTo: case OPS.lineTo: case OPS.curveTo: case OPS.curveTo2: case OPS.curveTo3: case OPS.closePath: case OPS.rectangle:
        pathOp(fn, args || [], 0); break;
      case OPS.stroke: paint('s'); break;
      case OPS.closeStroke: pathOp(OPS.closePath, [], 0); paint('s'); break;
      case OPS.fill: case OPS.eoFill: paint('f'); break;
      case OPS.fillStroke: case OPS.eoFillStroke: paint('fs'); break;
      case OPS.closeFillStroke: case OPS.closeEOFillStroke: pathOp(OPS.closePath, [], 0); paint('fs'); break;
      case OPS.endPath: items = []; break;
      case OPS.paintImageXObject: case OPS.paintInlineImageXObject: case OPS.paintImageMaskXObject: images++; break;
    }
  }
  return { drawings: out, images };
}

export function pdfIsRaster(ex) {
  const n = ex.drawings.filter(d => d.type === 's' || d.type === 'fs').length;
  return n < 10 && ex.images > 0;
}

/** pdf.js-Textinhalt -> Phrasen (Zeilen) in Blatt-mm, y nach oben. */
export function extractPhrases(tc) {
  const phrases = []; let full = [];
  for (const it of tc.items) {
    const t = (it.str || '').trim(); full.push(it.str || '');
    if (!t) continue;
    const [a, b, , , e, f] = it.transform; const fs = Math.hypot(a, b) || it.height || 10;
    const vert = Math.abs(a) < 0.5 * fs;
    const w = it.width || 0;
    let lo, hi;
    if (!vert) { lo = [e, f - 0.22 * fs]; hi = [e + w, f + 0.9 * fs]; }
    else if (b > 0) { lo = [e - 0.9 * fs, f]; hi = [e + 0.22 * fs, f + (it.width > 0 ? Math.abs(w) : 0)]; if (Math.abs(it.height) > Math.abs(w) && !it.width) hi[1] = f + it.height; }
    else { lo = [e - 0.22 * fs, f - Math.abs(w)]; hi = [e + 0.9 * fs, f]; }
    // pdf.js liefert width bei gedrehtem Text entlang der Schreibrichtung (in Benutzereinheiten)
    if (vert && b > 0 && it.height && Math.abs(it.width) < 1e-6) hi[1] = f + it.height;
    lo = lo.map(v => v * PT); hi = hi.map(v => v * PT);
    phrases.push({ text: t, lo, hi, x: (lo[0] + hi[0]) / 2, y: (lo[1] + hi[1]) / 2, vertikal: vert });
  }
  return { phrases, full: full.join(' ') };
}

export function readPdfVector(ex, tcRes, pageW, pageH) {
  const drawings = ex.drawings;
  const stroked = drawings.filter(d => d.type === 's' || d.type === 'fs');
  if (!stroked.length) throw new ReconError('Keine Vektorgeometrie gefunden.');
  const isDashed = d => d.dash && d.dash.length > 0 && d.dash.some(x => x > 0);
  const widths = stroked.filter(d => !isDashed(d)).map(d => d.width);
  const wmax = widths.length ? Math.max(...widths) : 0;
  const thr = wmax >= 0.55 ? Math.max(0.55, 0.8 * wmax) : 0.8 * wmax;
  const msgs = [];
  if (wmax < 0.55) msgs.push('Hinweis: Keine breiten Linien (≥0,5 mm) gefunden – Linienarten werden nur relativ unterschieden.');
  const pw = pageW * PT, ph = pageH * PT;
  const thick = [], thin = [], hidden = [], center = [];
  for (const d of stroked) {
    const prims = [];
    for (const it of d.items) {
      if (it[0] === 'l') prims.push(prim('line', { pts: [it[1], it[2]] }));
      else if (it[0] === 'c') {
        const b = it.slice(1, 5); const a = bezierAsArc(b); const last = prims[prims.length - 1];
        if (a) {
          const [c, r, sw] = a;
          if (last && last.kind === 'arc' && dist(last.center, c) < 0.05 && Math.abs(last.r - r) < 0.05 && dist(last.pts[1], b[0]) < 0.05 && Math.sign(last.sweep) === Math.sign(sw)) {
            last.sweep += sw; last.pts[1] = b[3];
          } else prims.push(prim('arc', { center: c, r, sweep: sw, pts: [b[0], b[3]] }));
        } else if (last && last.kind === 'spline' && dist(last.beziers[last.beziers.length - 1][3], b[0]) < 0.05) last.beziers.push(b);
        else prims.push(prim('spline', { beziers: [b] }));
      }
    }
    const out = [];
    for (let p of prims) {
      if (p.kind === 'arc' && Math.abs(Math.abs(p.sweep) - TAU) < 0.01) p = prim('circle', { center: p.center, r: p.r });
      if (p.kind === 'line' && dist(p.pts[0], p.pts[1]) < 1e-3) continue;
      out.push(p);
    }
    const dashed = isDashed(d);
    const longDash = dashed && (d.dash.length >= 4 || Math.max(...d.dash) * PT > 6);
    for (const p of out) {
      const [lo, hi] = bbox(p);
      if (hi[0] - lo[0] > 0.8 * pw || hi[1] - lo[1] > 0.8 * ph) continue;
      if (dashed) (longDash ? center : hidden).push(p);
      else if (d.width >= thr - 1e-6) thick.push(p);
      else thin.push(p);
    }
  }
  // Maßpfeile (gefüllte Dreiecke)
  const arrows = [];
  for (const d of drawings) {
    if (d.type !== 'f') continue;
    const pts = []; for (const it of d.items) if (it[0] === 'l') pts.push(it[1], it[2]);
    const uniq = []; for (const p of pts) if (!uniq.some(q => dist(p, q) < 0.05)) uniq.push(p);
    if (uniq.length !== 3) continue;
    const angs = [0, 1, 2].map(i => {
      const a = [uniq[(i + 1) % 3][0] - uniq[i][0], uniq[(i + 1) % 3][1] - uniq[i][1]], b = [uniq[(i + 2) % 3][0] - uniq[i][0], uniq[(i + 2) % 3][1] - uniq[i][1]];
      return Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / Math.hypot(...a) / Math.hypot(...b))));
    });
    const i = angs.indexOf(Math.min(...angs)); const tip = uniq[i];
    const base = [(uniq[(i + 1) % 3][0] + uniq[(i + 2) % 3][0]) / 2, (uniq[(i + 1) % 3][1] + uniq[(i + 2) % 3][1]) / 2];
    const L = dist(tip, base); if (L > 6) continue;
    arrows.push({ tip, dir: [(tip[0] - base[0]) / L, (tip[1] - base[1]) / L] });
  }
  const { phrases, full } = tcRes;
  let scale = 1, src = 'Annahme 1:1';
  const m = full.match(SCALE_RE);
  if (m) { scale = parseFloat(m[1].replace(',', '.')) / parseFloat(m[2].replace(',', '.')); src = 'Schriftfeld'; }
  else msgs.push('Kein Maßstab im Schriftfeld gefunden – nehme 1:1 an.');
  const hatch = vectorHatch(thin, thick);
  const thinCircles = thin.filter(p => p.kind === 'circle');
  return { kind: 'vektor', thick, thin, hidden, center, arrows, phrases, scale, scale_src: src, msgs, page_w: pw, page_h: ph, hatch, thinCircles, strokes: [] };
}
