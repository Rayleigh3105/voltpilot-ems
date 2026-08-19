"""Daily forecast + plan evaluation job (DB glue around ``evaluation.py``).

For a given Europe/Berlin day and every site it computes:

* per model: forecast-vs-actual metrics (MAE kW, nMAE %, bias, skill vs the
  kind's ACTIVE model) into ``forecast_accuracy``;
* the plan economics (realized vs planned vs no-battery-baseline cost) into
  ``plan_accuracy``.

Idempotent by construction (PK-targeted upserts), so re-running a day - e.g.
after late telemetry - simply overwrites. Cadences:

    python -m voltpilot_forecast.evaluate run                 # yesterday (Berlin)
    python -m voltpilot_forecast.evaluate run --date 2026-07-01 --days-back 3
    python -m voltpilot_forecast.evaluate serve               # daily loop

The collector's ``serve`` loop also triggers this once per Berlin day, so a
deployment needs no extra container (see forecast_collect.py). Runs as the
trusted backend DB role (reads all tenants, writes stamped tenant_id rows -
the weather-collector pattern).
"""

from __future__ import annotations

import argparse
import logging
import os
from datetime import date, datetime, timedelta, timezone

from voltpilot_forecast import model_choice
from voltpilot_forecast.domain import ForecastKind, ensure_utc
from voltpilot_forecast.evaluation import (
    BERLIN,
    berlin_day_bounds,
    forecast_metrics,
    plan_economics,
    skill_vs_baseline,
)
from voltpilot_forecast.quality_repository import (
    AccuracyRecord,
    PlanAccuracyRecord,
    QualityRepository,
    TimescaleQualityRepository,
)
from voltpilot_forecast.runtime import ServeRuntime

logger = logging.getLogger("voltpilot.forecast.evaluate")

_KIND_COLUMNS = {ForecastKind.LOAD: "load_kw", ForecastKind.PV: "pv_power_kw"}


def _dsn_from_env(env: dict[str, str]) -> str:
    from urllib.parse import quote  # noqa: PLC0415

    host = env.get("POSTGRES_HOST", "localhost")
    port = env.get("POSTGRES_PORT", "5432")
    db = env.get("POSTGRES_DB", "voltpilot")
    user = quote(env.get("POSTGRES_USER", "voltpilot"), safe="")
    password = quote(env.get("POSTGRES_PASSWORD", ""), safe="")
    # connect_timeout bounds the connect: without it libpq waits on the OS
    # TCP timeout, so an unreachable DB hangs the cycle (and the shutdown
    # handler) instead of failing into the retry back-off. See
    # docs/k8s-readiness.md.
    timeout = env.get("POSTGRES_CONNECT_TIMEOUT", "10")
    return (
        f"postgresql://{user}:{password}@{host}:{port}/{db}"
        f"?connect_timeout={quote(timeout, safe='')}"
    )


# ---- DB reads (trusted backend role) ------------------------------------------

def _sites(cur) -> list[tuple[str, str]]:
    cur.execute("SELECT tenant_id, id FROM site ORDER BY id")
    return [(str(t), str(s)) for t, s in cur.fetchall()]


def _actuals(cur, site_id: str, column: str, start, end) -> dict[datetime, float]:
    """Slot-mean actuals (15-min buckets) from raw telemetry."""
    # power_kw feeds the plan-economics realized cost; fixed set, never user
    # input - a hard raise (not assert, which is stripped under python -O)
    # keeps the f-string interpolation safe (S15).
    if column not in (*_KIND_COLUMNS.values(), "power_kw"):
        raise ValueError(f"unsupported telemetry column: {column}")
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


def _freshest_predictions(
    cur, site_id: str, kind: str, model: str, start, end
) -> dict[datetime, float]:
    """Per slot: the model's freshest prediction issued at or before the slot -
    exactly what the optimizer would have consumed had this model been active."""
    cur.execute(
        """
        SELECT DISTINCT ON (time) time, value_kw
        FROM forecast
        WHERE site_id = %s AND kind = %s AND model = %s
          AND time >= %s AND time < %s AND run_at <= time
        ORDER BY time, run_at DESC
        """,
        (site_id, kind, model, start, end),
    )
    return {ensure_utc(ts): float(v) for ts, v in cur.fetchall()}


def _planned_costs(cur, site_id: str, start, end) -> dict[datetime, tuple[float, float]]:
    """Per slot: (cost_eur, baseline_cost_eur) of the freshest plan issued at
    or before the slot (the operative ex-ante plan under 15-min MPC)."""
    cur.execute(
        """
        SELECT DISTINCT ON (time) time, cost_eur, baseline_cost_eur
        FROM schedule
        WHERE site_id = %s AND time >= %s AND time < %s AND generated_at <= time
        ORDER BY time, generated_at DESC
        """,
        (site_id, start, end),
    )
    return {
        ensure_utc(ts): (float(c), float(b))
        for ts, c, b in cur.fetchall()
        if c is not None and b is not None
    }


def _prices(cur, zone: str, start, end) -> dict[datetime, float]:
    """Day-ahead price per 15-min slot; PT60M rows expand to their 4 quarters,
    PT15M wins where both exist (same convention as the optimizer)."""
    cur.execute(
        """
        SELECT ts, resolution, price_eur_mwh FROM day_ahead_prices
        WHERE bidding_zone = %s AND ts >= %s AND ts < %s
        """,
        (zone, start - timedelta(minutes=45), end),
    )
    rows = cur.fetchall()
    by_slot: dict[datetime, float] = {}
    for wanted in ("PT60M", "PT15M"):
        for ts, resolution, price in rows:
            if resolution != wanted:
                continue
            ts = ensure_utc(ts)
            for i in range(4 if resolution == "PT60M" else 1):
                slot = ts + i * timedelta(minutes=15)
                if start <= slot < end:
                    by_slot[slot] = float(price)
    return by_slot


def _site_zone(cur, site_id: str) -> str:
    cur.execute("SELECT bidding_zone FROM site WHERE id = %s", (site_id,))
    row = cur.fetchone()
    return row[0] if row else "DE-LU"


# ---- the evaluation pass -------------------------------------------------------

def evaluate_day(
    conn, repository: QualityRepository, day: date, env=None
) -> tuple[int, int]:
    """Evaluate every site for one Berlin day; returns (#accuracy, #plan) rows.

    ⚠ **The skill reference is the ACTIVE model, not the baseline.** Skill
    answers exactly one question - "was this model closer to reality than the
    one that actually plans?" - and the portal has always WORDED it that way
    ("genauer als das aktive Modell"). While nothing is promoted, active ==
    baseline and every number is byte-identical to before; after a promotion
    the ROLES SWAP cleanly: the promoted model becomes the reference (skill
    NULL - it IS the yardstick) and the demoted one gets a skill number again.
    Keying on the baseline instead would leave the demoted model permanently
    skill-NULL, i.e. the candidate panel would go blank the moment someone used
    the promotion switch. The COLUMN keeps its name (``skill_vs_baseline``) -
    an applied migration is immutable.

    ⚠ **The reference is resolved PER SITE** (Captain 19.08.2026): since the
    per-plant switch, two plants of the same fleet can legitimately plan with
    different models, so a fleet-wide reference would score one of them against
    a model it does not use. The choices are read ONCE for the whole pass and
    then applied per site - a read per site would be N identical queries.
    """
    start, end = berlin_day_bounds(day)
    environment = os.environ if env is None else env
    choices = model_choice.load_all(conn)
    accuracy_rows = 0
    plan_rows = 0
    with conn.cursor() as cur:
        for tenant_id, site_id in _sites(cur):
            active = model_choice.active_models(
                environment, choices.for_site(site_id)
            )
            for kind in ForecastKind:
                actuals = _actuals(cur, site_id, _KIND_COLUMNS[kind], start, end)
                if not actuals:
                    continue
                reference_id = active[kind]
                models = _models_with_predictions(cur, site_id, kind.value, start, end)
                metrics_by_model = {}
                for model in models:
                    predictions = _freshest_predictions(
                        cur, site_id, kind.value, model, start, end
                    )
                    metrics = forecast_metrics(predictions, actuals)
                    if metrics is not None:
                        metrics_by_model[model] = metrics
                reference_mae = (
                    metrics_by_model[reference_id].mae_kw
                    if reference_id in metrics_by_model
                    else None
                )
                for model, metrics in metrics_by_model.items():
                    skill = (
                        None
                        if model == reference_id
                        else skill_vs_baseline(metrics.mae_kw, reference_mae)
                    )
                    repository.upsert_accuracy(
                        AccuracyRecord(
                            day=day,
                            tenant_id=tenant_id,
                            site_id=site_id,
                            model=model,
                            kind=kind.value,
                            mae_kw=metrics.mae_kw,
                            nmae_pct=metrics.nmae_pct,
                            bias_kw=metrics.bias_kw,
                            skill_vs_baseline=skill,
                            n_slots=metrics.n_slots,
                        )
                    )
                    accuracy_rows += 1

            # Plan economics (realized vs planned) for the same day.
            planned = _planned_costs(cur, site_id, start, end)
            if planned:
                grid_actual = _actuals(cur, site_id, "power_kw", start, end)
                prices = _prices(cur, _site_zone(cur, site_id), start, end)
                economics = plan_economics(planned, grid_actual, prices)
                if economics is not None:
                    repository.upsert_plan_accuracy(
                        PlanAccuracyRecord(
                            day=day,
                            tenant_id=tenant_id,
                            site_id=site_id,
                            planned_cost_eur=economics.planned_cost_eur,
                            baseline_cost_eur=economics.baseline_cost_eur,
                            realized_cost_eur=economics.realized_cost_eur,
                            n_slots=economics.n_slots,
                        )
                    )
                    plan_rows += 1
    return accuracy_rows, plan_rows


def run_for(dsn: str, day: date, days_back: int = 1) -> None:
    """Evaluate ``days_back`` days ending at ``day`` (inclusive)."""
    import psycopg  # noqa: PLC0415 - optional [db] extra

    with psycopg.connect(dsn) as conn:
        repository = TimescaleQualityRepository(conn)
        for offset in range(days_back):
            target = day - timedelta(days=offset)
            accuracy_rows, plan_rows = evaluate_day(conn, repository, target)
            print(
                f"voltpilot-forecast-eval: day={target.isoformat()} "
                f"accuracy_rows={accuracy_rows} plan_rows={plan_rows}"
            )


def yesterday_berlin(now: datetime | None = None) -> date:
    now = now or datetime.now(timezone.utc)
    return (now.astimezone(BERLIN) - timedelta(days=1)).date()


# ---- CLI ------------------------------------------------------------------------

def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="voltpilot-forecast-eval")
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="evaluate one (or N) Berlin day(s)")
    run.add_argument("--date", help="Berlin day YYYY-MM-DD (default: yesterday)")
    run.add_argument(
        "--days-back", type=int, default=1,
        help="evaluate this many days ending at --date (default 1)",
    )
    run.add_argument("--log-level", default="INFO")

    serve = sub.add_parser("serve", help="evaluate yesterday, repeat periodically")
    serve.add_argument(
        "--interval-seconds", type=int,
        default=int(os.environ.get("FORECAST_EVAL_INTERVAL_SECONDS", "21600")),
        help="seconds between passes (default 21600 = 6h; idempotent re-runs)",
    )
    serve.add_argument("--max-cycles", type=int, default=0)
    serve.add_argument("--log-level", default="INFO")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO))
    env = dict(os.environ)
    dsn = _dsn_from_env(env)

    if args.command == "run":
        day = (
            date.fromisoformat(args.date) if args.date else yesterday_berlin()
        )
        run_for(dsn, day, args.days_back)
        return 0

    if args.command == "serve":
        # Not a deployed service (the forecast collector triggers the daily
        # evaluation inline), but the same container contract applies whenever
        # an operator runs it standalone: SIGTERM must leave the sleep, and a
        # failed cycle must not idle the full interval. No probe endpoint -
        # nothing schedules this loop. See docs/k8s-readiness.md.
        runtime = ServeRuntime("forecast-eval")
        runtime.install_signal_handlers()
        cycle = 0
        while not runtime.stopping:
            try:
                run_for(dsn, yesterday_berlin(), days_back=2)
                runtime.record_success()
            except Exception as exc:  # keep the loop alive across DB blips
                runtime.record_failure(exc)
                logger.warning("eval.cycle_failed: %s", exc)
            cycle += 1
            if args.max_cycles and cycle >= args.max_cycles:
                return 0
            if not runtime.sleep(runtime.next_delay(args.interval_seconds)):
                break
        return 0

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
