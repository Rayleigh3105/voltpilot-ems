# mqtt-measurement-samples 2.1 — Zusätzliche Messwerte mit Herkunftsfeldern (Box → Cloud)

**Status: BINDEND (UEMS AP-07 IP-2, additiv). Schema:
[`mqtt-measurement-samples-2.1.schema.json`](./mqtt-measurement-samples-2.1.schema.json).
Vorgänger, unverändert und weiter gültig:
[`mqtt-measurement-samples.schema.json`](./mqtt-measurement-samples.schema.json) (2.0).
Beispiele: [`examples/`](./examples/README.md).**

2.1 ist 2.0 plus genau zwei OPTIONALE Angaben aus dem Herkunftsvertrag je Messwert
([`messwert-herkunft.md`](./messwert-herkunft.md), Angaben 2 und 11). Sonst ändert sich nichts:
dasselbe Topic `ems/{tenant_id}/{site_id}/{device_id}/v2/measurement-samples`, QoS 1, nicht
retained, dieselbe Identitätsregel (Topic = Payload), dieselbe Ehrlichkeitsregel für `raw`.

## 1. Die zwei neuen Felder

| Feld | Ebene | Herkunftsangabe | Bedeutung | Fehlt es |
|---|---|---|---|---|
| `applied_revision` | Umschlag | Einstellungs-Fassung (`einstellungs_fassung`, im Herkunftsvertrag `umschlag.angewendete_fassung`) | Ganzzahl ≥ 0: die Fassung der messwertrelevanten Einstellungen (AP-04 E5), die die Box beim Erfassen ALLER Samples dieses Umschlags angewendet hat | Die Cloud schlägt die zur Messzeit angewendete Fassung aus der Zustellung (`applied_at`) nach (`quelle: zustellung`), nie geraten |
| `entity_id` | Sample | Komponente (`komponente`) | UUID der Komponente, für die der Punkt gelesen wurde — dieselbe Kennung wie `selections[].entity_id` in [`mqtt-measurement-config`](./mqtt-measurement-config.schema.json), nie das Kundenkennzeichen (`K-5`) | Die Cloud löst die Komponente aus der Auswahl auf; mehrdeutig = Spiegel, nie geraten |

Die Messzeit bleibt, wie sie ist: `observed_at` je Sample (optional), sonst die des Umschlags —
immer RFC 3339, die Cloud rechnet in UTC. Die Sequenz bleibt `sequence` je Umschlag.

## 2. Warum eine eigene Datei und warum die Felder nur unter 2.1 (W4)

Die Verträge führen Versionen als getrennte Dateien (`mqtt-telemetry-2.0`, `mqtt-schedule-2.0`,
`mqtt-events-2.1`); die 1.0-Telemetrie blieb beim Nachfolger unangetastet. So auch hier: die
2.0-Datei ist byte-gleich, jede ausgelieferte Box bleibt gültig, und eine neue Box sagt mit
`schema_version: "2.1"` ausdrücklich, dass sie den erweiterten Vertrag spricht.

Beide Verträge verbieten fremde Felder weiter (`additionalProperties: false`). Die Auflösung
von AP-07 W4 („Verträge sind additiv“ gegen die strengen Schemas) ist deshalb eine neue
Versionsnummer mit genau den erlaubten neuen Feldern, kein Aufweichen: ein 2.0-Umschlag mit
`entity_id` oder `applied_revision` ist ungültig, ein Tippfehler bleibt ein Fehler, und ein
Feld, das die Box nie liefert (`messstelle` — die Messstelle bestimmt die Cloud aus der
Quellenbindung), wird in beiden Versionen abgewiesen. Eine ältere Box sendet 2.0 und wird von
der Cloud vervollständigt — nie abgelehnt (AP-06 E8). 2.1 ohne die neuen Felder ist ebenfalls
gültig: eine Auswahl ohne Komponenten-Bindung hat keine `entity_id`.

`point_key` bleibt je Umschlag eindeutig (wie 2.0) — mit EINER Ausnahme, nur unter 2.1 (AP-07
IP-18b, Cloud-Vorpaket): derselbe `point_key` darf mehrfach stehen, wenn JEDES Vorkommen eine
`entity_id` nennt und keine Komponente zweimal vorkommt (ein **geteilter Punkt**, ein Punkt je
Komponente). Doppelt ist dann das Paar (`point_key`, `entity_id`). Fehlt einem Vorkommen die
Komponente, gilt die Eindeutigkeit des `point_key` unverändert für alle Vorkommen. Das Schema
kann diese Regel nicht ausdrücken (JSON Schema kennt keine Eindeutigkeit eines Feldes über
Array-Elemente); sie steht in der Datenannahme und im Writer.

| Vorkommen desselben `point_key` im Umschlag | Ergebnis |
|---|---|
| einmal, mit oder ohne `entity_id` | angenommen, wie bisher |
| zweimal, `entity_id` A und B | beide angenommen (geteilter Punkt) |
| zweimal, `entity_id` A und A (auch in anderer Schreibweise) | beide `regel_verletzt` |
| zweimal, eines ohne `entity_id` | beide `regel_verletzt` (die Regel von 2.0) |
| dreimal: A, A, B | A zweimal `regel_verletzt`, B angenommen |

## 3. Was die Datenannahme heute tut (IP-2) — und was IP-5 tut

`services/ingest` (`MeasurementSamplesValidator`) nimmt 2.0 und 2.1 auf demselben Topic an und
prüft die neuen Felder (Ganzzahl ≥ 0; UUID in Normalform). Es VERARBEITET sie noch nicht: das
Redpanda-Ereignis `measurements.raw` bleibt
[`1.0`](./measurements-raw.event.schema.json) und trägt genau die 2.0-Sample-Felder — die
Datenannahme entfernt `entity_id` vor dem Weiterreichen, denn der Writer prüft die Sample-Felder
streng und würde das Ereignis sonst verwerfen. Das Durchreichen ins Ereignis (additiv) kommt
deshalb MIT dem Writer, der die Felder annimmt — mit den Spalten (IP-6) und dem Nachschlagen für
ältere Boxen (IP-7); IP-5 hat es bewusst nicht getan.

**Seit IP-5** ist das SAMPLE die Einheit für Inhalt und Messzeit: ein fehlerhaftes Sample (Grund
aus dem geschlossenen Vokabular, doppelter `point_key` = `regel_verletzt` für jedes Vorkommen)
oder eines mit unplausibler Messzeit (E13: > 300 s nach dem Eingang `clock_ahead`, > 90 Tage davor
`too_old`) verwirft nur sich selbst, die übrigen gehen weiter; Fassung, Form und Kennung des
Umschlags verwerfen ihn ganz. Jede Ablehnung wird gebündelt als Ereignis der Datenannahme auf
`events.raw` festgehalten ([`events-vocabulary.md`](./events-vocabulary.md) §7). `sequence` reist
wie bisher unverändert in `measurements.raw`.

**Seit IP-18b (Cloud-Vorpaket)** reist `entity_id` an GENAU einer Stelle ins Ereignis: an den
Samples eines geteilten Punkts. Dort ist sie das Einzige, was die zwei Werte unterscheidet
(`measurements.raw` bleibt `1.0`, das Sample-Feld ist additiv). An jedem einfachen Punkt entfernt
die Datenannahme sie weiter — ein heutiges Ereignis ist damit Zeichen für Zeichen das bisherige.
Der Writer nimmt die Komponente nie als Fakt: er zählt zu (Box, `point_key`, `entity_id`) die
Zeilen der EIGENEN Auswahl, und nur bei genau einer folgt die Reihe; sonst bleibt der Wert ohne
Komponente wie heute bei Mehrdeutigkeit. ⚠ Auslieferung: Writer vor (oder mit) der Datenannahme —
ein älterer Writer verwirft ein Ereignis mit `entity_id` ganz. ⚠ Offen bis zum Folgepaket: der
alte Speicherschlüssel `(device_id, point_key, time, edge_sequence)` lässt zu DERSELBEN Messzeit
nur die erste Komponente eines geteilten Punkts durch; Schlüssel je Komponente und die
Historienzählung je Komponente kommen dort. Heute liefert keine Box einen geteilten Punkt (der
Mess-Plan führt ihn zusammen); das ändert erst Teil 2 (Plan + Box, nach `supports[]`).

Die Box sendet 2.1 erst mit einem Edge-Release (AP-07 IP-18).

## 4. Beispiele (Referenzunternehmen Ahrenberg)

Technische Kennungen wie in [`events-vocabulary-vectors.json`](./events-vocabulary-vectors.json)
(`kennungen`): Kundenbereich `…-000000000001`, AN-1 `…-0000000000a1`, AN-2 `…-0000000000a2`,
Box Halle 1 (E-1) `…-0000000000e1`, Box Halle 2 (E-2) `…-0000000000e2`; dazu für die Komponente
K-5 (Unterzähler Spritzguss) `a4e0b000-0000-4000-8000-0000000000c5`. Werte, Sequenzen,
Katalogstand und Fassung stammen aus den Fällen `ms06-1039-letzter-wert-z5a`,
`ms06-1047-erster-wert-z5b` und `nachlieferung-box-halle-2-nach-ausfall` von
[`messwert-herkunft-vectors.json`](./messwert-herkunft-vectors.json); die Messzeiten stehen dort
in Ortszeit (+01:00), am Draht in UTC. Das Referenzunternehmen nennt keinen Katalogschlüssel für
den Kanal „Wirkenergie Bezug“ eines Modbus-Zählers; die Beispiele benutzen den eigenen Punkt
`custom.wirkenergie-bezug`.

## 5. Prüfung

`services/ingest`: `MeasurementSamplesValidatorTest` (2.0 ohne, 2.1 mit und ohne neue Felder,
fremdes Feld in beiden Versionen, unbekannte `schema_version`, unverändertes Ereignis, die Tabelle
des geteilten Punkts in §2) und `MeasurementSamplesContractSchemaTest` (jedes Beispiel gegen sein
Schema UND gegen die Datenannahme; 2.1 = 2.0 + genau die zwei Felder; Feldlisten der Datenannahme
= Schema). `services/timescale-writer`: `GeteilterPunktConsumerTest` (Schlüssel im Ereignis) und
`WriterPipeTest#einGeteilterPunktFindetJeKomponenteSeineReihe` (Nachschlag je Komponente, die
Grenze des alten Speicherschlüssels).
