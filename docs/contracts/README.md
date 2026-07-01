# Contracts

These are the **binding interface contracts** for Voltpilot-EMS (architecture section 20, item 8).
They are first-class artifacts: services implement against them, and changes here are breaking changes that must be versioned.

| File | Contract | Owner boundary |
|---|---|---|
| [`mqtt-telemetry.schema.json`](./mqtt-telemetry.schema.json) | MQTT topic convention + telemetry payload published by the edge. Includes the observed §14a effective power limit (`grid_limit_kw`). | Node-RED edge -> EMQX -> Ingest |
| [`telemetry-raw.event.schema.json`](./telemetry-raw.event.schema.json) | Redpanda `telemetry.raw` event written by Ingest and consumed by the TimescaleDB-Writer (and future consumers). | Ingest -> Redpanda -> Writer |
| [`mqtt-schedule.schema.json`](./mqtt-schedule.schema.json) | Battery dispatch plan (24h, 15-min slots) published retained by the optimizer and executed slot-wise by the edge. Includes fail-safe semantics (`x-failsafe`). | Optimization -> EMQX -> Node-RED edge |
| [`openapi.yaml`](./openapi.yaml) | Portal API REST surface (stub) consumed by the frontend. | API <-> Frontend |

## MQTT topic convention

```
ems/{tenant_id}/{site_id}/{device_id}/telemetry   # Edge -> Cloud, measurements (QoS1)
ems/{tenant_id}/{site_id}/{device_id}/status      # Edge -> Cloud, heartbeat/health
ems/{tenant_id}/{site_id}/{device_id}/schedule    # Cloud -> Edge, schedule (retained)
ems/{tenant_id}/{site_id}/{device_id}/command     # Cloud -> Edge, ad-hoc command
ems/{tenant_id}/{site_id}/{device_id}/config      # Cloud -> Edge, configuration (retained)
```

## Versioning

Every payload/event carries `schema_version`. Bump it on any breaking change and keep consumers tolerant of unknown additive fields where possible.
