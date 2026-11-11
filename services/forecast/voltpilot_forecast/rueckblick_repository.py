"""Persistence for the S3 "Rückblick" table (am Vortag erwartet vs. gemessen).

Owned by the api Flyway migration ``V20261111150000`` - the same pattern as
``forecast_accuracy``/``plan_accuracy`` (:mod:`voltpilot_forecast.quality_repository`):
RLS-scoped by tenant, the collector writes as the trusted backend role and
stamps ``tenant_id``, the portal reads through the RLS-scoped app role.

One row is one (site, Berlin day, kind, model, lead_days): the evening-run
(17:45 ± 15 min of the day before) forecast for that day, summed to kWh and
compared against the measured kWh - plus the same day's mean absolute error
in kW (``mae_kw``), the quantity S5's automatic switcher compares (Bericht
R.4: "mittlerer Fehler je Viertelstunde"). ``lead_days`` is carried for every
model of a site, not only the active one, because S5 decides from it; only
``lead_days = 1`` (der Vortagsvergleich) is populated today - the weekly
Ausblick's accuracy (lead 2-6) is a documented, bounded future extension
(S4 already measures it is possible; nothing in S3/S5 needs it yet).
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import date

from voltpilot_forecast.kundenbereich import lebenden_bereich_sperren

logger = logging.getLogger(__name__)

#: Der Vortagsvergleich (Bericht R.4 Punkt 1) - der einzige heute gefüllte Vorlauf.
LEAD_DAYS_VORTAG = 1


@dataclass(frozen=True)
class RueckblickRecord:
    """One row of ``forecast_rueckblick``."""

    day: date
    tenant_id: str
    site_id: str
    kind: str  # 'load' | 'pv'
    model: str
    lead_days: int
    erwartet_kwh: float
    gemessen_kwh: float
    mae_kw: float
    n_slots: int


class RueckblickRepository(ABC):
    """Write seam for the daily Rückblick rows."""

    @abstractmethod
    def upsert(self, record: RueckblickRecord) -> None: ...


class InMemoryRueckblickRepository(RueckblickRepository):
    """Offline reference implementation (keyed exactly like the table PK)."""

    def __init__(self) -> None:
        self.rows: dict[tuple[str, str, str, date, int], RueckblickRecord] = {}

    def upsert(self, record: RueckblickRecord) -> None:
        key = (record.site_id, record.kind, record.model, record.day, record.lead_days)
        self.rows[key] = record


_UPSERT_SQL = """
INSERT INTO forecast_rueckblick (
    day, tenant_id, site_id, kind, model, lead_days,
    erwartet_kwh, gemessen_kwh, mae_kw, n_slots, computed_at
) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
ON CONFLICT (site_id, kind, model, day, lead_days) DO UPDATE SET
    tenant_id = EXCLUDED.tenant_id,
    erwartet_kwh = EXCLUDED.erwartet_kwh,
    gemessen_kwh = EXCLUDED.gemessen_kwh,
    mae_kw = EXCLUDED.mae_kw,
    n_slots = EXCLUDED.n_slots,
    computed_at = now()
"""


class TimescaleRueckblickRepository(RueckblickRepository):
    """psycopg-backed writer (``connection`` lifecycle owned by the caller)."""

    def __init__(self, connection) -> None:  # noqa: ANN001 - psycopg optional
        self._conn = connection

    def upsert(self, record: RueckblickRecord) -> None:
        with self._conn.cursor() as cur:
            if lebenden_bereich_sperren(cur, record.tenant_id):
                cur.execute(
                    _UPSERT_SQL,
                    (
                        record.day,
                        record.tenant_id,
                        record.site_id,
                        record.kind,
                        record.model,
                        record.lead_days,
                        record.erwartet_kwh,
                        record.gemessen_kwh,
                        record.mae_kw,
                        record.n_slots,
                    ),
                )
            else:
                logger.info("rueckblick.bereich_ausgelassen site=%s", record.site_id)
        self._conn.commit()
