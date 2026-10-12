// CAD-Worker: OpenCascade (replicad, WASM) + Rekonstruktions-Pipeline. Hält die UI frei.
import * as Pdf from './core/pdfin.js';
import * as Ra from './core/raster.js';
import * as RC from './core/recon.js';

let replicad = null, oc = null, ready = null;
let lastDr = null, lastSolid = null, pre = null;

const post = (m, tr) => self.postMessage(m, tr || []);
const prog = (id, text, frac) => post({ type: 'progress', id, text, frac });

async function init(base) {
  const t0 = performance.now();
  prog(0, 'Lade CAD-Kern (replicad) …', 0);
  replicad = await import(base + 'vendor/replicad.js');
  const ocMod = await import(base + 'vendor/replicad_single.js');
  const url = base + 'vendor/replicad_single.wasm';
  const r = await fetch(url); if (!r.ok) throw new Error('WASM HTTP ' + r.status);
  const total = +r.headers.get('content-length') || 22980267;
  let bytes;
  if (r.body && r.body.getReader) {
    const rd = r.body.getReader(); const parts = []; let n = 0, last = 0;
    for (;;) {
      const { done, value } = await rd.read(); if (done) break; parts.push(value); n += value.length;
      if (n - last > 400000) { last = n; prog(0, `Lade OpenCascade-WASM … ${(n / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`, Math.min(0.95, n / total)); }
    }
    bytes = new Uint8Array(n); let o = 0; for (const p of parts) { bytes.set(p, o); o += p.length; }
  } else bytes = new Uint8Array(await r.arrayBuffer());
  prog(0, 'Initialisiere WASM …', 0.97);
  oc = await ocMod.default({
    print: () => {}, printErr: () => {},
    instantiateWasm(imports, done) { WebAssembly.instantiate(bytes, imports).then(res => done(res.instance, res.module)); return {}; },
  });
  bytes = null;
  replicad.setOC(oc); RC.setLib(replicad, oc);
  post({ type: 'ready', ms: performance.now() - t0 });
}

function run(id, dr, edits) {
  const t = performance.now();
  const work = structuredClone(dr);
  const { solid, result, mesh, edgeMesh } = RC.processDrawing(work, edits, txt => prog(id, txt));
  lastSolid = solid;
  result.ms = Math.round(performance.now() - t);
  const lines = Float32Array.from(edgeMesh.lines);
  post({ type: 'result', id, result, mesh, edgeLines: lines, edgeGroups: edgeMesh.edgeGroups },
    [mesh.vertices.buffer, mesh.normals.buffer, mesh.triangles.buffer, lines.buffer]);
}

function fail(id, e) {
  let msg;
  if (e instanceof Error) msg = e.message;
  else if (typeof WebAssembly !== 'undefined' && WebAssembly.Exception && e instanceof WebAssembly.Exception) msg = 'OpenCascade-Fehler bei der Volumenmodellierung (Konturen passen nicht zusammen).';
  else msg = String(e);
  post({ type: 'error', id, message: msg, recon: e && e.constructor && e.constructor.name === 'ReconError' });
}

self.onmessage = async ev => {
  const m = ev.data; const id = m.id;
  try {
    if (m.type === 'init') { ready = init(m.base); await ready; return; }
    await ready;
    if (m.type === 'vector') {
      prog(id, 'Vektorgeometrie auswerten …');
      lastDr = Pdf.readPdfVector(m.ex, m.tc, m.w, m.h);
      run(id, lastDr, null);
    } else if (m.type === 'raster_prepare') {
      prog(id, 'Bild binarisieren …');
      pre = Ra.prepare(m.gray, m.W, m.H, m.dpi); pre.dpiKnown = m.dpiKnown;
      const txt = pre.txt; pre.txt = null;
      post({ type: 'ocr_needed', id, txt, W: m.W, H: m.H, up: Math.max(1, 300 / m.dpi) }, [txt.buffer]);
    } else if (m.type === 'raster_finish') {
      prog(id, 'Linien, Konturen, Strichlinien …');
      const ocr = Ra.phrasesFromOcr(m.passes, pre.u, pre.W, pre.H);
      lastDr = Ra.finish(pre, ocr, pre.dpiKnown, txt => prog(id, txt));
      if (m.extraMsg) lastDr.msgs.unshift(m.extraMsg);
      pre = null;
      run(id, lastDr, null);
    } else if (m.type === 'rebuild') {
      if (!lastDr) throw new Error('Keine Zeichnung geladen.');
      run(id, lastDr, m.edits);
    } else if (m.type === 'export') {
      if (!lastSolid) throw new Error('Kein Modell vorhanden.');
      if (m.format === 'step') {
        const st = RC.stepText(lastSolid, m.schema);
        post({ type: 'export', id, format: 'step', text: st.text, schema: st.schema });
      } else if (m.format === 'stl') {
        const blob = lastSolid.blobSTL({ tolerance: 0.02, angularTolerance: 0.1, binary: true });
        post({ type: 'export', id, format: 'stl', blob });
      }
    }
  } catch (e) { fail(id, e); }
};
