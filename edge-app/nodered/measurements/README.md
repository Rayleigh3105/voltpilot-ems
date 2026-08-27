# Additional measurement runtime

This directory is the additive, read-only measurement runtime. It is packaged
into the Node-RED image independently of the frozen `edge/telemetry` flow.

The core bridges these local topics to the identity-bound mTLS cloud topics:

| Local topic | Direction | Retained | Purpose |
|---|---|---:|---|
| `edge/measurements/config` | core -> Layer 1 | yes | complete desired poll plan |
| `edge/measurements/config-status` | Layer 1 -> core | yes | accepted/rejected revision |
| `edge/measurements/samples` | Layer 1 -> core | no | actually read raw samples |

Two further retained documents are READ (never written) for the per-component
binding: `edge/sources/config` (the source list, i.e. the connections) and
`edge/entities/+/config` (the registry descriptors, i.e. the `edge_source_id`
pin). See "Which device a point is read over" below.

`MeasurementRuntime.apply()` builds a candidate plan and swaps the active plan
and due map with one pointer assignment only after all validation and hard
budgets pass. A rejected revision therefore leaves the previous plan running.
The scheduler always drains control work before measurement polls.

The runtime has no write primitive. The shipped `vp-measurements` palette node
is instantiated in `flows.json`; it consumes the retained config, injects the
read-only Modbus/Solarman/HTTP transports, discovers SunSpec model bases and
reads Model 160's live `N` field, receives OCPP `MeterValues` from Core, ticks the
runtime and publishes status/samples. The `edge/setpoint` lane opens a control
priority window before measurement requests. The implementation groups adjacent
registers into blocks of at most 120 words and enforces D5 before activation and
again over rolling runtime windows:

- soft warning above 120 samples/minute;
- hard maximum 600 samples/minute;
- hard maximum 30 wire requests/minute;
- hard maximum 20% estimated bus duty.

## Which device a point is read over (Geraeteseite Stufe 3c)

A selection may name the COMPONENT it belongs to (`entity_id`, cloud Stufe 3b).
`measurement-binding.js` is the pure rule that turns that name into the device
the point is read over; the planner keys its blocks and HTTP groups on the
resulting target, and the runtime keeps the read words PER TARGET.

    no entity_id                      -> the primary inverter (the pre-3c behaviour)
    pin 'inverter'                    -> the primary inverter
    pin naming a reported source      -> that source's connection
    composed type without a pin       -> the primary inverter (it IS its channels)
    anything else                     -> REFUSED, reason binding_unavailable

**A binding that cannot be resolved is refused, never read against the primary.**
Before this stage every point was polled over `edge/inverter/config`, so a
register selected on a second Fronius or a wallbox was read from the Deye's
address - a wrong value on a right-looking point. The refusal is self-healing:
the node re-applies the plan whenever the registry or the source list changes.

Consequences worth knowing:

- The composed set (`battery-hybrid`, `grid-meter`, `house-load`) is copied from
  the core's `internal/entities/compose.go` `composedType` and pinned against it
  by a test - **change both together**. They carry no pin because they ARE the
  primary inverter's own channels.
- A SunSpec point's address is model-relative, so each target needs its OWN
  discovery walk. A target without one is refused as `driver_unavailable` rather
  than reading the primary's model base on another device.
- The CONNECTION is resolved at READ time (`resolveDevice`), not baked into the
  plan: a source that vanished between plan and poll produces a gap, never a
  read of the primary.
- OCPP MeterValues arrive from the core and have no connection, so a binding
  neither selects nor refuses one there; OCPP attribution stays device-wide.
- Samples still carry only `point_key` - the SAMPLE path has no component
  dimension, so "which component measured this" stays a cloud-side question
  answered by the selection.
- A (re)connect replays every retained document at once, so the binding-driven
  re-applies COALESCE into one; a new PLAN still applies synchronously, because
  its status is the acknowledgement the cloud waits for.

The catalog is generated from `catalog/measurement-points/catalog.json` with
`tools/package_edge_runtime.py`. Never edit the packaged JSON or catalog SQL by
hand. Run the generator with `--check` in validation.

Honesty rules are deliberate: no response means no sample; `raw` always comes
from the register word(s), HTTP/RPC field, or OCPP value that was read. A scale
factor or vendor rule that is not provable omits `decoded`; it never reconstructs
raw, invents a unit, or emits a synthetic zero. SunSpec model 160 module keys
are resolved from the live discovered model base and module count.

Offline driver/plan/backpressure benches:

```bash
node --test measurements/*.test.js
```
