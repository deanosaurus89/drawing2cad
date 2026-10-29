// Schnittkontur: falsche geschlossene Bahn (Bohrung) vs. bestätigte Schraffurfläche.
// Aufruf: node --test tests/test_section_confirm.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { prim } from '../app/core/geom.js';
import * as Sx from '../app/core/sections.js';
import * as RC from '../app/core/recon.js';
import { proposeStack, appliesStep } from '../app/core/stack.js';

const pdfjs = await import(new URL('../vendor/pdf.min.mjs', import.meta.url).href);
pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
const Pdf = await import('../app/core/pdfin.js');

function polyPrims(poly) {
  return poly.map((a, i) => prim('line', { pts: [a.slice(), poly[(i + 1) % poly.length].slice()] }));
}
const WALL = [[0, 13], [0, 24], [1, 25], [40, 25], [40, 20], [59, 20], [60, 19], [60, 12], [32.5, 12], [32.5, 13.5], [30, 13.5], [30, 12], [1, 12]];

test('Maßstab parsen', () => {
  assert.equal(Sx.parseScaleText('2:1'), 2);
  assert.equal(Sx.parseScaleText('1:2'), 0.5);
  assert.equal(Sx.parseScaleText('4,0'), 4);
  assert.equal(Sx.parseScaleText(''), null);
  assert.equal(Sx.fmtScale(2), '2:1');
  assert.equal(Sx.fmtScale(0.5), '1:2');
});

test('Schraffur wählt die Materialbahn, nicht die Bohrung', () => {
  // Halbprofil der Buchse plus die unschraffierte Bohrung bis zur Achse.
  // Eine einzelne Schraffurlinie in der Bohrung lässt die Automatik (n ≥ 1) beide Flächen rotieren.
  const prims = polyPrims(WALL).concat([
    prim('line', { pts: [[0, 13], [0, 0]] }),
    prim('line', { pts: [[60, 12], [60, 0]] }),
    prim('line', { pts: [[0, 0], [60, 0]] }),
  ]);
  const hatch = [];
  for (let i = 0; i < 10; i++) hatch.push([[8 + i * 3, 17.6], [9 + i * 3, 18.4]]);
  hatch.push([[20, 5.5], [22, 6.5]]);
  const hatched = Sx.hatchedFaces(prims, hatch, 0.08);
  assert.ok(hatched.length >= 2, 'Automatik würde mehr als eine Fläche rotieren');
  const ranked = Sx.proposeContours(prims, hatch, 0.08).sort((a, b) => b.hatch - a.hatch || b.area - a.area);
  assert.ok(ranked[0].hatch >= 10, 'Vorschlag trägt die Schraffur');
  assert.ok(ranked.some(c => c.hatch === 1), 'Bohrungsbahn bleibt als Alternative sichtbar');
  const axis = { p0: [-2, 0], p1: [70, 0] };
  const good = Sx.revolveProfile(ranked[0].items, axis, 1);
  const bore = ranked.find(c => c.hatch === 1);
  const bad = Sx.revolveProfile(bore.items, axis, 1);
  assert.ok(good.rmin > 10 && good.rmax > 24 && good.rmax < 26, `Materialradius ${good.rmin}…${good.rmax}`);
  assert.ok(bad.rmin < 0.2, `Bohrungsbahn berührt die Achse (rmin ${bad.rmin})`);
  assert.ok(good.volume > 60000 && good.volume < 90000, `Volumen Material ${good.volume}`);
  assert.ok(good.volume + bad.volume > good.volume * 1.2, 'Bohrung mitrotieren vergrößert das Volumen deutlich');
  const scaled = Sx.revolveProfile(ranked[0].items, axis, 2);
  assert.ok(Math.abs(scaled.rmax * 2 - good.rmax) < 0.05, 'Maßstab 2:1 halbiert die Radien');
  assert.ok(Math.abs(scaled.volume * 8 - good.volume) / good.volume < 0.02, 'Volumen skaliert mit der dritten Potenz');
});

async function vectorContours(file) {
  const buf = new Uint8Array(readFileSync(file));
  const doc = await pdfjs.getDocument({ data: buf, isEvalSupported: false, verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  const ex = Pdf.extractDrawings(await page.getOperatorList());
  const tc = Pdf.extractPhrases(await page.getTextContent());
  const [x0, y0, x1, y1] = page.view;
  const dr = Pdf.readPdfVector(ex, tc, x1 - x0, y1 - y0);
  await doc.destroy();
  let views = RC.clusterViews(dr.thick, 3, 4);
  const strokes = [];
  views = views.filter(v => {
    const mark = Math.max(...v.size) < 12 && Math.min(...v.size) < 1.5 && v.prims.length <= 2 && v.prims.every(p => p.kind === 'line');
    if (mark) strokes.push(v);
    return !mark;
  });
  const lab = Sx.parseLabels(dr.phrases);
  const msgs = [];
  let details;
  [details, views] = Sx.findDetails(views, dr.thinCircles || [], lab, msgs);
  for (const d of details) {
    const pi = views.findIndex(v => d.cP[0] >= v.lo[0] - d.rP && d.cP[0] <= v.hi[0] + d.rP && d.cP[1] >= v.lo[1] - d.rP && d.cP[1] <= v.hi[1] + d.rP);
    if (pi < 0) continue;
    Sx.applyDetail(views[pi], d, 0.02);
    RC.refresh(views[pi]);
  }
  for (const v of views) v.prims = v.prims.filter(p => !p.weak);
  const layout = RC.detectLayout(views);
  const sections = Sx.findSections(views, strokes, lab, dr.hatch, msgs);
  for (const sec of sections) {
    const v = views[sec.view];
    sec.hatch = dr.hatch.filter(([a, b]) => {
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      return m[0] > v.lo[0] - 1 && m[0] < v.hi[0] + 1 && m[1] > v.lo[1] - 1 && m[1] < v.hi[1] + 1;
    });
    sec.regions = [];
  }
  const contours = Sx.collectContours(views, sections, { tol: 0.08, centers: dr.center, layout, scale: dr.scale });
  return { dr, layout, contours, sections };
}

test('Buchse A-A: Vorschlag ist die schraffierte Wand, Bohrung bleibt alternativ', async () => {
  const { contours } = await vectorContours(new URL('../beispiele/06_buchse.pdf', import.meta.url).pathname);
  assert.ok(contours.length >= 2, 'mehrere geschlossene Bahnen');
  const prop = contours.find(c => c.vorschlag);
  assert.ok(prop, 'ein Vorschlag');
  assert.ok(prop.schraffur >= 10, `Vorschlag ohne genug Schraffur (${prop.schraffur})`);
  assert.ok(prop.flaeche > 500 && prop.flaeche < 900, `Fläche ${prop.flaeche}`);
  assert.equal(prop.achse.quelle, 'mittellinie');
  assert.ok(Math.abs(prop.achse.p0[1] - prop.achse.p1[1]) < 0.6, 'Achse waagerecht');
  const bare = contours.filter(c => c.schraffur === 0);
  assert.ok(bare.length >= 1, 'unschraffierte Bahn (falsche Kontur) wird angeboten');
  const good = Sx.revolveProfile(prop.items, prop.achse, 1);
  assert.ok(good.rmin > 10 && good.rmin < 14, `Innenradius ${good.rmin}`);
  assert.ok(good.rmax > 24 && good.rmax < 26, `Außenradius ${good.rmax}`);
  assert.ok(good.volume > 60000 && good.volume < 90000, `ca. Volumen ${good.volume}`);
});

test('Buchse: Feature-Stack dreht nur die bestätigte Basis', async () => {
  const { contours, dr, layout, sections } = await vectorContours(new URL('../beispiele/06_buchse.pdf', import.meta.url).pathname);
  const stack = proposeStack({
    teil_typ: layout.typ,
    massstab: dr.scale,
    massstab_quelle: dr.scale_src || 'Schriftfeld',
    schnitt_konturen: contours,
    schnitte: sections.map(x => ({ buchstabe: x.letter, verlauf: x.cut ? x.cut.dir : null, eltern: x.parent != null ? 'Stirnansicht' : null })),
    einzelheiten: [{ buchstabe: 'Z', massstab: 5, vergroesserung: 5 }],
    ansichten: [{ art: 'schnitt', rolle: 'Schnitt A-A' }, { art: 'ansicht', rolle: 'Stirnansicht' }],
    masse: [{ id: 'M9', typ: 'fase', wert: 1, winkel: 45, text: '1x45°' }],
    meldungen: ['Einzelheit Z (5:1): Konturelemente in die Hauptansicht übernommen (Vergrößerung 5.00×).'],
    flaechen_statistik: { Zylinder: 4, Ebene: 3 },
    schnitt_tiefe: null,
  });
  assert.equal(stack.scope, 'rotation');
  assert.ok(stack.grund.length > 20);
  const basis = stack.schritte.find(s => s.rolle === 'basis');
  assert.equal(basis.op, 'drehen');
  assert.equal(basis.confidence, 'hoch');
  const live = stack.schritte.map(s => ({ ...s, status: 'vorschlag' }));
  const auto = live.filter(appliesStep);
  assert.deepEqual(auto.map(s => s.rolle), ['basis']);
  const offen = live.filter(s => s.opWennBestaetigt === 'cut');
  assert.ok(offen.length >= 1, 'unschraffierte Bahn bleibt ein Cut-Vorschlag');
  assert.ok(offen.every(s => !appliesStep(s) && s.confidence === 'niedrig'));
  assert.ok(live.some(s => s.rolle === 'einzelheit' && /Z/.test(s.titel)));
  assert.ok(live.some(s => s.op === 'fase' && s.confidence !== 'hoch'));
});

test('Lagerplatte: Schnittkontur und Tiefenvorschlag', async () => {
  const { contours, layout, dr, sections } = await vectorContours(new URL('../beispiele/07_lagerplatte_schnitt.pdf', import.meta.url).pathname);
  const prop = contours.find(c => c.vorschlag);
  assert.ok(prop && prop.schraffur >= 10, 'schraffierte Schnittfläche');
  assert.equal(layout.typ, 'prisma');
  assert.ok(prop.flaeche > 1500 && prop.flaeche < 2800, `Schnittfläche ${prop.flaeche}`);
  const stack = proposeStack({
    teil_typ: layout.typ, massstab: dr.scale, massstab_quelle: dr.scale_src || 'Schriftfeld',
    schnitt_konturen: contours,
    schnitte: sections.map(x => ({ buchstabe: x.letter, verlauf: x.cut ? x.cut.dir : null, eltern: x.parent != null ? 'Draufsicht' : null })),
    einzelheiten: [], ansichten: [{ art: 'schnitt' }, { art: 'ansicht' }], masse: [], meldungen: [],
    flaechen_statistik: { Ebene: 6 }, schnitt_tiefe: 60,
  });
  const basis = stack.schritte.find(s => s.rolle === 'basis');
  assert.equal(basis.op, 'extrudieren');
  assert.equal(basis.confidence, 'hoch');
  assert.equal(stack.scope, 'prismatisch');
});
