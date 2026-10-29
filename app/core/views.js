// Ansichten auf dem Blatt: gruppieren, Schriftfeld und Isometrie abtrennen, Rollen vorschlagen.
import { bbox, dist, Graph } from './geom.js';
import { fitPrimitives } from './fitgeom.js';
import { erkenneMittellinie } from './mittellinie.js';

export function clusterViews(prims, gap = 3.0, minSize = 4.0) {
  const boxes = prims.map(bbox);
  const parent = prims.map((_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < prims.length; i++) for (let j = i + 1; j < prims.length; j++) {
    const [a0, a1] = boxes[i], [b0, b1] = boxes[j];
    if (a0[0] - gap <= b1[0] && b0[0] - gap <= a1[0] && a0[1] - gap <= b1[1] && b0[1] - gap <= a1[1]) parent[find(i)] = find(j);
  }
  const groups = new Map();
  prims.forEach((_, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); });
  let views = [];
  for (const g of groups.values()) {
    const lo = [Math.min(...g.map(i => boxes[i][0][0])), Math.min(...g.map(i => boxes[i][0][1]))];
    const hi = [Math.max(...g.map(i => boxes[i][1][0])), Math.max(...g.map(i => boxes[i][1][1]))];
    if (Math.max(hi[0] - lo[0], hi[1] - lo[1]) < minSize) continue;
    views.push({ prims: g.map(i => prims[i]), lo, hi });
  }
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (const a of views) for (const b of views) {
      if (a !== b && a.lo[0] >= b.lo[0] - 0.01 && a.lo[1] >= b.lo[1] - 0.01 && a.hi[0] <= b.hi[0] + 0.01 && a.hi[1] <= b.hi[1] + 0.01) {
        b.prims.push(...a.prims); views = views.filter(v => v !== a); changed = true; break outer;
      }
    }
  }
  views.forEach(refresh);
  views.sort((a, b) => -a.c[1] + b.c[1] || a.c[0] - b.c[0]);
  return views;
}

export function refresh(v) {
  const bb = v.prims.map(bbox);
  v.lo = [Math.min(...bb.map(b => b[0][0])), Math.min(...bb.map(b => b[0][1]))];
  v.hi = [Math.max(...bb.map(b => b[1][0])), Math.max(...bb.map(b => b[1][1]))];
  v.c = [(v.lo[0] + v.hi[0]) / 2, (v.lo[1] + v.hi[1]) / 2];
  v.size = [v.hi[0] - v.lo[0], v.hi[1] - v.lo[1]];
}

function nearPhrase(phrases, v, re, pad = 18) {
  return (phrases || []).find(p => re.test(p.text || '')
    && p.x >= v.lo[0] - pad && p.x <= v.hi[0] + pad && p.y >= v.lo[1] - pad && p.y <= v.hi[1] + pad);
}

function axisShare(v) {
  let axis = 0, other = 0, n = 0;
  for (const p of v.prims) {
    if (p.kind !== 'line' || !p.pts) continue;
    const dx = p.pts[1][0] - p.pts[0][0], dy = p.pts[1][1] - p.pts[0][1];
    const L = Math.hypot(dx, dy);
    if (L < 8) continue;
    n++;
    let ang = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI) % 180;
    const toAxis = Math.min(ang, Math.abs(ang - 90), Math.abs(180 - ang));
    if (toAxis < 8) axis += L; else other += L;
  }
  if (n < 4 || axis + other < 30) return null;
  return axis / (axis + other);
}

function isTitleBlock(v, page, phrases) {
  if (!page || v.lo[1] > 3) return false;
  if (v.hi[1] > page.h * 0.34) return false;
  if (v.size[0] < page.w * 0.28) return false;
  return !!nearPhrase(phrases, v, /designed|scale|maßstab|massstab|datum|date|benennung|werkstoff|gezeichnet|titel/i, 8)
    || (v.prims.length >= 15 && v.size[1] < page.h * 0.28);
}

const ROLLE_LABEL = {
  haupt: 'Hauptansicht',
  rechts: 'Abgeleitet rechts',
  links: 'Abgeleitet links',
  oben: 'Abgeleitet oben',
  unten: 'Abgeleitet unten',
  abgeleitet: 'Abgeleitet',
  schnitt: 'Schnitt',
  isometrie: 'Isometrie (nur Orientierung)',
  schriftfeld: 'Schriftfeld',
  ignorieren: 'Ignorieren',
  einzelheit: 'Einzelheit',
};

export function rolleLabel(rolle, extra) {
  const base = ROLLE_LABEL[rolle] || rolle || 'Ansicht';
  return extra ? base + ' ' + extra : base;
}

function classifyOne(v, page, phrases) {
  if (isTitleBlock(v, page, phrases)) return { rolle: 'schriftfeld', art: 'schriftfeld', nutzen: false };
  const isoTxt = nearPhrase(phrases, v, /isometr/i, 28);
  const share = axisShare(v);
  if (isoTxt || (share != null && share < 0.38)) return { rolle: 'isometrie', art: 'isometrie', nutzen: false };
  const sec = nearPhrase(phrases, v, /schnitt/i, 22);
  if (sec) return { rolle: 'schnitt', art: 'schnitt', nutzen: true, extra: sec.text.replace(/\s+/g, '') };
  const det = nearPhrase(phrases, v, /einzelheit|detail/i, 22);
  if (det && /[A-Z]\s*\(|detail\s+[A-Z]|einzelheit/i.test(det.text)) return { rolle: 'einzelheit', art: 'einzelheit', nutzen: true, extra: det.text };
  return { rolle: 'ortho', art: 'ansicht', nutzen: true };
}

function assignProjection(list) {
  const ortho = list.filter(v => v.rolle === 'ortho' || v.rolle === 'schnitt');
  if (!ortho.length) return;
  const score = v => v.size[0] * v.size[1] * (v.rolle === 'schnitt' ? 0.25 : 1);
  const haupt = ortho.reduce((a, b) => score(b) > score(a) ? b : a);
  haupt.rolle = 'haupt';
  haupt.art = 'ansicht';
  for (const v of ortho) {
    if (v === haupt) continue;
    if (v.rolle === 'schnitt') continue;
    const row = Math.abs(v.c[1] - haupt.c[1]) < Math.max(10, haupt.size[1] * 0.35);
    const col = Math.abs(v.c[0] - haupt.c[0]) < Math.max(10, haupt.size[0] * 0.35);
    if (row && v.c[0] > haupt.c[0]) v.rolle = 'rechts';
    else if (row && v.c[0] < haupt.c[0]) v.rolle = 'links';
    else if (col && v.c[1] > haupt.c[1]) v.rolle = 'oben';
    else if (col && v.c[1] < haupt.c[1]) v.rolle = 'unten';
    else v.rolle = 'abgeleitet';
    v.art = 'ansicht';
  }
}

/**
 * Gruppiert Körperkanten, fittet tessellierte Züge und vergibt Rollen.
 * hinweis.ansichten: [{ id, rolle, nutzen }] aus der Bestätigung.
 * hinweis.luecke_mm / schliessen: manuelles Schließen und gröberes Fitten.
 */
export function aufbereiten(dr, hinweis) {
  const msgs = [];
  const raster = dr.kind === 'raster';
  if (!raster && dr.thick && dr.thick.length) {
    const fit = fitPrimitives(dr.thick, { join: hinweis && hinweis.luecke_mm > 0 ? hinweis.luecke_mm : 0.45, schliessen: !!(hinweis && hinweis.schliessen) });
    if (fit.changed) {
      dr.thick = fit.prims;
      msgs.push(fit.text);
    }
    dr.fit = fit;
  }
  let views = clusterViews(dr.thick || [], raster ? 2.0 : 3.0, 4.0);
  const strokes = (dr.strokes || []).slice();
  if (raster) {
    for (const v of views.slice()) {
      const host = views.find(w => w !== v && Math.max(...w.size) > Math.max(...v.size) * 2 && v.lo[0] >= w.lo[0] && v.hi[0] <= w.hi[0] && v.lo[1] >= w.lo[1] && v.hi[1] <= w.hi[1]);
      if (host) { host.prims.push(...v.prims); views.splice(views.indexOf(v), 1); refresh(host); }
    }
  }
  views = views.filter(v => {
    const st = Math.max(...v.size) < 12 && Math.min(...v.size) < 1.5 && v.prims.length <= 2 && v.prims.every(p => p.kind === 'line');
    if (st) strokes.push(v);
    return !st && !(raster && Math.max(...v.size) < 8);
  });
  const page = { w: dr.page_w || 0, h: dr.page_h || 0 };
  const phrases = dr.phrases || [];
  views.forEach((v, i) => {
    const c = classifyOne(v, page, phrases);
    v.id = 'A' + (i + 1);
    v.rolle = c.rolle;
    v.art = c.art;
    v.nutzen = c.nutzen;
    v.extra = c.extra || '';
    v.label = rolleLabel(c.rolle === 'ortho' ? 'abgeleitet' : c.rolle, c.extra);
  });
  assignProjection(views);
  views.forEach(v => { v.label = rolleLabel(v.rolle, v.extra); });
  const byId = new Map(views.map(v => [v.id, v]));
  if (hinweis && Array.isArray(hinweis.ansichten)) {
    for (const a of hinweis.ansichten) {
      const v = byId.get(a.id);
      if (!v) continue;
      if (a.rolle) v.rolle = a.rolle;
      v.nutzen = !!a.nutzen && a.rolle !== 'ignorieren';
      if (v.rolle === 'isometrie' || v.rolle === 'schriftfeld') v.art = v.rolle === 'isometrie' ? 'isometrie' : 'schriftfeld';
      else if (v.rolle === 'schnitt') v.art = 'schnitt';
      else if (v.rolle === 'einzelheit') v.art = 'einzelheit';
      else v.art = 'ansicht';
      v.label = rolleLabel(v.rolle, v.extra);
    }
  }
  const use = views.filter(v => v.nutzen && v.rolle !== 'isometrie' && v.rolle !== 'schriftfeld' && v.rolle !== 'ignorieren');
  const nIso = views.filter(v => v.rolle === 'isometrie').length;
  const nSchrift = views.filter(v => v.rolle === 'schriftfeld').length;
  const nDet = views.filter(v => v.rolle === 'einzelheit').length;
  if (views.length) msgs.push(`${views.length} Bereich(e) auf dem Blatt, ${use.length} fürs Volumen`
    + (nIso ? `, ${nIso} Isometrie (nicht mitgebaut)` : '')
    + (nSchrift ? `, ${nSchrift} Schriftfeld` : '')
    + (nDet ? `, ${nDet} Einzelheit (lokaler Maßstab, noch nicht still ins Volumen)` : '') + '.');
  const details = (phrases || []).filter(p => /einzelheit|detail/i.test(p.text || '')).map(p => ({ text: p.text, at: [p.x, p.y] }));
  if (details.length) msgs.push('Einzelheit erkannt (' + details.map(d => d.text).join(', ') + '). Lokaler Maßstab bleibt erhalten und wird nicht übersprungen; die Übernahme ins Volumen erst nach Zuordnung.');
  return { alle: views, views: use, strokes, msgs, details };
}

export function suggestAxis(view, centers, extra = {}) {
  if (!view) return null;
  const pools = centers && centers.center ? centers : { center: centers || [], thin: extra.thin || [], hidden: extra.hidden || [] };
  const found = erkenneMittellinie(view, pools);
  if (found) {
    const horiz = Math.abs(found.p0[1] - found.p1[1]) <= Math.abs(found.p0[0] - found.p1[0]);
    return {
      ...found,
      y: (found.p0[1] + found.p1[1]) / 2,
      x: (found.p0[0] + found.p1[0]) / 2,
      lage: horiz ? 'waagerecht' : 'senkrecht',
    };
  }
  const y = (view.lo[1] + view.hi[1]) / 2;
  return { y, x: (view.lo[0] + view.hi[0]) / 2, p0: [view.lo[0], y], p1: [view.hi[0], y], quelle: 'ansichtsmitte', lage: 'waagerecht' };
}

const CONF_LABEL = { hoch: 'hoch', mittel: 'mittel', niedrig: 'niedrig' };

/** true, wenn die Ansicht eine geschlossene Außenkontur hat oder nur Kreise enthält. */
export function konturGeschlossen(view, tol = 0.12) {
  if (!view || !view.prims) return false;
  const lines = view.prims.filter(p => p.kind !== 'circle');
  if (!lines.length) return view.prims.some(p => p.kind === 'circle');
  try {
    const g = new Graph(lines, tol);
    const comps = g.components();
    if (!comps.length) return false;
    const comp = comps.reduce((a, b) => b.length > a.length ? b : a);
    g.outerWalk(comp);
    return true;
  } catch { return false; }
}

/** Sicherheit der automatischen Ansichtswahl. auto nur bei hoher Sicherheit. */
export function bewerte(prep, layout, layoutError) {
  const use = prep.views || [];
  const alle = prep.alle || [];
  if (!alle.length) {
    return { stufe: 'niedrig', auto: false, grund: 'Körperkanten bilden keine Ansichtsgruppe. Bitte die Zeichnung prüfen – das Blatt ist nicht leer, die Gruppierung ist unsicher.' };
  }
  if (!use.length) {
    return { stufe: 'niedrig', auto: false, grund: 'Bereiche sind da (Schriftfeld, Isometrie oder Einzelheit), aber keine freigegebene Körperansicht. Bitte eine Hauptansicht markieren.' };
  }
  const messy = use.some(v => {
    const lines = v.prims.filter(p => p.kind === 'line' && p.pts);
    if (lines.length < 40) return false;
    const short = lines.filter(p => dist(p.pts[0], p.pts[1]) < 1.2).length;
    return short / lines.length > 0.5;
  });
  if (layoutError) return { stufe: 'niedrig', auto: false, grund: layoutError + ' Rolle und Drehen oder Extrudieren festlegen, dann 3D erzeugen.' };
  if (messy) return { stufe: 'mittel', auto: false, grund: 'Konturen sind noch viele kurze Linien. „Bögen fitten“ oder die Lücke vergrößern, dann 3D erzeugen.' };
  if (use.length > 4) return { stufe: 'mittel', auto: false, grund: 'Mehr als vier Ansichten fürs Volumen. Bitte die Hauptansicht bestätigen.' };
  const schnitt = use.some(v => v.rolle === 'schnitt') || alle.some(v => v.rolle === 'schnitt');
  if (schnitt && layout && layout.typ === 'prisma') return { stufe: 'mittel', auto: false, grund: 'Schnitt erkannt. Bitte Drehen oder Extrudieren wählen. Die Achse lässt sich setzen, auch ohne Mittellinie.' };
  if (layout && layout.typ === 'prisma') {
    const haupt = use.find(v => v.rolle === 'haupt') || use[0];
    if (haupt && haupt.size[0] > haupt.size[1] * 2.2 && haupt.size[0] > 50 && !use.some(v => v.prims.some(p => p.kind === 'circle'))) {
      return { stufe: 'mittel', auto: false, grund: 'Lange Ansicht ohne Stirnkreise. Für eine Welle „Drehen“ und die Achse prüfen, sonst Extrudieren. Ein Klick genügt.' };
    }
  }
  if (!layout) return { stufe: 'mittel', auto: false, grund: 'Projektion unsicher. Bitte Hauptansicht und Art bestätigen.' };
  const haupt = use.find(v => v.rolle === 'haupt') || use[0];
  if (haupt && layout.typ === 'prisma' && !konturGeschlossen(haupt)) {
    return { stufe: 'mittel', auto: false, grund: 'Die Hauptansicht ist noch nicht geschlossen. Lücke oder „Kontur schließen“, dann 3D erzeugen. Drehen bleibt möglich.' };
  }
  return { stufe: 'hoch', auto: true, grund: 'Ansichten sind eindeutig' + (alle.some(v => v.rolle === 'isometrie') ? ', Isometrie bleibt außen vor' : '') + '. ' + (layout.typ === 'dreh' ? 'Vorschlag: Drehen.' : 'Vorschlag: Extrudieren.') };
}

export function konfidenzText(stufe) {
  return CONF_LABEL[stufe] || stufe;
}
