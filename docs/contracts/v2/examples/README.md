# v2 contract fixtures

Machine-checkable examples for every v2 schema: at least two valid payloads and one invalid
counter-example each. Validate with ajv (JSON Schema 2020-12, `strict: false` because the
schemas carry `x-*` annotation keywords like the 1.0 contracts):

```js
const Ajv2020 = require('ajv/dist/2020').default;
const ajv = new Ajv2020({ strict: false });
// add formats (ajv-formats) or register 'date-time'/'uuid' as pass-through
```

| Fixture | Schema | Expectation |
|---|---|---|
| `edge-desired.valid.flow-setpoint.json` | edge-desired | valid — a flow's wallbox charge desire (class `flow`) |
| `edge-desired.valid.override-onoff.json` | edge-desired | valid — boost `override: true` on_off desire, 1 h TTL |
| `edge-desired.valid.arbitration-clamped.json` | edge-desired | valid — arbitration event: won but clamped by `guard:solar_only_charge` |
| `edge-desired.invalid.missing-ttl.json` | edge-desired | **invalid** — `ttl_s` missing (no immortal desires; fails the `desired` branch, and the `arbitration` branch by shape) |
| `mqtt-schedule-2.0.valid.two-entities.json` | mqtt-schedule-2.0 | valid — storage + PV entity, site peak target, per-entity reserve |
| `mqtt-schedule-2.0.valid.minimal-battery.json` | mqtt-schedule-2.0 | valid — minimal single-storage plan, explicit `charge_from_grid_allowed: true` |
| `mqtt-schedule-2.0.invalid.v1-command-key.json` | mqtt-schedule-2.0 | **invalid** — uses the v1 field name `battery_setpoint_kw` as a command key (not in the 2.0 vocabulary; `additionalProperties: false`) |
| `flow-graph.valid.pv-surplus-heatrod.json` | flow-graph | valid — read → threshold → on_off control, interval + value-change triggers, explicit claim |
| `flow-graph.valid.market-battery.json` | flow-graph | valid — strategy node with `delegated: true` claim, slot-boundary trigger |
| `flow-graph.valid.guided-setpoint.json` | flow-graph | valid — the guided "Sollwert setzen" rule: Bedingung → `vp.logic.if` → control `setpoint` (#519 H3-a) |
| `flow-graph.valid.selfconsumption-starter.json` | flow-graph | valid — the AE7 starter / pilot chain: delegated strategy → control `plan`, control derives NO own claim (#519 MEDIUM-5) |
| `flow-graph.valid.two-window-and.json` | flow-graph | valid — two topic-less `vp.schedule.window` branches through `vp.logic.and` (#519 H3-b) |
| `flow-graph.invalid.unknown-trigger.json` | flow-graph | **invalid** — trigger `kind: "cron"` is not in the trigger enum |
| `flow-artifact.valid.artifact.json` | flow-artifact | valid — one compiled artifact (manifest + nodered-tabs bundle with `@vp-flow` tab marker) |
| `flow-artifact.valid.deployment.json` | flow-artifact | valid — retained deployment set for one device carrying that artifact |
| `flow-artifact.invalid.bad-hash.json` | flow-artifact | **invalid** — `content_hash` is not `sha256:<64 hex>` (md5 prefix) |
| `mqtt-telemetry-2.0.valid.three-entities.json` | mqtt-telemetry-2.0 | valid — the three pilot entities (battery-hybrid + producer + grid-meter), per-entity ts override |
| `mqtt-telemetry-2.0.valid.single-entity.json` | mqtt-telemetry-2.0 | valid — minimal single grid-meter uplink |
| `mqtt-telemetry-2.0.invalid.string-channel.json` | mqtt-telemetry-2.0 | **invalid** — channel value is a string (channels are always numbers) |
| `edge-entity.valid.config-battery.json` | edge-entity | valid — retained per-entity config for a battery-hybrid (guard limits + self-consumption failsafe) |
| `edge-entity.valid.config-wallbox.json` | edge-entity | valid — retained per-entity config for a wallbox (E1b consumer type: `max_consumption_kw`, `release` failsafe) |
| `edge-entity.valid.registry-push.json` | edge-entity | valid — full `…/v2/entities` push carrying the three pilot entity descriptors |
| `edge-entity.valid.registry-push-consumers.json` | edge-entity | valid — push carrying the E1b consumer types (wallbox + heating-rod + generic-load incl. a `mode` capability) |
| `edge-entity.valid.telemetry-producer.json` | edge-entity | valid — local per-entity telemetry of a producer |
| `edge-entity.invalid.malformed-entity-type.json` | edge-entity | **invalid** — `entity_type: "Wallbox 11kW!"` violates the kebab-case type pattern (the vocabulary is open since E1b, but never free-form; fails every oneOf branch) |

The invalid fixtures fail at the JSON-Schema level by design (an ajv run proves it). Semantic
validator rules that JSON Schema cannot express (port type compatibility, cycles, exclusive
resources — [flow-graph.md](../flow-graph.md) §4) are NOT exercised here; they get executable
fixtures with the platform validator (E2).
