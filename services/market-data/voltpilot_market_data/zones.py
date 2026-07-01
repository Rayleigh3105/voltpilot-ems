"""Bidding-zone -> ENTSO-E EIC area code mapping.

ENTSO-E addresses markets by 16-character EIC codes, not by the human-readable
Gebotszone names Voltpilot uses (``site.bidding_zone`` in the DB defaults to
``DE-LU``). This table is the *only* place ENTSO-E's addressing leaks in; adding
AT/CH (architecture section 3: "DE zuerst, AT/CH-fähig") is a one-line edit here
and needs no change to callers or the adapter logic.
"""

from __future__ import annotations

# Voltpilot bidding-zone id -> ENTSO-E EIC area code.
# DE-LU is the joint German-Luxembourg day-ahead zone (the MVP target).
ZONE_TO_EIC: dict[str, str] = {
    "DE-LU": "10Y1001A1001A82H",
    "AT": "10YAT-APG------L",
    "CH": "10YCH-SWISSGRIDZ",
}

# Reverse lookup so a parsed document's domain code can be traced back to a zone.
EIC_TO_ZONE: dict[str, str] = {eic: zone for zone, eic in ZONE_TO_EIC.items()}


def eic_for_zone(zone: str) -> str:
    """EIC area code for a Voltpilot bidding zone, or raise ``KeyError``-like."""
    try:
        return ZONE_TO_EIC[zone]
    except KeyError as exc:
        supported = ", ".join(sorted(ZONE_TO_EIC))
        raise ValueError(
            f"unknown bidding zone {zone!r}; supported: {supported}"
        ) from exc
