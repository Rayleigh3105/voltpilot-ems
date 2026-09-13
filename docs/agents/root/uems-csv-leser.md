# UEMS-Bezugsdaten: der CSV-Leser als reines Modul (AP-09 IP-11)

Angelegt am 13.09.2026. **Die Datei kommt von draußen:** ein Kunde lädt hoch, was er irgendwo
bekommen hat. Der Leser macht aus den Bytes Zeilen — oder gibt eine benannte, ruhige Antwort. Er
wirft für keine Datei, er deutet kein Feld und er schreibt nichts.

| Was | Wo |
|---|---|
| Modul (rein, ohne Spring, ohne Uhr) | `services/api/.../uems/CsvLeser` |
| Vertrag | `docs/contracts/v2/bezugsdaten-vectors.json` Block `csv` + Regel `csv` an B1, B12, B13; Prosa `bezugsdaten.md` §9 |
| Tests | `CsvLeserTest` (Block `csv`, Sätze, Spiegel des Exports, Zufallsdateien), `BezugsdatenVectorsTest` (Regel `csv`); gemeinsame Lesart der Vektoren `CsvVektoren` |
| TS-Zwilling | keiner — `zwillinge.csv = ["java"]`, Grund in `zwillinge_grund.csv` |

## Grenzen

- **5 MB = 5 242 880 Bytes** (5 × 1 024 × 1 024): keine Datei, die ein Betriebssystem mit „5 MB“
  oder weniger anzeigt, wird abgelehnt, und es ist Springs `5MB` — IP-12 setzt dieselbe Zahl
  als Multipart-Grenze. Darüber: `datei_zu_gross` + `zu_viele_bytes`, nichts gelesen.
- **100 000 Datenzeilen**, ohne Kopfzeile und ohne Leerzeilen. Die 100 001.: `datei_zu_gross` +
  `zu_viele_datenzeilen`; Kodierung, Trennzeichen und Kopfzeile stehen dann schon fest.

## Erkennungsreihenfolge (ergebnisrelevant)

`groesse → leer → kodierung → trennzeichen → anfuehrungszeichen → leerzeilen → kopfzeile → datenzeilen`
— die erste Stufe, die nicht passt, spricht. Was vor ihr feststand, steht im `Ergebnis`, alles
danach ist `null`, `zeilen` ist leer.

1. **Kodierung:** UTF-8-BOM entscheidet (auch gegen die Vorlage) → Vorgabe der Vorlage → UTF-8 →
   Windows-1252; beide STRENG (`CodingErrorAction.REPORT`, nie `U+FFFD`). Steuerzeichen außer
   Tab/`\n`/`\r` → unlesbar: so fallen Excel-Mappe (ZIP) und „Unicode-Text“ (UTF-16) nicht als
   Text durch. ⚠ Nur ASCII-Bytes heißen UTF-8 — B1s „Windows-1252“ steht nur mit Vorlage da.
2. **Trennzeichen:** die ersten 20 Zeilen MIT Inhalt stimmen ab, jede für das Zeichen, das sie
   (Anführungszeichen beachtet) in die meisten Felder zerlegt, mindestens zwei; Gleichstand in
   der Zeile und in der Summe → Reihenfolge `;` · `,` · Tab; niemand stimmt ab → `;`. Die Zeilen
   der Minderheit bleiben EIN Feld — der Leser rät nicht um.
3. **RFC 4180:** nicht geschlossenes `"` oder Text nach dem schließenden → `kodierung_unlesbar` +
   `anfuehrungszeichen_offen` + `zeile` (wo das Feld beginnt). Ein `"` mitten in einem Feld ohne
   Anführungszeichen ist ein Zeichen (`12" Rohr`). Zeilenenden `\r\n`, `\n` und `\r`.
4. **Leerzeilen** (leer, nur Leerzeichen, nur Trennzeichen) werden übersprungen; `nr` bleibt die
   Zeile der Datei. Nichts übrig → `keine_datenzeilen` + `nur_leerzeilen`.
5. **Kopfzeile:** die erste Zeile, wenn keines ihrer Felder zahlartig ist (nur Ziffern und
   `+ - . , : / '` und Leerzeichen, mindestens eine Ziffer) UND die zweite fehlt oder ein
   zahlartiges hat. Nur die Kopfzeile → `keine_datenzeilen` + `nur_kopfzeile` (B12).

Die `Vorgabe` (Kodierung, Trennzeichen, Kopfzeile) überspringt die Erkennung; ein Wort außerhalb
des Vokabulars in der Vorgabe ist ein Programmierfehler (`IllegalArgumentException`) — die
einzige Stelle, an der das Modul wirft, und nie wegen der Datei.

## Benannte Antworten

C8 ist geschlossen: **kein neues Befund-Wort.** Befund = `datei_zu_gross` · `kodierung_unlesbar` ·
`keine_datenzeilen` mit Satz aus `befund_saetze` (`CsvLeser.SAETZE`); der **Zusatz** sagt woran
(`csv.zusaetze` ⟷ `CsvLeser.ZUSAETZE`, je Zusatz sein Befund), Vorbild B12 „Die Datei ist leer
(0 Byte).“. `BezugsdatenRegeln.KEINE_DATENZEILEN` zeigt auf `CsvLeser`.

## Neutralisierungsregel

⚠ **Beim ANZEIGEN, nicht beim Lesen.** `CsvLeser.anzeige(feld)` / `Zeile.anzeige()` stellt `'` vor
ein Feld, das mit `=` `+` `-` `@` Tab oder `\r` beginnt — Zeichen für Zeichen der Export
(`MeasurementHistoryService.csv`, der Test liest dessen Quelltext). `Zeile.felder()` und
`text()` bleiben, was in der Datei stand; eine zweite Wahrheit über die Datei des Kunden gibt es
nicht. Der Leser kennt keine Spaltenart: auch `-5` wird so angezeigt, bis die Zuordnung (IP-12) das
Feld als Zahl liest.

## Fallen

- Eine geänderte Vektor-Datei: ALLE Leser fahren (`rg -l "bezugsdaten-vectors.json" services frontend`).
  Die Container-Klassen `UemsBezugsgroesseMigrationTest` (Regeln `fassung`/`periode`/`zeit`, zählt
  genau 10) und `BezugsgroesseApiTest` (`verwalten`, `vokabulare`) lesen den Block `csv` nicht.
- Eine neue `csv`-Prüfung braucht einen Zusatz, der zu ihrem Befund passt — `CsvLeserTest`
  verlangt außerdem, dass jeder Zusatz mindestens einen Fall hat.
- Nicht hier: Route, Multipart, Fingerabdruck (C2), Vorschau, Tabellen, Migration (IP-12);
  Übernahme (IP-13); Portal-Fläche; Rechte.
