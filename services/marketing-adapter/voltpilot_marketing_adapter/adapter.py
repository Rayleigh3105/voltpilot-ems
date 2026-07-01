"""Generic Direktvermarktung adapter port (stub).

Defines the provider-agnostic interface the optimization engine talks to when
submitting a marketing schedule. Concrete, certified provider adapters will
implement :class:`MarketingAdapter`; the MVP ships only the echo stub below to
demonstrate the mechanics (architecture section 4/13).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass(frozen=True)
class MarketingSchedule:
    """A schedule offered to a direct marketer for a site."""

    site_id: str
    slots_kw: list[float]


@dataclass(frozen=True)
class SubmitResult:
    accepted: bool
    reference: str


class MarketingAdapter(ABC):
    """Provider-agnostic port for submitting marketing schedules."""

    @abstractmethod
    def submit(self, schedule: MarketingSchedule) -> SubmitResult:
        ...


class StubMarketingAdapter(MarketingAdapter):
    """MVP stub: accepts any schedule and echoes a deterministic reference."""

    def submit(self, schedule: MarketingSchedule) -> SubmitResult:
        reference = f"stub-{schedule.site_id}-{len(schedule.slots_kw)}"
        return SubmitResult(accepted=True, reference=reference)
