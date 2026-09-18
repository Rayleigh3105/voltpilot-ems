# v1-Vertragsbeispiele

Ausführbare JSON-Fixtures für Schema- und Laufzeitprüfungen. Dateinamen und Inhalte werden von Tests referenziert; Umbenennungen mit den konsumierenden Tests abstimmen.

| Fixture-Gruppe | Gültig | Negativfälle |
|---|---:|---:|
| `mqtt-charging-boost.*.json` | 2 | 1 |
| `mqtt-charging-config.*.json` | 5 | 1 |
| `mqtt-control-certification.*.json` | 2 | 1 |
| `mqtt-ota-target.*.json` | 2 | 1 |
| `mqtt-probe.*.json` | 12 | 3 |
| `mqtt-register-write.*.json` | 6 | 1 |
| `mqtt-schedule.*.json` | 5 | 4 |
| `ota-release-manifest.*.json` | 2 | 1 |

`valid` muss die jeweils geprüfte Regel erfüllen; `invalid` benennt den gezielten Verstoß. Negative Beispiele nicht mit beliebigen Zusatzfeldern ungültig machen. Datumswerte sind eingefrorene Testdaten, keine aktuellen Fahrpläne.

## Wichtige Unterschiede

- Boolesche Fahrplanpflichten sind keine kW-Sollwerte; negative Einspeisegrenzen sind ungültig. Semantik im jeweiligen Vertrag und [Optimierer](../../../services/optimization/README.md) nachlesen.
- OTA-Manifeste pinnen Image-Digests; ein Tag wie `latest` genügt nicht.
- Registerschreibaufträge und Ergebnisse werden auf API- und Geräteseite geprüft. Eine Quittung ersetzt keine Messwirkung.
- `mqtt-charging-config`: fehlende Patch-Felder erhalten bestehende Werte; `charge_points` ergänzt Kennungen. Entfernen erfolgt ausdrücklich über `removed_charge_point_ids`; Tombstones müssen in späteren retained Dokumenten erhalten bleiben.
- `mqtt-charging-boost` ist ein zeitlich begrenzter Einmalauftrag, nicht retained. `requested_at` begrenzt auch verspätete Zustellung; `cancel` nimmt die Freigabe zurück.

Konsumenten: Optimierung `tests/test_contract.py`; Go-Core `internal/plan`, `otaverify`, `probe`, `registerwrite` und Agent-Tests; API-Publisher/-Listener. [Schemaübersicht](../README.md)

## Ergänzende Fälle

- `mqtt-schedule.invalid.limit-discharge-not-boolean.json`: `limit_discharge_to_load` ist eine boolesche Erlaubnis, kein zweiter kW-Sollwert.
- `mqtt-probe.valid.test-connection-battery*.json`: MQTT-/HTTP-Vorschau mit `samples`; kein Empfang bedeutet `count: 0` ohne erfundenen Wert. HTTP-Geheimnisse gehören nur in Probe/Registry.
- `mqtt-charging-config.valid.steuerart-je-saeule.json`: fehlende Säulenwahl übernimmt den Anlagenstandard; fehlende Rahmenfelder erhalten den Boxwert.
- `mqtt-charging-config.valid.fahrzeug-profile*.json`: vollständige Profil-Liste je Box-`tag_ref`; eine leere Liste entfernt alle Profile. Der Cloud-Journalbezug ist keine gültige Kartenkennung.
- `mqtt-probe.valid.wago-kopf*.json`: der Op `wago_kopf` liest NUR den Kopf eines VoltPilot-Registerbilds WAGO v1. Ein Feld, das die Lesung nicht ergeben hat, fehlt; bei fremder Hauptversion steht nur die Version da, nie Kartenzahl oder Herzschlag. `mqtt-probe.invalid.wago-kopf-without-address.json`: ohne Basisadresse gibt es keinen Kopf - der Kopf beginnt genau dort.
- `mqtt-charging-boost.valid.laden-pausieren.json`: `action: pause` stoppt nur diesen Ladevorgang; fehlende `action` behält den bisherigen Voll-Laden-Boost.
