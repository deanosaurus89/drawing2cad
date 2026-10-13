// Rasterbild (Scan/Foto/Bild-PDF) -> Zeichnungs-Zwischenformat (Port von backend/raster_in.py, ohne OpenCV).
import { prim, arcFrom3pts, ReconError, cross2, solve2, dist } from './geom.js';
import * as I from './imgops.js';
import { SCALE_RE } from './pdfin.js';

export function normOcr(t) {
  t = t.trim();
  t = t.replace(/^[@©®⌀Q¢]/, 'Ø');
  t = t.replace(/(?<![\p{L}\p{N}_])[@©®⌀¢](?=\d)/gu, 'Ø');
  t = t.replace(/(?<![\p{L}\p{N}_,.])[Oo](?=\d)/gu, 'Ø');
  t = t.replace(/(?<![\p{L}\p{N}_,.])0(?=[1-9]\d)/gu, 'Ø');
  t = t.replace(/^D(?=\d)/, 'Ø');
  return t.replace(/—/g, '-').replace(/–/g, '-');
}

/** Stufe 1: Binarisieren, Rauschen entfernen, Nur-Text-Bild für OCR erzeugen. */
export function prepare(gray, W, H, dpi) {
  const u = 25.4 / (dpi || 300); const f = (dpi || 300) / 300;
  const g = I.gaussBlur3(gray, W, H); const thr = I.otsu(g);
  let ink = new Uint8Array(W * H); for (let i = 0; i < ink.length; i++) ink[i] = g[i] <= thr ? 1 : 0;
  if (f > 0.8) ink = I.open2x2(ink, W, H);
  let cc = I.components(ink, W, H, 8);
  const minA = Math.max(2, Math.round(8 * f * f));
  for (let i = 0; i < ink.length; i++) if (cc.lab[i] && cc.stats[cc.lab[i]][4] < minA) ink[i] = 0;
  cc = I.components(ink, W, H, 8);
  const small = new Uint8Array(cc.n);
  for (let i = 1; i < cc.n; i++) { const s = cc.stats[i]; if (Math.max(s[2], s[3]) * u < 5.5 && s[4] > 10 * f * f) small[i] = 1; }
  const txt = new Uint8Array(W * H).fill(255);
  for (let i = 0; i < ink.length; i++) if (cc.lab[i] && small[cc.lab[i]]) txt[i] = 0;
  return { ink, txt, u, f, W, H };
}

/** Tesseract-Ergebnis (Zeilen mit Wörtern, je Durchgang) -> Phrasen + Wortboxen (Port der OCR-Gruppierung). */
export function phrasesFromOcr(passes, u, W, H) {
  const phrases = [], boxes = [];
  for (const { rot, lines, imgH } of passes) {
    for (const ln of lines) {
      const g = [];
      for (const w of ln.words) {
        const t = (w.text || '').trim(); if (!t) continue;
        const conf = w.confidence; const { x0, y0, x1, y1 } = w.bbox;
        if (y1 - y0 > 0.03 * imgH) continue;
        // gedrehtes Bild (90° im Uhrzeigersinn): (xr, yr) -> Original (x = yr, y = H-1-xr)
        const bx = rot === 0 ? [x0, y0, x1, y1] : [y0, H - 1 - x1, y1, H - 1 - x0];
        if (conf > 50 && /[A-Za-z0-9ØÄÖÜäöüß°±]/.test(t)) boxes.push(bx);
        if (conf < 40) continue;
        if (rot !== 0 && !/\d/.test(t)) continue;
        g.push([x0, t, bx]);
      }
      if (!g.length) continue;
      g.sort((a, b) => a[0] - b[0]);
      let text = normOcr(g.map(z => z[1]).join(' '));
      const X0 = Math.min(...g.map(z => z[2][0])), Y0 = Math.min(...g.map(z => z[2][1])), X1 = Math.max(...g.map(z => z[2][2])), Y1 = Math.max(...g.map(z => z[2][3]));
      if (rot !== 0 && !/\d/.test(text)) continue;
      // senkrecht geschriebene Durchmesser: OCR liest „Ø“ oft als „8“ (Ø10 -> 810, Ø8 -> 88)
      if (rot !== 0 && /^8\d{1,2}$/.test(text)) { text = 'Ø' + text.slice(1); }
      const ph = { text, lo: [X0 * u, (H - Y1) * u], hi: [X1 * u, (H - Y0) * u], x: (X0 + X1) / 2 * u, y: (H - (Y0 + Y1) / 2) * u, vertikal: rot !== 0 };
      if (rot !== 0 && phrases.some(p => Math.abs(p.x - ph.x) < 3 && Math.abs(p.y - ph.y) < 3)) continue;
      phrases.push(ph);
    }
  }
  return { phrases, boxes };
}

function kmeans1d(x) {
  const s = Float64Array.from(x).sort(); const pct = q => s[Math.min(s.length - 1, Math.floor(q / 100 * (s.length - 1)))];
  let c1 = pct(20), c2 = pct(90);
  for (let it = 0; it < 30; it++) {
    let a = 0, na = 0, b = 0, nb = 0;
    for (const v of x) { if (Math.abs(v - c1) < Math.abs(v - c2)) { a += v; na++; } else { b += v; nb++; } }
    if (!na || !nb) break; c1 = a / na; c2 = b / nb;
  }
  return [c1, c2];
}

function dashLines(thin, W, H, u) {
  const { n, stats } = I.components(thin, W, H, 8);
  const dashes = [];
  for (let i = 1; i < n; i++) {
    const [x, y, w, h] = stats[i]; const Lw = w * u, Lh = h * u;
    if (Lw >= 0.7 && Lw <= 5 && Lh < 1.0) dashes.push(['h', y + h / 2, x, x + w]);
    else if (Lh >= 0.7 && Lh <= 5 && Lw < 1.0) dashes.push(['v', x + w / 2, y, y + h]);
  }
  const lines = [];
  for (const o of ['h', 'v']) {
    const ds = dashes.filter(d => d[0] === o).sort((a, b) => a[1] - b[1] || a[2] - b[2]);
    const used = new Uint8Array(ds.length);
    for (let i = 0; i < ds.length; i++) {
      if (used[i]) continue;
      const chain = [ds[i]]; used[i] = 1; let changed = true;
      while (changed) {
        changed = false;
        for (let j = 0; j < ds.length; j++) {
          const e = ds[j]; if (used[j] || Math.abs(e[1] - chain[0][1]) > 0.6 / u) continue;
          const lo = Math.min(...chain.map(c => c[2])), hi = Math.max(...chain.map(c => c[3]));
          if ((-2.6 / u < e[2] - hi && e[2] - hi < 2.6 / u) || (-2.6 / u < lo - e[3] && lo - e[3] < 2.6 / u)) { chain.push(e); used[j] = 1; changed = true; }
        }
      }
      if (chain.length < 2) continue;
      const k = chain.reduce((s, c) => s + c[1], 0) / chain.length, lo = Math.min(...chain.map(c => c[2])), hi = Math.max(...chain.map(c => c[3]));
      if (o === 'h') lines.push(prim('line', { pts: [[lo * u, (H - k) * u], [hi * u, (H - k) * u]] }));
      else lines.push(prim('line', { pts: [[k * u, (H - lo) * u], [k * u, (H - hi) * u]] }));
    }
  }
  return lines;
}

/** Geschlossene Pixelkontur -> geschlossene Primitive (Blatt-mm). */
export function fitContour(cnt, u, H, pxEps = 0.8, shortMm = 3.5) {
  const P = cnt.map(([x, y]) => [x * u, (H - y) * u]); const n = P.length;
  if (n < 8) return [];
  {
    const [c, r, rms] = I.fitCircle(P);
    if (rms < Math.max(0.06, (r < 5 ? 0.035 : 0.012) * r) && r > 0.5) {
      let tot = 0, prev = Math.atan2(P[0][1] - c[1], P[0][0] - c[0]);
      for (let i = 1; i < n; i++) { const a = Math.atan2(P[i][1] - c[1], P[i][0] - c[0]); let d = a - prev; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; tot += d; prev = a; }
      if (Math.abs(tot) > 1.9 * Math.PI) return [prim('circle', { center: c, r })];
    }
    // kleine Kreise mit angesetzten Stummeln (Mittellinien/Bezugslinien): robust nachfitten
    if (r > 0.8 && r < 5) {
      const inl = P.filter(q => Math.abs(Math.hypot(q[0] - c[0], q[1] - c[1]) - r) < 0.15);
      if (inl.length >= 0.8 * n) {
        const [c2, r2, rms2] = I.fitCircle(inl);
        const ang = new Set(inl.map(q => Math.floor((Math.atan2(q[1] - c2[1], q[0] - c2[0]) + Math.PI) / (Math.PI / 8))));
        if (rms2 < 0.035 * r2 && ang.size >= 15) return [prim('circle', { center: c2, r: r2 })];
      }
    }
  }
  // schwacher Kreis: Bohrung mit angesetzten Mittel-/Hinweislinien (nur für Lochbild-/Mustererkennung, recon prüft gegen Maße)
  {
    const bx = [Math.min(...P.map(q => q[0])), Math.max(...P.map(q => q[0]))], by = [Math.min(...P.map(q => q[1])), Math.max(...P.map(q => q[1]))];
    let [c, r] = I.fitCircle(P);
    for (let it = 0; it < 4; it++) {
      const res = P.map(q => Math.abs(Math.hypot(q[0] - c[0], q[1] - c[1]) - r)); const srt = [...res].sort((a, b) => a - b);
      const th = Math.max(0.08, srt[Math.floor(srt.length * 0.6)] * 1.5); const S = P.filter((q, k) => res[k] < th); if (S.length < 8) break; [c, r] = I.fitCircle(S);
    }
    const inl = P.filter(q => Math.abs(Math.hypot(q[0] - c[0], q[1] - c[1]) - r) < 0.08);
    const bins = new Set(inl.map(q => Math.floor((Math.atan2(q[1] - c[1], q[0] - c[0]) + Math.PI) / (Math.PI / 8))));
    if (r > 0.8 && r < 12 && inl.length >= 0.35 * n && bins.size >= 10 && bx[1] - bx[0] < 2.6 * r && by[1] - by[0] < 2.6 * r && bx[0] > c[0] - 1.3 * r && by[0] > c[1] - 1.3 * r)
      return [prim('circle', { center: c, r, weak: true })];
  }
  const idx = I.approxPolyClosed(cnt, pxEps);
  if (idx.length < 3) return [];
  let segs = idx.map((i0, k) => {
    const i1 = idx[(k + 1) % idx.length]; const span = [];
    if (i1 > i0) for (let i = i0; i <= i1; i++) span.push(i); else { for (let i = i0; i < n; i++) span.push(i); for (let i = 0; i <= i1; i++) span.push(i); }
    const L = dist(P[span[span.length - 1]], P[span[0]]);
    return { span, L, short: L < shortMm };
  });
  const start = segs.findIndex(s => !s.short);
  if (start < 0) { const st = Math.max(1, Math.floor(n / 60)); const poly = []; for (let i = 0; i < n; i += st) poly.push(P[i]); poly.push(P[0]); return [prim('spline', { poly })]; }
  segs = segs.slice(start).concat(segs.slice(0, start));
  let els = [];
  for (const s of segs) {
    const last = els[els.length - 1];
    if (s.short && last && last.typ === 'run') { last.span = last.span.concat(s.span.slice(1)); last.n++; }
    else if (s.short) els.push({ typ: 'run', span: s.span.slice(), n: 1 });
    else els.push({ typ: 'line', span: s.span.slice() });
  }
  for (const e of els) {
    if (e.typ !== 'run') continue;
    if (e.n === 1) { e.typ = 'line'; continue; }
    const Q = e.span.map(i => P[i]);
    const [, , l2] = I.pca(Q);
    if (Math.sqrt(l2) / Math.sqrt(Q.length) < 0.05) { e.typ = 'line'; continue; }
    const [c, r, rms] = I.fitCircle(Q); const chord = dist(Q[Q.length - 1], Q[0]);
    if (rms < Math.max(0.05, Math.min(0.03 * r, 0.15)) && r < 300 && chord < 2.05 * r) Object.assign(e, { typ: 'arc', c, r });
    else e.typ = 'spline';
  }
  // Spline-Läufe in Gerade + Bogen (z. B. Schräge mit Eckradius) zerlegen, wenn beide Teile sauber passen
  {
    const fitPart = Q => {
      if (Q.length < 3) return null;
      const [, , l2] = I.pca(Q); const lr = Math.sqrt(l2 / Q.length);
      if (lr < 0.06) return { typ: 'line', err: lr };
      const [c, r, rms] = I.fitCircle(Q); const chord = dist(Q[Q.length - 1], Q[0]);
      if (rms < Math.max(0.05, Math.min(0.03 * r, 0.12)) && r < 300 && chord < 2.05 * r) return { typ: 'arc', c, r, err: rms };
      return null;
    };
    const out = [];
    for (const e of els) {
      if (e.typ !== 'spline' || e.span.length < 12) { out.push(e); continue; }
      let best = null;
      for (let k = 4; k < e.span.length - 4; k++) {
        const A = fitPart(e.span.slice(0, k + 1).map(i => P[i])), B = fitPart(e.span.slice(k).map(i => P[i]));
        if (A && B && !(A.typ === 'line' && B.typ === 'line')) { const err = Math.max(A.err, B.err); if (!best || err < best.err) best = { k, A, B, err }; }
      }
      if (!best) { out.push(e); continue; }
      out.push(Object.assign({ span: e.span.slice(0, best.k + 1) }, best.A), Object.assign({ span: e.span.slice(best.k) }, best.B));
    }
    els = out;
  }
  const ldir = e => { const a = P[e.span[0]], b = P[e.span[e.span.length - 1]]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]) + 1e-12; return [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; };
  const coll = (a, b) => Math.abs(cross2(ldir(a), ldir(b))) < 0.035 && (ldir(a)[0] * ldir(b)[0] + ldir(a)[1] * ldir(b)[1]) > 0;
  const merged = [];
  for (const e of els) {
    const last = merged[merged.length - 1];
    if (last && e.typ === 'line' && last.typ === 'line' && coll(last, e)) last.span = last.span.concat(e.span.slice(1));
    else merged.push(e);
  }
  if (merged.length > 1 && merged[0].typ === 'line' && merged[merged.length - 1].typ === 'line' && coll(merged[merged.length - 1], merged[0])) {
    merged[0].span = merged[merged.length - 1].span.concat(merged[0].span.slice(1)); merged.pop();
  }
  els = merged;
  {
    const m = els.length, keep = [];
    for (let k = 0; k < m; k++) {
      const e = els[k], prv = els[(k - 1 + m) % m], nxt = els[(k + 1) % m];
      const chord = dist(P[e.span[e.span.length - 1]], P[e.span[0]]);
      if ((e.typ === 'arc' || e.typ === 'spline') && prv.typ === 'line' && nxt.typ === 'line' && (chord < 1.6 || (e.typ === 'arc' && e.r < 0.9))) {
        prv.span = prv.span.concat(e.span.slice(1)); continue;
      }
      keep.push(e);
    }
    els = keep;
  }
  for (const e of els) {
    if (e.typ !== 'line') continue;
    const Q = e.span.map(i => P[i]); const m = Math.max(1, Math.floor(Q.length / 10));
    const Qi = Q.length > 2 * m + 2 ? Q.slice(m, Q.length - m) : Q;
    let [d, p0] = I.pca(Qi);
    const ang = ((Math.atan2(d[1], d[0]) * 180 / Math.PI) % 180 + 180) % 180;
    if (Math.min(ang, 180 - ang) < 1.5) d = [1, 0]; else if (Math.abs(ang - 90) < 1.5) d = [0, 1];
    e.d = d; e.p = p0;
  }
  const m = els.length; const verts = [];
  for (let k = 0; k < m; k++) {
    const a = els[k], b = els[(k + 1) % m]; const raw = P[a.span[a.span.length - 1]]; let v;
    if (a.typ === 'line' && b.typ === 'line') {
      const t = solve2(a.d[0], -b.d[0], a.d[1], -b.d[1], b.p[0] - a.p[0], b.p[1] - a.p[1]);
      const det = a.d[0] * -b.d[1] - -b.d[0] * a.d[1];
      if (t && Math.abs(det) > 1e-3) { v = [a.p[0] + t[0] * a.d[0], a.p[1] + t[0] * a.d[1]]; if (dist(v, raw) > 1.5) v = raw; } else v = raw;
    } else if (a.typ === 'line') { const s = (raw[0] - a.p[0]) * a.d[0] + (raw[1] - a.p[1]) * a.d[1]; v = [a.p[0] + s * a.d[0], a.p[1] + s * a.d[1]]; }
    else if (b.typ === 'line') { const s = (raw[0] - b.p[0]) * b.d[0] + (raw[1] - b.p[1]) * b.d[1]; v = [b.p[0] + s * b.d[0], b.p[1] + s * b.d[1]]; }
    else v = raw;
    verts.push(v);
  }
  const prims = [];
  for (let k = 0; k < m; k++) {
    const e = els[k], v0 = verts[(k - 1 + m) % m], v1 = verts[k];
    if (dist(v0, v1) < 1e-6) continue;
    if (e.typ === 'line') prims.push(prim('line', { pts: [v0.slice(), v1.slice()] }));
    else if (e.typ === 'arc') {
      let q = P[e.span[Math.floor(e.span.length / 2)]]; const L = dist(q, e.c);
      q = [e.c[0] + (q[0] - e.c[0]) / L * e.r, e.c[1] + (q[1] - e.c[1]) / L * e.r];
      prims.push(arcFrom3pts(v0, q, v1) || prim('line', { pts: [v0.slice(), v1.slice()] }));
    } else {
      const inner = []; for (let i = 1; i < e.span.length - 1; i += 3) inner.push(P[e.span[i]]);
      prims.push(prim('spline', { poly: [v0.slice(), ...inner, v1.slice()] }));
    }
  }
  return refineLoop(prims);
}

// ---- Kontur-Nachbearbeitung: Spline zwischen zwei Geraden als Kreisbogen (robust), G1-Einrasten Gerade/Bogen und Bogen/Bogen
const pS = p => p.kind === 'spline' ? p.poly[0] : p.pts[0];
const pE = p => p.kind === 'spline' ? p.poly[p.poly.length - 1] : p.pts[p.pts.length - 1];
function arcTan(a, atEnd) {
  const q = atEnd ? a.pts[1] : a.pts[0]; const rx = q[0] - a.center[0], ry = q[1] - a.center[1]; const L = Math.hypot(rx, ry);
  return a.sweep > 0 ? [-ry / L, rx / L] : [ry / L, -rx / L];
}
function primTan(p, atEnd) {
  if (p.kind === 'arc') return arcTan(p, atEnd);
  const P = p.kind === 'spline' ? p.poly : p.pts; const a = atEnd ? P[P.length - 2] : P[0], b = atEnd ? P[P.length - 1] : P[1];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
}
const kinkDeg = (t1, t2) => Math.acos(Math.max(-1, Math.min(1, t1[0] * t2[0] + t1[1] * t2[1]))) * 180 / Math.PI;
function arcMidNear(c, r, q) { const L = Math.hypot(q[0] - c[0], q[1] - c[1]) || 1; return [c[0] + (q[0] - c[0]) / L * r, c[1] + (q[1] - c[1]) / L * r]; }
function arcMid(a) { const a0 = Math.atan2(a.pts[0][1] - a.center[1], a.pts[0][0] - a.center[0]) + a.sweep / 2; return [a.center[0] + a.r * Math.cos(a0), a.center[1] + a.r * Math.sin(a0)]; }
function lineHit(c, r, l, near) {
  const p = l.pts[0], q = l.pts[1]; const L = Math.hypot(q[0] - p[0], q[1] - p[1]); const d = [(q[0] - p[0]) / L, (q[1] - p[1]) / L];
  const t0 = (c[0] - p[0]) * d[0] + (c[1] - p[1]) * d[1]; const f = [p[0] + t0 * d[0], p[1] + t0 * d[1]]; const h = Math.hypot(c[0] - f[0], c[1] - f[1]);
  if (h > r + 0.3) return null;
  if (h > r - 0.05 * r) return { pt: f, tangent: true };
  const w = Math.sqrt(r * r - h * h); const A = [f[0] - w * d[0], f[1] - w * d[1]], B = [f[0] + w * d[0], f[1] + w * d[1]];
  return { pt: dist(A, near) < dist(B, near) ? A : B, tangent: false };
}
function ransacCircle(Q) {
  let best = null; const n = Q.length; const st = Math.max(1, Math.floor(n / 14));
  for (let i = 0; i < n; i += st) for (let j = i + st; j < n; j += st) for (let k = j + st; k < n; k += st) {
    const a = arcFrom3pts(Q[i], Q[j], Q[k]); if (!a || a.r > 150) continue;
    const inl = Q.filter(q => Math.abs(dist(q, a.center) - a.r) < 0.1);
    if (!best || inl.length > best.length) best = inl;
  }
  if (!best || best.length < 0.55 * n || best.length < 6) return null;
  const [c, r, rms] = I.fitCircle(best); return rms < 0.06 ? { c, r, frac: best.length / n } : null;
}
export function refineLoop(prims) {
  const n = prims.length; if (n < 3) return prims;
  const out = prims.slice(); let g1 = 0, arcsFromSpline = 0;
  // Endpunkt einer Geraden nur verschieben, wenn sie dabei nicht umklappt/verschwindet und sich der Punkt kaum bewegt
  const okMove = (p, v, atEnd) => { if (p.kind !== 'line') return false; const a = atEnd ? p.pts[0] : v, b = atEnd ? v : p.pts[1]; const d0 = [p.pts[1][0] - p.pts[0][0], p.pts[1][1] - p.pts[0][1]], d1 = [b[0] - a[0], b[1] - a[1]];
    return d0[0] * d1[0] + d0[1] * d1[1] > 0 && Math.hypot(...d1) > 0.1 && dist(atEnd ? p.pts[1] : p.pts[0], v) < 2.5; };
  const setEnd = (p, v) => { if (p.kind === 'line') p.pts[1] = v.slice(); };
  const setStart = (p, v) => { if (p.kind === 'line') p.pts[0] = v.slice(); };
  // 1) Spline zwischen zwei Geraden -> Bogen
  for (let k = 0; k < n; k++) {
    const e = out[k], A = out[(k - 1 + n) % n], B = out[(k + 1) % n];
    if (e.kind !== 'spline' || A.kind !== 'line' || B.kind !== 'line' || e.poly.length < 8) continue;
    const ci = ransacCircle(e.poly); if (!ci) continue;
    const h0 = lineHit(ci.c, ci.r, A, pS(e)), h1 = lineHit(ci.c, ci.r, B, pE(e)); if (!h0 || !h1) continue;
    if (dist(h0.pt, pS(e)) > 8 || dist(h1.pt, pE(e)) > 8) continue;
    const mid = arcMidNear(ci.c, ci.r, e.poly[Math.floor(e.poly.length / 2)]);
    const a = arcFrom3pts(h0.pt, mid, h1.pt); if (!a) continue;
    // Gerade darf nicht umklappen
    const okLen = (l, from, to) => { const d0 = [l.pts[1][0] - l.pts[0][0], l.pts[1][1] - l.pts[0][1]]; const d1 = [to[0] - from[0], to[1] - from[1]]; return d0[0] * d1[0] + d0[1] * d1[1] > 0; };
    if (!okLen(A, A.pts[0], h0.pt) || !okLen(B, h1.pt, B.pts[1])) continue;
    setEnd(A, h0.pt); setStart(B, h1.pt); out[k] = a; arcsFromSpline++;
  }
  // 2) G1 einrasten
  for (let k = 0; k < n; k++) {
    const a = out[k]; if (a.kind !== 'arc') continue;
    const A = out[(k - 1 + n) % n], B = out[(k + 1) % n];
    const kA = A.kind !== 'spline' ? kinkDeg(primTan(A, true), arcTan(a, false)) : 99, kB = B.kind !== 'spline' ? kinkDeg(arcTan(a, true), primTan(B, false)) : 99;
    const tA = A.kind === 'line' && kA > 0.05 && kA < 8, tB = B.kind === 'line' && kB > 0.05 && kB < 8;
    const side = (l, c) => { const p = l.pts[0], q = l.pts[1]; return Math.sign((q[0] - p[0]) * (c[1] - p[1]) - (q[1] - p[1]) * (c[0] - p[0])); };
    const offLine = (l, sgn, r) => { const p = l.pts[0], q = l.pts[1]; const L = Math.hypot(q[0] - p[0], q[1] - p[1]); const nrm = [-(q[1] - p[1]) / L * sgn, (q[0] - p[0]) / L * sgn]; return { p: [p[0] + nrm[0] * r, p[1] + nrm[1] * r], d: [(q[0] - p[0]) / L, (q[1] - p[1]) / L] }; };
    const foot = (l, c) => { const p = l.pts[0], q = l.pts[1]; const L = Math.hypot(q[0] - p[0], q[1] - p[1]); const d = [(q[0] - p[0]) / L, (q[1] - p[1]) / L]; const t = (c[0] - p[0]) * d[0] + (c[1] - p[1]) * d[1]; return [p[0] + t * d[0], p[1] + t * d[1]]; };
    let c = null;
    if (tA && tB) {
      const oa = offLine(A, side(A, a.center), a.r), ob = offLine(B, side(B, a.center), a.r);
      const t = solve2(oa.d[0], -ob.d[0], oa.d[1], -ob.d[1], ob.p[0] - oa.p[0], ob.p[1] - oa.p[1]); if (t) c = [oa.p[0] + t[0] * oa.d[0], oa.p[1] + t[0] * oa.d[1]];
      if (c && dist(c, a.center) < 0.3 * a.r) { const j0 = foot(A, c), j1 = foot(B, c); if (!okMove(A, j0, true) || !okMove(B, j1, false)) continue; const na = arcFrom3pts(j0, arcMidNear(c, a.r, arcMid(a)), j1); if (na) { setEnd(A, j0); setStart(B, j1); out[k] = na; g1 += 2; } }
      continue;
    }
    if (tA || tB) {
      const L = tA ? A : B, far = tA ? a.pts[1] : a.pts[0]; const o = offLine(L, side(L, a.center), a.r);
      // Mittelpunkt auf Parallele im Abstand r, Abstand r zum festen Endpunkt
      const t0 = (far[0] - o.p[0]) * o.d[0] + (far[1] - o.p[1]) * o.d[1]; const f = [o.p[0] + t0 * o.d[0], o.p[1] + t0 * o.d[1]]; const h = dist(far, f);
      if (h > a.r) continue; const w = Math.sqrt(a.r * a.r - h * h);
      const C1 = [f[0] - w * o.d[0], f[1] - w * o.d[1]], C2 = [f[0] + w * o.d[0], f[1] + w * o.d[1]]; c = dist(C1, a.center) < dist(C2, a.center) ? C1 : C2;
      if (dist(c, a.center) > 0.3 * a.r) continue;
      const j = foot(L, c); if (!okMove(L, j, tA)) continue; const mid = arcMidNear(c, a.r, arcMid(a));
      const na = tA ? arcFrom3pts(j, mid, far) : arcFrom3pts(far, mid, j); if (!na) continue;
      if (tA) setEnd(A, j); else setStart(B, j); out[k] = na; g1++;
      continue;
    }
    // Bogen -> Bogen
    if (B.kind === 'arc') {
      const kk = kinkDeg(arcTan(a, true), arcTan(B, false)); if (!(kk > 0.05 && kk < 8)) continue;
      const J = a.pts[1], P = B.pts[1]; const nr = [(J[0] - a.center[0]) / a.r, (J[1] - a.center[1]) / a.r];
      const dJP = [J[0] - P[0], J[1] - P[1]]; const den = 2 * (nr[0] * dJP[0] + nr[1] * dJP[1]); if (Math.abs(den) < 1e-9) continue;
      const t = -(dJP[0] ** 2 + dJP[1] ** 2) / den; const c2 = [J[0] + t * nr[0], J[1] + t * nr[1]]; const r2 = Math.abs(t);
      if (Math.abs(r2 - B.r) > 0.1 * B.r || dist(c2, B.center) > 0.3 * B.r) continue;
      const nb = arcFrom3pts(J, arcMidNear(c2, r2, arcMid(B)), P); if (nb) { out[(k + 1) % n] = nb; g1++; }
    }
  }
  if (g1 || arcsFromSpline) out.g1 = { g1, arcsFromSpline };
  return out;
}

/** Stufe 2: Geometrie aus Bild + OCR-Ergebnis. */
export function finish(pre, ocrRes, dpiKnown, log = () => {}) {
  const { ink, u, f, W, H } = pre; const msgs = [];
  if (!dpiKnown) msgs.push('Auflösung nicht sicher bekannt – Maßstab wird über die Maßzahlen bestimmt.');
  const { phrases, boxes } = ocrRes;
  log('Textmaske & Strichstärken …');
  const tmask = new Uint8Array(W * H); const pad = Math.max(1, Math.round(3 * f));
  for (const [x0, y0, x1, y1] of boxes) {
    for (let y = Math.max(0, Math.floor(y0) - pad); y <= Math.min(H - 1, Math.ceil(y1) + pad); y++)
      tmask.fill(1, y * W + Math.max(0, Math.floor(x0) - pad), y * W + Math.min(W - 1, Math.ceil(x1) + pad) + 1);
  }
  const strong = I.dilate(I.open(ink, W, H, 0.55 / u), W, H, 3 * f);
  const geo = new Uint8Array(W * H); for (let i = 0; i < geo.length; i++) geo[i] = ink[i] && !(tmask[i] && !strong[i]) ? 1 : 0;
  {
    const cc = I.components(geo, W, H, 8);
    for (let i = 0; i < geo.length; i++) { const l = cc.lab[i]; if (l && ((cc.stats[l][2] > 0.8 * W && cc.stats[l][3] > 0.6 * H) || cc.stats[l][2] > 0.95 * W || cc.stats[l][3] > 0.95 * H)) geo[i] = 0; }
  }
  const D = I.edt2(geo, W, H, 0); const sk = I.skeleton(geo, W, H);
  const widths = []; for (let i = 0; i < geo.length; i++) if (sk[i]) { const w = 2 * Math.sqrt(D[i]) - 1; if (w > 0.5) widths.push(w); }
  if (widths.length < 50) throw new ReconError('Im Bild wurde keine Liniengeometrie gefunden.');
  const [c1, c2] = kmeans1d(widths);
  if (c2 / Math.max(c1, 0.5) < 1.4) msgs.push('WARNUNG: Breite und schmale Linien sind kaum unterscheidbar – Erkennung unsicher.');
  const thr = (c1 + c2) / 2;
  msgs.push(`Strichstärken: schmal ≈ ${(c1 * u).toFixed(2)} mm, breit ≈ ${(c2 * u).toFixed(2)} mm (Schwelle ${(thr * u).toFixed(2)} mm)`);
  let thick = I.open(geo, W, H, thr);
  const blobs = I.open(geo, W, H, 1.15 / u);
  { const bc = I.components(blobs, W, H, 8); for (let i = 0; i < blobs.length; i++) { const l = bc.lab[i]; if (l && Math.max(bc.stats[l][2], bc.stats[l][3]) * u > 4) blobs[i] = 0; } }
  const blobsD = I.dilate(blobs, W, H, 0.7 / u);
  thick = I.close(thick, W, H, 2 * f);
  {
    const cc = I.components(thick, W, H, 8);
    for (let i = 0; i < thick.length; i++) { const l = cc.lab[i]; if (l && Math.max(cc.stats[l][2], cc.stats[l][3]) * u < 4.5) thick[i] = 0; }
  }
  const wth = c2;
  if (globalThis.DBG) globalThis.DBGMASK = { thick, geo, ink, W, H, c1, c2 };
  const thickD = I.dilate(thick, W, H, wth * 0.8);
  const thin = new Uint8Array(W * H); for (let i = 0; i < thin.length; i++) thin[i] = geo[i] && !thickD[i] ? 1 : 0;
  log('Strichlinien (verdeckte Kanten) …');
  const hidden = dashLines(thin, W, H, u);
  log('Konturen …');
  const cc = I.components(thick, W, H, 8); const st = cc.stats;
  const comps = []; for (let i = 1; i < cc.n; i++) if (Math.max(st[i][2], st[i][3]) * u > 1.5) comps.push(i);
  const gap = 2.5 / u; const parent = new Map(comps.map(i => [i, i]));
  const find = i => { while (parent.get(i) !== i) i = parent.get(i); return i; };
  const bx = i => [st[i][0], st[i][1], st[i][0] + st[i][2], st[i][1] + st[i][3]];
  for (const a of comps) for (const b of comps) if (a < b) {
    const A = bx(a), B = bx(b);
    if (A[0] - gap <= B[2] && B[0] - gap <= A[2] && A[1] - gap <= B[3] && B[1] - gap <= A[3]) parent.set(find(a), find(b));
  }
  const groups = new Map(); for (const i of comps) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }
  const thickPrims = [];
  for (const g of groups.values()) {
    const x0 = Math.min(...g.map(i => st[i][0])), y0 = Math.min(...g.map(i => st[i][1]));
    const x1 = Math.max(...g.map(i => st[i][0] + st[i][2])), y1 = Math.max(...g.map(i => st[i][1] + st[i][3]));
    // kleine Gruppen nur, wenn annähernd rund (kleine Bohrungen in Stirnansichten)
    if (Math.max(x1 - x0, y1 - y0) * u < 8 && !(Math.min(x1 - x0, y1 - y0) * u >= 2.5 && Math.abs((x1 - x0) / (y1 - y0) - 1) < 0.15)) continue;
    const main = g.reduce((a, b) => st[b][2] * st[b][3] > st[a][2] * st[a][3] ? b : a);
    for (const i of g) {
      const [bx0, by0, bw, bh] = st[i]; const pd = Math.round(wth) + 4;
      const ox = Math.max(0, bx0 - pd), oy = Math.max(0, by0 - pd);
      const cw = Math.min(W, bx0 + bw + pd) - ox, ch = Math.min(H, by0 + bh + pd) - oy;
      const crop = new Uint8Array(cw * ch);
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) crop[y * cw + x] = cc.lab[(oy + y) * W + ox + x] === i ? 1 : 0;
      const filled = I.fillHoles(crop, cw, ch);
      let region;
      if (i === main) {
        for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (blobsD[(oy + y) * W + ox + x]) filled[y * cw + x] = 0;
        // runde Löcher, die über (dick erkannte) Hilfslinien mit dem Umriss verschmolzen sind
        {
          const enc = new Uint8Array(cw * ch); for (let k = 0; k < enc.length; k++) enc[k] = filled[k] && !crop[k] ? 1 : 0;
          const ce = I.components(enc, cw, ch, 4); const gp = 1.5 * wth + 2; const used = new Set();
          const ok = k => { const [, , ew, eh] = ce.stats[k]; return Math.max(ew, eh) * u < 25 && Math.max(ew, eh) * u > 0.4; };
          for (let k = 1; k < ce.n; k++) {
            if (used.has(k) || !ok(k)) continue;
            // Teilflächen eines durch (dick erkannte) Mittellinien geteilten Kreises zusammenfassen
            let grp = [k], ch_ = true;
            while (ch_) { ch_ = false; const [gx0, gy0, gx1, gy1] = grp.reduce((r, q) => { const t = ce.stats[q]; return [Math.min(r[0], t[0]), Math.min(r[1], t[1]), Math.max(r[2], t[0] + t[2]), Math.max(r[3], t[1] + t[3])]; }, [1e9, 1e9, -1e9, -1e9]);
              for (let j = 1; j < ce.n; j++) { if (grp.includes(j) || used.has(j) || !ok(j)) continue; const t = ce.stats[j];
                if (t[0] - gp <= gx1 && gx0 - gp <= t[0] + t[2] && t[1] - gp <= gy1 && gy0 - gp <= t[1] + t[3]) { const nx0 = Math.min(gx0, t[0]), nx1 = Math.max(gx1, t[0] + t[2]), ny0 = Math.min(gy0, t[1]), ny1 = Math.max(gy1, t[1] + t[3]); if ((nx1 - nx0) * u < 25 && (ny1 - ny0) * u < 25 && grp.length < 4) { grp.push(j); ch_ = true; } } } }
            const [ex, ey, ex1, ey1] = grp.reduce((r, q) => { const t = ce.stats[q]; return [Math.min(r[0], t[0]), Math.min(r[1], t[1]), Math.max(r[2], t[0] + t[2]), Math.max(r[3], t[1] + t[3])]; }, [1e9, 1e9, -1e9, -1e9]);
            const ew = ex1 - ex, eh = ey1 - ey, ea = grp.reduce((r, q) => r + ce.stats[q][4], 0);
            if (Math.max(ew, eh) * u < 1.5 || Math.abs(ew / eh - 1) > 0.12 || ea < 0.6 * ew * eh) continue;
            const pd2 = Math.round(wth) + 3, sx = Math.max(0, ex - pd2), sy = Math.max(0, ey - pd2), sw = Math.min(cw, ex1 + pd2) - sx, sh = Math.min(ch, ey1 + pd2) - sy;
            const gs = new Set(grp); const one = new Uint8Array(sw * sh); for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) one[y * sw + x] = gs.has(ce.lab[(sy + y) * cw + sx + x]) ? 1 : 0;
            const rg = I.dilate(I.close(one, sw, sh, gp), sw, sh, wth + 1); const cn = I.outerContour(rg, sw, sh); if (!cn) continue;
            const fp = fitContour(cn.map(([x, y]) => [x + sx + ox, y + sy + oy]), u, H, 0.8 * Math.max(0.6, f));
            if (fp.length === 1 && fp[0].kind === 'circle') { thickPrims.push(fp[0]); grp.forEach(q => used.add(q)); }
          }
        }
        region = I.erode(filled, cw, ch, wth + 1);
        const c3 = I.components(region, cw, ch, 4);
        if (c3.n > 2) { let b = 1; for (let k = 2; k < c3.n; k++) if (c3.stats[k][4] > c3.stats[b][4]) b = k; for (let k = 0; k < region.length; k++) region[k] = c3.lab[k] === b ? 1 : 0; }
      } else {
        const enc = new Uint8Array(cw * ch); for (let k = 0; k < enc.length; k++) enc[k] = filled[k] && !crop[k] ? 1 : 0;
        const c2_ = I.components(enc, cw, ch, 4); if (c2_.n < 2) continue;
        let b = 1; for (let k = 2; k < c2_.n; k++) if (c2_.stats[k][4] > c2_.stats[b][4]) b = k;
        if (c2_.stats[b][4] * u * u < 0.5) continue;
        const one = new Uint8Array(cw * ch); for (let k = 0; k < one.length; k++) one[k] = c2_.lab[k] === b ? 1 : 0;
        region = I.dilate(one, cw, ch, wth + 1);
      }
      const cnt = I.outerContour(region, cw, ch); if (!cnt) continue;
      thickPrims.push(...fitContour(cnt.map(([x, y]) => [x + ox, y + oy]), u, H, 0.8 * Math.max(0.6, f)));
    }
  }
  log('Schraffur, Detailkreise, Schnittverlauf …');
  const { hatch, thinCircles, strokes } = rasterSectionMarks(thin, thick, W, H, u, wth);
  log('Schraffierte Schnittflächen …');
  const hatchRegions = rasterHatchRegions(thick, geo, thickD, tmask, W, H, u, wth, f);
  const full = phrases.map(p => p.text).join(' ');
  const m = full.match(SCALE_RE);
  let sTxt = m ? parseFloat(m[1].replace(',', '.')) / parseFloat(m[2].replace(',', '.')) : null;
  // Schriftfeld: freistehendes Verhältnis („1:2“, „4: 1“ hinter unlesbarem „MASSTAB“) im rechten unteren Blattviertel
  const titleKs = phrases.filter(p => p.x > 0.5 * W * u && p.y < 0.3 * H * u && !/[A-Z]\s*-\s*[A-Z]/.test(p.text))
    .map(p => p.text.match(/(?:^|[^\d,.])(\d{1,2})\s*:\s*(\d{1,2})\s*$/)).filter(Boolean).map(q => +q[1] / +q[2])
    .filter(k => [1, 2, 2.5, 4, 5, 10, 20, 0.5, 0.4, 0.2, 0.1, 0.05].some(q => Math.abs(q / k - 1) < 1e-6));
  if (sTxt == null && titleKs.length) sTxt = titleKs[0];
  const fm = phrases.filter(p => p.x > 0.5 * W * u && p.y < 0.3 * H * u).map(p => p.text.trim().match(/^A([0-4])$/)).find(Boolean);
  const sheetFmt = fm ? +fm[1] : null;
  const _dr = { kind: 'raster', thick: thickPrims, thin: [], hidden, center: [], arrows: [], phrases, scale: 1, scale_txt: sTxt, dpi_known: dpiKnown,
    scale_src: 'vorläufig', msgs, page_w: W * u, page_h: H * u, px_mm: u, hatch, thinCircles, strokes, hatchRegions, sheet_fmt: sheetFmt };
  // Abfrage dünner Linien (Blatt-mm, y nach oben) für Messungen in recon (z. B. Tangentialkanten von Fasen); nicht aufzählbar -> nicht im postMessage
  Object.defineProperty(_dr, 'thinAt', { enumerable: false, value: makeThinAt(thin, u, W, H) });
  return _dr;
}

export const fmtScale = k => k >= 1 ? `${+k.toPrecision(6)}:1` : `1:${+(1 / k).toPrecision(6)}`;

const STD = [1, 2, 2.5, 4, 5, 10, 20, 0.5, 0.4, 0.2, 0.1, 0.05];
const viewLens = v => {
  const L = [v.size[0], v.size[1]];
  for (const p of v.prims) {
    if (p.kind === 'circle') L.push(2 * p.r);
    else if (p.kind === 'line') { const d = [p.pts[1][0] - p.pts[0][0], p.pts[1][1] - p.pts[0][1]]; if (Math.min(Math.abs(d[0]), Math.abs(d[1])) < 0.05) L.push(Math.hypot(...d)); }
  }
  return L.filter(x => x > 3);
};
/** Ist das Blatt ein Normformat (A0–A4, hoch/quer)? Dann sind Blatt-mm verlässlich und nur Normmaßstäbe kommen in Frage. */
export function isStdSheet(w, h) {
  const F = [[1189, 841], [841, 594], [594, 420], [420, 297], [297, 210]];
  return F.some(([a, b]) => (Math.abs(w / a - 1) < 0.03 && Math.abs(h / b - 1) < 0.03) || (Math.abs(w / b - 1) < 0.03 && Math.abs(h / a - 1) < 0.03));
}
/** Maßstab je Ansicht (Normmaßstäbe, Normblatt): Rückgabe Array k je Ansicht oder null. */
export function perViewScales(dr, views, values) {
  if (!isStdSheet(dr.page_w, dr.page_h)) return null;
  const vals = [...new Set(values.flatMap(v => Number.isInteger(v) && v >= 100 && v < 1000 ? [v, v / 10] : [v]).filter(v => v >= 3))];
  let F = 1;
  const supF = (L, k, f) => vals.filter(v => L.some(l => Math.abs(l * f / (v * k) - 1) < 0.015)).reduce((a, v) => a + Math.sqrt(v), 0);
  const sup = (L, k) => supF(L, k, F);
  const big = views.reduce((a, b, i) => b.size[0] * b.size[1] > views[a].size[0] * views[a].size[1] ? i : a, 0);
  const all = views.flatMap(viewLens);
  // Blattformat unsicher (DPI geraten): echtes Format über Formatangabe im Schriftfeld oder Schriftfeld-Maßstab + Maßzahlen bestimmen
  if (!dr.dpi_known) {
    const fmtOf = (w, h) => { const L = Math.max(w, h); return [1189, 841, 594, 420, 297].findIndex(a => Math.abs(L / a - 1) < 0.03); };
    const fm = fmtOf(dr.page_w, dr.page_h);
    if (dr.sheet_fmt != null && fm >= 0) F = Math.pow(2, (fm - dr.sheet_fmt) / 2);
    else if (dr.scale_txt) {
      let bsF = supF(all, dr.scale_txt, 1);
      for (const f of [Math.SQRT1_2, Math.SQRT2]) { const sc = supF(all, dr.scale_txt, f); if (sc > bsF * 1.5 + 1) { bsF = sc; F = f; } }
    }
    if (F !== 1) dr.sheet_f = F;
  }
  // 1) Ansichtstitel mit Maßstab („A-A 1:1“, „Z (5:1)“) direkt über/unter einer Ansicht
  const kt = views.map(() => null);
  for (const ph of dr.phrases || []) {
    const m = ph.text.match(/(?:^|\s|\()(\d+(?:[.,]\d+)?)\s*:\s*(\d+(?:[.,]\d+)?)\)?\s*$/); if (!m) continue;
    const k = parseFloat(m[1].replace(',', '.')) / parseFloat(m[2].replace(',', '.'));
    if (!STD.some(q => Math.abs(q / k - 1) < 1e-6)) continue;
    let bi = -1, bd = 18;
    views.forEach((v, i) => {
      if (Math.max(...v.size) < 15 || ph.x < v.lo[0] - 10 || ph.x > v.hi[0] + 10) return;
      const d = ph.y > v.hi[1] ? ph.y - v.hi[1] : (ph.y < v.lo[1] ? v.lo[1] - ph.y : 99);
      if (d < bd) { bd = d; bi = i; }
    });
    if (bi >= 0) kt[bi] = k;
  }
  // 2) über Größenverhältnis auf ähnliche Ansichten übertragen (gleiche Ansicht in anderem Maßstab)
  const kp = kt.slice();
  views.forEach((v, i) => {
    if (kp[i] != null || Math.max(...v.size) < 25) return;
    for (let j = 0; j < views.length; j++) if (kt[j] != null) {
      const r0 = v.size[0] / views[j].size[0], r1 = v.size[1] / views[j].size[1], k = kt[j] * (r0 + r1) / 2;
      if (Math.abs(r0 / r1 - 1) < 0.03 && v.prims.length >= 0.33 * views[j].prims.length && v.prims.length <= 3 * views[j].prims.length) { const q = STD.find(q => Math.abs(q / k - 1) < 0.03); if (q) kp[i] = q; }
    }
  });
  let kM = null, bs = 1;
  for (const k of STD) { const s = sup(viewLens(views[big]), k) * 2 + sup(all, k); if (s > bs) { bs = s; kM = k; } }
  if (dr.scale_txt && STD.includes(dr.scale_txt) && sup(all, dr.scale_txt) > 0) kM = dr.scale_txt;
  if (kp[big] != null) kM = kp[big];
  if (kM == null) return null;
  // Rückgabe: Blatt-mm (gemessen) je Bauteil-mm
  return views.map((v, i) => {
    if (kp[i] != null) return kp[i] / F;
    // eigener Maßstab nur mit Ansichtstitel (oder Größenvergleich dazu) – reine Maßzahl-Abstimmung je Ansicht ist zu unsicher
    return kM / F;
  });
}

export function voteScale(dr, views, values) {
  let L = [];
  for (const v of views) {
    L.push(v.size[0], v.size[1]);
    for (const p of v.prims) {
      if (p.kind === 'circle') L.push(2 * p.r);
      else if (p.kind === 'line') { const d = [p.pts[1][0] - p.pts[0][0], p.pts[1][1] - p.pts[0][1]]; if (Math.min(Math.abs(d[0]), Math.abs(d[1])) < 0.05) L.push(Math.hypot(...d)); }
    }
  }
  L = L.filter(x => x > 3);
  // OCR verliert oft das Dezimalkomma (21,9 -> 219): für die Abstimmung auch v/10 zulassen
  const vals = [...new Set(values.flatMap(v => Number.isInteger(v) && v >= 100 && v < 1000 ? [v, v / 10] : [v]).filter(v => v >= 3))].sort((a, b) => a - b);
  const support = k => vals.filter(v => L.some(l => Math.abs(l / (v * k) - 1) < 0.012)).length;
  let best = null, bs = -1;
  for (const l of L) for (const v of vals) {
    const k = l / v; if (!(k > 0.05 && k < 20)) continue;
    const s = support(k);
    if (s > bs || (s === bs && best != null && Math.abs(k - 1) < Math.abs(best - 1))) { best = k; bs = s; }
  }
  const k0 = dr.scale_txt;
  if (k0 && (dr.dpi_known ? (support(k0) >= 1 || bs < 3) : support(k0) >= Math.max(2, bs - 1))) {
    const how = dr.dpi_known ? 'Schriftfeld + DPI' : 'Schriftfeld + angenommene 300 dpi';
    return [k0, `${how} (Maßstab ${fmtScale(k0)}, bestätigt durch ${support(k0)} Maßzahlen)`];
  }
  if (best == null || bs < 2) return [k0 || 1, 'WARNUNG: Maßstab nicht sicher bestimmbar (zu wenige passende Maßzahlen)'];
  const ratios = []; for (const v of vals) for (const l of L) if (Math.abs(l / (v * best) - 1) < 0.012) ratios.push(l / v);
  ratios.sort((a, b) => a - b); const k = ratios.length % 2 ? ratios[(ratios.length - 1) / 2] : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2;
  return [k, `aus ${bs} Maßzahlen ermittelt (Faktor ${k.toFixed(4)} Blatt-mm je mm)`];
}

export function snapGeometry(views, ks, values) {
  const rv = values.map(v => v / 2).concat(values);
  for (const v of views) for (const p of v.prims.concat(v.hidden || [])) if (p.kind === 'circle') {
    const rm = p.r / ks; const cand = rv.filter(r => Math.abs(r - rm) < Math.max(0.15, 0.03 * rm));
    if (cand.length) p.r = cand.reduce((a, b) => Math.abs(b - rm) < Math.abs(a - rm) ? b : a) * ks;
  }
  const lin = [...new Set(values)].sort((a, b) => a - b);
  for (const v of views) for (const k of [0, 1]) {
    const base = v.lo[k];
    const snapc = c => { const d = (c - base) / ks; for (const val of lin) if (Math.abs(d - val) < 0.6 && Math.abs(d - val) > 1e-9) return base + val * ks; return c; };
    const fq = q => q.map((x, i) => i === k ? snapc(x) : x);
    for (const p of v.prims.concat(v.hidden || [])) {
      if (p.kind === 'line' || p.kind === 'arc') p.pts = p.pts.map(fq);
      else if (p.kind === 'circle') p.center = fq(p.center);
      else if (p.kind === 'spline' && p.poly) { p.poly[0] = fq(p.poly[0]); p.poly[p.poly.length - 1] = fq(p.poly[p.poly.length - 1]); }
    }
  }
  for (const axis of [0, 1]) {
    const ends = p => (p.kind === 'line' || p.kind === 'arc') ? p.pts : (p.kind === 'spline' && p.poly ? [p.poly[0], p.poly[p.poly.length - 1]] : []);
    const coords = []; for (const v of views) for (const p of v.prims.concat(v.hidden || [])) for (const q of ends(p)) coords.push(q[axis]);
    coords.sort((a, b) => a - b);
    const clusters = []; for (const c of coords) { const last = clusters[clusters.length - 1]; if (last && c - last[last.length - 1] < 0.25 * ks) last.push(c); else clusters.push([c]); }
    const cmap = new Map(); for (const cl of clusters) { const m = cl.reduce((a, b) => a + b, 0) / cl.length; for (const c of cl) cmap.set(c, m); }
    const f = q => q.map((x, a) => a === axis && cmap.has(x) ? cmap.get(x) : x);
    for (const v of views) for (const p of v.prims.concat(v.hidden || [])) {
      if (p.kind === 'line' || p.kind === 'arc') p.pts = p.pts.map(f);
      else if (p.kind === 'spline' && p.poly) { p.poly[0] = f(p.poly[0]); p.poly[p.poly.length - 1] = f(p.poly[p.poly.length - 1]); }
    }
  }
}

/** Raster: Schraffurlinien (schmale, gerade, schräge Komponenten zwischen breiten Linien), schmale Kreise (RANSAC), Schnittverlauf-Striche. */
function rasterSectionMarks(thin, thick, W, H, u, wth) {
  const toMm = (x, y) => [x * u, (H - y) * u];
  const hatch = [], arcs = [], strokes = [];
  const cc = I.components(thin, W, H, 8);
  const pix = Array.from({ length: cc.n }, () => []);
  for (let i = 0; i < thin.length; i++) { const l = cc.lab[i]; if (l) pix[l].push(i); }
  const reach = Math.round((wth * 0.8 + 1.2 / u)); // Abstand Ende -> breite Linie (Pixel)
  const thickAt = (x, y) => x >= 0 && y >= 0 && x < W && y < H && thick[Math.round(y) * W + Math.round(x)];
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let l = 1; l < cc.n; l++) {
    const P = pix[l]; if (P.length < 12) continue;
    const [bx, by, bw, bh] = cc.stats[l]; const ext = Math.max(bw, bh) * u; if (ext < 1.5) continue;
    const step = Math.max(1, Math.floor(P.length / 600)); const Q = []; for (let k = 0; k < P.length; k += step) Q.push([P[k] % W, Math.floor(P[k] / W)]);
    const [d, c, l2] = I.pca(Q); const thickness = Math.sqrt(l2 / Q.length) * u;
    if (thickness < 0.25 && ext < 160) {
      // gerade Komponente
      let t0 = Infinity, t1 = -Infinity; for (const q of Q) { const t = (q[0] - c[0]) * d[0] + (q[1] - c[1]) * d[1]; t0 = Math.min(t0, t); t1 = Math.max(t1, t); }
      const a = [c[0] + t0 * d[0], c[1] + t0 * d[1]], b = [c[0] + t1 * d[0], c[1] + t1 * d[1]];
      let ang = Math.atan2(-d[1], d[0]) * 180 / Math.PI; ang = ((ang % 180) + 180) % 180;
      if (!((ang > 25 && ang < 65) || (ang > 115 && ang < 155))) continue;
      if (globalThis.DBG) globalThis.DBGH = (globalThis.DBGH || 0) + 1;
      const hit = (p, s) => { for (let k = 0; k <= reach; k++) if (thickAt(p[0] + s * d[0] * k, p[1] + s * d[1] * k)) return true; return false; };
      if (hit(a, -1) && hit(b, 1)) hatch.push([toMm(...a), toMm(...b)]);
      continue;
    }
    if (ext < 3 || ext > 170 || Q.length < 20) continue;
    // Kreisbögen per RANSAC
    const M = Q.map(q => toMm(q[0], q[1])); let best = null;
    for (let it = 0; it < 150; it++) {
      const p1 = M[Math.floor(rnd() * M.length)], p2 = M[Math.floor(rnd() * M.length)], p3 = M[Math.floor(rnd() * M.length)];
      const [cxy, r] = I.fitCircle([p1, p2, p3]); if (!(r > 1.5 && r < 85)) continue;
      let n = 0; for (const q of M) if (Math.abs(Math.hypot(q[0] - cxy[0], q[1] - cxy[1]) - r) < 0.15) n++;
      if (!best || n > best[0]) best = [n, cxy, r];
    }
    if (!best || best[0] < 15) continue;
    const inl = M.filter(q => Math.abs(Math.hypot(q[0] - best[1][0], q[1] - best[1][1]) - best[2]) < 0.15);
    const [c2, r2, rms] = I.fitCircle(inl); if (rms > 0.12 || !(r2 > 3)) continue;
    const bins = new Set(inl.map(q => Math.floor(((Math.atan2(q[1] - c2[1], q[0] - c2[0]) + Math.PI) / (2 * Math.PI)) * 36) % 36));
    if (bins.size < 3) continue;
    // Bogenlänge muss zur Pixelzahl passen (keine zufälligen Treffer)
    if (inl.length * step * u < 0.6 * bins.size / 36 * 2 * Math.PI * r2) continue;
    arcs.push({ c: c2, r: r2, bins });
  }
  const circles = [];
  for (const a of arcs) {
    const m = circles.find(c => Math.hypot(c.c[0] - a.c[0], c.c[1] - a.c[1]) < Math.max(0.8, 0.04 * a.r) && Math.abs(c.r - a.r) < Math.max(0.5, 0.03 * a.r));
    if (m) { m.n++; m.c = [(m.c[0] * (m.n - 1) + a.c[0]) / m.n, (m.c[1] * (m.n - 1) + a.c[1]) / m.n]; m.r = (m.r * (m.n - 1) + a.r) / m.n; for (const b of a.bins) m.bins.add(b); }
    else circles.push({ c: a.c, r: a.r, bins: new Set(a.bins), n: 1 });
  }
  const thinCircles = circles.filter(c => c.bins.size >= 18).map(c => prim('circle', { center: c.c, r: c.r }));
  // Schnittverlauf-Striche: kurze, breite gerade Komponenten
  const tc = I.components(thick, W, H, 8);
  for (let l = 1; l < tc.n; l++) {
    const [bx, by, bw, bh] = tc.stats[l]; const L = Math.max(bw, bh) * u, Wd = Math.min(bw, bh) * u;
    if (L > 4.5 && L < 12 && Wd < 2.2) {
      const lo = [bx * u, (H - by - bh) * u], hi = [(bx + bw) * u, (H - by) * u];
      strokes.push({ lo, hi, c: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2], size: [hi[0] - lo[0], hi[1] - lo[1]] });
    }
  }
  return { hatch, thinCircles, strokes };
}

/** Schraffierte Flächen im Raster: Hintergrundgebiete zwischen breiten Linien mit hoher Dichte dünner Schräglinien.
 *  Liefert je Fläche die geschlossene Randkontur (Primitive auf der Mitte der breiten Linien). */
function rasterHatchRegions(thick, geo, thickD, tmask, W, H, u, wth, f) {
  // Grenzen = Skelett der breiten Linien (Linienmitte) -> Flächenrand liegt exakt auf der Kantenmitte
  const skT = I.skeleton(thick, W, H);
  const bg = new Uint8Array(W * H); for (let i = 0; i < bg.length; i++) bg[i] = skT[i] ? 0 : 1;
  const cc = I.components(bg, W, H, 4); const st = cc.stats; const n = cc.n;
  // dünne Tinte je Gebiet sammeln (Pixelkoordinaten), dann Schräglinien zählen
  const pts = new Map();
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x; if (!(geo[i] && !thickD[i] && !tmask[i])) continue;
    // Pixel gehört zum Gebiet des nächstgelegenen Hintergrundlabels (dünne Linien sind selbst Hintergrund für „thick“)
    const l = cc.lab[i]; if (!l) continue;
    let q = pts.get(l); if (!q) pts.set(l, q = []); q.push(i);
  }
  const out = [];
  for (let l = 1; l < n; l++) {
    const [x0, y0, w, h, a] = st[l]; const amm = a * u * u;
    if (amm < 2 || w > 0.6 * W || h > 0.6 * H || x0 <= 1 || y0 <= 1 || x0 + w >= W - 1 || y0 + h >= H - 1) continue;
    const q = pts.get(l) || []; if (q.length < 20) continue;
    // Komponenten der dünnen Tinte im Gebiet
    const set = new Set(q); const seen = new Set(); let diagLen = 0, nDiag = 0;
    for (const s0 of q) {
      if (seen.has(s0)) continue; const comp = [s0]; seen.add(s0);
      for (let k = 0; k < comp.length; k++) { const c = comp[k]; for (const d of [1, -1, W, -W, W + 1, W - 1, -W + 1, -W - 1]) { const nb = c + d; if (set.has(nb) && !seen.has(nb)) { seen.add(nb); comp.push(nb); } } }
      if (comp.length < 8) continue;
      const P = comp.map(c => [c % W, (c - c % W) / W]); const [d, , l2] = I.pca(P);
      let ext = 0; { let mn = 1e9, mx = -1e9; for (const p of P) { const t = p[0] * d[0] + p[1] * d[1]; mn = Math.min(mn, t); mx = Math.max(mx, t); } ext = (mx - mn) * u; }
      const ang = Math.abs(Math.atan2(d[1], d[0]) * 180 / Math.PI) % 180;
      if (ext > 0.8 && Math.sqrt(l2 / P.length) * u < 0.3 && ((ang > 20 && ang < 75) || (ang > 105 && ang < 160))) { diagLen += ext; nDiag++; }
    }
    // Schraffur ist dicht: Schräglinienlänge je Fläche (Bemaßungs-/Hinweislinien in großen Ansichtsflächen sind dünn gesät)
    if (nDiag < 2 || diagLen < 2.5 || diagLen / amm < 0.025) continue;
    const dens = diagLen;
    const pd = Math.round(wth) + 4, ox = Math.max(0, x0 - pd), oy = Math.max(0, y0 - pd);
    const cw = Math.min(W, x0 + w + pd) - ox, ch = Math.min(H, y0 + h + pd) - oy;
    let reg = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (cc.lab[(oy + y) * W + ox + x] === l) reg[y * cw + x] = 1;
    // Einschnitte (Hilfs-/Schraffurlinien an der Kante) schließen, dünne Ausläufer entfernen
    { const rs = Math.max(3, 0.8 / u); reg = I.close(I.dilate(reg, cw, ch, 2), cw, ch, rs); }
    const cnt = I.outerContour(reg, cw, ch); if (!cnt) continue;
    const prims = fitContour(cnt.map(([x, y]) => [x + ox, y + oy]), u, H, 0.7 * Math.max(0.6, f), 1.2);
    if (prims.length) out.push({ prims, lo: [x0 * u, (H - y0 - h) * u], hi: [(x0 + w) * u, (H - y0) * u], area: amm, schraeg_mm: +dens.toFixed(1), n: nDiag });
  }
  return out;
}
export const fitCircleFn = I.fitCircle;

/** Feinabgleich des Maßstabs über Maßzahlen (DPI geraten): Abstände zwischen Kreismitten, achsparallelen Kanten und Ansichtsgrenzen
 *  mit Maßwerten vergleichen; dichtester Verhältnis-Cluster (±0,25 %) mit ≥ 4 Treffern liefert den Korrekturfaktor. */
export function fineScale(v, vals, s) {
  const xs = [v.lo[0], v.hi[0]], ys = [v.lo[1], v.hi[1]], ds = [];
  for (const p of v.prims) {
    if (p.kind === 'circle') { xs.push(p.center[0]); ys.push(p.center[1]); ds.push(2 * p.r); }
    else if (p.kind === 'line') { const d = [p.pts[1][0] - p.pts[0][0], p.pts[1][1] - p.pts[0][1]]; const L = Math.hypot(...d); if (L < 3) continue; if (Math.abs(d[0]) < 0.05) xs.push(p.pts[0][0]); if (Math.abs(d[1]) < 0.05) ys.push(p.pts[0][1]); }
  }
  const L = [...ds];
  for (const A of [xs, ys]) for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) { const d = Math.abs(A[i] - A[j]); if (d > 2) L.push(d); }
  const vs = [...new Set(vals)].filter(x => x >= 5 && !Number.isInteger(x));   // Nachkommastellen: weniger Zufallstreffer
  const rs = [];
  for (const val of vs) { let best = null; for (const l of L) { const r = val / (l / s); if (Math.abs(r - 1) < 0.025 && (!best || Math.abs(r - 1) < Math.abs(best - 1))) best = r; } if (best) rs.push(best); }
  rs.sort((a, b) => a - b); let bc = null;
  for (let i = 0; i < rs.length; i++) { const c = rs.filter(r => Math.abs(r - rs[i]) < 0.0025); if (!bc || c.length > bc.length) bc = c; }
  if (!bc || bc.length < 4) return null;
  const med = bc[Math.floor(bc.length / 2)];
  return Math.abs(med - 1) > 0.002 ? { f: med, n: bc.length } : null;
}

// eigene Funktion (eigener Scope), Bitfeld statt Byte-Maske: hält nur ~W*H/8 Byte fest, nicht die übrigen Masken von finish()
function makeThinAt(thin, u, W, H) {
  const bits = new Uint8Array((W * H + 7) >> 3); for (let i = 0; i < thin.length; i++) if (thin[i]) bits[i >> 3] |= 1 << (i & 7);
  return (x, y) => { const px = Math.round(x / u), py = Math.round(H - y / u); if (px < 0 || py < 0 || px >= W || py >= H) return 0; const i = py * W + px; return (bits[i >> 3] >> (i & 7)) & 1; };
}
