# VoltPilot standalone edge simulator

A dependency-light, **installable-anywhere** simulated EMS edge device.
Drop it on a Raspberry Pi or any host on your LAN, point it at a VoltPilot broker, and it publishes realistic PV / battery / household-load telemetry over MQTT - so a "device" running on a *different* machine writes into the stack hosted on the captain's machine and the data shows up in the portal.

It is deliberately separate from the Node-RED edge in [`edge/`](../../edge/): that one models SunSpec/Modbus hardware; **this** is a single self-contained Python program you can copy onto a remote box with nothing but Python + one pip package.

- Speaks the binding telemetry contract verbatim: [`docs/contracts/mqtt-telemetry.schema.json`](../../docs/contracts/mqtt-telemetry.schema.json) (`schema_version` `"1.0"`).
- Publishes to `ems/{tenant_id}/{site_id}/{device_id}/telemetry` at **QoS1**, plus a health heartbeat on `.../status`.
- **Zero-touch onboarding**: with just `--host` + `--ref` it performs the provisioning handshake ([`docs/contracts/mqtt-provisioning.schema.json`](../../docs/contracts/mqtt-provisioning.schema.json)) and adopts its identity once the ref is claimed in the portal - no UUIDs to copy. See below.
- Both **plain MQTT (1883)** for local dev and **mutual-TLS (8883)** for real remote onboarding with a device cert from [`tools/pki/provision-device.sh`](../pki/provision-device.sh).
- One runtime dependency: `paho-mqtt`.

## Zero-touch mode (recommended): `--host` + `--ref`

The device needs to know exactly two things - the broker host and its **edge reference** (the string the customer types under *Geräte → Gerät hinzufügen*):

```bash
python3 voltpilot_edge_sim.py --host 192.168.2.77 --ref pi-sim-01 --verbose
```

What happens (contract: `mqtt-provisioning.schema.json`):

1. The simulator publishes a hello on `provision/pi-sim-01/hello` (QoS1) and subscribes to `provision/pi-sim-01/config`.
2. Until the ref is claimed, there is **no answer** - the hello retries every `--provision-retry` seconds (default 10). This is the normal "wartet auf Beanspruchung" state, not an error.
3. The moment the ref is claimed in the portal, the cloud publishes the identity `{tenant_id, site_id, device_id}` **retained** on the config topic; the simulator adopts it and starts publishing normal contract telemetry. The portal device row flips from *"wartet auf erste Daten"* to *online*.
4. After a restart the retained config re-provisions the device instantly - no cloud round-trip.

`--provision-timeout N` gives up after N seconds (default `0` = wait for the claim forever). Env twins: `EDGE_SIM_REF` (also `VP_REF`), `EDGE_SIM_PROVISION_RETRY`, `EDGE_SIM_PROVISION_TIMEOUT`. The explicit `--tenant-id/--site-id/--device-id` flags keep working and skip the handshake entirely.

## What it simulates

A believable day, updated every publish interval:

| Channel | Behaviour |
|---|---|
| `pv_power_kw` | Diurnal curve: **zero at night**, single peak near solar noon, mild cloud variation. |
| `load_kw` | Household profile: base draw + morning, midday and evening bumps. |
| `soc_pct` | Battery **charges midday** on PV surplus, **discharges in the evening**; clamped 10-100 %. |
| `power_kw` | Grid coupling point = `load - pv + battery`. **Positive = import, negative = export.** |
| `grid_limit_kw` | Constant observed §14a limit (configurable). |

With `--time-scale 1` (default) the curve tracks the real wall clock, so left running it draws a real day.
Set e.g. `--time-scale 288` to replay a **full 24 h day in 5 minutes** for a quick, plausible-looking demo.

## Configuration

Precedence: **CLI flag > environment variable / `.env` > default**. Every flag has an `EDGE_SIM_*` env twin; see [`.env.example`](.env.example) for the full list. Identity also accepts the edge's `VP_TENANT_ID/VP_SITE_ID/VP_DEVICE_ID` names.

Key options (`python3 voltpilot_edge_sim.py --help` for all):

| Flag / env | Meaning | Default |
|---|---|---|
| `--host` / `EDGE_SIM_HOST` | Broker host/FQDN/IP | `localhost` |
| `--port` / `EDGE_SIM_PORT` | `1883` plain, `8883` mTLS | `1883` |
| `--tls` / `--no-tls` | TLS on/off (auto-on for 8883 or when a client cert is set) | auto |
| `--ca-cert` / `--client-cert` / `--client-key` | mTLS bundle paths | - |
| `--insecure` | Skip broker cert verification (dev only) | off |
| `--ref` / `EDGE_SIM_REF` | Zero-touch: edge reference for the provisioning handshake (overrides the explicit identity) | - |
| `--provision-retry` / `--provision-timeout` | Hello retry cadence / give-up (0 = wait forever) | `10` / `0` |
| `--tenant-id` / `--site-id` / `--device-id` | Explicit identity (UUIDs), skips the handshake | the `demo` dev seed |
| `--interval` | Seconds between telemetry samples | `5` |
| `--count` | Stop after N messages (`0` = forever) | `0` |
| `--time-scale` | Simulated seconds per real second | `1` |
| `--pv-peak-kw` `--batt-capacity-kwh` `--batt-max-kw` `--soc-init-pct` `--grid-limit-kw` | Plant sizing | 8 / 10 / 5 / 40 / 11 |

The identity defaults mirror the dev seed (Tenant A / Demo Site Berlin / `demo-inverter-01`), so a plain local run needs **no arguments** and lands straight in the `demo` user's telemetry view.

---

## (a) Local run against `localhost:1883`

On the captain's machine, with the live ingest path up (see [`proof/README.md`](proof/README.md) for the exact `docker compose` lines):

```bash
cd tools/edge-simulator
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

# No args needed: defaults target localhost:1883 and the demo device.
python3 voltpilot_edge_sim.py --verbose

# Or replay a whole plausible day in ~5 minutes:
python3 voltpilot_edge_sim.py --time-scale 288 --interval 2 --verbose
```

Log in to the portal (`http://localhost:5173`) as `demo` / `demo` - the freshly published points appear in the telemetry view.

## (b) Run from ANOTHER LAN machine against the captain's machine over 8883 mTLS

This is the real scenario: a second host (e.g. a Raspberry Pi) publishes into the captain's stack over mutual TLS.

### 1. On the captain's machine: bring up the secure broker and issue a device cert

```bash
# One-time: create the device CA + broker server cert. Put the captain's LAN IP
# in the SAN so the Pi can connect by IP (or use a resolvable FQDN).
./tools/pki/voltpilot-ca.sh init-ca --domain voltpilot.lan --ip 192.168.1.50

# Bring up the hardened mTLS listener on 8883 (+ the ingest path).
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile edge up -d --build

# Issue a cert for the device you want to simulate. Easiest: provision (claim in
# the portal + issue cert in one step); tenant is read from the access token.
./tools/pki/provision-device.sh \
  --api-base http://192.168.1.50:8090 \
  --token "$ACCESS_TOKEN" \
  --site 00000000-0000-0000-0000-000000000002 \
  --external-ref pi-sim-01 \
  --domain voltpilot.lan
# -> prints the tenant/site/device IDs, the topics, and the cert bundle path:
#    tools/pki/out/devices/<device_id>/{device.crt,device.key,device-ca.crt}

# Reload the broker so the new per-device ACL grant applies.
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec emqx emqx ctl conf reload
```

> Prefer to skip the portal? `./tools/pki/voltpilot-ca.sh issue --tenant <t> --site <s> --device <d>` issues a cert for IDs you already own (use the demo seed IDs to land in the `demo` view). Reload the broker afterwards the same way.

### 2. Copy the artifact + the cert bundle to the other machine

```bash
# From the captain's machine (adjust <device_id> and the Pi's address):
scp -r tools/edge-simulator pi@192.168.1.77:~/edge-simulator
scp tools/pki/out/devices/<device_id>/{device.crt,device.key,device-ca.crt} \
    pi@192.168.1.77:~/edge-simulator/certs/
```

The **private key never leaves your control except onto that one device**.

### 3. On the other machine: run against the captain's IP on 8883

```bash
ssh pi@192.168.1.77
cd ~/edge-simulator
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

python3 voltpilot_edge_sim.py \
  --host 192.168.1.50 --port 8883 \
  --ca-cert certs/device-ca.crt \
  --client-cert certs/device.crt \
  --client-key certs/device.key \
  --tenant-id 00000000-0000-0000-0000-000000000001 \
  --site-id   00000000-0000-0000-0000-000000000002 \
  --device-id <device_id-from-issue> \
  --verbose
```

Notes:
- Port `8883` **auto-enables TLS**; passing the client cert makes it mutual TLS. Do **not** set username/clientid - the broker derives both from the cert CN (`device_id`), and its per-device ACL confines the cert to exactly its own `ems/{t}/{s}/{d}/...` topics.
- Broker verification uses the host you dial. Because `init-ca --domain <fqdn> --ip <ip>` puts **both** in the server cert SAN, dialing either the FQDN or the IP verifies with no extra flags. In production, prefer dialing the broker's MQTT domain (e.g. `mqtt.<domain>`, a plain DNS A record to the server) with the IP as fallback - see [`docs/connect-a-device.md`](../../docs/connect-a-device.md). For a throwaway test against a cert that lists neither, `--insecure` skips verification (dev only).
- The device makes an **outbound-only** connection (architecture §6) - it needs no inbound ports and works behind NAT.

Confirm on the captain's side: EMQX dashboard (`http://localhost:18083`) shows a client connected with clientid = `device_id`, and the portal telemetry view fills in. Full model: [`docs/security-mqtt.md`](../../docs/security-mqtt.md) and [`docs/connect-a-device.md`](../../docs/connect-a-device.md).

## (c) Containerized run

Build and run the image (multi-arch; works on a Pi):

```bash
cd tools/edge-simulator
docker build -t voltpilot-edge-sim .

# Plain, against a broker reachable from the container (host networking on Linux):
docker run --rm --network host \
  -e EDGE_SIM_HOST=localhost -e EDGE_SIM_PORT=1883 -e EDGE_SIM_VERBOSE=true \
  voltpilot-edge-sim

# mTLS, mounting the device cert bundle read-only:
docker run --rm \
  -v "$PWD/certs:/certs:ro" \
  -e EDGE_SIM_HOST=192.168.1.50 -e EDGE_SIM_PORT=8883 \
  -e EDGE_SIM_CA_CERT=/certs/device-ca.crt \
  -e EDGE_SIM_CLIENT_CERT=/certs/device.crt \
  -e EDGE_SIM_CLIENT_KEY=/certs/device.key \
  -e EDGE_SIM_DEVICE_ID=<device_id> \
  voltpilot-edge-sim
```

### Or via compose on the captain's machine (opt-in `sim` profile)

A ready service block is wired into the root `docker-compose.yml` behind its **own** `sim` profile (kept off the default `up` and separate from the `edge` profile so it never double-publishes with the Node-RED edge):

```bash
docker compose --profile edge up -d --build emqx ingest timescale-writer   # ingest path
docker compose --profile sim  up -d --build edge-simulator                 # the publisher
docker compose logs -f edge-simulator
```

## Run it as a service on a Pi (systemd)

An example unit is provided: [`voltpilot-edge-sim.service`](voltpilot-edge-sim.service). It documents the install steps (dedicated user, venv, an `EnvironmentFile` for config + cert paths) and includes basic hardening. `journalctl -u voltpilot-edge-sim -f` to watch it.

## Prove it works

See [`proof/README.md`](proof/README.md): a one-command script (`proof/publish_and_verify.sh`) that publishes N messages and shows the rows appearing in TimescaleDB, plus the by-hand SQL query and an offline (no-Docker) test path.

## Tests

Offline, no broker/Docker/network:

```bash
cd tools/edge-simulator
python3 -m pytest test_edge_sim.py -q     # or: python3 test_edge_sim.py
```

They validate generated payloads against the **real** binding schema, the grid power-balance identity, the PV day/night curve, the battery charge/discharge cycle, SoC bounds, the topic format, and config precedence.
The zero-touch handshake is tested over the real paho wire path against an in-process MQTT broker stub: claimed ref → identity adopted, unclaimed ref → hello retries then timeout, retained config → instant re-provision after restart, foreign-ref config → ignored.
