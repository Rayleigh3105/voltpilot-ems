# UEMS-Bericht-Tabellen und Berichts-Ereignisse (AP-12 IP-4)

Neu angelegt am 15.09.2026. Migrationen `V20260915050000__uems_bericht.sql` (Tabellen) und
`V20260915050100__uems_bericht_ereignisse.sql` (vier Ereignisarten). Beweis: `UemsBerichtMigrationTest` (Testcontainers),
`MessreiheEreignisMigrationTest`, `EreignisVokabularVectorsTest`. Die Regeln sind der Vertrag `docs/contracts/v2/bericht.md` +
`bericht-vectors.json` + `bericht-vorlagen.json` (siehe `uems-bericht-vertrag.md`).

## Was es gibt — und was (noch) nicht

- `bericht` (Vorlage × Geltung × Zeitraum, genau eine Verweis-Spalte `standort_id`/`unternehmen_id`, `geltung_id` fasst sie
  für `bericht_gibt_es_schon`), `bericht_entwurf` (genau einer je Bericht, ersetzt), `bericht_stand` (Nr. 1, 2, …),
  `bericht_quelle` (Entwurf: `stand_nr` NULL), `bericht_revision_anstoss`, `bericht_abruf`, `bericht_aenderung`,
  `bericht_kennung_seq`.
- Seit IP-5 schreibt `BerichtAbzugBildung` Entwurf und Quellen des Entwurfs (`uems-bericht-abzug.md`). Noch kein
  Unternehmens-Abzug (IP-6), keine Berichts-Route und keine Freigabe (IP-7), keine Naht und kein Läufer (IP-8/IP-9),
  kein Abruf (IP-10/IP-11), keine Belegprüfung an den Löschwegen (IP-12).

## ⚠ Löschschutz (E13 S1) — nur an diesen Tabellen

- `bericht_stand` ist append-only für JEDE Rolle (Trigger `bericht_stand_append_only`, auch Verwaltungsrolle mit Recht und
  Eigentümer). Die eine Änderung: `ersetzt_durch_nr` von NULL auf den Nachfolger, genau einmal
  (`bericht_stand_ersetzt_einmal`), nur ein späterer Stand desselben Berichts (CHECK + FK). Nr. = letzte + 1
  (`bericht_stand_folgt`); `anlass_anstoss_id` ohne FK (Stand und Anstoß zeigten sonst im Kreis), geprüft vom Trigger.
- Ebenso append-only: Quellen eines Stands, Anstöße (nur der Abschluss offen → erledigt/verworfen, einmal), Abrufe,
  Protokoll. Die Quellen des Entwurfs werden gelöscht und neu geschrieben, nie geändert.
- Einziger Ausgang: `uems_berichte_des_kundenbereichs_entfernen(tenant)` (nur Verwaltungsrolle), in
  `TenantRepository.offboard` VOR den Kennzahlen; danach Entwurf, Bericht und Zähler per `deleteByTenant`.
- Kein bestehender Weg wird enger: `objekt_id` ohne FK, die Geltung zeigt auf Standort/Unternehmen (nur Offboarding),
  kein Trigger an Bestandstabellen — `keinBestehenderWegWirdEnger` hält das fest.

## ⚠ Abzug

- `abzug` ist `text`, nie `jsonb`; CHECK `pruefsumme = bericht_pruefsumme(abzug)` (SHA-256 über die UTF-8-Bytes). Wer
  schreibt (IP-5/IP-7), schreibt `BerichtRegeln.kanonisch` und `BerichtRegeln.pruefsumme` — eine abweichende Summe lehnt
  die Datenbank ab. Die Prüfsummen von B1 Nr. 1 und Nr. 2 entstehen im Test auch in der Datenbank.
- Keine Hypertable, keine Aufbewahrung, keine Kompression (Abfrage `timescaledb_information`).

## ⚠ Vokabulare und Literale

- `bericht_vokabular()` = Zeile für Zeile `vokabulare.vorlage|geltung_art|zeitraum_art|quelle_art|quelle_bezug|anstoss_art|
  anstoss_zustand|handlung`; `bericht_vorlage()` = `bericht-vorlagen.json` (Vorlage → Geltung, Zeitraum; die Fassung
  steht nicht dort). Ein neuer Vokabular-Block macht den Test rot: gespeichert (`LISTEN`) oder `NICHT_GESPEICHERT`.
- Protokoll-Wörter = `handlung` (`anlegen`, `freigeben`, …), nicht Konzept §4.2 — `angelegt` wird abgelehnt. Abruf nur
  `pdf`/`csv`; `gebildet_von` = `anlegen` · `abruf` · `kaskade` · `struktur` (bericht.md EW1).
- Tage einschließlich `erster_tag`/`letzter_tag` (Schema `$defs/quelle`), nicht das halboffene `von`/`bis` aus §4.2.

## Anstoß, Belege, Kennung, Rechte

- Anstoß idempotent: `UNIQUE NULLS NOT DISTINCT (tenant_id, stand_id, art, anlass_kennung, anlass_fassung, anlass_status)`
  → `INSERT … ON CONFLICT ON CONSTRAINT bericht_revision_anstoss_einmal DO NOTHING` (B7). Anlegen darf nur die
  Verwaltungsrolle (Naht, Läufer); die Anwendung schließt ab.
- `uems_berichts_belege(objekt)` (SECURITY INVOKER): jeder Stand, dessen Quelle das Objekt zitiert — unmittelbar,
  mittelbar UND als Vergleich, auch ein ersetzter (B12); Entwürfe nie.
- `uems_bericht_kennung(tenant, jahr)` → `BR-<Jahr>-<Nr.>`, vierstellig und darüber wachsend, belegte übersprungen; Jahr =
  Jahr des Anlegens (B15: Jahresbericht 2026 = BR-2027-0002).
- Anwendung: `bericht` SI + `archiviert_am`; `bericht_entwurf` SI + Abzug/Prüfsumme/Datenstand/`gebildet_von`;
  `bericht_stand` SI + `ersetzt_durch_nr`; `bericht_quelle` SID; Anstoß S + Abschluss-Spalten; Abruf, Protokoll SI;
  Zähler SIU. Verwaltungsrolle: SELECT, Entwurf ersetzen, Quellen ID, Anstoß I, DELETE nur Bericht/Entwurf/Zähler.
- ⚠ Eine neue Migration auf den Berichts-Tabellen gehört in `UemsBerichtMigrationTest.BAUEN_DARAUF_AUF`.

## Ereignisse (Teil 2)

- `bericht_freigegeben` (kunde; `nr`, `datenstand`, `pruefsumme`) · `bericht_revision_angestossen` (cloud; `nr`,
  `anstoss_art`, `anlass_kennung`, optional `anlass_fassung`) · `bericht_entwurf_neu_gebildet` (cloud; `datenstand`,
  optional `anlass_kennung`) · `bericht_abgerufen` (kunde; `nr`, `format`) — das 29. bis 32. Wort, Zeitpunkt, Bezug NUR
  `bericht` (sechster Schlüssel von `kennungen`). Person und Teilansicht eines Abrufs stehen in `bericht_abruf`.
- `anstoss_art` ist im Ereignis-Vokabular eine Kopie mit Kundennamen — `EreignisVokabularVectorsTest` hält sie Zeile für
  Zeile gleich `bericht-vectors.json`. `anlass` ist schon ein Wort-Feld (Gerätegrenze, Übergabe): darum `anlass_kennung`.
- ⚠ Der Art-CHECK von `messreihe_ereignis` ist eine wörtliche Liste: eine neue Art braucht DROP/ADD (Muster
  `V20260914140000`), die Vokabular-Funktion wird Zeichen für Zeichen übernommen und hinten ergänzt. Mitziehen: beide
  `EreignisVokabular` (api, writer), beide `MessreiheEreignisRepository`, `BoxEventsValidator` (ingest), `uemsEreignis.ts`,
  `events-raw.event.schema.json`, `events-vocabulary.schema.json`, die Zahl in `MessreiheEreignisMigrationTest`.
