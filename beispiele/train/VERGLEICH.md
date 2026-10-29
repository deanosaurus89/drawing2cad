# Trainingspaare vergleichen

Die Zeichnungen liegen daneben (`01_welle.pdf` … `08_flansch.jpg`) und sind im Menü unter **Trainingspaare**. Die CAD-Dateien in `cad/` sind die Referenz, nicht das, was die App bauen muss. Isometrie auf dem Blatt dient nur der Orientierung. Freiform (IGES von Lochverbund) bleibt ununterstützt.

## Volumen und Hüllkasten

Die App zeigt unter **Info** Volumen (mm³) und Abmessungen (mm). Dieselben Zahlen stehen im PMI-Export (`bbox_mm`).

Lokal, ohne Server und ohne Einfluss auf GitHub Pages:

```bash
node scripts/vergleiche_referenz.mjs
node scripts/vergleiche_referenz.mjs --ist rekonstruktion.json
```

Das Skript nutzt das OpenCascade, das schon unter `vendor/` liegt. Es schreibt `cad/referenz.json` mit Volumen und Kantenlängen. Beim Vergleich werden die drei Kantenlängen sortiert, weil die STEP-Achsen nicht die Achsen der Rekonstruktion sein müssen.

`05_lochverbund.igs` liest dieses Skript nicht. Die Datei ist ein Flächenmodell aus PolyWorks.

## Was die App selbst tut

Bei hoher Sicherheit entsteht das 3D von allein. Sonst die Ansichten prüfen (Haupt, abgeleitet, Schnitt; Isometrie aus), Drehen oder Extrudieren wählen, die Achse setzen und **3D erzeugen**. **Bögen fitten** macht aus kurzen Linienzügen Geraden, Kreisbögen und Kreise. **Neues Projekt** leert das Modell, ohne die Beispiele aus dem Menü zu nehmen.
