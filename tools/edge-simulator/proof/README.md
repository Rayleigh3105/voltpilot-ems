# Proof: simulator telemetry lands in TimescaleDB

This shows, reproducibly, that a message published by the standalone edge simulator is accepted by the live ingest pipe and lands as a row in the TimescaleDB `telemetry` hypertable - exactly as a real device would.

Data path exercised (architecture §4/§7):

```
voltpilot_edge_sim.py  --MQTT/QoS1-->  EMQX  -->  ingest  -->  Redpanda(telemetry.raw)  -->  timescale-writer  -->  TimescaleDB.telemetry
```

## 1. Bring up the live ingest path

From the repo root (once: `cp .env.example .env`):

```bash
# api owns the schema + RLS role the writer needs; start it if the DB is fresh.
docker compose up -d timescaledb keycloak api
# the `edge` profile carries the ingest + writer services and the broker/log.
docker compose --profile edge up -d --build emqx redpanda redpanda-init ingest timescale-writer
docker compose ps          # ingest + writer + emqx + timescaledb report healthy
```

> If you pulled newly-merged increments onto an already-initialized volume, the
> `infra/local/timescale/*.sql` bootstrap only runs on a **fresh** volume - do a
> `docker compose down -v` first (this wipes data) so the hypertables exist.

## 2. Run the proof

```bash
tools/edge-simulator/proof/publish_and_verify.sh
```

It (1) counts existing rows for the demo device, (2) publishes `COUNT` (default 20) telemetry messages with the simulator against `localhost:1883`, (3) waits for the pipe to drain and re-queries.
It prints the latest 10 rows and asserts the row count grew, exiting non-zero if not.

Override via env, e.g. a different device or a remote broker:

```bash
COUNT=50 HOST=localhost PORT=1883 tools/edge-simulator/proof/publish_and_verify.sh
```

## 3. The DB query, by hand

The same check without the script (superuser `voltpilot` bypasses RLS, so it sees every tenant's rows):

```bash
docker compose exec -T timescaledb psql -U voltpilot -d voltpilot -c \
  "SELECT time, device_id, power_kw, soc_pct, pv_power_kw, load_kw, grid_limit_kw
     FROM telemetry
    WHERE device_id = '00000000-0000-0000-0000-000000000003'
    ORDER BY time DESC
    LIMIT 10;"
```

Fresh rows (timestamps within the last minute, varying `pv_power_kw`/`soc_pct`/`load_kw`) prove the simulator's payload was validated by ingest, carried through `telemetry.raw`, and written by the writer - mapped field-for-field into the hypertable columns.

## 4. See it in the portal

Log in to the portal (`http://localhost:5173`) as `demo` / `demo`; the telemetry view for **Demo Site Berlin / demo-inverter-01** shows the freshly published points (newer than the dev seed), because the simulator's default identity is exactly that seeded device.

## Offline proof (no Docker, runs anywhere)

The wire path (real paho MQTT CONNECT + QoS1 PUBLISH/PUBACK + contract-conformant payloads) and the physical model are covered by the offline test suite - no broker or Docker needed:

```bash
cd tools/edge-simulator
python3 -m pytest test_edge_sim.py -q      # or: python3 test_edge_sim.py
```

`test_payload_matches_contract_jsonschema` validates generated payloads against the real binding schema `docs/contracts/mqtt-telemetry.schema.json`, so any drift in the payload shape fails before it could ever reach ingest.
