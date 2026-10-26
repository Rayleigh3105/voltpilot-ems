"""Ein OCPP-Ladepunkt im Haushalt, so wie die API ihn anlegt (Audit W-02).

Profil und Policy-Dokument kommen aus ``docs/contracts/v2/ladepunkt-profil-
vectors.json``, die die API selbst pinnt (``LadepunktProfilVectorsTest``,
``SteuerartApiTest``) - hier setzt niemand ``control_kind`` oder die
Nennleistung von Hand. Die Tests zu #1569 waren grün, weil sie ein Profil
annahmen, das die API nie anlegte.

Die Optimierer-Probe aus dem Audit (Anhang A) als Test: „Günstig" mit dem Ziel
„20 kWh bis 06:00" in der Nacht 24./25.10.2026 (Sommerzeitende), gerechnet zu
den Läufen 22:00 und 04:30, während der Preis überall ÜBER der Grenze liegt -
nur das Ziel lädt.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import sys
import types
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest

from voltpilot_optimization.consumer_inputs import (
    ConsumerProfileRow,
    compile_consumer,
    load_consumer_entities,
)
from voltpilot_optimization.domain import horizon_slot_starts

VECTORS = (
    Path(__file__).resolve().parents[3]
    / "docs" / "contracts" / "v2" / "ladepunkt-profil-vectors.json"
)
BERLIN = ZoneInfo("Europe/Berlin")
TEUER_CT = 35.0  # über der Grenze 28 ct des Vektors: „Günstig" lädt nie

solver = pytest.mark.skipif(
    importlib.util.find_spec("highspy") is None,
    reason="highspy not installed (install the [solver] extra)",
)


def _vektoren() -> dict:
    return json.loads(VECTORS.read_text(encoding="utf-8"))


def _fall(name: str) -> dict:
    (fall,) = [f for f in _vektoren()["faelle"] if f["name"] == name]
    return fall


def profil_der_api(fall: dict, entity_id: str = "lp-1") -> ConsumerProfileRow:
    """Das Profil, das ``ConsumerService.ensureProfile`` anlegt."""
    p = fall["profil"]
    return ConsumerProfileRow(
        entity_id=entity_id,
        control_kind=p["control_kind"],
        rated_power_kw=float(p["rated_power_kw"]),
    )


def _berlin(tag: int, stunde: int, minute: int = 0) -> datetime:
    return datetime(2026, 10, tag, stunde, minute, tzinfo=BERLIN).astimezone(timezone.utc)


def _plan(jetzt: datetime, slots: int):
    from voltpilot_optimization.co_solver import co_optimize
    from voltpilot_optimization.domain import BatteryParams
    from voltpilot_optimization.entities import CoOptimizationInput, StorageEntity
    from voltpilot_optimization.publisher_v2 import build_plan_v2_payload

    fall = _fall("guenstig-mit-ziel")
    starts = horizon_slot_starts(jetzt, slots)
    imp = [TEUER_CT] * slots
    spot = [p - 20.0 for p in imp]
    load = compile_consumer(profil_der_api(fall), fall["dokument"], starts, 15, spot, imp)
    assert load is not None
    inp = CoOptimizationInput(
        tenant_id=uuid4(), site_id=uuid4(), device_id=uuid4(),
        slot_starts=starts,
        prices_eur_mwh=[p * 10.0 for p in spot],
        base_load_kw=[0.5] * slots,
        # Ein Haushalt wie im Feld: der Optimierer plant nur Anlagen mit Speicher.
        storages=(StorageEntity(
            entity_id="speicher",
            params=BatteryParams(capacity_kwh=10.0, max_charge_kw=5.0, max_discharge_kw=5.0,
                                 roundtrip_efficiency=0.92, wear_cost_ct_per_kwh=4.0),
            initial_soc_kwh=5.0,
            charge_from_grid_allowed=False,
        ),),
        controllable_loads=(load,),
        import_price_eur_mwh=[p * 10.0 for p in imp],
    )
    plan = co_optimize(inp, uuid4(), jetzt)
    return starts, load, plan, build_plan_v2_payload(plan)


def test_das_fenster_ueber_das_sommerzeitende_hat_52_slots():
    """18:00 (Sommerzeit) bis 06:00 (Winterzeit) sind 13 echte Stunden."""
    fall = _fall("guenstig-mit-ziel")
    starts = horizon_slot_starts(_berlin(24, 17), 96)
    load = compile_consumer(profil_der_api(fall), fall["dokument"], starts, 15,
                            [10.0] * 96, [TEUER_CT] * 96)
    # Je Fenster-Instanz eine Anforderung, benannt nach dem Abend, an dem sie beginnt.
    (ziel,) = [r for r in load.requirements if r.requirement_id == "bis_uhrzeit@2026-10-24"]
    assert len(ziel.window_slots) == 52
    assert ziel.required_kwh == 20


@solver
def test_lauf_2200_plant_das_ziel_vor_0600_als_grenze():
    starts, load, plan, payload = _plan(_berlin(24, 22), 48)
    (ladepunkt,) = [d for d in plan.loads if d.entity_id == "lp-1"]
    ende = _berlin(25, 6)
    geplant = sum(s.power_kw for s in ladepunkt.slots if s.start < ende) * 0.25
    assert geplant >= 20.0 - 1e-3
    assert all(s.power_kw == 0 for s in ladepunkt.slots if s.start >= ende)
    assert ladepunkt.unserved == ()
    # Das Wort, das die Box an einer Säule als Grenze trägt - nie on_off.
    (eintrag,) = [e for e in payload["entities"] if e["entity_id"] == "lp-1"]
    assert {k for s in eintrag["slots"] for k in s["commands"]} == {"setpoint_kw"}
    assert max(s["commands"]["setpoint_kw"] for s in eintrag["slots"]) == pytest.approx(11.0)


@solver
def test_lauf_0430_fuellt_die_restlichen_sechs_slots():
    """Um 04:30 bleiben sechs Slots: 16,5 kWh bei 11 kW. Der Optimierer kennt den
    Fortschritt der Sitzung noch nicht (Audit W-20, „später") und verlangt die
    vollen 20 kWh - der Rest steht ehrlich als ``unserved``."""
    starts, load, plan, payload = _plan(_berlin(25, 4, 30), 32)
    (ladepunkt,) = [d for d in plan.loads if d.entity_id == "lp-1"]
    ende = _berlin(25, 6)
    im_fenster = [s for s in ladepunkt.slots if s.start < ende]
    assert len(im_fenster) == 6
    assert all(s.power_kw == pytest.approx(11.0, abs=1e-3) for s in im_fenster)
    assert [(u.shortfall, u.unit) for u in ladepunkt.unserved] == [(3.5, "kwh")]
    (eintrag,) = [e for e in payload["entities"] if e["entity_id"] == "lp-1"]
    assert {k for s in eintrag["slots"] for k in s["commands"]} == {"setpoint_kw"}


class _Verbindung:
    """psycopg-Ersatz: liefert die Zeilen, die ``_CONSUMER_SQL`` liefern würde."""

    def __init__(self, zeilen):
        self._zeilen = zeilen

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params):
        assert "device_charge_point" in sql, "der Ladepunkt hängt an seiner Box-Bindung"
        return types.SimpleNamespace(fetchall=lambda: self._zeilen)


def _zeile(entity_id: str, fall: dict):
    p = fall["profil"]
    return (entity_id, p["control_kind"], p["rated_power_kw"], None, None, None,
            "consumer_first", "allow", False, None, None, None, None,
            json.dumps(fall["dokument"]))


def test_ohne_nennleistung_faellt_die_saeule_mit_grund_aus(monkeypatch, caplog):
    """Kein TypeError aus float(None): die Säule ohne Nennleistung wird mit Grund
    ausgelassen, die mit Nennleistung geplant."""
    zeilen = [_zeile("ohne", _fall("ziel-ohne-nennleistung")),
              _zeile("mit", _fall("guenstig-mit-ziel"))]
    monkeypatch.setitem(sys.modules, "psycopg", types.SimpleNamespace(
        connect=lambda dsn: _Verbindung(zeilen)))
    starts = horizon_slot_starts(_berlin(24, 22), 48)
    with caplog.at_level(logging.WARNING, logger="voltpilot.optimization.consumer_inputs"):
        loads = load_consumer_entities("dsn", uuid4(), starts, 15, [10.0] * 48,
                                       [TEUER_CT] * 48)
    assert [e.entity_id for e in loads] == ["mit"]
    (grund,) = [r for r in caplog.records if r.getMessage() == "consumer.compile_failed"]
    assert grund.context["entity_id"] == "ohne"
    assert "Nennleistung fehlt" in grund.context["error"]
