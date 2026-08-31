"""K2 - die STILLE-REGEL (Verbrauchsmanagement v1 / P5).

Ein Verbraucher, dessen Policy AUCH eine lokale Quelle traegt, bekommt nur die
Slots, die der Plan wirklich schaltet. Wo der Plan SCHWEIGT, regiert die Quelle
(die reaktive Regel am Edge) - statt dass ein volles Raster mit ausdruecklichen
Aus-Slots sie jede Viertelstunde ueberstimmt.

Zwei Schichten, wie bei den drei In-Slot-Pflichten:

- die ABLEITUNG (:func:`consumer_inputs.compile_consumer` setzt das Flag genau
  dann, wenn eine aktive Anforderung nur am Edge auswertbar ist), und
- der PUBLISHER (:mod:`voltpilot_optimization.publisher_v2`), der daraufhin die
  Aus-Slots weglaesst - und, wenn NICHTS zu sagen bleibt, die ganze Entitaet.

Der Kompatibilitaets-Beweis ist der wichtigste Fall: ohne lokale Quelle ist die
Nutzlast byte-identisch zum Stand vor P5.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import pytest

from voltpilot_optimization import consumer_inputs
from voltpilot_optimization.consumer_inputs import ConsumerProfileRow
from voltpilot_optimization.entities import (
    LoadDispatch,
    LoadSlot,
    SitePlan,
    SiteSlot,
)
from voltpilot_optimization.publisher_v2 import build_plan_v2_payload

T0 = datetime(2026, 8, 31, 6, 0, tzinfo=timezone.utc)


def _slots(pattern: str, power: float = 2.0) -> list[LoadSlot]:
    """``pattern`` is one character per slot: ``x`` = on, ``.`` = off."""
    return [
        LoadSlot(
            start=T0 + timedelta(minutes=15 * i),
            on=c == "x",
            power_kw=power if c == "x" else 0.0,
            reason_code="fixed_window" if c == "x" else None,
        )
        for i, c in enumerate(pattern)
    ]


def _plan(*loads: LoadDispatch) -> SitePlan:
    n = max(len(load.slots) for load in loads)
    return SitePlan(
        plan_id=uuid4(),
        tenant_id=uuid4(),
        site_id=uuid4(),
        device_id=uuid4(),
        generated_at=T0,
        slot_minutes=15,
        site_slots=[
            SiteSlot(
                start=T0 + timedelta(minutes=15 * i),
                grid_kw=0.0,
                base_load_kw=0.0,
                price_eur_mwh=100.0,
                cost_eur=0.0,
                baseline_cost_eur=0.0,
            )
            for i in range(n)
        ],
        loads=list(loads),
    )


def _entity(payload: dict, entity_id: str) -> dict | None:
    for ent in payload["entities"]:
        if ent["entity_id"] == entity_id:
            return ent
    return None


# ---------------------------------------------------------------------------
# Der Publisher
# ---------------------------------------------------------------------------


def test_a_consumer_without_a_local_source_keeps_the_full_grid():
    """Der Kompatibilitaets-Beweis: ohne lokale Quelle ist NICHTS anders.

    Dort IST ein Aus-Slot die Aussage ("dieses Geraet laeuft jetzt nicht"), und
    ein Weglassen hiesse "entscheide selbst", was er nicht kann.
    """
    load = LoadDispatch(entity_id="rod", control_kind="on_off", slots=_slots("..xx.."))
    payload = build_plan_v2_payload(_plan(load))
    ent = _entity(payload, "rod")
    assert ent is not None
    assert [s["commands"]["on_off"] for s in ent["slots"]] == [
        False,
        False,
        True,
        True,
        False,
        False,
    ]


def test_a_local_source_consumer_carries_only_the_dispatched_slots():
    load = LoadDispatch(
        entity_id="rod",
        control_kind="on_off",
        slots=_slots("..xx.."),
        has_local_source=True,
    )
    ent = _entity(build_plan_v2_payload(_plan(load)), "rod")
    assert ent is not None
    assert [s["commands"]["on_off"] for s in ent["slots"]] == [True, True]
    # ... und zwar GENAU die zwei geschalteten Viertelstunden.
    assert [s["start"] for s in ent["slots"]] == [
        (T0 + timedelta(minutes=30)).isoformat().replace("+00:00", "Z"),
        (T0 + timedelta(minutes=45)).isoformat().replace("+00:00", "Z"),
    ]


def test_the_silent_slots_are_the_only_difference():
    """Die geschalteten Slots sind Zeichen fuer Zeichen dieselben."""
    on_off = _slots("..xx..")
    quiet = build_plan_v2_payload(
        _plan(
            LoadDispatch(
                entity_id="rod",
                control_kind="on_off",
                slots=on_off,
                has_local_source=True,
            )
        )
    )
    loud = build_plan_v2_payload(
        _plan(LoadDispatch(entity_id="rod", control_kind="on_off", slots=on_off))
    )
    dispatched = [s for s in _entity(loud, "rod")["slots"] if s["commands"]["on_off"]]
    assert _entity(quiet, "rod")["slots"] == dispatched


def test_a_continuous_consumer_is_silent_on_its_zero_slots_too():
    load = LoadDispatch(
        entity_id="pump",
        control_kind="continuous",
        slots=_slots(".x.x.", power=3.5),
        has_local_source=True,
    )
    ent = _entity(build_plan_v2_payload(_plan(load)), "pump")
    assert [s["commands"]["setpoint_kw"] for s in ent["slots"]] == [3.5, 3.5]


def test_a_fully_silent_consumer_is_omitted_instead_of_publishing_no_slots():
    """``slots`` traegt ``minItems: 1`` - eine leere Liste waere ein kaputter
    Plan, kein "die Quelle regiert". Also faellt die ganze Entitaet weg."""
    quiet = LoadDispatch(
        entity_id="rod",
        control_kind="on_off",
        slots=_slots("......"),
        has_local_source=True,
    )
    other = LoadDispatch(entity_id="pump", control_kind="on_off", slots=_slots("xx...."))
    payload = build_plan_v2_payload(_plan(quiet, other))
    assert _entity(payload, "rod") is None
    assert _entity(payload, "pump") is not None


def test_a_plan_with_nothing_left_to_say_refuses_rather_than_publishing_empty():
    quiet = LoadDispatch(
        entity_id="rod",
        control_kind="on_off",
        slots=_slots("...."),
        has_local_source=True,
    )
    with pytest.raises(ValueError, match="without any commanded entity"):
        build_plan_v2_payload(_plan(quiet))


def test_the_published_payload_still_validates_against_the_contract():
    jsonschema = pytest.importorskip("jsonschema")
    schema_path = (
        Path(__file__).resolve().parents[3]
        / "docs"
        / "contracts"
        / "v2"
        / "mqtt-schedule-2.0.schema.json"
    )
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    payload = build_plan_v2_payload(
        _plan(
            LoadDispatch(
                entity_id="rod",
                control_kind="on_off",
                slots=_slots("..xx.."),
                has_local_source=True,
            )
        )
    )
    jsonschema.validate(payload, schema)


# ---------------------------------------------------------------------------
# Die Ableitung
# ---------------------------------------------------------------------------


def _profile() -> ConsumerProfileRow:
    return ConsumerProfileRow(
        entity_id="rod", control_kind="on_off", rated_power_kw=2.0
    )


def _slot_starts(n: int = 8) -> list[datetime]:
    return [T0 + timedelta(minutes=15 * i) for i in range(n)]


def _compile(document: dict):
    starts = _slot_starts()
    return consumer_inputs.compile_consumer(
        _profile(),
        document,
        slot_starts=starts,
        slot_minutes=15,
        spot_ct_kwh=[10.0] * len(starts),
        import_ct_kwh=[30.0] * len(starts),
    )


def _fixed_window_requirement() -> dict:
    return {
        "id": "morgens",
        "kind": "fixed_window",
        "enforcement": "must_run",
        "target": {"kind": "on_off", "value": True},
        "recurrence": {"days": "daily", "from": "08:00", "to": "09:00"},
    }


def test_a_local_signal_requirement_marks_the_consumer():
    doc = {
        "schema_version": "1.0",
        "entity_id": "rod",
        "timezone": "Europe/Berlin",
        "requirements": [
            _fixed_window_requirement(),
            {
                "id": "sonne",
                "kind": "reactive",
                "enforcement": "opportunistic",
                "target": {"kind": "on_off", "value": True},
                "condition": {
                    "signal": "site.pv_surplus_kw",
                    "operator": "gt",
                    "value": 2.0,
                    "reset_value": 1.5,
                    "max_age_s": 120,
                },
            },
        ],
    }
    entity = _compile(doc)
    assert entity is not None
    assert entity.has_local_source is True


def test_a_windows_only_policy_is_never_marked():
    """Eine Preisregel kompiliert die WOLKE zu Fenstern - der Edge wertet dort
    nichts aus, und ein Aus-Slot ist die ehrliche Aussage."""
    doc = {
        "schema_version": "1.0",
        "entity_id": "rod",
        "timezone": "Europe/Berlin",
        "requirements": [_fixed_window_requirement()],
    }
    entity = _compile(doc)
    assert entity is not None
    assert entity.has_local_source is False


def test_an_inactive_local_rule_does_not_silence_the_plan():
    doc = {
        "schema_version": "1.0",
        "entity_id": "rod",
        "timezone": "Europe/Berlin",
        "requirements": [
            _fixed_window_requirement(),
            {
                "id": "sonne",
                "kind": "reactive",
                "enforcement": "opportunistic",
                "active": False,
                "target": {"kind": "on_off", "value": True},
                "condition": {
                    "signal": "site.pv_surplus_kw",
                    "operator": "gt",
                    "value": 2.0,
                    "reset_value": 1.5,
                    "max_age_s": 120,
                },
            },
        ],
    }
    assert _compile(doc).has_local_source is False
