# BlindenPlan

Tastbare Gebäudepläne für blinde und sehbehinderte Menschen – gezeichnet im Browser, beschriftet in Brailleschrift, exportiert als STL oder 3MF für den 3D-Druck.

**Live:** https://lollylan.github.io/BlindenPlan/

Läuft komplett im Browser, ohne Installation und ohne Server. Pläne werden automatisch im Browser gespeichert und lassen sich als JSON sichern und wieder öffnen.

## Was das Tool kann

- **Grundriss zeichnen** in Metern: Räume als Rechteck oder freies Polygon, Ecken ziehen, Ecken einfügen (Alt+Klick auf eine Kante), Raster-Fang.
- **Bereiche** ohne Wände (z. B. Anmeldung und Wartebereich im selben Raum) mit flacher, gestrichelter Tastlinie.
- **Türen** als Lücken in der Wand, optional mit niedriger Schwelle; entlang der Wand verschiebbar.
- **Beschriftung** je Raum: Name und Kurzbezeichnung. Braille wird automatisch erzeugt (deutsche Basisschrift oder Vollschrift), darüber optional erhabene Profilschrift für Sehende. Freie Beschriftungen (z. B. „Eingang“) sind ebenfalls möglich.
- **Legende** als eigene Tafel: Kurzbezeichnung → voller Name, in Braille und Profilschrift.
- **3D-Vorschau** (Three.js) mit Gesamtplatte oder Einzelteilen, zweifarbig oder pro Raum.
- **Export**
  - **3MF** mit Grundplatte und erhabenen Teilen als getrennten Teilen eines Objekts (je ein Filament zuweisen) oder als ein Körper.
  - **STL** als einzelne Datei oder ZIP mit mehreren Dateien.
  - **Gesamtplatte**, **Räume einzeln** (Puzzleteile mit eigenem Boden, z. B. in verschiedenen Farben) oder nur ein ausgewählter Raum.
- **Maßstab** frei wählbar; „Einpassen“ wählt den kleinsten Maßstab, bei dem die Platte auf das Druckbett passt (Bambu Lab A1 mini, P1/X1/A1, H2D oder eigenes Maß).

## Braille-Maße

Standard nach DIN 32976 / Marburg Medium: Punktabstand 2,5 mm, Zeichenabstand 6,0 mm, Zeilenabstand 10,0 mm, Punktdurchmesser 1,5 mm, Punkthöhe 0,6 mm (kuppelförmig). Alle Werte sind im Tab „Plan“ einstellbar.

Die Vollschrift wird automatisch mit den Lautgruppen au, äu, eu, ei, ch, sch, st, ie gesetzt. Sie kennt keine Wortfugen – „Haus|tür“ trennt mit `|`. Im Zweifel Basisschrift verwenden oder eine Braille lesende Person gegenlesen lassen.

## Drucken mit Bambu Studio

1. 3MF importieren (Datei → Importieren).
2. **Zweifarbig:** Grundplatte und erhabene Teile sind Teile eines Objekts – jedem Teil ein Filament zuweisen. Erscheinen sie als getrennte Objekte: alle markieren, Rechtsklick, „Zusammenfügen“.
3. **Ein Körper mit Filamentwechsel:** In der Schichtvorschau bei der Oberkante der Grundplatte (Dicke der Grundplatte, Standard 2,4 mm) einen Filamentwechsel einfügen.
4. Empfehlung: 0,2 mm Schichthöhe, 0,4 mm Düse, 3–4 Wandlinien, 100 % Füllung in den oberen Schichten (Punkte und Schrift).

## Entwicklung

Reine Web-App ohne Build-Schritt: `index.html`, `css/app.css`, `js/*.js` (ES-Module). Three.js wird vom CDN geladen (nur für 3D-Vorschau und Profilschrift). Lokal testen z. B. mit `python -m http.server 8765` und http://localhost:8765 öffnen.

Deployment über GitHub Actions (`.github/workflows/pages.yml`) auf GitHub Pages; `.nojekyll` verhindert den Jekyll-Build.

## Lizenz

MIT – siehe [LICENSE](LICENSE).
