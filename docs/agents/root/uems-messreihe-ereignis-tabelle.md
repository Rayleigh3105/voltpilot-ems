# UEMS-Ereignis-Tabelle `messreihe_ereignis`: append-only, nie gelöscht — und wer hineinschreibt

Neu angelegt am 11.09.2026 (AP-07 IP-8). Migration
`services/api/src/main/resources/db/migration/V20260911260000__uems_messreihe_ereignis.sql`.
Schreibwege: api `uems/MessreiheEreignisRepository` (Cloud-Ereignisse der api, noch ohne Aufrufer),
api-Läufe auf der BYPASSRLS-Rolle mit abgeleiteten Kennungen (`SpaetankunftMelder` → `late_arrival`,
`LueckenMelder` → `data_gap`/`backfill`, [`uems-luecken-melder.md`](uems-luecken-melder.md)),
Writer `MessreiheEreignisRepository` (Bestands-Spiegel + `events.raw`) mit `EventsRawConsumer` und
dem Writer-Zwilling `EreignisVokabular`. Beweise: `MessreiheEreignisMigrationTest` (api,
Testcontainers: Bestand zeichengleich, Vokabular = Klasse, CHECKs urteilen wie die Klasse, alle
Vektor-Fälle durch den Schreibweg, Zaun, Rechte, Löschwege, Offboarding),
`DataRetentionPolicyTest` (kein Job, keine Kompression), `WriterPipeTest` (Spiegel 1:1),
`EventsRawConsumerTest` (je Urheber eine Nachricht, Wiederholung, Fortschreibung, Verwerfen),
`EreignisVokabularZwillingTest` (rein: der Zwilling urteilt alle 61 Fälle wie die Vektor-Datei).

## Die Fakten, die man ohne Nachlesen braucht

1. **Nie gelöscht, nie geändert.** Keine Retention, keine Kompression (RLS-Tabelle, E7), KEIN
   Fremdschlüssel auf Anlage/Box/Komponente/Datenquelle/Messstelle/Gerät — Unclaim, Purge und
   Anlage-Löschen lassen jede Zeile stehen. Einziger Löschweg: `TenantRepository.offboard`
   (Admin-Rolle hat dafür DELETE; `tenant_id` hängt RESTRICT am Mandanten). App-Rolle (api UND
   Writer, beide `voltpilot_app`): nur SELECT + INSERT. Ein Trigger lehnt jedes UPDATE ab.
2. **Eine Zeile = eine Meldung.** Ein offenes Ereignis (`data_gap`, `handover`) wird durch eine
   WEITERE Zeile mit derselben `ereignis_id` fortgeschrieben; die jüngste (`eingang`) ist der
   Stand, die erste bleibt lesbar. Zulässig ist nur, was `pruefeFortschreibung` erlaubt (der
   Schreibweg prüft gegen die jüngste Meldung, gleicher Urheber).
3. **Idempotenz = `meldung`**, der md5-Fingerabdruck der ganzen Meldung ohne Eingangszeit (Trigger,
   nie vom Aufrufer), eindeutig mit `(tenant_id, meldung, zeit)`. Dieselbe Meldung zweimal →
   `ON CONFLICT DO NOTHING`; der Schreibweg meldet sie vorher schon als Wiederholung.
4. **Bezug wie gemeldet + aufgelöst.** `kennungen` hält Box/Datenquelle/Komponente/Messstelle
   wörtlich (UUID oder `DQ-4`, `K-8.3`, `MS-06`); `device_id`/`data_source_id`/`entity_id`/
   `messstelle_id` nur, was eindeutig auflösbar war (UUID-Form wörtlich — das Objekt darf weg sein;
   `DQ-n` über `data_source.kennzeichen`, `MS-n` über `messstelle_kennzeichen`), sonst NULL. Für
   Komponenten gibt es kein Kennzeichen in der Datenbank — `K-8.3` bleibt nur in `kennungen`.
5. **Das Vokabular steht in der Datenbank** (`messreihe_ereignis_vokabular()`), die CHECKs fragen es
   (Art, Urheber je Art, Zeitform, Bezug, Nutzlast-Schlüssel). Eine neue Art = neue Migration, die
   diesen Stand abschreibt, PLUS api-Klasse, Writer-Zwilling, TS-Zwilling, Schemas, Vektoren.
6. **Bestandsweg (`aus_bestand`).** Jedes Ereignis, das der Writer NEU in
   `device_measurement_event` schreibt, schreibt er in derselben Transaktion hierher — in einem
   EIGENEN SAVEPOINT (`TransactionTemplate` mit `PROPAGATION_NESTED`): scheitert der Spiegel
   (CHECK, Mandanten-FK, Vokabular-Drift), wird nur er zurückgerollt, laut geloggt und in
   `voltpilot_writer_events_mirror_total{ergebnis="fehler",grund=<Constraint>}` gezählt; der
   Bestandsweg schreibt garantiert wie vorher und die Partition hängt nie am Spiegel. Gespiegelt
   wird nur, wenn die Bestandszeile neu war — eine Wiederholung spiegelt nichts. Box + `point_key` als `messkanal`,
   keine Komponente; die `_pipeline`-Lücke ist Urheber `box`, `erkannt_aus = verdraengung`,
   `erwartet_fehlend` = `dropped_samples` (nur > 0), OHNE Zeitraum (`zeit` = `observed_at` des
   Umschlags). `ereignis_id` = UUID v3 aus dem Bestandsschlüssel. `device_measurement_event` und
   seine Leser (`MeasurementHistoryService`) bleiben unverändert, bis IP-14 umzieht.
7. **`events.raw`** (Topic `REDPANDA_EVENTS_TOPIC`, Vorgabe `events.raw`, lokal von `redpanda-init`
   angelegt, fehlt es, legt die Datenannahme es seit 15.09.2026 selbst an, Grund in Falle 1 von
   `uems-datenannahme-ereignisse.md`): `EventsRawConsumer` prüft den Rahmen wie das Schema (für `box`: Umschlag-Felder,
   `ereignis.box` = `device_id`, Topic genau dieser Box), dann den Vertrag; verworfen wird geloggt und
   in `voltpilot_writer_events_raw_total{ergebnis,grund}` gezählt, nie geraten. Beschickt wird es
   von der Datenannahme (IP-5) und Cloud-Diensten — dieses Paket baut nur die Verbraucher-Seite.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='MessreiheEreignisMigrationTest,DataRetentionPolicyTest')
(cd services/timescale-writer && ./mvnw test -Dtest='EreignisVokabularZwillingTest,EventsRawConsumerTest,WriterPipeTest')
```

Die Writer-Tests fahren die ECHTE Migration auf ihr `writer-schema.sql` (`EreignisTabelleImTest`);
das Schema liefert nur, was sie voraussetzt (Admin-Rolle, `tenant`, `reject_audit_mutation()`,
Kennzeichen-Tabellen verkürzt). Maven braucht JDK 21.
