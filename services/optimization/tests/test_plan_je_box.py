"""UEMS AP-15 IP-15: Plan je Box veröffentlichen (Regeln P1, P2, Auflösung W8).

Ein Lauf je Anlage; je steuernder Box höchstens ein Dokument, alle mit derselben
``plan_id``, demselben ``generated_at`` und einer Laufnummer; jede Entität im
Dokument der Box ihrer Komponente; ``grid_import_limit_kw`` nur bei der
führenden Box. Ohne scharfe Gemeinsame Steuerung: das EINE Dokument von heute,
Byte für Byte (NW-6, R22). Zahlen aus R1 (Referenzdatei 1.5, AN-1).
"""

from __future__ import annotations

import dataclasses
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest

pytest.importorskip("highspy")
from jsonschema import Draft202012Validator, FormatChecker  # noqa: E402

from voltpilot_optimization import engine  # noqa: E402
from voltpilot_optimization.co_solver import co_optimize  # noqa: E402
from voltpilot_optimization.domain import (  # noqa: E402
    BatteryParams,
    OptimizationInput,
    horizon_slot_starts,
)
from voltpilot_optimization.entities import (  # noqa: E402
    V1_STORAGE_ENTITY_ID,
    ControllableLoadEntity,
    LoadRequirement,
    from_v1_input,
)
from voltpilot_optimization.persistence_v2 import InMemorySitePlanRepository  # noqa: E402
from voltpilot_optimization.publisher_v2 import (  # noqa: E402
    RecordingPlanV2Publisher,
    build_plan_v2_payload,
    plan_je_box,
    plan_v2_topic,
)
from voltpilot_optimization.verbund import (  # noqa: E402
    BoxAnteil,
    MitsteuerndeBox,
    VerbundStand,
    erzeuger_id,
    load_verbund,
)

T0 = datetime(2027, 6, 13, 11, 0, tzinfo=timezone.utc)  # Sonntag 13:00 (R1)
TENANT = UUID("00000000-0000-0000-0000-00000000a001")
SITE = UUID("00000000-0000-0000-0000-00000000a1a1")  # AN-1
E_1 = UUID("00000000-0000-0000-0000-0000000000e1")  # Box Halle 1, fuehrt, Speicher
E_4 = UUID("00000000-0000-0000-0000-0000000000e4")  # Box Verwaltung, steuert mit
LP = "ahr-lp-02"  # ein Verbraucher an Box Verwaltung (steuerungsverbund_geraet)

SCHEMA = json.loads(
    (Path(__file__).resolve().parents[3] / "docs/contracts/v2/mqtt-schedule-2.0.schema.json")
    .read_text()
)
VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())

R1_E4 = [55.0, 57.0, 65.0, 70.0]  # ueber 60 kW regelt die Verwaltung ab
R1_E1 = [95.0] * 4


def _plan(verbund: tuple = (), loads: tuple = (), peak: float | None = None):
    """EIN echter Lauf des Co-Optimierers fuer AN-1 (R1)."""
    n = len(R1_E1)
    inp = OptimizationInput(
        tenant_id=TENANT,
        site_id=SITE,
        device_id=E_1,
        battery=BatteryParams(capacity_kwh=200.0, max_charge_kw=100.0, max_discharge_kw=100.0),
        slot_starts=horizon_slot_starts(T0, n),
        prices_eur_mwh=[100.0] * n,
        load_kw=[40.0] * n,
        pv_kw=[a + b for a, b in zip(R1_E1, R1_E4)],
        initial_soc_kwh=200.0,
        netzladen_erlaubt=False,
        max_feed_in_kw=100.0,
        verbund=verbund,
    )
    co = dataclasses.replace(from_v1_input(inp), controllable_loads=loads)
    plan = co_optimize(co, uuid4(), T0)
    return dataclasses.replace(plan, peak_target_kw=peak)


def _ladepunkt() -> ControllableLoadEntity:
    return ControllableLoadEntity(
        entity_id=LP,
        max_power_kw=11.0,
        control_kind="continuous",
        requirements=(
            LoadRequirement(
                requirement_id="laden-02",
                kind="fixed_window",
                window_slots=(0, 1, 2, 3),
                target_kw=11.0,
            ),
        ),
    )


R1_VERBUND = (BoxAnteil(E_4, 60.0, 77.0, pv_kw=tuple(R1_E4), verbraucher=(LP,)),)


def _stand(**box) -> VerbundStand:
    werte = dict(device_id=E_4, einspeisung_kw=60.0, bezug_kw=77.0, stumm=False,
                 pv_kwp=60.0, verbraucher=(LP,))
    werte.update(box)
    return VerbundStand(mitsteuernde=(MitsteuerndeBox(**werte),), pv_kwp_gesamt=160.0,
                        fuehrende=E_1)


def _ids(payload: dict) -> list[str]:
    return [e["entity_id"] for e in payload["entities"]]


# ---------------------------------------------------------------------------
# R1: zwei Boxen -> zwei Dokumente, eine plan_id, jede Entitaet genau einmal
# ---------------------------------------------------------------------------


def test_r1_zwei_boxen_zwei_dokumente_eine_plan_id():
    plan = _plan(R1_VERBUND, loads=(_ladepunkt(),), peak=80.0)
    dokumente = plan_je_box(plan, _stand(), lauf_nr=4711)

    assert [d.device_id for d in dokumente] == [E_1, E_4]
    assert [d.topic for d in dokumente] == [
        f"ems/{TENANT}/{SITE}/{E_1}/v2/plan",
        f"ems/{TENANT}/{SITE}/{E_4}/v2/plan",
    ]
    fuehrend, mit = (d.payload for d in dokumente)
    for payload, box in ((fuehrend, E_1), (mit, E_4)):
        VALIDATOR.validate(payload)
        assert payload["device_id"] == str(box)  # Topic- und Payload-Identitaet
        assert payload["plan_id"] == str(plan.plan_id)
        assert payload["generated_at"] == fuehrend["generated_at"]
        assert payload["lauf_nr"] == 4711
    assert fuehrend["gemeinsame_steuerung"] == {"rolle": "fuehrt"}
    assert mit["gemeinsame_steuerung"] == {"rolle": "steuert_mit"}
    # die PV der Verwaltung (abgeregelt ueber 60 kW) und ihr Ladepunkt bei ihr
    assert set(_ids(mit)) == {erzeuger_id(E_4), LP}
    assert V1_STORAGE_ENTITY_ID in _ids(fuehrend)
    # jede Entitaet genau einmal ueber alle Dokumente
    alle = _ids(fuehrend) + _ids(mit)
    assert len(alle) == len(set(alle))
    geplant = {s.entity_id for s in plan.storages} | {l.entity_id for l in plan.loads} | {
        p.entity_id for p in plan.producers if p.curtails
    }
    assert set(alle) == geplant
    # das Lastspitzen-ZIEL nur bei der fuehrenden Box; keine Anteile im Plan (Y1)
    assert fuehrend["grid_import_limit_kw"] == 80.0
    assert "grid_import_limit_kw" not in mit
    assert "anteile" not in json.dumps(mit) and "anteil" not in mit["gemeinsame_steuerung"]


def test_r1_pv_verwaltung_steht_im_dokument_der_verwaltung_mit_ihrem_deckel():
    plan = _plan(R1_VERBUND)
    mit = plan_je_box(plan, _stand(), lauf_nr=1)[1].payload
    pv = next(e for e in mit["entities"] if e["entity_id"] == erzeuger_id(E_4))
    deckel = [s["commands"].get("limit_kw") for s in pv["slots"]]
    assert all(d is None or d <= 60.0 + 1e-6 for d in deckel)
    assert any(d is not None for d in deckel)  # 65 und 70 kW werden abgeregelt


# ---------------------------------------------------------------------------
# Wer keinen Plan bekommt
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "grund",
    ["stumm (R7)", "nach dem Box-Tausch unbestaetigt (R17)", "ohne Faehigkeit (A12/R14)"],
)
def test_belegte_box_bekommt_kein_dokument_und_ihre_entitaeten_stehen_nirgends(grund):
    # load_verbund fasst alle drei in ``stumm`` (siehe den Leser-Test unten).
    plan = _plan(R1_VERBUND, loads=(_ladepunkt(),))
    dokumente = plan_je_box(plan, _stand(stumm=True), lauf_nr=7)
    assert [d.device_id for d in dokumente] == [E_1], grund
    ids = _ids(dokumente[0].payload)
    assert erzeuger_id(E_4) not in ids and LP not in ids


def test_box_ohne_entitaet_im_lauf_bekommt_kein_dokument_sondern_die_ruecknahme():
    # PV der Verwaltung unter ihrem Anteil, kein Verbraucher: nichts zu sagen.
    plan = _plan((BoxAnteil(E_4, 60.0, 77.0, pv_kw=(55.0,) * 4),))
    fuehrend, mit = plan_je_box(plan, _stand(verbraucher=()), lauf_nr=3)
    assert fuehrend.payload is not None
    assert mit.device_id == E_4 and mit.payload is None
    assert mit.topic == f"ems/{TENANT}/{SITE}/{E_4}/v2/plan"


def test_ohne_scharfe_steuerung_ein_dokument_wie_bisher():
    """Ohne Stand (kein Verbund, angehalten, jede Stufe vor anteile_aktiv) oder
    ohne fuehrende Box: EIN Dokument an die Speicher-Box, gebaut wie immer."""
    plan = _plan(peak=80.0)
    for stand in (None, dataclasses.replace(_stand(), fuehrende=None)):
        (dok,) = plan_je_box(plan, stand, lauf_nr=12)
        assert dok.device_id == E_1 and dok.topic == plan_v2_topic(plan)
        assert json.dumps(dok.payload) == json.dumps(build_plan_v2_payload(plan))
        assert "lauf_nr" not in dok.payload and "gemeinsame_steuerung" not in dok.payload


# ---------------------------------------------------------------------------
# Der Zyklus: ein Lauf, je Box veroeffentlicht und vermerkt, Laufnummer (P1)
# ---------------------------------------------------------------------------


def _zyklus(monkeypatch, plan, *, verbund=None, flagged=frozenset({SITE})):
    monkeypatch.setattr(engine, "from_v1_input", lambda inp: SimpleNamespace())
    monkeypatch.setattr(engine, "co_optimize", lambda co, plan_id, now: plan)
    monkeypatch.delenv("VOLTPILOT_CONTROLLABLE_LOADS", raising=False)
    site = SimpleNamespace(site_id=SITE, device_id=E_1, verbund=verbund)
    publisher, repo = RecordingPlanV2Publisher(), InMemorySitePlanRepository()
    engine._shadow_publish_v2(
        "dsn", site, SimpleNamespace(soc_unbekannt=False), T0, publisher, flagged, repo
    )
    return publisher, repo


def test_zyklus_r1_zwei_dokumente_zweimal_veroeffentlicht(monkeypatch):
    plan = _plan(R1_VERBUND, loads=(_ladepunkt(),))
    publisher, repo = _zyklus(monkeypatch, plan, verbund=_stand())
    assert [t for t, _ in publisher.published] == [
        f"ems/{TENANT}/{SITE}/{E_1}/v2/plan",
        f"ems/{TENANT}/{SITE}/{E_4}/v2/plan",
    ]
    assert {p["plan_id"] for _, p in publisher.published} == {str(plan.plan_id)}
    assert [p["lauf_nr"] for _, p in publisher.published] == [1, 1]
    assert [(box, pid) for box, pid, _, _ in repo.publications] == [
        (E_1, plan.plan_id),
        (E_4, plan.plan_id),
    ]


def test_zyklus_scharfe_anlage_braucht_den_v2_schalter_nicht(monkeypatch):
    plan = _plan(R1_VERBUND)
    publisher, _ = _zyklus(monkeypatch, plan, verbund=_stand(), flagged=frozenset())
    assert len(publisher.published) == 2


def test_zyklus_unbestaetigtes_mitglied_nur_die_fuehrende_einmal_vermerkt(monkeypatch):
    plan = _plan(R1_VERBUND)
    publisher, repo = _zyklus(monkeypatch, plan, verbund=_stand(stumm=True))
    assert [t for t, _ in publisher.published] == [f"ems/{TENANT}/{SITE}/{E_1}/v2/plan"]
    assert [box for box, *_ in repo.publications] == [E_1]
    assert publisher.cleared == []  # eine belegte Box bekommt auch keine Ruecknahme


def test_zyklus_ruecknahme_wird_nicht_als_veroeffentlicht_vermerkt(monkeypatch):
    plan = _plan((BoxAnteil(E_4, 60.0, 77.0, pv_kw=(55.0,) * 4),))
    publisher, repo = _zyklus(monkeypatch, plan, verbund=_stand(verbraucher=()))
    assert publisher.cleared == [f"ems/{TENANT}/{SITE}/{E_4}/v2/plan"]
    assert [box for box, *_ in repo.publications] == [E_1]


def test_nw6_ohne_scharfe_steuerung_byte_gleich_und_einmal_vermerkt(monkeypatch):
    """Ein-Box-Anlage und Zwei-Box-Anlage ohne scharfe Gemeinsame Steuerung
    (angehalten eingeschlossen: ``load_verbund`` liefert dann nichts): Topic und
    Nutzlast sind die von ``build_plan_v2_payload`` - kein ``lauf_nr``, kein
    Block, obwohl die Laufnummer am Lauf vergeben ist (P1)."""
    plan = _plan(peak=80.0)
    publisher, repo = _zyklus(monkeypatch, plan)
    ((topic, payload),) = publisher.published
    assert topic == plan_v2_topic(plan)
    assert json.dumps(payload) == json.dumps(build_plan_v2_payload(plan))
    assert [box for box, *_ in repo.publications] == [E_1]
    assert repo.run_numbers == {SITE: 1}


def test_p1_laufnummer_je_anlage_aufsteigend():
    repo = InMemorySitePlanRepository()
    andere = dataclasses.replace(_plan(), site_id=uuid4())
    plan = _plan()
    assert [repo.assign_run_number(plan), repo.assign_run_number(plan)] == [1, 2]
    assert repo.assign_run_number(andere) == 1


def test_laufnummer_fehlt_wenn_die_api_noch_nicht_migriert_ist(monkeypatch):
    plan = _plan(R1_VERBUND)

    class _AlteDb(InMemorySitePlanRepository):
        def assign_run_number(self, plan):
            raise RuntimeError('column "lauf_nr" does not exist')

    monkeypatch.setattr(engine, "from_v1_input", lambda inp: SimpleNamespace())
    monkeypatch.setattr(engine, "co_optimize", lambda co, plan_id, now: plan)
    publisher, repo = RecordingPlanV2Publisher(), _AlteDb()
    site = SimpleNamespace(site_id=SITE, device_id=E_1, verbund=_stand())
    engine._shadow_publish_v2(
        "dsn", site, SimpleNamespace(soc_unbekannt=False), T0, publisher, frozenset(), repo
    )
    assert len(publisher.published) == 2
    assert all("lauf_nr" not in p for _, p in publisher.published)
    assert len(repo.publications) == 2


# ---------------------------------------------------------------------------
# Der Leser: fuehrende Box, Faehigkeit
# ---------------------------------------------------------------------------


def test_load_verbund_box_ohne_faehigkeit_wird_als_belegt_gerechnet(monkeypatch):
    rows = {
        "FROM steuerungsverbund v": [(SITE, E_4, None, None, T0, T0, False)],
        "FROM asset": [],
        "FROM steuerungsverbund_geraet g": [],
        "FROM steuerungsverbund_mitglied f": [(SITE, E_1)],
    }
    abfragen: list[str] = []

    class _Cur:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, sql, params=()):
            flat = " ".join(sql.split())
            abfragen.append(flat)
            self._rows = next(r for marke, r in rows.items() if marke in flat)

        def fetchall(self):
            return self._rows

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def cursor(self):
            return _Cur()

    monkeypatch.setitem(
        sys.modules,
        "psycopg",
        SimpleNamespace(
            connect=lambda dsn: _Conn(),
            errors=SimpleNamespace(UndefinedTable=type("UndefinedTable", (Exception,), {})),
        ),
    )
    stand = load_verbund("dsn", T0)[SITE]
    assert stand.fuehrende == E_1
    assert stand.mitsteuernde[0].stumm and not stand.mitsteuernde[0].bekommt_plan
    assert "'steuerungsverbund_anteil'" in abfragen[0]
    assert "f.rolle = 'fuehrt'" in abfragen[-1]
