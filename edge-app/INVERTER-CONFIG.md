# Contract: `edge/inverter/config` (Wechselrichter-Auswahl)

The customer/operator picks their inverter **once** in the Edge-App local web UI
(`http://<geraet>:8484` → "Wechselrichter einrichten").
Layer 2 (`edge-app/core`, Go) persists that choice and publishes it **retained**
on the embedded local MQTT bus.
Layer 1 (`edge-app/nodered`) reads the retained message and self-wires the right
read adapter - **no Admin API, no flow edit per customer**.

This file is the binding contract between the two layers.
It is produced by [`core/internal/inverter`](core/internal/inverter/inverter.go)
(the `Catalog` + `Selection` types) and consumed by the Node-RED tranche.

> **Scope:** read/monitoring selection only. Nothing in this contract controls
> the inverter.

## Topic

| Topic | Direction | QoS | Retain |
|---|---|---|---|
| `edge/inverter/config` | core → Node-RED | 1 | **yes** |

Retain is load-bearing: a Node-RED that (re)connects to the bus after a reboot
receives the current selection immediately, without waiting for the next change.
The core (re-)publishes it at boot and on every change.

## Payload

```jsonc
{
  "schema_version": "1.0",
  "brand": "deye",                          // "deye" | "generic_modbus" | "fronius"
  "label": "Deye · SUN-12K-SG04LP3-EU",     // human label (brand · model)
  "model": "sun-12k-sg04lp3",               // the concrete model the customer picked
  "family": "hybrid_3p",                    // register-map / profile id (Node-RED routes on THIS)
  "communication": "solarman_v5",           // "solarman_v5" | "modbus_tcp" | "fronius_solar_api"
  "connection": { /* per communication, see below */ },
  "updated_at": "2026-07-03T12:00:00Z"      // RFC 3339, when the choice was saved
}
```

The customer selects an **individual inverter model** in the UI (no grouping
into families). `model` is that concrete choice; `family` is the register map it
resolves to and stays the field the Node-RED adapter routes on - so a
`SUN-12K-SG04LP3` (LV) can never be read with an HV profile. `model` is
**additive**: `schema_version` stays `"1.0"` and a consumer that only knows
`family` keeps working (unknown fields are ignored per the contract).

The **communication method is fixed per brand** (the captain's rule): a Deye is
always read through its WiFi datalogger via **Solarman-V5** (TCP 8899); a Fronius
is read via its local **Solar API** (HTTP/JSON); every other brand is generic
**Modbus TCP** (502). The client never sends `communication` or `label` - the
core derives both from the brand, so an inconsistent transport can't be
requested.

`connection` carries **only** the fields the chosen communication needs:

### `communication: "solarman_v5"` (Deye datalogger)

```jsonc
"connection": {
  "ip": "192.168.0.28",     // datalogger IP on the LAN
  "port": 8899,             // Solarman-V5 port (default 8899)
  "serial": "2985159064",   // DATALOGGER serial - NOT the inverter serial
  "mb_slave_id": 1,         // Modbus slave id (default 1)
  "invert_grid_sign": false,// flip grid import/export sign if calibration shows it
  "power_scale": 1          // 1 = Watt (default); 10 = decawatt HV firmware
}
```

`family` selects the Deye register map (see [`nodered/DEYE.md`](nodered/DEYE.md)):
`string` · `hybrid_1p` · `hybrid_3p` · `micro`. The customer never picks this
directly - it is derived from the chosen `model` (e.g. every `SUN-*-SG04LP3` LV
and `SUN-*-SG01HP3` HV model resolves to `hybrid_3p`).

> **`serial` is the DATALOGGER serial** (from the AP SSID `AP_<serial>` or the
> logger status page), not the inverter serial - the #1 config mistake. The UI
> says so inline.

### `communication: "modbus_tcp"` (everything else)

```jsonc
"connection": {
  "ip": "192.168.0.50",  // inverter / Modbus-TCP gateway IP
  "port": 502,           // Modbus TCP port (default 502)
  "unit_id": 1,          // Modbus unit id (default 1)
  "profile": "sunspec"   // register profile = the chosen family id
}
```

`family` is the Modbus/SunSpec profile id. Today: `sunspec` (the standard
SunSpec register model, matching the `edge/sim` SunSpec source; the profile is
decoded by the `PROFILES` map in `nodered/modbus-tcp.js`, additive per profile).

### `communication: "fronius_solar_api"` (Fronius)

```jsonc
"connection": {
  "ip": "192.168.0.20",       // Fronius inverter IP on the LAN
  "port": 80,                 // Solar API HTTP port (default 80)
  "insecure_tls": false,      // true = dial HTTPS + accept a self-signed cert (GEN24 firmware)
  "invert_grid_sign": false   // escape hatch, default off (Fronius sign already matches)
}
```

`family` is always `fronius_solar_api` (the Solar API is self-describing, so
there is no per-model register map). The edge does **one** HTTP GET to
`http(s)://{ip}:{port}/solar_api/v1/GetPowerFlowRealtimeData.fcgi` (Solar API
**v1**), exactly like Home Assistant, and maps `Site.P_PV`/`P_Grid`/`P_Load` +
`Inverters["1"].SOC` onto the canonical channels. No serial, unit id or auth is
needed. See [`nodered/FRONIUS.md`](nodered/FRONIUS.md) for the operator guide
(enabling the Solar API, the GEN24 self-signed-cert quirk, the v1-vs-v0 caveat).
Read-only; battery power (`P_Akku`) is used only for calibration, never
published (the cloud derives `battery_kw` from the power balance).

## Catalog (what the UI offers)

The UI form is fully data-driven from `GET /api/inverter` → `catalog`, so adding
a brand/model/field is additive (edit `DefaultCatalog()` in
`core/internal/inverter/inverter.go`) and needs no front-end change. Each brand
exposes a per-model list (`models`, the UI selection unit) plus its register-map
`families` (reference; each model carries the `family` it resolves to):

| brand | communication | models (selection unit) | register-map families |
|---|---|---|---|
| `deye` | `solarman_v5` | every `SUN-*` model individually (SG04LP3 LV incl. 12K, SG01HP3 HV, SG03LP1 1-phase, G03/G04 string, SUN*G3 micro) | `hybrid_3p`, `hybrid_1p`, `string`, `micro` |
| `fronius` | `fronius_solar_api` | `fronius_solar_api` (one generic entry; GEN24 / Symo / Primo / Symo Hybrid) | `fronius_solar_api` |
| `generic_modbus` | `modbus_tcp` | `sunspec` | `sunspec` |

Each `models[]` entry is `{id, label, family, note}` - `family` is the register
map that model reads with. The UI may sort/search the list, but the selection
unit is the individual model.

## HTTP API (backs the UI)

| Method | Path | Body / Response |
|---|---|---|
| `GET` | `/api/inverter` | `{ "catalog": Catalog, "selection": Selection\|null }` |
| `POST` | `/api/inverter` | body `{brand, model, connection}` (a bare `family` is accepted as a backward-compatible fallback when `model` is omitted); `200 {selection}` on success, `400 {error}` (German message) on a validation failure |

The current selection also appears on `GET /api/state` under `inverter`
(`{brand,label,model,family,communication,host,configured}`) so the dashboard can
show the configured model.

## Node-RED consumer (IMPLEMENTED)

The Layer-1 consumer is the **"Wechselrichter (automatisch)"** tab in
`nodered/flows.json` - it self-wires from this contract, no per-customer flow
edit:

- The **`vp-inverter-config`** palette node (`nodered/vp-palette/nodes/`)
  subscribes `edge/inverter/config` (retained) on `core:1883` and emits the
  parsed selection; a store function keeps it in flow context.
- A poll timer drives the **"Router / Leseplan"** function
  (`nodered/inverter-routing.js` = source of truth, synced copy inline) which
  branches on `communication`:
  - `solarman_v5` → the Solarman-V5 reader (`nodered/deye/solarman-v5.js`),
    passing `family` + the connection params to the register map / decode
    (`nodered/deye/deye-decode.js`).
  - `modbus_tcp` → the generic Modbus-TCP reader + profile decode
    (`nodered/modbus-tcp.js`), using `profile` (= `family`) + `unit_id`.
  - `fronius_solar_api` → one HTTP(S) GET to the Solar API + the PowerFlow decode
    (`nodered/fronius/solar-api.js`), using `url` + `insecure_tls`.
- The decoded canonical measurements go to `edge/telemetry` via `vp-telemetrie`
  (`power_kw`/`soc_pct`/`pv_power_kw`/`load_kw`/`grid_limit_kw`); this contract
  changes only how the adapter is **selected**, not the telemetry shape.
- No/unknown selection → the tab stays idle-safe (a node status note, no crash,
  no telemetry) and picks up the retained config the moment it arrives.
- `schema_version` is `"1.0"`; unknown future fields are ignored.

Read/monitoring only - nothing in this path controls the inverter.
