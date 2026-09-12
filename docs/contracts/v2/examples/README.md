# v2-Vertragsbeispiele

Ausführbare JSON-Fixtures für Schema- und Laufzeitprüfungen. Dateinamen und Inhalte werden von Tests referenziert; Umbenennungen mit den konsumierenden Tests abstimmen.

| Fixture-Gruppe | Gültig | Negativfälle |
|---|---:|---:|
| `consumer-policy.*.json` | 3 | 1 |
| `edge-desired.*.json` | 3 | 1 |
| `edge-entity.*.json` | 6 | 1 |
| `flow-artifact.*.json` | 2 | 1 |
| `flow-graph.*.json` | 14 | 3 |
| `mqtt-measurement-config-status.*.json` | 1 | 0 |
| `mqtt-measurement-config.*.json` | 3 | 1 |
| `mqtt-measurement-samples.*.json` | 1 | 1 |
| `mqtt-schedule-2.0.*.json` | 3 | 1 |
| `mqtt-telemetry-2.0.*.json` | 2 | 1 |

`valid` muss die jeweils geprüfte Regel erfüllen; `invalid` benennt den gezielten Verstoß. Negative Beispiele nicht mit beliebigen Zusatzfeldern ungültig machen. Datumswerte sind eingefrorene Testdaten, keine aktuellen Fahrpläne.

## Schema und Semantik getrennt prüfen

- `flow-graph.invalid.reactive-without-origin.json` verletzt eine **semantische** Herkunftsregel; JSON-Schema allein reicht nicht.
- `mqtt-measurement-config.invalid.identity.json` ist formal gültig, passt aber nicht zur Topic-Identität.
- Ports, Zyklen, Claims, Berechtigungen und Laufzeit-Hashprüfung benötigen die jeweiligen Validatoren.

JSON-Schema 2020-12 verwenden; bei Ajv auch `ajv-formats` für UUIDs und Zeitstempel einbinden. `strict: false` erlaubt projektbezogene `x-*`-Annotationen, ersetzt aber keine Formatprüfung.

Prüfpfade: Optimierung `tests/test_contract_v2.py`, API-Validatoren, `edge-app/nodered/flowc/` und Go-Core-Pakete für Registry, Plan und Measurements. [Vertragsübersicht](../README.md)

## Neuere Referenzfälle

| Datei | Erwartung |
|---|---|
| `flow-graph.valid.mqtt-battery.json` | Gültiger Referenzfall; Erwartung bleibt durch Schema und Validator-Tests festgelegt. |
| `flow-graph.valid.mqtt-battery-protected.json` | Gültiger Referenzfall; Erwartung bleibt durch Schema und Validator-Tests festgelegt. |
| `flow-graph.valid.http-battery.json` | Gültiger Referenzfall; Erwartung bleibt durch Schema und Validator-Tests festgelegt. |
| `mqtt-measurement-samples.valid.box-halle-2-nachlieferung.json` | Gültiger Referenzfall; Erwartung bleibt durch Schema und Validator-Tests festgelegt. |
| `mqtt-measurement-samples.invalid.herkunft-unter-2.0.json` | Ungültiger Grenzfall; Erwartung bleibt durch Schema und Validator-Tests festgelegt. |
| `mqtt-measurement-samples-2.1.valid.ms06-letzter-wert-z5a.json` | Gültiger Referenzfall; Erwartung bleibt durch Schema und Validator-Tests festgelegt. |
| `mqtt-measurement-samples-2.1.valid.ms06-erster-wert-z5b.json` | Gültiger Referenzfall; Erwartung bleibt durch Schema und Validator-Tests festgelegt. |
| `mqtt-measurement-samples-2.1.valid.ohne-herkunftsfelder.json` | Gültiger Referenzfall; Erwartung bleibt durch Schema und Validator-Tests festgelegt. |
| `mqtt-measurement-samples-2.1.invalid.fremdes-feld-messstelle.json` | Ungültiger Grenzfall; Erwartung bleibt durch Schema und Validator-Tests festgelegt. |
| `mqtt-measurement-samples-2.1.invalid.komponente-als-kennzeichen.json` | Ungültiger Grenzfall; Erwartung bleibt durch Schema und Validator-Tests festgelegt. |
| `edge-entity.valid.registry-push-roles.json` | Gültiger Referenzfall; Erwartung bleibt durch Schema und Validator-Tests festgelegt. |
| `mqtt-events-2.1.valid.restart.json` | Gültiger Referenzfall; Erwartung bleibt durch Schema und Validator-Tests festgelegt. |
| `mqtt-events-2.1.valid.layout-and-gap.json` | Gültiger Referenzfall; Erwartung bleibt durch Schema und Validator-Tests festgelegt. |
| `mqtt-events-2.1.invalid.handover-from-box.json` | Ungültiger Grenzfall; Erwartung bleibt durch Schema und Validator-Tests festgelegt. |
| `events-raw.valid.box-range-limit.json` | Gültiger Referenzfall; Erwartung bleibt durch Schema und Validator-Tests festgelegt. |
| `events-raw.valid.cloud-handover.json` | Gültiger Referenzfall; Erwartung bleibt durch Schema und Validator-Tests festgelegt. |
| `events-raw.valid.writer-duplicate-conflict.json` | Gültiger Referenzfall; Erwartung bleibt durch Schema und Validator-Tests festgelegt. |
| `events-raw.invalid.box-without-envelope.json` | Ungültiger Grenzfall; Erwartung bleibt durch Schema und Validator-Tests festgelegt. |
