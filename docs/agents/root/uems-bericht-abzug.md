# UEMS-Berichts-Abzug bilden und Berichtsvorlagen (AP-12 IP-5)

Neu angelegt am 15.09.2026, Meilenstein 1 „Abzug existiert“. Keine Migration, keine Fläche, eine Route. Die Regeln sind
der Vertrag `docs/contracts/v2/bericht.md` (EW3, A1–A8, Q1–Q6, RW1) — Tabellen: `uems-bericht-tabellen.md`, Regel-Module:
`uems-bericht-vertrag.md`.

| Was | Wo |
|---|---|
| Vorlagen | `services/api/src/main/resources/berichte/bericht-vorlagen.json` = Vertrag = `frontend/portal/src/berichte/bericht-vorlagen.json` (Byte für Byte); `GET /api/v1/bericht-vorlagen` in `web/BerichtVorlagenController` liefert die Bytes |
| Bildung | `uems/BerichtAbzugBildung.bilden(con, bericht, jetzt, gebildetVon)` schreibt Entwurf + Quellen; `zusammentragen(con, bericht, jetzt)` dieselbe Bildung ohne zu schreiben |
| Regelwerk (RW1) | `uems/BerichtRegelwerk`: `spring-boot:build-info` im `pom.xml`, `voltpilot.uems.berichte.build: ${VOLTPILOT_BUILD:}`; `schema_version` je Vertrag als Konstante, gegen die Vektor-Dateien geprüft |
| Lesemodell | `MessstelleWerteService.werte(tenant, messstelle, raster, von, bis)` — package-private, Mandant ausdrücklich |
| Tests | `BerichtAbzugBildungTest` (Testcontainers) · `BerichtRegelwerkTest` · `web/BerichtVorlagenControllerTest` · `berichtVorlagen.sync.test.ts` |

```bash
(cd services/api && ./mvnw test -Dtest='BerichtAbzugBildungTest,BerichtRegelwerkTest,BerichtVorlagenControllerTest,BerichtVectorsTest')
(cd frontend/portal && npx vitest run src/berichtVorlagen.sync.test.ts)
```

## Die Fallen

- **Mandant ausdrücklich.** Die Kaskade (IP-8) reicht eine Verbindung der Verwaltungsrolle (BYPASSRLS) herein.
  `MessstelleRepository.findeNachKennzeichen`, `MessstelleQuelleRepository.derMessstelle` und
  `BerechnetePeriodenRepository` filtern NICHT nach `tenant_id` — die Bildung sucht nie über ein Kennzeichen, jede eigene
  Abfrage nennt `tenant_id`, das Lesemodell wird über `SingleConnectionDataSource` auf DER Verbindung des Aufrufers gebaut
  (sieht also auch die eben geschriebene Version 2 der Kaskade).
- **Schreiben:** die Verwaltungsrolle hat kein INSERT auf `bericht_entwurf` → erst UPDATE, dann INSERT. Die Quellen des
  Entwurfs werden gelöscht und neu geschrieben. **D2 wirft vor jedem Schreiben** (`IllegalStateException`, nichts
  geschrieben).
- **Ein Rest speichert keine Terme** (Trigger `messstelle_formel_term_nicht_rest`, AP-10 E3): `formel` kommt aus der
  gespeicherten Herkunft `bilanzwert_eingang` der Version — Zufluss „+“, Abfluss und zugeordnet „−“, je Gruppe nach
  Kennzeichen; Speicher-Anteil positiv = „laden“, negativ = „entladen“ (`BilanzAbleitung.rolle`). `formel_fassung` =
  die an der Periodenzeile gespeicherte Fassung.
- **Messstellen der Geltung je Tag** (Q3): `generate_series` × `messstelle_ort` × `ort_zuordnung` rekursiv, Tage
  einschließlich. `ort_zum_datenstand` = Ort am letzten Tag im Zeitraum — ein Ortswechsel im Zeitraum wird noch nicht als
  „bis … · ab …“ gesagt. „Energiemanagement seit“ = frühester Tag mit einer Messstelle in der Geltung.
- **Zusammenfassung:** Hauptzähler Bezug/Abgabe, Erzeuger, Speicher nur mit EINER Richtung, nur Strom in kWh; fehlt ein
  Wert, fehlt der Schlüssel (unbekannt ist keine Null). Gas/Wärme hat im Vertrag noch keinen Schlüssel.
- **Vergleichszeitraum:** ohne Zahl „keine Werte — vor Beginn (Energiemanagement seit …)“, das Datum nur beim ersten;
  mit Zahlen vorläufig „n Werte“ und die Quellen mit `bezug = vergleich` — die Vergleichswerte je Messstelle hat
  Vertrag 1.0 nicht.
- **Rechte:** die Route hat keine eigene Kennung; `RechteKennungenDerRoutenTest` verlangt trotzdem je UEMS-Controller eine
  genannte Kennung — sie steht im Klassen-Javadoc (die Kennungen des Anlegens).

## Benannte Lücken (firstmate 001 = A) — der Test wird rot, wenn sie sich schließen

`b1NummerEinsIstByteGleichZumVektor_jedeLueckeAlsIstZustandBehauptet` behauptet jede als Ist-Zustand:

1. ~~Kennzahlen leer („Keine Kennzahlen definiert“)~~ — geschlossen mit AP-12 IP-6 (`uems-bericht-abzug-unternehmen.md`);
   an ihrer Stelle zwei benannte Abweichungen: der Wert mit 10 Nachkommastellen (Vektor: 4), der Name von KZ-0005 aus der
   Referenzdatei 1.3.
2. ~~19 − 4 Quellen (ohne BZ-4, BZ-6, KZ-0001, KZ-0005)~~ — geschlossen mit AP-12 IP-6.
3. MS-04 („Laden / Entladen“) ist EINE Netto-Menge des Lesemodells statt Laden 7 900 / Entladen 7 100 —
   `vp-uems-b12-tagesverlauf-speicher` (Vertrag 1.1 + AP-08-Leseweg).
4. Folge davon: `speicher_laden_kwh`/`speicher_entladen_kwh` fehlen, 15 statt 16 Werte — dito.
5. MS-03 (PV aus Leistung) trägt „aus Leistung integriert …“ seiner Zeile, der Konzept-Abzug nicht — Vertrag 1.1.

Dazu nach Vertrag 1.0: kein Tagesverlauf im Abzug (`$defs/abzug`, `additionalProperties: false`).
