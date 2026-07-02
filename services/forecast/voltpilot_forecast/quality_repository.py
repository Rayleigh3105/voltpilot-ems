"""Persistence for the shadow-mode measurement tables.

Three tables, all owned by the api Flyway migration ``V20260701040000`` (RLS-
scoped by tenant like telemetry; the collector/evaluator write as the trusted
backend role and stamp ``tenant_id`` - the weather-collector pattern):

* ``forecast_model_state``  - per site x model lifecycle + explainability trail
  (:class:`ModelState`), upserted every collector cycle.
* ``forecast_accuracy``     - per site x model x Berlin-day forecast-vs-actual
  metrics (:class:`AccuracyRecord`), upserted by the daily evaluation.
* ``plan_accuracy``         - per site x Berlin-day plan economics
  (:class:`PlanAccuracyRecord`), upserted by the daily evaluation.

Like the sibling repositories: an ABC seam, an in-memory fake for offline
tests, and a psycopg-backed writer behind the optional ``db`` extra. All
upserts are idempotent (re-running a day overwrites, never duplicates).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import date, datetime

from voltpilot_forecast.domain import ensure_utc

#: forecast_model_state.status values (machine codes; German copy lives in the
#: portal): 'collecting' = self-gate unmet, NO predictions; 'ready' = predicting.
STATUS_COLLECTING = "collecting"
STATUS_READY = "ready"


@dataclass(frozen=True)
class ModelState:
    """One row of ``forecast_model_state``."""

    tenant_id: str
    site_id: str
    model: str
    kind: str  # 'load' | 'pv'
    status: str  # STATUS_COLLECTING | STATUS_READY
    updated_at: datetime
    days_collected: int | None = None
    days_required: int | None = None
    trained_at: datetime | None = None
    train_rows: int | None = None
    # [{"feature": ..., "label": <German>, "weight": 0..1}, ...] most important first
    feature_importance: list[dict] = field(default_factory=list)


@dataclass(frozen=True)
class AccuracyRecord:
    """One row of ``forecast_accuracy`` (a site x model x Berlin day)."""

    day: date
    tenant_id: str
    site_id: str
    model: str
    kind: str
    mae_kw: float
    n_slots: int
    nmae_pct: float | None = None
    bias_kw: float | None = None
    skill_vs_baseline: float | None = None  # None for the baseline itself


@dataclass(frozen=True)
class PlanAccuracyRecord:
    """One row of ``plan_accuracy`` (a site x Berlin day)."""

    day: date
    tenant_id: str
    site_id: str
    n_slots: int
    planned_cost_eur: float | None = None
    baseline_cost_eur: float | None = None
    realized_cost_eur: float | None = None


class QualityRepository(ABC):
    """Write seam for model state + daily accuracy rows."""

    @abstractmethod
    def upsert_model_state(self, state: ModelState) -> None: ...

    @abstractmethod
    def upsert_accuracy(self, record: AccuracyRecord) -> None: ...

    @abstractmethod
    def upsert_plan_accuracy(self, record: PlanAccuracyRecord) -> None: ...


class InMemoryQualityRepository(QualityRepository):
    """Offline reference implementation (keyed exactly like the table PKs)."""

    def __init__(self) -> None:
        self.model_states: dict[tuple[str, str], ModelState] = {}
        self.accuracy: dict[tuple[str, str, date], AccuracyRecord] = {}
        self.plan_accuracy: dict[tuple[str, date], PlanAccuracyRecord] = {}

    def upsert_model_state(self, state: ModelState) -> None:
        self.model_states[(state.site_id, state.model)] = state

    def upsert_accuracy(self, record: AccuracyRecord) -> None:
        self.accuracy[(record.site_id, record.model, record.day)] = record

    def upsert_plan_accuracy(self, record: PlanAccuracyRecord) -> None:
        self.plan_accuracy[(record.site_id, record.day)] = record


_STATE_SQL = """
INSERT INTO forecast_model_state (
    tenant_id, site_id, model, kind, status,
    days_collected, days_required, trained_at, train_rows,
    feature_importance, updated_at
) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s)
ON CONFLICT (site_id, model) DO UPDATE SET
    tenant_id = EXCLUDED.tenant_id,
    kind = EXCLUDED.kind,
    status = EXCLUDED.status,
    days_collected = EXCLUDED.days_collected,
    days_required = EXCLUDED.days_required,
    trained_at = EXCLUDED.trained_at,
    train_rows = EXCLUDED.train_rows,
    feature_importance = EXCLUDED.feature_importance,
    updated_at = EXCLUDED.updated_at
"""

_ACCURACY_SQL = """
INSERT INTO forecast_accuracy (
    day, tenant_id, site_id, model, kind,
    mae_kw, nmae_pct, bias_kw, skill_vs_baseline, n_slots, computed_at
) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
ON CONFLICT (site_id, model, day) DO UPDATE SET
    tenant_id = EXCLUDED.tenant_id,
    kind = EXCLUDED.kind,
    mae_kw = EXCLUDED.mae_kw,
    nmae_pct = EXCLUDED.nmae_pct,
    bias_kw = EXCLUDED.bias_kw,
    skill_vs_baseline = EXCLUDED.skill_vs_baseline,
    n_slots = EXCLUDED.n_slots,
    computed_at = now()
"""

_PLAN_SQL = """
INSERT INTO plan_accuracy (
    day, tenant_id, site_id,
    planned_cost_eur, baseline_cost_eur, realized_cost_eur, n_slots, computed_at
) VALUES (%s, %s, %s, %s, %s, %s, %s, now())
ON CONFLICT (site_id, day) DO UPDATE SET
    tenant_id = EXCLUDED.tenant_id,
    planned_cost_eur = EXCLUDED.planned_cost_eur,
    baseline_cost_eur = EXCLUDED.baseline_cost_eur,
    realized_cost_eur = EXCLUDED.realized_cost_eur,
    n_slots = EXCLUDED.n_slots,
    computed_at = now()
"""


class TimescaleQualityRepository(QualityRepository):
    """psycopg-backed writer (``connection`` lifecycle owned by the caller)."""

    def __init__(self, connection) -> None:  # noqa: ANN001 - psycopg optional
        self._conn = connection

    def upsert_model_state(self, state: ModelState) -> None:
        import json  # noqa: PLC0415

        with self._conn.cursor() as cur:
            cur.execute(
                _STATE_SQL,
                (
                    state.tenant_id,
                    state.site_id,
                    state.model,
                    state.kind,
                    state.status,
                    state.days_collected,
                    state.days_required,
                    None if state.trained_at is None else ensure_utc(state.trained_at),
                    state.train_rows,
                    json.dumps(state.feature_importance),
                    ensure_utc(state.updated_at),
                ),
            )
        self._conn.commit()

    def upsert_accuracy(self, record: AccuracyRecord) -> None:
        with self._conn.cursor() as cur:
            cur.execute(
                _ACCURACY_SQL,
                (
                    record.day,
                    record.tenant_id,
                    record.site_id,
                    record.model,
                    record.kind,
                    record.mae_kw,
                    record.nmae_pct,
                    record.bias_kw,
                    record.skill_vs_baseline,
                    record.n_slots,
                ),
            )
        self._conn.commit()

    def upsert_plan_accuracy(self, record: PlanAccuracyRecord) -> None:
        with self._conn.cursor() as cur:
            cur.execute(
                _PLAN_SQL,
                (
                    record.day,
                    record.tenant_id,
                    record.site_id,
                    record.planned_cost_eur,
                    record.baseline_cost_eur,
                    record.realized_cost_eur,
                    record.n_slots,
                ),
            )
        self._conn.commit()
