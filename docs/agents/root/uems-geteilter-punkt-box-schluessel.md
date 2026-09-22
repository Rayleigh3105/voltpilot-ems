# UEMS AP-07 IP-18b Teil 1b — Box-Schlüssel des geteilten Punkts

Ein **geteilter Punkt** ist derselbe `point_key` einer Box für zwei Komponenten, jede mit ihrer
`entity_id` am Sample ([Vertrag §2/§3](../../contracts/v2/mqtt-measurement-samples-2.1.md)).
Teil 1a (Datenannahme, Writer-Nachschlag) steht in
[uems-measurement-samples-2-1-herkunftsfelder.md](uems-measurement-samples-2-1-herkunftsfelder.md).

## Speicherschlüssel (`V20260922236000`)

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
- Punktzustand `device_measurement_point_state`: Ein Wert mit Komponente schreibt ihn nicht fort.
- Beweis: `UemsGeteilterPunktBoxSchluesselMigrationTest` (Migration, Bestand und Box-Verlauf) und
  `WriterPipeTest#einGeteilterPunktFindetJeKomponenteSeineReihe` (Writer).

## Offen / Fallen

- `MessstelleFormelWerteRepository#frischester` liest den Live-Wert eines Formel-Terms über
  `(device_id, point_key)` ohne Komponente. Am geteilten Punkt nimmt er irgendeine der beiden
  Komponenten. Der Term kennt seine Komponente; die Korrektur ist ein eigenes Paket.
- `appendTransitions` (Wechsel-Ereignisse) eines einfachen Punkts vergleicht weiter mit der
  letzten Zeile seines `point_key`, auch mit einer, die eine Komponente genannt hat. Das betrifft
  nur einen Punkt, der von geteilt zu einfach wechselt.
- Teil 2 (Plan und Box nach `supports[]`) liefert den geteilten Punkt erst wirklich. Bis dahin
  meldet keine Box einen.
