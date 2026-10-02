"""MiSpeL MP-33c: der MiSpeL-Check ist wiederholbar - die Abbruchregel ohne Wanduhr.

Im Mischbetrieb endet ein Loesungslauf live nach ``MISCHBETRIEB_ZEITGRENZE_S``
(Wanduhr) und plant dann ohne Gutschrift; unter Last trifft das andere Laeufe,
zwei Checks derselben Eingabe wichen um Euro ab (Befund MP-13b). Mit
``OptimizationInput.wiederholbar`` endet die Suche stattdessen an der
Knotengrenze ``CHECK_KNOTENGRENZE`` (HiGHS ``mip_max_nodes``, deterministisch);
ein Rueckfall steht im ``hinweis`` des Checks. Die Live-Planung behaelt die Wanduhr.
"""

from __future__ import annotations

import logging
from dataclasses import replace
from uuid import UUID

import pytest
from pyomo.environ import value

from voltpilot_optimization import solver
from voltpilot_optimization.simulation import mispel_check as mc
from voltpilot_optimization.solver import build_model, optimize_mit_rueckfall

from test_mispel_check import _deps, mai_fenster  # noqa: F401 - Fixture
from test_mispel_fahrzeugspeicher import _abend_preise, _real
from test_mispel_jahreszustand import P4, _pauschal
from test_mispel_jahreszustand import _stand as _jahresstand
from test_mispel_monatszustand import _mit_stand, _stand, _tag
from test_solver import T0, make_input, needs_highs

MITTEL = {"mittel": mc.STANDARD_FAELLE["mittel"]}


def _mp10():
    """Mischbetrieb ohne Monatsstand und ohne Fahrzeug: die Lauf-Ganzzahl (MP-10)."""
    return replace(make_input(_abend_preise(n=8), pv=[0.0] * 8), mischbetrieb=True,
                   mispel_praemie_eur_mwh=[30.0] * 8, saldierte_bestandteile_eur_mwh=150.0)


def _spion(monkeypatch) -> list[tuple]:
    gesehen = []
    echt = solver._highs

    def spion(model, time_limit=None, optionen=None, knoten=None):
        gesehen.append((time_limit, knoten))
        return echt(model, time_limit, optionen, knoten)

    monkeypatch.setattr(solver, "_highs", spion)
    return gesehen


def test_live_wanduhr_check_knotengrenze():
    assert solver._grenzen(_tag(), 20.0) == {"time_limit": 20.0}
    assert solver._grenzen(replace(_tag(), wiederholbar=True), 20.0) == {
        "time_limit": solver.CHECK_NOTBREMSE_S, "knoten": solver.CHECK_KNOTENGRENZE,
    }
    # Die Notbremse ist kein Ersatz der Wanduhr: weit ueber der gemessenen Wurzelzeit.
    assert solver.CHECK_NOTBREMSE_S > 10 * solver.MISCHBETRIEB_ZEITGRENZE_S


@needs_highs
@pytest.mark.parametrize("fall", ["mp10", "monatszustand", "jahreszustand"])
def test_live_planung_unveraendert_mit_wanduhr(monkeypatch, fall):
    gesehen = _spion(monkeypatch)
    inp = {"mp10": _mp10, "monatszustand": lambda: _mit_stand(_tag(), _stand(3.0)),
           "jahreszustand": lambda: _pauschal(_jahresstand(p14=5000.0, p7=P4 - 3.0, p9=1500.0),
                                              praemie=0.0)}[fall]()
    assert not inp.wiederholbar
    assert solver._solve_plan(build_model(inp), inp) is None
    assert gesehen == [(solver.MISCHBETRIEB_ZEITGRENZE_S, None)]


@needs_highs
def test_check_haengt_nicht_an_der_wanduhr(monkeypatch):
    # Eine Wanduhr, die JEDEN Lauf trifft: live faellt der Lauf zurueck, der
    # Check rechnet bis zum Optimum - und bekommt die Gutschrift.
    monkeypatch.setattr(solver, "MISCHBETRIEB_ZEITGRENZE_S", 1e-4)
    live = _mit_stand(_tag(), _stand(3.0))
    m_live = build_model(live)
    assert solver._solve_plan(m_live, live) == "zeitgrenze"
    assert value(m_live.mispel_gutschrift) == 0.0
    check = replace(live, wiederholbar=True)
    m_check = build_model(check)
    assert solver._solve_plan(m_check, check) is None
    assert value(m_check.mispel_gutschrift) > 0.0


@needs_highs
@pytest.mark.parametrize("fall", ["mp10", "monatszustand", "jahreszustand", "fahrzeug"])
def test_knotengrenze_faellt_in_jedem_lauf_gleich_zurueck(monkeypatch, caplog, fall):
    monkeypatch.setattr(solver, "CHECK_KNOTENGRENZE", 0)
    inp = {"mp10": _mp10, "monatszustand": lambda: _mit_stand(_tag(), _stand(3.0)),
           "jahreszustand": lambda: _pauschal(_jahresstand(p14=5000.0, p7=P4 - 3.0, p9=1500.0),
                                              praemie=0.0),
           "fahrzeug": lambda: _real(32, "A3")}[fall]()
    inp = replace(inp, wiederholbar=True)
    with caplog.at_level(logging.WARNING):
        a, grenze_a = optimize_mit_rueckfall(inp, UUID(int=1), T0)
        b, grenze_b = optimize_mit_rueckfall(inp, UUID(int=1), T0)
    assert grenze_a == grenze_b == "knotengrenze"
    assert any((r.__dict__.get("context") or {}).get("grenze") == "knotengrenze"
               for r in caplog.records)
    assert [(s.battery_kw, s.grid_kw, s.soc_kwh) for s in a.slots] == [
        (s.battery_kw, s.grid_kw, s.soc_kwh) for s in b.slots]


def test_hinweis_nennt_den_rueckfall():
    leer = {"mittel": {"rueckfaelle": []}}
    assert mc.rueckfall_hinweis(leer) is None
    knoten = {
        "niedrig": {"rueckfaelle": [{"variante": "mitMispel", "tag": "2026-05-31", "grenze": "knotengrenze"}]},
        "mittel": {"rueckfaelle": [{"variante": "mitMispel", "tag": "2026-05-31", "grenze": "knotengrenze"},
                                   {"variante": "mitMispel", "tag": "2026-05-30", "grenze": "knotengrenze"}]},
    }
    satz = mc.rueckfall_hinweis(knoten)
    assert satz.startswith("An 2 Tagen (30.05.2026, 31.05.2026) hat der Solver")
    assert "ohne Gutschrift" in satz and "dasselbe" in satz
    zeit = {"mittel": {"rueckfaelle": [{"variante": "mitMispel", "tag": "2026-05-30", "grenze": "zeitgrenze"}]}}
    assert mc.rueckfall_hinweis(zeit).startswith("An 1 Tag (30.05.2026)")
    assert "kann abweichen" in mc.rueckfall_hinweis(zeit)


@needs_highs
def test_check_zweimal_derselbe_betrag_und_rueckfall_im_hinweis(mai_fenster, monkeypatch):  # noqa: F811
    # Der ganze Check (A1, Mischbetrieb mit Monatszustand) zweimal: dieselben Beträge.
    erster = mc.mispel_check(mc.KUNDENTYPEN["a"], _deps(), faelle=MITTEL)
    zweiter = mc.mispel_check(mc.KUNDENTYPEN["a"], _deps(), faelle=MITTEL)
    assert erster == zweiter
    assert erster["hinweis"] is None and erster["faelle"]["mittel"]["rueckfaelle"] == []
    # An der Knotengrenze: der Rueckfall steht im Hinweis - nie still im Betrag.
    monkeypatch.setattr(solver, "CHECK_KNOTENGRENZE", 0)
    grenze = mc.mispel_check(mc.KUNDENTYPEN["a"], _deps(), faelle=MITTEL)
    rueck = grenze["faelle"]["mittel"]["rueckfaelle"]
    assert rueck and {r["variante"] for r in rueck} == {"mitMispel"}
    assert {r["grenze"] for r in rueck} == {"knotengrenze"}
    assert "ohne Gutschrift" in grenze["hinweis"]
    assert grenze == mc.mispel_check(mc.KUNDENTYPEN["a"], _deps(), faelle=MITTEL)
