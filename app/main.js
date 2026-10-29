// UI-Steuerung: Dateien, Worker, OCR, Maßtabelle, Export, Tabs.
import { readFile, getOcr, profile } from './input.js';
import { ocrPasses } from './core/ocr.js';
import { Viewer, TYPE_COLORS, TYPE_NAMES } from './viewer.js';
import { createSectionUI } from './sectionui.js';
import { createStackUI } from './stackui.js';
import { dimKlasse, pruefmerkmale } from './core/dims.js';
import { analyseBlatt } from './core/recon.js';
import { createViewUI } from './viewui.js';
import { BUILD, showWhatsNew, maybeShowWhatsNew, versionText } from './changelog.js';

const BASE = new URL('../', import.meta.url).href;
const $ = s => document.querySelector(s);
const BEISPIELE = [
  ['01_flansch.pdf', 'Flansch (Vektor-PDF)'], ['02_welle.pdf', 'Welle (Vektor-PDF)'], ['03_halteplatte.pdf', 'Halteplatte (Vektor-PDF)'],
  ['04_winkel.pdf', 'Winkel (Vektor-PDF)'], ['05_stufenblock.pdf', 'Stufenblock (Vektor-PDF)'],
  ['r01_flansch_scan.png', 'Flansch (Scan PNG)'], ['r02_welle_scan.tif', 'Welle (Scan TIFF)'], ['r03_halteplatte_scan.pdf', 'Halteplatte (Scan-PDF)'],
  ['r04_winkel_scan.jpg', 'Winkel (Scan JPG)'], ['r05_stufenblock_scan.tif', 'Stufenblock (Scan TIFF)'],
  ['06_buchse.pdf', 'Buchse – Schnitt A-A + Einzelheit Z (Vektor-PDF)'], ['07_lagerplatte_schnitt.pdf', 'Lagerplatte – Schnitt A-A (Vektor-PDF)'],
  ['r06_buchse_scan.tif', 'Buchse – Schnitt + Einzelheit (Scan TIFF)'], ['r07_lagerplatte_schnitt_scan.pdf', 'Lagerplatte – Schnitt (Scan-PDF)'],
  ['real/xometry_lathe_sample.webp', 'Reale Zeichnung: Drehteil (WEBP, 90 dpi)'],
  ['real/drehteil_rillen_4zu1.jpg', 'Reale Zeichnung: Drehteil mit Rillen, Schnitt, 4:1 (JPG)'],
  ['real/platte_schraege_1zu2.jpg', 'Reale Zeichnung: Platte mit Kegelloch, 1:2 (JPG)'],
];
const TRAINING = [
  ['train/01_welle.pdf', 'Training: 01 Welle (PDF)'],
  ['train/02_winkel.pdf', 'Training: 02 Winkel (PDF)'],
  ['train/03_verbindung.pdf', 'Training: 03 Verbindung (PDF)'],
  ['train/04_stempel.pdf', 'Training: 04 Stempel (PDF)'],
  ['train/05_lochverbund.pdf', 'Training: 05 Lochverbund (PDF)'],
  ['train/06_nutwelle.pdf', 'Training: 06 Nutwelle (PDF)'],
  ['train/07_hebel.pdf', 'Training: 07 Hebel (PDF)'],
  ['train/08_flansch.jpg', 'Training: 08 Flansch, Maximum-Material (JPG)'],
];

const state = { busy: false, result: null, file: null, preview: null, edits: {}, msgs: [], auto: null };
let sectionUi;
window.__ready = false; window.__state = state;

// ---------------------------------------------------------------- Worker
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let seq = 0; const pending = new Map();
let workerReady;
const readyP = new Promise((res, rej) => { workerReady = { res, rej }; });
worker.onmessage = ev => {
  const m = ev.data;
  if (m.type === 'progress') { status(m.text); if (m.frac != null) bar(m.frac); return; }
  if (m.type === 'ready') { workerReady.res(); return; }
  const p = pending.get(m.id); if (!p) { if (m.type === 'error' && m.id == null) workerReady.rej(new Error(m.message)); return; }
  if (m.type === 'ocr_needed') { p.onOcr(m); return; }
  pending.delete(m.id);
  if (m.type === 'error') p.rej(Object.assign(new Error(m.message), { recon: m.recon })); else p.res(m);
};
worker.onerror = e => { status('Worker-Fehler: ' + (e.message || e)); console.error(e); };
function call(msg, transfer, onOcr) { const id = ++seq; return new Promise((res, rej) => { pending.set(id, { res, rej, onOcr }); worker.postMessage({ ...msg, id }, transfer || []); }); }
worker.postMessage({ type: 'init', base: BASE });

// ---------------------------------------------------------------- UI-Helfer
function status(t) { $('#status').textContent = t; }
function bar(f) { $('#fortschritt div').style.width = f == null || f >= 1 ? '0' : (f * 100).toFixed(0) + '%'; }
function busy(b) { state.busy = b; for (const s of ['#neu', '#x-step', '#x-stl', '#x-pmi', '#sk-build', '#sk-stack']) { const el = $(s); if (el) el.disabled = b || !state.result; } $('#beispiel').disabled = b; }
function msg(t, err) { const d = document.createElement('div'); d.textContent = t; if (err) d.className = 'fehler'; $('#meldungen').appendChild(d); }
function tab(t) { $('main').dataset.tab = t; document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('aktiv', b.dataset.tab === t)); if (t === '3d') viewer.resize(); }
document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => tab(b.dataset.tab)));
const fmt = (x, d = 3) => x == null ? '–' : (typeof x === 'number' ? (+x.toFixed(d)).toLocaleString('de-DE') : Array.isArray(x) ? '(' + x.map(v => fmt(v, 2)).join('; ') + ')' : String(x));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const viewer = new Viewer($('#ansicht'), $('#viewcube'), $('#labels'));
$('#fit').onclick = () => viewer.fitAll();
$('#o-farben').onchange = e => viewer.setOption('colors', e.target.checked);
$('#o-kanten').onchange = e => viewer.setOption('edges', e.target.checked);
$('#o-pmi').onchange = e => viewer.setOption('pmi', e.target.checked);
$('#legende').innerHTML = Object.entries(TYPE_NAMES).filter(([k]) => k !== 'other').map(([k, n]) => `<span><i style="background:#${TYPE_COLORS[k].toString(16).padStart(6, '0')}"></i>${n}</span>`).join('');

viewer.onPick = s => {
  const box = $('#auswahl'); document.querySelectorAll('#pmi li').forEach(li => li.classList.toggle('aktiv', !!s && s.kind === 'pmi' && li.dataset.id === s.id));
  if (!s || s.kind === 'pmi') { if (!s || s.kind !== 'pmi') { box.hidden = true; return; } }
  let obj, title;
  if (s.kind === 'flaeche') { obj = state.result.flaechen[s.index]; title = `Fläche ${s.index + 1}`; }
  else if (s.kind === 'kante') { obj = state.result.kanten[s.index]; title = `Kante ${s.index + 1}`; }
  else { obj = state.result.pmi.find(p => p.id === s.id); title = s.id; }
  const skip = new Set(['p', 'tri', 'typ_en', 'bezuege', 'anker_3d', 'label_3d']);
  const rows = Object.entries(obj).filter(([k]) => !skip.has(k)).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(fmt(v))}</td></tr>`).join('');
  const refs = obj.bezuege ? `<tr><td>Bezüge</td><td>${esc(obj.bezuege.map(b => b.rolle + ': ' + (b.flaechen.length ? b.flaechen.join(', ') : '—')).join(' · '))}</td></tr>` : '';
  box.innerHTML = `<b>${esc(title)}</b><table>${rows}${refs}</table>`; box.hidden = false;
};
viewer.onPmiClick = it => { viewer.selectSids(it.bezuege.flatMap(b => b.flaechen), it.id); };

// ---------------------------------------------------------------- Laden
async function ladeDatei(file, alt = false, dpi = null) {
  if (state.busy) return; busy(true); state.wartet = false;
  state.file = file; state.edits = {}; $('#meldungen').innerHTML = '';
  const t0 = performance.now();
  try {
    status('Lese ' + file.name + ' …'); bar(0.05);
    const inp = await readFile(file, BASE, { alt, dpi });
    showPreview(inp.preview);
    if (inp.msg) msg(inp.msg);
    await readyP;
    if (inp.kind === 'vector') {
      status('Ansichten erkennen …');
      state.vectorInp = { ex: inp.ex, tc: inp.tc, w: inp.w, h: inp.h };
      const a = analyseBlatt(inp.ex, inp.tc, inp.w, inp.h);
      state.analyse = a;
      viewUi.show(a);
      fillPruef(pruefmerkmale([], a.dr && a.dr.phrases));
      if (!a.auto) {
        msg(a.grund);
        status(a.grund);
        state.wartet = true;
        window.__ready = 'ansichten';
        busy(false);
        tab('zeichnung');
        return;
      }
    } else { state.vectorInp = null; viewUi.reset(); }
    let r;
    if (inp.kind === 'vector') r = await call({ type: 'vector', ex: inp.ex, tc: inp.tc, w: inp.w, h: inp.h });
    else r = await rasterRun(inp);
    const R = r.result, ks = R.massstab_schriftfeld;
    if (inp.kind === 'raster' && !inp.dpiKnown && !dpi && ks && Math.abs(R.massstab / ks - 1) > 0.03) {
      // Bild ohne DPI: tatsächliche Auflösung aus Schriftfeld-Maßstab und gemessenem Faktor ableiten, neu auswerten
      const est = Math.round(inp.dpi * inp.W0 / inp.W * R.massstab / ks);
      if (est >= 100 && est <= 1200) { msg(`Auflösung aus Maßstab geschätzt: ≈ ${est} dpi – neue Auswertung …`); busy(false); return ladeDatei(file, alt, est); }
    }
    state.ok = true; zeige(r, file.name, performance.now() - t0);
    if (dpi) msg(`Bild ohne DPI-Angabe: Auflösung aus Schriftfeld-Maßstab und Maßzahlen auf ≈ ${dpi} dpi geschätzt.`);
  } catch (e) {
    const p = profile(true);
    if (!alt && lastRaster && !dpi) {
      msg(`Erster Versuch fehlgeschlagen (${e.message}) – neuer Versuch mit ${p.dpi} dpi …`);
      busy(false); return ladeDatei(file, true);
    }
    state.ok = false; fehler(e);
  } finally { if (state.busy) busy(false); bar(1); }
}
let lastRaster = false;
async function rasterRun(inp) {
  lastRaster = true;
  const gray = inp.gray;
  return call({ type: 'raster_prepare', gray, W: inp.W, H: inp.H, dpi: inp.dpi, dpiKnown: inp.dpiKnown }, [gray.buffer], async m => {
    try {
      const w = await getOcr(status);
      const recognize = async bytes => (await w.recognize(new Blob([bytes], { type: 'image/x-portable-graymap' }), {}, { blocks: true, text: false, hocr: false, tsv: false })).data;
      const passes = await ocrPasses(recognize, m.txt, m.W, m.H, t => status(t), m.up);
      worker.postMessage({ type: 'raster_finish', id: m.id, passes, extraMsg: inp.msg ? null : null });
    } catch (e) { const p = pending.get(m.id); pending.delete(m.id); p && p.rej(new Error('Texterkennung fehlgeschlagen: ' + (e.message || e))); }
  });
}
function fehler(e) {
  console.warn(e);
  status('Fehler: ' + e.message); msg('Rekonstruktion nicht möglich: ' + e.message, true);
  if (!state.result) { $('#info').innerHTML = '<p class="leer">–</p>'; }
  tab('zeichnung');
}

function showPreview(pv) {
  state.preview = pv; const el = $('#vorschau'); el.innerHTML = '';
  if (!pv) return;
  const wrap = document.createElement('div'); wrap.id = 'blatt'; wrap.className = 'blatt';
  pv.canvas.removeAttribute('style'); wrap.appendChild(pv.canvas);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.id = 'konturen';
  wrap.appendChild(svg);
  const g = document.createElement('div'); g.id = 'griffe'; wrap.appendChild(g);
  el.appendChild(wrap);
}
function drawViewBoxes(r) {
  const el = $('#vorschau'); el.querySelectorAll('.box').forEach(b => b.remove());
  const pv = state.preview; if (!pv || !r.ansichten || !r.page_w) return;
  const host = $('#blatt') || el; const svg = $('#konturen');
  for (const v of r.ansichten) {
    // Ansichtskoordinaten: mm, y nach oben ab Seitenunterkante
    const b = document.createElement('div'); b.className = 'box' + (v.art && v.art !== 'ansicht' ? ' ' + v.art : '');
    b.style.left = (v.lo[0] / r.page_w * 100) + '%'; b.style.width = ((v.hi[0] - v.lo[0]) / r.page_w * 100) + '%';
    b.style.top = ((r.page_h - v.hi[1]) / r.page_h * 100) + '%'; b.style.height = ((v.hi[1] - v.lo[1]) / r.page_h * 100) + '%';
    if (v.rolle) b.innerHTML = `<span>${esc(v.rolle)}</span>`;
    if (svg && svg.parentNode === host) host.insertBefore(b, svg); else host.appendChild(b);
  }
}

function zeige(r, name, ms, opts = {}) {
  const res = r.result; state.result = res; lastRaster = res.quelle === 'raster' || lastRaster;
  if (!opts.fromSection && r.mesh && r.mesh.vertices) {
    state.auto = {
      result: res,
      mesh: { vertices: r.mesh.vertices.slice(), normals: r.mesh.normals.slice(), triangles: r.mesh.triangles.slice(), groups: r.mesh.groups },
      edgeLines: r.edgeLines.slice(), edgeGroups: r.edgeGroups,
    };
  }
  viewer.setModel(r.mesh, r.edgeLines, r.edgeGroups, res);
  drawViewBoxes(res);
  for (const t of res.meldungen || []) msg(t);
  for (const t of res.aenderungen || []) msg(t);
  tabelleMasse(res);
  const st = Object.entries(res.flaechen_statistik).map(([k, v]) => `${v}× ${k}`).join(', ');
  const ks = Object.entries(res.kanten_statistik).map(([k, v]) => `${v}× ${k}`).join(', ');
  $('#info').innerHTML = `<table>
    <tr><td>Datei</td><td>${esc(name)}</td></tr><tr><td>Quelle</td><td>${res.quelle === 'raster' ? 'Rasterbild (OCR)' : 'Vektor-PDF'}</td></tr>
    <tr><td>Strategie</td><td>${esc(res.strategie)}</td></tr><tr><td>Maßstab</td><td>${esc(fmt(res.massstab, 4))}</td></tr>
    <tr><td>Volumen</td><td id="volumen">${fmt(res.volumen_mm3, 1)} mm³</td></tr><tr><td>Abmessungen</td><td>${res.bbox.map(v => fmt(v, 2)).join(' × ')} mm</td></tr>
    <tr><td>Gültig (BRepCheck)</td><td>${res.gueltig ? 'ja' : 'nein'}</td></tr><tr><td>Merkmale</td><td>${(res.merkmale || []).map(m => esc(typeof m === 'string' ? m : `${m.typ}: ${m.text}`)).join('<br>')}</td></tr>
    <tr><td>Flächen</td><td>${res.flaechen.length}: ${esc(st)}</td></tr><tr><td>Kanten</td><td>${res.kanten.length}: ${esc(ks)}</td></tr>
    <tr><td>Rechenzeit</td><td>${(ms / 1000).toFixed(1)} s</td></tr>
    ${res.sicherheit ? `<tr><td>Sicherheit</td><td class="k-${esc(res.sicherheit)}">${esc(res.sicherheit)} – ${esc(res.sicherheit_grund || '')}</td></tr>` : ''}
    </table>`;
  $('#pmi').innerHTML = '';
  for (const it of res.pmi) {
    const li = document.createElement('li'); li.dataset.id = it.id;
    const klasse = it.klasse || 'mass';
    li.dataset.klasse = klasse; li.classList.add('k-' + klasse);
    const n = it.bezuege.reduce((a, b) => a + b.flaechen.length, 0);
    li.innerHTML = `<b>${esc(it.id)}</b> ${esc(it.typ)}: ${esc(it.text)} <small>(${n} Fläche${n === 1 ? '' : 'n'})</small>`;
    li.onclick = () => { viewer.onPmiClick(it); tab('3d'); };
    $('#pmi').appendChild(li);
  }
  applyPmiFilter(state.pmiFilter || 'alle');
  fillPruef(pruefmerkmale(res.masse, (state.analyse && state.analyse.dr && state.analyse.dr.phrases) || []));
  try { sectionUi && sectionUi.onResult(res, opts); } catch (e) { console.warn(e); }
  try { stackUi && stackUi.onResult(res, opts); } catch (e) { console.warn(e); }
  status(`Fertig: ${res.flaechen.length} Flächen, ${fmt(res.volumen_mm3, 1)} mm³ (${(ms / 1000).toFixed(1)} s)`);
  window.__ready = true; window.__letztes = { name, volumen: res.volumen_mm3, flaechen: res.flaechen.length, pmi: res.pmi.length, gueltig: res.gueltig, strategie: res.strategie };
  if (!opts.fromSection && matchMedia('(max-width: 899px)').matches) tab('3d');
}
function tabelleMasse(res) {
  const tb = $('#masse tbody'); tb.innerHTML = '';
  for (const d of res.masse) {
    const tr = document.createElement('tr'); tr.className = (!d.editierbar ? 'fest ' : '') + 'k-' + dimKlasse(d);
    const cur = state.edits[d.id] ?? d.wert;
    tr.innerHTML = `<td>${esc(d.id)}</td><td>${esc(d.text)}</td><td></td>`;
    const inp = document.createElement('input'); inp.type = 'text'; inp.inputMode = 'decimal'; inp.value = String(cur).replace('.', ',');
    inp.disabled = !d.editierbar; inp.title = d.editierbar ? 'Wert ändern' : 'nicht parametrisch änderbar'; inp.dataset.id = d.id; inp.dataset.orig = d.wert;
    inp.addEventListener('input', () => inp.classList.toggle('geaendert', Math.abs(parseFloat(inp.value.replace(',', '.')) - d.wert) > 1e-9));
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') neu(); });
    tr.children[2].appendChild(inp); tb.appendChild(tr);
  }
  $('#zurueck').disabled = !Object.keys(state.edits).length;
}
async function neu() {
  if (state.busy || !state.result) return;
  const edits = { ...state.edits };
  document.querySelectorAll('#masse input').forEach(i => { const v = parseFloat(i.value.replace(',', '.')); if (isFinite(v)) { if (Math.abs(v - (+i.dataset.orig)) > 1e-9) edits[i.dataset.id] = v; } });
  return rebuild(edits);
}
async function rebuild(edits) {
  busy(true); $('#meldungen').innerHTML = ''; const t0 = performance.now(); window.__ready = false;
  try {
    const r = await call({ type: 'rebuild', edits });
    state.edits = edits; const keepOrig = state.result.masse; zeige(r, state.file ? state.file.name : '', performance.now() - t0);
    // Originalwerte für die Tabelle behalten
    for (const i of document.querySelectorAll('#masse input')) { const o = keepOrig.find(d => d.id === i.dataset.id); if (o) i.dataset.orig = o.wert; }
  } catch (e) { fehler(e); window.__ready = true; } finally { busy(false); }
}
$('#neu').onclick = neu;
$('#zurueck').onclick = () => rebuild({});

// ---------------------------------------------------------------- Export
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }
const stem = () => (state.file ? state.file.name.replace(/\.[^.]+$/, '') : 'modell');
$('#x-step').onclick = async () => {
  busy(true); try {
    const sch = $('#schema').value; const r = await call({ type: 'export', format: 'step', schema: sch });
    download(new Blob([r.text], { type: 'application/step' }), `${stem()}_${sch.replace(/IS|DIS/, '')}.step`); status(`STEP exportiert (Schema ${r.schema}).`);
  } catch (e) { fehler(e); } finally { busy(false); }
};
$('#x-stl').onclick = async () => { busy(true); try { const r = await call({ type: 'export', format: 'stl' }); download(r.blob, stem() + '.stl'); status('STL exportiert.'); } catch (e) { fehler(e); } finally { busy(false); } };
$('#x-pmi').onclick = () => {
  const r = state.result; const out = { quelle: stem(), einheit: 'mm', volumen_mm3: r.volumen_mm3, bbox_mm: r.bbox, flaechen: r.flaechen.map(({ p, tri, ...f }) => f), pmi: r.pmi };
  download(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }), stem() + '_pmi.json'); status('PMI als JSON exportiert.');
};

// ---------------------------------------------------------------- Eingaben
for (const s of ['#datei', '#kamera']) $(s).addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) { lastRaster = !/\.pdf$/i.test(f.name); ladeDatei(f); } });
function optgruppe(label, eintraege) {
  const g = document.createElement('optgroup');
  g.label = label;
  for (const [f, n] of eintraege) { const o = document.createElement('option'); o.value = f; o.textContent = n; g.appendChild(o); }
  $('#beispiel').appendChild(g);
}
optgruppe('Beispiele', BEISPIELE);
optgruppe('Trainingspaare', TRAINING);
$('#beispiel').onchange = e => { const f = e.target.value; if (f) ladeBeispiel(f); };
async function ladeBeispiel(f) {
  window.__ready = false; status('Lade Beispiel …');
  const r = await fetch(BASE + 'beispiele/' + f); if (!r.ok) { fehler(new Error('Beispiel nicht gefunden: ' + f)); return; }
  const file = new File([await r.blob()], f); lastRaster = /(?:^|\/)r\d/i.test(f) || !/\.pdf$/i.test(f);
  $('#beispiel').value = f;
  await ladeDatei(file);
  if (state.wartet) return;
  if (!state.ok) window.__ready = 'fehler';
}
// Test-Hooks
window.ladeBeispiel = ladeBeispiel;
window.__ansicht = d => viewer.flyTo(new (viewer.camera.position.constructor)(...d));
window.__aendere = edits => rebuild(edits);
window.__kamera = () => ({ pos: viewer.camera.position.toArray(), dir: viewer.viewDir().toArray(), target: viewer.controls.target.toArray() });
window.__viewer = viewer;
window.__cubePunkt = d => viewer.cubeScreen(d);

sectionUi = createSectionUI({ $, call, viewer, state, status, msg, tab, busy, esc, zeige, fehler });
function fillPruef(rows) {
  const tb = $('#pruef tbody'); if (!tb) return;
  tb.innerHTML = '';
  const hint = $('#pruef-hinweis');
  const list = rows || [];
  if (hint) { hint.hidden = list.length > 0; if (!list.length) hint.textContent = 'Keine Prüfmerkmale erkannt.'; }
  for (const r of list) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(r.nr)}</td><td>${esc(r.merkmal)}</td><td>${esc(fmt(r.nennmass, 3))}</td><td>${esc(r.toleranz || '–')}</td><td>${esc(r.klasse)}</td><td>${esc(r.art)}</td>`;
    tb.appendChild(tr);
  }
}
async function baueHinweis(h) {
  if (!state.vectorInp || state.busy) return;
  busy(true); window.__ready = false; $('#meldungen').innerHTML = '';
  const t0 = performance.now();
  try {
    const a = analyseBlatt(state.vectorInp.ex, state.vectorInp.tc, state.vectorInp.w, state.vectorInp.h, h);
    state.analyse = a;
    viewUi.show(a);
    await readyP;
    const r = await call({ type: 'vector', ...state.vectorInp, hinweis: h });
    zeige(r, state.file ? state.file.name : '', performance.now() - t0);
  } catch (e) { fehler(e); window.__ready = true; }
  finally { busy(false); }
}
let viewUi;
viewUi = createViewUI({ $, bauen: h => baueHinweis(h), erneut: h => {
  if (!state.vectorInp) return;
  const a = analyseBlatt(state.vectorInp.ex, state.vectorInp.tc, state.vectorInp.w, state.vectorInp.h, h);
  state.analyse = a;
  viewUi.show(a);
  fillPruef(pruefmerkmale([], a.dr && a.dr.phrases));
  status(a.grund);
} });
let stackUi;
function applyPmiFilter(k) {
  state.pmiFilter = k || 'alle';
  document.querySelectorAll('#pmi-filter button').forEach(b => b.classList.toggle('aktiv', b.dataset.filter === state.pmiFilter));
  let shown = 0, n = 0;
  document.querySelectorAll('#pmi li').forEach(li => {
    n++;
    const ok = state.pmiFilter === 'alle' || li.dataset.klasse === state.pmiFilter;
    li.hidden = !ok; if (ok) shown++;
  });
  const empty = $('#pmi-leer');
  if (empty) { empty.hidden = shown > 0 || !n; empty.textContent = n && !shown ? 'Keine Einträge in dieser Klasse.' : ''; }
  viewer.setPmiFilter(state.pmiFilter);
}
document.querySelectorAll('#pmi-filter button').forEach(b => { b.onclick = () => applyPmiFilter(b.dataset.filter); });
stackUi = createStackUI({ $, call, state, status, msg, tab, busy, esc, zeige, fehler, live: () => sectionUi.live(), restore: () => sectionUi.restore() });
window.__stackSchritte = () => stackUi.steps();
window.__schnittKandidaten = () => sectionUi.candidates();
window.__schnittWahl = id => sectionUi.selectId(id);
window.__schnittModell = id => sectionUi.build(id);

function neuesProjekt() {
  state.result = null; state.file = null; state.preview = null; state.edits = {}; state.auto = null; state.ok = false;
  state.analyse = null; state.vectorInp = null; window.__ready = false;
  viewer.clear(); viewer.onPick(null);
  $('#meldungen').innerHTML = '';
  $('#vorschau').innerHTML = '<p class="leer">Noch keine Zeichnung. PDF (Vektor oder Scan), PNG, JPG oder TIFF wählen – oder ein Beispiel.</p>';
  $('#masse tbody').innerHTML = '';
  $('#pmi').innerHTML = '';
  $('#info').innerHTML = '<p class="leer">–</p>';
  const aus = $('#auswahl'); if (aus) aus.hidden = true;
  $('#beispiel').value = '';
  $('#datei').value = '';
  $('#kamera').value = '';
  fillPruef([]);
  const hint = $('#pruef-hinweis'); if (hint) { hint.hidden = false; hint.textContent = 'Noch keine Merkmale. Nach dem Laden stehen hier Nennmaß, Toleranz, GD&T und Prüfmaß.'; }
  if (sectionUi && sectionUi.reset) sectionUi.reset();
  if (stackUi && stackUi.reset) stackUi.reset();
  if (viewUi) viewUi.reset();
  for (const s of ['#neu', '#x-step', '#x-stl', '#x-pmi', '#zurueck']) { const el = $(s); if (el) el.disabled = true; }
  status('Neues Projekt. Beispiel wählen oder eine Datei laden.');
  tab('zeichnung');
}
$('#btn-neues-projekt').onclick = neuesProjekt;

$('#app-version').textContent = BUILD.version;
$('#app-version').title = versionText();
$('#app-version-info').textContent = versionText();
for (const id of ['#btn-whatsnew', '#btn-whatsnew-info']) $(id).onclick = () => showWhatsNew();
setTimeout(() => maybeShowWhatsNew(), 1000);

readyP.then(() => { status('Bereit – Datei wählen oder Beispiel laden.'); bar(1); if (!state.file) ladeBeispiel('01_flansch.pdf'); }, e => status('CAD-Kern konnte nicht geladen werden: ' + e.message));
