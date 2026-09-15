# UEMS-WAGO: Erhebungsbogen, Hardwareblatt-Vorlage, Referenzdatensatz-Schema (AP-05 IP-1)

Neu am 15.09.2026, erstes Bau-Paket von AP-05 (Konzept `vp-uems-ap05-wago/report.md` §4.9–§4.11,
§8 IP-1). Nur Dokumente, ein Schema und ein Test — keine Laufzeit, kein Produktivcode. Leitsatz:
**Der Simulator dient dem Bauen, nie dem Beleg.**

- [`docs/wago/erhebungsbogen.md`](../../wago/erhebungsbogen.md) — A–E mit 22 Fragen für jemanden am
  Schaltschrank; jede Frage lässt „weiß nicht“ zu, das wird zur Prüfaufgabe (Tabelle: welcher
  Pilotschritt). Auswertung = die drei Antworten aus E8. Das Ahrenberg-Beispiel folgt
  `uems-referenzunternehmen.json`; was dort fehlt, steht als „weiß nicht“.
- [`docs/wago/hardwareblatt-vorlage.md`](../../wago/hardwareblatt-vorlage.md) — jedes Feld nennt seine
  Quelle (Bogen · Handbuch · Programm · Schritt 1 · Schritt 2), vier Nachweis-Wörter, 15 Zeilen
  (E9-Standardsatz + Wirkleistung gesamt als Regel + Herzschlag), Verhalten nur im Wartungsfenster mit
  Zustimmung (E7 = B), Fassungen.
- [`docs/contracts/v2/wago-referenzdatensatz.schema.json`](../../contracts/v2/wago-referenzdatensatz.schema.json)
  + `fixtures/wago-referenzdatensatz/` (2 gültig, 1 ungültig) — geprüft von
  `frontend/portal/src/wagoReferenzdatensatz.test.ts`.

## Fallen

- ⚠ **Die Beweisregel ist `anyOf`, nicht `if`/`then`:** `belegtAusDemPilot` (herkunft `pilot`, `belegt:
  true`, Nachweis Pflicht) oder `nichtBelegt`. Der UEMS-Schema-Läufer kennt kein `if`, `not`, `format`
  und übergeht Unbekanntes STILL — der Test hält die Schlüsselwort-Teilmenge fest. Wer das Schema
  erweitert, bleibt in der Teilmenge oder erweitert den Läufer (TS und Java) mit.
- ⚠ **Fixtures nie nach `docs/contracts/v2/examples/`:** die ingest-Tests (`EventsContractSchemaTest`,
  `MeasurementSamplesContractSchemaTest`, `BoxEventsValidatorTest`) listen dort jede Datei.
- ⚠ **Die Beispiele sind KEINE Vektor-Datei.** Die Lesungen sind erfunden; den echten Referenzdatensatz
  (`belegt: true` nur mit Pilot-Protokoll) legt IP-14 an, die Simulator-Fälle IP-12.
- ⚠ **Energie-Faktor bei Register 35 = 4 ist offen:** Das Konzept-Muster §4.10 nennt 0,01 kWh an einer
  /000-001-Karte, Handbuch 750-495 Tab. 67 gibt für 5-A-Varianten 0,05 kWh, für 750-494 ist die Tabelle
  nicht belegt → in der Vorlage `zu erheben` (Pilotschritt 2). Die Rechenbeispiele in §4.11 passen nicht
  zu ihren Rohwörtern (0x0038 0x5470 ergibt nicht 36 912,48 kWh) — nicht übernehmen.
- Nicht belegt und darum `zu erheben`: Messwert-IDs von Wirkenergie Lieferung gesamt und Netzfrequenz,
  die Bitlage der Bereichsbegrenzung im Statuswort, die Seriennummer von C-1.
- Das Ahrenberg-Beispiel weicht vom Konzept-Muster §4.9 ab, wo die Referenzdatei etwas anderes sagt:
  keine Seriennummer an C-1, keine befristete Unterstützung bis 31.03.2027 (Brunner:
  24.11.–15.12.2026), Bogen vor der Einrichtung am 01.10.2026, Box beim Pilot E-2′.
