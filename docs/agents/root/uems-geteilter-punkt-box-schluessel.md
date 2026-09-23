# UEMS AP-07 IP-18b Teil 1b — Box-Schlüssel des geteilten Punkts

Ein **geteilter Punkt** ist derselbe `point_key` einer Box für zwei Komponenten, jede mit ihrer
`entity_id` am Sample ([Vertrag §2/§3](../../contracts/v2/mqtt-measurement-samples-2.1.md)).
Teil 1a (Datenannahme, Writer-Nachschlag) steht in
[uems-measurement-samples-2-1-herkunftsfelder.md](uems-measurement-samples-2-1-herkunftsfelder.md).

## Speicherschlüssel (`V20260922236000` Spalte, `V20260922236500` Schlüssel)

- `device_measurement_sample.edge_entity_id`: die Komponente, die die **Box genannt** hat —
  Wortlaut vom Draht. Das Ergebnis des Nachschlags steht getrennt davon in `entity_id`. Jede
  Bestandszeile hat NULL, keine wurde umgeschrieben.
- `uq_device_measurement_sample_box (device_id, point_key, time, edge_sequence) WHERE
  edge_entity_id IS NULL` ersetzt `uq_device_measurement_sample_idempotency`: dieselbe
  Spaltenfolge, für alles Heutige dieselbe Semantik.
- `uq_device_measurement_sample_box_komponente (device_id, point_key, edge_entity_id, time,
  edge_sequence) WHERE edge_entity_id IS NOT NULL`: beide Komponenten desselben Ticks liegen.
- ⚠ Kein Schlüssel über `entity_id`: er kollidiert, wenn beide Komponenten unaufgelöst sind, und
  kann zwischen zwei Zustellungen desselben Umschlags wechseln.
- Gebaut werden die Schlüssel sperrarm in `V20260922236500` (ohne Flyway-Transaktion,
  `….sql.conf`): `device_measurement_sample` ist eine Hypertable, `CREATE INDEX CONCURRENTLY`
  lehnt TimescaleDB ab, `timescaledb.transaction_per_chunk` gibt es nicht für UNIQUE (2.17.2).
  Darum Wurzel mit `ON ONLY`, dann je Chunk eine Transaktion mit Eintrag in
  `_timescaledb_catalog.chunk_index` (wie Timescale selbst), der alte Schlüssel fällt je Chunk
  erst danach; jede Sperre mit 5 s Frist und Wiederholung. Nach jedem Abbruch wiederholbar, auch
  mit INVALID-Rest (`UemsBoxSchluesselBauenMigrationTest`). Drehbuch:
  [uems-erste-freigabe.md §2.7](../../rollout/uems-erste-freigabe.md).
- ⚠ Ein Chunk-Index ohne Katalog-Eintrag bricht `ON CONFLICT (…)` mit Ziel („could not find
  arbiter index") und bleibt bei `DROP INDEX` an der Wurzel liegen. Wer einen Schlüssel auf
  einer Hypertable von Hand je Chunk baut, trägt ihn ein.
- Der Writer (`MeasurementWriteRepository#schreiben`) nennt `edge_entity_id` nur an einem
  geteilten Punkt. Ohne Komponente bleibt die Anweisung Zeichen für Zeichen die bisherige.
  Ein älterer Writer schreibt NULL und trifft damit den alten Schlüssel.

## Box-Verlauf: der geteilte Punkt erscheint dort nicht (Entscheid firstmate 22.09.2026)

Auf Box-Ebene zählen nur Zeilen mit `edge_entity_id IS NULL`. Die Werte der Komponenten zeigt
nur ihre Reihe (`entity_id`), also Messstelle, Viertelstunde und Kennzahl.

- `MeasurementHistoryService`: `rawData`, `prependRawState` und `rawAvailable` filtern auf
  `edge_entity_id IS NULL`. Dieser Filter macht eine Partition von `lag` nach `edge_entity_id`
  überflüssig. Die Bestands-CSV bleibt Byte für Byte gleich (`UemsKennzahlenBestandsschutzTest`,
  `UemsBerichteBestandsschutzTest`).
- Box-Verdichtung `refresh_device_measurement_rollup`: dieselbe Prozedur mit demselben Filter.
- Punktzustand `device_measurement_point_state`: siehe den nächsten Abschnitt — er wird
  fortgeschrieben, aber als Wert einer Komponente gekennzeichnet.
- Beweis: `UemsGeteilterPunktBoxSchluesselMigrationTest` (Migration, Bestand und Box-Verlauf) und
  `WriterPipeTest#einGeteilterPunktFindetJeKomponenteSeineReihe` (Writer).

## Punktzustand am geteilten Punkt (`V20260923241500`, Pflicht vor dem Einschalten)

Der Punktzustand trägt die letzte Beobachtung über ALLE Komponenten, damit „zuletzt gelesen" der
Geräteseite nicht stillsteht; ein stehender Wert sähe aus wie ein aktueller.

- Spalte `component_read_at`: Messzeit der letzten Beobachtung mit Komponente. Die Zeile gilt als
  „je Komponente", solange `component_read_at >= last_read_at`. Ein späterer Wert ohne Komponente
  rückt `last_read_at` weiter und hebt das Kennzeichen damit auf, OHNE die Spalte zu nennen: die
  Writer-Anweisung eines heutigen Punkts bleibt Zeichen für Zeichen die bisherige
  (`MeasurementWriteRepository#punktzustandSql`, `PunktzustandBestandTest` mit wörtlicher Kopie).
- Warum keine Zeile je Komponente: die Löschwege `uems_messwerte_der_anlage_entfernen` und
  `uems_messwerte_des_kundenbereichs_entfernen` nehmen die Punktzustands-Zeile schon mit; eine
  eigene Tabelle hätte beide Funktionen umschreiben müssen. Die Werte je Komponente stehen in ihrer
  Reihe — dieselbe Lesart wie der Box-Verlauf.
- Geräteseite (`MeasurementSelectionRepository#latestObservations`, `Observation#jeKomponente`):
  gelesen, `lastReadAt` aktuell, aber `rawValue`/`decodedValue`/`quality` leer und der Grund
  „Von diesem Gerät gelesen, je Komponente: der Wert steht in der Reihe der Komponente." — der
  gespeicherte Wert gehört EINER Komponente und wäre für jede andere falsch (Summenwert-Assistent
  liest `decodedValue` je Komponente). Kein neues Feld, keine Portal-Änderung.
- Vergleichs-Auswahl der Anlage (`MeasurementHistoryService#comparisonOptions`) bietet einen
  Punkt „je Komponente" nicht an: er hat keinen Box-Verlauf.
- ⚠ Randfall: ein Wert ohne Komponente auf GENAU derselben Messzeit wie der letzte mit Komponente
  (höhere Sequenz) gilt bis zum nächsten Box-Wert noch als „je Komponente". Tritt nur beim
  Planwechsel geteilt → zusammengelegt auf und heilt mit der nächsten Kadenz.
- Beweise: `WriterPipeTest#einGeteilterPunktFindetJeKomponenteSeineReihe` (Zustand bewegt sich),
  `UemsPunktzustandJeKomponenteMigrationTest` (Bestand zeilengleich, Geräteseite, Vergleich),
  `MeasurementSelectionApiTest#catalogZeigtEinenGeteiltenPunktGelesenJeKomponenteOhneWertDerBox`.

## Offen / Fallen

- `MessstelleFormelWerteRepository#frischester` liest den Live-Wert eines Formel-Terms über
  `(device_id, point_key)` ohne Komponente. Am geteilten Punkt nimmt er irgendeine der beiden
  Komponenten. Der Term kennt seine Komponente; die Korrektur ist ein eigenes Paket.
- `appendTransitions` (Wechsel-Ereignisse) eines einfachen Punkts vergleicht weiter mit der
  letzten Zeile seines `point_key`, auch mit einer, die eine Komponente genannt hat. Das betrifft
  nur einen Punkt, der von geteilt zu einfach wechselt.
- Teil 2, Cloud-Schnitt: `MeasurementConfigPublisher` fragt `BoxFaehigkeiten.kann(…,
  "measurement_config_per_component")`; nur dann steht ein Punkt mehrerer Komponenten einmal je
  Komponente im Plan (`MeasurementPlan#composeJeKomponente`, Vertrag `x-point-key-rule`, bleibt
  2.0). Jede andere Box bekommt den zusammengelegten Plan byte-gleich
  (`MessplanJeKomponenteBestandTest`, wörtliche Kopie von vorher).
- Box-Schritt, gebaut aber RUHEND: Core `measurements.geteiltePunkte` ist die eine
  Duplikat-Regel für `ParseConfig`, `parseBatch` und `WrapStatus` (Paar zulässig, dieselbe
  Komponente zweimal oder ein Vorkommen ohne Komponente = Duplikat). `BuiltSupports` meldet das
  Wort NICHT (Entscheid firstmate 23.09.2026, `cloud/geteilter_punkt_ruhend_test.go`): erst nach
  Punktzustand (erledigt, Abschnitt oben), Cloud-Status je Komponente, Revisions-Anstoß und einem Summen-Wächter gegen zwei
  an A und B gebundene Messstellen desselben Registers (sonst doppelt gezählt); Einschalten ist
  ein eigenes Paket. Node-RED `buildPlan` plant Anfragen aus `lesungenJeZiel` (ein Lesen je Ziel und Punkt,
  schnellste Kadenz), Samples je Komponente; die Laufzeit taktet Lesen (`due`) und Sample
  (`probenDue`) getrennt und dekodiert je Lesen einmal (Decoder halten Vorwerte). Beweise:
  `geteilter_punkt_test.go`, `measurement-geteilter-punkt.test.js` (Budget über jeden
  Katalogpunkt).
- ⚠ Status je Komponente (`x-rejection-entity-rule`): die Box nennt `entity_id` an der Ablehnung
  einer Komponente eines geteilten Punkts. `MeasurementConfigStatusListener` (nur
  `point_key`/`reason`, Punkt nie zugleich angenommen und abgelehnt) und
  `applyAcknowledgement` (je `point_key`) verwerfen so eine Quittung heute ganz — Pflicht vor dem
  Box-Release, eigenes Cloud-Paket.
- Mit dem Box-Release endet an einer Box mit bisher zusammengelegtem Punkt dessen Box-Verlauf
  (gewollt, Werte in den Reihen der Komponenten); „zuletzt gelesen" der Geräteseite läuft weiter
  (Punktzustand, Abschnitt oben).
- ⚠ Meldet eine Box das Wort erst nach ihrem Update, erreicht sie der neue Plan erst mit der
  nächsten Plan-Revision: der Core weist dieselbe Revision mit anderem Inhalt als `stale
  revision` ab (`agent/measurements.go`), und das bleibt so — die Box kann keine Revision
  erzeugen. Den Anstoß (Revision +1, wenn das Wort neu gemeldet wird) muss die Cloud geben;
  bis dahin läuft der zusammengelegte Plan wie heute weiter.
