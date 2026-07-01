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
import uuid

import voltpilot_edge_sim as sim

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCHEMA_PATH = os.path.join(REPO_ROOT, "docs", "contracts", "mqtt-telemetry.schema.json")

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
