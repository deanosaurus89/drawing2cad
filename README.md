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
  - Schnitt/Einzelheit: `06_buchse.pdf` (Vollschnitt A-A, Einzelheit Z (5:1) mit Freistich), `07_lagerplatte_schnitt.pdf` (Schnitt A-A mit Tasche T12 und Sackbohrung T18), dazu `r06`/`r07` als 200-dpi-Scans. Sollvolumen analytisch: `examples/sollwerte_schnitt.json`.
  - Reale Zeichnung: `real/xometry_lathe_sample.webp` (1492×1054 px ≈ 90 dpi, A3, 2:1, Drittwinkelprojektion, Schnitt A-A 1:1, Einzelheit C 4:1, blaue Prüf-Ballons). Referenz: handmodelliertes Teil `tests/ref_real.py`.
  - Reale Zeichnung A: `real/drehteil_rillen_4zu1.jpg` (1600×1131 px JPG, Schriftfeld „MASSTAB 4:1“, Schnitt mit Rillen/Senkung). Das Innenprofil der schraffierten Schnittfläche wird direkt als Pixelgebiet vektorisiert und rotiert. Referenz: `tests/ref_real_a.py` (243,16 mm³), App 243,3 mm³ (+0,06 %).
  - Reale Zeichnung B: `real/platte_schraege_1zu2.jpg` (A3, „SCALE 1:2“, „FIRST ANGLE PROJECTION“, Schnitt A-A, 60°-Kegelloch, Senkung Ø33,02 an der Nabe, Lochkreis 5×Ø8, Langloch, 120°-Schräge am Umfang). Referenz: `tests/ref_real_b.py` (214 747 mm³ inkl. Schräge), App ≈ 214 600 mm³ (−0,1 %).
- **Schnitte und Einzelheiten:**
  - Schraffur (dünne 45°-Linien zwischen Körperkanten), Schnittverlauf (kurze breite Striche mit Buchstaben), Schnitttitel „A-A“ und Ansichtsmaßstab („A-A 1:1“).
  - Drehteile: die schraffierten Flächen der Schnittansicht werden als Rotationsprofil verwendet (Bohrungen, Einstiche, Freistiche, Innenfasen). Eine eigenständige Vollschnitt-Ansicht in anderem Maßstab wird über ihren Titel-Maßstab angeglichen.
  - Prismatische Teile: Tiefen von Taschen und Sackbohrungen kommen aus der Schnittfläche.
  - Einzelheiten: Detailkreis + Buchstabe und Titel „Z (5:1)“; die vergrößerte Geometrie ersetzt die Kontur im Detailkreis der Elternansicht, Maße daraus erhalten die Quelle „Einzelheit Z“.
  - Vorschau: Schnitte rot schraffiert, Einzelheiten und Detailkreise violett, Schnittverlauf rot gestrichelt.
- **Niedrig aufgelöste Bilder / WEBP:** WEBP wird über den Browser-Decoder gelesen. Ohne DPI-Angabe wird auch 72–120 dpi über das DIN-Format geschätzt und bis 4× hochskaliert. Auf Normblättern wird nur zwischen Normmaßstäben gewählt (Ansichtstitel > Maßzahlen). Deutlich blaue Elemente (Ballons/Prüfnummern) werden vor der Erkennung entfernt. Lochkreise werden bei Anzahlangabe („x4“) vervollständigt, wenn eine Bohrung verdeckt ist (Meldung im Merkmal).
- **Lokal starten:** `python -m http.server 8000` im Repo-Ordner ausführen, dann `http://localhost:8000/` öffnen. ES-Module und WASM funktionieren nicht über `file://`.
- **Test:** `python tests/test_web.py [URL]`. Der Test läuft in Headless Chrome am Desktop und als iPhone 390×844 mit Touch. Er prüft:
  - alle 15 Beispiele, mit Volumenvergleich gegen das Python-Backend bzw. analytische Sollwerte (Schnitt-Beispiele) bzw. das Handmodell (reale Zeichnung, Toleranz 3 %);
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
- Schnitte im Rasterbild: es wird nur der äußere Umriss vektorisiert, Innenkanten der Schnittfläche nicht. Durchgangsbohrungen kommen dann aus der Stirnansicht (nur wenn der Schnitt innerhalb keine Schraffur zeigt); Sackbohrungen, Gewinde, Einstiche und Freistiche aus Raster-Schnitten/-Einzelheiten werden nicht modelliert (Meldung).
- Reale, niedrig aufgelöste Zeichnungen: OCR liest viele Maße falsch (Komma fehlt „219“ statt 21,9, „Ø“ als 8/D). GD&T-Rahmen und Oberflächenzeichen werden nicht als PMI übernommen. Die Projektionsmethode kommt nur aus dem Schriftfeldtext, nicht aus dem Symbol; Stirnansicht links oder rechts wird gleichermaßen über die Lage zugeordnet (für Drehteile gleichwertig).
- Platte B: Gedrehte Maßtexte (R32,5, R45,5, Ø58,5, 120°) liest die OCR nicht. Die Radien kommen deshalb aus dem Pixel-Fit (R45,7 statt R45,5, R33,5 statt R32,5), und der Winkel 120° wird als Normwert angenommen (Meldung). Der Schnittverlauf A-A wird nicht gefunden. Tiefen kommen aus den schraffierten Flächen des ausgerichteten Schnitts (Spalten unter der Bohrung, mit Wandprüfung).
- Lochkreise werden aus erkannten und nur teilweise sichtbaren Bohrungen (Mittellinien angesetzt) über gemeinsamen Mittelpunkt und gleiche Teilung erkannt und ergänzt.
- Tangentialität: Übergänge Gerade/Bogen und Bogen/Bogen mit Knick < 8° werden auf G1 eingerastet. Die Prüfung erfolgt am fertigen B-Rep (Schnitt in halber Dicke) und wird als Merkmal angezeigt. Das Einsetzen von Radien aus Maßzahlen gibt es nur bei Drehteilen (Ø/R aus OCR).
- Projektionsmethode: „FIRST ANGLE“/„THIRD ANGLE“/„PROJEKTIONSMETHODE 1/3“ wird aus dem Schriftfeld gelesen. Bei Drittwinkel werden die Nebenansichten gespiegelt zugeordnet.
- Python-Version: Schnitte/Einzelheiten sind dort nicht umgesetzt.

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
