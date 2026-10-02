"""MiSpeL MP-22: Pilot-Durchstich im Simulator (E6 = D).

Die Fixture ``fixtures/mispel-durchstich-2026-10.json`` und die Box-Nutzlasten
``edge-app/core/internal/plan/testdata/mispel-durchstich-2026-10.jsonl``
schreibt ``voltpilot_optimization.simulation.mispel_durchstich`` (Optimierer im
Mischbetrieb, Plan zur Box, Zählerwerte, Rechenwerk). Hier: die gespeicherten
Mengen sind genau das Rechenwerk (1)–(33) auf den gespeicherten Viertelstunden
(A1 S. 32–40), jeder Plan trägt den Förderweg und erfüllt den Vertrag, und
die Box-Datei gehört zu genau diesen Plänen. Die Cloud-Seite prüft
``MispelDurchstichSimulatorTest`` (Monatslauf, Nachweis, Kundenansicht), die
Box ``mispel_durchstich_test.go``.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from fractions import Fraction

from voltpilot_optimization import mispel_abgrenzung
from voltpilot_optimization.simulation import mispel_durchstich as md

from test_contract import load_validator


def _fixture() -> dict:
    return json.loads(md.FIXTURE.read_text(encoding="utf-8"))


def _box() -> list[dict]:
    return [json.loads(z) for z in md.BOX_FIXTURE.read_text(encoding="utf-8").splitlines()]


def test_die_mengen_der_fixture_sind_das_rechenwerk_auf_ihren_viertelstunden():
    doc = _fixture()
    q = doc["viertelstunden"]
    beginn = datetime.fromisoformat(q["beginn"].replace("Z", "+00:00"))
    qhs = [
        {
            "beginn": beginn + timedelta(minutes=15 * i),
            "Z1NB¼": Fraction(q["Z1NB"][i]),
            "Z1NE¼": Fraction(q["Z1NE"][i]),
            "Z2V¼": Fraction(q["Z2V"][i]),
            "Z2E¼": Fraction(q["Z2E"][i]),
            "AW¼": Fraction(q["AWgroesserNull"][i]),
        }
        for i in range(q["anzahl"])
    ]
    # Oktober 2026 nach gesetzlicher Zeit: 31 × 96 + 4 (Winterzeit am 25.10.).
    assert q["anzahl"] == 2980
    ergebnis = mispel_abgrenzung.rechne(doc["anlage"]["formelsatz"], qhs)
    assert list(ergebnis.monate) == [doc["monat"]]
    assert {k: Fraction(v) for k, v in doc["rechenwerk"].items()} == ergebnis.monate[doc["monat"]]
    # Der Durchstich prüft jede Farbe: grün (26), gelb (31), rot (16) sind belegt.
    for nr in ("(26)", "(31)", "(16)", "(20)", "(32)"):
        assert Fraction(doc["rechenwerk"][nr]) > 0, nr


def test_jeder_plan_traegt_den_foerderweg_und_die_box_datei_gehoert_dazu():
    doc = _fixture()
    box = _box()
    assert len(doc["plaene"]) == len(box) == 31
    validator = load_validator()
    for plan, zeile in zip(doc["plaene"], box):
        nutzlast = zeile["nutzlast"]
        assert plan["foerderweg"] == nutzlast["foerderweg"] == md.FOERDERWEG
        assert plan["grid_charge_allowed"] is nutzlast["grid_charge_allowed"] is True
        assert plan["plan_id"] == nutzlast["plan_id"]
        assert nutzlast["site_id"] == doc["anlage"]["anlageId"]
        assert list(validator.iter_errors(nutzlast)) == []
        assert len(zeile["pv_kw"]) == len(zeile["last_kw"]) == len(nutzlast["slots"])
    # Der Tag der Zeitumstellung hat 100 Viertelstunden, die Nutzlast höchstens 96.
    umstellung = next(p for p in doc["plaene"] if p["tag"] == "2026-10-25")
    assert (umstellung["viertelstunden"], umstellung["nutzlast_viertelstunden"]) == (100, 96)


def test_text_ist_exakt_und_lesbar_fuer_java():
    assert md._text(Fraction(2333900, 1000)) == "2333.9"
    assert md._text(Fraction(-5, 4)) == "-1.25"
    assert md._text(Fraction(1, 3)) == "1/3"
    assert md._text(Fraction(0)) == "0"
    assert md._text(Fraction(7, 1000)) == "0.007"
