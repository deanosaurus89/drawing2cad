// Version und „Neu in dieser Version“. version.json im Stamm muss version und date von BUILD entsprechen.
export const BUILD = { version: '2026.0.5', date: '2026-10-29' };

/** Neueste Fassung zuerst. Kurz halten: Dialog nach einem Versionswechsel und über „Neuigkeiten“. */
export const CHANGELOG = [
  { version: '2026.0.5', date: '2026-10-29', items: [
    'Mittellinie: Strichlinie und aufgelöste Kurz-lang-Folge werden erkannt.',
    'Fehlte die Erkennung, eine bestehende Linie antippen. Ohne Mittellinie zwei Kanten wählen, die Achse liegt dazwischen.',
    'Dieselbe Mittellinie gilt für Drehen und fürs Ergänzen einer Halbkontur beim Extrudieren.',
    'Die verwendete Bahn ist in der Zeichnung grün, die Mittellinie violett gestrichelt.',
  ] },
  { version: '2026.0.4', date: '2026-10-29', items: [
    'Trainingspaare von Martin: acht Zeichnungen im Menü, STEP/IGES unter beispiele/train/cad zum Vergleich.',
    'Körperkanten: einzelne sehr dicke Striche verdecken nicht mehr die 0,35-mm-Linie. „Keine Ansichten“ nur noch, wenn wirklich keine Gruppe da ist.',
    'Ansichten: Haupt, abgeleitet, Schnitt, Einzelheit, Isometrie nur zur Orientierung. Bei Unsicherheit erst bestätigen, dann 3D.',
    'Linienzüge werden zu Geraden, Kreisbögen und Kreisen. Lücke und „Kontur schließen“ sind einstellbar. Drehen oder Extrudieren, Achse auch ohne Mittellinie.',
    'Prüfmerkmale: Nennmaß, Toleranz, GD&T und Prüfmaß. Neues Projekt leert Modell, Stack, PMI, Maße und Meldungen.',
    '3D-PMI: Maßlinien in eigenen Bahnen, Texte weichen in mehrere Richtungen aus.',
  ] },
  { version: '2026.0.3', date: '2026-10-29', items: [
    'Testliste: feste Leiste mit großem „Schließen“ und „← Zurück zur App“. Esc geht zurück, sonst zur App.',
    'Feature-Stack: Basis aus bestätigtem Hauptschnitt (Drehen oder Extrudieren), weitere Schnitte als Add/Cut, Einzelheiten und Fasen nur nach Bestätigung.',
    'Sicherheit je Schritt und gesamt (hoch, mittel, niedrig). Bei niedriger Sicherheit wird nichts still gebaut.',
    '3D-PMI: Maßtext parallel zur Kamera, Abstände mit Maßlinie und Pfeilen, Staffelung, Zoom zeigt die Toleranz, Klick hebt Bezüge und Linie hervor.',
    'Nur prismatische und rotationssymmetrische Teile. Freiformflächen sind als nicht unterstützt gekennzeichnet.',
  ] },
  { version: '2026.0.2', date: '2026-10-28', items: [
    'Halbautomatische Schnittkontur: farbige Vorschläge auf der Zeichnung, Kontur bestätigen, Achse und Maßstab prüfen.',
    '3D aus Schnitt dreht die bestätigte Kontur. Bei Platten: Extrudieren (Tiefe aus der Nachbaransicht).',
    'Automatik stellt das bisherige Modell wieder her. Punkte der Kontur lassen sich schieben.',
    'Neuigkeiten zu dieser Version und eine Testliste (neuer Tab).',
  ] },
  { version: '2026.0.1', date: '2026-10-12', items: [
    'App nur im Browser: PDF, Scan und Foto werden auf dem Gerät zum Volumenmodell.',
    'Beispiele, STEP-Export (AP214, AP203, AP242), STL und PMI.',
    'ViewCube, Maße ändern, Schnitt- und Einzelheitenansichten.',
  ] },
];

const KEY = 'd2c-seen-version';

export function versionText() {
  return `Version ${BUILD.version} · ${BUILD.date}`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function bindSwipe(box, close) {
  let y0 = -1, x0 = 0;
  box.addEventListener('touchstart', e => {
    const t = e.touches[0];
    if (!t || e.touches.length > 1) { y0 = -1; return; }
    const onHead = !!(e.target.closest && e.target.closest('.ov-top'));
    y0 = onHead || box.scrollTop <= 0 ? t.clientY : -1;
    x0 = t.clientX;
  }, { passive: true });
  box.addEventListener('touchend', e => {
    const t = e.changedTouches[0];
    if (y0 < 0 || !t) return;
    const dy = t.clientY - y0, dx = Math.abs(t.clientX - x0);
    y0 = -1;
    if (dy > 70 && dy > 1.5 * dx) close();
  }, { passive: true });
}

/** Dialog immer öffnen (Menü „Neuigkeiten“). */
export function showWhatsNew() {
  document.getElementById('whatsnew')?.remove();
  const el = document.createElement('div');
  el.id = 'whatsnew';
  el.innerHTML = `<div class="wn-box" role="dialog" aria-modal="true" aria-labelledby="wn-title">
    <div class="ov-top"><h3 id="wn-title">Neu in dieser Version</h3><button type="button" class="ov-x" data-x title="Schließen" aria-label="Schließen">✕</button></div>
    <p class="wn-note">Release Notes · ${esc(versionText())}</p>
    ${CHANGELOG.map(c => `<h4>${esc(c.version)} <span>· ${esc(c.date)}</span></h4><ul>${c.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`).join('')}
    <div class="zeile"><button type="button" class="btn primaer" data-ok>OK</button></div>
  </div>`;
  const close = () => { el.remove(); document.removeEventListener('keydown', onEsc, true); };
  const onEsc = e => {
    if (e.key !== 'Escape' || !el.isConnected) return;
    e.stopPropagation();
    close();
  };
  document.addEventListener('keydown', onEsc, true);
  el.querySelectorAll('[data-ok], [data-x]').forEach(b => { b.onclick = close; });
  el.addEventListener('pointerdown', e => { if (e.target === el) close(); });
  bindSwipe(el.querySelector('.wn-box'), close);
  document.body.appendChild(el);
  el.querySelector('[data-x]').focus();
}

/** Nur für wiederkehrende Nutzer, wenn die Version sich geändert hat. Erster Besuch schreibt nur den Schlüssel. */
export function maybeShowWhatsNew() {
  try {
    const seen = localStorage.getItem(KEY);
    localStorage.setItem(KEY, BUILD.version);
    if (seen && seen !== BUILD.version) showWhatsNew();
  } catch { /* Speicher gesperrt */ }
}
