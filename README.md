# drawing2cad – Zeichnung → 3D-CAD

Web-App (deutsch) für technische Zeichnungen von Maschinenbauteilen (Dreh- und prismatische Teile). Sie erzeugt daraus B-Rep-Volumenmodelle mit Ebenen, Zylindern, Kegeln, Tori und Spline-Flächen.

**Live (ohne Server, läuft komplett im Browser, auch auf dem Smartphone): https://deanosaurus89.github.io/drawing2cad/**

## Web-App (`index.html`, `app/`)
Die App läuft vollständig im Browser, es gibt kein Backend. Hochgeladene Dateien verlassen das Gerät nicht.
- **Eingaben:**
  - Vektor-PDF über pdf.js: Operatorliste mit Pfaden, Strichstärken und Strichmustern sowie Textinhalt.
  - Gescanntes PDF (wird gerastert), PNG, JPG und TIFF (UTIF).
  - Kamera-Foto (`capture`).
  - Rasterbilder durchlaufen eine eigene Bildverarbeitung in JS:
    - Binarisierung, Morphologie über Distanztransformation;
    - Skelett, Konturen und Kreis-/Linien-Fits;
    - Strichlinien-Erkennung.
  - Danach folgt OCR mit tesseract.js (deu+eng). Sie wird erst bei Bedarf vom CDN geladen.
- **CAD-Kern:** replicad 1.1.0 + OpenCascade (WASM, 23 MB) in einem Web Worker.
  - Drehteile entstehen durch Rotation.
  - Prismatische Teile entstehen durch Extrusion und Verschneidung der Ansichten. Bohrungen, Taschen und Fasen werden als Schnitte ausgeführt.
- **Maße:** Die Maßtabelle ist editierbar. „Modell neu erzeugen“ berechnet das Modell parametrisch neu (Strecken/Verschieben, Ø, R, TK, Fase).
- **3D-Ansicht** (three.js):
  - Drehen, Verschieben und Zoomen mit Maus oder Touch (1 Finger drehen, 2 Finger zoomen/verschieben).
  - ViewCube: Flächen, Kanten und Ecken lassen sich anklicken bzw. antippen.
  - „Alles“ passt die Ansicht ein.
  - Flächen werden nach Typ eingefärbt.
  - Flächen und Kanten lassen sich antippen; angezeigt werden Typ und Parameter.
- **PMI:**
  - Jedes Maß wird als PMI-Element mit Bezug auf B-Rep-Flächen (stabile `sid`) angelegt.
  - In der 3D-Ansicht erscheint es als Beschriftung mit Hinweislinie.
  - Bei Auswahl werden die bezogenen Flächen hervorgehoben.
  - Export als JSON.
- **Export:**
  - STEP mit wählbarem Schema: AP214 (Standard), AP203 oder AP242. Geschrieben wird mit dem OCCT-STEP-Writer.
  - STL.
- **Mobil:**
  - Unter 900 px Breite gibt es Reiter (Zeichnung / 3D / Maße / Info) und große Bedienflächen.
  - Rasterbilder werden mit 200 dpi / max. 8 MPixel verarbeitet. Schlägt das fehl, folgt automatisch ein zweiter Versuch mit 300 dpi.
  - Am Desktop wird mit 300 dpi gearbeitet; der Rückfall erfolgt auf 200 dpi.
- **Beispiele** (`beispiele/`):
  - 5 Vektor-PDFs: Flansch, Welle, Halteplatte, Winkel, Stufenblock.
  - Dieselben 5 Teile als Scans (PNG ohne DPI, TIFF, Scan-PDF, JPG ohne DPI, TIFF).
- **Lokal starten:** `python -m http.server 8000` im Repo-Ordner ausführen, dann `http://localhost:8000/` öffnen. ES-Module und WASM funktionieren nicht über `file://`.
- **Test:** `python tests/test_web.py [URL]`. Der Test läuft in Headless Chrome am Desktop und als iPhone 390×844 mit Touch. Er prüft:
  - alle 10 Beispiele, mit Volumenvergleich gegen das Python-Backend;
  - den STEP-Reimport mit CadQuery;
  - die drei STEP-Schemata;
  - den ViewCube (Flächen, Kanten, Ecken);
  - eine Maßänderung;
  - die Konsolenfehler.

  Screenshots landen in `screenshots/web_*.png`.

### Unterschiede zur Python-Version (`python/`)
- Es gibt keinen GLB-Export und keine semantische AP242-PMI (XCAF) im STEP. Die PMI liegt als JSON vor.
- Bei AP242 wird nur das Schema gesetzt.
- Die Rasterpfade unterscheiden sich: OpenCV und Tesseract (nativ) in Python, eigene JS-Bildverarbeitung und tesseract.js im Browser. Dadurch entstehen leicht andere Konturen; die Volumen weichen um etwa 1 % ab.
- Bilder ohne DPI-Angabe: Die Auflösung wird über das DIN-A-Format der Bildgröße geschätzt und über den Schriftfeld-Maßstab und die Maßzahlen geprüft.

### Grenzen
- Fotos werden nicht perspektivisch entzerrt. Sie müssen frontal und gleichmäßig ausgeleuchtet sein.
- OCR übersieht gelegentlich Maßtexte. Bei Scans gibt es deshalb weniger PMI als bei Vektor-PDFs.
- Beim ersten Start werden rund 23 MB WASM geladen; danach liegen sie im Browser-Cache. Für OCR kommen etwa 15 MB Sprachdaten vom CDN dazu, also ist dafür Internet nötig.
- Sehr große Scans auf älteren Smartphones können am Speicher scheitern.

## Python-Version (`python/`)
Die ursprüngliche Server-Version (FastAPI, CadQuery, OpenCV, Tesseract) hat zusätzlich GLB-Export und STEP AP242 mit semantischer PMI.
- Start: `python/start.sh`, dann `http://localhost:8420` öffnen.
- Test: `python python/screenshot.py`.

## Start in GitHub Codespaces
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/deanosaurus89/drawing2cad?quickstart=1)

Nach dem ersten Aufbau (einige Minuten) startet der Server automatisch auf Port 8420 und öffnet sich im Browser. Falls nicht: `python/start.sh` im Terminal ausführen und im Tab „Ports“ Port 8420 öffnen.

## Browser-Test ohne Backend (`browser/test-browser-cad.html`)
Eine einzelne HTML-Seite (deutsch), die replicad 1.1.0 + `replicad-opencascadejs` 1.1.0 (OpenCascade als WASM) im Browser lädt. Sie erzeugt eine Platte 80×50×10 mit Bohrung Ø12, zeigt sie mit three.js an und exportiert sie als STEP. Danach liest sie `FILE_SCHEMA` aus dem STEP-Header und zeigt es an.

- Laden: Standard ist das CDN (jsDelivr). Mit `?quelle=lokal` kommen die Dateien aus `vendor/` (replicad.js, replicad_single.js/.wasm (23 MB), three.module.js).
- Starten:
  - Per Doppelklick (`file://`) funktioniert nur die CDN-Variante (Internet nötig). Die lokale Variante wird von Chrome blockiert, weil Chrome keine ES-Module von `file://` lädt (CORS, Origin `null`).
  - Offline bzw. lokal: im Repo-Stammordner `python -m http.server 8000` ausführen und `http://localhost:8000/browser/test-browser-cad.html?quelle=lokal` öffnen.
- STEP-Schema:
  - `shape.blobSTEP()` von replicad setzt fest `write.step.schema = 5` und schreibt damit `AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF {1 0 10303 442 1 1 4 }`. Das lässt sich von außen nicht ändern.
  - Die Seite nutzt deshalb für AP203/AP214/AP242 einen eigenen `oc.STEPControl_Writer` nach `oc.Interface_Static.SetCVal("write.step.schema", "AP203" | "AP214IS" | "AP242DIS")`. Ergebnis: `CONFIG_CONTROL_DESIGN` bzw. `AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }`.
- Test: `python browser/test_browser.py [Pages-URL]` prüft file:// und http://, jeweils mit CDN und lokal, und importiert alle STEP-Dateien mit CadQuery neu. Ergebnis: alle sind gültige Solids mit 38869,0 mm³ und 7 Flächen.
