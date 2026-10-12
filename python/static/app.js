import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

const FARBEN = { plane: 0xb8c4d2, cylinder: 0x5b9bd5, cone: 0xf0a030, torus: 0x70c070, bspline: 0xc060c0, extrusion: 0xc060c0, sphere: 0xe06060, revolution: 0x60c0c0, other: 0xaaaaaa };
const NAMEN = { plane: 'Ebene', cylinder: 'Zylinder', cone: 'Kegel', torus: 'Torus', extrusion: 'Spline-Extrusionsfläche', bspline: 'B-Spline-Fläche', sphere: 'Kugel', revolution: 'Rotationsfläche' };
const TYPEN = { laenge: 'Länge', durchmesser: 'Durchmesser', radius: 'Radius', fase: 'Fase', winkel: 'Winkel', tiefe: 'Tiefe', teilkreis: 'Teilkreis', tasche: 'Tasche/Langloch' };
const $ = id => document.getElementById(id);
const hex = c => '#' + c.toString(16).padStart(6, '0');

// ------------------------------------------------------------------ Hauptansicht
const el = $('viewer');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio);
el.prepend(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0xe4e9f0);
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x8090a0, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.5); camera.add(sun); sun.position.set(1, 2, 3); scene.add(camera);
let modell = null, faceMeshes = [], edgeLines = [], pmiGroup = null, daten = null, groesse = 100, anim = null;
const bySid = {};

function resize() { const r = el.getBoundingClientRect(); renderer.setSize(r.width, r.height); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); }
new ResizeObserver(resize).observe(el); resize();

// ------------------------------------------------------------------ ViewCube
const cubeCanvas = $('cube');
const cubeR = new THREE.WebGLRenderer({ canvas: cubeCanvas, antialias: true, alpha: true });
cubeR.setPixelRatio(window.devicePixelRatio); cubeR.setSize(120, 120, false);
const cubeScene = new THREE.Scene();
const cubeCam = new THREE.OrthographicCamera(-0.9, 0.9, 0.9, -0.9, 0.1, 10);
function faceTex(t) {
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  g.fillStyle = '#dfe7f2'; g.fillRect(0, 0, 128, 128); g.strokeStyle = '#1f3a5f'; g.lineWidth = 6; g.strokeRect(3, 3, 122, 122);
  g.fillStyle = '#1f3a5f'; g.font = 'bold 26px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t, 64, 64);
  const tx = new THREE.CanvasTexture(c); tx.colorSpace = THREE.SRGBColorSpace; return tx;
}
// Reihenfolge BoxGeometry: +x, -x, +y, -y, +z, -z  (three: Y oben, +Z = vorne)
const cubeMats = ['Rechts', 'Links', 'Oben', 'Unten', 'Vorne', 'Hinten'].map(t => new THREE.MeshBasicMaterial({ map: faceTex(t) }));
const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), cubeMats); cubeScene.add(cube);
cubeScene.add(new THREE.LineSegments(new THREE.EdgesGeometry(cube.geometry), new THREE.LineBasicMaterial({ color: 0x1f3a5f })));
const hoverMark = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 12), new THREE.MeshBasicMaterial({ color: 0xff8800 })); hoverMark.visible = false; cubeScene.add(hoverMark);
const cubeRay = new THREE.Raycaster();
function cubeDir(ev) {
  const r = cubeCanvas.getBoundingClientRect();
  cubeRay.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), cubeCam);
  const h = cubeRay.intersectObject(cube)[0]; if (!h) return null;
  const p = h.point; const s = v => Math.abs(v) > 0.3 ? Math.sign(v) : 0;
  return new THREE.Vector3(s(p.x), s(p.y), s(p.z));
}
cubeCanvas.addEventListener('mousemove', ev => { const d = cubeDir(ev); hoverMark.visible = !!d; if (d) hoverMark.position.copy(d.clone().multiplyScalar(0.5)); });
cubeCanvas.addEventListener('mouseleave', () => hoverMark.visible = false);
cubeCanvas.addEventListener('click', ev => { const d = cubeDir(ev); if (d) blickRichtung(d); });
function blickRichtung(d) {
  const dist = camera.position.distanceTo(controls.target);
  const dir = d.clone().normalize();
  if (Math.abs(dir.y) > 0.999) dir.z += 0.001; // Pol vermeiden
  fliegeZu(controls.target.clone(), controls.target.clone().add(dir.normalize().multiplyScalar(dist)));
}
function fliegeZu(target, pos) {
  anim = { t0: performance.now(), p0: camera.position.clone(), p1: pos, q0: controls.target.clone(), q1: target };
}
window.__ansicht = (x, y, z) => { blickRichtung(new THREE.Vector3(x, y, z)); };

// ------------------------------------------------------------------ Render-Schleife
(function loop() {
  requestAnimationFrame(loop);
  if (anim) {
    let t = Math.min(1, (performance.now() - anim.t0) / 450); t = t * t * (3 - 2 * t);
    camera.position.lerpVectors(anim.p0, anim.p1, t); controls.target.lerpVectors(anim.q0, anim.q1, t);
    if (t >= 1) anim = null;
  }
  controls.update();
  renderer.render(scene, camera);
  cubeCam.position.copy(camera.position).sub(controls.target).normalize().multiplyScalar(3);
  cubeCam.up.copy(camera.up); cubeCam.lookAt(0, 0, 0);
  cubeR.render(cubeScene, cubeCam);
  platziereLabels();
})();

function farbe(f) { return $('farbeTyp').checked ? (FARBEN[f.typ_en] ?? 0xaaaaaa) : 0xb8c4d2; }

function einpassen(sofort) {
  if (!modell) return;
  const box = new THREE.Box3(); faceMeshes.forEach(m => box.expandByObject(m));
  const s = box.getSize(new THREE.Vector3()).length(), c = box.getCenter(new THREE.Vector3());
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (sofort || dir.lengthSq() < 0.5) dir.set(0.55, 0.45, 0.7).normalize();
  const dist = s * 1.9 / Math.min(1, camera.aspect);
  camera.near = s / 100; camera.far = s * 30; camera.updateProjectionMatrix();
  if (sofort) { camera.position.copy(c.clone().add(dir.multiplyScalar(dist))); controls.target.copy(c); }
  else fliegeZu(c, c.clone().add(dir.multiplyScalar(dist)));
}
$('fit').onclick = () => einpassen(false);

function zeigeModell(d, neueAnsicht) {
  if (modell) scene.remove(modell);
  modell = new THREE.Group(); faceMeshes = []; edgeLines = [];
  for (const k in bySid) delete bySid[k];
  for (const f of d.flaechen) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(f.v, 3)); g.setIndex(f.t); g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: farbe(f), metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
    m.userData = f; modell.add(m); faceMeshes.push(m); bySid[f.sid] = m;
  }
  for (const e of d.kanten) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(e.p, 3));
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x1a1f2b })); l.userData = e; modell.add(l); edgeLines.push(l);
  }
  // PMI-Hinweislinien
  pmiGroup = new THREE.Group(); modell.add(pmiGroup);
  for (const p of d.pmi) {
    for (const b of p.bezuege) for (const sid of b.flaechen) {
      const f = bySid[sid]?.userData; if (!f) continue;
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...p.label_3d), new THREE.Vector3(...f.zentrum_flaeche)]);
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xb08a00, depthTest: false, transparent: true, opacity: 0.85 }));
      l.renderOrder = 5; l.userData = { pmi: p.id }; pmiGroup.add(l);
    }
  }
  modell.rotation.x = -Math.PI / 2; // CAD Z-oben -> three.js Y-oben
  scene.add(modell); modell.updateMatrixWorld(true);
  const box = new THREE.Box3(); faceMeshes.forEach(m => box.expandByObject(m)); groesse = box.getSize(new THREE.Vector3()).length();
  baueLabels(d);
  if (neueAnsicht) einpassen(true);
  sichtbarkeit();
}
function sichtbarkeit() {
  edgeLines.forEach(l => l.visible = $('kantenAn').checked);
  if (pmiGroup) pmiGroup.visible = $('pmiAn').checked;
  $('labels').style.display = $('pmiAn').checked ? '' : 'none';
}
$('kantenAn').onchange = sichtbarkeit; $('pmiAn').onchange = sichtbarkeit;
$('farbeTyp').onchange = () => faceMeshes.forEach(m => m.material.color.setHex(farbe(m.userData)));

// ------------------------------------------------------------------ PMI-Beschriftungen
let labelEls = [];
function pmiText(p) {
  const pre = { Durchmesser: 'Ø', Radius: 'R', 'Teilkreis (Lagemaß)': 'TK Ø', Fase: '⦣ ' }[p.typ] ?? '';
  let t = pre + fmt(p.nennmass) + (p.einheit === '°' ? '°' : '');
  if (p.passung) t += ' ' + p.passung;
  if (p.tol_oben != null && p.tol_unten != null) t += (Math.abs(p.tol_oben + p.tol_unten) < 1e-9 ? ` ±${fmt(p.tol_oben)}` : ` (+${fmt(p.tol_oben)}/${fmt(p.tol_unten)})`);
  if (p.typ === 'Tiefe') t = '↧ ' + t;
  return t;
}
const fmt = v => (Math.round(v * 1000) / 1000).toString().replace('.', ',');
function baueLabels(d) {
  $('labels').innerHTML = ''; labelEls = [];
  for (const p of d.pmi) {
    const div = document.createElement('div'); div.className = 'pmilabel'; div.textContent = pmiText(p); div.title = `${p.id} · ${p.typ} · ${p.text}`;
    div.onclick = () => waehlePmi(p.id);
    $('labels').appendChild(div); labelEls.push({ div, pos: new THREE.Vector3(...p.label_3d), id: p.id });
  }
}
const _v = new THREE.Vector3();
function platziereLabels() {
  if (!modell || !$('pmiAn').checked) return;
  const r = el.getBoundingClientRect();
  for (const L of labelEls) {
    _v.copy(L.pos).applyMatrix4(modell.matrixWorld).project(camera);
    const vis = _v.z < 1 && Math.abs(_v.x) < 1.1 && Math.abs(_v.y) < 1.1;
    L.div.style.display = vis ? '' : 'none';
    L.div.style.left = ((_v.x + 1) / 2 * r.width) + 'px'; L.div.style.top = ((1 - _v.y) / 2 * r.height) + 'px';
  }
}

// ------------------------------------------------------------------ Auswahl
function reset() {
  document.querySelectorAll('.zeile.sel, tr.sel, .pmilabel.sel').forEach(z => z.classList.remove('sel'));
  faceMeshes.forEach(m => m.material.emissive.setHex(0));
  edgeLines.forEach(l => l.material.color.setHex(0x1a1f2b));
}
function info(html) { const i = $('info'); i.innerHTML = html; i.classList.toggle('versteckt', !html); }
function param(o) {
  const skip = new Set(['id', 'v', 't', 'p', 'typ', 'typ_en', 'sid', 'mitte']);
  return Object.entries(o).filter(([k]) => !skip.has(k)).map(([k, v]) => `${k}=${Array.isArray(v) ? '(' + v.join(', ') + ')' : v}`).join('  ');
}
function pmiFuer(sid) { return (daten?.pmi || []).filter(p => p.bezuege.some(b => b.flaechen.includes(sid))); }
function waehleFlaeche(id) {
  reset(); const m = faceMeshes[id]; m.material.emissive.setHex(0x886600);
  const z = $('f' + id); if (z) { z.classList.add('sel'); z.scrollIntoView({ block: 'nearest' }); }
  const f = m.userData, pm = pmiFuer(f.sid);
  info(`<b>Fläche F${f.id}</b> · ${f.typ}<br><span class="param">ID ${f.sid}<br>${param(f)}</span>` + (pm.length ? `<br>PMI: ${pm.map(p => p.id + ' (' + pmiText(p) + ')').join(', ')}` : ''));
}
function waehleKante(id) {
  reset(); edgeLines[id].material.color.setHex(0xff2200);
  const z = $('k' + id); if (z) { z.classList.add('sel'); z.scrollIntoView({ block: 'nearest' }); }
  const e = edgeLines[id].userData;
  info(`<b>Kante K${e.id}</b> · ${e.typ}<br><span class="param">ID ${e.sid}<br>${param(e)}</span>`);
}
function waehlePmi(pid) {
  reset(); const p = daten.pmi.find(x => x.id === pid); if (!p) return;
  for (const b of p.bezuege) for (const sid of b.flaechen) bySid[sid]?.material.emissive.setHex(0xaa3300);
  labelEls.find(l => l.id === pid)?.div.classList.add('sel');
  const z = $('p-' + pid); if (z) { z.classList.add('sel'); z.scrollIntoView({ block: 'nearest' }); }
  const tr = $('tr-' + p.masz); if (tr) tr.classList.add('sel');
  info(`<b>${p.id}</b> · ${p.typ}: ${pmiText(p)}<br><span class="param">Zeichnungstext „${p.text}“<br>` +
    p.bezuege.map(b => `${b.rolle}: ${b.flaechen.map(s => s + ' (' + (bySid[s]?.userData.typ ?? '?') + ')').join(', ')}`).join('<br>') + (p.hinweis ? '<br>' + p.hinweis : '') + '</span>');
}
const ray = new THREE.Raycaster(); let down = null;
renderer.domElement.addEventListener('pointerdown', ev => down = [ev.clientX, ev.clientY]);
renderer.domElement.addEventListener('pointerup', ev => {
  if (!down || Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) > 4 || !modell) return;
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera);
  ray.params.Line.threshold = groesse / 300;
  const hf = ray.intersectObjects(faceMeshes)[0];
  const he = $('kantenAn').checked ? ray.intersectObjects(edgeLines)[0] : null;
  if (he && (!hf || he.distance < hf.distance + groesse / 200)) waehleKante(he.object.userData.id);
  else if (hf) waehleFlaeche(hf.object.userData.id);
  else { reset(); info(''); }
});

// ------------------------------------------------------------------ Tabellen
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button, .tab').forEach(x => x.classList.remove('aktiv'));
  b.classList.add('aktiv'); $('tab-' + b.dataset.tab).classList.add('aktiv');
});
function tolText(d) {
  if (d.passung && d.tol_o != null) return `${d.passung} (+${fmt(d.tol_o)}/${fmt(d.tol_u)})`;
  if (d.passung) return d.passung;
  if (d.tol_o != null) return Math.abs(d.tol_o + d.tol_u) < 1e-9 ? `±${fmt(d.tol_o)}` : `+${fmt(d.tol_o)}/${fmt(d.tol_u)}`;
  return '';
}
function zeigeListen(d) {
  const tb = document.querySelector('#masse tbody');
  tb.innerHTML = d.masse.map(m => {
    const cls = m.status === 'geprüft' || m.status === 'geändert' ? 'st-ok' : m.status.startsWith('Abw') || m.status === 'nicht zugeordnet' ? 'st-warn' : 'st-grau';
    const pre = { durchmesser: 'Ø', radius: 'R', teilkreis: 'TK Ø' }[m.typ] ?? '';
    return `<tr id="tr-${m.id}" title="Zeichnungstext: ${m.text} · Quelle: ${m.quelle}${m.hinweis ? ' · ' + m.hinweis : ''}"><td>${m.id}</td><td>${TYPEN[m.typ] ?? m.typ}</td>` +
      `<td>${pre}<input data-id="${m.id}" data-orig="${m.wert_alt ?? m.wert}" value="${m.wert}" ${m.editierbar ? '' : 'disabled'}></td><td>${tolText(m)}</td><td class="${cls}">${m.status}</td></tr>`;
  }).join('');
  tb.querySelectorAll('tr').forEach(tr => tr.onclick = ev => { if (ev.target.tagName === 'INPUT') return; const p = d.pmi.find(x => x.masz === tr.id.slice(3)); if (p) waehlePmi(p.id); });
  tb.querySelectorAll('input').forEach(i => i.oninput = () => { i.classList.toggle('geaendert', parseFloat(i.value.replace(',', '.')) !== parseFloat(i.dataset.orig)); pruefeKnopf(); });
  tb.querySelectorAll('input').forEach(i => i.classList.toggle('geaendert', parseFloat(i.value) !== parseFloat(i.dataset.orig)));
  $('aenderungen').innerHTML = (d.aenderungen || []).map(a => '✔ ' + a).join('<br>');
  $('pmi').innerHTML = d.pmi.map(p => `<div class="zeile" id="p-${p.id}"><b>${p.id}</b> ${p.typ}: <b>${pmiText(p)}</b><br><span class="param">${p.bezuege.map(b => b.rolle + ' → ' + b.flaechen.map(s => s + ' ' + (bySid[s]?.userData.typ ?? '')).join(', ')).join(' | ')}</span></div>`).join('') || '<div class="zeile">Keine PMI-Elemente.</div>';
  d.pmi.forEach(p => $('p-' + p.id).onclick = () => waehlePmi(p.id));
  $('flaechen').innerHTML = d.flaechen.map(f => `<div class="zeile" id="f${f.id}"><b>F${f.id}</b> <i style="color:${hex(FARBEN[f.typ_en] ?? 0xaaaaaa)}">■</i> ${f.typ}<br><span class="param">${f.sid} · ${param(f)}</span></div>`).join('');
  $('kanten').innerHTML = d.kanten.map(e => `<div class="zeile" id="k${e.id}"><b>K${e.id}</b> ${e.typ}<br><span class="param">${e.sid} · ${param(e)}</span></div>`).join('');
  d.flaechen.forEach(f => $('f' + f.id).onclick = () => waehleFlaeche(f.id));
  d.kanten.forEach(e => $('k' + e.id).onclick = () => waehleKante(e.id));
  $('merkmale').innerHTML = d.merkmale.map(m => `<li><b>${m.typ}:</b> ${m.text}</li>`).join('') +
    `<li>Volumen ${(d.volumen_mm3 / 1000).toFixed(2)} cm³, Hüllquader ${d.bbox.join(' × ')} mm, B-Rep ${d.gueltig ? 'gültig' : '<b>ungültig</b>'}</li>` +
    `<li>STEP-Schema: ${d.step_schema}</li>` + (d.ap242 ? `<li>AP242-PMI: ${d.ap242.pmi_anzahl} Maße (${d.ap242.schema.split(' ')[0]})</li>` : '');
  const st = d.flaechen_statistik, ks = d.kanten_statistik;
  $('legende').innerHTML = Object.entries(FARBEN).filter(([k]) => d.flaechen.some(f => f.typ_en === k)).map(([k, c]) => `<span><i style="background:${hex(c)}"></i>${NAMEN[k] ?? k}</span>`).join('')
    + `<br>Flächen: ${Object.entries(st).map(([k, v]) => v + '× ' + k).join(', ')} · Kanten: ${Object.entries(ks).map(([k, v]) => v + '× ' + k).join(', ')}`;
  const nm = { step: 'STEP AP214', stl: 'STL', glb: 'GLB', pmi: 'PMI (JSON)', ap242: 'STEP AP242 + PMI' };
  const base = (d.name || 'modell').replace(/\.[a-z]+$/i, '').replace(/[^\w-]+/g, '_');
  $('downloads').innerHTML = Object.entries(d.downloads).map(([k, u]) => `<a href="${u}" download="${base}${k === 'ap242' ? '_ap242' : ''}.${k === 'pmi' ? 'pmi.json' : k === 'ap242' ? 'step' : k}">${nm[k] ?? k}</a>`).join('');
  pruefeKnopf();
}
function aenderungen() {
  const e = {};
  document.querySelectorAll('#masse input:not(:disabled)').forEach(i => {
    const v = parseFloat(i.value.replace(',', '.'));
    if (!isNaN(v) && Math.abs(v - parseFloat(i.dataset.orig)) > 1e-9) e[i.dataset.id] = v;
  });
  return e;
}
function pruefeKnopf() {
  const e = aenderungen(), alt = daten?.aenderungs_eingabe || {};
  $('neuBerechnen').disabled = !daten?.ok || JSON.stringify(e) === JSON.stringify(alt);
}
$('neuBerechnen').onclick = () => verarbeite(fetch(`/api/jobs/${daten.job}/neu`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(aenderungen()) }), daten.name, false);
$('zuruecksetzen').onclick = () => { if (daten?.job) verarbeite(fetch(`/api/jobs/${daten.job}/neu`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), daten.name, false); };
window.__aendere = (werte) => { for (const [k, v] of Object.entries(werte)) { const i = document.querySelector(`#masse input[data-id="${k}"]`); if (i) { i.value = v; i.oninput(); } } $('neuBerechnen').click(); };

// ------------------------------------------------------------------ Laden
function status(t, k = '') { const s = $('status'); s.textContent = t; s.className = 'status ' + k; }
async function verarbeite(prom, name, neueAnsicht = true) {
  status(`Verarbeite „${name}“ …`); window.__ready = false; $('busy').classList.remove('versteckt');
  try {
    const d = await (await prom).json();
    if (d.vorschau) { $('vorschau').src = d.vorschau; $('vorschauLink').href = d.original || d.vorschau; }
    if (!d.ok) { status('Fehler: ' + d.fehler, 'fehler'); $('meldungen').innerHTML = ''; window.__ready = 'fehler'; return; }
    daten = d;
    status(`Fertig: ${d.strategie} – ${d.flaechen.length} Flächen, ${d.masse.length} Maße, ${d.pmi.length} PMI.` + (d.quelle === 'raster' ? ' (Rasterbild)' : ''), 'ok');
    $('meldungen').innerHTML = d.meldungen.map(m => `<div>• ${m}</div>`).join('');
    zeigeModell(d, neueAnsicht); zeigeListen(d); info(''); window.__ready = true;
  } catch (e) { status('Serverfehler: ' + e, 'fehler'); window.__ready = 'fehler'; }
  finally { $('busy').classList.add('versteckt'); }
}
const bsp = await (await fetch('/api/beispiele')).json();
const og1 = `<optgroup label="Vektor-Zeichnungen">${bsp.filter(b => !b.id.startsWith('r')).map(b => `<option value="${b.id}">${b.titel}</option>`).join('')}</optgroup>`;
const og2 = `<optgroup label="Gescannte Zeichnungen (Raster + OCR)">${bsp.filter(b => b.id.startsWith('r')).map(b => `<option value="${b.id}">${b.titel} · ${b.art}</option>`).join('')}</optgroup>`;
$('beispiel').insertAdjacentHTML('beforeend', og1 + og2);
window.ladeBeispiel = id => { $('beispiel').value = id; const b = bsp.find(x => x.id === id); verarbeite(fetch('/api/beispiele/' + id, { method: 'POST' }), b.titel); };
$('beispiel').onchange = () => { if ($('beispiel').value) window.ladeBeispiel($('beispiel').value); };
$('datei').onchange = ev => {
  const f = ev.target.files[0]; if (!f) return; const fd = new FormData(); fd.append('datei', f);
  $('beispiel').value = '';
  verarbeite(fetch('/api/upload', { method: 'POST', body: fd }), f.name);
};
const q = new URLSearchParams(location.search).get('beispiel');
window.ladeBeispiel(q || bsp[0].id);
