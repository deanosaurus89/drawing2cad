// Schnittkontur bestätigen: Overlay, Achse/Tiefe, Maßstab, Neuaufbau.
import { revolveProfile, itemsFromPoly, parseScaleText, fmtScale } from './core/sections.js';

const clone = o => JSON.parse(JSON.stringify(o));
const NS = 'http://www.w3.org/2000/svg';

export function createSectionUI(api) {
  const { $, call, state, status, msg, tab, busy } = api;
  const ui = { contours: [], rejected: new Set(), selected: null, editing: false, picking: 0, side: 'auto', axis: null, axisDirty: false, drag: null };
  const panel = () => $('#schnitt-panel');
  const blatt = () => $('#blatt');
  const pageOf = () => state.result && state.result.page_w ? { w: state.result.page_w, h: state.result.page_h } : null;

  function current() { return ui.contours.find(c => c.id === ui.selected) || null; }
  function mode() { return $('#sk-art').value; }
  function scale() { return parseScaleText($('#sk-scale').value, state.result ? state.result.massstab : 1); }
  function visible() { return ui.contours.filter(c => !ui.rejected.has(c.id)); }

  function toSheet(ev) {
    const host = blatt(); const page = pageOf(); if (!host || !page) return [0, 0];
    const r = host.getBoundingClientRect();
    const x = (ev.clientX - r.left) / Math.max(r.width, 1) * page.w;
    const y = page.h - (ev.clientY - r.top) / Math.max(r.height, 1) * page.h;
    return [x, y];
  }
  function styleOf(c) {
    const proposal = !!c.vorschlag;
    const fill = proposal ? 'rgba(12,140,78,0.55)' : c.schraffur ? 'rgba(230,126,34,0.45)' : 'rgba(142,68,173,0.40)';
    const stroke = proposal ? '#087443' : c.schraffur ? '#c0392b' : '#6c3483';
    return { fill, stroke, width: c.id === ui.selected ? 6 : 4 };
  }
  function axisHorizontal() {
    if (!ui.axis) return false;
    return Math.abs(ui.axis.p0[1] - ui.axis.p1[1]) < 0.8;
  }
  function nudge(delta) {
    if (!ui.axis) return;
    const dx = ui.axis.p1[0] - ui.axis.p0[0], dy = ui.axis.p1[1] - ui.axis.p0[1];
    const L = Math.hypot(dx, dy) || 1; const nx = -dy / L, ny = dx / L;
    ui.axis.p0 = [ui.axis.p0[0] + nx * delta, ui.axis.p0[1] + ny * delta];
    ui.axis.p1 = [ui.axis.p1[0] + nx * delta, ui.axis.p1[1] + ny * delta];
    ui.axis.quelle = 'manuell'; ui.axisDirty = true;
  }

  function select(id) {
    ui.selected = id;
    const c = current();
    if (c && !ui.axisDirty) ui.axis = clone(c.achse);
    render();
  }

  function render() {
    const host = blatt(); const svg = $('#konturen'); const page = pageOf();
    const list = $('#schnitt-liste'); if (list) list.innerHTML = '';
    if (!host || !svg || !page || !ui.contours.length) {
      if (svg) svg.replaceChildren();
      const g = $('#griffe'); if (g) g.replaceChildren();
      if (panel()) panel().hidden = true;
      return;
    }
    panel().hidden = false;
    $('#sk-achse-block').hidden = mode() !== 'drehen';
    $('#sk-extr-block').hidden = mode() !== 'extrudieren';
    $('#sk-punkt').hidden = !ui.editing;
    $('#sk-edit').textContent = ui.editing ? 'Punkte fertig' : 'Punkte schieben';
    const src = (state.result && state.result.massstab_quelle) || '';
    const srcEl = $('#sk-scale-src'); srcEl.textContent = src ? 'Erkannt: ' + src : '';
    $('#sk-scale').classList.toggle('warn', /WARNUNG|Annahme|nicht sicher/i.test(src));
    const nZero = ui.contours.filter(c => !c.schraffur).length;
    $('#schnitt-hinweis').textContent = 'Grün ist der Vorschlag (meiste Schraffur in der Schnittansicht). '
      + (nZero ? nZero + ' weitere Bahn(en) ohne Schraffur – oft die Bohrung oder ein Einstich, nicht das Material. ' : '')
      + 'Antippen wählt die Kontur. Danach Achse oder Extrusion und den Maßstab prüfen.';
    const info = $('#sk-achse-info');
    if (ui.picking === 1) info.textContent = 'Ersten Achsenpunkt auf der Zeichnung antippen.';
    else if (ui.picking === 2) info.textContent = 'Zweiten Achsenpunkt antippen.';
    else if (ui.axis) {
      const q = ui.axis.quelle === 'mittellinie' ? 'Mittellinie' : ui.axis.quelle === 'symmetrie' ? 'Symmetrie der Drehachse' : ui.axis.quelle === 'ansichtsmitte' ? 'Mitte der Ansicht' : 'von Hand gesetzt';
      info.textContent = 'Rotationsachse: ' + q + '.';
    }
    const yLabel = $('#sk-achse-y-label');
    if (axisHorizontal() && !ui.picking) {
      yLabel.hidden = false;
      const inp = $('#sk-achse-y');
      if (document.activeElement !== inp) inp.value = String(+(((ui.axis.p0[1] + ui.axis.p1[1]) / 2).toFixed(2)));
    } else yLabel.hidden = true;

    svg.setAttribute('viewBox', `0 0 ${page.w} ${page.h}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.replaceChildren();
    if (ui.picking) {
      const bg = document.createElementNS(NS, 'rect');
      bg.setAttribute('class', 'pick'); bg.setAttribute('x', '0'); bg.setAttribute('y', '0');
      bg.setAttribute('width', page.w); bg.setAttribute('height', page.h); bg.setAttribute('fill', 'rgba(108,43,217,0.06)');
      svg.appendChild(bg);
    }
    const order = visible().slice().sort((a, b) => (a.id === ui.selected) - (b.id === ui.selected) || (a.vorschlag - b.vorschlag));
    for (const c of order) {
      const st = styleOf(c);
      const poly = document.createElementNS(NS, 'polygon');
      poly.setAttribute('points', c.poly.map(p => `${p[0]},${page.h - p[1]}`).join(' '));
      poly.setAttribute('fill', st.fill); poly.setAttribute('stroke', st.stroke);
      poly.setAttribute('stroke-width', String(st.width));
      poly.setAttribute('vector-effect', 'non-scaling-stroke');
      poly.dataset.id = c.id;
      svg.appendChild(poly);
    }
    if (mode() === 'drehen' && ui.axis) {
      const ln = document.createElementNS(NS, 'line');
      ln.setAttribute('x1', ui.axis.p0[0]); ln.setAttribute('y1', page.h - ui.axis.p0[1]);
      ln.setAttribute('x2', ui.axis.p1[0]); ln.setAttribute('y2', page.h - ui.axis.p1[1]);
      ln.setAttribute('stroke', '#6c2bd9'); ln.setAttribute('stroke-width', '3'); ln.setAttribute('stroke-dasharray', '7 4');
      ln.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.appendChild(ln);
    }
    const g = $('#griffe'); g.replaceChildren();
    if (mode() === 'drehen' && ui.axis && !ui.picking) {
      for (const [i, p] of [[0, ui.axis.p0], [1, ui.axis.p1]]) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'griff achse'; b.title = 'Achsenende ziehen';
        b.dataset.kind = 'axis'; b.dataset.i = String(i);
        b.style.left = (p[0] / page.w * 100) + '%'; b.style.top = ((page.h - p[1]) / page.h * 100) + '%';
        b.addEventListener('pointerdown', onHandleDown);
        g.appendChild(b);
      }
    }
    const sel = current();
    if (ui.editing && sel && !ui.rejected.has(sel.id)) {
      sel.poly.forEach((p, i) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'griff punkt'; b.title = 'Konturpunkt ziehen';
        b.dataset.kind = 'vertex'; b.dataset.i = String(i);
        b.style.left = (p[0] / page.w * 100) + '%'; b.style.top = ((page.h - p[1]) / page.h * 100) + '%';
        b.addEventListener('pointerdown', onHandleDown);
        g.appendChild(b);
      });
    }

    const sc = scale();
    for (const c of ui.contours) {
      if (ui.rejected.has(c.id)) continue;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn' + (c.id === ui.selected ? ' aktiv' : '');
      const sw = styleOf(c);
      let est = '';
      if (mode() === 'drehen' && ui.axis && sc > 0) {
        try {
          const items = c.edited ? itemsFromPoly(c.poly) : c.items;
          const vol = revolveProfile(items, ui.axis, sc, ui.side).volume;
          est = ` · ca. ${Math.round(vol).toLocaleString('de-DE')} mm³`;
        } catch (e) { est = ''; }
      }
      const name = c.buchstabe ? `Schnitt ${c.buchstabe}-${c.buchstabe}` : 'Schnitt';
      const tag = c.vorschlag ? 'Vorschlag' : (c.schraffur ? 'Alternative' : 'ohne Schraffur');
      b.innerHTML = `<i style="background:${sw.stroke}"></i>${name} · ${tag} · ${c.flaeche.toLocaleString('de-DE')} mm² · ${c.schraffur} Schraffur${est}`;
      b.onclick = () => select(c.id);
      list.appendChild(b);
    }
  }

  function onHandleDown(ev) {
    ev.preventDefault(); ev.stopPropagation();
    ui.drag = { kind: ev.currentTarget.dataset.kind, i: +ev.currentTarget.dataset.i, pointer: ev.pointerId };
    ev.currentTarget.setPointerCapture(ev.pointerId);
    ev.currentTarget.addEventListener('pointermove', onHandleMove);
    ev.currentTarget.addEventListener('pointerup', onHandleUp);
    ev.currentTarget.addEventListener('pointercancel', onHandleUp);
  }
  function onHandleMove(ev) {
    if (!ui.drag || ev.pointerId !== ui.drag.pointer) return;
    const p = toSheet(ev);
    if (ui.drag.kind === 'axis') {
      if (ui.drag.i === 0) ui.axis.p0 = p; else ui.axis.p1 = p;
      ui.axis.quelle = 'manuell'; ui.axisDirty = true;
    } else if (ui.drag.kind === 'vertex') {
      const c = current(); if (!c) return;
      c.poly[ui.drag.i] = [+p[0].toFixed(3), +p[1].toFixed(3)];
      c.edited = true;
    }
    const page = pageOf(); const el = ev.currentTarget;
    if (page) { el.style.left = (p[0] / page.w * 100) + '%'; el.style.top = ((page.h - p[1]) / page.h * 100) + '%'; }
    if (ui.drag.kind === 'axis') {
      const ln = $('#konturen line');
      if (ln && ui.axis) {
        ln.setAttribute('x1', ui.axis.p0[0]); ln.setAttribute('y1', page.h - ui.axis.p0[1]);
        ln.setAttribute('x2', ui.axis.p1[0]); ln.setAttribute('y2', page.h - ui.axis.p1[1]);
      }
    } else {
      const c = current(); const polys = $('#konturen').querySelectorAll('polygon');
      for (const poly of polys) if (poly.dataset.id === c.id) poly.setAttribute('points', c.poly.map(q => `${q[0]},${page.h - q[1]}`).join(' '));
    }
  }
  function onHandleUp(ev) {
    ev.currentTarget.removeEventListener('pointermove', onHandleMove);
    ev.currentTarget.removeEventListener('pointerup', onHandleUp);
    ev.currentTarget.removeEventListener('pointercancel', onHandleUp);
    ui.drag = null; render();
  }

  function onSvgDown(ev) {
    if (!ui.picking) {
      const id = ev.target && ev.target.dataset && ev.target.dataset.id;
      if (id && !ui.rejected.has(id)) select(id);
      return;
    }
    const p = [+toSheet(ev)[0].toFixed(3), +toSheet(ev)[1].toFixed(3)];
    if (ui.picking === 1) {
      const p1 = ui.axis ? ui.axis.p1 : [p[0] + 20, p[1]];
      ui.axis = { p0: p, p1, quelle: 'manuell' }; ui.picking = 2;
    } else {
      ui.axis.p1 = p; ui.axis.quelle = 'manuell'; ui.picking = 0; ui.axisDirty = true;
    }
    render();
  }

  function onResult(res, opts = {}) {
    if (!opts.fromSection) {
      ui.contours = (res.schnitt_konturen || []).map(c => ({ ...clone(c), baseItems: clone(c.items), basePoly: clone(c.poly), edited: false }));
      ui.rejected = new Set(); ui.editing = false; ui.picking = 0; ui.side = 'auto'; ui.axisDirty = false;
      const prop = ui.contours.find(c => c.vorschlag) || ui.contours[0];
      ui.selected = prop ? prop.id : null;
      ui.axis = prop ? clone(prop.achse) : null;
      $('#sk-art').value = res.teil_typ === 'prisma' ? 'extrudieren' : 'drehen';
      $('#sk-scale').value = fmtScale(res.massstab || 1);
      if (res.schnitt_tiefe) $('#sk-tiefe').value = String(res.schnitt_tiefe);
    }
    render();
  }

  async function build(id) {
    if (state.busy) return;
    if (id) { ui.axisDirty = false; select(id); }
    const c = current();
    if (!c) { msg('Keine Schnittkontur gewählt.', true); return; }
    const sc = scale();
    if (!(sc > 0)) { msg('Maßstab ungültig. Beispiel: 1:1 oder 2:1.', true); return; }
    const depth = parseFloat(String($('#sk-tiefe').value).replace(',', '.'));
    busy(true); window.__ready = false; $('#meldungen').innerHTML = '';
    const t0 = performance.now();
    try {
      const spec = {
        items: c.edited ? itemsFromPoly(c.poly) : c.items,
        mode: mode(), axis: ui.axis, scale: sc, side: ui.side,
        depth, dir: $('#sk-dir').value,
        label: c.buchstabe ? `Schnitt ${c.buchstabe}-${c.buchstabe}` : 'Schnittkontur',
      };
      const r = await call({ type: 'section_model', spec });
      const prev = state.result || {};
      Object.assign(r.result, {
        ansichten: prev.ansichten, schnitte: prev.schnitte, einzelheiten: prev.einzelheiten,
        schnitt_konturen: prev.schnitt_konturen, schnitt_tiefe: prev.schnitt_tiefe,
        page_w: prev.page_w, page_h: prev.page_h, quelle: prev.quelle,
        massstab_quelle: prev.massstab_quelle, massstab_schriftfeld: prev.massstab_schriftfeld,
        texte: prev.texte, teil_typ: prev.teil_typ || r.result.teil_typ,
      });
      r.result.masse = []; r.result.pmi = [];
      api.zeige(r, state.file ? state.file.name : '', performance.now() - t0, { fromSection: true });
      status(`Schnittkontur bestätigt: ${r.result.volumen_mm3.toLocaleString('de-DE')} mm³`);
      if (matchMedia('(max-width: 899px)').matches) tab('3d');
    } catch (e) { api.fehler(e); window.__ready = true; }
    finally { busy(false); }
  }

  function restore() {
    const a = state.auto; if (!a) return;
    $('#meldungen').innerHTML = '';
    api.zeige({ result: a.result, mesh: a.mesh, edgeLines: a.edgeLines, edgeGroups: a.edgeGroups }, state.file ? state.file.name : '', 0);
    status('Automatische Rekonstruktion wiederhergestellt.');
  }

  const svg = () => $('#konturen');
  document.addEventListener('pointerdown', ev => {
    const s = svg(); if (s && (ev.target === s || s.contains(ev.target))) onSvgDown(ev);
  });
  $('#sk-art').onchange = () => render();
  $('#sk-edit').onclick = () => { ui.editing = !ui.editing; ui.picking = 0; render(); };
  $('#sk-punkt').onclick = () => {
    const c = current(); if (!c || c.poly.length < 2) return;
    let bi = 0, bd = -1;
    for (let i = 0; i < c.poly.length; i++) {
      const a = c.poly[i], b = c.poly[(i + 1) % c.poly.length];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (d > bd) { bd = d; bi = i; }
    }
    const a = c.poly[bi], b = c.poly[(bi + 1) % c.poly.length];
    c.poly.splice(bi + 1, 0, [+((a[0] + b[0]) / 2).toFixed(3), +((a[1] + b[1]) / 2).toFixed(3)]);
    c.edited = true; render();
  };
  $('#sk-reset').onclick = () => {
    ui.rejected = new Set(); ui.editing = false; ui.picking = 0; ui.side = 'auto'; ui.axisDirty = false;
    for (const c of ui.contours) { c.poly = clone(c.basePoly); c.items = clone(c.baseItems); c.edited = false; }
    const prop = ui.contours.find(c => c.vorschlag) || ui.contours[0];
    ui.selected = prop ? prop.id : null; ui.axis = prop ? clone(prop.achse) : null;
    if (state.result) { $('#sk-art').value = state.result.teil_typ === 'prisma' ? 'extrudieren' : 'drehen'; $('#sk-scale').value = fmtScale(state.result.massstab || 1); }
    render();
  };
  $('#sk-weg').onclick = () => {
    const c = current(); if (!c) return;
    ui.rejected.add(c.id);
    const nxt = visible()[0]; ui.selected = nxt ? nxt.id : null;
    if (nxt && !ui.axisDirty) ui.axis = clone(nxt.achse);
    render();
  };
  $('#sk-achse-hoch').onclick = () => { nudge(0.5); render(); };
  $('#sk-achse-runter').onclick = () => { nudge(-0.5); render(); };
  $('#sk-achse-tippen').onclick = () => { ui.picking = 1; ui.editing = false; render(); };
  $('#sk-achse-mitte').onclick = () => {
    const c = current(); if (!c) return;
    ui.axis = clone(c.achse); ui.axisDirty = false; ui.picking = 0; render();
  };
  $('#sk-seite').onclick = () => { ui.side = ui.side === 1 ? -1 : ui.side === -1 ? 'auto' : 1; render(); };
  $('#sk-achse-y').onchange = () => {
    const y = parseFloat($('#sk-achse-y').value.replace(',', '.')); if (!isFinite(y) || !ui.axis) return;
    ui.axis.p0 = [ui.axis.p0[0], y]; ui.axis.p1 = [ui.axis.p1[0], y]; ui.axis.quelle = 'manuell'; ui.axisDirty = true; render();
  };
  $('#sk-build').onclick = () => build();
  $('#sk-auto').onclick = restore;
  $('#sk-scale').addEventListener('change', () => render());

  return {
    onResult, build, restore, render,
    selectId: id => { ui.axisDirty = false; select(id); },
    candidates: () => ui.contours.map(c => ({ id: c.id, schraffur: c.schraffur, flaeche: c.flaeche, vorschlag: !!c.vorschlag, quelle: c.quelle, buchstabe: c.buchstabe, rejected: ui.rejected.has(c.id) })),
    selected: () => ui.selected,
  };
}
