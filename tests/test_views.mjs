// Linienstärke, Geometrie-Fit und Ansichtszerlegung der Trainingsblätter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prim } from '../app/core/geom.js';
import { lineWeightPlan, readPdfVector, extractDrawings, extractPhrases } from '../app/core/pdfin.js';
import { fitPrimitives } from '../app/core/fitgeom.js';
import { analyseBlatt } from '../app/core/recon.js';
import { pruefmerkmale } from '../app/core/dims.js';
import { parseLabels } from '../app/core/sections.js';

const pdfjs = await import(new URL('../vendor/pdf.min.mjs', import.meta.url).href);
pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

async function blatt(rel) {
  const buf = new Uint8Array(readFileSync(new URL(rel, import.meta.url)));
  const doc = await pdfjs.getDocument({ data: buf, isEvalSupported: false, verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  const ex = extractDrawings(await page.getOperatorList());
  const tc = extractPhrases(await page.getTextContent());
  const [x0, , x1, y1] = page.view;
  const a = analyseBlatt(ex, tc, x1 - x0, y1 - page.view[1]);
  await doc.destroy();
  return a;
}

test('einzelne dicke Striche verdecken die 0,35-mm-Kante nicht', () => {
  const widths = [...Array(120).fill(0.349), ...Array(170).fill(0.131), 0.998, 0.998];
  const plan = lineWeightPlan(widths);
  assert.ok(plan.isThick(0.349), 'Körperkante bleibt dick');
  assert.equal(plan.isThick(0.131), false);
  assert.ok(plan.thr < 0.5, 'Schwelle liegt zwischen den beiden häufigen Stärken');
  const klassisch = Math.max(0.55, 0.8 * 0.998);
  assert.ok(plan.thr < klassisch, 'Ausreißer 1 mm hebt die Schwelle nicht mehr über die Volllinie');
});

test('Beispiel-Flansch behält die breite Volllinie', () => {
  const plan = lineWeightPlan([...Array(32).fill(0.7), ...Array(28).fill(0.25), ...Array(2).fill(0.5)]);
  assert.ok(plan.isThick(0.7));
  assert.equal(plan.isThick(0.25), false);
  assert.equal(plan.isThick(0.5), false);
});

test('tessellierter Kreis wird ein Kreis', () => {
  const pts = [];
  for (let i = 0; i < 24; i++) {
    const a = i / 24 * Math.PI * 2;
    pts.push([15 * Math.cos(a), 15 * Math.sin(a)]);
  }
  const segs = pts.map((p, i) => prim('line', { pts: [p, pts[(i + 1) % pts.length]] }));
  const fit = fitPrimitives(segs, { join: 0.5 });
  assert.equal(fit.circles, 1);
  assert.equal(fit.prims.length, 1);
  assert.ok(Math.abs(fit.prims[0].r - 15) < 0.05);
});

test('SchnittansichtA-A wird als Schnitt gelesen', () => {
  const lab = parseLabels([{ text: 'SchnittansichtA-A', x: 1, y: 2 }]);
  assert.equal(lab.sec.length, 1);
  assert.equal(lab.sec[0].letter, 'A');
});

test('Verbindung hat Ansichten, nicht die leere Meldung', async () => {
  const a = await blatt('../beispiele/train/03_verbindung.pdf');
  assert.ok(a.alle.length >= 2, 'Bereiche auf dem Blatt');
  assert.ok(a.alle.some(v => v.rolle === 'haupt'), 'Hauptansicht');
  assert.ok(a.alle.some(v => v.rolle === 'isometrie'), 'Isometrie nur als Orientierung');
  assert.equal(a.alle.some(v => v.rolle === 'isometrie' && v.nutzen), false);
  assert.ok(a.dr.thick.length > 20, 'Körperkanten nach der neuen Schwelle');
});

test('Flansch bleibt automatisch', async () => {
  const a = await blatt('../beispiele/01_flansch.pdf');
  assert.equal(a.auto, true);
  assert.equal(a.stufe, 'hoch');
  assert.equal(a.layout.typ, 'dreh');
});

test('Prüfmerkmale aus Maß und GD&T', () => {
  const rows = pruefmerkmale([
    { id: 'M1', text: 'Ø32 H7', wert: 32, typ: 'durchmesser', passung: 'H7' },
    { id: 'M2', text: 'Prüfmaß 16±0,1', wert: 16, typ: 'laenge', tol_o: 0.1, tol_u: -0.1 },
  ], [{ text: '⌖ 0,05 A', x: 0, y: 0 }]);
  assert.ok(rows.some(r => r.klasse === 'Maß' && r.toleranz === 'H7'));
  assert.ok(rows.some(r => r.art === 'Prüfmaß'));
});
