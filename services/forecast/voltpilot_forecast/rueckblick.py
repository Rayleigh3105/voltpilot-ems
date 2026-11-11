"""Daily Rückblick job (DB glue): "am Vortag erwartet" vs. "gemessen" (S3).

For a given Europe/Berlin day and every site, every model of ``kind`` that
predicted that day gets ONE row in ``forecast_rueckblick`` (lead_days = 1):
the evening-run (17:45 ± 15 min of the day before - the same "what a
Untergrenze am Vorabend über den nächsten Morgen WUSSTE" rule as
:mod:`voltpilot_optimization.storage_release`, its own copy here since no
module is shared between the two services) summed to kWh against the
measured kWh for the same PAIRED quarter-hours, plus their mean absolute
error in kW (:func:`voltpilot_forecast.evaluation.forecast_metrics` - the
exact quantity S5's automatic switcher compares, Bericht R.4).

Idempotent by construction (PK-targeted upsert). Cadence: triggered from the
same point as the daily evaluation (``forecast_collect.py``'s ``serve``
loop, alongside ``evaluate.run_for``), so no extra container.

    python -m voltpilot_forecast.rueckblick run
    python -m voltpilot_forecast.rueckblick run --date 2026-07-01 --days-back 3
"""

from __future__ import annotations

import argparse
import logging
import os
from datetime import date, datetime, time, timedelta, timezone

from voltpilot_forecast.anlage import anlage_slot_kw, fuehrende_box
from voltpilot_forecast.domain import ForecastKind, ensure_utc
from voltpilot_forecast.evaluation import BERLIN, berlin_day_bounds, forecast_metrics
from voltpilot_forecast.kundenbereich import NICHT_BEENDET
from voltpilot_forecast.pgdsn import dsn_from_env
from voltpilot_forecast.rueckblick_repository import (
    LEAD_DAYS_VORTAG,
    RueckblickRecord,
    RueckblickRepository,
    TimescaleRueckblickRepository,
)

logger = logging.getLogger("voltpilot.forecast.rueckblick")

_KIND_COLUMNS = {ForecastKind.LOAD: "load_kw", ForecastKind.PV: "pv_power_kw"}

#: Der Abend-Lauf (dieselbe Uhrzeit wie der Fahrplan und
#: `voltpilot_optimization.night_reserve`): 17:45 Berliner Zeit, ± 15 min.
RUN_HOUR, RUN_MINUTE = 17, 45
RUN_TOLERANCE = timedelta(minutes=15)

#: Unter dieser Deckung ist ein Tag unvollständig - keine Zeile, nie eine
#: stille Teilsumme ("Fehlend ist keine Null"; dieselbe 90-%-Regel wie
#: `prognoseSeite.ts` DECKUNG).
SLOTS_PER_DAY = 96
MIN_COVERAGE = 0.9


# ---- DB reads (trusted backend role) ------------------------------------------

def _sites(cur) -> list[tuple[str, str]]:
    """Jede Anlage eines lebenden Kundenbereichs - ein "beendeter" bekommt
    keine neue Bewertung (UEMS AP-20 E10 = A, dieselbe Regel wie evaluate.py)."""
    cur.execute(
        "SELECT s.tenant_id, s.id FROM site s JOIN tenant t ON t.id = s.tenant_id "
        "WHERE " + NICHT_BEENDET + " ORDER BY s.id"
    )
    return [(str(t), str(s)) for t, s in cur.fetchall()]


def _actuals(cur, site_id: str, column: str, start, end) -> dict[datetime, float]:
    """Slot-Mittel (Viertelstunde) der Messung - je ANLAGE (eigene Kopie von
    evaluate.py._actuals, keine Modul-Teilung zwischen den Aufrufern)."""
    if column not in _KIND_COLUMNS.values():
        raise ValueError(f"unsupported telemetry column: {column}")
    if fuehrende_box(cur, site_id) is not None:
        return dict(anlage_slot_kw(cur, site_id, column, start, end))
    cur.execute(
        f"""
        SELECT time_bucket('15 minutes', time) AS bucket, avg({column})
        FROM telemetry
        WHERE site_id = %s AND {column} IS NOT NULL
          AND time >= %s AND time < %s
        GROUP BY bucket
        """,
        (site_id, start, end),
    )
    return {ensure_utc(ts): float(v) for ts, v in cur.fetchall()}


def _models_with_predictions(cur, site_id: str, kind: str, start, end) -> list[str]:
    cur.execute(
        """
        SELECT DISTINCT model FROM forecast
        WHERE site_id = %s AND kind = %s AND time >= %s AND time < %s
        """,
        (site_id, kind, start, end),
    )
    return sorted(m for (m,) in cur.fetchall())


def abendlauf_ziel(tag_start: datetime) -> datetime:
    """Die Zielzeit des Abend-Laufs (17:45 Berlin) des Tages VOR ``tag_start``
    - reine Funktion, kein Abruf (Test-Zwilling von
    `voltpilot_optimization.storage_release.evening_runs`'s `target`)."""
    tag_vorher = tag_start.astimezone(BERLIN).date() - timedelta(days=1)
    return datetime.combine(
        tag_vorher, time(RUN_HOUR, RUN_MINUTE), tzinfo=BERLIN
    ).astimezone(timezone.utc)


def naechster_lauf(kandidaten: list[datetime], ziel: datetime) -> datetime | None:
    """Der Lauf am nächsten an ``ziel``, nie der neuere bei Gleichstand - reine
    Funktion, ``None`` ohne Treffer innerhalb ``RUN_TOLERANCE``."""
    innerhalb = [r for r in kandidaten if abs(r - ziel) <= RUN_TOLERANCE]
    if not innerhalb:
        return None
    return min(innerhalb, key=lambda r: (abs(r - ziel), r))


def tageskwh(
    predicted: dict[datetime, float], actual: dict[datetime, float]
) -> tuple[float, float, int]:
    """Tagessummen (kWh) über die gepaarten Viertelstunden - reine Funktion.

    Nur Viertelstunden, die BEIDE Reihen tragen, zählen (dieselbe Ehrlichkeit
    wie `storage_release.day_error_rels`); negative Werte werden auf 0
    abgeschnitten (Rausch-Untergrenze, physikalisch nie negativ)."""
    slots = sorted(set(predicted) & set(actual))
    erwartet_kwh = sum(max(0.0, predicted[t]) for t in slots) * 0.25
    gemessen_kwh = sum(max(0.0, actual[t]) for t in slots) * 0.25
    return round(erwartet_kwh, 4), round(gemessen_kwh, 4), len(slots)


def _evening_run_values(
    cur, site_id: str, kind: str, model: str, day_start, day_end
) -> dict[datetime, float] | None:
    """Die Prognose des Abend-Laufs (17:45 ± 15 min) des VORTAGS für den
    Tag [day_start, day_end) - DB-Glue um :func:`abendlauf_ziel`/
    :func:`naechster_lauf`."""
    ziel = abendlauf_ziel(day_start)
    cur.execute(
        """
        SELECT DISTINCT run_at FROM forecast
        WHERE site_id = %s AND kind = %s AND model = %s
          AND run_at >= %s AND run_at <= %s
        """,
        (site_id, kind, model, ziel - RUN_TOLERANCE, ziel + RUN_TOLERANCE),
    )
    best = naechster_lauf([ensure_utc(row[0]) for row in cur.fetchall()], ziel)
    if best is None:
        return None
    cur.execute(
        """
        SELECT time, value_kw FROM forecast
        WHERE site_id = %s AND kind = %s AND model = %s AND run_at = %s
          AND time >= %s AND time < %s
        """,
        (site_id, kind, model, best, day_start, day_end),
    )
    return {ensure_utc(ts): float(v) for ts, v in cur.fetchall()}


# ---- the Rückblick pass --------------------------------------------------------

def rueckblick_day(conn, repository: RueckblickRepository, day: date) -> int:
    """Rückblick-Zeilen für einen Berliner Tag, jede Anlage, jedes Modell mit
    einer Prognose. Gibt die Zahl der geschriebenen Zeilen zurück."""
    start, end = berlin_day_bounds(day)
    rows = 0
    with conn.cursor() as cur:
        for tenant_id, site_id in _sites(cur):
            for kind in ForecastKind:
                column = _KIND_COLUMNS[kind]
                actual = _actuals(cur, site_id, column, start, end)
                if not actual:
                    continue
                for model in _models_with_predictions(cur, site_id, kind.value, start, end):
                    predicted = _evening_run_values(cur, site_id, kind.value, model, start, end)
                    if not predicted:
                        continue
                    metrics = forecast_metrics(predicted, actual)
                    if metrics is None or metrics.n_slots < int(SLOTS_PER_DAY * MIN_COVERAGE):
                        continue
                    erwartet_kwh, gemessen_kwh, _ = tageskwh(predicted, actual)
                    repository.upsert(
                        RueckblickRecord(
                            day=day,
                            tenant_id=tenant_id,
                            site_id=site_id,
                            kind=kind.value,
                            model=model,
                            lead_days=LEAD_DAYS_VORTAG,
                            erwartet_kwh=erwartet_kwh,
                            gemessen_kwh=gemessen_kwh,
                            mae_kw=metrics.mae_kw,
                            n_slots=metrics.n_slots,
                        )
                    )
                    rows += 1
    return rows


def run_for(dsn: str, day: date, days_back: int = 1) -> None:
    """Rückblick für ``days_back`` Tage bis einschließlich ``day``."""
    import psycopg  # noqa: PLC0415 - optional [db] extra

    with psycopg.connect(dsn) as conn:
        repository = TimescaleRueckblickRepository(conn)
        for offset in range(days_back):
            target = day - timedelta(days=offset)
            rows = rueckblick_day(conn, repository, target)
            print(f"voltpilot-forecast-rueckblick: day={target.isoformat()} rows={rows}")


def yesterday_berlin(now: datetime | None = None) -> date:
    now = now or datetime.now(timezone.utc)
    return (now.astimezone(BERLIN) - timedelta(days=1)).date()


# ---- CLI ------------------------------------------------------------------------

def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="voltpilot-forecast-rueckblick")
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="Rückblick für einen (oder mehrere) Berliner Tag(e)")
    run.add_argument("--date", help="Berliner Tag YYYY-MM-DD (Vorgabe: gestern)")
    run.add_argument("--days-back", type=int, default=1)
    run.add_argument("--log-level", default="INFO")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO))
    dsn = dsn_from_env(dict(os.environ))
    day = date.fromisoformat(args.date) if args.date else yesterday_berlin()
    run_for(dsn, day, args.days_back)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
