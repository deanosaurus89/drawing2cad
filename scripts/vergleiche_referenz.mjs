// Volumen und Hüllkasten der Trainings-STEP gegen eine Rekonstruktion.
// Läuft lokal mit dem schon vorhandenen OpenCascade (vendor/). GitHub Pages braucht das nicht.
//
//   node scripts/vergleiche_referenz.mjs
//       schreibt beispiele/train/cad/referenz.json und druckt die Tabelle
//   node scripts/vergleiche_referenz.mjs --ist datei.json
//       datei.json: PMI-Export aus der App oder { "01_welle": { "volumen_mm3": 1, "bbox_mm": [l,b,h] } }
//
// bbox_mm sind die Kantenlängen X, Y, Z in mm, wie unter Info „Abmessungen“.
// Achsen der STEP-Datei und der Rekonstruktion müssen nicht übereinstimmen:
// verglichen wird das sortierte Tripel, zusätzlich die unsortierte Abweichung.
// IGES (Lochverbund, PolyWorks) hat in diesem WASM keinen Leser. Freiform bleibt außen vor.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cadDir = join(root, 'beispiele', 'train', 'cad');
const r3 = v => v.map(x => Math.round(x * 10) / 10);

function sorted(b) { return b.slice().sort((a, c) => a - c); }
function dev(ist, soll) {
  if (!(soll > 0) || ist == null) return null;
  return (ist - soll) / soll * 100;
}

let ocReady;
async function kern() {
  if (ocReady) return ocReady;
  ocReady = (async () => {
    const ocMod = await import(pathToFileURL(join(root, 'vendor', 'replicad_single.js')).href);
    const replicad = await import(pathToFileURL(join(root, 'vendor', 'replicad.js')).href);
    const oc = await ocMod.default({});
    replicad.setOC(oc);
    return replicad;
  })();
  return ocReady;
}

async function stepMass(name, bytes) {
  const replicad = await kern();
  const blob = new Blob([bytes]);
  const shape = await replicad.importSTEP(blob);
  const solids = shape.solids && shape.solids.length ? shape.solids : [shape];
  let volumen = 0;
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const s of solids) {
    try { volumen += replicad.measureVolume(s); } catch { /* Fläche ohne Volumen */ }
    const bb = s.boundingBox.bounds;
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], bb[0][k]); hi[k] = Math.max(hi[k], bb[1][k]); }
  }
  const bbox = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  return {
    datei: name, einheit: 'mm', volumen_mm3: Math.round(volumen * 10) / 10,
    bbox_mm: r3(bbox), bbox_sortiert_mm: r3(sorted(bbox)),
    art: volumen > 1 ? 'volumen' : 'ohne Volumen (Fläche oder Lesefehler)',
  };
}

function zeile(ref, ist) {
  if (!ist) return `${ref.datei}: V=${ref.volumen_mm3} mm³  Kasten ${ref.bbox_mm.join(' × ')} mm`;
  const dv = dev(ist.volumen_mm3, ref.volumen_mm3);
  const a = sorted(ist.bbox_mm || []), b = ref.bbox_sortiert_mm;
  const bd = a.length === 3 && b ? a.map((x, i) => dev(x, b[i])) : [];
  const btxt = bd.length ? bd.map(x => (x == null ? '–' : x.toFixed(1) + '%')).join(', ') : '–';
  return `${ref.datei}: Volumen ${(dv == null ? '–' : dv.toFixed(1) + '%')} (Ist ${ist.volumen_mm3}, Soll ${ref.volumen_mm3})  Kasten sortiert ${btxt}`;
}

const args = process.argv.slice(2);
let istPfad = null;
for (let i = 0; i < args.length; i++) if (args[i] === '--ist') istPfad = args[++i];
const istDatei = istPfad ? JSON.parse(await readFile(istPfad, 'utf8')) : null;
function istVon(stem) {
  if (!istDatei) return null;
  if (istDatei[stem]) return istDatei[stem];
  if (istDatei.quelle && String(istDatei.quelle).includes(stem)) return istDatei;
  return null;
}

const namen = (await readdir(cadDir)).filter(n => /\.(stp|step)$/i.test(n)).sort();
const teile = [];
for (const name of namen) {
  const bytes = await readFile(join(cadDir, name));
  process.stderr.write(name + ' … ');
  const ref = await stepMass(name, bytes);
  teile.push(ref);
  const stem = basename(name).replace(/\.(stp|step)$/i, '');
  console.log(zeile(ref, istVon(stem)));
}
const iges = (await readdir(cadDir)).filter(n => /\.(igs|iges)$/i.test(n));
const hinweis = iges.length
  ? iges.map(n => n + ': IGES von PolyWorks, in diesem Browser-Kern nicht lesbar. Freiform, nicht als Volumen-Soll verwenden.').join(' ')
  : '';
if (hinweis) console.log(hinweis);
const out = {
  einheit: 'mm',
  hinweis: 'Soll aus STEP (OpenCascade, vendor/). Achslage kann von der Rekonstruktion abweichen, deshalb bbox_sortiert_mm. ' + hinweis,
  teile,
};
await writeFile(join(cadDir, 'referenz.json'), JSON.stringify(out, null, 2));
console.log('geschrieben: beispiele/train/cad/referenz.json');
