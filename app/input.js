// Dateien einlesen (Hauptthread): PDF (pdf.js), Bilder (Browser-Decoder), TIFF (UTIF). Liefert Daten für den Worker.
import * as Pdf from './core/pdfin.js';

let pdfjs = null;
async function loadPdfjs(base) {
  if (!pdfjs) {
    pdfjs = await import(base + 'vendor/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = base + 'vendor/pdf.worker.min.mjs';
  }
  return pdfjs;
}
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Skript nicht ladbar: ' + src)); document.head.appendChild(s); });
}

/** Ziel-Auflösung je Gerät (Speicher!). */
export function profile(alt = false) {
  const mobile = matchMedia('(pointer: coarse)').matches || (navigator.deviceMemory && navigator.deviceMemory <= 4);
  if (mobile) return alt ? { dpi: 300, maxPx: 18e6, mobile } : { dpi: 200, maxPx: 8e6, mobile };
  return alt ? { dpi: 200, maxPx: 8e6, mobile } : { dpi: 300, maxPx: 18e6, mobile };
}

// ---------- DPI aus Dateikopf
function pngDpi(b) {
  for (let i = 8; i + 8 < b.length;) {
    const len = (b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]) >>> 0; const t = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    if (t === 'pHYs') { const ppu = (b[i + 8] << 24 | b[i + 9] << 16 | b[i + 10] << 8 | b[i + 11]) >>> 0; return b[i + 16] === 1 ? ppu * 0.0254 : null; }
    if (t === 'IDAT' || t === 'IEND') return null; i += 12 + len;
  }
  return null;
}
function jpegDpi(b) {
  let i = 2;
  while (i + 4 < b.length && b[i] === 0xFF) {
    const mk = b[i + 1], len = b[i + 2] << 8 | b[i + 3];
    if (mk === 0xE0 && String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]) === 'JFIF') {
      const unit = b[i + 11], xd = b[i + 12] << 8 | b[i + 13];
      if (unit === 1) return xd; if (unit === 2) return xd * 2.54; return null;
    }
    if (mk === 0xDA) break; i += 2 + len;
  }
  return null;
}
/** Ohne DPI-Angabe: Auflösung raten, bei der das Bild genau ein DIN-A-Blatt (A4…A0) ergibt. */
function guessDpi(W, H) {
  const L = Math.max(W, H), S = Math.min(W, H);
  for (const dpi of [300, 200, 400, 150, 600, 250]) for (const [a, b] of [[297, 210], [420, 297], [594, 420], [841, 594], [1189, 841]]) {
    if (Math.abs(L * 25.4 / dpi / a - 1) < 0.015 && Math.abs(S * 25.4 / dpi / b - 1) < 0.015) return { dpi, fmt: 'A' + [4, 3, 2, 1, 0][[297, 420, 594, 841, 1189].indexOf(a)] };
  }
  return null;
}
const realDpi = d => (d && d >= 100 && d <= 2400 ? d : null); // 72/96 dpi sind Standardwerte ohne Aussage

function toGrayFromRGBA(rgba, n) {
  const g = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) { const a = rgba[j + 3]; const l = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8; g[i] = a === 255 ? l : 255 - ((255 - l) * a >> 8); }
  return g;
}
function canvasGray(src, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data; const g = toGrayFromRGBA(d, w * h);
  c.width = c.height = 1; return g;
}
function boxDown(gray, W, H, w, h) {
  const out = new Uint8Array(w * h); const sx = W / w, sy = H / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx)); let s = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { s += gray[yy * W + xx]; n++; }
      out[y * w + x] = s / n;
    }
  }
  return out;
}
function bilinUp(g, W, H, w, h) {
  const out = new Uint8Array(w * h); const sx = W / w, sy = H / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5), y0 = Math.min(H - 1, Math.floor(fy)), y1 = Math.min(H - 1, y0 + 1), ay = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5), x0 = Math.min(W - 1, Math.floor(fx)), x1 = Math.min(W - 1, x0 + 1), ax = fx - x0;
      out[y * w + x] = (g[y0 * W + x0] * (1 - ax) + g[y0 * W + x1] * ax) * (1 - ay) + (g[y1 * W + x0] * (1 - ax) + g[y1 * W + x1] * ax) * ay + 0.5;
    }
  }
  return out;
}
/** Ungleichmäßige Ausleuchtung (Foto) ausgleichen: Bild / grob geglätteter Hintergrund. */
function flattenIfNeeded(g, W, H) {
  const T = 16, tw = Math.ceil(W / T), th = Math.ceil(H / T); const bg = [];
  for (let ty = 0; ty < T; ty++) for (let tx = 0; tx < T; tx++) {
    const hist = new Uint32Array(256); let n = 0;
    for (let y = ty * th; y < Math.min(H, (ty + 1) * th); y += 4) for (let x = tx * tw; x < Math.min(W, (tx + 1) * tw); x += 4) { hist[g[y * W + x]]++; n++; }
    let acc = 0, p90 = 255; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= 0.9 * n) { p90 = v; break; } }
    bg.push(p90);
  }
  const mn = Math.min(...bg), mx = Math.max(...bg);
  if (mx - mn < 30) return false;
  for (let y = 0; y < H; y++) {
    const fy = Math.min(T - 1.001, Math.max(0, y / th - 0.5)); const iy = Math.floor(fy), ay = fy - iy;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(T - 1.001, Math.max(0, x / tw - 0.5)); const ix = Math.floor(fx), ax = fx - ix;
      const b = (bg[iy * T + ix] * (1 - ax) + bg[iy * T + ix + 1] * ax) * (1 - ay) + (bg[(iy + 1) * T + ix] * (1 - ax) + bg[(iy + 1) * T + ix + 1] * ax) * ay;
      const i = y * W + x; g[i] = Math.min(255, Math.round(g[i] * 255 / Math.max(b, 40)));
    }
  }
  return true;
}

/**
 * Datei -> { kind: 'vector', ex, tc, w, h, preview } oder { kind: 'raster', gray, W, H, dpi, dpiKnown, preview, msg }
 * preview: { canvas, pageW_mm, pageH_mm }
 */
export async function readFile(file, base, opts = {}) {
  const name = (file.name || '').toLowerCase(); const buf = new Uint8Array(await file.arrayBuffer());
  const prof = profile(opts.alt);
  const isPdf = name.endsWith('.pdf') || (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46);
  const isTiff = /\.tiff?$/.test(name) || (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 42) || (buf[0] === 0x4D && buf[1] === 0x4D && buf[3] === 42);
  if (isPdf) {
    const pj = await loadPdfjs(base);
    const doc = await pj.getDocument({ data: buf, isEvalSupported: false, verbosity: 0 }).promise;
    if (!doc.numPages) throw new Error('Die PDF-Datei enthält keine Seiten.');
    const page = await doc.getPage(1);
    const ol = await page.getOperatorList(); const ex = Pdf.extractDrawings(ol);
    const vp1 = page.getViewport({ scale: 1 }); const wPt = vp1.width, hPt = vp1.height;
    const pageW = wPt * Pdf.PT, pageH = hPt * Pdf.PT;
    const prevScale = Math.min(2, 900 / wPt);
    const prev = document.createElement('canvas'); const vpp = page.getViewport({ scale: prevScale });
    prev.width = Math.round(vpp.width); prev.height = Math.round(vpp.height);
    await page.render({ canvasContext: prev.getContext('2d'), viewport: vpp, background: '#ffffff' }).promise;
    if (!Pdf.pdfIsRaster(ex)) {
      const tc = Pdf.extractPhrases(await page.getTextContent());
      const [x0, y0, x1, y1] = page.view;
      doc.destroy();
      return { kind: 'vector', ex: { drawings: ex.drawings, images: ex.images }, tc, w: x1 - x0, h: y1 - y0, preview: { canvas: prev, pageW, pageH } };
    }
    // Scan-PDF: Seite rastern
    let dpi = prof.dpi; const px = (wPt / 72 * dpi) * (hPt / 72 * dpi);
    if (px > prof.maxPx) dpi *= Math.sqrt(prof.maxPx / px);
    const vp = page.getViewport({ scale: dpi / 72 }); const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    await page.render({ canvasContext: ctx, viewport: vp, background: '#ffffff' }).promise;
    const gray = toGrayFromRGBA(ctx.getImageData(0, 0, c.width, c.height).data, c.width * c.height);
    const W = c.width, H = c.height; c.width = c.height = 1; doc.destroy();
    return { kind: 'raster', gray, W, H, dpi: dpi * W / vp.width, dpiKnown: true, preview: { canvas: prev, pageW, pageH }, msg: `PDF enthält nur ein Rasterbild (Scan) – gerastert mit ${Math.round(dpi)} dpi, Bildverarbeitung + OCR.` };
  }
  let W0, H0, srcDpi, gray, W, H, prevCanvas, photo = false, guessed = null;
  if (isTiff) {
    if (!self.UTIF) { await loadScript(base + 'vendor/pako_inflate.min.js'); await loadScript(base + 'vendor/UTIF.js'); }
    const ifds = self.UTIF.decode(buf.buffer); const ifd = ifds[0]; self.UTIF.decodeImage(buf.buffer, ifd);
    W0 = ifd.width; H0 = ifd.height;
    const xr = ifd.t282 ? ifd.t282[0] : null; const unit = ifd.t296 ? ifd.t296[0] : 2;
    srcDpi = opts.dpi || realDpi(xr ? (unit === 3 ? xr * 2.54 : xr) : null);
    if (!srcDpi) { const gd = guessDpi(W0, H0); if (gd) { srcDpi = gd.dpi; guessed = gd; } }
    const rgba = self.UTIF.toRGBA8(ifd); let g0 = toGrayFromRGBA(rgba, W0 * H0);
    const s = scaleFor(W0, H0, srcDpi, prof); W = Math.round(W0 * s); H = Math.round(H0 * s);
    gray = s < 0.999 ? boxDown(g0, W0, H0, W, H) : s > 1.001 ? bilinUp(g0, W0, H0, W, H) : g0; g0 = null;
    prevCanvas = grayCanvas(gray, W, H, 900);
  } else {
    const bmp = await createImageBitmap(file);
    W0 = bmp.width; H0 = bmp.height;
    srcDpi = opts.dpi || realDpi(buf[0] === 0x89 ? pngDpi(buf) : (buf[0] === 0xFF ? jpegDpi(buf) : null));
    photo = buf[0] === 0xFF && !srcDpi && !opts.dpi;
    if (!srcDpi) { const gd = guessDpi(W0, H0); if (gd) { srcDpi = gd.dpi; guessed = gd; } }
    const s = scaleFor(W0, H0, srcDpi, prof); W = Math.round(W0 * s); H = Math.round(H0 * s);
    gray = canvasGray(bmp, W, H);
    const ps = Math.min(1, 900 / W0); prevCanvas = document.createElement('canvas'); prevCanvas.width = Math.round(W0 * ps); prevCanvas.height = Math.round(H0 * ps);
    prevCanvas.getContext('2d').drawImage(bmp, 0, 0, prevCanvas.width, prevCanvas.height); bmp.close && bmp.close();
  }
  const dpi = (srcDpi || 300) * W / W0;
  let msg = null;
  if (flattenIfNeeded(gray, W, H)) msg = 'Ungleichmäßige Ausleuchtung erkannt (Foto?) – Hintergrund ausgeglichen.';
  if (guessed) msg = (msg ? msg + ' ' : '') + `Keine DPI-Angabe – Bildgröße passt zu DIN ${guessed.fmt} bei ${guessed.dpi} dpi (vorläufig, Maßstab wird über Maßzahlen geprüft).`;
  if (photo) msg = (msg ? msg + ' ' : '') + 'Hinweis: Fotos nur frontal und unverzerrt verwenden (keine Perspektivkorrektur).';
  return { kind: 'raster', gray, W, H, W0, dpi, dpiKnown: !!srcDpi && !guessed, preview: { canvas: prevCanvas, pageW: W * 25.4 / dpi, pageH: H * 25.4 / dpi }, msg };
}
function scaleFor(W0, H0, srcDpi, prof) {
  // Hochskalieren (bis 1,6×) nur bei bekannter, niedriger Auflösung: 200-dpi-Scans werden bei 300 dpi robuster erkannt
  let s = srcDpi ? Math.min(1.6, prof.dpi / srcDpi) : Math.min(1, prof.dpi / 300);
  if (W0 * H0 * s * s > prof.maxPx) s = Math.sqrt(prof.maxPx / (W0 * H0));
  return s;
}
function grayCanvas(g, W, H, maxW) {
  const s = Math.min(1, maxW / W); const w = Math.round(W * s), h = Math.round(H * s);
  const c = document.createElement('canvas'); c.width = w; c.height = h; const ctx = c.getContext('2d'); const im = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = g[Math.floor(y / s) * W + Math.floor(x / s)]; const j = (y * w + x) * 4; im.data[j] = im.data[j + 1] = im.data[j + 2] = v; im.data[j + 3] = 255; }
  ctx.putImageData(im, 0, 0); return c;
}

// ---------- OCR (tesseract.js, erst bei Bedarf geladen)
const TESS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.esm.min.js';
let tessWorker = null;
export async function getOcr(progress) {
  if (tessWorker) return tessWorker;
  progress('Lade Texterkennung (tesseract.js, deu+eng) …');
  const T = await import(TESS);
  const createWorker = T.createWorker || (T.default && T.default.createWorker);
  tessWorker = await createWorker(['deu', 'eng'], 1, {
    langPath: 'https://tessdata.projectnaptha.com/4.0.0_fast',
    logger: m => { if (m.status && m.progress != null && /load|initializ/.test(m.status)) progress(`OCR: ${m.status} ${Math.round(m.progress * 100)} %`); },
  });
  await tessWorker.setParameters({ tessedit_pageseg_mode: '11' });
  return tessWorker;
}
