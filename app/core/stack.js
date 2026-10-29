// Feature-Stack: Vorschläge aus Ansichten, Schnitten und Einzelheiten.
// Nur Extrusion/Drehung und Boolean Add/Cut. Freiform wird nicht modelliert.
import { pointInPoly } from './geom.js';
import { fmtScale } from './sections.js';

const rank = { niedrig: 0, mittel: 1, hoch: 2 };
export function worse(a, b) { return rank[a] <= rank[b] ? a : b; }

export function scaleLevel(res) {
  if (!res || !(res.massstab > 0)) return 'niedrig';
  const src = res.massstab_quelle || '';
  if (/WARNUNG|Annahme|nicht sicher|geraten|geschätzt/i.test(src)) return 'mittel';
  return 'hoch';
}

export function axisFrame(axis, p) {
  const p0 = axis.p0, p1 = axis.p1;
  let ux = p1[0] - p0[0], uy = p1[1] - p0[1];
  const L = Math.hypot(ux, uy) || 1;
  ux /= L; uy /= L;
  return [(p[0] - p0[0]) * ux + (p[1] - p0[1]) * uy, (p[0] - p0[0]) * -uy + (p[1] - p0[1]) * ux];
}

/** Untere und obere Hälfte desselben Drehprofils. */
export function isMirrorPair(a, b, axis) {
  if (!axis || !axis.p0 || !axis.p1 || !a || !b || !a.poly || !b.poly) return false;
  if (a.poly.length < 3 || b.poly.length < 3) return false;
  const mean = poly => {
    const P = poly.map(p => axisFrame(axis, p));
    const n = P.length || 1;
    return [P.reduce((s, p) => s + p[0], 0) / n, P.reduce((s, p) => s + p[1], 0) / n];
  };
  const ma = mean(a.poly), mb = mean(b.poly);
  if (Math.abs(ma[0] - mb[0]) > 3) return false;
  if (ma[1] * mb[1] >= 0) return false;
  if (Math.abs(Math.abs(ma[1]) - Math.abs(mb[1])) > 3) return false;
  const areaA = Math.abs(a.flaeche || 0), areaB = Math.abs(b.flaeche || 0);
  if (!areaA || !areaB) return false;
  return Math.abs(areaA - areaB) / Math.max(areaA, areaB) < 0.15;
}

function mostlyInside(inner, outer) {
  if (!inner || !outer || !inner.poly || !outer.poly || inner.poly.length < 3) return false;
  let n = 0;
  for (const p of inner.poly) if (pointInPoly(p, outer.poly)) n++;
  return n >= inner.poly.length * 0.6;
}

function freeShare(res) {
  const st = (res && res.flaechen_statistik) || {};
  const n = Object.values(st).reduce((a, b) => a + b, 0);
  const free = (st['B-Spline-Fläche'] || 0) + (st['Extrusionsfläche (B-Spline)'] || 0);
  return { n, free, share: n ? free / n : 0 };
}

function scopeOf(res) {
  const typ = res && res.teil_typ;
  if (typ === 'dreh') return 'rotation';
  if (typ === 'prisma') return 'prismatisch';
  return 'nicht_unterstuetzt';
}

function contourSpec(c, res, mode) {
  return {
    mode,
    items: c.items,
    axis: c.achse || null,
    scale: res.massstab || 1,
    side: 'auto',
    depth: res.schnitt_tiefe || null,
    dir: 'z',
    label: c.buchstabe ? `Schnitt ${c.buchstabe}-${c.buchstabe}` : 'Schnittkontur',
    ansicht: c.ansicht,
  };
}

/**
 * Schritte, die „3D aktualisieren“ ohne extra Klick übernimmt:
 * nur die Basis, und nur bei hoher Sicherheit und ohne Zurückstellen.
 * Schnitte, Einzelheiten und Fasen warten auf Bestätigung.
 */
export function appliesStep(s) {
  if (!s || !s.op || s.status === 'uebersprungen' || s.zurueckgestellt) return false;
  if (s.status === 'bestaetigt') return true;
  return s.status === 'vorschlag' && s.confidence === 'hoch' && s.rolle === 'basis';
}

/** Vorschlag mit Wirkung, der noch nicht bestätigt ist. Auch Cuts, die erst beim Bestätigen ein op bekommen. */
export function needsDecision(s) {
  return !!(s && s.status === 'vorschlag' && !appliesStep(s) && (s.op || s.opWennBestaetigt));
}

export function waitingSteps(steps) {
  return (steps || []).filter(needsDecision);
}

function basisConfidence(res, contour, mode) {
  const scale = scaleLevel(res);
  const hatch = contour && contour.schraffur >= 5;
  let axis = 'mittel';
  if (mode === 'drehen') {
    const q = contour && contour.achse && contour.achse.quelle;
    axis = q === 'mittellinie' ? 'hoch' : q === 'symmetrie' ? 'mittel' : 'niedrig';
  } else if (res.schnitt_tiefe > 0) axis = 'hoch';
  else axis = 'niedrig';
  let level = 'hoch';
  if (!hatch) level = worse(level, 'niedrig');
  level = worse(level, scale);
  level = worse(level, axis);
  const bits = [];
  if (!hatch) bits.push('wenig oder keine Schraffur in der vorgeschlagenen Kontur');
  if (scale !== 'hoch') bits.push(scale === 'niedrig' ? 'Maßstab fehlt' : 'Maßstab ist nicht sicher (' + (res.massstab_quelle || 'ohne Quelle') + ')');
  if (mode === 'drehen' && axis !== 'hoch') bits.push(axis === 'niedrig' ? 'Rotationsachse ist nur geraten' : 'Rotationsachse aus Symmetrie, nicht aus einer Mittellinie');
  if (mode === 'extrudieren' && !(res.schnitt_tiefe > 0)) bits.push('Extrusionstiefe lässt sich nicht aus einer Nachbaransicht lesen');
  if (!bits.length) bits.push(mode === 'drehen'
    ? 'Schraffur, Mittellinie und Maßstab reichen für das Basisvolumen'
    : 'Schraffur, Tiefe aus der Nachbaransicht und Maßstab reichen für das Basisvolumen');
  return { level, grund: bits.join('. ') + '.' };
}

function detailNote(res) {
  const dets = res.einzelheiten || [];
  const msgs = (res.meldungen || []).join(' ');
  return dets.map(d => {
    const k = d.massstab;
    const ratio = d.vergroesserung;
    const expect = k && res.massstab ? k / res.massstab : null;
    const match = expect && ratio && Math.abs(ratio / expect - 1) < 0.08;
    const merged = new RegExp('Einzelheit ' + d.buchstabe + '[\\s\\S]{0,80}übernommen').test(msgs);
    let level = 'hoch';
    const bits = [`Einzelheit ${d.buchstabe}`];
    if (k) bits.push('Maßstab ' + fmtScale(k));
    else { bits.push('Maßstab nicht gelesen'); level = 'niedrig'; }
    if (ratio) bits.push('Kreisverhältnis ' + (+ratio).toFixed(2) + '×');
    if (k && ratio && !match) { bits.push('Kreisverhältnis und Maßstab passen nicht – lokalen Maßstab prüfen'); level = worse(level, 'mittel'); }
    if (merged) bits.push('die Kontur ist in den Hauptschnitt übernommen (z. B. Freistich). Kein zweites Boolean, sonst würde das Merkmal doppelt entstehen');
    else { bits.push('nicht in die Schnittkontur übernommen. Axiale Lage eines Freistichs ist damit nicht eindeutig – bitte in der Zeichnung prüfen'); level = worse(level, 'niedrig'); }
    return {
      id: 'E-' + d.buchstabe,
      rolle: 'einzelheit',
      op: null,
      titel: `Einzelheit ${d.buchstabe}`,
      confidence: level,
      grund: bits.join(', ') + '.',
      contourId: null,
      spec: null,
    };
  });
}

function faseSteps(res) {
  const out = [];
  if (res.teil_typ !== 'dreh') return out;
  for (const d of res.masse || []) {
    if (d.typ !== 'fase' || !(d.wert > 0)) continue;
    const w = d.winkel || 45;
    out.push({
      id: 'F-' + (d.id || out.length + 1),
      rolle: 'merkmal',
      op: 'fase',
      titel: `Fase ${String(d.wert).replace('.', ',')} × ${w}°`,
      confidence: 'mittel',
      grund: `Fase aus „${d.text || d.id}“. Annahme: beide äußeren Stirnkanten des Drehteils. Erst nach Bestätigung schneiden, die Kante ist nicht eindeutig einer Fläche zugeordnet.`,
      contourId: null,
      spec: { c: d.wert, winkel: w },
    });
  }
  return out;
}

function senkungSteps(res) {
  const out = [];
  const feats = res.merkmale || [];
  feats.forEach((m, i) => {
    const text = typeof m === 'string' ? m : `${m.typ || ''}: ${m.text || ''}`;
    if (!/senkung|kegelloch/i.test(text)) return;
    const mm = text.match(/(\d{2,3})\s*°/);
    const ds = [...text.matchAll(/Ø\s*(\d+(?:[.,]\d+)?)/g)].map(x => parseFloat(x[1].replace(',', '.')));
    const klar = mm && ds.length >= 1;
    out.push({
      id: 'K-' + (i + 1),
      rolle: 'merkmal',
      op: klar ? 'senkung' : null,
      opWennBestaetigt: klar ? null : null,
      titel: klar ? `Senkung ${mm[1]}°` : 'Senkung (unklar)',
      confidence: klar ? 'mittel' : 'niedrig',
      grund: klar
        ? text + ' Lage an der Stirnseite des Drehteils ist eine Annahme. Erst nach Bestätigung abziehen.'
        : text + ' Die Maße reichen nicht für einen Kegelschnitt. Bitte bestätigen oder überspringen – es wird nichts stillschweigend weggelassen.',
      contourId: null,
      spec: klar ? { winkel: +mm[1], durchmesser: Math.max(...ds), bohrung: ds.length > 1 ? Math.min(...ds) : null } : null,
    });
  });
  return out;
}

function contourSteps(res, basis) {
  const out = [];
  const contours = res.schnitt_konturen || [];
  const mode = res.teil_typ === 'prisma' ? 'extrudieren' : 'drehen';
  for (const c of contours) {
    if (!c || c.id === basis.id) continue;
    const mirror = mode === 'drehen' && isMirrorPair(basis, c, basis.achse || c.achse);
    if (mirror) {
      out.push({
        id: 'H-' + c.id,
        rolle: 'hinweis',
        op: null,
        titel: (c.buchstabe ? `Schnitt ${c.buchstabe}-${c.buchstabe}` : 'Kontur') + ' · Gegenhälfte',
        confidence: 'hoch',
        grund: 'Spiegelt die Basis über die Drehachse. Die volle Drehung enthält diese Hälfte bereits, kein weiteres Boolean.',
        contourId: c.id,
        spec: null,
      });
      continue;
    }
    const inside = mostlyInside(c, basis);
    const hatched = c.schraffur > 0;
    let op = null, opWenn = null, level, titel, grund;
    const name = (c.buchstabe ? `Schnitt ${c.buchstabe}-${c.buchstabe}` : 'Kontur ' + c.id);
    if (hatched && !inside) {
      op = 'add'; level = c.schraffur >= 4 ? 'hoch' : 'mittel';
      titel = name + ' · Material hinzufügen';
      grund = 'Weitere schraffierte Fläche. Wird als Vereinigung (Add) angetragen, aber erst nach Bestätigung, damit nichts doppelt entsteht.';
    } else if (hatched && inside) {
      op = 'add'; level = 'mittel';
      titel = name + ' · Insel im Schnitt';
      grund = 'Schraffierte Fläche innerhalb der Basis. Als Add vorgeschlagen. Bitte prüfen, ob das zusätzliches Material ist.';
    } else if (!hatched && inside) {
      opWenn = 'cut'; level = 'niedrig';
      titel = name + ' · ohne Schraffur';
      grund = 'Keine Schraffur, oft Bohrung oder Einstich. Nicht automatisch abgezogen. Bestätigen schneidet die rotierte bzw. extrudierte Kontur ab (Cut). Überspringen lässt sie weg.';
    } else {
      opWenn = 'cut'; level = 'niedrig';
      titel = name + ' · weitere Kontur';
      grund = 'Weder klar Material noch klar Abzug. Bitte Cut bestätigen oder überspringen. Ohne Entscheidung bleibt der Körper unverändert.';
    }
    if (c.buchstabe && basis.buchstabe && c.buchstabe !== basis.buchstabe) level = worse(level, 'mittel');
    const step = {
      id: 'C-' + c.id,
      rolle: op === 'add' ? 'add' : 'cut',
      op,
      opWennBestaetigt: opWenn,
      titel,
      confidence: level,
      grund,
      contourId: c.id,
      spec: contourSpec(c, res, mode),
    };
    if (!op && opWenn) step.spec.mode = mode;
    out.push(step);
  }
  return out;
}

function overall(scope, steps, free) {
  if (scope === 'nicht_unterstuetzt') {
    return { confidence: 'niedrig', grund: 'Nur prismatische und rotationssymmetrische Teile. Dieses Blatt ist weder als Extrusion noch als Drehung geführt. Freiformflächen werden nicht modelliert. Die Automatik bleibt unverändert nutzbar.' };
  }
  const basis = steps.find(s => s.rolle === 'basis');
  if (!basis) {
    return { confidence: 'niedrig', grund: 'Kein Hauptschnitt mit Kontur. Allein aus diesem Blatt entsteht kein Feature-Stack. Die automatische Rekonstruktion bleibt über „Automatik“ verfügbar.' };
  }
  let level = basis.confidence;
  if (free.share > 0.4) level = 'niedrig';
  else if (free.share > 0.15) level = worse(level, 'mittel');
  const wait = waitingSteps(steps);
  if (level === 'niedrig') {
    return { confidence: 'niedrig', grund: basis.grund + (free.share > 0.4 ? ' Viele Freiformflächen (B-Spline) – die werden nicht übernommen.' : '') + ' Bitte die Basis bestätigen, bevor ein Volumen entsteht.' };
  }
  if (level === 'mittel') {
    return { confidence: 'mittel', grund: 'Das Basisvolumen ist brauchbar, Maßstab, Achse oder Einzelheit brauchen einen Blick. Ohne Bestätigung wird bei mittlerer Sicherheit nichts gebaut.' };
  }
  if (wait.length) {
    return { confidence: 'hoch', grund: 'Das Basisvolumen lässt sich allein aufbauen. ' + wait.length + ' weitere Schritte (Schnitt, Einzelheit, Fase, Senkung) warten auf Bestätigung und werden nicht still übersprungen.' };
  }
  return { confidence: 'hoch', grund: 'Ansichten, Hauptschnitt und Maßstab reichen für das Basisvolumen.' };
}

/** Vorschlag aus dem Rekonstruktionsergebnis. Ändert die Eingabe nicht. */
export function proposeStack(res) {
  const src = res || {};
  const scope = scopeOf(src);
  const free = freeShare(src);
  const scale = scaleLevel(src);
  const views = src.ansichten || [];
  const sections = src.schnitte || [];
  const ohneVerlauf = sections.filter(s => s.buchstabe && !s.verlauf).length;
  const nDet = (src.einzelheiten || []).length;
  let blattLevel = 'hoch';
  if (!views.length && !sections.length) blattLevel = 'niedrig';
  else if (!sections.length || scale !== 'hoch' || ohneVerlauf) blattLevel = 'mittel';
  const blattBits = [];
  blattBits.push(views.length + ' Ansichtsrahmen');
  blattBits.push(sections.length + ' Schnitt' + (sections.length === 1 ? '' : 'e'));
  if (nDet) blattBits.push(nDet + ' Einzelheit' + (nDet === 1 ? '' : 'en'));
  blattBits.push('Maßstab ' + (src.massstab > 0 ? fmtScale(src.massstab) : 'fehlt'));
  if (src.massstab_quelle) blattBits.push(src.massstab_quelle);
  if (ohneVerlauf) blattBits.push(ohneVerlauf + ' Schnitt(e) ohne Schnittverlauf');
  if (!sections.length) blattBits.push('kein Schnitt erkannt');
  const steps = [{
    id: 'BLATT',
    rolle: 'blatt',
    op: null,
    titel: 'Blatt: Ansichten, Schnitte, Maßstäbe',
    confidence: blattLevel,
    grund: blattBits.join(' · ') + '.',
    contourId: null,
    spec: null,
  }];
  if (free.free > 0) {
    steps.push({
      id: 'FREI',
      rolle: 'hinweis',
      op: null,
      titel: 'Freiformflächen nicht unterstützt',
      confidence: free.share > 0.4 ? 'niedrig' : 'mittel',
      grund: free.free + ' B-Spline-Flächen. Der Stack modelliert nur analytische Flächen aus Extrusion, Drehung und Boolean. Freiform wird nicht angenähert.',
      contourId: null,
      spec: null,
    });
  }
  if (scope === 'nicht_unterstuetzt') {
    const pack = { scope, confidence: 'niedrig', grund: '', schritte: steps };
    const ov = overall(scope, steps, free);
    pack.confidence = ov.confidence; pack.grund = ov.grund;
    return pack;
  }
  const contours = src.schnitt_konturen || [];
  const basisC = contours.find(c => c.vorschlag) || contours.find(c => c.schraffur > 0) || null;
  const mode = scope === 'prismatisch' ? 'extrudieren' : 'drehen';
  if (basisC) {
    const bc = basisConfidence(src, basisC, mode);
    steps.push({
      id: 'BASIS',
      rolle: 'basis',
      op: mode,
      titel: mode === 'drehen' ? 'Basis: Drehen des Hauptschnitts' : 'Basis: Extrudieren des Hauptschnitts',
      confidence: bc.level,
      grund: bc.grund,
      contourId: basisC.id,
      spec: contourSpec(basisC, src, mode),
    });
    steps.push(...contourSteps(src, basisC));
  } else {
    steps.push({
      id: 'BASIS',
      rolle: 'hinweis',
      op: null,
      titel: 'Kein Hauptschnitt',
      confidence: 'niedrig',
      grund: 'Ohne geschlossene Schnittkontur gibt es kein Basisvolumen. „Automatik“ nutzt weiterhin die bisherige Rekonstruktion.',
      contourId: null,
      spec: null,
    });
  }
  const details = detailNote(src);
  steps.push(...details);
  const basisStep = steps.find(s => s.rolle === 'basis');
  if (basisStep && details.some(d => d.confidence !== 'hoch')) {
    basisStep.confidence = worse(basisStep.confidence, 'mittel');
    basisStep.grund += ' Einzelheit und lokaler Maßstab sind nicht eindeutig – Basis bitte bestätigen.';
  }
  steps.push(...faseSteps(src));
  steps.push(...senkungSteps(src));
  const ov = overall(scope, steps, free);
  return { scope, confidence: ov.confidence, grund: ov.grund, schritte: steps };
}
