"""Core forecast domain types (framework-free, dependency-free).

These value objects are the vocabulary shared by every forecast method and every
consumer (the optimizer). They are deliberately plain dataclasses so the load and
PV methods, the weather adapter and the persistence layer all speak the same
language without coupling to a framework.

Conventions:
- All timestamps are timezone-aware UTC ``datetime`` objects.
- Power is expressed in kW; a forecast slot's value is the mean power over the
  slot (architecture section 11 works in 15-min slots).
- ``kind`` distinguishes the two v1 forecasts named in architecture section 12:
  ``load`` (baseline persistence/profile) and ``pv`` (physical model).
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum


class ForecastKind(str, Enum):
    """The forecast quantities produced in v1 (architecture section 12)."""

    LOAD = "load"
    PV = "pv"


@dataclass(frozen=True)
class Horizon:
    """Optimization horizon as a grid of equal slots.

    Architecture section 11: the MILP/MPC runs on a rolling 24-48h horizon in
    15-min slots. ``slot_minutes`` defaults to 15; ``slots`` is how many future
    slots to forecast (96 = 24h, 192 = 48h).
    """

    slots: int
    slot_minutes: int = 15

    def __post_init__(self) -> None:
        if self.slots <= 0:
            raise ValueError("slots must be positive")
        if self.slot_minutes <= 0:
            raise ValueError("slot_minutes must be positive")

    @property
    def slot_delta(self) -> timedelta:
        return timedelta(minutes=self.slot_minutes)

    @property
    def duration(self) -> timedelta:
        return self.slot_delta * self.slots

    @classmethod
    def hours(cls, hours: float, slot_minutes: int = 15) -> "Horizon":
        """Build a horizon spanning ``hours`` at ``slot_minutes`` resolution."""
        total = round(hours * 60 / slot_minutes)
        return cls(slots=total, slot_minutes=slot_minutes)

    def slot_starts(self, run_at: datetime) -> list[datetime]:
        """Return the slot-start timestamps, aligned to the slot grid.

        ``run_at`` is floored to the slot boundary; the first forecast slot is the
        next boundary strictly after ``run_at`` (we forecast the future, not the
        slot already in progress).
        """
        base = floor_to_slot(run_at, self.slot_minutes)
        first = base + self.slot_delta
        return [first + i * self.slot_delta for i in range(self.slots)]


@dataclass(frozen=True)
class GeoLocation:
    """WGS84 site location used by the physical PV / solar-geometry model."""

    latitude: float
    longitude: float

    def __post_init__(self) -> None:
        if not -90.0 <= self.latitude <= 90.0:
            raise ValueError("latitude must be within [-90, 90]")
        if not -180.0 <= self.longitude <= 180.0:
            raise ValueError("longitude must be within [-180, 180]")


@dataclass(frozen=True)
class PlantSpec:
    """PV plant parameters for the physical model (architecture section 12).

    Orientation/tilt are optional in the field but carry sensible DACH defaults
    (south-facing, 30° tilt) so a minimally-configured site still forecasts.
    ``system_loss_fraction`` lumps inverter/wiring/soiling/temperature losses in
    a single PVWatts-style derate; ``albedo`` drives ground-reflected irradiance.
    """

    capacity_kwp: float
    tilt_deg: float = 30.0
    azimuth_deg: float = 180.0  # clockwise from North; 180 = due South
    system_loss_fraction: float = 0.14
    albedo: float = 0.20

    def __post_init__(self) -> None:
        if self.capacity_kwp < 0:
            raise ValueError("capacity_kwp must be non-negative")
        if not 0.0 <= self.tilt_deg <= 90.0:
            raise ValueError("tilt_deg must be within [0, 90]")
        if not 0.0 <= self.azimuth_deg < 360.0:
            raise ValueError("azimuth_deg must be within [0, 360)")
        if not 0.0 <= self.system_loss_fraction < 1.0:
            raise ValueError("system_loss_fraction must be within [0, 1)")
        if not 0.0 <= self.albedo <= 1.0:
            raise ValueError("albedo must be within [0, 1]")


@dataclass(frozen=True)
class SiteForecastConfig:
    """Everything the forecast service needs to forecast one site.

    ``plant`` is ``None`` for a site without PV; PV forecasting then yields an
    all-zero series. ``tenant_id``/``site_id`` are opaque strings here (UUIDs in
    the DB) so this library stays free of the persistence layer's types.
    """

    tenant_id: str
    site_id: str
    location: GeoLocation
    plant: PlantSpec | None = None


@dataclass(frozen=True)
class Observation:
    """A single historical load/PV measurement (input to the load baseline)."""

    timestamp: datetime
    value_kw: float


@dataclass(frozen=True)
class ForecastPoint:
    """A single forecasted slot: mean power ``value_kw`` starting at ``timestamp``."""

    timestamp: datetime
    value_kw: float


@dataclass(frozen=True)
class ForecastSeries:
    """An ordered forecast over the horizon, tagged with provenance.

    ``model`` is the registry-level model id (see
    :mod:`voltpilot_forecast.registry`) every persisted prediction is tagged
    with - the traceability key the optimizer filters on and the daily
    evaluation compares by. ``method`` stays as the finer-grained
    implementation detail (e.g. ``persistence``, ``clear_sky_v1:open_meteo``).
    ``run_at`` is the issue time; every point carries a positive lead time
    relative to it.
    """

    kind: ForecastKind
    site_id: str
    tenant_id: str
    run_at: datetime
    method: str
    points: list[ForecastPoint] = field(default_factory=list)
    schema_version: int = 1
    model: str = ""

    def __post_init__(self) -> None:
        # Untagged series default to the kind's baseline id so nothing ever
        # lands in storage without a model tag (the column is NOT NULL). The
        # literals mirror registry.BASELINE_MODELS (registry imports domain,
        # so domain cannot import registry back).
        if not self.model:
            fallback = (
                "load-persistence" if self.kind is ForecastKind.LOAD else "pv-physical"
            )
            object.__setattr__(self, "model", fallback)

    @property
    def values(self) -> list[float]:
        return [p.value_kw for p in self.points]

    def __len__(self) -> int:
        return len(self.points)


def floor_to_slot(dt: datetime, slot_minutes: int) -> datetime:
    """Floor ``dt`` down to the nearest ``slot_minutes`` boundary (UTC-safe)."""
    dt = ensure_utc(dt)
    discard = timedelta(
        minutes=dt.minute % slot_minutes,
        seconds=dt.second,
        microseconds=dt.microsecond,
    )
    return dt - discard


def slot_means(
    history: Iterable["Observation"], slot_minutes: int
) -> dict[datetime, float]:
    """Mean value per slot from raw telemetry samples (keyed by UTC slot start).

    THE aggregation every model must see history through. A forecast slot's value
    is the MEAN POWER over the slot (module docstring above) - the same quantity
    the optimizer plans with - but telemetry arrives at a ~5-10 s cadence, i.e.
    ~90-180 samples per quarter hour. Keeping any single one of them (the last,
    say) makes a quarter-hour forecast a random draw from within the slot: on the
    Pilsting plant that sampling error alone measured 1.14 kW mean absolute,
    2.26 kW peak (scout report vp-netzbezug-nacht-s3 section 3, link 3), before
    any day-to-day deviation is even involved.

    Samples are weighted equally. That is exact for the regular telemetry cadence
    and honest for an irregular one (no interpolation is invented over gaps).
    """
    sums: dict[datetime, float] = {}
    counts: dict[datetime, int] = {}
    for obs in history:
        key = floor_to_slot(obs.timestamp, slot_minutes)
        sums[key] = sums.get(key, 0.0) + obs.value_kw
        counts[key] = counts.get(key, 0) + 1
    return {ts: sums[ts] / counts[ts] for ts in sums}


def ensure_utc(dt: datetime) -> datetime:
    """Return ``dt`` as timezone-aware UTC.

    Naive datetimes are assumed to already be UTC (the storage/transport
    convention across the platform) rather than local time, which would be
    ambiguous across the DACH DST boundary.
    """
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)
