// Feature-Stack und PMI-Layout ohne CAD-Kern.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeStack, appliesStep, waitingSteps, isMirrorPair } from '../app/core/stack.js';
import { dimKlasse, masslinieAbstand, hilfslinienAbstand } from '../app/core/dims.js';
import { formatPmi, staggerBoxes, pmiDetail } from '../app/core/pmilayout.js';

const axis = { p0: [0, 0], p1: [40, 0], quelle: 'mittellinie' };
const upper = { id: 'K1', vorschlag: true, schraffur: 12, flaeche: 100, buchstabe: 'A', achse: axis, items: [], poly: [[0, 10], [40, 10], [40, 20], [0, 20]] };
const lower = { id: 'K2', vorschlag: false, schraffur: 12, flaeche: 100, buchstabe: 'A', achse: axis, items: [], poly: [[0, -20], [40, -20], [40, -10], [0, -10]] };
const bore = { id: 'K3', vorschlag: false, schraffur: 0, flaeche: 40, buchstabe: 'A', achse: axis, items: [], poly: [[5, 1], [35, 1], [35, 8], [5, 8]] };

function baseRes(extra = {}) {
  return {
    teil_typ: 'dreh', massstab: 1, massstab_quelle: 'Schriftfeld 1:1',
    schnitt_konturen: [upper, lower, bore],
    schnitte: [{ buchstabe: 'A', verlauf: 'senkrecht', eltern: 'Stirnansicht' }],
    einzelheiten: [], ansichten: [{ art: 'schnitt' }, { art: 'ansicht' }],
    masse: [], meldungen: [], flaechen_statistik: { Zylinder: 2, Ebene: 2 }, schnitt_tiefe: null,
    ...extra,
  };
}

test('Spiegelhälfte und Bohrung', () => {
  assert.equal(isMirrorPair(upper, lower, axis), true);
  const stack = proposeStack(baseRes());
  assert.equal(stack.scope, 'rotation');
  assert.equal(stack.confidence, 'hoch');
  const live = stack.schritte.map(s => ({ ...s, status: 'vorschlag' }));
  assert.deepEqual(live.filter(appliesStep).map(s => s.id), ['BASIS']);
  assert.ok(live.some(s => s.rolle === 'hinweis' && /Gegenhälfte/.test(s.titel)));
  const b = live.find(s => s.contourId === 'K3');
  assert.equal(b.op, null);
  assert.equal(b.opWennBestaetigt, 'cut');
  assert.equal(b.confidence, 'niedrig');
  assert.ok(waitingSteps(live).some(s => s.contourId === 'K3'));
  b.status = 'bestaetigt'; b.op = b.opWennBestaetigt;
  assert.equal(appliesStep(b), true);
});

test('ohne Schnitt bleibt die Sicherheit niedrig', () => {
  const stack = proposeStack({ teil_typ: 'dreh', massstab: 1, massstab_quelle: 'Schriftfeld', schnitt_konturen: [], schnitte: [], ansichten: [{ art: 'ansicht' }], masse: [], meldungen: [], flaechen_statistik: {} });
  assert.equal(stack.confidence, 'niedrig');
  assert.match(stack.grund, /Automatik/);
  assert.equal(stack.schritte.find(s => s.rolle === 'basis'), undefined);
});

test('Freiform ist nicht unterstützt', () => {
  const stack = proposeStack({ teil_typ: 'frei', massstab: 1, massstab_quelle: 'Schriftfeld', schnitt_konturen: [], schnitte: [], ansichten: [], masse: [], meldungen: [], flaechen_statistik: { 'B-Spline-Fläche': 8, Ebene: 1 } });
  assert.equal(stack.scope, 'nicht_unterstuetzt');
  assert.equal(stack.confidence, 'niedrig');
  assert.match(stack.grund, /Freiform/);
  assert.ok(stack.schritte.some(s => /Freiform/.test(s.titel)));
});

test('Maßklasse und Maßlinie', () => {
  assert.equal(dimKlasse({ typ: 'laenge', text: '60' }), 'abstand');
  assert.equal(dimKlasse({ typ: 'durchmesser', text: 'Ø24 H7' }), 'mass');
  assert.equal(dimKlasse({ typ: 'durchmesser', text: 'Ø12 Prüfmaß' }), 'pruef');
  assert.equal(dimKlasse({ typ: 'winkel', text: 'Rechtwinkligkeit 0,05' }), 'gdt');
  const line = masslinieAbstand('X', 0, 60, [0, -25, -25], [60, 25, 25]);
  assert.equal(line[0][0], 0);
  assert.equal(line[1][0], 60);
  assert.ok(line[0][2] > 25 && line[1][2] > 25);
  assert.equal(line[0][1], line[1][1]);
  const hilfe = hilfslinienAbstand('X', 0, 60, [0, -25, -25], [60, 25, 25], line);
  assert.equal(hilfe[0][0][0], 0);
  assert.ok(hilfe[0][1][2] > hilfe[0][0][2]);
});

test('PMI-Text und Staffelung', () => {
  const it = { typ: 'Durchmesser', nennmass: 24, einheit: 'mm', tol_oben: 0.02, tol_unten: -0.02 };
  assert.equal(formatPmi(it, false), 'Ø24');
  assert.match(formatPmi(it, true), /Ø24 ±0,02 mm/);
  assert.equal(pmiDetail(100, 200), true);
  assert.equal(pmiDetail(180, 200), false);
  const placed = staggerBoxes([
    { id: 'a', x: 10, y: 10, w: 40, h: 16 },
    { id: 'b', x: 12, y: 12, w: 40, h: 16 },
  ]);
  const b = placed.find(p => p.id === 'b');
  assert.equal(b.shifted, true);
  assert.ok(b.y > 12);
  assert.equal(b.ax, 12);
});
