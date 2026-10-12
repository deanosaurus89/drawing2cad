# Zeichnung → 3D-CAD

Web-App (deutsch), die technische Zeichnungen von Maschinenbauteilen (Dreh- und prismatische Teile) in B-Rep-Volumenmodelle umsetzt.

## Start
    ./start.sh            # http://localhost:8420

## Eingaben
- Vektor-PDF; Rasterbilder PNG/JPG/TIFF; gescannte (reine Bild-)PDFs. Bei Rastereingaben laufen eine OpenCV-Linienerkennung und Tesseract-OCR (deu+eng). Den Maßstab bestimmen die Maßzahlen. Ein Maßstab im Schriftfeld wird bevorzugt, wenn die Maßzahlen ihn bestätigen.
- Beispiele (`make_examples.py`): 01 Flansch, 02 Welle, 03 Halteplatte, 04 Winkel (L-Profil), 05 Stufenblock (Tasche, Sackloch). Unter `examples/raster/` liegen verrauschte 300-dpi-Scans davon.

## Funktionen
- Erkannt werden Maße: Länge, Ø, R, Fase (2×45°), Winkel und Toleranzen (±, ISO-Passung wie H7). Sie werden mit der Geometrie verknüpft und erscheinen in einer editierbaren Tabelle. „Modell neu berechnen“ erzeugt das Modell neu.
- Modellaufbau: Drehteile durch Rotation des Profils. Prismatische Teile entstehen, indem die Silhouetten aller Ansichten extrudiert und miteinander verschnitten werden. Bohrungen und Taschen werden als Schnitte ausgeführt; ihre Tiefe kommt aus den verdeckten Kanten (Erstwinkelprojektion, ISO).
- Viewer: ViewCube (Flächen, Kanten und Ecken anklickbar), Drehen/Verschieben/Zoomen, Einpassen, Anklicken einzelner Flächen und Kanten mit stabiler ID, PMI-Beschriftungen mit Hinweislinien.
- Export: STEP AP214 (`AUTOMOTIVE_DESIGN`), STL, GLB, `pmi.json` (PMI-Elemente → B-Rep-IDs), STEP AP242 mit semantischer PMI (XCAF-Bemaßungen).

## Tests
    python screenshot.py   # lädt alle 10 Beispiele headless, ViewCube/PMI/Maßänderung → screenshots/

## Grenzen
- Raster: OCR verfehlt gelegentlich Maßtexte (z. B. „Ø32H7“). Ohne Maßtext gilt das gemessene Maß, und es bleibt weniger PMI übrig. Tiefen aus verdeckten Kanten sind nur näherungsweise genau (z. B. 8,97 statt 10). Konturen können Splines oder Zusatzflächen enthalten. Der Winkel-Scan zeigt ein Artefakt an der Unterkante.
- Unterstützt wird nur die Erstwinkelprojektion. Drehteile müssen eine horizontale Achse haben. Freiformflächen werden nicht unterstützt.
- Die Wirkung einer Maßänderung wird heuristisch abgeleitet (Strecken/Verschieben). Taschen- und Tiefenmaße lassen sich nicht bearbeiten.
- Die stabilen IDs sind Hashes aus Typ, Parametern und Lage. Ändert sich die Geometrie, ändert sich auch die ID.
- Der Ordner `jobs/` wird nicht automatisch geleert.

## Start in GitHub Codespaces
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/deanosaurus89/drawing2cad?quickstart=1)

Nach dem ersten Aufbau (einige Minuten) startet der Server automatisch auf Port 8420 und öffnet sich im Browser. Falls nicht: `./start.sh` im Terminal ausführen und im Tab „Ports“ Port 8420 öffnen.

## Browser-Test ohne Backend (`browser/test-browser-cad.html`)
Eine einzelne HTML-Seite (deutsch), die replicad 1.1.0 + `replicad-opencascadejs` 1.1.0 (OpenCascade als WASM) im Browser lädt. Sie erzeugt eine Platte 80×50×10 mit Bohrung Ø12, zeigt sie mit three.js an und exportiert sie als STEP. Danach liest sie `FILE_SCHEMA` aus dem STEP-Header und zeigt es an.

- Laden: Standard ist das CDN (jsDelivr). Mit `?quelle=lokal` kommen die Dateien aus `browser/vendor/` (replicad.js, replicad_single.js/.wasm (23 MB), three.module.js).
- Starten:
  - Per Doppelklick (`file://`) funktioniert nur die CDN-Variante (Internet nötig). Die lokale Variante wird von Chrome blockiert, weil Chrome keine ES-Module von `file://` lädt (CORS, Origin `null`).
  - Offline bzw. lokal: im Repo-Stammordner `python -m http.server 8000` ausführen und `http://localhost:8000/browser/test-browser-cad.html?quelle=lokal` öffnen.
- STEP-Schema:
  - `shape.blobSTEP()` von replicad setzt fest `write.step.schema = 5` und schreibt damit `AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF {1 0 10303 442 1 1 4 }`. Das lässt sich von außen nicht ändern.
  - Die Seite nutzt deshalb für AP203/AP214/AP242 einen eigenen `oc.STEPControl_Writer` nach `oc.Interface_Static.SetCVal("write.step.schema", "AP203" | "AP214IS" | "AP242DIS")`. Ergebnis: `CONFIG_CONTROL_DESIGN` bzw. `AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }`.
- Test: `python browser/test_browser.py [Pages-URL]` prüft file:// und http://, jeweils mit CDN und lokal, und importiert alle STEP-Dateien mit CadQuery neu. Ergebnis: alle sind gültige Solids mit 38869,0 mm³ und 7 Flächen.
