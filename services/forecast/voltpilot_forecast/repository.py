"""Forecast persistence seam - how the optimizer consumes forecasts.

Architecture section 10 lists forecasts among the TimescaleDB hypertables
(Telemetrie, *Prognosen*, Fahrpläne, KPIs), so the production exposure is a
``forecast`` hypertable that the optimizer reads. :class:`ForecastRepository` is
the interface; two implementations back it:

- :class:`InMemoryForecastRepository` - default, dependency-free, for tests and
  offline runs (keeps the service startable without a database, matching the
  scaffold's offline-first stance).
- :class:`TimescaleForecastRepository` - writes/reads the ``forecast`` hypertable
  via ``psycopg`` (optional ``db`` extra). The DDL lives in the Flyway migration
  ``migrations/V3__forecast_hypertable.sql`` +
  ``V20260702000000__forecast_model_column.sql``; see AGENTS.md for version
  coordination.

Shadow-mode forecasting (docs/forecasting.md): every persisted row is tagged
with the producing **model id** (``ForecastSeries.model``), so the ACTIVE model
and its shadow challengers coexist in the same table. ``latest(...)`` takes the
model id; the optimizer only ever asks for the active model's rows, everything
else stays measurement material for the daily evaluation.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from voltpilot_forecast.domain import (
    ForecastKind,
    ForecastPoint,
    ForecastSeries,
    ensure_utc,
)


class ForecastRepository(ABC):
    """Store forecast runs and read back the latest run for a site+kind+model."""

    @abstractmethod
    def save(self, series: ForecastSeries) -> None:
        """Persist a full forecast run (all slots), tagged with its model id."""
        raise NotImplementedError

    @abstractmethod
    def latest(
        self, site_id: str, kind: ForecastKind, model: str | None = None
    ) -> ForecastSeries | None:
        """The most recently issued forecast for ``site_id``/``kind``.

        ``model`` narrows to one model's runs; ``None`` means "any model"
        (the pre-registry behavior, kept for tooling/back-compat - production
        consumers always pass the active model id).
        """
        raise NotImplementedError


class InMemoryForecastRepository(ForecastRepository):
    """Non-durable reference implementation keyed by (site_id, kind, model).

    Keeps only the latest run per key (the optimizer always wants the freshest),
    which is enough for tests and local demos.
    """

    def __init__(self) -> None:
        self._store: dict[tuple[str, ForecastKind, str], ForecastSeries] = {}

    def save(self, series: ForecastSeries) -> None:
        key = (series.site_id, series.kind, series.model)
        existing = self._store.get(key)
        if existing is None or ensure_utc(series.run_at) >= ensure_utc(
            existing.run_at
        ):
            self._store[key] = series

    def latest(
        self, site_id: str, kind: ForecastKind, model: str | None = None
    ) -> ForecastSeries | None:
        if model is not None:
            return self._store.get((site_id, kind, model))
        candidates = [
            s
            for (sid, k, _), s in self._store.items()
            if sid == site_id and k == kind
        ]
        if not candidates:
            return None
        return max(candidates, key=lambda s: ensure_utc(s.run_at))


class TimescaleForecastRepository(ForecastRepository):
    """TimescaleDB-backed repository writing the ``forecast`` hypertable.

    ``psycopg`` (v3) is imported lazily so the rest of the package stays
    dependency-free; install the ``db`` extra to use this class. ``connection`` is
    a live ``psycopg.Connection`` (caller owns its lifecycle/pooling).
    """

    def __init__(self, connection) -> None:  # noqa: ANN001 - psycopg optional
        self._conn = connection

    def save(self, series: ForecastSeries) -> None:
        run_at = ensure_utc(series.run_at)
        rows = [
            (
                ensure_utc(point.timestamp),
                series.tenant_id,
                series.site_id,
                series.kind.value,
                series.model,
                point.value_kw,
                run_at,
                int((ensure_utc(point.timestamp) - run_at).total_seconds() // 60),
                series.method,
                series.schema_version,
            )
            for point in series.points
        ]
        if not rows:
            return
        with self._conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO forecast (
                    time, tenant_id, site_id, kind, model, value_kw,
                    run_at, horizon_min, method, schema_version
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (site_id, kind, model, run_at, time)
                DO UPDATE SET value_kw = EXCLUDED.value_kw,
                              horizon_min = EXCLUDED.horizon_min,
                              method = EXCLUDED.method,
                              schema_version = EXCLUDED.schema_version
                """,
                rows,
            )
        self._conn.commit()

    def latest(
        self, site_id: str, kind: ForecastKind, model: str | None = None
    ) -> ForecastSeries | None:
        with self._conn.cursor() as cur:
            # Resolve the newest run first - (run_at, model) together, so two
            # models issuing at the same instant can never interleave rows.
            if model is None:
                cur.execute(
                    """
                    SELECT run_at, model FROM forecast
                    WHERE site_id = %s AND kind = %s
                    ORDER BY run_at DESC LIMIT 1
                    """,
                    (site_id, kind.value),
                )
            else:
                cur.execute(
                    """
                    SELECT max(run_at), %s FROM forecast
                    WHERE site_id = %s AND kind = %s AND model = %s
                    """,
                    (model, site_id, kind.value, model),
                )
            row = cur.fetchone()
            if row is None or row[0] is None:
                return None
            run_at, run_model = row[0], row[1]
            cur.execute(
                """
                SELECT time, value_kw, tenant_id, method, schema_version, model
                FROM forecast
                WHERE site_id = %s AND kind = %s AND model = %s AND run_at = %s
                ORDER BY time
                """,
                (site_id, kind.value, run_model, run_at),
            )
            fetched = cur.fetchall()
        if not fetched:
            return None
        points = [ForecastPoint(r[0], float(r[1])) for r in fetched]
        return ForecastSeries(
            kind=kind,
            site_id=site_id,
            tenant_id=fetched[0][2],
            run_at=run_at,
            method=fetched[0][3],
            points=points,
            schema_version=int(fetched[0][4]),
            model=fetched[0][5],
        )
