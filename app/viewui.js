// Ansichtsliste: Rollen bestätigen, Drehen/Extrudieren, Achse, Linienzüge fitten.
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
  const ui = { analyse: null };

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
    if (a.achse_y != null) $('#av-achse').value = String(Math.round(a.achse_y * 10) / 10).replace('.', ',');
    $('#av-achse-src').textContent = a.achse_quelle === 'mittellinie' ? 'Achse aus der Mittellinie.' : 'Achse in der Mitte der Hauptansicht (Mittellinie darf fehlen).';
    toggleAchse();
    paint(a);
  }

  function toggleAchse() {
    const dreh = $('#av-modus').value === 'drehen';
    $('#av-achse-block').hidden = !dreh;
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
      achse_y: isFinite(y) ? y : null,
      luecke_mm: isFinite(luecke) ? luecke : 0.45,
      schliessen: !!$('#av-schliessen').checked,
    };
  }

  function reset() {
    ui.analyse = null;
    const el = panel();
    if (el) el.hidden = true;
    const box = list();
    if (box) box.innerHTML = '';
    document.querySelectorAll('.box.av').forEach(b => b.remove());
  }

  $('#av-modus').onchange = toggleAchse;
  $('#av-bauen').onclick = () => api.bauen(hinweis());
  $('#av-fit').onclick = () => {
    const h = hinweis();
    h.luecke_mm = Math.max(h.luecke_mm || 0.45, 0.8);
    $('#av-luecke').value = String(h.luecke_mm).replace('.', ',');
    api.erneut(h);
  };

  return { show, reset, hinweis, paint };
}
