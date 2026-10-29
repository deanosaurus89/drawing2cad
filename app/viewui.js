// Ansichtsliste: Rollen bestätigen, Drehen/Extrudieren, Mittellinie, Linienzüge fitten.
import { bahnAusAnsicht, ansichtFuerBahn } from './core/mittellinie.js';
const NS = 'http://www.w3.org/2000/svg';
const ROLLEN = [
  ['haupt', 'Hauptansicht'],
  ['rechts', 'Abgeleitet rechts'],
  ['links', 'Abgeleitet links'],
  ['oben', 'Abgeleitet oben'],
  ['unten', 'Abgeleitet unten'],
  ['abgeleitet', 'Abgeleitet'],
  ['schnitt', 'Schnitt'],
  ['einzelheit', 'Einzelheit'],
  ['isometrie', 'Isometrie (nicht fürs Volumen)'],
  ['schriftfeld', 'Schriftfeld'],
  ['ignorieren', 'Ignorieren'],
];

export function createViewUI(api) {
  const { $ } = api;
  const ui = { analyse: null, achse: null };

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
    for (const v of a.alle) {
      const row = document.createElement('div');
      row.className = 'av-row';
      row.dataset.id = v.id;
      const nutzen = v.rolle !== 'isometrie' && v.rolle !== 'schriftfeld' && v.rolle !== 'ignorieren';
      const opts = ROLLEN.map(([k, n]) => `<option value="${k}"${k === v.rolle ? ' selected' : ''}>${n}</option>`).join('');
      row.innerHTML = `<label class="chk"><input type="checkbox" data-nutzen ${nutzen ? 'checked' : ''}> ${v.id}</label>
        <select data-rolle aria-label="Rolle ${v.id}">${opts}</select>
        <span class="leer">${Math.round(v.size[0])}×${Math.round(v.size[1])} mm</span>`;
      box.appendChild(row);
    }
    $('#av-modus').value = a.modus || (a.layout && a.layout.typ === 'dreh' ? 'drehen' : 'auto');
    if (!ui.achse || (ui.achse.quelle !== 'markiert' && ui.achse.quelle !== 'abgeleitet')) ui.achse = a.achse || ui.achse;
    if (ui.achse && ui.achse.p0) {
      const y = (ui.achse.p0[1] + ui.achse.p1[1]) / 2;
      if (Math.abs(ui.achse.p0[1] - ui.achse.p1[1]) <= Math.abs(ui.achse.p0[0] - ui.achse.p1[0]) + 0.5) $('#av-achse').value = y.toFixed(2);
    }
    const namen = { mittellinie: 'erkannte Mittellinie', markiert: 'angeklickte Linie', abgeleitet: 'Mitte aus zwei Linien', ansichtsmitte: 'Mitte der Ansicht' };
    $('#av-achse-src').textContent = ui.achse ? 'Mittellinie: ' + (namen[ui.achse.quelle] || ui.achse.quelle) + '.' : 'Noch keine Mittellinie. Linie antippen oder zwei Kanten wählen.';
    toggleAchse();
    paint(a);
    zeichneOverlay();
  }

  function zeichneOverlay() {
    const svg = $('#konturen');
    const a = ui.analyse;
    if (!svg || !a || !a.page_w) return;
    svg.querySelectorAll('[data-bahn],[data-ml]').forEach(n => n.remove());
    const poly = bahnAusAnsicht(ansichtFuerBahn(a));
    if (poly && poly.length >= 3) {
      const pl = document.createElementNS(NS, 'polyline');
      const ring = poly.concat([poly[0]]);
      pl.setAttribute('points', ring.map(p => `${p[0]},${a.page_h - p[1]}`).join(' '));
      pl.setAttribute('fill', 'rgba(10,122,50,0.16)');
      pl.setAttribute('stroke', '#0a7a32');
      pl.setAttribute('stroke-width', '4');
      pl.setAttribute('vector-effect', 'non-scaling-stroke');
      pl.dataset.bahn = '1';
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

  function toggleAchse() {
    $('#av-achse-block').hidden = false;
  }

  function hinweis() {
    const ansichten = [];
    list().querySelectorAll('.av-row').forEach(row => {
      ansichten.push({
        id: row.dataset.id,
        rolle: row.querySelector('[data-rolle]').value,
        nutzen: row.querySelector('[data-nutzen]').checked,
      });
    });
    const luecke = parseFloat(String($('#av-luecke').value).replace(',', '.'));
    const y = parseFloat(String($('#av-achse').value).replace(',', '.'));
    return {
      ansichten,
      modus: $('#av-modus').value,
      achse_y: isFinite(y) ? y : (ui.achse && ui.achse.p0 ? (ui.achse.p0[1] + ui.achse.p1[1]) / 2 : null),
      achse: ui.achse || null,
      luecke_mm: isFinite(luecke) ? luecke : 0.45,
      schliessen: !!$('#av-schliessen').checked,
    };
  }

  function reset() {
    ui.analyse = null; ui.achse = null;
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
  $('#av-modus').onchange = toggleAchse;
  $('#av-bauen').onclick = () => api.bauen(hinweis());
  $('#av-fit').onclick = () => {
    const h = hinweis();
    h.luecke_mm = Math.max(h.luecke_mm || 0.45, 0.8);
    $('#av-luecke').value = String(h.luecke_mm).replace('.', ',');
    api.erneut(h);
  };

  return { show, reset, hinweis, paint, setAxis };
}
