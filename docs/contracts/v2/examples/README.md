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
| `mqtt-schedule-2.0.valid.consumer-dispatch.json` | mqtt-schedule-2.0 | valid — the Verbrauchssteuerung Inkrement-2 publisher shape: three `kind: "consumer"` entities (`setpoint_kw` for continuous, `on_off` for on/off consumers, a 0/false slot IS the plan); read BY PATH by the Go executor test (`plan2_test.go`) and validated by `test_contract_v2.py` |
| `mqtt-schedule-2.0.invalid.v1-command-key.json` | mqtt-schedule-2.0 | **invalid** — uses the v1 field name `battery_setpoint_kw` as a command key (not in the 2.0 vocabulary; `additionalProperties: false`) |
| `flow-graph.valid.pv-surplus-heatrod.json` | flow-graph | valid — read → threshold → on_off control, interval + value-change triggers, explicit claim |
| `flow-graph.valid.market-battery.json` | flow-graph | valid — strategy node with `delegated: true` claim, slot-boundary trigger |
| `flow-graph.valid.guided-setpoint.json` | flow-graph | valid — the guided "Sollwert setzen" rule: Bedingung → `vp.logic.if` → control `setpoint` (#519 H3-a) |
| `flow-graph.valid.market-starter.json` | flow-graph | valid — the AE7 starter / pilot chain (Profil `arbitrage`): delegated strategy → control `plan`, control derives NO own claim (#519 MEDIUM-5, D-13) |
| `flow-graph.valid.two-window-and.json` | flow-graph | valid — two topic-less `vp.schedule.window` branches through `vp.logic.and` (#519 H3-b) |
| `flow-graph.invalid.unknown-trigger.json` | flow-graph | **invalid** — trigger `kind: "cron"` is not in the trigger enum |
| `flow-graph.valid.consumer-reactive.json` | flow-graph | valid — a GENERATED consumer-policy flow (D-19): `origin` marker + one `vp.consumer.reactive` node (must_run availability rule + an ODER mix of a precompiled price window and a hysteresis SoC signal) |
| `flow-graph.invalid.reactive-without-origin.json` | flow-graph | **invalid** — a `vp.consumer.reactive` node in a document WITHOUT the server-stamped consumer-policy `origin`; schema-conform (JSON Schema cannot express the rule), refused by the validator twins + flowc (D-19) |
| `flow-graph.valid.modbus-device.json` | flow-graph | valid — the GENERATED read flow of ONE self-built Modbus device (Einheitsmodell Stufe 3): `origin.kind: "modbus-device"` + one free `vp.modbus.read` per channel, each mapped onto its component's measure channel; `flow_version` IS the definition version |
| `flow-graph.valid.mqtt-battery.json` | flow-graph | valid — the GENERATED read flow of ONE SELF-CONNECTED battery over a local MQTT broker (P5 Ebene 1, `vp-deye-diybms-luecke-l5` §3.2b): `origin.kind: "mqtt-device"` + exactly ONE generated-only `vp.mqtt.read` whose user-defined field mapping turns 11×16 DIYBMS cell topics (`emon/diybms/+/+`, `.voltage`) into `cell_min_mv`/`cell_max_mv` via the `min`/`max` aggregate — one broker connection per device, never one per channel. SINCE P5b (Ebene 2) it additionally carries the generated-only `vp.soc.derive` on an EDGE behind the read node: two OCV→SoC curves (the customer's measured tables), conservative minimum, publishing `soc_pct` together with its origin `soc_source_code` |
| `flow-graph.valid.mqtt-battery-protected.json` | flow-graph | valid — the SAME generated battery flow plus the SCHUTZ-/GRENZBAUSTEIN (P5c, `vp-deye-diybms-luecke-l5` §3.2b/§3.3): a LINEAR chain `vp.mqtt.read` → `vp.soc.derive` → generated-only `vp.bms.limit`, whose SoC→current staircase and cell-voltage hysteresis latch publish `charge_limit_a`/`discharge_limit_a`/`charge_allowed`/`discharge_allowed`. The staircases and the four thresholds are verbatim the customer's Node-RED flow (`limit-protection-vectors.json`). ⚠ Nothing in it WRITES: the limits are provided for the surface and as the guard cap (`guard:bms_limit`) — which is also why the two permission MAPPINGS of the sibling fixture are absent here, a channel has exactly one author |
| `flow-graph.valid.http-battery.json` | flow-graph | valid — the SAME self-connected battery read over an HTTP/JSON endpoint instead (P5-HTTP, `vp-deye-diybms-luecke-l5` §3.2b "Ebene 1, HTTP/JSON"): `origin.kind: "http-device"` + exactly ONE generated-only `vp.http.read` that GETs one JSON document per tick, with value PATHS instead of topic filters (`modules.*.exttemp` with the `max` aggregate is the HTTP counterpart of `emon/diybms/+/+`) and no `stale_s` at all — an HTTP answer is ONE point in time. The template case is DIYBMS v4 `/ha` with the `ApiKey` header. ⚠ The auth SECRET is deliberately absent: only the mode (and the header name) travel here, the value reaches the box in the registry push, because a flow document is readable through the portal API. The `vp.soc.derive` behind it is the SAME node as in the MQTT fixture — it works on channels, not on a transport |
| `flow-graph.invalid.origin-mixed-kinds.json` | flow-graph | **invalid** — an `origin` carrying the `modbus-device` kind together with the consumer-policy fields; each `origin` branch is closed (`additionalProperties: false`), so a document can never mix the two provenance vocabularies |
| `flow-artifact.valid.artifact.json` | flow-artifact | valid — one compiled artifact (manifest + nodered-tabs bundle with `@vp-flow` tab marker) |
| `flow-artifact.valid.deployment.json` | flow-artifact | valid — retained deployment set for one device carrying that artifact |
| `flow-artifact.invalid.bad-hash.json` | flow-artifact | **invalid** — `content_hash` is not `sha256:<64 hex>` (md5 prefix) |
| `mqtt-telemetry-2.0.valid.three-entities.json` | mqtt-telemetry-2.0 | valid — the three pilot entities (battery-hybrid + producer + grid-meter), per-entity ts override |
| `mqtt-telemetry-2.0.valid.single-entity.json` | mqtt-telemetry-2.0 | valid — minimal single grid-meter uplink |
| `mqtt-telemetry-2.0.invalid.string-channel.json` | mqtt-telemetry-2.0 | **invalid** — channel value is a string (channels are always numbers) |
| `mqtt-measurement-config.valid.json` | mqtt-measurement-config | valid — packaged catalog selection |
| `mqtt-measurement-config.valid.custom.json` | mqtt-measurement-config | valid — complete read-only custom Modbus input definition survives desired-state transport |
| `mqtt-measurement-config.valid.per-component.json` | mqtt-measurement-config | valid — additive `entity_id` binds one selection to one component (Stufe 3b); since Stufe 3c the edge resolves it to that component's device and refuses (`binding_unavailable`) when it cannot. The second entry keeps the device-wide box semantics |
| `mqtt-measurement-config.invalid.identity.json` | mqtt-measurement-config | **semantic invalid** — schema-valid payload whose tenant differs from the fixture topic identity; refused by the Core validator |
| `mqtt-measurement-config-status.valid.json` | mqtt-measurement-config-status | valid — monotone apply receipt |
| `mqtt-measurement-samples.valid.json` | mqtt-measurement-samples | valid — exact raw sample batch |
| `mqtt-measurement-samples.invalid.no-raw.json` | mqtt-measurement-samples | **invalid** — a sample may never invent or omit its wire/API raw value |
| `edge-entity.valid.config-battery.json` | edge-entity | valid — retained per-entity config for a battery-hybrid (guard limits + self-consumption failsafe) |
| `edge-entity.valid.config-wallbox.json` | edge-entity | valid — retained per-entity config for a wallbox (E1b consumer type: `max_consumption_kw`, `release` failsafe) |
| `edge-entity.valid.registry-push.json` | edge-entity | valid — full `…/v2/entities` push carrying the three pilot entity descriptors |
| `edge-entity.valid.registry-push-consumers.json` | edge-entity | valid — push carrying the E1b consumer types (wallbox + heating-rod + generic-load incl. a `mode` capability); the heating-rod carries the Inkrement-3 cycle-guard limits (`min_on_seconds`/`min_off_seconds`/`max_starts_per_day`), the wallbox `ramp_kw_per_min` |
| `edge-entity.valid.registry-push-roles.json` | edge-entity | valid — push carrying the AE1 role assignment (`role_assignment`, Befund L4): the SECOND grid meter is the customer's maßgebliche measurement, and a `generic-load` channel is re-purposed to `pv`. Absent on every plant without a stored assignment, so such a push stays byte-identical |
| `edge-entity.valid.telemetry-producer.json` | edge-entity | valid — local per-entity telemetry of a producer |
| `edge-entity.invalid.malformed-entity-type.json` | edge-entity | **invalid** — `entity_type: "Wallbox 11kW!"` violates the kebab-case type pattern (the vocabulary is open since E1b, but never free-form; fails every oneOf branch) |
| `consumer-policy.valid.heater.json` | consumer-policy | valid — the §10 heater: a `fixed_window` `must_run` at 13–14 plus a `reactive` `must_run` with an `any` (OR) of a cloud price signal and a local SoC signal with hysteresis |
| `consumer-policy.valid.wallbox-ranges.json` | consumer-policy | valid — a `reactive` `must_run` `percent` target gated on `consumer.vehicle_connected`, with a `continuous` `control_profile` carrying the D4 `power_ranges_kw` (1- vs 3-phase) |
| `consumer-policy.valid.pump-flexible.json` | consumer-policy | valid — the §10 pump: a `flexible_task` with a daily availability window, a contiguous 60-minute runtime demand and `grid_energy_policy: avoid` |
| `consumer-policy.invalid.percent-out-of-range.json` | consumer-policy | **invalid** — a `percent` target with `value: 150` exceeds the schema `maximum: 100` (JSON-Schema level; the semantic rules that JSON Schema cannot express live in `consumer-policy-vectors.json`) |

The invalid fixtures fail at the JSON-Schema level by design (an ajv run proves it). Semantic
validator rules that JSON Schema cannot express (port type compatibility, cycles, exclusive
resources — [flow-graph.md](../flow-graph.md) §4) are NOT exercised here; they get executable
fixtures with the platform validator (E2).
