# Contracts

These are the **binding interface contracts** for Voltpilot-EMS (architecture section 20, item 8).
They are first-class artifacts: services implement against them, and changes here are breaking changes that must be versioned.

| File | Contract | Owner boundary |
|---|---|---|
| [`mqtt-telemetry.schema.json`](./mqtt-telemetry.schema.json) | MQTT topic convention + telemetry payload published by the edge. Includes the observed §14a effective power limit (`grid_limit_kw`). | Node-RED edge -> EMQX -> Ingest |
| [`telemetry-raw.event.schema.json`](./telemetry-raw.event.schema.json) | Redpanda `telemetry.raw` event written by Ingest and consumed by the TimescaleDB-Writer (and future consumers). | Ingest -> Redpanda -> Writer |
| [`mqtt-schedule.schema.json`](./mqtt-schedule.schema.json) | Battery dispatch plan (24h, 15-min slots) published retained by the optimizer and executed slot-wise by the edge. Includes fail-safe semantics (`x-failsafe`). | Optimization -> EMQX -> Node-RED edge |
| [`mqtt-provisioning.schema.json`](./mqtt-provisioning.schema.json) | Zero-touch onboarding handshake: device hello on `provision/{ref}/hello`, cloud answers claimed refs with the RETAINED identity config on `provision/{ref}/config`. Additive - the telemetry/schedule contracts are unchanged. | Device -> EMQX -> Ingest resolver (+ portal api at claim time) |
| [`mqtt-ocpp-events.schema.json`](./mqtt-ocpp-events.schema.json) | Privacy-redigiertes, dauerhaft am Edge gejournaltes OCPP-1.6 Call/CallResult/CallError-/Verbindungsereignis (QoS1, nicht retained). Reine Station→Cloud-Sichtbarkeit, kein Command-Downlink. | Edge-App CSMS -> EMQX -> API |
| [`openapi.yaml`](./openapi.yaml) | Portal API REST surface (stub) consumed by the frontend. | API <-> Frontend |

## MQTT topic convention

```
ems/{tenant_id}/{site_id}/{device_id}/telemetry   # Edge -> Cloud, measurements (QoS1)
ems/{tenant_id}/{site_id}/{device_id}/status      # Edge -> Cloud, heartbeat/health
ems/{tenant_id}/{site_id}/{device_id}/schedule    # Cloud -> Edge, schedule (retained)
ems/{tenant_id}/{site_id}/{device_id}/command     # Cloud -> Edge, ad-hoc command
ems/{tenant_id}/{site_id}/{device_id}/config      # Cloud -> Edge, configuration (retained)
ems/{tenant_id}/{site_id}/{device_id}/v2/ocpp-events # Edge -> Cloud, privacy-safe OCPP journal (QoS1)

provision/{ref}/hello                             # Device -> Cloud, zero-touch hello (QoS1, retried)
provision/{ref}/config                            # Cloud -> Device, claimed identity (retained)
```

## Versioning

Every payload/event carries `schema_version`. Bump it on any breaking change and keep consumers tolerant of unknown additive fields where possible.
