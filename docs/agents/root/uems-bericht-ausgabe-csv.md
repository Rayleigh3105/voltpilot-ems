# UEMS-Ausgabe CSV, Abruf-Protokoll und Bestand-Geräte-CSV (AP-12 IP-10) — Meilenstein 4, CSV-Hälfte

Neu angelegt am 15.09.2026. Keine Migration, keine Fläche. Die Regeln sind der Vertrag `docs/contracts/v2/bericht.md` §10
(DA3–DA5) und G1–G3; Routen und Rechte: `uems-bericht-routen.md`; Tabellen: `uems-bericht-tabellen.md`; Lesepfad des
Bestand-Exports: `uems-lesepfad-verlauf-herkunft-rueckfall.md`.

| Was | Wo |
|---|---|
| Berichts-CSV | `GET /api/v1/berichte/{kennung}/staende/{nr}/csv` in `web/BerichtController` → `uems/BerichtService.csv` → rein `uems/BerichtCsv` (Kopf und Zeile aus `BerichtRegeln.csvKopf`/`csvZeile`) |
| Abruf-Protokoll | `BerichtRepository.abruf` (`bericht_abruf`) + Meldung `bericht_abgerufen` (Kennung = die des Abrufs), EINE Transaktion |
| Bestand-Geräte-CSV | `web/DeviceMeasurementSelectionController.export` → `uems/BestandGeraeteCsv.erzeugung` (Recht, Standort, Unternehmen) → `MeasurementHistoryService.csv(History, Erzeugung)` |
| Portal-Naht (nicht eingehängt) | `berichtSeite.ts`: `AUSGABE_EINGEHAENGT.csv` auf `true`, `darfNachLesen` kennt `export.*` noch nicht (antwortet `null` → kein Knopf); `pages/BerichtSeite.tsx`: `onAbruf` hereinreichen; `api.ts`: ein Download wie `downloadMeasurementExport` |
| Tests | `BerichtCsvTest` · `BestandGeraeteCsvTest` (Vorher-Datei) · `BerichtApiTest` (`b14…`, `derBestandGeraeteCsv…`) · `UemsLesepfadTest` · `UemsLesepfadMengenTest` (md5-Karte) · `MeasurementSelectionApiTest` · `BerichtSchnittstelleVertragTest` |

```bash
(cd services/api && ./mvnw test -Dtest='BerichtCsvTest,BestandGeraeteCsvTest,MeasurementHistoryServiceTest,BerichtSchnittstelleVertragTest,RechteKennungenDerRoutenTest')
(cd services/api && ./mvnw test -Dtest='BerichtApiTest')                          # Testcontainers
(cd services/api && ./mvnw test -Dtest='UemsLesepfadTest,UemsLesepfadMengenTest')  # Testcontainers
```

## Die Fallen

- **Nur aus dem Abzug (A1).** `BerichtCsv` liest den Abzug und die Freigabe des Stands — nie `messreihe_*`, `kennzahl_wert`
  oder Stammdaten. Was der Abzug nicht trägt, bleibt leer: je Kennzahl `ort` und `endgueltig_ab` (Abzug 1.1; firstmate 001 =
  A, als Ist-Zustand behauptet in `BerichtCsvTest`, das Mapping liest beide schon). Das Folgepaket
  `vp-uems-b12-tagesverlauf-speicher` hebt den Abzug auf 1.2 — dann wird der Test rot und KZ-0001 byte-gleich zum Vektor.
- **Die Richtung einer Kennzahl ist ein Kennzeichen** („Untergrenze …“, „Obergrenze …“, „Richtung unbestimmt …“) in der Zelle
  `kennzeichen` — keine 14. Spalte (Vertrag und Vektoren: 13).
- **Abschnitte** entscheidet die Geltung im Abzug, nicht die heutige Vorlagen-Datei; `dieAbschnitteMitZeilenFolgenDenVorlagen`
  pinnt die Folge gegen die Vorlagen (der Leistungsvergleich folgt mit IP-22).
- **Zwei Abrufe sind byte-gleich** bei derselben Person in derselben Sekunde: `erzeugt_am`, `erzeugt_von` und `teilansicht`
  beschreiben den Abruf selbst (DA3). `jetzt` ist sekundengenau.
- **Kein Abruf ohne Spur:** erst die Datei bauen, dann `bericht_abruf` und die Meldung in EINER Transaktion — scheitert das,
  geht keine Datei hinaus. Abgelehnte Abrufe (403/404) schreiben nichts.
- **Die Route hat kein `produces`:** die Ablehnungen kommen als JSON aus dem `@ExceptionHandler`; mit `produces = "text/csv"`
  fände Spring für sie keinen Konverter. Die Test-Hilfe `ruf` liest JSON — Dateien holt `datei(...)`.
- **Der Bestand-Geräte-CSV ist die EINE sichtbare Bestandsänderung von AP-12:** die VoltPilot-Unterstützung (Plattform-Admin
  mit `X-Tenant-Id`) bekommt 403 statt der Datei — und das Portal zeigt dazu heute NICHTS (`void downloadMeasurementExport`
  am Knopf „CSV mit Metadaten exportieren“). Kunden (heute Kundenadministrator unternehmensweit) bekommen dieselben Spalten
  und Zeilen, neun Kopfzeilen mehr. Ohne OIDC (nur Entwicklung) ist der Export jetzt 401 wie jede UEMS-Route.
- **Die neun Kopfzeilen stehen an Position 16–24** (nach den 15 bisherigen). `BestandGeraeteCsvVergleich.ohneNeueKopfzeilen`
  prüft die Stelle und nimmt sie heraus — so vergleichen `BestandGeraeteCsvTest` (Vorher-Datei vom unveränderten Export, Stand
  `uems` 84f8307f) und die md5-Karte `FLAECHE_VORHER`. Eine neue Kopfzeile gehört HINTER die neun.
- **Ziel des Rechts** ist der Standort der Anlage heute (`anlage_standort`); ohne Standort das Unternehmen (dann nur
  unternehmensweite Rollen). Archivierte Standorte gehören zum Kundenbereich — sonst verlöre jemand den Export.
