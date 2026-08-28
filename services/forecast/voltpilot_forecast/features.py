"""Tabular feature engineering for the gradient-boosted challengers.

Everything here is pure, dependency-free Python (the ML library itself stays
isolated in :mod:`voltpilot_forecast.ml` behind the optional ``ml`` extra), so
the feature logic is unit-testable offline and its semantics are documented in
ONE place - the traceability requirement extends to what the model actually
sees.

Leakage discipline
------------------
Features must be computable identically at training time and at prediction
time. A prediction for target slot ``t`` is issued at ``run_at`` up to 24h
earlier, so every feature only uses data at or before ``t - 24h`` (lags,
windowed means) or data that is legitimately known ahead (calendar, weather
FORECAST). That is why the "rolling mean" features are lagged by one day:

* ``lag_1d_kw`` / ``lag_7d_kw`` - the value at the same slot 1 / 7 days before
  ``t`` (both are <= run_at for a 24h horizon).
* ``same_slot_mean_7d_kw`` - mean over the same slot on the 7 previous days.
* ``prev_period_mean_kw`` - mean over the 24h window ``(t-48h, t-24h]``, the
  most recent full day guaranteed to be observed at issue time.

Missing values become NaN - XGBoost handles them natively (learned default
split direction), so sparse history degrades gracefully instead of erroring.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Mapping, Sequence
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from voltpilot_forecast.domain import (
    Observation,
    ensure_utc,
    floor_to_slot,
    slot_means,
)
from voltpilot_forecast.holidays import is_german_holiday
from voltpilot_forecast.openmeteo import WeatherPoint, hour_label_for

SLOT_MINUTES = 15
SLOTS_PER_DAY = 24 * 60 // SLOT_MINUTES

#: The v1 platform timezone (matches the api's HistoryRange.ZONE): calendar
#: features describe GERMAN daily life, so they are computed in Berlin time.
BERLIN = ZoneInfo("Europe/Berlin")

NAN = float("nan")

# ---- feature vocabulary (order = model input order) ---------------------------

LOAD_FEATURES: tuple[str, ...] = (
    "slot_of_day",
    "day_of_week",
    "is_weekend",
    "is_holiday",
    "lag_1d_kw",
    "lag_7d_kw",
    "same_slot_mean_7d_kw",
    "prev_period_mean_kw",
    "temperature_c",
)

PV_RESIDUAL_FEATURES: tuple[str, ...] = (
    "physical_kw",
    "slot_of_day",
    "ghi_w_m2",
    "cloud_cover_pct",
    "temperature_c",
)

#: Plain-German labels for the portal's explainability trail ("Prognosequalität"
#: shows the top feature importances of the last training run).
FEATURE_LABELS_DE: Mapping[str, str] = {
    "slot_of_day": "Uhrzeit",
    "day_of_week": "Wochentag",
    "is_weekend": "Wochenende",
    "is_holiday": "Feiertag",
    "lag_1d_kw": "Verbrauch gestern zur gleichen Zeit",
    "lag_7d_kw": "Verbrauch vor einer Woche zur gleichen Zeit",
    "same_slot_mean_7d_kw": "Mittel gleiche Uhrzeit, letzte 7 Tage",
    "prev_period_mean_kw": "Tagesmittel des Vortags",
    "temperature_c": "Außentemperatur",
    "physical_kw": "Physikalische PV-Prognose",
    "ghi_w_m2": "Sonneneinstrahlung",
    "cloud_cover_pct": "Bewölkung",
}


# ---- 15-min bucketing ---------------------------------------------------------

def bucket_15min(history: Sequence[Observation]) -> dict[datetime, float]:
    """Mean value per 15-min slot from raw telemetry samples (UTC slot starts).

    Thin alias of :func:`voltpilot_forecast.domain.slot_means` at the fixed
    feature slot width - ONE aggregation for challengers and baselines alike.
    """
    return slot_means(history, SLOT_MINUTES)


def full_days(by_slot: Mapping[datetime, float], min_slots: int = 48) -> int:
    """How many distinct UTC days have at least ``min_slots`` observed slots.

    This is the challengers' self-gating currency: a "training day" only counts
    when at least half of its 96 slots carry data, so a few stray samples never
    unlock training on effectively empty history.
    """
    per_day: dict = {}
    for ts in by_slot:
        day = ensure_utc(ts).date()
        per_day[day] = per_day.get(day, 0) + 1
    return sum(1 for n in per_day.values() if n >= min_slots)


# ---- weather lookup (temperature for load; irradiance for PV residual) --------

class WeatherHistory:
    """Hour-keyed lookup over stored weather points (past runs + latest run).

    The collector assembles this from the ``weather_forecast`` hypertable
    (latest run per past hour, i.e. "the weather that was forecast for that
    hour" - the same information a live prediction has). Missing hours yield
    NaN features rather than errors.

    Keyed through :func:`~voltpilot_forecast.openmeteo.hour_label_for`, so a
    slot gets the bucket that CONTAINS it - the same convention the irradiance
    provider reads, in one place rather than two. Nothing is SHAPED here: a
    feature only has to be the right hour, and these rows feed a learned
    residual that never reaches a plan (shadow models are consumed by nobody
    but the daily evaluation), so the challenger simply relearns against a
    better-aligned feature on its next nightly retrain.
    """

    def __init__(self, points: Iterable[WeatherPoint]) -> None:
        # Stored points carry their own label; index them by it verbatim.
        self._by_hour: dict[datetime, WeatherPoint] = {
            ensure_utc(p.timestamp).replace(minute=0, second=0, microsecond=0): p
            for p in points
        }

    def at(self, ts: datetime) -> WeatherPoint | None:
        return self._by_hour.get(hour_label_for(ensure_utc(ts)))

    def temperature_at(self, ts: datetime) -> float:
        point = self.at(ts)
        if point is None or point.temperature_c is None:
            return NAN
        return float(point.temperature_c)

    def points(self) -> tuple[WeatherPoint, ...]:
        return tuple(self._by_hour[h] for h in sorted(self._by_hour))

    def __len__(self) -> int:
        return len(self._by_hour)


# ---- load features -------------------------------------------------------------

def _calendar(ts: datetime) -> tuple[float, float, float, float]:
    local = ensure_utc(ts).astimezone(BERLIN)
    slot_of_day = float(local.hour * 4 + local.minute // SLOT_MINUTES)
    dow = float(local.weekday())
    weekend = 1.0 if local.weekday() >= 5 else 0.0
    holiday = 1.0 if is_german_holiday(local.date()) else 0.0
    return slot_of_day, dow, weekend, holiday


def _same_slot_mean(
    by_slot: Mapping[datetime, float], ts: datetime, days: int = 7
) -> float:
    values = [
        by_slot[ts - timedelta(days=k)]
        for k in range(1, days + 1)
        if ts - timedelta(days=k) in by_slot
    ]
    return sum(values) / len(values) if values else NAN


def _prev_period_mean(by_slot: Mapping[datetime, float], ts: datetime) -> float:
    start, end = ts - timedelta(hours=48), ts - timedelta(hours=24)
    values = [v for slot, v in by_slot.items() if start < slot <= end]
    return sum(values) / len(values) if values else NAN


def load_feature_row(
    ts: datetime,
    by_slot: Mapping[datetime, float],
    temperature_at: Callable[[datetime], float],
) -> list[float]:
    """One feature vector (order = :data:`LOAD_FEATURES`) for target slot ``ts``."""
    ts = floor_to_slot(ts, SLOT_MINUTES)
    slot_of_day, dow, weekend, holiday = _calendar(ts)
    lag_1d = by_slot.get(ts - timedelta(days=1), NAN)
    lag_7d = by_slot.get(ts - timedelta(days=7), NAN)
    return [
        slot_of_day,
        dow,
        weekend,
        holiday,
        lag_1d,
        lag_7d,
        _same_slot_mean(by_slot, ts),
        _prev_period_mean(by_slot, ts),
        temperature_at(ts),
    ]


def build_load_training_set(
    by_slot: Mapping[datetime, float],
    temperature_at: Callable[[datetime], float],
) -> tuple[list[list[float]], list[float]]:
    """(X, y) over every observed slot that has at least the 1-day lag.

    Rows without ``lag_1d`` are dropped (the very first day of history has no
    usable signal); every other missing feature stays NaN for the booster.
    """
    xs: list[list[float]] = []
    ys: list[float] = []
    for ts in sorted(by_slot):
        if ts - timedelta(days=1) not in by_slot:
            continue
        xs.append(load_feature_row(ts, by_slot, temperature_at))
        ys.append(by_slot[ts])
    return xs, ys


# ---- PV residual features -------------------------------------------------------

def pv_residual_feature_row(
    ts: datetime,
    physical_kw: float,
    weather: WeatherHistory | None,
) -> list[float]:
    """One feature vector (order = :data:`PV_RESIDUAL_FEATURES`) for slot ``ts``."""
    ts = floor_to_slot(ts, SLOT_MINUTES)
    slot_of_day, _, _, _ = _calendar(ts)
    point = weather.at(ts) if weather is not None else None
    ghi = NAN if point is None or point.ghi_w_m2 is None else float(point.ghi_w_m2)
    cloud = (
        NAN
        if point is None or point.cloud_cover_pct is None
        else float(point.cloud_cover_pct)
    )
    temp = (
        NAN
        if point is None or point.temperature_c is None
        else float(point.temperature_c)
    )
    return [physical_kw, slot_of_day, ghi, cloud, temp]


def is_nan(value: float) -> bool:
    return isinstance(value, float) and math.isnan(value)
