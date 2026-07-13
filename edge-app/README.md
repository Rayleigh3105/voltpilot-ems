# VoltPilot Edge-App

The installable, standalone customer-side edge: one `docker compose up` on the device (Raspberry Pi, IPC, any Docker host), open the local web app, read the reference, claim it in the portal - done.

Two layers in one package:

| Layer | Service | Responsibility |
|---|---|---|
| **Layer 2 - Core-Agent** (`core/`, Go) | `core` | Identical at every customer, the reliability layer: identity + first-boot enrollment, the ONLY cloud connection (mTLS MQTT), telemetry store-and-forward, schedule cache + guarded execution + offline fallback, the embedded local MQTT bus, the local device web app. |
| **Layer 1 - I/O-Flows** (`nodered/`) | `nodered` | Inverter I/O in Node-RED, talking ONLY to the core's local bus via the **vp-palette** nodes. **Self-wiring:** it reads the customer's inverter selection (retained `edge/inverter/config`) and runs the matching read adapter automatically - no per-customer flow edit. |

Intelligence stays in the cloud (the optimizer plans, the edge executes and guards); the edge works with the cloud gone for days.

## Schnellstart ohne Hardware (Simulator-Modus)

The fastest way to see the whole thing run - zero hardware, one command:

```bash
cd edge-app
docker compose --profile sim up -d --build
```

This starts core + Node-RED **plus** the SunSpec-Modbus-Simulator (`edge-sim`, the repo's `edge/sim` source). The shipped flow tab **"SunSpec (Simulator)"** is preconfigured against it, so the full loop runs immediately: simulator → Node-RED → local bus → core → cloud (once paired), and cloud schedule → core guards → Node-RED → simulator setpoint writes (visible in `docker compose logs -f edge-sim`).

Then open the local web app: **http://localhost:8484** - it shows the device's reference and the pairing state. Claim the reference in the portal (*Geräte → ＋ Gerät hinzufügen*) and watch the state walk through *Warte auf Beanspruchung* → *Zertifikat erhalten* → *Verbunden mit VoltPilot*.

Without the `sim` profile (`docker compose up -d`) the same stack runs for a **real inverter**: the customer picks the inverter in the local web app and the always-on tab **"Wechselrichter (automatisch)"** self-wires the right read adapter - no flow edit. See "Einen neuen Kunden verdrahten" below.

**Auf einer eigenen VM gegen die Live-Cloud ausrollen** (echter Deye-Wechselrichter, First-Boot-Enrollment, selbst beanspruchen): das Schritt-für-Schritt-Runbook steht in [`DEPLOY.md`](DEPLOY.md).

## Kundenerlebnis (production)

Für ein NEUES Gerät ist der **eigenständige, geführte Installer** der empfohlene Weg - `install.sh` ist die **einzige Datei**, die auf das Gerät muss: er **erzeugt seine eigene `docker-compose.yml`** (nur vorgefertigte Registry-Images, kein Build, kein Simulator) und die `.env`, prüft die Voraussetzungen, meldet an der Registry an, startet `core` + `nodered` (echter Wechselrichter), zeigt die Referenz-ID an und verifiziert die Anbindung; mehrfach ausführbar, ohne Datenvolumes/Identität zu löschen (Runbook + Fallback: [`DEPLOY.md`](DEPLOY.md)):

```bash
# nur install.sh auf das Gerät kopieren, dann:
./install.sh          # schreibt docker-compose.yml + .env ins aktuelle Verzeichnis
                      # Optionen: --help, --reconfigure, --force-compose,
                      #           --print-compose, --dry-run, --non-interactive
```

Für ein LAUFENDES Gerät ist der Begleiter **`update.sh`** der empfohlene Update-Weg - ein Befehl, der die Compose-Datei(en) aktuell hält (Installer-Deployment über die `install.sh`-Vorlage, Repo-Klon per `git pull --ff-only`; Handbearbeitetes wird nie ohne `--force-compose` überschrieben), die frischen Registry-Images zieht, `up -d --remove-orphans` ausführt und die Anbindung über `/health` verifiziert. Volumes, Geräteidentität und `.env` bleiben dabei immer unberührt (Details: [`DEPLOY.md`](DEPLOY.md), Abschnitt "Betrieb"):

```bash
# im Deploy-Verzeichnis (update.sh liegt neben install.sh):
./update.sh           # Compose aktualisieren + Images ziehen + up -d + Verifizierung
                      # Optionen: --help, --dry-run, --skip-pull, --force-compose,
                      #           --hostnet, --non-interactive, --print-compose/--print-hostnet
```

Manuell (Fallback):

1. Install: `cp .env.example .env` (optional), `docker compose up -d`.
2. Open **http://\<geraet\>:8484** on the LAN: the page shows the **Referenz-ID** big and copyable, plus the pairing state.
3. Enter that reference in the VoltPilot portal (*Geräte → ＋ Gerät hinzufügen*).
4. Done. The device enrolls its certificate automatically (first-boot HTTPS enrollment: locally generated key → CSR upload → poll → cert), connects via mTLS and starts delivering telemetry; the portal row flips to *online*.

There is nothing to configure for the customer; the local web app is read-only.

## How the core works (Layer 2)

- **Config** (`core/internal/config`): env > `config.json` (in the data dir or `VP_CONFIG`) > defaults. Defaults: portal `https://voltpilot.de`, broker `mqtt.voltpilot.de:8883`, data dir `/data`, web `:8484`, bus `:1883`. An unset reference is generated once and persisted (`/data/ref`).
- **Enrollment** (`core/internal/enroll`): EC P-256 key generated on the device (never leaves it), CSR to `POST /api/v1/enrollment/{ref}/csr`, poll `GET .../certificate` (10 s → 60 s backoff, indefinitely - claiming may happen days later). Persists `device.key`/`device.crt`/`ca.crt`/`identity.json` under `/data/identity/`; restarts skip enrollment. Conflict states are surfaced in the web app (fremder Schlüssel / unbekannte Referenz).
- **Cloud link** (`core/internal/cloud`): ONE outbound mTLS MQTT connection (port 8883, cert CN = device id, username/clientid derived by the broker). Publishes the **frozen** telemetry contract + status heartbeat, subscribes the retained schedule topic.
- **Removal detection (`geraet_entfernt`)**: an enrolled device notices when it is REMOVED (unclaimed) in the cloud. The periodic identity reconcile keeps polling the enrollment certificate endpoint; only a **sustained, uninterrupted** run of definitive clean-404 "not claimed" answers from a REACHABLE portal (default ≥ 20 min AND ≥ 4 consecutive polls, `VP_UNCLAIM_CONFIRM_MINUTES` / `VP_UNCLAIM_CONFIRM_POLLS`) confirms the removal - dial errors, timeouts and 5xx keep the existing `portal_nicht_erreichbar` behavior and RESET the run, so a transient outage can never trip it (and a never-claimed device polling pending is just onboarding, never "removed"). On confirmation the device tears down the cloud link, **pauses the store-and-forward buffer** (honest `buffer_paused` flag + "Aufzeichnung pausiert" in the web app instead of piling up data that can never be delivered; the local dashboard keeps running), keeps its identity/keys ON DISK, and keeps polling: a re-claim in the portal re-issues against the same key, the new identity is adopted and normal operation (incl. buffering) resumes automatically. The web app re-opens the portal-claim step with the reference; `/health` reports `pairing_state=geraet_entfernt` for headless tooling.
- **Store-and-forward** (`core/internal/buffer`): every sample lands in a segmented on-disk ring buffer first (default 48 h, `VP_BUFFER_HOURS`), publishes drain oldest-first and ack only after the broker confirmed QoS1. Cloud outage = the buffer grows; reconnect = replay in order with the ORIGINAL timestamps (cloud ingest is idempotent per (device, time)). Eviction is oldest-first with a clear log line.
- **Schedule execution** (`core/internal/plan` + `guards`): the retained plan is validated (frozen `mqtt-schedule` contract), cached in memory AND on disk (reboot-safe). Every tick (10 s - every 15-min slot boundary is hit) the current slot's setpoint is **clamped through the guards** - rated charge/discharge band, SoC bounds, the observed §14a envelope on import AND export, and (when the plan carries `grid_charge_allowed=false` - an EEG site, P5) charge ≤ the MEASURED PV surplus, so a forecast overshoot can never grid-charge an EEG battery - and published retained on the local bus (`edge/setpoint`). A plan not refreshed for **20 minutes** is stale (the contract's `x-failsafe` window) → **self-consumption fallback** (battery follows PV − load). No plan, no cloud, for days: the fallback keeps the site sane.
- **Local bus** (`core/internal/localbus`, embedded [mochi-mqtt](https://github.com/mochi-mqtt/server) - no extra broker container). Topics: `edge/telemetry` (Layer 1 → core), `edge/setpoint` (core → Layer 1, retained), `edge/status` (Layer 1 → core, inverter link up/down), `edge/inverter/config` (core → Layer 1, retained - the inverter selection, see below).
- **Wechselrichter-Auswahl** (`core/internal/inverter` + the web app): the customer picks their inverter ONCE in the local web UI (Marke → Typ → Verbindungsdaten). The communication method follows from the brand (Deye → Solarman-V5 über den WiFi-Datenlogger; alle anderen → Modbus TCP), so no transport is chosen by hand. The core validates + persists the choice (`data_dir/inverter.json`, survives restart) and publishes it **retained** on `edge/inverter/config` at boot and on every change; Layer 1 reads it to self-wire the right read adapter. Contract: [`INVERTER-CONFIG.md`](INVERTER-CONFIG.md). Read/monitoring only - the selection never controls the inverter.
- **Web app + health** (`core/internal/web`): German, read-only **live energy dashboard** on `:8484` - at-a-glance KPI cards (PV / Batterie-SoC + Lade-/Entlade-Zustand / Hausverbrauch / Netzbezug ↔ Einspeisung), an animated **energy-flow** diagram (PV → Haus / Batterie / Netz, direction encodes charge/discharge & import/export), and **live time-series charts** (Leistung: PV/Last/Netz/Batterie with a 15 Min / 1 Std / 3 Std range toggle, plus a SoC chart). Below the fold: the pairing/onboarding card (prominent Referenz-ID + step tracker until *Verbunden*, then it collapses) and a Betrieb-&-Status panel. All assets are bundled locally (no CDN, works offline); charts are hand-rolled on `<canvas>` (`static/charts.js`, HiDPI-aware, hover tooltip). Data path: the agent keeps an in-memory ring of recent samples (`core/internal/history`, fed from `edge/telemetry`, battery power derived from the power balance `grid - load + pv`); the web layer serves `GET /api/history?minutes=N` for the initial series and streams live updates over **SSE** at `GET /api/stream` (`event: state` + `event: sample`, falls back to `/api/state` polling), plus the inverter-selection form and `GET /health` for watchdogs. Structured JSON logs on stdout; `restart: unless-stopped` in compose.

## vp-palette (Layer 1 building blocks)

Four Node-RED nodes (`nodered/vp-palette/`), all preconfigured to the core's bus via the shared `vp-core` config node (`core:1883` in compose):

| Node | Direction | Contract |
|---|---|---|
| `vp-telemetrie` | flow → core | `msg.payload` = `{power_kw?, soc_pct?, pv_power_kw?, load_kw?, grid_limit_kw?, ts?}` (aliases `grid_kw`/`pv_kw` accepted). The core stamps identity/seq and owns the cloud contract. |
| `vp-sollwert` | core → flow | Emits `msg.payload` = setpoint kW (+ laden / − entladen), `msg.setpoint` = full command. Already guard-clamped - just translate to the device protocol. |
| `vp-status` | flow → core | `msg.payload` = `true`/`false`, `"up"`/`"down"` - feeds "Wechselrichter: verbunden/getrennt" in the web app. |
| `vp-inverter-config` | core → flow | Emits the retained inverter **selection** (`msg.payload`/`msg.inverter` = `{brand, family, communication, connection, …}`). This is what lets the "Wechselrichter (automatisch)" tab self-wire the right read adapter. |

**Self-wiring read path** (`nodered/inverter-routing.js` + `modbus-tcp.js` + `deye/*.js`, all offline-tested; the flow's function nodes carry synced copies): the "Wechselrichter (automatisch)" tab subscribes `edge/inverter/config`, and per the selection routes to either the **Deye Solarman-V5** reader (`communication=solarman_v5`, the `family` register map) or the **generic Modbus-TCP** reader (`communication=modbus_tcp`, the `profile`), then publishes the canonical `edge/telemetry` via `vp-telemetrie`. No selection yet → the tab stays idle-safe and picks up the retained config the moment it arrives.

**Custom inverter integration:** the full local-bus contract - payload schema, units/signs, QoS/cadence, the copy-paste function + `mqtt out` recipe, and the gotchas - is documented in [`nodered/CUSTOM-INVERTER.md`](nodered/CUSTOM-INVERTER.md).

**Deye inverters:** the self-wiring tab reads all major Deye families (string, hybrid 1p/3p, micro) over Solarman-V5 (TCP 8899) using the selected `family` register map. Read/monitoring only (the string/micro power-limit write + hybrid battery control are out of scope here). Register maps, sign calibration and the on-device probe: [`nodered/DEYE.md`](nodered/DEYE.md).

## Einen neuen Kunden verdrahten (VoltPilot service task)

The capstone of the framework: **"vorne auswählen, hinten ist alles verdrahtet"** - the customer picks the inverter once, Node-RED just works.

1. In the local web app (**http://\<geraet\>:8484 → "Wechselrichter einrichten"**) pick the inverter: brand → family/type → connection params. The communication follows from the brand (Deye → Solarman-V5; everything else → Modbus-TCP), so no transport is chosen by hand. The core persists it and publishes it retained on `edge/inverter/config`.
2. That's it for the read path. The always-on Node-RED tab **"Wechselrichter (automatisch)"** picks up the retained selection and runs the matching adapter automatically - **no flow edit per customer** (this is the point of the design; the former manual "Vorlage" tabs are retired).
3. Set the battery's real limits in `.env` (`VP_MAX_CHARGE_KW`, `VP_MAX_DISCHARGE_KW`, `VP_SOC_*`) and `docker compose up -d`.

For a **custom inverter** whose register map is not yet a built-in profile, VoltPilot adds a profile to `nodered/modbus-tcp.js` (Modbus) or a `family` to `nodered/deye/deye-decode.js` (Deye) - both additive, the routing carries the id through. The Node-RED editor is available LAN-only behind auth for that (`http://<geraet>:1881`, user `voltpilot`, password `VP_NODERED_PASSWORD` - customers never get these credentials); the hand-wiring contract for a fully bespoke inverter is [`nodered/CUSTOM-INVERTER.md`](nodered/CUSTOM-INVERTER.md).

The structure is always the same: selection → self-wired read → `vp-telemetrie`, link state → `vp-status`. Everything cloud-related (and the setpoint write loop) stays in the core / the Simulator tab. Read/monitoring only - the selection never controls the inverter.

**LAN-Logger nicht aus dem Container erreichbar?** Manche WiFi-Logger (Deye/Solarman-Dongle, UDP 48899) antworten dem Bridge-Container nicht (UDP-über-NAT). Fix: Node-RED aufs Host-Netz - `docker compose -f docker-compose.yml -f docker-compose.hostnet.yml up -d` (Override `docker-compose.hostnet.yml`). Details + Caveats in [`DEPLOY.md`](DEPLOY.md#lan-logger-nicht-aus-dem-container-erreichbar-host-networking).

## Konfiguration

See [`.env.example`](.env.example). Everything is optional; the dev escape hatches (`VP_DEV_*`: fixed identity skips enrollment, `VP_DEV_CLOUD_URL` = plain-MQTT cloud) exist for development/e2e ONLY and must stay empty on customer devices.

## Build & Tests

```bash
# Go core (unit + in-process integration: enrollment stub with a real CA,
# mTLS mochi cloud broker, buffer replay, guard clamps)
(cd core && go test ./...)

# vp-palette (pure shaping + node-red-node-test-helper against an in-process bus)
(cd nodered/vp-palette && npm install && npm test)

# Self-wiring read path + Deye decode (offline: config→adapter routing, generic
# Modbus-TCP codec + SunSpec profile, flow-vs-module sync guard, +ok=0103 parser,
# per-family register maps, PV sum, sign inversion - no hardware/network)
node --test nodered/*.test.js nodered/deye/*.test.js

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
