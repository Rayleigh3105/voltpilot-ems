#!/usr/bin/env python3
"""VoltPilot standalone simulated edge device.

A single-file, dependency-light MQTT publisher that stands in for a real EMS
edge (PV inverter + battery + household load). Drop it on a Raspberry Pi or any
host on the LAN, point it at a VoltPilot broker, and it publishes contract-
conformant telemetry so the data shows up in the portal exactly as a real
device would.

It speaks the BINDING telemetry contract verbatim
(docs/contracts/mqtt-telemetry.schema.json, schema_version "1.0") on
    ems/{tenant_id}/{site_id}/{device_id}/telemetry   (QoS1)
and a lightweight health heartbeat on
    ems/{tenant_id}/{site_id}/{device_id}/status

Both plain MQTT (1883, local dev) and mutual-TLS (8883, real remote onboarding
with a device cert from tools/pki/provision-device.sh) are supported.

Only dependency: paho-mqtt (see requirements.txt). Config comes from CLI flags,
environment variables, or an optional .env file (CLI > env/.env > defaults).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import signal
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

try:
    import paho.mqtt.client as mqtt
except ImportError:  # pragma: no cover - only hit when the dep is missing
    sys.stderr.write(
        "error: paho-mqtt is not installed. Run: pip install -r requirements.txt\n"
    )
    raise

SCHEMA_VERSION = "1.0"
SW_VERSION = "voltpilot-edge-sim/1.0.0"


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Defaults mirror the dev seed (Tenant A / Demo Site Berlin / demo-inverter-01)
# in infra/local/timescale/01-init.sql, so a plain local run lands straight in
# the `demo` user's telemetry view with no ID juggling.
DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001"
DEFAULT_SITE_ID = "00000000-0000-0000-0000-000000000002"
DEFAULT_DEVICE_ID = "00000000-0000-0000-0000-000000000003"


@dataclass
class Config:
    # Broker / transport
    host: str = "localhost"
    port: int = 1883
    tls: bool = False
    ca_cert: str | None = None
    client_cert: str | None = None
    client_key: str | None = None
    insecure: bool = False
    username: str | None = None
    password: str | None = None
    client_id: str | None = None
    keepalive: int = 60

    # Device identity (topic + payload)
    tenant_id: str = DEFAULT_TENANT_ID
    site_id: str = DEFAULT_SITE_ID
    device_id: str = DEFAULT_DEVICE_ID

    # Publish cadence
    interval: float = 5.0          # seconds between telemetry samples
    status_interval: float = 30.0  # seconds between status heartbeats
    count: int = 0                 # 0 = run forever, N = stop after N telemetry msgs
    qos: int = 1

    # Simulation
    time_scale: float = 1.0        # simulated seconds per real second (>1 = fast day)
    start_hour: float | None = None  # sim start hour-of-day (default: real local now)
    pv_peak_kw: float = 8.0
    load_base_kw: float = 0.35
    batt_capacity_kwh: float = 10.0
    batt_max_kw: float = 5.0
    soc_init_pct: float = 40.0
    grid_limit_kw: float = 11.0
    noise: float = 0.04            # relative measurement noise (0 = perfectly smooth)
    seed: int | None = None        # deterministic noise when set

    verbose: bool = False


def _env(name: str) -> str | None:
    v = os.environ.get(name)
    return v if v not in (None, "") else None


def _as_bool(v: str | None, default: bool) -> bool:
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def load_dotenv(path: str) -> None:
    """Minimal .env loader (no external dependency). Does not overwrite an
    already-exported variable, so real env always wins over the file."""
    if not path or not os.path.isfile(path):
        return
    with open(path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val


def build_config(argv: list[str] | None = None) -> Config:
    """Resolve config with precedence CLI > env/.env > defaults."""
    pre = argparse.ArgumentParser(add_help=False)
    pre.add_argument("--env-file", default=os.environ.get("EDGE_SIM_ENV_FILE", ".env"))
    known, _ = pre.parse_known_args(argv)
    load_dotenv(known.env_file)

    d = Config()  # defaults
    p = argparse.ArgumentParser(
        description="VoltPilot standalone simulated edge device (MQTT telemetry publisher).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--env-file", default=known.env_file,
                   help="Path to an optional .env file with EDGE_SIM_* variables.")

    # Broker / transport
    p.add_argument("--host", default=_env("EDGE_SIM_HOST") or d.host,
                   help="MQTT broker host/FQDN/IP.")
    p.add_argument("--port", type=int,
                   default=int(_env("EDGE_SIM_PORT") or d.port),
                   help="Broker port (1883 plain, 8883 mTLS).")
    p.add_argument("--tls", dest="tls", action="store_true",
                   default=_as_bool(_env("EDGE_SIM_TLS"), d.tls),
                   help="Enable TLS. Auto-enabled when --port 8883 or certs are given.")
    p.add_argument("--no-tls", dest="tls", action="store_false",
                   help="Force plain MQTT even on 8883.")
    p.add_argument("--ca-cert", default=_env("EDGE_SIM_CA_CERT") or d.ca_cert,
                   help="CA cert that signs the broker's server cert (device-ca.crt).")
    p.add_argument("--client-cert", default=_env("EDGE_SIM_CLIENT_CERT") or d.client_cert,
                   help="Client cert for mTLS (device.crt).")
    p.add_argument("--client-key", default=_env("EDGE_SIM_CLIENT_KEY") or d.client_key,
                   help="Client private key for mTLS (device.key).")
    p.add_argument("--insecure", action="store_true",
                   default=_as_bool(_env("EDGE_SIM_INSECURE"), d.insecure),
                   help="Skip broker cert hostname/chain verification (dev only). "
                        "Normally unneeded: the CA tool puts both the FQDN and IP "
                        "in the broker cert SAN, so dialing either --host verifies.")
    p.add_argument("--username", default=_env("EDGE_SIM_USERNAME") or d.username,
                   help="MQTT username (omit for mTLS: broker derives it from the cert CN).")
    p.add_argument("--password", default=_env("EDGE_SIM_PASSWORD") or d.password,
                   help="MQTT password.")
    p.add_argument("--client-id", default=_env("EDGE_SIM_CLIENT_ID") or d.client_id,
                   help="MQTT client id (default: device_id; ignored by the mTLS broker).")
    p.add_argument("--keepalive", type=int,
                   default=int(_env("EDGE_SIM_KEEPALIVE") or d.keepalive),
                   help="MQTT keepalive seconds.")

    # Identity
    p.add_argument("--tenant-id", default=_env("EDGE_SIM_TENANT_ID") or _env("VP_TENANT_ID") or d.tenant_id)
    p.add_argument("--site-id", default=_env("EDGE_SIM_SITE_ID") or _env("VP_SITE_ID") or d.site_id)
    p.add_argument("--device-id", default=_env("EDGE_SIM_DEVICE_ID") or _env("VP_DEVICE_ID") or d.device_id)

    # Cadence
    p.add_argument("--interval", type=float, default=float(_env("EDGE_SIM_INTERVAL") or d.interval),
                   help="Seconds between telemetry samples.")
    p.add_argument("--status-interval", type=float,
                   default=float(_env("EDGE_SIM_STATUS_INTERVAL") or d.status_interval),
                   help="Seconds between status heartbeats.")
    p.add_argument("--count", type=int, default=int(_env("EDGE_SIM_COUNT") or d.count),
                   help="Stop after N telemetry messages (0 = run forever).")
    p.add_argument("--qos", type=int, choices=(0, 1, 2), default=int(_env("EDGE_SIM_QOS") or d.qos))

    # Simulation
    p.add_argument("--time-scale", type=float, default=float(_env("EDGE_SIM_TIME_SCALE") or d.time_scale),
                   help="Simulated seconds per real second. 1=realtime; e.g. 288 plays a full day in 5 min.")
    p.add_argument("--start-hour", type=float,
                   default=(float(_env("EDGE_SIM_START_HOUR")) if _env("EDGE_SIM_START_HOUR") else d.start_hour),
                   help="Sim start hour-of-day 0-24 (default: real local clock).")
    p.add_argument("--pv-peak-kw", type=float, default=float(_env("EDGE_SIM_PV_PEAK_KW") or d.pv_peak_kw))
    p.add_argument("--load-base-kw", type=float, default=float(_env("EDGE_SIM_LOAD_BASE_KW") or d.load_base_kw))
    p.add_argument("--batt-capacity-kwh", type=float,
                   default=float(_env("EDGE_SIM_BATT_CAPACITY_KWH") or d.batt_capacity_kwh))
    p.add_argument("--batt-max-kw", type=float, default=float(_env("EDGE_SIM_BATT_MAX_KW") or d.batt_max_kw))
    p.add_argument("--soc-init-pct", type=float, default=float(_env("EDGE_SIM_SOC_INIT_PCT") or d.soc_init_pct))
    p.add_argument("--grid-limit-kw", type=float, default=float(_env("EDGE_SIM_GRID_LIMIT_KW") or d.grid_limit_kw))
    p.add_argument("--noise", type=float, default=float(_env("EDGE_SIM_NOISE") or d.noise),
                   help="Relative measurement noise 0..1.")
    p.add_argument("--seed", type=int,
                   default=(int(_env("EDGE_SIM_SEED")) if _env("EDGE_SIM_SEED") else d.seed),
                   help="Seed for deterministic noise (useful for tests/proofs).")
    p.add_argument("--verbose", "-v", action="store_true",
                   default=_as_bool(_env("EDGE_SIM_VERBOSE"), d.verbose))

    a = p.parse_args(argv)

    tls = a.tls or a.port == 8883 or bool(a.client_cert)
    cfg = Config(
        host=a.host, port=a.port, tls=tls, ca_cert=a.ca_cert,
        client_cert=a.client_cert, client_key=a.client_key,
        insecure=a.insecure,
        username=a.username, password=a.password, client_id=a.client_id,
        keepalive=a.keepalive,
        tenant_id=a.tenant_id, site_id=a.site_id, device_id=a.device_id,
        interval=a.interval, status_interval=a.status_interval, count=a.count, qos=a.qos,
        time_scale=a.time_scale, start_hour=a.start_hour,
        pv_peak_kw=a.pv_peak_kw, load_base_kw=a.load_base_kw,
        batt_capacity_kwh=a.batt_capacity_kwh, batt_max_kw=a.batt_max_kw,
        soc_init_pct=a.soc_init_pct, grid_limit_kw=a.grid_limit_kw,
        noise=a.noise, seed=a.seed, verbose=a.verbose,
    )
    validate_config(cfg)
    return cfg


def validate_config(cfg: Config) -> None:
    for name, val in (("tenant_id", cfg.tenant_id), ("site_id", cfg.site_id), ("device_id", cfg.device_id)):
        try:
            uuid.UUID(str(val))
        except (ValueError, TypeError):
            raise SystemExit(f"error: {name} must be a UUID, got {val!r}")
    if cfg.interval <= 0:
        raise SystemExit("error: --interval must be > 0")
    if cfg.time_scale <= 0:
        raise SystemExit("error: --time-scale must be > 0")
    if cfg.tls and cfg.client_cert and not cfg.client_key:
        raise SystemExit("error: --client-cert requires --client-key for mTLS")
    if cfg.batt_capacity_kwh <= 0:
        raise SystemExit("error: --batt-capacity-kwh must be > 0")


# ---------------------------------------------------------------------------
# Physical simulation - a believable PV / load / battery day
# ---------------------------------------------------------------------------

@dataclass
class SimState:
    soc_pct: float
    seq: int = 0
    _rng: "_Rng" = field(default=None)  # type: ignore[assignment]


class _Rng:
    """Tiny deterministic PRNG (xorshift) so noise is reproducible with --seed
    and we never need numpy/random import surprises across hosts."""

    def __init__(self, seed: int | None):
        if seed is None:
            seed = (int(time.time() * 1e6) ^ os.getpid()) & 0xFFFFFFFF
        self._s = (seed & 0xFFFFFFFF) or 0x9E3779B9

    def _next(self) -> int:
        x = self._s
        x ^= (x << 13) & 0xFFFFFFFF
        x ^= x >> 17
        x ^= (x << 5) & 0xFFFFFFFF
        self._s = x & 0xFFFFFFFF
        return self._s

    def uniform(self, lo: float, hi: float) -> float:
        return lo + (hi - lo) * (self._next() / 0xFFFFFFFF)


def pv_power_kw(hour: float, peak_kw: float, cloud: float) -> float:
    """Diurnal PV curve: zero at night, single peak near solar noon.

    Summer DACH-ish daylight window; a sine base raised to a mild exponent to
    fatten the midday peak, scaled by a slowly varying cloud factor (0.6..1.0).
    """
    sunrise, sunset = 5.5, 20.5
    if hour <= sunrise or hour >= sunset:
        return 0.0
    x = (hour - sunrise) / (sunset - sunrise)  # 0..1 across the day
    shape = math.sin(math.pi * x) ** 1.3       # 0..1, peaked at solar noon
    return max(0.0, peak_kw * shape * cloud)


def household_load_kw(hour: float, base_kw: float) -> float:
    """Household load: a base draw plus morning, midday and evening bumps."""
    def bump(center: float, width: float, amp: float) -> float:
        return amp * math.exp(-0.5 * ((hour - center) / width) ** 2)

    load = base_kw
    load += bump(7.5, 1.1, 1.3)    # morning routine
    load += bump(12.5, 1.6, 0.6)   # midday
    load += bump(19.0, 1.8, 2.2)   # evening peak (cooking, etc.)
    return max(0.05, load)


def battery_dispatch(pv: float, load: float, soc: float, hour: float,
                     max_kw: float, capacity_kwh: float, dt_h: float) -> tuple[float, float]:
    """Simple self-consumption rule: charge on PV surplus (midday), discharge to
    cover the evening/overnight deficit. Returns (battery_power_kw, new_soc_pct)
    where battery_power_kw > 0 means charging (draws power), < 0 discharging.
    Charge/discharge are clamped so SoC stays within a 10..100% band.
    """
    surplus = pv - load
    batt = 0.0
    if surplus > 0.05 and soc < 98.0:
        batt = min(surplus, max_kw)                       # soak up PV excess
    elif surplus < -0.05 and soc > 15.0 and (hour >= 17.0 or hour < 7.0):
        batt = -min(-surplus, max_kw)                     # cover evening load

    if dt_h > 0:
        if batt > 0:  # charging: cap by headroom to 100%
            headroom_kwh = (100.0 - soc) / 100.0 * capacity_kwh
            batt = min(batt, headroom_kwh / dt_h)
        elif batt < 0:  # discharging: cap by energy above the 10% floor
            avail_kwh = (soc - 10.0) / 100.0 * capacity_kwh
            batt = -min(-batt, avail_kwh / dt_h)

    new_soc = soc + (batt * dt_h) / capacity_kwh * 100.0
    new_soc = max(0.0, min(100.0, new_soc))
    return batt, new_soc


def simulate_measurements(cfg: Config, state: SimState, hour: float, dt_h: float) -> dict:
    """Advance the model one step and return the `measurements` block.

    Grid coupling identity: power_kw = load_kw - pv_power_kw + battery_power_kw
    (positive = import from grid, negative = export).
    """
    rng = state._rng
    n = max(0.0, cfg.noise)

    # Slowly varying cloud factor keyed off the sim hour so PV isn't jittery.
    cloud = 0.85 + 0.15 * math.sin(hour * 0.7) + (rng.uniform(-n, n) if n else 0.0)
    cloud = max(0.5, min(1.05, cloud))

    pv = pv_power_kw(hour, cfg.pv_peak_kw, cloud)
    load = household_load_kw(hour, cfg.load_base_kw)
    if n:
        load *= 1.0 + rng.uniform(-n, n)

    batt, new_soc = battery_dispatch(pv, load, state.soc_pct, hour,
                                     cfg.batt_max_kw, cfg.batt_capacity_kwh, dt_h)
    state.soc_pct = new_soc

    grid = load - pv + batt

    return {
        "power_kw": round(grid, 3),
        "soc_pct": round(max(0.0, min(100.0, new_soc)), 2),
        "pv_power_kw": round(max(0.0, pv), 3),
        "load_kw": round(max(0.0, load), 3),
        "grid_limit_kw": round(cfg.grid_limit_kw, 3),
    }


# ---------------------------------------------------------------------------
# Payload builders (BINDING contract - keep field names/shape exact)
# ---------------------------------------------------------------------------

def rfc3339_now() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def build_telemetry_payload(cfg: Config, ts: str, seq: int, measurements: dict) -> dict:
    """docs/contracts/mqtt-telemetry.schema.json (schema_version "1.0")."""
    return {
        "schema_version": SCHEMA_VERSION,
        "tenant_id": cfg.tenant_id,
        "site_id": cfg.site_id,
        "device_id": cfg.device_id,
        "ts": ts,
        "seq": seq,
        "measurements": measurements,
    }


def build_status_payload(cfg: Config, ts: str, seq: int, uptime_s: float, online: bool = True) -> dict:
    """Health heartbeat on .../status. The status topic has no frozen contract
    yet; this shape is intentionally small and additive (schema_version tagged)."""
    return {
        "schema_version": SCHEMA_VERSION,
        "tenant_id": cfg.tenant_id,
        "site_id": cfg.site_id,
        "device_id": cfg.device_id,
        "ts": ts,
        "status": "online" if online else "offline",
        "uptime_s": round(uptime_s, 1),
        "seq": seq,
        "sw_version": SW_VERSION,
    }


def topic(cfg: Config, leaf: str) -> str:
    return f"ems/{cfg.tenant_id}/{cfg.site_id}/{cfg.device_id}/{leaf}"


# ---------------------------------------------------------------------------
# Sim clock: maps real elapsed time to a (optionally accelerated) hour-of-day
# ---------------------------------------------------------------------------

class SimClock:
    def __init__(self, time_scale: float, start_hour: float | None):
        self.scale = time_scale
        if start_hour is None:
            lt = time.localtime()
            start_s = lt.tm_hour * 3600 + lt.tm_min * 60 + lt.tm_sec
        else:
            start_s = (start_hour % 24.0) * 3600.0
        self._start_s = start_s
        self._t0 = time.monotonic()

    def hour_of_day(self) -> float:
        elapsed = time.monotonic() - self._t0
        sim_s = self._start_s + elapsed * self.scale
        return (sim_s % 86400.0) / 3600.0


# ---------------------------------------------------------------------------
# MQTT client wiring
# ---------------------------------------------------------------------------

def _make_client(cfg: Config) -> "mqtt.Client":
    client_id = cfg.client_id or cfg.device_id
    # VERSION1 callbacks give a stable signature across paho-mqtt 1.x and 2.x.
    try:
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1, client_id=client_id, clean_session=False)
    except (AttributeError, TypeError):  # paho-mqtt 1.x
        client = mqtt.Client(client_id=client_id, clean_session=False)

    if cfg.username:
        client.username_pw_set(cfg.username, cfg.password)

    if cfg.tls:
        import ssl
        client.tls_set(
            ca_certs=cfg.ca_cert,
            certfile=cfg.client_cert,
            keyfile=cfg.client_key,
            cert_reqs=ssl.CERT_REQUIRED,
            tls_version=ssl.PROTOCOL_TLS_CLIENT,
        )
        if cfg.insecure:
            # paho verifies the broker cert against the connect host (SNI). The
            # CA tool adds both the FQDN and IP to the server cert SAN, so normal
            # verification works when dialing either; --insecure is the dev-only
            # escape hatch for a cert that lists neither the host you dialed.
            client.tls_insecure_set(True)

    # Graceful last-will so a hard crash marks the device offline for consumers.
    will = build_status_payload(cfg, rfc3339_now(), -1, 0.0, online=False)
    client.will_set(topic(cfg, "status"), json.dumps(will), qos=cfg.qos, retain=False)

    client.reconnect_delay_set(min_delay=1, max_delay=30)
    return client


def run(cfg: Config) -> int:
    state = SimState(soc_pct=cfg.soc_init_pct, _rng=_Rng(cfg.seed))
    connected = {"ok": False}

    def on_connect(client, userdata, flags, rc, *args):
        if rc == 0:
            connected["ok"] = True
            _log(cfg, f"connected to {cfg.host}:{cfg.port} "
                      f"({'mTLS' if cfg.tls else 'plain'}) as clientid={cfg.client_id or cfg.device_id}")
        else:
            connected["ok"] = False
            _log(cfg, f"connect failed rc={rc}", err=True)

    def on_disconnect(client, userdata, rc, *args):
        connected["ok"] = False
        if rc != 0:
            _log(cfg, f"disconnected (rc={rc}); auto-reconnecting", err=True)

    client = _make_client(cfg)
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect

    stopping = {"flag": False}

    def _stop(signum, frame):
        stopping["flag"] = True

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    tel_topic = topic(cfg, "telemetry")
    st_topic = topic(cfg, "status")

    try:
        client.connect(cfg.host, cfg.port, keepalive=cfg.keepalive)
    except Exception as exc:  # noqa: BLE001 - surface any transport/TLS error clearly
        _log(cfg, f"initial connect to {cfg.host}:{cfg.port} failed: {exc}", err=True)
        return 2

    client.loop_start()
    clock = SimClock(cfg.time_scale, cfg.start_hour)
    started = time.monotonic()
    last_status = 0.0
    last_tick = time.monotonic()
    published = 0

    # Publish an initial "online" status right away.
    _publish(client, st_topic,
             build_status_payload(cfg, rfc3339_now(), state.seq, 0.0), cfg.qos)

    _log(cfg, f"publishing telemetry to {tel_topic} every {cfg.interval}s "
              f"(time-scale x{cfg.time_scale}); Ctrl-C to stop")

    rc = 0
    while not stopping["flag"]:
        now = time.monotonic()
        dt_h = max(0.0, (now - last_tick)) * cfg.time_scale / 3600.0
        last_tick = now
        hour = clock.hour_of_day()

        measurements = simulate_measurements(cfg, state, hour, dt_h)
        ts = rfc3339_now()
        payload = build_telemetry_payload(cfg, ts, state.seq, measurements)
        ok = _publish(client, tel_topic, payload, cfg.qos)
        if cfg.verbose:
            _log(cfg, f"[{ts} h={hour:04.1f}] tx#{state.seq} pv={measurements['pv_power_kw']}kW "
                      f"load={measurements['load_kw']}kW soc={measurements['soc_pct']}% "
                      f"grid={measurements['power_kw']}kW {'ok' if ok else 'QUEUED'}")
        state.seq += 1
        published += 1

        if now - last_status >= cfg.status_interval:
            _publish(client, st_topic,
                     build_status_payload(cfg, ts, state.seq, now - started), cfg.qos)
            last_status = now

        if cfg.count and published >= cfg.count:
            _log(cfg, f"published {published} telemetry messages; exiting (--count)")
            break

        # Sleep in small slices so Ctrl-C is responsive.
        target = now + cfg.interval
        while not stopping["flag"] and time.monotonic() < target:
            time.sleep(min(0.2, max(0.0, target - time.monotonic())))

    # Best-effort graceful "offline" status, then clean disconnect.
    try:
        _publish(client, st_topic,
                 build_status_payload(cfg, rfc3339_now(), state.seq, time.monotonic() - started, online=False),
                 cfg.qos)
        client.loop_write()
        time.sleep(0.2)
    finally:
        client.loop_stop()
        client.disconnect()
    _log(cfg, "stopped")
    return rc


def _publish(client, topic_str: str, payload: dict, qos: int) -> bool:
    info = client.publish(topic_str, json.dumps(payload, separators=(",", ":")), qos=qos, retain=False)
    try:
        # Don't block forever; QoS1 delivery completes as the network loop runs.
        info.wait_for_publish(timeout=5.0)
        return info.is_published()
    except (ValueError, RuntimeError):
        return False


def _log(cfg: Config, msg: str, err: bool = False) -> None:
    stream = sys.stderr if err else sys.stdout
    stream.write(f"{datetime.now().strftime('%H:%M:%S')} edge-sim: {msg}\n")
    stream.flush()


def main(argv: list[str] | None = None) -> int:
    cfg = build_config(argv)
    return run(cfg)


if __name__ == "__main__":
    raise SystemExit(main())
