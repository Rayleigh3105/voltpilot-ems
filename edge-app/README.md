# VoltPilot Edge-App

The installable, standalone customer-side edge: one `docker compose up` on the device (Raspberry Pi, IPC, any Docker host), open the local web app, read the reference, claim it in the portal - done.

Two layers in one package:

| Layer | Service | Responsibility |
|---|---|---|
| **Layer 2 - Core-Agent** (`core/`, Go) | `core` | Identical at every customer, the reliability layer: identity + first-boot enrollment, the ONLY cloud connection (mTLS MQTT), telemetry store-and-forward, schedule cache + guarded execution + offline fallback, the embedded local MQTT bus, the local device web app. |
| **Layer 1 - I/O-Flows** (`nodered/`) | `nodered` | Per-customer inverter wiring in Node-RED (read measurements, write setpoints), talking ONLY to the core's local bus via the **vp-palette** nodes. **VoltPilot wires these flows - the customer never edits them.** |

Intelligence stays in the cloud (the optimizer plans, the edge executes and guards); the edge works with the cloud gone for days.

## Schnellstart ohne Hardware (Simulator-Modus)

The fastest way to see the whole thing run - zero hardware, one command:

```bash
cd edge-app
docker compose --profile sim up -d --build
```

This starts core + Node-RED **plus** the SunSpec-Modbus-Simulator (`edge-sim`, the repo's `edge/sim` source). The shipped flow tab **"SunSpec (Simulator)"** is preconfigured against it, so the full loop runs immediately: simulator → Node-RED → local bus → core → cloud (once paired), and cloud schedule → core guards → Node-RED → simulator setpoint writes (visible in `docker compose logs -f edge-sim`).

Then open the local web app: **http://localhost:8484** - it shows the device's reference and the pairing state. Claim the reference in the portal (*Geräte → ＋ Gerät hinzufügen*) and watch the state walk through *Warte auf Beanspruchung* → *Zertifikat erhalten* → *Verbunden mit VoltPilot*.

Without the `sim` profile (`docker compose up -d`) the same stack runs for a **real inverter**; the flow template for that is on the (disabled) tab "SunSpec Wechselrichter (Vorlage)" - see "Einen neuen Kunden verdrahten" below.

## Kundenerlebnis (production)

1. Install: `cp .env.example .env` (optional), `docker compose up -d`.
2. Open **http://\<geraet\>:8484** on the LAN: the page shows the **Referenz-ID** big and copyable, plus the pairing state.
3. Enter that reference in the VoltPilot portal (*Geräte → ＋ Gerät hinzufügen*).
4. Done. The device enrolls its certificate automatically (first-boot HTTPS enrollment: locally generated key → CSR upload → poll → cert), connects via mTLS and starts delivering telemetry; the portal row flips to *online*.

There is nothing to configure for the customer; the local web app is read-only.

## How the core works (Layer 2)

- **Config** (`core/internal/config`): env > `config.json` (in the data dir or `VP_CONFIG`) > defaults. Defaults: portal `https://voltpilot.de`, broker `mqtt.voltpilot.de:8883`, data dir `/data`, web `:8484`, bus `:1883`. An unset reference is generated once and persisted (`/data/ref`).
- **Enrollment** (`core/internal/enroll`): EC P-256 key generated on the device (never leaves it), CSR to `POST /api/v1/enrollment/{ref}/csr`, poll `GET .../certificate` (10 s → 60 s backoff, indefinitely - claiming may happen days later). Persists `device.key`/`device.crt`/`ca.crt`/`identity.json` under `/data/identity/`; restarts skip enrollment. Conflict states are surfaced in the web app (fremder Schlüssel / unbekannte Referenz).
- **Cloud link** (`core/internal/cloud`): ONE outbound mTLS MQTT connection (port 8883, cert CN = device id, username/clientid derived by the broker). Publishes the **frozen** telemetry contract + status heartbeat, subscribes the retained schedule topic.
- **Store-and-forward** (`core/internal/buffer`): every sample lands in a segmented on-disk ring buffer first (default 48 h, `VP_BUFFER_HOURS`), publishes drain oldest-first and ack only after the broker confirmed QoS1. Cloud outage = the buffer grows; reconnect = replay in order with the ORIGINAL timestamps (cloud ingest is idempotent per (device, time)). Eviction is oldest-first with a clear log line.
- **Schedule execution** (`core/internal/plan` + `guards`): the retained plan is validated (frozen `mqtt-schedule` contract), cached in memory AND on disk (reboot-safe). Every tick (10 s - every 15-min slot boundary is hit) the current slot's setpoint is **clamped through the guards** - rated charge/discharge band, SoC bounds, the observed §14a envelope on import AND export - and published retained on the local bus (`edge/setpoint`). A plan not refreshed for **20 minutes** is stale (the contract's `x-failsafe` window) → **self-consumption fallback** (battery follows PV − load). No plan, no cloud, for days: the fallback keeps the site sane.
- **Local bus** (`core/internal/localbus`, embedded [mochi-mqtt](https://github.com/mochi-mqtt/server) - no extra broker container). Topics: `edge/telemetry` (Layer 1 → core), `edge/setpoint` (core → Layer 1, retained), `edge/status` (Layer 1 → core, inverter link up/down).
- **Web app + health** (`core/internal/web`): German, read-only, self-contained (design-system token values baked in). `GET /health` for watchdogs; structured JSON logs on stdout; `restart: unless-stopped` in compose.

## vp-palette (Layer 1 building blocks)

Three Node-RED nodes (`nodered/vp-palette/`), all preconfigured to the core's bus via the shared `vp-core` config node (`core:1883` in compose):

| Node | Direction | Contract |
|---|---|---|
| `vp-telemetrie` | flow → core | `msg.payload` = `{power_kw?, soc_pct?, pv_power_kw?, load_kw?, grid_limit_kw?, ts?}` (aliases `grid_kw`/`pv_kw` accepted). The core stamps identity/seq and owns the cloud contract. |
| `vp-sollwert` | core → flow | Emits `msg.payload` = setpoint kW (+ laden / − entladen), `msg.setpoint` = full command. Already guard-clamped - just translate to the device protocol. |
| `vp-status` | flow → core | `msg.payload` = `true`/`false`, `"up"`/`"down"` - feeds "Wechselrichter: verbunden/getrennt" in the web app. |

## Einen neuen Kunden verdrahten (VoltPilot service task)

The Node-RED editor runs LAN-only behind auth: `http://<geraet>:1881`, user `voltpilot`, password from `VP_NODERED_PASSWORD` (default `voltpilot` - **change it per installation**). Customers never get these credentials.

1. Open the disabled tab **"SunSpec Wechselrichter (Vorlage)"**.
2. Set the inverter IP in the config node *Wechselrichter (Modbus TCP)*; adapt the `decode`/`write` functions to the device's register map (the simulator tab shows a complete working example; register semantics: `edge/sim/sunspec-sim.js`).
3. Enable the template tab, disable the simulator tab, deploy.
4. Set the battery's real limits in `.env` (`VP_MAX_CHARGE_KW`, `VP_MAX_DISCHARGE_KW`, `VP_SOC_*`) and `docker compose up -d` again.

The structure is always the same: read → `vp-telemetrie`, `vp-sollwert` → write, link state → `vp-status`. Everything cloud-related stays in the core.

## Konfiguration

See [`.env.example`](.env.example). Everything is optional; the dev escape hatches (`VP_DEV_*`: fixed identity skips enrollment, `VP_DEV_CLOUD_URL` = plain-MQTT cloud) exist for development/e2e ONLY and must stay empty on customer devices.

## Build & Tests

```bash
# Go core (unit + in-process integration: enrollment stub with a real CA,
# mTLS mochi cloud broker, buffer replay, guard clamps)
(cd core && go test ./...)

# vp-palette (pure shaping + node-red-node-test-helper against an in-process bus)
(cd nodered/vp-palette && npm install && npm test)

# Isolated compose e2e (own project name/ports; sim -> nodered -> core ->
# stand-in cloud broker; retained schedule -> guards -> sim setpoint write)
./test/e2e-compose.sh
```

Multi-arch image build (arm64 for Pi + amd64):

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/edge-app-core:TAG edge-app/core
docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/edge-app-nodered:TAG edge-app/nodered
```

## Manual E2E against a real cloud stack

The compose e2e uses a stand-in broker. To verify against a real current-main cloud (enrollment + mTLS + portal):

1. Bring up an isolated cloud stack with enrollment enabled (`VOLTPILOT_ENROLLMENT_ENABLED=true`, staged device CA - see `docs/deploy.md`) or use a production-like VM.
2. On the edge device: `.env` with `VP_PORTAL_BASE_URL` + `VP_MQTT_HOST` pointing at it, then `docker compose --profile sim up -d --build`.
3. Portal: register/claim the reference shown at `:8484`; watch the pairing state reach *Verbunden mit VoltPilot* and telemetry appear in the portal.

## Future work (deliberately not in this MVP)

Auto-update/OTA (Mender per architecture), on-edge ML, local optimization beyond the self-consumption fallback, non-Modbus inverter drivers as ready-made palettes, HTTPS/auth for the local web app (LAN trust zone for now), metrics endpoints (Prometheus), and moving the plain-MQTT dev escape hatches behind a build tag.
