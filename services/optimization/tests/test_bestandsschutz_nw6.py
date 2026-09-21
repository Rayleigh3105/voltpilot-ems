"""UEMS AP-15 IP-30 (NW-6, Regel I6): das Plan-Dokument einer Anlage ohne scharfe
Gemeinsame Steuerung ist Byte fuer Byte das von VOR AP-15.

Der Fingerabdruck ist festgehalten, nicht nachgerechnet: dasselbe Skript lief auf
dem Stand direkt vor dem ersten AP-15-Commit (``73e2371d6^``) und auf dem Stand
von IP-30 und lieferte beide Male diese Bytes (kanonisches JSON, sortierte
Schluessel). Er ist das Paar zu ``test_plan_je_box.py::test_nw6_…`` (dort: mit
und ohne AP-15-Pfad im selben Code). Aendert ein Solver-Update die Zahlen, wird
der Wert mit Begruendung fortgeschrieben - nie wegen eines AP-15-Pfads.
"""
from __future__ import annotations

import dataclasses
import hashlib
import json
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import UUID

import pytest

pytest.importorskip("highspy")

from voltpilot_optimization import engine  # noqa: E402
from voltpilot_optimization.co_solver import co_optimize  # noqa: E402
from voltpilot_optimization.domain import (  # noqa: E402
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)
from voltpilot_optimization.entities import from_v1_input  # noqa: E402
from voltpilot_optimization.persistence_v2 import InMemorySitePlanRepository  # noqa: E402
from voltpilot_optimization.publisher_v2 import (  # noqa: E402
    RecordingPlanV2Publisher,
    build_plan_v2_payload,
    plan_je_box,
    plan_v2_topic,
)

T0 = datetime(2027, 6, 13, 11, 0, tzinfo=timezone.utc)
SITE = UUID(int=0xA1A1)
E_1 = UUID(int=0xE1)

#: sha256 und Laenge des kanonischen Plan-Dokuments vor AP-15 (``73e2371d6^``).
VOR_AP15 = ("58c10364ef9e29bc1a472b80c8cf89c02af1f14b34c8025ed7282d0732aff194", 991)


def _plan():
    inp = OptimizationInput(
        tenant_id=UUID(int=0xA001), site_id=SITE, device_id=E_1,
        battery=BatteryParams(capacity_kwh=200.0, max_charge_kw=100.0, max_discharge_kw=100.0),
        slot_starts=horizon_slot_starts(T0, 4), prices_eur_mwh=[100.0, -20.0, 80.0, 120.0],
        load_kw=[40.0] * 4, pv_kw=[150.0, 152.0, 160.0, 165.0], initial_soc_kwh=120.0,
        netzladen_erlaubt=False, max_feed_in_kw=100.0,
    )
    return dataclasses.replace(co_optimize(from_v1_input(inp), UUID(int=0x4711), T0), peak_target_kw=80.0)


def _fingerabdruck(payload: dict) -> tuple[str, int]:
    b = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(b).hexdigest(), len(b)


def test_nw6_plan_dokument_byte_gleich_zum_stand_vor_ap15():
    assert _fingerabdruck(build_plan_v2_payload(_plan())) == VOR_AP15


def test_nw6_plan_je_box_ohne_stand_liefert_die_bytes_von_vor_ap15():
    """Ein-Box-Anlage und Zwei-Box-Anlage ohne eingerichtete Gemeinsame Steuerung:
    ``load_verbund`` liefert keinen Stand - der AP-15-Pfad gibt die alten Bytes."""
    plan = _plan()
    (dok,) = plan_je_box(plan, None, lauf_nr=7)
    assert dok.topic == plan_v2_topic(plan)
    assert _fingerabdruck(dok.payload) == VOR_AP15


def test_nw6_ganzer_zyklus_veroeffentlicht_die_bytes_von_vor_ap15(monkeypatch):
    plan = _plan()
    monkeypatch.setattr(engine, "from_v1_input", lambda inp: SimpleNamespace())
    monkeypatch.setattr(engine, "co_optimize", lambda co, plan_id, now: plan)
    monkeypatch.delenv("VOLTPILOT_CONTROLLABLE_LOADS", raising=False)
    publisher, repo = RecordingPlanV2Publisher(), InMemorySitePlanRepository()
    site = SimpleNamespace(site_id=SITE, device_id=E_1, verbund=None)
    engine._shadow_publish_v2(
        "dsn", site, SimpleNamespace(soc_unbekannt=False), T0, publisher, frozenset({SITE}), repo
    )
    ((topic, payload),) = publisher.published
    assert topic == plan_v2_topic(plan)
    assert _fingerabdruck(payload) == VOR_AP15
