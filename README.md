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
