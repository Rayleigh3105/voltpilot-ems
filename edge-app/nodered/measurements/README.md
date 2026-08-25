# Additional measurement runtime

This directory is the additive, read-only measurement runtime. It is packaged
into the Node-RED image independently of the frozen `edge/telemetry` flow.

The core bridges these local topics to the identity-bound mTLS cloud topics:

| Local topic | Direction | Retained | Purpose |
|---|---|---:|---|
| `edge/measurements/config` | core -> Layer 1 | yes | complete desired poll plan |
| `edge/measurements/config-status` | Layer 1 -> core | yes | accepted/rejected revision |
| `edge/measurements/samples` | Layer 1 -> core | no | actually read raw samples |

`MeasurementRuntime.apply()` builds a candidate plan and swaps the active plan
and due map with one pointer assignment only after all validation and hard
budgets pass. A rejected revision therefore leaves the previous plan running.
The scheduler always drains control work before measurement polls.

The runtime has no write primitive. Customer-specific Layer-1 wiring injects
the existing read transports through `readModbus` and `readJSON`, and forwards
OCPP `MeterValues` to `onMeterValues`. The injected Modbus reader must use the
same per-device arbiter as control traffic; measurement requests carry
`priority: "measurement"`. The implementation groups adjacent registers into
blocks of at most 120 words and enforces D5 before activation:

- soft warning above 120 samples/minute;
- hard maximum 600 samples/minute;
- hard maximum 30 wire requests/minute;
- hard maximum 20% estimated bus duty.

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
