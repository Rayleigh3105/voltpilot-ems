# UEMS-Korrektur und Ersatzwert: zwei Beleg-Tabellen, ein Vokabular (AP-08 IP-12)

Neu angelegt am 13.09.2026. Migration
`services/api/src/main/resources/db/migration/V20260913190000__uems_korrektur_ersatzwert.sql`,
Beweis `UemsKorrekturErsatzwertMigrationTest` (Testcontainers). Repositories
`uems/MessreiheErsatzwertRepository`, `uems/MessreiheKorrekturRepository` (gemeinsam
`uems/MessreiheFassungen`). Vertrag: `docs/contracts/v2/events-vocabulary.md` §4 + Vektor-Datei
`events-vocabulary-vectors.json` (Block `vokabular.ersatzwert_methode|ersatzwert_status|korrektur_art|korrektur_status`).

## ⚠ Ein Ersatzwert ist kein Messwert — und man sieht es ihm an

Ein Ersatzwert ist eine Zahl, die ein Mensch setzt, weil der Zähler sie nie geliefert hat. Darum
steht er **nie** in `device_measurement_sample`, `messreihe_viertelstunde` oder einer Periode, sondern
in seiner eigenen Tabelle: mit Kennung `EW-<Jahr>-<lfd. Nr.>`, Methode, **Pflicht-Begründung**
(10–500 Zeichen), Urheber — und **widerrufbar** (Rücknahme als Fortschreibung, nie gelöscht). Kein
Rohwert wird angefasst. Die Rechnung (Werte je Viertelstunde, Kennzeichen „mit Ersatzwert (Methode …)“,
Versionen) ist IP-13/IP-17 — die Tabelle trägt die Methode, sie wendet sie nicht an.

## Die sieben Methoden (E7) und die Unterscheidung in der Datenbank

| | Wort | `zuwachs` | `bezug` | Datenbank erzwingt |
|---|---|---|---|---|
| a | `gleichmaessig_verteilen` | gemessen | — | `luecke_ereignis_id` + `zuwachs`/`stand_vor`/`stand_nach`/`einheit` |
| b | `profil_vorperiode` | gemessen | vorperiode | dazu `vorperiode_von` (Raster, vor `von`) |
| c | `profil_vergleichsquelle` | gemessen | vergleichsquelle | dazu `vergleich_quelle_id` |
| d | `ablesestand_nachtragen` | — | ablesestaende | `zeitpunkt` volle Minute in (von, bis] EINER Viertelstunde, End-/Anfangsstand, Einheit |
| e | `wert_eingeben` | keiner | betrag | `betrag` + Einheit + **Beleg** |
| f | `vorperiode_uebernehmen` | keiner | vorperiode | `vorperiode_von` |
| g | `vergleichsquelle_uebernehmen` | keiner | vergleichsquelle | `vergleich_quelle_id` |

- **a–c (`gemessen`):** Trigger `messreihe_ersatzwert_luecke` verlangt die genannte `data_gap`-Meldung
  an DERSELBEN Reihe, geschlossen, mit GENAU diesem Zuwachs, diesen Ständen und dieser Einheit, und
  [von, bis) in ihren Viertelstunden (Boden/Decke auf 15 min) → sonst
  `messreihe_ersatzwert_zuwachs_gemessen`. Die Summe hat damit keine zweite, getippte Quelle.
- **e–g (`keiner`):** derselbe Trigger lehnt ab, sobald eine `data_gap` MIT Zuwachs Reihe und Zeitraum
  berührt (`messreihe_ersatzwert_ohne_zuwachs`). f/g sagt E7 wörtlich; **e** folgt aus §4.6 („nicht
  gezählte Zeit oder Lücke einer Intervallmengen-/Leistungsreihe“) und der F21-Invariante (die Summe
  über eine Zählerstand-Lücke bleibt der gemessene Zuwachs). Eine OFFENE Lücke hat noch keinen Zuwachs
  und hält e–g nicht auf.
- Der Trigger liest mit den Rechten des Schreibers: eine fremde Lücke ist unsichtbar (RLS).
- BEFORE-Trigger laufen VOR RLS-WITH-CHECK und CHECKs — ein Test, der 42501 erwartet, braucht eine
  Zeile, an der der Trigger nichts findet.

## Korrektur

`messreihe_korrektur`: `K-<Jahr>-<lfd. Nr.>`, Art (`nachlieferung_nach_endgueltigkeit` ·
`ablesestaende_nachgetragen` · `umklassifizierung` · `ersatzwert` · `wert_berichtigt`), `reihen` JSONB
`[{entity_id, messkanal}, …]` (kanonische UUID, keine doppelt), [von, bis) im Raster, Begründung,
`beleg` (Pflicht bei `wert_berichtigt`), `ersatzwert_kennung` (genau bei Art `ersatzwert`, FK über die
berechnete `ersatzwert_fassung` = 1; Trigger: Reihe in `reihen`, Zeitraum umfasst), `vorschau` JSONB
(nicht leeres Array, Inhalt IP-14).

## ⚠ Append-only als Fassungen

- Fassung 1 legt an (alle anlegenden Spalten), jede weitere trägt NUR Status + `grund` + Urheber —
  anlegende Spalten leer (`…_anlage_chk`), nichts kann auseinanderlaufen.
- `folgt_auf` im Vokabular: Ersatzwert `wirksam` → `zurueckgenommen`; Korrektur `vorschlag` →
  `freigegeben` | `abgelehnt`, `freigegeben` → `zurueckgenommen`. **Jede Korrektur beginnt als
  Vorschlag** (E14, auch bei Vier-Augen aus). Trigger `…_fassung_folgt`: lückenlos
  (`…_fassung_lueckenlos`), Übergang (`…_status_folgt`); zwei gleichzeitige trifft der PK.
- `grund` Pflicht bei `abgelehnt`/`zurueckgenommen` (`grund_pflicht`).
- Ersteller, Freigeber, Widerrufer sind die `actor_*` ihrer Fassung — zwei Zeilen, nie zwei Spalten.
- UPDATE scheitert per Trigger `…_append_only` für JEDE Rolle (auch Verwaltung mit Recht, Eigentümer).
  App: SELECT + spaltenweises INSERT ohne `created_at`; Verwaltung: SELECT + DELETE (nur Offboarding).
  Die System-Vorschläge von IP-14 brauchen ein eigenes INSERT-Recht der BYPASSRLS-Rolle.
- Kennung: höchste je vergebene + 1 unter `pg_advisory_xact_lock` je Kundenbereich + Präfix + Jahr
  (Jahr in der Zone des Aufrufers) — kein Zähler, weil nie gelöscht wird. Nur in einer Transaktion.

## ⚠ Das Vokabular

- `messreihe_korrektur_vokabular()` ist die EINE Stelle in der DB, Zeile für Zeile die vier Blöcke der
  Vektor-Datei (der Test druckt den VALUES-Block, wenn der Vertrag weitet → NEUE Migration ersetzt nur
  die Funktion). CHECKs fragen `messreihe_korrektur_wort` / `…_merkmal`; keiner trägt ein Wort
  (Test). Merkmal-Schlüssel dürfen kein Vokabular-Wort sein (darum `nennt_ersatzwert`).
- Die Ereignis-Arten `substitute` (nur `kunde`) und `correction` (`cloud` nur `vorschlag`, `kunde`) —
  25./26. Wort: `messreihe_ereignis_vokabular()` ganz abgeschrieben + Art-CHECK, beide Java-Zwillinge
  (`EreignisVokabular` api/Writer), TS `uemsEreignis.ts` (`METHODE_TEXT`, `KORREKTUR_ART_TEXT`),
  `events-raw.event.schema.json`, Ingest `BoxEventsValidator.ARTEN`. Jeder Statuswechsel = neue Meldung.
- Der Writer-Test (`EreignisTabelleImTest`) spielt diese Migration NICHT ein (sie braucht
  `uems_viertelstunde_raster`); der Writer meldet beide Arten nie.

## Abgrenzung zu `messreihe_korrektur_vorschlag` (AP-07 IP-13, PR 702)

Die Liste ist die **Erkennung** (eine Zeile je Reihe + Viertelstunde, Rohwert nach der Frist,
`offen`/`erledigt`/`verworfen`, vom Stundenlauf); `messreihe_korrektur` ist der **Vorgang** (bündelt
solche Zeilen einer Reihe — F10: K-2026-0007 über 15 Viertelstunden — und wird entschieden). IP-14 macht
aus offenen Zeilen eine Korrektur der Art `nachlieferung_nach_endgueltigkeit` (dasselbe Wort wie
`grund`) und setzt sie auf `erledigt`. Keine zweite Wahrheit, keine Spalte doppelt.

## Offboarding

`TenantRepository.offboard` löscht `messreihe_korrektur` VOR `messreihe_ersatzwert` (FK). Beide sind
Belege: keine Hypertable, keine Aufbewahrung, kein FK auf Löschbares (Reihe, Messstelle,
Vergleichsquelle, Lücke stehen als Kennung).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='UemsKorrekturErsatzwertMigrationTest,MessreiheEreignisMigrationTest,EreignisVokabularVectorsTest')
(cd services/timescale-writer && ./mvnw test -Dtest='EreignisVokabularZwillingTest,EventsRawConsumerTest')
(cd services/ingest && ./mvnw test -Dtest='BoxEventsValidatorTest,EventsContractSchemaTest')
(cd frontend/portal && npx vitest run src/uemsEreignis.test.ts)
```
