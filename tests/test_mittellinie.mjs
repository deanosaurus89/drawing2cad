// Mittellinie: Strichlinie, explodierte Kurz-lang-Folge, Klick, zwei Kanten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prim } from '../app/core/geom.js';
import { axisBetween, axisFromPrim, erkenneMittellinie, eineSeite, symmetrieren } from '../app/core/mittellinie.js';
import { proposeAxis } from '../app/core/sections.js';
import { extractDrawings, extractPhrases, readPdfVector } from '../app/core/pdfin.js';

const pdfjs = await import(new URL('../vendor/pdf.min.mjs', import.meta.url).href);
pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

test('zwei parallele Kanten ergeben die Mittelachse', () => {
  const a = prim('line', { pts: [[0, 0], [40, 0]] });
  const b = prim('line', { pts: [[0, 10], [40, 10]] });
  const ax = axisBetween(a, b);
  assert.equal(ax.quelle, 'abgeleitet');
  assert.ok(Math.abs((ax.p0[1] + ax.p1[1]) / 2 - 5) < 0.05);
  assert.ok(Math.abs(ax.p0[1] - ax.p1[1]) < 0.05);
  assert.equal(axisBetween(a, prim('line', { pts: [[0, 0], [0, 40]] })), null);
});

test('angeklickte Linie wird die Mittellinie', () => {
  const ax = axisFromPrim(prim('line', { pts: [[2, 3], [20, 3]] }));
  assert.equal(ax.quelle, 'markiert');
  assert.deepEqual(ax.p0, [2, 3]);
  assert.deepEqual(ax.p1, [20, 3]);
});

test('Kurz-lang-Stücke ohne Strichmuster werden zur Mittellinie', () => {
  const thin = [];
  for (let i = 0; i < 8; i++) {
    const x = i * 8;
    const len = i % 2 === 0 ? 5 : 1.2;
    thin.push(prim('line', { pts: [[x, 30], [x + len, 30]] }));
  }
  const view = { lo: [0, 10], hi: [70, 50], size: [70, 40] };
  const ax = erkenneMittellinie(view, { thin });
  assert.ok(ax, 'Mittellinie erkannt');
  assert.equal(ax.quelle, 'mittellinie');
  assert.ok(Math.abs(ax.p0[1] - 30) < 0.2 && Math.abs(ax.p1[1] - 30) < 0.2);
});

test('Halbkontur wird an der Mittellinie ergänzt, volle Kontur nicht', () => {
  const axis = { p0: [0, 0], p1: [20, 0], quelle: 'markiert' };
  const halb = [{ k: 'line', pts: [[0, 0], [20, 0]] }, { k: 'line', pts: [[20, 0], [20, 8]] }, { k: 'line', pts: [[20, 8], [0, 8]] }, { k: 'line', pts: [[0, 8], [0, 0]] }];
  assert.equal(eineSeite(halb.flatMap(it => it.pts), axis), true);
  const full = symmetrieren(halb, axis);
  assert.ok(full && full.length >= 6);
  const beide = [{ k: 'line', pts: [[0, -4], [10, -4]] }, { k: 'line', pts: [[10, 4], [0, 4]] }];
  assert.equal(eineSeite(beide.flatMap(it => it.pts), axis), false);
});

test('Buchse: gezeichnete Mittellinie im Schnitt', async () => {
  const buf = new Uint8Array(readFileSync(new URL('../beispiele/06_buchse.pdf', import.meta.url)));
  const doc = await pdfjs.getDocument({ data: buf, isEvalSupported: false, verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  const ex = extractDrawings(await page.getOperatorList());
  const tc = extractPhrases(await page.getTextContent());
  const dr = readPdfVector(ex, tc, page.view[2] - page.view[0], page.view[3] - page.view[1]);
  await doc.destroy();
  const view = { lo: [50, 140], hi: [130, 220], size: [80, 80] };
  const ax = proposeAxis(view, dr.center, { typ: 'dreh', achse_y: 180 }, dr);
  assert.equal(ax.quelle, 'mittellinie');
  assert.ok(Math.abs(ax.p0[1] - ax.p1[1]) < 0.6, 'Achse ist waagerecht');
});
