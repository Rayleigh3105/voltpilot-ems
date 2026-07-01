"""Internal, provider-agnostic price representation.

This is the *core domain* type the optimizer consumes. It intentionally carries
no ENTSO-E (or any vendor) vocabulary: the ENTSO-E adapter translates the
Publication_MarketDocument into these types, and a future commercial adapter
would translate its own format into the same types. Keeping this boundary clean
is the whole point of the anti-corruption layer (architecture section 13).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

# ISO-8601 duration codes used across the module for slot resolution.
RESOLUTION_PT15M = "PT15M"
RESOLUTION_PT60M = "PT60M"

# How many minutes each resolution code represents.
_RESOLUTION_MINUTES = {
    RESOLUTION_PT15M: 15,
    RESOLUTION_PT60M: 60,
}


def resolution_minutes(resolution: str) -> int:
    """Minutes per slot for an ISO-8601 duration code we support."""
    try:
        return _RESOLUTION_MINUTES[resolution]
    except KeyError as exc:  # pragma: no cover - guarded by callers
        raise ValueError(f"unsupported resolution: {resolution!r}") from exc


@dataclass(frozen=True)
class PricePoint:
    """A single spot price valid over the half-open slot ``[start, end)``.

    Prices are stored in EUR/MWh (ENTSO-E's native unit). ``start``/``end`` are
    always timezone-aware and normalised to UTC.
    """

    start: datetime
    end: datetime
    price_eur_mwh: float

    def __post_init__(self) -> None:
        if self.start.tzinfo is None or self.end.tzinfo is None:
            raise ValueError("PricePoint timestamps must be timezone-aware")
        if self.end <= self.start:
            raise ValueError("PricePoint end must be after start")


@dataclass(frozen=True)
class PriceSeries:
    """An ordered day-ahead price series for one bidding zone.

    ``points`` are contiguous, sorted by ``start``, all at ``resolution``.
    """

    zone: str
    resolution: str
    currency: str
    points: tuple[PricePoint, ...]
    source: str = "entsoe"
    fetched_at: datetime | None = field(default=None)

    def __post_init__(self) -> None:
        # Validate ordering/contiguity defensively; a malformed series would
        # silently corrupt the optimizer's cost vector otherwise.
        prev: PricePoint | None = None
        for point in self.points:
            if prev is not None and point.start < prev.start:
                raise ValueError("PriceSeries points must be sorted by start")
            prev = point

    @property
    def start(self) -> datetime | None:
        return self.points[0].start if self.points else None

    @property
    def end(self) -> datetime | None:
        return self.points[-1].end if self.points else None

    def __len__(self) -> int:
        return len(self.points)

    def prices(self) -> list[float]:
        """The bare EUR/MWh vector, in slot order - the optimizer's input."""
        return [p.price_eur_mwh for p in self.points]

    def at(self, moment: datetime) -> float | None:
        """Price valid at ``moment`` (UTC), or ``None`` if outside the series."""
        moment = moment.astimezone(timezone.utc)
        for point in self.points:
            if point.start <= moment < point.end:
                return point.price_eur_mwh
        return None
