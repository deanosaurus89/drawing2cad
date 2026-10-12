// OCR-Hilfen (tesseract.js): Nur-Text-Bild -> zwei Durchgänge (normal + 90° gedreht).
export function pgm(gray, W, H) {
  const head = new TextEncoder().encode(`P5\n${W} ${H}\n255\n`);
  const out = new Uint8Array(head.length + W * H); out.set(head); out.set(gray, head.length); return out;
}
export function rotCW(gray, W, H) { // np.rot90(g, -1)
  const out = new Uint8Array(W * H); // neue Größe: W' = H, H' = W
  for (let r = 0; r < W; r++) for (let c = 0; c < H; c++) out[r * H + c] = gray[(H - 1 - c) * W + r];
  return out;
}
/** Text-Bild beschneiden auf Bereich mit Tinte (spart OCR-Zeit); liefert Offset. */
export function cropInk(gray, W, H, pad = 20) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (gray[y * W + x] < 128) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  const w = x1 - x0 + 1, h = y1 - y0 + 1; const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) out.set(gray.subarray((y0 + y) * W + x0, (y0 + y) * W + x0 + w), y * w);
  return { gray: out, w, h, x0, y0 };
}
export function linesOf(data) {
  const lines = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || [])
    lines.push({ words: (l.words || []).map(w => ({ text: w.text, confidence: w.confidence, bbox: w.bbox })) });
  if (!lines.length && data.lines) for (const l of data.lines) lines.push({ words: l.words.map(w => ({ text: w.text, confidence: w.confidence, bbox: w.bbox })) });
  return lines;
}
/** recognize: async (Uint8Array pgm) -> tesseract data. Liefert passes für raster.phrasesFromOcr. */
export function upscaleNN(g, w, h, f) {
  const W2 = Math.round(w * f), H2 = Math.round(h * f); const out = new Uint8Array(W2 * H2);
  const xs = new Int32Array(W2); for (let x = 0; x < W2; x++) xs[x] = Math.min(w - 1, Math.floor(x / f));
  for (let y = 0; y < H2; y++) { const r = Math.min(h - 1, Math.floor(y / f)) * w, o = y * W2; for (let x = 0; x < W2; x++) out[o + x] = g[r + xs[x]]; }
  return { gray: out, w: W2, h: H2 };
}
export async function ocrPasses(recognize, txt, W, H, progress = () => {}, up = 1) {
  const passes = [];
  let c = cropInk(txt, W, H);
  if (!c) return passes;
  if (up > 1.05) { const u2 = upscaleNN(c.gray, c.w, c.h, up); const k = { x0: c.x0, y0: c.y0 }; c = { ...u2, x0: 0, y0: 0, scale: up, ox: k.x0, oy: k.y0 }; }
  else c.scale = 1, c.ox = c.x0, c.oy = c.y0, c.x0 = 0, c.y0 = 0;
  progress('Texterkennung (OCR) 1/2 …');
  const d0 = await recognize(pgm(c.gray, c.w, c.h));
  const l0 = linesOf(d0);
  const S = c.scale;
  for (const l of l0) for (const w of l.words) { w.bbox = { x0: w.bbox.x0 / S + c.ox, x1: w.bbox.x1 / S + c.ox, y0: w.bbox.y0 / S + c.oy, y1: w.bbox.y1 / S + c.oy }; }
  passes.push({ rot: 0, lines: l0, imgH: H });
  progress('Texterkennung (OCR) 2/2 (senkrechte Maße) …');
  const rg = rotCW(c.gray, c.w, c.h); // gedrehter Ausschnitt: Breite c.h, Höhe c.w
  const d1 = await recognize(pgm(rg, c.h, c.w));
  const l1 = linesOf(d1);
  // Ausschnitt-Koordinaten (gedreht, skaliert) -> gedrehtes Vollbild: xr_full = xr/S + (H - oy - h/S), yr_full = yr/S + ox
  const ox = H - c.oy - c.h / S, oy = c.ox;
  for (const l of l1) for (const w of l.words) { w.bbox = { x0: w.bbox.x0 / S + ox, x1: w.bbox.x1 / S + ox, y0: w.bbox.y0 / S + oy, y1: w.bbox.y1 / S + oy }; }
  passes.push({ rot: -1, lines: l1, imgH: W });
  return passes;
}
