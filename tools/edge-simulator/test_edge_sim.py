"""Lightweight, offline tests for the VoltPilot edge simulator.

No broker, no Docker, no network. Run with either:
    python3 -m pytest test_edge_sim.py -q
    python3 test_edge_sim.py              # falls back to a built-in runner

The strongest check validates a generated telemetry payload against the REAL
binding contract (docs/contracts/mqtt-telemetry.schema.json), so a drift in the
payload shape fails here before it ever reaches the ingest service.
"""

from __future__ import annotations

import json
import os
import re
import socket
import struct
import threading
import uuid

import voltpilot_edge_sim as sim

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCHEMA_PATH = os.path.join(REPO_ROOT, "docs", "contracts", "mqtt-telemetry.schema.json")
PROVISIONING_SCHEMA_PATH = os.path.join(REPO_ROOT, "docs", "contracts", "mqtt-provisioning.schema.json")

RFC3339 = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")


def _cfg(**kw) -> sim.Config:
    base = dict(seed=42, noise=0.04)
    base.update(kw)
    return sim.Config(**base)


def _one_sample(cfg: sim.Config, hour: float) -> dict:
    state = sim.SimState(soc_pct=cfg.soc_init_pct, _rng=sim._Rng(cfg.seed))
    return sim.simulate_measurements(cfg, state, hour, dt_h=cfg.interval / 3600.0)


# --- Contract conformance ---------------------------------------------------

def _manual_validate_telemetry(payload: dict) -> None:
    """Mirror mqtt-telemetry.schema.json exactly (no external dep needed)."""
    required = {"schema_version", "device_id", "site_id", "tenant_id", "ts", "measurements"}
    allowed = required | {"seq"}
    assert required <= set(payload), f"missing required keys: {required - set(payload)}"
    assert set(payload) <= allowed, f"unexpected keys: {set(payload) - allowed}"
    assert payload["schema_version"] == "1.0"
    for k in ("tenant_id", "site_id", "device_id"):
        uuid.UUID(payload[k])  # raises on non-UUID
    assert RFC3339.match(payload["ts"]), payload["ts"]
    if "seq" in payload:
        assert isinstance(payload["seq"], int) and payload["seq"] >= 0

    m = payload["measurements"]
    assert isinstance(m, dict)
    m_allowed = {"power_kw", "soc_pct", "pv_power_kw", "load_kw", "grid_limit_kw"}
    assert set(m) <= m_allowed, f"unexpected measurement keys: {set(m) - m_allowed}"
    for k, v in m.items():
        assert isinstance(v, (int, float)) and not isinstance(v, bool), f"{k} not numeric"
    if "soc_pct" in m:
        assert 0.0 <= m["soc_pct"] <= 100.0


def test_payload_matches_contract_manual():
    cfg = _cfg()
    payload = sim.build_telemetry_payload(cfg, sim.rfc3339_now(), 0, _one_sample(cfg, 13.0))
    _manual_validate_telemetry(payload)


def test_payload_matches_contract_jsonschema():
    try:
        import jsonschema  # type: ignore
    except ImportError:
        return  # optional; the manual check above already covers the shape
    with open(SCHEMA_PATH, "r", encoding="utf-8") as fh:
        schema = json.load(fh)
    cfg = _cfg()
    # exercise several hours of the day, incl. night (PV=0) and noon (PV peak)
    state = sim.SimState(soc_pct=cfg.soc_init_pct, _rng=sim._Rng(cfg.seed))
    for hour in (0.0, 6.0, 9.0, 13.0, 18.0, 21.0):
        m = sim.simulate_measurements(cfg, state, hour, dt_h=0.25)
        payload = sim.build_telemetry_payload(cfg, sim.rfc3339_now(), state.seq, m)
        jsonschema.validate(payload, schema)


# --- Physical plausibility --------------------------------------------------

def test_pv_zero_at_night_peak_midday():
    cfg = _cfg(noise=0.0)
    assert _one_sample(cfg, 2.0)["pv_power_kw"] == 0.0
    assert _one_sample(cfg, 23.0)["pv_power_kw"] == 0.0
    noon = _one_sample(cfg, 13.0)["pv_power_kw"]
    assert noon > 0.5 * cfg.pv_peak_kw, noon
    assert noon <= cfg.pv_peak_kw + 1e-6


def test_grid_power_balance_identity():
    """power_kw == load_kw - pv_power_kw + battery_power (battery is implicit).
    We can't read battery directly, but load - pv - grid must equal -battery,
    and |battery| must never exceed the configured max charge/discharge rate."""
    cfg = _cfg(noise=0.0)
    state = sim.SimState(soc_pct=50.0, _rng=sim._Rng(cfg.seed))
    for hour in [h / 2 for h in range(0, 48)]:
        m = sim.simulate_measurements(cfg, state, hour, dt_h=0.25)
        battery = m["power_kw"] - (m["load_kw"] - m["pv_power_kw"])
        assert abs(battery) <= cfg.batt_max_kw + 1e-6, (hour, battery)


def test_soc_stays_in_band_over_a_day():
    cfg = _cfg(noise=0.02)
    state = sim.SimState(soc_pct=cfg.soc_init_pct, _rng=sim._Rng(cfg.seed))
    # step every 15 sim-minutes for a full 24h
    for step in range(96):
        hour = (step * 15) / 60.0
        m = sim.simulate_measurements(cfg, state, hour, dt_h=0.25)
        assert 0.0 <= m["soc_pct"] <= 100.0
    # battery should actually cycle: charge midday, discharge evening
    midday = _one_sample(_cfg(noise=0.0), 13.0)
    assert midday["pv_power_kw"] > midday["load_kw"]  # surplus available midday


def test_battery_charges_midday_discharges_evening():
    cfg = _cfg(noise=0.0)
    # Fresh state at 40% -> a midday step should raise SoC (charging).
    s1 = sim.SimState(soc_pct=40.0, _rng=sim._Rng(1))
    before = s1.soc_pct
    sim.simulate_measurements(cfg, s1, 13.0, dt_h=1.0)
    assert s1.soc_pct > before  # charged

    # Evening deficit with charge available -> SoC should fall (discharging).
    s2 = sim.SimState(soc_pct=80.0, _rng=sim._Rng(1))
    before2 = s2.soc_pct
    sim.simulate_measurements(cfg, s2, 19.5, dt_h=1.0)
    assert s2.soc_pct < before2  # discharged


# --- Topic + config ---------------------------------------------------------

def test_topic_format():
    cfg = _cfg()
    assert sim.topic(cfg, "telemetry") == \
        f"ems/{cfg.tenant_id}/{cfg.site_id}/{cfg.device_id}/telemetry"
    assert sim.topic(cfg, "status").endswith("/status")


def test_status_payload_shape():
    cfg = _cfg()
    st = sim.build_status_payload(cfg, sim.rfc3339_now(), 5, 12.3)
    assert st["schema_version"] == "1.0"
    assert st["status"] == "online"
    assert st["device_id"] == cfg.device_id
    assert RFC3339.match(st["ts"])


def test_config_uuid_validation_rejects_garbage():
    try:
        sim.validate_config(_cfg(device_id="not-a-uuid"))
    except SystemExit:
        return
    raise AssertionError("expected SystemExit for a non-UUID device_id")


def test_cli_overrides_env(monkeypatch=None):
    os.environ["EDGE_SIM_HOST"] = "envhost"
    os.environ["EDGE_SIM_PORT"] = "1883"
    try:
        cfg = sim.build_config(["--host", "clihost", "--port", "8883"])
        assert cfg.host == "clihost"
        assert cfg.port == 8883
        assert cfg.tls is True  # auto-enabled on 8883
    finally:
        del os.environ["EDGE_SIM_HOST"]
        del os.environ["EDGE_SIM_PORT"]


def test_time_scale_default_env_only():
    # No CLI, defaults resolve cleanly.
    cfg = sim.build_config([])
    assert cfg.time_scale == 1.0
    assert cfg.tenant_id == sim.DEFAULT_TENANT_ID


# --- Zero-touch provisioning handshake ---------------------------------------
#
# The wire tests run the REAL paho client against an in-process MQTT 3.1.1
# broker stub (no Docker, no external broker): CONNECT/CONNACK, SUBSCRIBE/
# SUBACK (with retained delivery), PUBLISH qos0/1 (+PUBACK), PINGREQ/PINGRESP.


def _encode_len(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n % 128
        n //= 128
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def _recv_exact(conn: socket.socket, n: int) -> bytes | None:
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


class BrokerStub:
    """Minimal in-process MQTT 3.1.1 broker for the provisioning handshake.

    `respond_with_config(ref) -> dict | None` plays the cloud resolver: when a
    hello arrives on provision/{ref}/hello and the callable returns a config
    dict, it is stored retained and delivered to subscribers of
    provision/{ref}/config - exactly the contract's claimed-ref behavior.
    `retained` pre-seeds retained messages (the re-provision-after-restart case).
    """

    def __init__(self, respond_with_config=None, retained: dict | None = None):
        self.hellos: list[tuple[str, dict]] = []
        self._respond = respond_with_config
        self._retained: dict[str, bytes] = dict(retained or {})
        self._subs: list[tuple[socket.socket, str]] = []
        self._lock = threading.Lock()
        self._server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server.bind(("127.0.0.1", 0))
        self._server.listen(5)
        self.port = self._server.getsockname()[1]
        self._closing = False
        threading.Thread(target=self._accept_loop, daemon=True).start()

    def close(self):
        self._closing = True
        try:
            self._server.close()
        except OSError:
            pass

    # -- wire handling --------------------------------------------------------

    def _accept_loop(self):
        while not self._closing:
            try:
                conn, _ = self._server.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _serve(self, conn: socket.socket):
        try:
            while True:
                packet = self._read_packet(conn)
                if packet is None:
                    return
                ptype, body = packet
                kind = ptype >> 4
                if kind == 1:  # CONNECT
                    conn.sendall(b"\x20\x02\x00\x00")  # CONNACK, rc=0
                elif kind == 8:  # SUBSCRIBE
                    pid = body[0:2]
                    (tlen,) = struct.unpack("!H", body[2:4])
                    topic = body[4:4 + tlen].decode()
                    with self._lock:
                        self._subs.append((conn, topic))
                        retained = [(t, p) for t, p in self._retained.items() if t == topic]
                    conn.sendall(b"\x90\x03" + pid + b"\x01")  # SUBACK, granted qos1
                    for t, p in retained:
                        self._send_publish(conn, t, p, retain=True)
                elif kind == 3:  # PUBLISH
                    qos = (ptype >> 1) & 0x03
                    (tlen,) = struct.unpack("!H", body[0:2])
                    topic = body[2:2 + tlen].decode()
                    rest = body[2 + tlen:]
                    if qos:
                        pid, rest = rest[0:2], rest[2:]
                        conn.sendall(b"\x40\x02" + pid)  # PUBACK
                    self._on_publish(topic, rest)
                elif kind == 12:  # PINGREQ
                    conn.sendall(b"\xd0\x00")
                elif kind == 14:  # DISCONNECT
                    return
        except OSError:
            return
        finally:
            with self._lock:
                self._subs = [(c, t) for c, t in self._subs if c is not conn]
            try:
                conn.close()
            except OSError:
                pass

    @staticmethod
    def _read_packet(conn: socket.socket):
        first = _recv_exact(conn, 1)
        if first is None:
            return None
        mult, length = 1, 0
        while True:
            b = _recv_exact(conn, 1)
            if b is None:
                return None
            length += (b[0] & 0x7F) * mult
            if not b[0] & 0x80:
                break
            mult *= 128
        body = _recv_exact(conn, length) if length else b""
        if length and body is None:
            return None
        return first[0], body

    @staticmethod
    def _send_publish(conn: socket.socket, topic: str, payload: bytes, retain=False):
        t = topic.encode()
        body = struct.pack("!H", len(t)) + t + payload  # qos0 delivery, no pid
        conn.sendall(bytes([0x30 | (0x01 if retain else 0)]) + _encode_len(len(body)) + body)

    def _on_publish(self, topic: str, payload: bytes):
        m = re.match(r"^provision/([^/]+)/hello$", topic)
        if m:
            self.hellos.append((topic, json.loads(payload)))
            if self._respond:
                config = self._respond(m.group(1))
                if config is not None:
                    self.publish_retained(f"provision/{m.group(1)}/config",
                                          json.dumps(config).encode())

    def publish_retained(self, topic: str, payload: bytes):
        with self._lock:
            self._retained[topic] = payload
            targets = [c for c, t in self._subs if t == topic]
        for conn in targets:
            try:
                self._send_publish(conn, topic, payload)
            except OSError:
                pass


_T = "10000000-0000-0000-0000-000000000001"
_S = "10000000-0000-0000-0000-000000000042"
_D = "10000000-0000-0000-0000-000000000077"


def _config_for(ref: str) -> dict:
    return {"schema_version": "1.0", "ref": ref,
            "tenant_id": _T, "site_id": _S, "device_id": _D}


def test_provision_claimed_ref_adopts_identity():
    broker = BrokerStub(respond_with_config=_config_for)
    try:
        cfg = _cfg(ref="edge-77", host="127.0.0.1", port=broker.port,
                   provision_retry=0.3, provision_timeout=15.0)
        assert sim.provision(cfg) is True
        assert cfg.tenant_id == _T
        assert cfg.site_id == _S
        assert cfg.device_id == _D
        # ...and the telemetry topic now carries the provisioned identity.
        assert sim.topic(cfg, "telemetry") == f"ems/{_T}/{_S}/{_D}/telemetry"
        # The hello that went over the wire is contract-shaped.
        topic, hello = broker.hellos[0]
        assert topic == "provision/edge-77/hello"
        assert hello["schema_version"] == "1.0"
        assert hello["ref"] == "edge-77"
        assert RFC3339.match(hello["ts"])
    finally:
        broker.close()


def test_provision_unclaimed_ref_retries_hello_then_times_out():
    broker = BrokerStub()  # never answers: the ref is not claimed
    try:
        cfg = _cfg(ref="edge-unclaimed", host="127.0.0.1", port=broker.port,
                   provision_retry=0.25, provision_timeout=1.5)
        assert sim.provision(cfg) is False
        # The device kept retrying (>= 2 hellos in 1.5s at 0.25s cadence).
        assert len(broker.hellos) >= 2
    finally:
        broker.close()


def test_provision_retained_config_reprovisions_without_hello_answer():
    # Re-provision after restart: the broker already holds the RETAINED config,
    # so the identity arrives on subscribe - no resolver round-trip needed.
    broker = BrokerStub(retained={
        "provision/edge-restart/config": json.dumps(_config_for("edge-restart")).encode(),
    })
    try:
        cfg = _cfg(ref="edge-restart", host="127.0.0.1", port=broker.port,
                   provision_retry=5.0, provision_timeout=15.0)
        assert sim.provision(cfg) is True
        assert cfg.device_id == _D
    finally:
        broker.close()


def test_provision_ignores_config_with_foreign_ref():
    # A config whose payload ref does not match ours MUST be ignored.
    broker = BrokerStub(respond_with_config=lambda ref: _config_for("someone-else"))
    try:
        cfg = _cfg(ref="edge-strict", host="127.0.0.1", port=broker.port,
                   provision_retry=0.25, provision_timeout=1.5)
        assert sim.provision(cfg) is False
    finally:
        broker.close()


def test_parse_provision_config_validation():
    ok = sim.parse_provision_config("r1", json.dumps(_config_for("r1")))
    assert ok == {"tenant_id": _T, "site_id": _S, "device_id": _D}
    assert sim.parse_provision_config("r1", "not json") is None
    assert sim.parse_provision_config("r1", json.dumps({"schema_version": "2.0"})) is None
    assert sim.parse_provision_config("r1", json.dumps(_config_for("r2"))) is None
    bad = _config_for("r1")
    bad["device_id"] = "not-a-uuid"
    assert sim.parse_provision_config("r1", json.dumps(bad)) is None


def test_hello_payload_matches_provisioning_contract():
    payload = sim.build_hello_payload("edge-77", sim.rfc3339_now())
    assert set(payload) == {"schema_version", "ref", "ts", "sw_version"}
    assert payload["schema_version"] == "1.0"
    assert sim.REF_PATTERN.match(payload["ref"])
    assert RFC3339.match(payload["ts"])
    try:
        import jsonschema  # type: ignore
    except ImportError:
        return
    with open(PROVISIONING_SCHEMA_PATH, "r", encoding="utf-8") as fh:
        schema = json.load(fh)
    jsonschema.validate(payload, schema)  # matches oneOf -> $defs/hello
    jsonschema.validate(_config_for("edge-77"), schema)  # and $defs/config


def test_ref_mode_config_skips_uuid_validation():
    cfg = sim.build_config(["--host", "broker.local", "--ref", "edge-9"])
    assert cfg.ref == "edge-9"
    sim.validate_config(cfg)  # no UUIDs required in ref mode

    try:
        sim.validate_config(_cfg(ref="bad/ref"))
    except SystemExit:
        pass
    else:
        raise AssertionError("expected SystemExit for a ref with '/'")


if __name__ == "__main__":
    # Minimal runner so the suite works without pytest installed.
    funcs = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in funcs:
        try:
            fn()
            print(f"ok   {fn.__name__}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"FAIL {fn.__name__}: {exc}")
    print(f"\n{len(funcs) - failed}/{len(funcs)} passed")
    raise SystemExit(1 if failed else 0)
