# edge/node-red - Edge Runtime (thin)

**Runtime:** Node-RED (container, ARM+x86)
**Responsibility (architecture section 6):** read inverters via Modbus TCP/SunSpec (incl. the observed effective §14a limit), publish telemetry over MQTT QoS1, execute the retained cloud schedule slot-by-slot, and hold a self-consumption default on outage.
Intelligence stays in the cloud; the edge is deliberately thin (no local optimization, no strategy).

## The five thin flows (`flows.json`)

The flows are generated for readability but committed as plain Node-RED JSON; open them in the editor at http://localhost:1880.

1. **Acquisition** - polls the (simulated) SunSpec inverter over Modbus TCP (FC3, holding registers 0..8) every 2s and normalizes the readings, **including the observed effective §14a active-power limit** (`WMaxLimPct`).
2. **Publish** - builds the binding telemetry payload (`docs/contracts/mqtt-telemetry.schema.json`) and publishes it to EMQX at **QoS1** on `ems/{tenant_id}/{site_id}/{device_id}/telemetry`, plus a light heartbeat on `.../status`. Plain TCP in dev; structured so mTLS can be enabled later (see below).
3. **Schedule-Exec** - subscribes to the **retained** `.../schedule` topic, caches it, and every tick writes the setpoint of the 15-min slot covering *now* to the inverter (via Guards).
4. **Default-Watchdog** - when the schedule is missing/stale (or the connection is lost), falls back to a deliberately simple **self-consumption default**: battery follows `PV - load` (charge surplus, discharge to cover deficit). No price/time-window logic.
5. **Guards** - local plausibility / limit checks before **any** write: clamp charge/discharge power, enforce SoC bounds, and keep the commanded battery power inside the observed §14a envelope. Then writes the battery setpoint register (FC6, addr 40).

Schedule-Exec and Default-Watchdog are mutually exclusive on schedule freshness (20-min staleness window), so exactly one drives the setpoint at a time.

## Simulated SunSpec Modbus source

There is no hardware in dev, so [`edge/sim/sunspec-sim.js`](../sim/sunspec-sim.js) provides a small SunSpec-style Modbus TCP server (inverter + battery). It models PV, load, SoC, grid coupling and a periodically throttled §14a limit (`WMaxLimPct` 100% -> 40%), obeys battery-setpoint writes (so slot-wise execution is observable), and logs every setpoint write.
Its compact register map (and the mapping to SunSpec models 103/124/123/203) is documented at the top of that file; the Node-RED decode uses the same scale factors.

## Run the edge (dev)

The edge is guarded behind the compose `edge` profile, so `docker compose up -d` stays backbone-only.

```bash
cp .env.example .env                     # once
docker compose up -d emqx                # broker (backbone)
docker compose --profile edge up -d --build edge-sim edge-nodered
docker compose logs -f edge-sim          # watch setpoint writes
# editor: http://localhost:1880 ; sim Modbus on host localhost:15020
docker compose --profile edge down       # stop the edge (and backbone)
```

Standalone Node-RED editor (no compose, no MQTT/Modbus connectivity) still works for inspecting the flows:

```bash
docker build -t voltpilot-edge edge/node-red && docker run --rm -p 1880:1880 voltpilot-edge
```

## Topic + payload it emits

Topic: `ems/{tenant_id}/{site_id}/{device_id}/telemetry` (QoS1). Device identity + battery envelope come from env (`VP_TENANT_ID`, `VP_SITE_ID`, `VP_DEVICE_ID`, `VP_BATT_*`, `VP_SOC_*` in `settings.js`); defaults mirror the dev seed in `infra/local/timescale/01-init.sql`.

```json
{
  "schema_version": "1.0",
  "tenant_id": "00000000-0000-0000-0000-000000000001",
  "site_id": "00000000-0000-0000-0000-000000000002",
  "device_id": "00000000-0000-0000-0000-000000000003",
  "ts": "2026-07-01T08:58:45.827Z",
  "seq": 24,
  "measurements": {
    "power_kw": 2.29,
    "soc_pct": 55.1,
    "pv_power_kw": 16.9,
    "load_kw": 9.58,
    "grid_limit_kw": 50
  }
}
```

`grid_limit_kw` is the **observed** §14a envelope (`WMaxLimPct/100 * grid-connection nameplate`); the EMS only observes it.

### Schedule payload the edge expects (Cloud -> Edge, retained)

There is **no frozen schedule contract in `docs/contracts` yet** (only telemetry is frozen). Pending that, the edge consumes this shape on `.../schedule`:

```json
{
  "schema_version": "1.0",
  "tenant_id": "…", "site_id": "…", "device_id": "…",
  "issued_at": "2026-07-01T09:00:00Z",
  "slot_minutes": 15,
  "slots": [
    { "start": "2026-07-01T09:00:00Z", "battery_setpoint_kw": -25.0 },
    { "start": "2026-07-01T09:15:00Z", "battery_setpoint_kw": 30.0 }
  ]
}
```

`battery_setpoint_kw`: **+ = charge, - = discharge**. The edge picks the slot whose `[start, start+slot_minutes)` contains *now*.

## Test end-to-end

With the stack up (`emqx` + `edge` profile):

```bash
T='ems/00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002/00000000-0000-0000-0000-000000000003'

# 1) capture telemetry (incl. §14a grid_limit_kw)
docker run --rm --network voltpilot_default eclipse-mosquitto:2 \
  mosquitto_sub -h emqx -p 1883 -t "$T/telemetry" -C 1 -v

# 2) publish a retained schedule; watch edge-sim log the slot's setpoint write.
# Anchor the slot to the current 15-min boundary (UTC) so it covers 'now';
# otherwise fn-slot finds no active slot and nothing is written.
START=$(node -e "const d=new Date();d.setUTCMinutes(Math.floor(d.getUTCMinutes()/15)*15,0,0);console.log(d.toISOString())")
docker run --rm --network voltpilot_default eclipse-mosquitto:2 \
  mosquitto_pub -h emqx -p 1883 -t "$T/schedule" -q 1 -r \
  -m "{\"schema_version\":\"1.0\",\"slot_minutes\":15,\"slots\":[{\"start\":\"$START\",\"battery_setpoint_kw\":-25}]}"
docker compose logs -f edge-sim   # -> "[sim] setpoint write: battery = -25.00 kW"
```

Telemetry conformance to the contract was validated with ajv (2020-12) against `docs/contracts/mqtt-telemetry.schema.json`.

## mTLS (production)

Dev uses plain TCP to `emqx:1883`. The broker config node is isolated so production provisioning flips it to `usetls: true` on 8883 with the device's x.509 client cert/key (EMQX already exposes 8883). The edge makes **only outbound** MQTT connections and exposes no inbound ports; identity + credentials + the concrete flows are provisioned per device (Mender OTA, A/B + rollback). All future work.

## Status

Runnable end-to-end against the local stack via the simulator. Real Modbus/SunSpec hardware wiring, mTLS device identity, and OTA are future work.
