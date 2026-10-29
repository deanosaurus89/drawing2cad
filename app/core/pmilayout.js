// Bildschirm-Anordnung der PMI-Beschriftungen und Text je nach Zoom. Reines Layout, ohne three.js.

const fmt = x => (Math.round(x * 1000) / 1000).toString().replace('.', ',');
const sgn = x => (x >= 0 ? '+' : '') + fmt(x);

export function pmiPrefix(it) {
  if (!it) return '';
  if (it.typ === 'Durchmesser' || (it.typ || '').startsWith('Teilkreis')) return 'Ø';
  if (it.typ === 'Radius') return 'R';
  if (it.typ === 'Fase') return 'C';
  return '';
}

export function pmiNominal(it) {
  const pre = pmiPrefix(it);
  const unit = it.einheit === '°' ? '°' : '';
  return `${pre}${fmt(it.nennmass)}${unit}`;
}

export function pmiTolerance(it) {
  if (!it) return '';
  if (it.passung) return ' ' + it.passung;
  if (it.tol_oben == null || it.tol_unten == null) return '';
  if (Math.abs(it.tol_oben + it.tol_unten) < 1e-9) return ' ±' + fmt(it.tol_oben);
  return ' ' + sgn(it.tol_oben) + '/' + sgn(it.tol_unten);
}

/** Nah: Nennmaß mit Toleranz und Einheit. Fern: nur das Nennmaß. */
export function formatPmi(it, detail) {
  const nom = pmiNominal(it);
  if (!detail) return nom;
  const tol = pmiTolerance(it);
  if (!tol) return nom;
  const unit = it.einheit === '°' || it.passung ? '' : ' mm';
  return nom + tol + unit;
}

/**
 * Vermeidet überlappende Beschriftungen. boxes: { id, x, y, w, h }.
 * Verschiebt nach unten. ax/ay bleiben der ursprüngliche Anker für die Hinweislinie.
 */
export function staggerBoxes(boxes, gap = 6) {
  const placed = [];
  const sorted = (boxes || []).map(b => ({ ...b })).sort((a, b) => a.y - b.y || a.x - b.x);
  const out = [];
  for (const b of sorted) {
    const w = b.w || 48, h = b.h || 18;
    let y = b.y, n = 0;
    const hit = () => placed.some(p => Math.abs(p.x - b.x) < (p.w + w) / 2 + gap && Math.abs(p.y - y) < (p.h + h) / 2 + gap);
    while (hit() && n < 8) { y += h + gap; n++; }
    placed.push({ x: b.x, y, w, h });
    out.push({ id: b.id, x: b.x, y, shifted: n > 0, ax: b.x, ay: b.y });
  }
  return out;
}

/** true, wenn die Kamera nah genug für Toleranzen ist (dist < fit * schwelle). */
export function pmiDetail(dist, fitDist, ratio = 0.62) {
  if (!(dist > 0) || !(fitDist > 0)) return false;
  return dist < fitDist * ratio;
}
