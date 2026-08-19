"""Die Wahl des aktiven Prognosemodells als DATEN - Präzedenz, Ehrlichkeit,
Rollen-Tausch (Captain-Auftrag 18.08.2026), und die Wahl JE ANLAGE
(Captain-Auftrag 19.08.2026).

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
    def __init__(self, rows, boom=False, site_rows=None, site_boom=False):
        self._rows = rows
        self._boom = boom
        self._site_rows = site_rows or []
        self._site_boom = site_boom
        self._answer = rows
        self.queries = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        flat = " ".join(sql.split())
        self.queries.append(flat)
        # ⚠ Die ANLAGEN-Tabelle heisst site_forecast_model_choice und enthaelt
        # den Namen der Plattform-Tabelle NICHT als Teilstring (dazwischen steht
        # "site_"), die Reihenfolge hier ist also eindeutig.
        if "FROM site_forecast_model_choice" in flat:
            if self._site_boom:
                raise RuntimeError(
                    'relation "site_forecast_model_choice" does not exist'
                )
            self._answer = self._site_rows
            return
        if self._boom:
            raise RuntimeError('relation "forecast_model_choice" does not exist')
        self._answer = self._rows

    def fetchall(self):
        return self._answer


class _ChoiceConnection:
    def __init__(self, rows, boom=False, site_rows=None, site_boom=False):
        self.cur = _ChoiceCursor(rows, boom, site_rows, site_boom)
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


# ---- die Wahl JE ANLAGE (Captain-Auftrag 19.08.2026) --------------------------

SITE_A = "00000000-0000-0000-0000-0000000000aa"
SITE_B = "00000000-0000-0000-0000-0000000000bb"


def test_without_a_site_row_every_plant_follows_the_platform_default():
    """Die Rueckwaerts-Sicherheit der Stufe zwei: ohne Anlagen-Zeile ist jede
    Anlage von der Zeit vor dem Anlagen-Schalter nicht zu unterscheiden."""
    conn = _ChoiceConnection([("load", "load-xgb")], site_rows=[])
    choices = model_choice.load_all(conn)

    assert choices.per_site == {}
    assert choices.for_site(SITE_A) == {ForecastKind.LOAD: registry.LOAD_XGB}
    active = model_choice.active_models({}, choices.for_site(SITE_A))
    assert active[ForecastKind.LOAD] == registry.LOAD_XGB
    assert active[ForecastKind.PV] == registry.PV_PHYSICAL


def test_the_site_choice_beats_the_platform_default_and_only_for_that_site():
    """Das Abnahmekriterium: NUR diese Anlage plant mit dem Kandidaten."""
    conn = _ChoiceConnection(
        [("load", "load-persistence")],
        site_rows=[(SITE_A, "load", "load-xgb"), (SITE_A, "pv", "pv-residual-xgb")],
    )
    choices = model_choice.load_all(conn)

    a = model_choice.active_models({}, choices.for_site(SITE_A))
    assert a[ForecastKind.LOAD] == registry.LOAD_XGB
    assert a[ForecastKind.PV] == registry.PV_RESIDUAL_XGB
    # Die NACHBAR-Anlage bleibt unberuehrt - das ist der ganze Punkt.
    b = model_choice.active_models({}, choices.for_site(SITE_B))
    assert b[ForecastKind.LOAD] == registry.LOAD_PERSISTENCE
    assert b[ForecastKind.PV] == registry.PV_PHYSICAL


def test_a_site_row_wins_over_the_environment_too():
    conn = _ChoiceConnection([], site_rows=[(SITE_A, "load", "load-xgb")])
    choices = model_choice.load_all(conn)
    active = model_choice.active_models(
        {"VOLTPILOT_ACTIVE_LOAD_MODEL": "load-persistence"}, choices.for_site(SITE_A)
    )
    assert active[ForecastKind.LOAD] == registry.LOAD_XGB


def test_the_site_query_orders_on_the_sequence_per_site_and_kind():
    conn = _ChoiceConnection([], site_rows=[])
    model_choice.load_site_choices(conn)
    sql = conn.cur.queries[0]
    assert "DISTINCT ON (site_id, model_kind)" in sql
    assert "ORDER BY site_id, model_kind, id DESC" in sql


@pytest.mark.parametrize(
    "rows",
    [
        [(SITE_A, "load", "load_xgb")],       # Tippfehler
        [(SITE_A, "load", "pv-physical")],    # art-fremd
        [(SITE_A, "waerme", "load-xgb")],     # unbekannte Prognoseart
    ],
)
def test_an_unusable_site_row_is_discarded_never_adopted(rows, caplog):
    conn = _ChoiceConnection([], site_rows=rows)
    with caplog.at_level("WARNING"):
        choices = model_choice.load_all(conn)
    assert caplog.records, "eine verworfene Zeile muss laut sein"
    # ... und damit gilt wieder die Plattform-Vorgabe bzw. die Umgebung.
    assert choices.for_site(SITE_A) == {}


def test_a_missing_site_table_degrades_to_the_platform_default(caplog):
    """Eine DB, deren api-Migration V20260826000000 noch nicht gelaufen ist."""
    conn = _ChoiceConnection([("load", "load-xgb")], site_rows=[], site_boom=True)
    with caplog.at_level("WARNING"):
        choices = model_choice.load_all(conn)
    assert conn.rolled_back
    assert choices.for_site(SITE_A) == {ForecastKind.LOAD: registry.LOAD_XGB}


def test_the_evaluation_reference_is_resolved_PER_SITE():
    """Zwei Anlagen derselben Flotte duerfen verschieden planen - der Massstab
    einer Anlage ist ihr eigenes aktives Modell, nie das der Nachbarin."""
    day = date(2026, 6, 15)
    t0 = datetime(2026, 6, 15, 10, 0, tzinfo=timezone.utc)
    slots = [t0 + i * timedelta(minutes=15) for i in range(4)]

    db = _eval_db(slots)
    db["site_model_choice"] = [(SITE.site_id, "load", "load-xgb")]
    repo = InMemoryQualityRepository()
    evaluate_day(_EvalConnection(db), repo, day, env={})

    # Die Anlage hat umgestellt -> der Kandidat IST der Massstab.
    assert repo.accuracy[(SITE.site_id, "load-xgb", day)].skill_vs_baseline is None
    assert repo.accuracy[(SITE.site_id, "load-persistence", day)].skill_vs_baseline == -3.0

    # Eine Zeile fuer eine ANDERE Anlage laesst diese hier voellig unberuehrt.
    db2 = _eval_db(slots)
    db2["site_model_choice"] = [(SITE_B, "load", "load-xgb")]
    repo2 = InMemoryQualityRepository()
    evaluate_day(_EvalConnection(db2), repo2, day, env={})
    assert repo2.accuracy[(SITE.site_id, "load-persistence", day)].skill_vs_baseline is None
    assert repo2.accuracy[(SITE.site_id, "load-xgb", day)].skill_vs_baseline == 0.75


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
