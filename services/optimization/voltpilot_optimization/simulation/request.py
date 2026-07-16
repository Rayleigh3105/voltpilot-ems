"""Parse + validate the simulation job request (the api's JSON payload).

The Java api resolves ALL master data (site tariff, battery asset,
Speicherschonung preset -> ct value, coordinates) into explicit values before
calling this service, so the request is self-contained - the sim service
knows neither tenants nor tokens. Field names are the api's camelCase JSON
(design report §6); internally everything is snake_case dataclasses.

Validation failures raise :class:`InvalidRequest` with a CUSTOMER-facing
German message (the api relays it as a 400 body).
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, field
from datetime import date, datetime, timezone

from voltpilot_optimization.domain import BatteryParams
from voltpilot_optimization.pricing import SiteTariff

DEFAULT_ZONE = "DE-LU"
DEFAULT_PROFILE = "haushalt"

# Default sweep: fractions of the base capacity (0 dropped), so the marginal
# value curve is meaningful for a 5-kWh household AND a 65-kWh Gewerbe plant.
DEFAULT_SWEEP_FACTORS = (0.5, 1.0, 1.5, 2.0)

MAX_SWEEP_SIZES = 6
MAX_CAPACITY_KWH = 2000.0
MAX_PV_KWP = 5000.0
MAX_ANNUAL_KWH = 10_000_000.0


class InvalidRequest(ValueError):
    """Request rejected; the message is customer-facing German."""


@dataclass(frozen=True)
class SimulationRequest:
    year: int
    zone: str
    pv_kwp: float
    latitude: float
    longitude: float
    azimuth_deg: float
    tilt_deg: float
    annual_kwh: float
    profile: str
    tariff: SiteTariff
    netzladen_erlaubt: bool
    battery: BatteryParams
    size_sweep_kwh: tuple[float, ...] = field(default=())

    def cache_key(self) -> str:
        """SHA-256 over the normalized inputs (design report §3): identical
        requests - the repeated sales demo - hit the cache instantly."""
        doc = {
            "year": self.year,
            "zone": self.zone,
            "pv_kwp": round(self.pv_kwp, 3),
            "lat": round(self.latitude, 4),
            "lon": round(self.longitude, 4),
            "azimuth": round(self.azimuth_deg, 1),
            "tilt": round(self.tilt_deg, 1),
            "annual_kwh": round(self.annual_kwh, 1),
            "profile": self.profile,
            "tariff": [
                self.tariff.plant_kind,
                self.tariff.tarif_art,
                self.tariff.tarif_param_ct_kwh,
                self.tariff.anzulegender_wert_ct_kwh,
                self.tariff.commissioned_on.isoformat()
                if self.tariff.commissioned_on
                else None,
                self.tariff.pv_capacity_kwp,
            ],
            "netzladen": self.netzladen_erlaubt,
            "battery": [
                self.battery.capacity_kwh,
                self.battery.max_charge_kw,
                self.battery.max_discharge_kw,
                self.battery.roundtrip_efficiency,
                self.battery.soc_min_fraction,
                self.battery.soc_max_fraction,
                self.battery.wear_cost_ct_per_kwh,
                self.battery.backup_reserve_pct,
            ],
            "sweep": list(self.size_sweep_kwh),
        }
        return hashlib.sha256(
            json.dumps(doc, sort_keys=True).encode("utf-8")
        ).hexdigest()


def default_year(today: date | None = None) -> int:
    """The last FULL calendar year (captain decision: clearly communicable)."""
    today = today or datetime.now(timezone.utc).date()
    return today.year - 1


def parse_request(doc: dict) -> SimulationRequest:
    """Validate the api's JSON into a :class:`SimulationRequest`."""
    if not isinstance(doc, dict):
        raise InvalidRequest("Ungültige Anfrage: JSON-Objekt erwartet.")
    year = doc.get("year") or default_year()
    if not isinstance(year, int) or not 2015 <= year <= default_year():
        raise InvalidRequest(
            f"Ungültiges Simulationsjahr - erlaubt sind 2015 bis {default_year()} "
            "(nur abgeschlossene Kalenderjahre)."
        )
    zone = str(doc.get("zone") or DEFAULT_ZONE)

    plant = doc.get("plant") or {}
    pv_kwp = _number(plant, "pvKwp", "PV-Leistung (kWp)", 0.0, MAX_PV_KWP)
    latitude = _number(plant, "latitude", "Breitengrad", -90.0, 90.0)
    longitude = _number(plant, "longitude", "Längengrad", -180.0, 180.0)
    azimuth = _number(plant, "azimuthDeg", "Ausrichtung", 0.0, 359.99, default=180.0)
    tilt = _number(plant, "tiltDeg", "Neigung", 0.0, 90.0, default=30.0)

    consumption = doc.get("consumption") or {}
    annual_kwh = _number(
        consumption, "annualKwh", "Jahresverbrauch (kWh)", 1.0, MAX_ANNUAL_KWH
    )
    profile = str(consumption.get("profile") or DEFAULT_PROFILE)

    tariff_doc = doc.get("tariff") or {}
    commissioned_on = None
    raw_commissioned = tariff_doc.get("commissionedOn")
    if raw_commissioned:
        try:
            commissioned_on = date.fromisoformat(str(raw_commissioned))
        except ValueError as exc:
            raise InvalidRequest(
                "Ungültiges Inbetriebnahmedatum (erwartet JJJJ-MM-TT)."
            ) from exc
    tariff = SiteTariff(
        plant_kind=str(tariff_doc.get("plantKind") or "eigenverbrauch"),
        tarif_art=str(tariff_doc.get("tarifArt") or "ohne"),
        tarif_param_ct_kwh=_optional_number(
            tariff_doc, "tarifParamCtKwh", "Tarif-Parameter (ct/kWh)", 0.0, 500.0
        ),
        anzulegender_wert_ct_kwh=_optional_number(
            tariff_doc, "anzulegenderWertCtKwh", "Anzulegender Wert (ct/kWh)", 0.0, 100.0
        ),
        commissioned_on=commissioned_on,
        pv_capacity_kwp=pv_kwp if pv_kwp > 0 else None,
    )
    netzladen = bool(tariff_doc.get("netzladenErlaubt") or False)

    battery_doc = doc.get("battery") or {}
    capacity = _number(
        battery_doc, "capacityKwh", "Speicherkapazität (kWh)", 0.1, MAX_CAPACITY_KWH
    )
    battery = _battery(battery_doc, capacity)

    raw_sweep = doc.get("sizeSweep")
    if raw_sweep is None:
        sweep = tuple(
            round(capacity * f, 1) for f in DEFAULT_SWEEP_FACTORS
        )
    elif isinstance(raw_sweep, list):
        try:
            sweep = tuple(float(v) for v in raw_sweep)
        except (TypeError, ValueError) as exc:
            raise InvalidRequest("Ungültige Speichergrößen-Liste.") from exc
        if len(sweep) > MAX_SWEEP_SIZES:
            raise InvalidRequest(
                f"Höchstens {MAX_SWEEP_SIZES} Speichergrößen je Simulation."
            )
        for v in sweep:
            if not (math.isfinite(v) and 0.1 <= v <= MAX_CAPACITY_KWH):
                raise InvalidRequest(
                    "Speichergrößen müssen zwischen 0,1 und 2000 kWh liegen."
                )
    else:
        raise InvalidRequest("Ungültige Speichergrößen-Liste.")
    # The base size is always part of the sweep curve; dedupe, ascending.
    sweep = tuple(sorted({round(v, 1) for v in (*sweep, round(capacity, 1))}))

    return SimulationRequest(
        year=year,
        zone=zone,
        pv_kwp=pv_kwp,
        latitude=latitude,
        longitude=longitude,
        azimuth_deg=azimuth,
        tilt_deg=tilt,
        annual_kwh=annual_kwh,
        profile=profile,
        tariff=tariff,
        netzladen_erlaubt=netzladen,
        battery=battery,
        size_sweep_kwh=sweep,
    )


def battery_for_size(base: BatteryParams, capacity_kwh: float) -> BatteryParams:
    """A sweep candidate: same chemistry/limits profile as the base battery,
    scaled to ``capacity_kwh`` with C/2 power (the design report's recipe) -
    unless the size IS the base capacity, which keeps the real asset's power."""
    if abs(capacity_kwh - base.capacity_kwh) < 1e-9:
        return base
    power = round(capacity_kwh / 2.0, 3)
    return BatteryParams(
        capacity_kwh=capacity_kwh,
        max_charge_kw=power,
        max_discharge_kw=power,
        roundtrip_efficiency=base.roundtrip_efficiency,
        soc_min_fraction=base.soc_min_fraction,
        soc_max_fraction=base.soc_max_fraction,
        wear_cost_ct_per_kwh=base.wear_cost_ct_per_kwh,
        backup_reserve_pct=base.backup_reserve_pct,
    )


def _battery(doc: dict, capacity: float) -> BatteryParams:
    max_charge = _number(
        doc, "maxChargeKw", "Ladeleistung (kW)", 0.1, 2000.0,
        default=round(capacity / 2.0, 3),
    )
    max_discharge = _number(
        doc, "maxDischargeKw", "Entladeleistung (kW)", 0.1, 2000.0,
        default=round(capacity / 2.0, 3),
    )
    efficiency_pct = _number(
        doc, "roundtripEfficiencyPct", "Wirkungsgrad (%)", 50.0, 100.0, default=92.0
    )
    wear_ct = _number(
        doc, "wearCostCtPerKwh", "Verschleißkosten (ct/kWh)", 0.0, 100.0, default=4.0
    )
    soc_min = _number(doc, "socMinPct", "SoC-Minimum (%)", 0.0, 99.0, default=5.0)
    soc_max = _number(doc, "socMaxPct", "SoC-Maximum (%)", 1.0, 100.0, default=95.0)
    if soc_min >= soc_max:
        raise InvalidRequest("Das SoC-Band ist ungültig (Minimum >= Maximum).")
    reserve = _optional_number(
        doc, "backupReserveSocPct", "Notstrom-Reserve (%)", 0.0, 100.0
    )
    try:
        return BatteryParams(
            capacity_kwh=capacity,
            max_charge_kw=max_charge,
            max_discharge_kw=max_discharge,
            roundtrip_efficiency=efficiency_pct / 100.0,
            soc_min_fraction=soc_min / 100.0,
            soc_max_fraction=soc_max / 100.0,
            wear_cost_ct_per_kwh=wear_ct,
            backup_reserve_pct=reserve,
        )
    except ValueError as exc:
        raise InvalidRequest(f"Ungültige Speicherdaten: {exc}") from exc


def _number(
    doc: dict,
    key: str,
    label: str,
    lo: float,
    hi: float,
    default: float | None = None,
) -> float:
    value = doc.get(key)
    if value is None:
        if default is not None:
            return default
        raise InvalidRequest(f"Bitte {label} angeben.")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise InvalidRequest(f"Ungültiger Wert für {label}.") from exc
    if not (math.isfinite(number) and lo <= number <= hi):
        raise InvalidRequest(
            f"{label} muss zwischen {lo:g} und {hi:g} liegen."
        )
    return number


def _optional_number(
    doc: dict, key: str, label: str, lo: float, hi: float
) -> float | None:
    if doc.get(key) is None:
        return None
    return _number(doc, key, label, lo, hi)
