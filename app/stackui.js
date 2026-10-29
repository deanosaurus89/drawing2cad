// Feature-Stack in der Zeichnungsleiste: Status, Bestätigen, Überspringen, Rückgängig, 3D aktualisieren.
import { proposeStack, appliesStep, waitingSteps, needsDecision } from './core/stack.js';

const ROLLE = { blatt: 'Blatt', basis: 'Basis', add: 'Add', cut: 'Cut', einzelheit: 'Einzelheit', merkmal: 'Merkmal', hinweis: 'Hinweis' };

export function createStackUI(api) {
  const { $, call, state, status, msg, tab, busy } = api;
  const ui = { steps: [], proposal: null, bericht: [] };

  function live() { return api.live ? api.live() : null; }

  function materialize(step) {
    const L = live();
    const spec = JSON.parse(JSON.stringify(step.spec || {}));
    if (step.contourId && L && L.contour) {
      const c = L.contour(step.contourId);
      if (c && c.items) spec.items = c.items;
    }
    if (!L) return spec;
    if (spec.mode === 'drehen' || step.op === 'drehen') {
      spec.mode = 'drehen';
      if (L.axis) spec.axis = L.axis;
      if (L.scale > 0) spec.scale = L.scale;
      spec.side = L.side || spec.side || 'auto';
    }
    if (spec.mode === 'extrudieren' || step.op === 'extrudieren') {
      spec.mode = 'extrudieren';
      if (L.depth > 0) spec.depth = L.depth;
      if (L.dir) spec.dir = L.dir;
      if (L.scale > 0) spec.scale = L.scale;
    }
    return spec;
  }

  function badge(cls, text) { return `<span class="badge ${cls}">${text}</span>`; }

  function render() {
    const box = $('#stack-box'); const list = $('#stack-liste'); const conf = $('#stack-conf');
    if (!box || !list) return;
    if (!ui.proposal) { box.hidden = true; return; }
    box.hidden = false;
    const p = ui.proposal;
    conf.className = 'stack-conf ' + p.confidence;
    conf.textContent = 'Sicherheit gesamt: ' + p.confidence + ' – ' + p.grund;
    list.innerHTML = '';
    const scope = document.createElement('p');
    scope.className = 'leer';
    const hasBasis = ui.steps.some(s => s.rolle === 'basis' && s.op);
    scope.textContent = p.scope === 'nicht_unterstuetzt'
      ? 'Nicht unterstützt: nur prismatische und rotationssymmetrische Teile. Freiformflächen entfallen.'
      : !hasBasis
        ? 'Ohne Schnittkontur entsteht hier kein Volumen. Freiformflächen werden nicht modelliert. Die Automatik bleibt nutzbar.'
        : (p.scope === 'rotation' ? 'Rotationssymmetrisch: Basis durch Drehen, weitere Schnitte als Add oder Cut.' : 'Prismatisch: Basis durch Extrudieren, weitere Schnitte als Add oder Cut.');
    list.appendChild(scope);
    for (const s of ui.steps) {
      const el = document.createElement('div');
      const wait = needsDecision(s);
      const built = ui.bericht.find(b => b.id === s.id);
      el.className = 'stack-step' + (wait && s.confidence !== 'hoch' ? ' braucht' : '') + (s.angewendet ? ' immodell' : '');
      el.dataset.id = s.id;
      const stLabel = s.status === 'bestaetigt' ? 'bestätigt' : s.status === 'uebersprungen' ? 'übersprungen' : 'Vorschlag';
      const tag = appliesStep(s) && s.status === 'vorschlag' ? ' <span class="badge hoch">wird gebaut</span>' : (wait ? ' <span class="badge mittel">bitte bestätigen</span>' : '');
      const fail = built && built.ok === false ? `<p class="fehler">${built.text}</p>` : '';
      el.innerHTML = `<div>${badge(s.status, stLabel)}${badge(s.confidence, s.confidence)}${badge('rolle', ROLLE[s.rolle] || s.rolle)}${tag}</div>
        <b></b><p class="grund"></p>${fail}
        <div class="zeile">
          <button type="button" class="btn" data-act="ok">Bestätigen</button>
          <button type="button" class="btn" data-act="skip">Überspringen</button>
          <button type="button" class="btn" data-act="undo">Rückgängig</button>
        </div>`;
      el.querySelector('b').textContent = s.titel;
      el.querySelector('.grund').textContent = s.grund;
      const undo = el.querySelector('[data-act="undo"]');
      undo.disabled = s.status === 'vorschlag' && !s.angewendet && !s.zurueckgestellt;
      el.querySelector('[data-act="ok"]').onclick = () => confirm(s);
      el.querySelector('[data-act="skip"]').onclick = () => skip(s);
      undo.onclick = () => undoStep(s);
      el.addEventListener('click', ev => {
        if (ev.target.closest('button')) return;
        if (s.contourId && live()) live().select(s.contourId);
      });
      list.appendChild(el);
    }
  }

  function confirm(s) {
    s.status = 'bestaetigt';
    s.zurueckgestellt = false;
    if (!s.op && s.opWennBestaetigt) s.op = s.opWennBestaetigt;
    if (s.contourId && live()) live().select(s.contourId);
    render();
  }
  function skip(s) {
    const was = s.angewendet;
    s.status = 'uebersprungen';
    s.zurueckgestellt = false;
    render();
    if (was) update(true);
  }
  function undoStep(s) {
    const was = s.angewendet || s.status !== 'vorschlag';
    if (s.opWennBestaetigt && s.status === 'bestaetigt') s.op = null;
    s.status = 'vorschlag';
    s.zurueckgestellt = s.rolle === 'basis' && s.confidence === 'hoch';
    s.angewendet = false;
    render();
    if (was) update(true);
  }

  function onResult(res, opts = {}) {
    if (!res) { ui.proposal = null; ui.steps = []; render(); return; }
    if (!opts.fromSection) {
      ui.proposal = proposeStack(res);
      ui.steps = ui.proposal.schritte.map(s => ({ ...s, status: 'vorschlag', angewendet: false, zurueckgestellt: false }));
      ui.bericht = [];
    } else if (res.stack_bericht) {
      ui.bericht = res.stack_bericht;
      for (const s of ui.steps) {
        const b = ui.bericht.find(x => x.id === s.id);
        if (b) s.angewendet = !!b.ok;
      }
    }
    if (res.sicherheit && ui.proposal) {
      ui.proposal.confidence = res.sicherheit;
      if (res.sicherheit_grund) ui.proposal.grund = res.sicherheit_grund;
    }
    render();
  }

  function focusWaiting() {
    const w = waitingSteps(ui.steps)[0];
    if (!w) return;
    const el = document.querySelector(`.stack-step[data-id="${w.id}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  async function update(fromUndo) {
    if (state.busy) return;
    const basis = ui.steps.find(s => s.rolle === 'basis' && s.op);
    const chosen = ui.steps.filter(appliesStep);
    if (!chosen.length || !chosen.some(s => s.rolle === 'basis')) {
      const grund = (basis && basis.grund) || (ui.proposal && ui.proposal.grund) || 'Kein Schritt ist bestätigt.';
      if (fromUndo && api.restore) { api.restore(); status('Basis zurückgenommen. Automatische Rekonstruktion wiederhergestellt.'); return; }
      msg('Feature-Stack: nichts gebaut. ' + grund, true);
      status('Bitte den Hauptschnitt bestätigen.');
      focusWaiting();
      if (basis) {
        const el = document.querySelector('.stack-step[data-id="' + basis.id + '"]');
        if (el) el.classList.add('braucht');
      }
      return;
    }
    const L = live();
    if (L && !(L.scale > 0)) { msg('Maßstab ungültig. Beispiel: 1:1 oder 2:1.', true); return; }
    const base = chosen.find(s => s.rolle === 'basis');
    if (base && base.op === 'extrudieren' && !(L && L.depth > 0) && !(base.spec && base.spec.depth > 0)) {
      msg('Extrusionstiefe fehlt. Wert eintragen und den Schritt bestätigen.', true);
      return;
    }
    busy(true); window.__ready = false; $('#meldungen').innerHTML = '';
    const t0 = performance.now();
    const dims = (state.auto && state.auto.result && state.auto.result.masse) || (state.result && state.result.masse) || [];
    try {
      const payload = {
        steps: chosen.map(s => ({ id: s.id, op: s.op, titel: s.titel, rolle: s.rolle, spec: materialize(s) })),
        dims, sicherheit: ui.proposal.confidence, sicherheit_grund: ui.proposal.grund,
      };
      const r = await call({ type: 'feature_stack', spec: payload });
      const prev = state.result || {};
      const keep = state.auto && state.auto.result ? state.auto.result : prev;
      Object.assign(r.result, {
        ansichten: keep.ansichten, schnitte: keep.schnitte, einzelheiten: keep.einzelheiten,
        schnitt_konturen: keep.schnitt_konturen, schnitt_tiefe: keep.schnitt_tiefe,
        page_w: keep.page_w, page_h: keep.page_h, quelle: keep.quelle || r.result.quelle,
        massstab_quelle: keep.massstab_quelle, massstab_schriftfeld: keep.massstab_schriftfeld,
        texte: keep.texte, teil_typ: r.result.teil_typ || keep.teil_typ,
      });
      if (!r.result.masse || !r.result.masse.length) r.result.masse = dims;
      ui.bericht = r.result.stack_bericht || [];
      for (const s of ui.steps) {
        const b = ui.bericht.find(x => x.id === s.id);
        s.angewendet = !!(b && b.ok);
      }
      api.zeige(r, state.file ? state.file.name : '', performance.now() - t0, { fromSection: true });
      const wait = waitingSteps(ui.steps);
      const failed = ui.bericht.filter(b => b.ok === false);
      let line = `Feature-Stack: ${r.result.volumen_mm3.toLocaleString('de-DE')} mm³`;
      if (wait.length) line += `. ${wait.length} Schritt(e) warten auf Bestätigung.`;
      if (failed.length) line += ` ${failed.length} Schritt(e) nicht angewendet.`;
      status(line);
      if (wait.length && !fromUndo) msg('Nicht angewendet, bitte bestätigen oder überspringen: ' + wait.map(s => s.titel).join(', ') + '.', false);
      focusWaiting();
      if (matchMedia('(max-width: 899px)').matches) tab('3d');
    } catch (e) { api.fehler(e); window.__ready = true; }
    finally { busy(false); render(); }
  }

  const btn = $('#sk-stack');
  if (btn) btn.onclick = () => update(false);

  return {
    onResult, update, render,
    steps: () => ui.steps.map(s => ({ id: s.id, rolle: s.rolle, op: s.op, status: s.status, confidence: s.confidence, angewendet: !!s.angewendet, titel: s.titel })),
    proposal: () => ui.proposal,
  };
}
