# UEMS: `measurement-samples` 2.1 — optionale Herkunftsfelder, 2.0 bleibt gültig

Neu angelegt am 11.09.2026 (AP-07 IP-2, Auflösung W4 „Verträge sind additiv“ gegen
`additionalProperties: false`).

- **[`docs/contracts/v2/mqtt-measurement-samples-2.1.md`](../../contracts/v2/mqtt-measurement-samples-2.1.md)**
  + `mqtt-measurement-samples-2.1.schema.json`: 2.0 plus `applied_revision` (Umschlag) und
  `entity_id` (Sample, Komponenten-UUID), beide OPTIONAL und NUR unter `schema_version: "2.1"`.
  Die 2.0-Datei ist byte-gleich; eine eigene Datei je Version, wie `mqtt-telemetry-2.0`/`mqtt-events-2.1`.
- **Ingest** `MeasurementSamplesValidator` nimmt 2.0 und 2.1 auf demselben Topic an;
  `MeasurementSamplesContractSchemaTest` prüft jedes Beispiel gegen Schema UND Validator, den
  Gleichlauf 2.1 = 2.0 + zwei Felder und die Feldlisten gegen die Schemas.
- `mqtt-telemetry-2.0.md` §5: `seq` bleibt optional für die Box, ist aber Pflicht-Weiterreichung
  für die Cloud (seit IP-5 in `telemetry-v2.raw`, siehe `uems-datenannahme-ereignisse.md`).

## ⚠ Zwei Fallen

1. **Der Writer prüft die Sample-Felder streng** (`MeasurementRawConsumer.SAMPLE_FIELDS`). Die
   Datenannahme ENTFERNT deshalb `entity_id`, bevor sie `measurements.raw` (1.0) schreibt. Wer die
   Felder durchreicht, ändert Ereignis-Schema, Validator UND Writer in einem Zug — IP-5 hat es
   deshalb NICHT getan, es kommt mit IP-6/IP-7. **Seit IP-18b (Cloud-Vorpaket)** reist
   `entity_id` NUR an einem geteilten Punkt (derselbe `point_key` mehrfach, je eigene Komponente)
   mit; der Writer schlägt damit nur in der eigenen Auswahl nach
   (`HerkunftNachschlag#reihe(..., komponente)`), und ein einfacher Punkt mit `entity_id` bleibt
   im Writer ungültig. Speicherschlüssel und Box-Verlauf regelt Teil 1b
   ([Box-Schlüssel des geteilten Punkts](uems-geteilter-punkt-box-schluessel.md)).
2. **Die Box-Core liest den lokalen Layer-1-Batch mit `DisallowUnknownFields`**
   (`edge-app/core/internal/measurements` `parseBatch`, `Sample`/`LocalBatch`). Seit
   [IP-18](uems-measurement-samples-box-herkunft.md) erlaubt sie Herkunft und wählt
   dafür 2.1; alte Batches bleiben 2.0. Eine neue Palette verwirft bei einer älteren
   Core den GANZEN Batch — Core und Palette müssen gemeinsam ausgeliefert werden.
