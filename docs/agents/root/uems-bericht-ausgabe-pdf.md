# UEMS-Ausgabe PDF (AP-12 IP-11) — Meilenstein 4, PDF-Hälfte

Neu angelegt am 15.09.2026. Keine Migration, keine Fläche. Die Regeln sind der Vertrag `docs/contracts/v2/bericht.md` §10
(DA2, DA5) und G1; der CSV-Zwilling und das Abruf-Protokoll: `uems-bericht-ausgabe-csv.md`; Routen und Rechte:
`uems-bericht-routen.md`.

| Was | Wo |
|---|---|
| Berichts-PDF | `GET /api/v1/berichte/{kennung}/staende/{nr}/pdf` in `web/BerichtController` → `uems/BerichtService.pdf` → rein `uems/BerichtPdf.datei(abzug, stand)` |
| Gemeinsamer Weg mit dem CSV | `BerichtService.ausgabe(…)`: Recht → Stand mit geprüfter Prüfsumme → Datei → `bericht_abruf` + `bericht_abgerufen` in EINER Transaktion |
| Bibliothek | Apache PDFBox 3.0.8 (Apache-2.0) in `services/api/pom.xml` mit Lizenz-Vermerk; `commons-logging` ausgeschlossen (spring-jcl stellt dieselbe API) |
| Schrift | Liberation Sans Regular aus dem pdfbox-Jar (`/org/apache/pdfbox/resources/ttf/LiberationSans-Regular.ttf`, SIL OFL 1.1), als Teilmenge eingebettet |
| Portal-Naht (nicht eingehängt) | `berichtSeite.ts`: `AUSGABE_EINGEHAENGT.pdf` auf `true` (`berichtSeite.test.ts` pinnt heute `{ pdf: false, csv: false }`); `pages/BerichtePage.tsx`: `onAbruf` in `<BerichtSeite>` reichen; `api.ts`: ein Download wie `downloadMeasurementExport` mit `k.datei`. `darfNachLesen` kennt das PDF-Recht schon (= abrufen) — der Knopf erscheint, sobald beides steht |
| Tests | `BerichtPdfTest` (rein) · `BerichtApiTest.dasPdfEinesStands…` (Testcontainers) · `BerichtSchnittstelleVertragTest` · `RechteKennungenDerRoutenTest` |

```bash
(cd services/api && ./mvnw test -Dtest='BerichtPdfTest,BerichtCsvTest,BerichtSchnittstelleVertragTest,RechteKennungenDerRoutenTest')
(cd services/api && ./mvnw test -Dtest='BerichtApiTest')   # Testcontainers
```

## Die Fallen

- **Nur aus dem Abzug (A1).** `BerichtPdf.datei` bekommt den Abzug und den Stand (Nr., Freigabe, Prüfsumme, ersetzt durch) —
  keine Verbindung, kein Repository. `BerichtApiTest` vergleicht die Bytes der Route mit der reinen Funktion.
- **Byte-gleich für JEDEN Abrufer — anders als der CSV.** Im CSV beschreiben `erzeugt_am`, `erzeugt_von` und `teilansicht` den
  Abruf; im PDF steht nichts davon. Wer eine Abrufzeile ins PDF schreibt, bricht die Kernzusage (Jonas und Claudia bekommen im
  API-Test dieselben Bytes). Die Teilansicht steht nur in `bericht_abruf`.
- **`/ID` im Trailer:** ohne feste Kennung setzt PDFBox eine aus `System.currentTimeMillis()`. `eigenschaften` schreibt sie aus
  der Prüfsumme, `CreationDate` = `ModDate` = Freigabe. `BerichtPdfTest` erzeugt über eine Sekundengrenze hinweg.
- **Ein ersetzter Stand ändert seine Datei genau einmal** (Wasserzeichen). „Byte-gleich“ heißt: derselbe Stand im selben
  Zustand — IP-16 vergleicht vor und nach den Fristen, nicht über eine Revision hinweg.
- **Gedrehter Text kommt bei der Text-Extraktion zerhackt heraus.** Darum steht „ersetzt durch Nr. n (Datum)“ zusätzlich als
  Zeile oben rechts; der Test liest die schräge Fassung über die Scherung der `TextPosition`.
- **Zeichen ohne Glyphe werden „?“**, Steuerzeichen Leerzeichen (`Setzer.sicher`) — Liberation Sans hat kein CJK. Ohne das
  würfe `showText` eine Ausnahme, und ein Name legte das PDF lahm.
- **`List.of` verträgt kein `null`:** fehlende Felder des Abzugs sind `null` (unbekannt ist keine Null) — Nachweis-Teile gehen
  über `Arrays.asList`.
- **Eine Einheit ohne Ebenen-Regel** (Stück an einer Bezugsgröße) lässt `BerichtRegeln.anzeige` werfen; `BerichtPdf.menge` fällt
  auf die ungerundete Zahl in derselben Schreibweise zurück.
- **Abschnitte, Titel und Vorlagen-Namen stehen fest in `BerichtPdf`** (Fassung 1), nicht aus der heutigen Vorlagen-Datei —
  `dieAbschnitteFolgenDenVorlagen` pinnt sie gegen `bericht-vorlagen.json`. Der Abzug 1.2 trägt den Tagesverlauf; der
  PDF-Setzer bildet Tagesverlauf und Monatswerte weiterhin nicht ab.
- **Die Route hat kein `produces`** — wie beim CSV kommen die Ablehnungen als JSON aus dem `@ExceptionHandler`.
