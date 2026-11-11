# Telemetrie 2.0

Verbindlich: [Schema](mqtt-telemetry-2.0.schema.json). Eine Nachricht enthält Messkanäle mehrerer Entitäten. v1 bleibt auf seinem eigenen Topic bestehen.

```mermaid
flowchart LR
    E["Box: Entitäten und Messkanäle"] -->|"v2/telemetry"| I["Ingest: Envelope prüfen"]
    I -->|"telemetry-v2.raw"| W["Writer"] --> DB[("telemetry_v2")]
```

## Topic und Inhalt

`ems/{tenant_id}/{site_id}/{device_id}/v2/telemetry`: QoS 1, nicht retained, `schema_version: "2.0"`.

- `entities` ist nach Entitätskennung geordnet; jede Entität trägt eine flache numerische `channels`-Map. Optionales Entitäts-`ts` überschreibt den Envelope-Zeitpunkt.
- Fehlende Messungen werden weggelassen. Boolesche Zustände werden als 0/1 übertragen; keine erfundenen Nullwerte.
- Vorzeichen folgen der Capability: Batterie positiv laden, Netz positiv beziehen; Erzeugung nicht negativ.
- Ingest prüft Version, UUIDs, Zeitformat, Topic-/Payload-Identität sowie sichere Entitätskennungen und numerische Kanäle.
- Ingest verlangt keine bereits synchronisierte Registry-Entität und keine zentrale Kanal-Whitelist. Die fachliche Capability-Prüfung ist eine andere Grenze.

## Wiederholung und Frische

`ts` bleibt der ursprüngliche Messzeitpunkt, auch bei Replay. `received_at` beschreibt die Ankunft; Verbindungs-Liveness und Alter der Messung sind deshalb unterschiedliche Größen. Schreiben ist je `(entity_id, channel, time)` wiederholbar.

Ereignisvertrag: [telemetry-v2.raw](telemetry-v2-raw.event.schema.json). [Fixtures](examples/README.md), [Ingest](../../../services/ingest/README.md), [Writer](../../../services/timescale-writer/README.md).

Der Ingest übernimmt eine vorhandene `seq` und prüft v2-Werte einzeln. Zurückgewiesene Werte erzeugen Ereignisse auf `events.raw`; sie verwerfen nicht automatisch alle anderen Werte desselben Umschlags. [Datenannahme](../../../services/ingest/README.md).
