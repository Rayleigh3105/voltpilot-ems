# Telemetrie-Ingest

Konsumiert v1-/v2-Telemetrie und zusätzliche Messwerte über MQTT, prüft Envelope und Geräteidentität und veröffentlicht Ereignisse nach Redpanda. Ungültige Eingänge werden verworfen und protokolliert.

## Start und Tests

Java 21; Befehle in diesem Verzeichnis:

```bash
./mvnw spring-boot:run
./mvnw test
./mvnw clean package
```

Standardport: `8091`. Health: `/health`; Kubernetes: `/health/liveness` und `/health/readiness`. Testcontainers-Fälle benötigen Docker.

Konfiguration: [`application.yml`](src/main/resources/application.yml), lokale/prod Compose-Dateien. Zugangsdaten nicht aus Entwicklungsbeispielen in Produktion übernehmen.

## Referenzen

[Verträge](../../docs/contracts/README.md), [MQTT-Sicherheit](../../docs/security-mqtt.md); [Betriebsvertrag](../../docs/k8s-readiness.md).

## Ereignisse und v2-Annahme

| MQTT-Suffix | Redpanda |
|---|---|
| `telemetry` | `telemetry.raw` |
| `v2/telemetry` | `telemetry-v2.raw` (vorhandene `seq` bleibt erhalten) |
| `v2/measurement-samples` | `measurements.raw` (2.0 und additive 2.1) |
| `v2/events` / v2-Annahmefehler | `events.raw` |

Auf den v2-Strecken verwirft ein fehlerhafter Wert nur sich selbst. Version, Form oder Identität können den gesamten Umschlag ablehnen. Mehr als 300 s Zukunft ergibt `clock_ahead`, mehr als 90 Tage Vergangenheit `too_old`; je Umschlag/Grund werden Ablehnungen als Ereignis gebündelt. v1 bleibt bei Log und Verwerfen.

`events.raw` muss in der tatsächlichen Produktions-Redpanda-Instanz existieren. `EventsTopicPruefung` prüft höchstens alle 10 s mit 3-s-Frist und merkt sich einen Erfolg für die Prozesslaufzeit. Solange das Topic fehlt:

- Messwertpfade laufen ohne Ereignisse weiter und quittieren nach bestätigter Redpanda-Schreibung; `voltpilot.ingest.events.undelivered` zählt Ausfälle.
- Der Box-Ereignisadapter verbindet sich noch nicht.
- Readiness (`readinessState,eventsTopic`) bleibt DOWN; dies hält den MQTT-Messwertkonsum nicht an.

Nach Topic-Erkennung gilt die Quittierung erst nach allen bestätigten Sendungen. Tests: `DatenannahmeTest`, `MesszeitregelTest`, `BoxEventsValidatorTest`; die bestehenden Pipe-Tests benötigen Testcontainers.
