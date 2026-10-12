// Kleine Bildverarbeitungs-Bibliothek (Ersatz für OpenCV): Binärmasken als Uint8Array (0/1), Zeilen-major.

export function gaussBlur3(g, W, H) {
  const t = new Uint16Array(W * H), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) { const r = y * W;
    for (let x = 0; x < W; x++) { const a = g[r + (x > 0 ? x - 1 : 1)], c = g[r + (x < W - 1 ? x + 1 : W - 2)]; t[r + x] = a + 2 * g[r + x] + c; } }
  for (let y = 0; y < H; y++) { const u = (y > 0 ? y - 1 : 1) * W, d = (y < H - 1 ? y + 1 : H - 2) * W, r = y * W;
    for (let x = 0; x < W; x++) out[r + x] = (t[u + x] + 2 * t[r + x] + t[d + x] + 8) >> 4; }
  return out;
}

export function otsu(g) {
  const h = new Float64Array(256); for (let i = 0; i < g.length; i++) h[g[i]]++;
  const N = g.length; let sum = 0; for (let i = 0; i < 256; i++) sum += i * h[i];
  let sB = 0, wB = 0, best = 0, thr = 0;
  for (let t = 0; t < 256; t++) {
    wB += h[t]; if (!wB) continue; const wF = N - wB; if (!wF) break;
    sB += t * h[t]; const mB = sB / wB, mF = (sum - sB) / wF; const v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; thr = t; }
  }
  return thr;
}

/** Quadratische euklidische Distanz zum nächsten Pixel mit mask==target (Felzenszwalb). */
export function edt2(mask, W, H, target = 1) {
  const INF = 1e20, n = Math.max(W, H);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const D = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) D[i] = mask[i] === target ? 0 : INF;
  const pass = (len, get, set) => {
    for (let q = 0; q < len; q++) f[q] = get(q);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s;
      for (;;) { const p = v[k]; s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p); if (s <= z[k] && k > 0) k--; else break; }
      if (s <= z[k]) { v[0] = q; z[0] = -INF; z[1] = INF; k = 0; continue; }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; const p = v[k]; d[q] = (q - p) * (q - p) + f[p]; }
    for (let q = 0; q < len; q++) set(q, d[q]);
  };
  for (let x = 0; x < W; x++) pass(H, q => D[q * W + x], (q, val) => { D[q * W + x] = val; });
  for (let y = 0; y < H; y++) { const r = y * W; pass(W, q => D[r + q], (q, val) => { D[r + q] = val; }); }
  return D;
}

const rho2 = d => { d = Math.max(1, Math.round(d)); const r = (d - 1) / 2 + 0.3; return r * r; };
export function dilate(mask, W, H, d) {
  const r2 = rho2(d); if (r2 < 1) return mask.slice();
  const D = edt2(mask, W, H, 1); const out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = D[i] <= r2 ? 1 : 0; return out;
}
export function erode(mask, W, H, d) {
  const r2 = rho2(d); if (r2 < 1) return mask.slice();
  const D = edt2(mask, W, H, 0); const out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = (mask[i] && D[i] > r2) ? 1 : 0;
  // Rand: außerhalb gilt als Hintergrund wie bei OpenCV-Standard (BORDER_CONSTANT = max) -> nicht erodieren am Bildrand
  return out;
}
export const open = (m, W, H, d) => dilate(erode(m, W, H, d), W, H, d);
export const close = (m, W, H, d) => erode(dilate(m, W, H, d), W, H, d);

export function open2x2(m, W, H) {
  const e = new Uint8Array(W * H);
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) { const i = y * W + x; e[i] = m[i] & m[i + 1] & m[i + W] & m[i + W + 1]; }
  const o = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    o[i] = e[i] | (x > 0 ? e[i - 1] : 0) | (y > 0 ? e[i - W] : 0) | (x > 0 && y > 0 ? e[i - W - 1] : 0);
  }
  return o;
}

/** Zusammenhangskomponenten: labels (0=Hintergrund), stats[i] = [x,y,w,h,area]. */
export function components(mask, W, H, conn = 8) {
  const lab = new Int32Array(W * H); const stats = [null]; const stack = new Int32Array(W * H);
  let n = 1;
  for (let s = 0; s < W * H; s++) {
    if (!mask[s] || lab[s]) continue;
    let sp = 0; stack[sp++] = s; lab[s] = n;
    let x0 = W, y0 = H, x1 = -1, y1 = -1, area = 0;
    while (sp) {
      const p = stack[--sp]; const x = p % W, y = (p - x) / W; area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue; if (conn === 4 && dx && dy) continue;
          const xx = x + dx; if (xx < 0 || xx >= W) continue;
          const q = yy * W + xx; if (mask[q] && !lab[q]) { lab[q] = n; stack[sp++] = q; }
        }
      }
    }
    stats.push([x0, y0, x1 - x0 + 1, y1 - y0 + 1, area]); n++;
  }
  return { n, lab, stats };
}

/** Zhang-Suen-Ausdünnung (Skelett). */
export function skeleton(mask, W, H) {
  const m = mask.slice(); const del = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let it = 0; it < 2; it++) {
      del.length = 0;
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x; if (!m[i]) continue;
        const p2 = m[i - W], p3 = m[i - W + 1], p4 = m[i + 1], p5 = m[i + W + 1], p6 = m[i + W], p7 = m[i + W - 1], p8 = m[i - 1], p9 = m[i - W - 1];
        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9; if (B < 2 || B > 6) continue;
        const A = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
        if (A !== 1) continue;
        if (it === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)) continue;
        del.push(i);
      }
      if (del.length) { changed = true; for (const i of del) m[i] = 0; }
    }
  }
  return m;
}

/** Flutfüllung (4er) des Hintergrunds ab (0,0); Rückgabe: 1 = innen oder Linie. */
export function fillHoles(crop, w, h) {
  const out = new Uint8Array(w * h).fill(1); const stack = new Int32Array(w * h); let sp = 0;
  if (!crop[0]) { stack[sp++] = 0; out[0] = 0; }
  while (sp) {
    const p = stack[--sp]; const x = p % w, y = (p - x) / w;
    const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
    for (const q of nb) if (q >= 0 && out[q] && !crop[q]) { out[q] = 0; stack[sp++] = q; }
  }
  return out;
}

/** Äußere Kontur (Moore-Nachbarschaft) der größten 8er-Komponente einer Maske -> [[x,y],...]. */
export function outerContour(mask, w, h) {
  const { n, lab, stats } = components(mask, w, h, 8);
  if (n < 2) return null;
  let best = 1; for (let i = 2; i < n; i++) if (stats[i][4] > stats[best][4]) best = i;
  let start = -1; for (let i = 0; i < w * h; i++) if (lab[i] === best) { start = i; break; }
  const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && lab[y * w + x] === best;
  const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];
  const sx = start % w, sy = (start - sx) / w; const pts = [[sx, sy]];
  let x = sx, y = sy, dir = 7;
  for (let guard = 0; guard < 4 * w * h; guard++) {
    let found = false;
    for (let k = 0; k < 8; k++) {
      const d = (dir + 6 + k) % 8; // links beginnen (gegen Uhrzeigersinn suchen)
      const nx = x + DX[d], ny = y + DY[d];
      if (inside(nx, ny)) { x = nx; y = ny; dir = d; found = true; break; }
    }
    if (!found) break;
    if (x === sx && y === sy) break;
    pts.push([x, y]);
  }
  return pts;
}

/** Douglas-Peucker für geschlossene Kontur; liefert Indizes. */
export function approxPolyClosed(P, eps) {
  const n = P.length; if (n < 3) return [...Array(n).keys()];
  let far = 0, fd = -1; for (let i = 0; i < n; i++) { const d = (P[i][0] - P[0][0]) ** 2 + (P[i][1] - P[0][1]) ** 2; if (d > fd) { fd = d; far = i; } }
  const keep = new Uint8Array(n); keep[0] = 1; keep[far] = 1;
  const rec = (i0, i1) => { // i1 kann > n sein (zyklisch)
    const a = P[i0 % n], b = P[i1 % n]; const dx = b[0] - a[0], dy = b[1] - a[1]; const L = Math.hypot(dx, dy) || 1e-12;
    let md = -1, mi = -1;
    for (let i = i0 + 1; i < i1; i++) { const p = P[i % n]; const d = Math.abs(dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / L; if (d > md) { md = d; mi = i; } }
    if (md > eps) { keep[mi % n] = 1; rec(i0, mi); rec(mi, i1); }
  };
  rec(0, far); rec(far, n);
  const out = []; for (let i = 0; i < n; i++) if (keep[i]) out.push(i); return out;
}

export function fitCircle(P) {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sz = 0, sxz = 0, syz = 0; const n = P.length;
  // zentrieren für Stabilität
  let mx = 0, my = 0; for (const p of P) { mx += p[0]; my += p[1]; } mx /= n; my /= n;
  for (const p of P) { const x = p[0] - mx, y = p[1] - my, z = x * x + y * y; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sz += z; sxz += x * z; syz += y * z; }
  // Lösen: [2sxx 2sxy sx; 2sxy 2syy sy; 2sx 2sy n] [cx cy c] = [sxz syz sz]
  const A = [[2 * sxx, 2 * sxy, sx], [2 * sxy, 2 * syy, sy], [2 * sx, 2 * sy, n]], b = [sxz, syz, sz];
  const sol = solve3(A, b); if (!sol) return [[mx, my], 0, Infinity];
  const c = [sol[0] + mx, sol[1] + my]; const r = Math.sqrt(Math.max(sol[2] + sol[0] ** 2 + sol[1] ** 2, 1e-12));
  let e = 0; for (const p of P) e += (Math.hypot(p[0] - c[0], p[1] - c[1]) - r) ** 2;
  return [c, r, Math.sqrt(e / n)];
}
export function solve3(A, b) {
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null; [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 3; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k]; }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

/** Hauptachse (PCA): [richtung, mittelpunkt, kleinster Eigenwert]. */
export function pca(Q) {
  let mx = 0, my = 0; for (const p of Q) { mx += p[0]; my += p[1]; } mx /= Q.length; my /= Q.length;
  let a = 0, b = 0, c = 0; for (const p of Q) { const x = p[0] - mx, y = p[1] - my; a += x * x; b += x * y; c += y * y; }
  const tr = a + c, det = a * c - b * b, disc = Math.sqrt(Math.max(tr * tr / 4 - det, 0));
  const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
  let d = Math.abs(b) > 1e-12 ? [l1 - c, b] : (a >= c ? [1, 0] : [0, 1]);
  const L = Math.hypot(d[0], d[1]); d = [d[0] / L, d[1] / L];
  return [d, [mx, my], Math.max(l2, 0)];
}
