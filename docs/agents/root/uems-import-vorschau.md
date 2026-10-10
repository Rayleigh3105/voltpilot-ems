# UEMS-Bezugsdaten: die Vorschau eines Imports — sie zeigt alles und schreibt nichts (AP-09 IP-12)

Angelegt am 14.09.2026. `POST /api/v1/bezugsdaten/importe/vorschau` (multipart: Teil `datei`, Teil
`zuordnung` als JSON) liest eine CSV-Datei, wendet die Zuordnung an und urteilt je Datenzeile — in
einer Nur-Lese-Transaktion. Kein Wert, kein Import, keine Vorlage, und nicht die Datei (E14).

| Was | Wo |
|---|---|
| Regel (rein) | `services/api/.../uems/ImportVorschau` — ruft `CsvLeser`, `BezugsdatenRegeln`, `BezugsEinheit`, `BezugsPeriode` an |
| Route · Arbeit · Formen | `web/BezugsdatenImportController` · `uems/ImportVorschauService` (+ `BezugsdatenImportRepository`, nur lesend) · `web/dto/BezugsdatenImportDto` |
| Vertrag | `bezugsdaten-vectors.json` Regel `vorschau` an B1, B2, B9–B13 (14 Prüfungen), `$defs/vorschau_*` im Schema, Prosa `bezugsdaten.md` §10; OpenAPI `BezugsdatenImportVorschau` |
| Tabellen | `V20260914173000__uems_bezugsdaten_import.sql`: `bezugsdaten_import` (Fassungen, append-only), `bezugsdaten_import_zeile` (append-only, Zeilentext zwei Jahre), `bezugsdaten_vorlage` (Fassungen) — beschrieben, nicht von der Vorschau |
| Aufbewahrung | `uems/ZeilentextAufbewahrung` (+ `…Laeufer`, `…SchedulingConfig`), täglich 03:17, `voltpilot.uems.zeilentexte.enabled` (yml AN, surefire AUS) |
| Tests | `ImportVorschauTest`, `BezugsdatenVectorsTest` (rein, über `VorschauVektoren`); `BezugsdatenImportVorschauApiTest`, `UemsBezugsdatenImportMigrationTest` (Docker); `BezugsdatenImportSchnittstelleVertragTest`, `ZeilentextAufbewahrungWiringTest` |

## ⚠ Die Fallen

- **Die Vorschau schreibt nichts — und das ist getestet, nicht behauptet.**
  `BezugsdatenImportVorschauApiTest.vorschauZweimalIdentischUndNullZeilenInBezugsgroesseWert` nimmt den
  Bestandsschutz-Fingerabdruck ALLER Tabellen vor und nach zwei Vorschauen und vergleicht die Antworten
  Zeichen für Zeichen (feste Uhr über `ImportVorschauService.uhrStellen`). Wer hier „nur kurz“ etwas
  anlegt (Import-Satz mit Status `vorschau`, Zwischenspeicher der Datei), bricht ihn — und die DB lehnt
  `status = 'vorschau'` ohnehin ab (`bezugsdaten_import_status_chk`).
- **Zwei Fingerabdrücke.** Datei = SHA-256 der Bytes. Zeile = SHA-256 `<bezugsgroesse_id>|<Periodenschlüssel
  oder Zeitpunkt UTC>|<Betrag ohne Nachkomma-Nullen>` in der Einheit der Bezugsgröße — nie der
  Zeilentext (B1 umgestellt, B9 t statt kg: derselbe Wert). Die ID, nicht das Kennzeichen: ein
  Kennzeichen darf wechseln (M2).
- **`datei_bekannt` ist ein Hinweis.** Nur ein Import mit `uebernommen`/`teilweise_uebernommen`/
  `zurueckgenommen` macht die Datei bekannt (`ImportVorschau.SCHREIBENDE_IMPORTE`); der heutige Status
  eines Imports ist der seiner HÖCHSTEN Fassung.
- **Die Kennung lebt 30 Minuten** (`ImportVorschau.GUELTIG`, `kennungPruefen`) und ist kein Auftrag,
  keine Reservierung, kein Geheimnis: sie bindet Kundenbereich + Ergebnis-Fingerabdruck + Sekunde der
  Ausstellung. Nach Ablauf oder bei geändertem Bestand rechnet die Übernahme (IP-13) neu — sie muss die
  Datei ohnehin noch einmal bekommen.
- **Kein neues Befund-Wort (C8 geschlossen).** Eine archivierte Bezugsgröße und ein Stammdatum nehmen
  keine Werte an; die Zeile ist `bezug_unbekannt`. Ein Stand in der Zukunft ist `periode_nicht_zu_ende`.
  `einheiten_gebunden` ist heute immer 1 (keine gespeicherte Anzahl) — `wert_unplausibel` ist nur ein Hinweis.
- **Vokabulare nur in `bezugsdaten_vokabular()`**: die Migration hat die Funktion neu gefasst
  (`import_status`, `zeilen_urteil`, `befunde`, dazu `kodierung`/`trennzeichen` aus dem Block `csv`);
  `UemsBezugsgroesseMigrationTest` vergleicht Zeile für Zeile (`LISTEN` + `CSV_LISTEN`).
- **Zeilentext zwei Jahre:** der Trigger `bezugsdaten_import_zeile_nur_vergessen` lässt nur `text → NULL`
  mit `text_entfernt_am` nach `bezugsdaten_zeilentext_frist()` durch (Spaltenrecht nur die
  Verwaltungsrolle) und den Grabstein `bezugsgroesse_id → NULL`; alles andere ist append-only.
- **Upload-Grenze:** `spring.servlet.multipart.max-file-size: 5MB` = `CsvLeser.BYTES_HOECHSTENS`,
  `resolve-lazily: true` (sonst erreicht `MaxUploadSizeExceededException` den Controller nicht). MockMvc
  setzt die Grenze NICHT durch — `ZeilentextAufbewahrungWiringTest` prüft yml und Handler. ⚠ Die
  Ingress-Grenze (gitops) muss ≥ 6 MB sein.
- Eine geänderte Vektor-Datei: ALLE Leser fahren (`rg -l "bezugsdaten-vectors.json" services frontend`).

## Nicht hier

Übernahme, Konflikt-Entscheidung, Kennungsvergabe `I-JJJJ-NNNN`, Rücknahme (IP-13); Vorlagen-Routen
(IP-14, die Tabelle steht); Portal-Assistent (IP-15/16); Rechte-Durchsetzung (AP-03).

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
(cd services/api && ./mvnw test -Dtest='ImportVorschauTest,BezugsdatenVectorsTest,BezugsdatenImportSchnittstelleVertragTest')
(cd services/api && ./mvnw test -Dtest='BezugsdatenImportVorschauApiTest,UemsBezugsdatenImportMigrationTest')   # Docker
```
