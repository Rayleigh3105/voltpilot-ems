"""Die Wahl des aktiven Prognosemodells als DATEN - Präzedenz, Ehrlichkeit,
Rollen-Tausch (Captain-Auftrag 18.08.2026).

Offline: eine winzige gefälschte Verbindung, die genau die eine Abfrage
beantwortet, plus der ECHTE Evaluator gegen die Fakes aus ``test_collect``.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest

from voltpilot_forecast import model_choice, registry
from voltpilot_forecast.domain import ForecastKind
from voltpilot_forecast.evaluate import evaluate_day

from test_collect import SITE, InMemoryQualityRepository, _EvalConnection


class _ChoiceCursor:
    def __init__(self, rows, boom=False):
        self._rows = rows
        self._boom = boom
        self.queries = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        self.queries.append(" ".join(sql.split()))
        if self._boom:
            raise RuntimeError('relation "forecast_model_choice" does not exist')

    def fetchall(self):
        return self._rows


class _ChoiceConnection:
    def __init__(self, rows, boom=False):
        self.cur = _ChoiceCursor(rows, boom)
        self.rolled_back = False

    def cursor(self):
        return self.cur

    def rollback(self):
        self.rolled_back = True


# ---- the precedence contract -------------------------------------------------

def test_without_a_row_the_environment_still_decides():
    """Die Rückwärts-Sicherheit: keine Zeile = exakt das Verhalten von vorher."""
    conn = _ChoiceConnection([])
    assert model_choice.load_choices(conn) == {}
    active = model_choice.active_models({}, {})
    assert active[ForecastKind.LOAD] == registry.LOAD_PERSISTENCE
    assert active[ForecastKind.PV] == registry.PV_PHYSICAL
    # Und eine gesetzte Umgebungsvariable gilt unverändert.
    active = model_choice.active_models({"VOLTPILOT_ACTIVE_LOAD_MODEL": "load-xgb"}, {})
    assert active[ForecastKind.LOAD] == registry.LOAD_XGB


def test_a_stored_choice_beats_the_environment():
    conn = _ChoiceConnection([("load", "load-xgb"), ("pv", "pv-residual-xgb")])
    choices = model_choice.load_choices(conn)
    assert choices == {
        ForecastKind.LOAD: registry.LOAD_XGB,
        ForecastKind.PV: registry.PV_RESIDUAL_XGB,
    }
    # Die Umgebung sagt etwas anderes - die Zeile gewinnt trotzdem.
    active = model_choice.active_models(
        {"VOLTPILOT_ACTIVE_LOAD_MODEL": "load-persistence"}, choices
    )
    assert active[ForecastKind.LOAD] == registry.LOAD_XGB
    assert active[ForecastKind.PV] == registry.PV_RESIDUAL_XGB


def test_the_query_orders_on_the_sequence_not_on_the_timestamp():
    """Zwei Umstellungen in derselben Mikrosekunde wären auf set_at ein
    Gleichstand - die Sequenz ist die Ordnung."""
    conn = _ChoiceConnection([])
    model_choice.load_choices(conn)
    sql = conn.cur.queries[0]
    assert "DISTINCT ON (model_kind)" in sql
    assert "ORDER BY model_kind, id DESC" in sql


# ---- honesty ------------------------------------------------------------------

@pytest.mark.parametrize(
    "rows",
    [
        [("load", "load_xgb")],          # Tippfehler: unbekannte Id
        [("load", "pv-physical")],       # art-fremd
        [("wärme", "load-xgb")],         # unbekannte Prognoseart
    ],
)
def test_an_unusable_row_is_discarded_never_adopted(rows, caplog):
    """Sie kann nur von Hand entstanden sein - der Schreibpfad validiert. Sie zu
    übernehmen fände null gespeicherte Prognosezeilen und ließe den Optimierer
    still auf seine Baseline zurückfallen, während das Portal „live" zeigt."""
    conn = _ChoiceConnection(rows)
    with caplog.at_level("WARNING"):
        assert model_choice.load_choices(conn) == {}
    assert caplog.records, "eine verworfene Zeile muss laut sein"
    # ... und damit gilt wieder die Umgebung, nie ein Rateversuch.
    active = model_choice.active_models({}, model_choice.load_choices(conn))
    assert active[ForecastKind.LOAD] == registry.LOAD_PERSISTENCE


def test_a_missing_table_degrades_to_the_environment_and_rolls_back(caplog):
    conn = _ChoiceConnection([], boom=True)
    with caplog.at_level("WARNING"):
        assert model_choice.load_choices(conn) == {}
    # Ohne Rollback schlüge jede FOLGE-Abfrage derselben Verbindung fehl - der
    # Evaluator teilt sich eine.
    assert conn.rolled_back


# ---- the role swap (Teil A.5) --------------------------------------------------

def _eval_db(slots):
    return {
        "telemetry": {
            "load_kw": {ts: 2.0 for ts in slots},
            "pv_power_kw": {},
            "power_kw": {ts: 2.0 for ts in slots},
        },
        "forecast": {
            ("load", "load-persistence"): {ts: 3.0 for ts in slots},   # MAE 1.00
            ("load", "load-xgb"): {ts: 2.25 for ts in slots},          # MAE 0.25
        },
        "schedule": {ts: (0.03, 0.05) for ts in slots},
        "prices": [(slots[0], "PT60M", 100.0)],
    }


def test_after_a_promotion_the_roles_swap_and_the_demoted_model_keeps_a_skill():
    """Der Kern der Beförderung: der Maßstab ist das AKTIVE Modell.

    Vorher (nichts befördert) hat das Basismodell keinen Skill und der Kandidat
    einen - danach genau umgekehrt. Mit dem alten Maßstab „Basismodell" bliebe
    das abgelöste Modell für immer skill-NULL, und das Kandidaten-Panel wäre
    nach dem ersten Klick blind.
    """
    day = date(2026, 6, 15)
    t0 = datetime(2026, 6, 15, 10, 0, tzinfo=timezone.utc)
    slots = [t0 + i * timedelta(minutes=15) for i in range(4)]

    # 1) Vor der Beförderung: Kandidat hat Skill, Aktiv/Basis nicht.
    before = InMemoryQualityRepository()
    evaluate_day(_EvalConnection(_eval_db(slots)), before, day, env={})
    assert before.accuracy[(SITE.site_id, "load-persistence", day)].skill_vs_baseline is None
    assert before.accuracy[(SITE.site_id, "load-xgb", day)].skill_vs_baseline == 0.75

    # 2) Nach der Beförderung (eine Zeile in forecast_model_choice) - dieselben
    #    Messwerte, vertauschte Rollen.
    db = _eval_db(slots)
    db["model_choice"] = [("load", "load-xgb")]
    after = InMemoryQualityRepository()
    evaluate_day(_EvalConnection(db), after, day, env={})
    assert after.accuracy[(SITE.site_id, "load-xgb", day)].skill_vs_baseline is None
    demoted = after.accuracy[(SITE.site_id, "load-persistence", day)]
    # 1 - 1.00/0.25 = -3.0: das abgelöste Modell wird bewertet und ist schlechter.
    assert demoted.skill_vs_baseline == -3.0
    assert demoted.mae_kw == 1.0


def test_the_promotion_changes_no_measured_number():
    """Nur der MASSSTAB wechselt: MAE/nMAE/Bias sind identisch."""
    day = date(2026, 6, 15)
    t0 = datetime(2026, 6, 15, 10, 0, tzinfo=timezone.utc)
    slots = [t0 + i * timedelta(minutes=15) for i in range(4)]

    before = InMemoryQualityRepository()
    evaluate_day(_EvalConnection(_eval_db(slots)), before, day, env={})
    db = _eval_db(slots)
    db["model_choice"] = [("load", "load-xgb")]
    after = InMemoryQualityRepository()
    evaluate_day(_EvalConnection(db), after, day, env={})

    for model in ("load-persistence", "load-xgb"):
        a = before.accuracy[(SITE.site_id, model, day)]
        b = after.accuracy[(SITE.site_id, model, day)]
        assert (a.mae_kw, a.nmae_pct, a.bias_kw, a.n_slots) == (
            b.mae_kw, b.nmae_pct, b.bias_kw, b.n_slots
        )
