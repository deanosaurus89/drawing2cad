// Ansichtsliste: Rollen bestätigen, Drehen/Extrudieren, Mittellinie, Linienzüge fitten.
import { bahnAusAnsicht, ansichtFuerBahn, halbkontur } from './core/mittellinie.js';
const NS = 'http://www.w3.org/2000/svg';
const ARTEN = [
  ['ansicht', 'Normale Ansicht'],
  ['schnitt', 'Schnitt'],
  ['einzelheit', 'Einzelheit'],
  ['isometrie', 'Isometrie, nur Orientierung'],
  ['ignorieren', 'Nicht verwenden'],
];

export function createViewUI(api) {
  const { $ } = api;
  const ui = { analyse: null, achse: null, wahl: {} };

  function panel() { return $('#ansicht-panel'); }
  function list() { return $('#av-liste'); }

  function paint(a) {
    const host = $('#blatt') || $('#vorschau');
    if (!host || !a || !a.page_w) return;
    host.querySelectorAll('.box.av').forEach(b => b.remove());
    for (const v of a.alle || []) {
      const b = document.createElement('div');
      b.className = 'box av ' + (v.art || 'ansicht');
      b.style.left = (v.lo[0] / a.page_w * 100) + '%';
      b.style.width = ((v.hi[0] - v.lo[0]) / a.page_w * 100) + '%';
      b.style.top = ((a.page_h - v.hi[1]) / a.page_h * 100) + '%';
      b.style.height = ((v.hi[1] - v.lo[1]) / a.page_h * 100) + '%';
      b.innerHTML = `<span>${v.id} ${v.label}</span>`;
      host.appendChild(b);
    }
  }

  function show(a) {
    ui.analyse = a;
    const el = panel();
    if (!el) return;
    if (!a || !(a.alle || []).length) { el.hidden = true; return; }
    el.hidden = false;
    $('#av-conf').textContent = 'Sicherheit ' + a.stufe + ' – ' + a.grund;
    $('#av-conf').className = 'stack-conf ' + (a.stufe || '');
    const box = list();
    box.innerHTML = '';
    const erste = (a.views || []).find(v => v.rolle === 'haupt') || (a.alle || []).find(v => v.rolle === 'schnitt') || (a.views || a.alle || [])[0];
    for (const v of a.alle) {
      const art0 = v.rolle === 'schnitt' ? 'schnitt' : v.rolle === 'einzelheit' ? 'einzelheit' : v.rolle === 'isometrie' ? 'isometrie' : (v.rolle === 'ignorieren' || v.rolle === 'schriftfeld' ? 'ignorieren' : 'ansicht');
      const w = ui.wahl[v.id] || {};
      if (!ui.wahl[v.id]) ui.wahl[v.id] = { art: art0, op: (a.modus === 'drehen' || v.rolle === 'schnitt' && a.layout && a.layout.typ === 'dreh') ? 'drehen' : 'extrudieren', schritt1: erste && v.id === erste.id };
      const cur = ui.wahl[v.id];
      const row = document.createElement('div');
      row.className = 'av-row';
      row.dataset.id = v.id;
      const arts = ARTEN.map(([k, n]) => `<option value="${k}"${k === cur.art ? ' selected' : ''}>${n}</option>`).join('');
      row.innerHTML = `<label class="chk"><input type="radio" name="schritt1" data-s1 ${cur.schritt1 ? 'checked' : ''}> ${v.id} Schritt 1</label>
        <select data-art aria-label="Rolle ${v.id}">${arts}</select>
        <select data-op aria-label="Operation ${v.id}">
          <option value="drehen"${cur.op === 'drehen' ? ' selected' : ''}>Rotieren</option>
          <option value="extrudieren"${cur.op === 'extrudieren' ? ' selected' : ''}>Extrudieren</option>
        </select>
        <span class="leer">${Math.round(v.size[0])}×${Math.round(v.size[1])} mm</span>`;
      row.querySelector('[data-art]').onchange = () => { cur.art = row.querySelector('[data-art]').value; syncOp(row, cur); wirkung(); zeichneOverlay(); };
      row.querySelector('[data-op]').onchange = () => { cur.op = row.querySelector('[data-op]').value; if (cur.schritt1) modusAusSchritt(); wirkung(); zeichneOverlay(); };
      row.querySelector('[data-s1]').onchange = () => {
        for (const id of Object.keys(ui.wahl)) ui.wahl[id].schritt1 = id === v.id;
        cur.schritt1 = true;
        modusAusSchritt();
        list().querySelectorAll('.av-row').forEach(r => syncOp(r, ui.wahl[r.dataset.id]));
        wirkung(); zeichneOverlay();
      };
      syncOp(row, cur);
      box.appendChild(row);
    }
    modusAusSchritt();
    if (!ui.achse || (ui.achse.quelle !== 'markiert' && ui.achse.quelle !== 'abgeleitet')) ui.achse = a.achse || ui.achse;
    if (ui.achse && ui.achse.p0) {
      const y = (ui.achse.p0[1] + ui.achse.p1[1]) / 2;
      if (Math.abs(ui.achse.p0[1] - ui.achse.p1[1]) <= Math.abs(ui.achse.p0[0] - ui.achse.p1[0]) + 0.5) $('#av-achse').value = y.toFixed(2);
    }
    const namen = { mittellinie: 'erkannte Mittellinie', markiert: 'angeklickte Linie', abgeleitet: 'Mitte aus zwei Linien', ansichtsmitte: 'Mitte der Ansicht' };
    $('#av-achse-src').textContent = ui.achse
      ? 'Wirkung: Rotationsachse ist die ' + (namen[ui.achse.quelle] || 'gesetzte Linie') + '. Violett gestrichelt.'
      : 'Wirkung: Noch keine Achse. Linie antippen oder zwei Kanten wählen, sonst wird nicht rotiert.';
    paint(a);
    zeichneOverlay();
    wirkung();
  }

  function syncOp(row, cur) {
    if (!row || !cur) return;
    const op = row.querySelector('[data-op]');
    const zeigen = cur.art === 'schnitt' || cur.schritt1;
    op.hidden = !zeigen;
    op.disabled = !zeigen;
  }
  function schritt1() {
    const a = ui.analyse;
    if (!a) return null;
    return (a.alle || []).find(v => ui.wahl[v.id] && ui.wahl[v.id].schritt1) || ansichtFuerBahn(a);
  }
  function modusAusSchritt() {
    const v = schritt1();
    const w = v && ui.wahl[v.id];
    const modus = w && w.op === 'drehen' ? 'drehen' : w && w.op === 'extrudieren' ? 'extrudieren' : (ui.analyse && ui.analyse.modus) || 'auto';
    const sel = $('#av-modus');
    if (sel) sel.value = modus === 'auto' ? 'auto' : modus;
    const block = $('#av-schritt-achse');
    if (block) block.classList.toggle('ruhig', modus !== 'drehen');
  }
  function seite() { const s = $('#av-seite'); return s ? s.value : 'auto'; }
  function wirkung() {
    const v = schritt1();
    const w = v && ui.wahl[v.id];
    const el = $('#av-schritt1');
    const h = $('#av-haelfte');
    if (!el || !v || !w) return;
    if (w.op === 'drehen') {
      el.textContent = 'Wirkung: „Schritt 1 erzeugen“ rotiert die grüne Hälfte von ' + v.id + ' um die violette Achse. Danach steht das Volumen in der Statuszeile. Vorher bleibt das 3D leer bzw. das alte Modell.';
      if (h) h.textContent = seite() === '-1' ? 'Die andere Seite der Achse wird zur Halbkontur.' : seite() === '1' ? 'Diese Seite der Achse wird zur Halbkontur.' : 'Die größere Hälfte neben der Achse wird rotiert.';
    } else {
      el.textContent = 'Wirkung: „Schritt 1 erzeugen“ extrudiert die ganze grüne Kontur von ' + v.id + '. Eine Mittellinie ist dafür nicht nötig. Das neue Volumen steht in der Statuszeile.';
      if (h) h.textContent = 'Extrudieren nutzt die volle Kontur, keine Halbkontur.';
    }
  }

  function zeichneOverlay() {
    const svg = $('#konturen');
    const a = ui.analyse;
    if (!svg || !a || !a.page_w) return;
    svg.querySelectorAll('[data-bahn],[data-ml],[data-halb]').forEach(n => n.remove());
    const ziel = schritt1() || ansichtFuerBahn(a);
    const poly = bahnAusAnsicht(ziel);
    const dreh = ziel && ui.wahl[ziel.id] && ui.wahl[ziel.id].op === 'drehen';
    const halb = dreh && ui.achse ? halbkontur(poly, ui.achse, seite()) : null;
    if (poly && poly.length >= 3) {
      const pl = document.createElementNS(NS, 'polyline');
      const ring = poly.concat([poly[0]]);
      pl.setAttribute('points', ring.map(p => `${p[0]},${a.page_h - p[1]}`).join(' '));
      pl.setAttribute('fill', halb ? 'none' : 'rgba(10,122,50,0.16)');
      pl.setAttribute('stroke', '#0a7a32');
      pl.setAttribute('stroke-width', halb ? '1.5' : '4');
      pl.setAttribute('stroke-dasharray', halb ? '4 3' : '');
      pl.setAttribute('vector-effect', 'non-scaling-stroke');
      pl.dataset.bahn = '1';
      svg.appendChild(pl);
    }
    if (halb && halb.poly.length >= 3) {
      const pl = document.createElementNS(NS, 'polygon');
      pl.setAttribute('points', halb.poly.map(p => `${p[0]},${a.page_h - p[1]}`).join(' '));
      pl.setAttribute('fill', 'rgba(10,122,50,0.45)');
      pl.setAttribute('stroke', '#0a7a32');
      pl.setAttribute('stroke-width', '3');
      pl.setAttribute('vector-effect', 'non-scaling-stroke');
      pl.dataset.halb = '1';
      svg.appendChild(pl);
    }
    const ax = ui.achse;
    if (ax && ax.p0 && ax.p1) {
      const ln = document.createElementNS(NS, 'line');
      ln.setAttribute('x1', ax.p0[0]); ln.setAttribute('y1', a.page_h - ax.p0[1]);
      ln.setAttribute('x2', ax.p1[0]); ln.setAttribute('y2', a.page_h - ax.p1[1]);
      ln.setAttribute('stroke', '#6c2bd9'); ln.setAttribute('stroke-width', '3');
      ln.setAttribute('stroke-dasharray', '8 4');
      ln.setAttribute('vector-effect', 'non-scaling-stroke');
      ln.dataset.ml = '1';
      svg.appendChild(ln);
    }
  }

  function setAxis(ax) {
    ui.achse = ax;
    if (ui.analyse) show(ui.analyse);
  }

  function rolleGesendet(v, w) {
    if (!w) return v.rolle;
    if (w.art === 'schnitt') return 'schnitt';
    if (w.art === 'einzelheit') return 'einzelheit';
    if (w.art === 'isometrie') return 'isometrie';
    if (w.art === 'ignorieren') return 'ignorieren';
    if (w.schritt1) return 'haupt';
    if (['rechts', 'links', 'oben', 'unten', 'abgeleitet', 'haupt'].includes(v.rolle)) return v.rolle;
    return 'abgeleitet';
  }

  function hinweis() {
    const a = ui.analyse;
    const ansichten = [];
    for (const v of (a && a.alle) || []) {
      const w = ui.wahl[v.id] || {};
      const rolle = rolleGesendet(v, w);
      ansichten.push({ id: v.id, rolle, nutzen: rolle !== 'ignorieren' && rolle !== 'isometrie', operation: w.op || 'extrudieren' });
    }
    const luecke = parseFloat(String($('#av-luecke').value).replace(',', '.'));
    const y = parseFloat(String($('#av-achse').value).replace(',', '.'));
    return {
      ansichten,
      modus: $('#av-modus').value,
      achse_y: isFinite(y) ? y : (ui.achse && ui.achse.p0 ? (ui.achse.p0[1] + ui.achse.p1[1]) / 2 : null),
      achse: ui.achse || null,
      luecke_mm: isFinite(luecke) ? luecke : 0.45,
      schliessen: !!$('#av-schliessen').checked,
      seite: seite(),
    };
  }

  function reset() {
    ui.analyse = null; ui.achse = null; ui.wahl = {};
    const el = panel();
    if (el) el.hidden = true;
    const box = list();
    if (box) box.innerHTML = '';
    document.querySelectorAll('.box.av').forEach(b => b.remove());
  }

  const achsen = api.achsen;
  if (achsen && $('#av-achse-mark')) {
    $('#av-achse-mark').onclick = () => { achsen.setMode('mark'); api.msg('Bestehende Linie oder Kurve als Mittellinie antippen.'); };
    $('#av-achse-zwei').onclick = () => { achsen.setMode('pair'); api.msg('Erste Linie antippen, danach die parallele Gegenkante.'); };
    achsen.on(ax => { if (ax) setAxis(ax); });
  }
  if ($('#av-seite')) $('#av-seite').onchange = () => { wirkung(); zeichneOverlay(); };
  $('#av-bauen').onclick = () => api.bauen(hinweis());
  $('#av-fit').onclick = () => {
    const h = hinweis();
    h.luecke_mm = Math.max(h.luecke_mm || 0.45, 0.8);
    $('#av-luecke').value = String(h.luecke_mm).replace('.', ',');
    api.erneut(h);
  };

  return { show, reset, hinweis, paint, setAxis };
}
