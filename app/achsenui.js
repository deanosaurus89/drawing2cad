// Mittellinie nachträglich: eine Linie anklicken oder aus zwei Linien ableiten.
import { naechsteLinie, linienPool, axisFromPrim, axisBetween } from './core/mittellinie.js';

export function createAchsenUI({ $, state, msg }) {
  let mode = null;
  let first = null;
  let axis = null;
  const listeners = new Set();
  function emit() { for (const fn of listeners) fn(axis, mode, first); }

  function pageOf() {
    const a = state.analyse;
    const r = state.result;
    const w = (a && a.page_w) || (r && r.page_w);
    const h = (a && a.page_h) || (r && r.page_h);
    return w && h ? { w, h } : null;
  }
  function toSheet(ev) {
    const host = $('#blatt') || $('#vorschau');
    const page = pageOf();
    if (!host || !page) return null;
    const box = host.getBoundingClientRect();
    return [
      (ev.clientX - box.left) / Math.max(box.width, 1) * page.w,
      page.h - (ev.clientY - box.top) / Math.max(box.height, 1) * page.h,
    ];
  }

  document.addEventListener('pointerdown', ev => {
    if (!mode) return;
    if (ev.target.closest && ev.target.closest('button, input, select, a, textarea')) return;
    const host = $('#blatt') || $('#vorschau');
    if (!host || !host.contains(ev.target)) return;
    const p = toSheet(ev);
    if (!p) return;
    const hit = naechsteLinie(linienPool(state.analyse && state.analyse.dr), p, 2.8);
    if (!hit) { msg('Keine Linie an dieser Stelle. Eine bestehende Kante antippen.', true); return; }
    ev.preventDefault();
    ev.stopPropagation();
    if (mode === 'mark') {
      const ax = axisFromPrim(hit);
      mode = null; first = null;
      if (!ax) { msg('Diese Linie ist zu kurz für eine Mittellinie.', true); emit(); return; }
      axis = ax;
      msg('Mittellinie ist die angeklickte Linie.');
      emit();
      return;
    }
    if (!first) { first = hit; msg('Zweite Linie antippen. Sie soll zur ersten ungefähr parallel sein.'); emit(); return; }
    const ax = axisBetween(first, hit);
    mode = null; first = null;
    if (!ax) { msg('Daraus wird keine Mittellinie: die Linien sind nicht parallel genug.', true); emit(); return; }
    axis = ax;
    msg('Mittellinie liegt in der Mitte zwischen den beiden Linien.');
    emit();
  }, true);

  return {
    setMode(m) { mode = m; first = null; emit(); },
    setAxis(ax) { axis = ax || null; emit(); },
    on(fn) { listeners.add(fn); },
    get axis() { return axis; },
  };
}
