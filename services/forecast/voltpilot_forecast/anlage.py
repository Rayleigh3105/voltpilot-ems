"""Site values of a multi-box site, read through the api's one rule (AP-15 W2, B1).

A site with a DETERMINED leading box (``site.lead_device_id`` claimed on this
site and not removed, and at least one further box likewise) has several boxes
sending telemetry. Their rows must not be averaged: the grid meter belongs to
the leading box, the site's PV is the SUM of the boxes, the site's load is the
leading box's load plus every other box's net output. That rule lives ONCE, in
the database (``V20260922170000``): ``telemetry_fuehrende_box(site)`` decides
whether a site has such a box, ``telemetry_anlage_15m(from, to, site)`` returns
the site's quarter-hour energies - the very rows the rollup procedure, the
api's day view and a purge rebuild write or read. The optimizer's twin
(``voltpilot_optimization.inputs._anlagen_slot_werte``) is not importable here
(the optimizer depends on this package, not the other way round).

Every other site keeps its raw query of before, byte for byte; the callers
branch on :func:`fuehrende_box`.
"""

from __future__ import annotations

from datetime import datetime

from voltpilot_forecast.domain import ensure_utc

# Quarter-hour energy (kWh) back to mean power (kW). Fixed set, never user input.
_KW_AUS_KWH = {
    "load_kw": "load_kwh * 4",
    "pv_power_kw": "pv_kwh * 4",
    # Mean of power_kw at the leading box = mean import - mean export there.
    "power_kw": "(grid_import_kwh - grid_export_kwh) * 4",
}


def fuehrende_box(cur, site_id: str) -> str | None:
    """The determined leading box of a multi-box site, else ``None``."""
    cur.execute("SELECT telemetry_fuehrende_box(%s)", (site_id,))
    row = cur.fetchone()
    return None if row is None or row[0] is None else str(row[0])


def anlage_slot_kw(
    cur, site_id: str, column: str, start: datetime, end: datetime | None
) -> list[tuple[datetime, float]]:
    """The site's quarter-hour mean power of ``column``, oldest first.

    Raw rows with ``start <= time < end`` (``end`` ``None`` = open); a slot
    whose site value is unknown (e.g. the leading box did not send) is absent.
    """
    if column not in _KW_AUS_KWH:
        raise ValueError(f"unsupported telemetry column: {column}")
    expr = _KW_AUS_KWH[column]
    cur.execute(
        f"""
        SELECT bucket, {expr} FROM telemetry_anlage_15m(%s, %s, %s)
        WHERE {expr} IS NOT NULL
        ORDER BY bucket
        """,
        (start, end, site_id),
    )
    return [(ensure_utc(ts), float(v)) for ts, v in cur.fetchall()]
