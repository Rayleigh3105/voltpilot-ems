"""„Sonne + Speicher" (06.10.2026): wie tief der Hausspeicher für ein Auto
entladen werden darf, ohne dass das Haus bis zur nächsten Erzeugung Netzstrom
braucht.

Der Wunsch des Kapitäns, wörtlich: „wenn ein auto angesteckt ist [soll] nur so
viel im speicher verbleiben ... bis zur nächsten erzeugung." Dieses Modul
rechnet die UNTERGRENZE dafür, je Viertelstunde des Fahrplans. Die Box gibt
einem Ladepunkt auf „Sonne + Speicher" nur die Energie OBERHALB davon frei
(``edge-app/core/internal/lastmgmt``) und fällt ohne frische Untergrenze auf
„Nur Sonne" zurück.

**Die Rechnung** (:func:`required_energy_kwh`) ist eine Rückwärtsrechnung über
den Horizont des Fahrplans, in gespeicherten kWh::

    E(n)  = E_lo                                   (Horizontende)
    Defizit-Slot  (Last' > PV'):  E(t) = E(t+1) + min(Last'−PV', P_ent)·dt / eta
    Überschuss-Slot (PV' ≥ Last'): E(t) = E(t+1) − min(PV'−Last', P_lad)·dt · eta
    E(t)  = max(E_lo, E(t));  E(t) > E_hi  ->  E(t) = E_hi, „gekappt"

``E_lo`` ist der Reservestapel des Speichers (technisch, Notstrom, Spitze)
PLUS die Reserve dieser Anlage; ``E_hi`` der nutzbare Höchststand.

**Der Horizont reicht bis zur nächsten Erzeugung - auch über den Fahrplan
hinaus.** Der Fahrplan endet, wo die Börsenpreise enden: vor der
Day-Ahead-Veröffentlichung (gegen 13 Uhr) also um Mitternacht. Um 12:00 sähe
die Rechnung dann nur den Abend bis 24:00 und nicht die Nacht danach - genau
das Beispiel des Kapitäns gäbe zu viel frei. Deshalb läuft die Rückwärtsrechnung
über die gespeicherte Last- und PV-Prognose WEITER (:func:`forecast_tail`, die
frischen Läufe des aktiven Modells, höchstens 48 h ab Planbeginn); in diesen
Viertelstunden gibt es keinen Handel. Reicht auch die Prognose nicht über die
nächste Nacht bis zur ersten Viertelstunde, in der die vorsichtige Sonne die
vorsichtige Last wieder deckt (:func:`reaches_next_generation`), gibt es keine
Freigabe (Grund ``prognose_zu_kurz``). Ein trüber Folgetag, an dem die vorsichtige Sonne die Last nie deckt,
muss als GANZER Tag in der Reihe liegen; die Rechnung trägt dann seinen ganzen
Bedarf, und die Untergrenze steigt entsprechend (oder es gibt
``nachtbedarf_ueber_kapazitaet``).

Warum genau so (die Tests in ``tests/test_storage_release.py`` belegen jede
Zeile):

- **Die Begrenzung nach UNTEN (``max(E_lo, …)``) ist die Kausalität**, nicht
  der volle Speicher: ein späterer Überschuss kann kein FRÜHERES Defizit
  bezahlen. Ohne sie verrechnete die Rückwärtsrechnung den Nachmittag gegen
  einen bewölkten Vormittag, den der Speicher schon tragen musste.
- **Der volle Speicher steckt in der Kappung nach OBEN**: mehr als ``E_hi``
  kann ein Speicher nicht halten. Ist ``E(t) > E_hi``, ist Netzbezug in der
  Zukunft ohnehin unvermeidlich; die Rechnung verlangt dann „voll bei t" und
  rechnet von dort weiter. Damit gilt die Zusage, die das Modul macht, auch für
  einen kleinen Speicher: eine Freigabe oberhalb von ``E(jetzt)`` erhöht den
  prognostizierten Netzbezug NIE - sie nimmt nur Energie, die der Nachmittag
  ohnehin wieder bringt. Ist schon ``E(jetzt)`` gekappt, gibt es keine Freigabe.
- **Monoton**: wer mit mehr als ``E(t)`` startet, ist nie schlechter dran. Die
  Box darf deshalb jeden gemessenen Ladestand über der Untergrenze freigeben.
- **Leistungsgrenzen**: ein Defizit über ``P_ent`` kommt ohnehin aus dem Netz
  (der Speicher kann es nicht liefern), ein Überschuss über ``P_lad`` kann nicht
  eingelagert werden. Beides zählt deshalb nicht.

**Vorsichtig** (Wunsch des Kapitäns, Punkt 2): Last' ist die Lastprognose mal
``1 + Aufschlag``, PV' die PV-Prognose mal ``1 − Abschlag``.

- Der Aufschlag ist das 0,9-Quantil des GEMESSENEN relativen Nachtfehlers
  dieser Anlage (:func:`voltpilot_optimization.night_reserve.night_error_quantiles`,
  dieselbe Verteilung, die der Fahrplan für seine Nacht-Wertfunktion nutzt).
- Der Abschlag ist das 0,1-Quantil des GEMESSENEN relativen Tagesfehlers der
  PV-Prognose (:func:`pv_day_error_quantiles`, dieselbe Methode für den Tag).
- Fehlt eine Verteilung (unter sieben vollständigen Nächten/Tagen), gilt eine
  dokumentierte VORGABE: Last +25 % (die größte belegte Nachtabweichung der
  Plattform, Pilsting 04./05.09.2026: +24 %), PV −30 %. Sie ist ausdrücklich
  vorsichtiger als eine typische gemessene Verteilung.
- Dazu die Reserve dieser Anlage, Vorgabe :data:`DEFAULT_RESERVE_KWH`.

**Der Fahrplan gewinnt beim Handel** (:func:`release_slot`): eine Viertelstunde,
in der der Plan Netzstrom bezieht (günstige Stunde, Netzladen, PV-Bus-Laden
mit parallelem Bezug) oder Speicherenergie verkauft, bekommt KEINE
Untergrenze - dort gibt es keine Freigabe. Ein geplanter Verkauf zählt
außerdem als Entnahme in der Rückwärtsrechnung, damit kein Auto die Energie
leert, die der Plan später verkaufen will. In Eigenverbrauchs-Viertelstunden
(Überschuss laden, Haus decken, ruhen) gewinnt die Kundenwahl.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from uuid import UUID

from voltpilot_optimization.domain import (
    SOC_SOURCE_UNBEKANNT,
    SchedulePlan,
)
from voltpilot_optimization.night_reserve import (
    BERLIN,
    RUN_HOUR,
    RUN_MINUTE,
    RUN_TOLERANCE,
    NightErrorQuantiles,
    quantile,
)

logger = logging.getLogger("voltpilot.optimization.storage_release")

#: Die Reserve über dem Reservestapel, wenn die Anlage keine eigene hinterlegt
#: hat [kWh]. Ein kleiner Puffer ZUSÄTZLICH zur vorsichtigen Prognose: er
#: deckt, was die Viertelstunden-Rechnung nicht sieht - einen späteren
#: Sonnenaufgang als prognostiziert, den Ladestand-Schritt zwischen zwei
#: Fahrplänen (bis 15 min Auto an einem Speicher kurz über der Grenze) und die
#: Unschärfe des gemessenen Ladestands. 1 kWh trägt die übliche Nacht-Grundlast
#: eines Hauses (0,3-0,5 kW) zwei bis drei Stunden.
DEFAULT_RESERVE_KWH = 1.0

#: Größte erlaubte Reserve je Anlage [kWh] - dieselbe Grenze prüft die api.
MAX_RESERVE_KWH = 100.0

#: Quantile der gemessenen Fehlerverteilungen: in 9 von 10 Nächten brauchte das
#: Haus höchstens so viel mehr, in 9 von 10 Tagen kam höchstens so viel weniger
#: Sonne.
LOAD_QUANTILE = 0.9
PV_QUANTILE = 0.1

#: Die Vorgaben ohne gemessene Verteilung (siehe Moduldoku).
DEFAULT_LOAD_UPLIFT = 0.25
DEFAULT_PV_HAIRCUT = 0.30

#: Mehr als 90 % Abschlag wäre keine Prognose mehr, sondern Nacht.
MAX_PV_HAIRCUT = 0.9

#: Unter dieser PV-Prognose [kW] ist eine Viertelstunde Nacht (keine
#: Erzeugung) - dieselbe Größenordnung wie die Totzone des Netzaustauschs.
NIGHT_PV_KW = 0.05

#: So weit ab Planbeginn liest die Rechnung die Prognose höchstens (48 h, das
#: Fenster des Fahrplans selbst).
MAX_RELEASE_SLOTS = 192

#: Ab dieser Netzleistung [kW] plant der Fahrplan einen Austausch - dieselbe
#: Totzone wie die Eigenverbrauchs-Pflichten (slot_trim).
GRID_DEADBAND_KW = 0.05

#: Mindestzahl vollständiger Tage für eine PV-Fehlerverteilung - dieselbe
#: Regel wie für die Nächte.
MIN_DAYS = 7
DAYS = 28
#: Tagesfenster der PV-Bewertung in Berliner Stunden (06-21 Uhr, 60 Slots).
DAY_WINDOW: tuple[int, int] = (6, 21)
#: So viele Viertelstunden des Tagesfensters müssen Messung UND Prognose
#: tragen (wie MIN_SLOTS_PER_NIGHT: 85 %).
MIN_SLOTS_PER_DAY = 51
#: Unter dieser prognostizierten Tagesenergie [kWh] ist ein Quotient Rauschen
#: (ein grauer Wintertag mit 0,3 kWh würde sonst ±100 % schwanken).
MIN_FORECAST_DAY_KWH = 1.0

#: Warum es an einem ganzen Lauf keine Freigabe gibt - das geschlossene
#: Vokabular, das die Box und die Fläche weiterreichen.
GRUND_KEIN_LADESTAND = "kein_ladestand"
GRUND_SPEICHER_GEHALTEN = "speicher_gehalten"
GRUND_PROGNOSE_VERALTET = "prognose_veraltet"
GRUND_NACHT_UEBER_KAPAZITAET = "nachtbedarf_ueber_kapazitaet"
GRUND_RESERVE_UEBER_KAPAZITAET = "reserve_ueber_kapazitaet"
#: Fahrplan und frische Prognose reichen nicht bis zur nächsten Erzeugung
#: (:func:`reaches_next_generation`) - die Prognose ist frisch, aber zu kurz.
GRUND_PROGNOSE_ZU_KURZ = "prognose_zu_kurz"


@dataclass(frozen=True)
class DayErrorQuantiles:
    """Die Tagesfehler-Verteilung der PV-Prognose EINER Anlage
    (``Σ gemessen / Σ prognostiziert − 1`` je vollständigem Tag)."""

    quantiles: dict[float, float]
    days: int
    model_id: str

    def level(self, q: float) -> float:
        return self.quantiles[q]


@dataclass(frozen=True)
class Unsicherheit:
    """Wie vorsichtig gerechnet wurde, und woher die Zahlen kommen."""

    #: Relativer Aufschlag auf die Lastprognose (>= 0).
    last_aufschlag: float
    #: ``gemessen`` (0,9-Quantil der Nachtfehler) oder ``vorgabe``.
    last_quelle: str
    #: Relativer Abschlag auf die PV-Prognose (0 <= x <= 0,9).
    pv_abschlag: float
    #: ``gemessen`` (0,1-Quantil der Tagesfehler) oder ``vorgabe``.
    pv_quelle: str
    #: Auf wie vielen Nächten/Tagen die gemessenen Zahlen ruhen (0 = Vorgabe).
    naechte: int = 0
    tage: int = 0


def unsicherheit(
    night_errors: NightErrorQuantiles | None,
    pv_errors: DayErrorQuantiles | None,
) -> Unsicherheit:
    """Der Aufschlag auf die Last und der Abschlag auf die PV.

    Eine gemessene Verteilung wird nur in die VORSICHTIGE Richtung gelesen:
    eine Anlage, deren Nacht im 0,9-Quantil noch unter der Prognose blieb,
    bekommt keinen Abschlag auf die Last, und eine, deren Sonne im 0,1-Quantil
    noch über der Prognose lag, keinen Zuschlag auf die PV.
    """
    if night_errors is not None and LOAD_QUANTILE in night_errors.quantiles:
        last = max(0.0, night_errors.level(LOAD_QUANTILE))
        last_quelle, naechte = "gemessen", night_errors.nights
    else:
        last, last_quelle, naechte = DEFAULT_LOAD_UPLIFT, "vorgabe", 0
    if pv_errors is not None and PV_QUANTILE in pv_errors.quantiles:
        pv = min(MAX_PV_HAIRCUT, max(0.0, -pv_errors.level(PV_QUANTILE)))
        pv_quelle, tage = "gemessen", pv_errors.days
    else:
        pv, pv_quelle, tage = DEFAULT_PV_HAIRCUT, "vorgabe", 0
    return Unsicherheit(
        last_aufschlag=last,
        last_quelle=last_quelle,
        pv_abschlag=pv,
        pv_quelle=pv_quelle,
        naechte=naechte,
        tage=tage,
    )


def required_energy_kwh(
    load_kw: list[float],
    pv_kw: list[float],
    slot_hours: float,
    *,
    floor_kwh: float,
    ceiling_kwh: float,
    max_charge_kw: float,
    max_discharge_kw: float,
    one_way_efficiency: float,
    extra_drain_kwh: list[float] | None = None,
) -> tuple[list[float], list[bool]]:
    """Die nötige gespeicherte Energie an jeder Slotgrenze ``0..n``.

    ``load_kw``/``pv_kw`` sind die schon VORSICHTIG gemachten Reihen (kW-Mittel
    je Slot). ``extra_drain_kwh`` sind zusätzliche Entnahmen je Slot in
    gespeicherten kWh (ein geplanter Verkauf). Rückgabe: ``(E, gekappt)`` mit
    ``len == n + 1``; ``gekappt[t]`` heißt, an der Grenze ``t`` reicht selbst
    ein voller Speicher nicht.
    """
    n = len(load_kw)
    if len(pv_kw) != n:
        raise ValueError("load_kw and pv_kw must have the same length")
    if extra_drain_kwh is not None and len(extra_drain_kwh) != n:
        raise ValueError("extra_drain_kwh must have one entry per slot")
    if one_way_efficiency <= 0.0:
        raise ValueError("one_way_efficiency must be positive")
    need = [0.0] * (n + 1)
    capped = [False] * (n + 1)
    need[n] = floor_kwh
    if floor_kwh > ceiling_kwh:
        need[n] = ceiling_kwh
        capped[n] = True
    for t in range(n - 1, -1, -1):
        net = load_kw[t] - pv_kw[t]
        if net > 0.0:
            e = need[t + 1] + min(net, max_discharge_kw) * slot_hours / one_way_efficiency
        else:
            e = need[t + 1] - min(-net, max_charge_kw) * slot_hours * one_way_efficiency
        if extra_drain_kwh is not None:
            e += max(0.0, extra_drain_kwh[t])
        e = max(floor_kwh, e)
        if e > ceiling_kwh + 1e-9:
            e = ceiling_kwh
            capped[t] = True
        need[t] = e
    return need, capped


def reaches_next_generation(
    load_kw: list[float], pv_kw: list[float], pv_raw_kw: list[float]
) -> bool:
    """Ob die Reihen über die nächste Nacht bis zur nächsten Erzeugung reichen.

    Nach der ersten Nacht-Viertelstunde (rohe PV-Prognose unter
    :data:`NIGHT_PV_KW`) muss die Reihe EINES von beiden erreichen:

    - die erste Viertelstunde, in der die VORSICHTIGE Sonne (``pv_kw``) die
      vorsichtige Last (``load_kw``) wieder deckt - die nächste Erzeugung im
      Sinn des Kapitäns; oder
    - das Ende des ganzen nächsten Tages (wieder eine Nacht-Viertelstunde nach
      Sonnenaufgang) - ein trüber Folgetag, an dem die Sonne das Haus nie
      deckt. Dann trägt die Rechnung seinen ganzen Bedarf: die Untergrenze
      steigt oder ist gekappt (``nachtbedarf_ueber_kapazitaet``), statt dass
      ein fehlender Morgen sie zu tief rechnet.

    Endet die Reihe vorher, wüsste niemand, was der Rest der Nacht braucht.
    """
    n = len(load_kw)
    if len(pv_kw) != n or len(pv_raw_kw) != n:
        raise ValueError("load_kw, pv_kw and pv_raw_kw must have the same length")
    night = next((t for t in range(n) if pv_raw_kw[t] < NIGHT_PV_KW), None)
    if night is None:
        return False
    sunrise = next((t for t in range(night + 1, n) if pv_raw_kw[t] >= NIGHT_PV_KW), None)
    if sunrise is None:
        return False
    for t in range(sunrise, n):
        if pv_raw_kw[t] < NIGHT_PV_KW:
            return True  # der ganze nächste Tag liegt in der Reihe
        if pv_kw[t] >= load_kw[t]:
            return True  # die Sonne deckt das Haus wieder
    return False


def release_slot(battery_kw: float, grid_kw: float, load_kw: float, pv_kw: float) -> bool:
    """Ob der Fahrplan in dieser Viertelstunde eine Freigabe zulässt.

    NEIN bei Handel - dort gewinnt der Plan:

    - geplanter NETZBEZUG über der Totzone: die günstige Stunde („warten"),
      Netzladen, oder PV-Bus-Laden, während das Haus parallel bezieht. Der
      Plan hat dort bewusst Netzstrom statt Speicherenergie gewählt.
    - geplanter VERKAUF aus dem Speicher: Entladung über das prognostizierte
      Hausdefizit hinaus bei Einspeisung.

    JA in Eigenverbrauchs-Viertelstunden: Überschuss laden, Haus decken, ruhen
    (auch der volle Speicher, dessen Sonne eingespeist wird).
    """
    if grid_kw > GRID_DEADBAND_KW:
        return False
    deficit = max(0.0, load_kw - pv_kw)
    if battery_kw < -GRID_DEADBAND_KW and grid_kw < -GRID_DEADBAND_KW:
        if -battery_kw > deficit + GRID_DEADBAND_KW:
            return False
    return True


def planned_sale_kw(battery_kw: float, load_kw: float, pv_kw: float) -> float:
    """Der Teil einer geplanten Entladung, der über das Hausdefizit hinaus ins
    Netz geht (>= 0)."""
    if battery_kw >= 0.0:
        return 0.0
    return max(0.0, -battery_kw - max(0.0, load_kw - pv_kw))


@dataclass(frozen=True)
class StorageRelease:
    """Die Untergrenze eines Laufs, je Slot des Fahrplans."""

    #: Ladestand [%], unter den die Box für „Sonne + Speicher" nicht entladen
    #: darf - je Slot; ``None`` = in diesem Slot keine Freigabe.
    floor_soc_pct: tuple[float | None, ...]
    #: Dieselbe Grenze in gespeicherten kWh (für Erklärung und Tests).
    floor_kwh: tuple[float | None, ...]
    #: Höchste Entladeleistung des Speichers [kW] (Stammdaten) - die Box gibt
    #: nie mehr frei, als der Speicher liefern kann.
    max_discharge_kw: float
    reserve_kwh: float
    reserve_standard: bool
    unsicherheit: Unsicherheit | None
    #: Warum der ganze Lauf keine Freigabe trägt (``GRUND_*``), sonst ``None``.
    grund: str | None = None

    @property
    def any_release(self) -> bool:
        return any(v is not None for v in self.floor_soc_pct)


def _none_release(plan: SchedulePlan, reserve_kwh: float, standard: bool,
                  grund: str, u: Unsicherheit | None = None) -> StorageRelease:
    n = len(plan.slots)
    return StorageRelease(
        floor_soc_pct=(None,) * n,
        floor_kwh=(None,) * n,
        max_discharge_kw=plan.battery.max_discharge_kw,
        reserve_kwh=reserve_kwh,
        reserve_standard=standard,
        unsicherheit=u,
        grund=grund,
    )


def plan_storage_release(
    plan: SchedulePlan,
    *,
    reserve_kwh: float | None,
    night_errors: NightErrorQuantiles | None,
    pv_errors: DayErrorQuantiles | None,
    forecasts_fresh: bool,
    battery_held: bool = False,
    tail_load_kw: list[float] | tuple[float, ...] = (),
    tail_pv_kw: list[float] | tuple[float, ...] = (),
) -> StorageRelease:
    """Die Untergrenze je Slot für EINEN gelösten Fahrplan.

    Rein (keine DB, keine Uhr): alles, was zählt, steht im Plan selbst (die
    Last-/PV-Reihen, die der Lauf benutzt hat, und seine Entscheidungen) oder
    wird hereingereicht. ``forecasts_fresh=False`` (Prognose fehlt oder ist
    veraltet) ergibt einen Lauf OHNE Freigabe - nie eine Rechnung auf alten
    Zahlen.

    ``tail_load_kw``/``tail_pv_kw`` sind die frischen Prognose-Viertelstunden
    direkt NACH dem Fahrplan (:func:`forecast_tail`); die Rechnung läuft über
    sie weiter, eine Untergrenze bekommen nur die Slots des Fahrplans. Reichen
    Fahrplan und Prognose zusammen nicht bis zur nächsten Erzeugung
    (:func:`reaches_next_generation`), gibt es keine Freigabe.
    """
    if len(tail_load_kw) != len(tail_pv_kw):
        raise ValueError("tail_load_kw and tail_pv_kw must have the same length")
    standard = reserve_kwh is None
    reserve = DEFAULT_RESERVE_KWH if reserve_kwh is None else max(0.0, float(reserve_kwh))
    if plan.soc_source == SOC_SOURCE_UNBEKANNT:
        return _none_release(plan, reserve, standard, GRUND_KEIN_LADESTAND)
    if battery_held:
        return _none_release(plan, reserve, standard, GRUND_SPEICHER_GEHALTEN)
    if not forecasts_fresh:
        return _none_release(plan, reserve, standard, GRUND_PROGNOSE_VERALTET)

    u = unsicherheit(night_errors, pv_errors)
    battery = plan.battery
    floor_kwh = battery.capacity_kwh * battery.effective_floor_soc_pct / 100.0 + reserve
    ceiling_kwh = battery.soc_max_kwh
    if floor_kwh >= ceiling_kwh:
        return _none_release(plan, reserve, standard, GRUND_RESERVE_UEBER_KAPAZITAET, u)

    slot_hours = plan.slot_minutes / 60.0
    eta = battery.one_way_efficiency
    raw_load = [s.load_kw for s in plan.slots] + [float(x) for x in tail_load_kw]
    raw_pv = [max(0.0, s.pv_kw) for s in plan.slots] + [max(0.0, float(x)) for x in tail_pv_kw]
    load = [x * (1.0 + u.last_aufschlag) for x in raw_load]
    pv = [x * (1.0 - u.pv_abschlag) for x in raw_pv]
    if not reaches_next_generation(load, pv, raw_pv):
        return _none_release(plan, reserve, standard, GRUND_PROGNOSE_ZU_KURZ, u)
    # In der Prognose-Verlängerung handelt kein Plan: keine Verkäufe.
    sales = [
        planned_sale_kw(s.battery_kw, s.load_kw, s.pv_kw) * slot_hours / eta
        for s in plan.slots
    ] + [0.0] * len(tail_load_kw)
    need, capped = required_energy_kwh(
        load,
        pv,
        slot_hours,
        floor_kwh=floor_kwh,
        ceiling_kwh=ceiling_kwh,
        max_charge_kw=battery.max_charge_kw,
        max_discharge_kw=battery.max_discharge_kw,
        one_way_efficiency=eta,
        extra_drain_kwh=sales,
    )
    if capped[0]:
        return _none_release(plan, reserve, standard, GRUND_NACHT_UEBER_KAPAZITAET, u)

    floors_kwh: list[float | None] = []
    floors_pct: list[float | None] = []
    for t, s in enumerate(plan.slots):
        if capped[t] or capped[t + 1] or not release_slot(
            s.battery_kw, s.grid_kw, s.load_kw, s.pv_kw
        ):
            floors_kwh.append(None)
            floors_pct.append(None)
            continue
        # Innerhalb des Slots wächst der Bedarf in einem Überschuss-Slot von
        # E(t) auf E(t+1) - die Box hält über den ganzen Slot den HÖHEREN Wert.
        e = max(need[t], need[t + 1])
        floors_kwh.append(math.ceil(e * 1000.0 - 1e-9) / 1000.0)
        floors_pct.append(_pct_up(e, battery.capacity_kwh))
    return StorageRelease(
        floor_soc_pct=tuple(floors_pct),
        floor_kwh=tuple(floors_kwh),
        max_discharge_kw=battery.max_discharge_kw,
        reserve_kwh=reserve,
        reserve_standard=standard,
        unsicherheit=u,
    )


def _pct_up(kwh: float, capacity_kwh: float) -> float:
    """kWh -> Ladestand in Prozent, auf 0,1 AUFGERUNDET (nie zu tief)."""
    pct = kwh / capacity_kwh * 100.0
    return min(100.0, math.ceil(pct * 10.0 - 1e-9) / 10.0)


# ---------------------------------------------------------------------------
# Die Lesepfade (DB) - alle FAIL-SOFT: was nicht lesbar ist, gibt KEINE
# Freigabe bzw. die Vorgabe, nie einen fehlenden Plan.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ReleaseSetting:
    """Was die Anlage für „Sonne + Speicher" eingestellt hat."""

    #: ``None`` = keine eigene Reserve hinterlegt (dann gilt die Vorgabe).
    reserve_kwh: float | None


def load_release_settings(dsn: str) -> dict[str, ReleaseSetting]:
    """Die Anlagen, an denen mindestens ein Ladepunkt „Sonne + Speicher" fährt,
    mit ihrer Reserve - EIN Lesen je Takt, wie die Modellwahl.

    Nur an diesen Anlagen wird eine Untergrenze gerechnet und veröffentlicht;
    jeder andere Fahrplan bleibt byte-identisch. Fail-soft: eine fehlende
    Tabelle (Optimierer vor der api-Migration) oder eine tote DB heißt „keine
    Anlage" - die Box fährt dann „Nur Sonne".
    """
    import psycopg  # lazy: optional [db] extra

    out: dict[str, ReleaseSetting] = {}
    try:
        with psycopg.connect(dsn) as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT a.site_id::text, c.storage_release_reserve_kwh
                FROM (SELECT DISTINCT site_id FROM site_charge_point_allowlist
                      WHERE storage_release) a
                LEFT JOIN site_charging_config c ON c.site_id = a.site_id
                """
            )
            for site_id, reserve in cur.fetchall():
                out[site_id] = ReleaseSetting(
                    reserve_kwh=float(reserve) if reserve is not None else None
                )
    except Exception as exc:  # pragma: no cover - exercised via the unit test
        logger.warning(
            "storage_release.settings_unavailable",
            extra={"context": {"error": str(exc)}},
        )
        return {}
    return out


@dataclass(frozen=True)
class ReleaseForecast:
    """Was die Rechnung über die Prognose wissen muss: ist sie frisch genug für
    den Fahrplan, und wie geht sie danach weiter (die Verlängerung bis zur
    nächsten Erzeugung, je Viertelstunde in kW)."""

    fresh: bool
    tail_load_kw: tuple[float, ...] = ()
    tail_pv_kw: tuple[float, ...] = ()


def release_forecast(
    dsn: str,
    site_id: UUID,
    load_model: str,
    pv_model: str,
    now: datetime,
    max_age: timedelta,
    plan: SchedulePlan,
) -> ReleaseForecast:
    """Frische und Verlängerung der Prognose für EINEN Fahrplan.

    ``fresh`` heißt: ein Lauf des aktiven Last- UND PV-Modells, jünger als
    ``max_age``, reicht bis zum letzten Slot des Fahrplans. Die Verlängerung
    (:func:`forecast_tail`) reicht höchstens so weit wie diese frischen Läufe.
    Fail-soft: nicht lesbar = nicht frisch.
    """
    until = fresh_forecast_until(dsn, site_id, load_model, pv_model, now, max_age)
    if until is None or until < _utc(plan.slots[-1].start):
        return ReleaseForecast(fresh=False)
    load, pv = forecast_tail(dsn, site_id, load_model, pv_model, plan, until)
    return ReleaseForecast(fresh=True, tail_load_kw=load, tail_pv_kw=pv)


def forecast_tail(
    dsn: str,
    site_id: UUID,
    load_model: str,
    pv_model: str,
    plan: SchedulePlan,
    until: datetime,
) -> tuple[tuple[float, ...], tuple[float, ...]]:
    """Die gespeicherte Last- und PV-Prognose direkt nach dem Fahrplan.

    Je Viertelstunde der frischeste Wert des aktiven Modells (dieselbe Regel
    wie der Fahrplan selbst), lückenlos ab dem Planende, bis ``until`` (der
    Reichweite der frischen Läufe) und höchstens :data:`MAX_RELEASE_SLOTS` ab
    Planbeginn. Fehlt ein Wert, endet die Verlängerung dort. Fail-soft: leer.
    """
    from voltpilot_optimization.inputs import _load_forecast

    step = timedelta(minutes=plan.slot_minutes)
    first = _utc(plan.slots[-1].start) + step
    room = max(0, MAX_RELEASE_SLOTS - len(plan.slots))
    if room == 0 or first > _utc(until):
        return (), ()
    try:
        stored_load = _load_forecast(dsn, site_id, "load", load_model, first)
        stored_pv = _load_forecast(dsn, site_id, "pv", pv_model, first)
    except Exception:
        logger.warning(
            "storage_release.forecast_tail_unavailable",
            extra={"context": {"site_id": str(site_id)}},
            exc_info=True,
        )
        return (), ()
    load: list[float] = []
    pv: list[float] = []
    t = first
    while len(load) < room and t <= _utc(until):
        if t not in stored_load or t not in stored_pv:
            break
        load.append(float(stored_load[t]))
        pv.append(float(stored_pv[t]))
        t += step
    return tuple(load), tuple(pv)


def forecasts_fresh(
    dsn: str,
    site_id: UUID,
    load_model: str,
    pv_model: str,
    now: datetime,
    max_age: timedelta,
    until: datetime,
) -> bool:
    """Ob für Last UND PV ein gespeicherter Lauf des aktiven Modells jünger als
    ``max_age`` vorliegt, der bis ``until`` reicht. Fail-soft: ``False``."""
    reach = fresh_forecast_until(dsn, site_id, load_model, pv_model, now, max_age)
    return reach is not None and reach >= _utc(until)


def fresh_forecast_until(
    dsn: str,
    site_id: UUID,
    load_model: str,
    pv_model: str,
    now: datetime,
    max_age: timedelta,
) -> datetime | None:
    """Bis wohin die Läufe des aktiven Last- UND PV-Modells reichen, die
    jünger als ``max_age`` sind (das Minimum beider), oder ``None``.
    Fail-soft: ``None``."""
    import psycopg  # lazy: optional [db] extra

    now = _utc(now)
    try:
        with psycopg.connect(dsn) as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT kind, max(time) FROM forecast
                WHERE site_id = %s AND run_at >= %s AND run_at <= %s
                  AND ((kind = 'load' AND model = %s) OR (kind = 'pv' AND model = %s))
                GROUP BY kind
                """,
                (site_id, now - max_age, now, load_model, pv_model),
            )
            rows = {kind: _utc(t) for kind, t in cur.fetchall() if t is not None}
    except Exception:
        logger.warning(
            "storage_release.forecast_age_unavailable",
            extra={"context": {"site_id": str(site_id)}},
            exc_info=True,
        )
        return None
    if not all(k in rows for k in ("load", "pv")):
        return None
    return min(rows["load"], rows["pv"])


def pv_day_error_quantiles(
    dsn: str,
    site_id: UUID,
    now: datetime,
    model_id: str,
    days: int = DAYS,
    min_days: int = MIN_DAYS,
    qs: tuple[float, ...] = (PV_QUANTILE,),
) -> DayErrorQuantiles | None:
    """Die Quantile des relativen Tagesfehlers der PV-Prognose, oder ``None``.

    Dieselbe Methode wie die Nacht-Fehlerverteilung
    (:func:`voltpilot_optimization.night_reserve.night_error_quantiles`): je
    abgeschlossenem Tag ``Σ gemessen / Σ prognostiziert − 1`` über das
    Tagesfenster 06-21 Uhr, prognostiziert vom AKTIVEN PV-Modell aus dem
    Abend-Lauf um 17:45 des Vortags - also aus dem, was eine Untergrenze am
    Vorabend über den nächsten Morgen WUSSTE.
    """
    import psycopg  # lazy: optional [db] extra

    now = _utc(now)
    windows = day_windows(now, days)
    if not windows:
        return None
    oldest = min(s for s, _ in windows)
    try:
        with psycopg.connect(dsn) as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT bucket, pv_kwh * 4.0 FROM telemetry_rollup_15m
                WHERE site_id = %s AND pv_kwh IS NOT NULL
                  AND bucket >= %s AND bucket < %s
                """,
                (site_id, oldest, now),
            )
            measured = {_utc(ts): float(v) for ts, v in cur.fetchall() if v is not None}
            cur.execute(
                """
                SELECT run_at, time, value_kw FROM forecast
                WHERE site_id = %s AND kind = 'pv' AND model = %s
                  AND time >= %s AND time < %s
                ORDER BY run_at
                """,
                (site_id, model_id, oldest, max(e for _, e in windows)),
            )
            by_run: dict[datetime, dict[datetime, float]] = {}
            for run_at, ts, value in cur.fetchall():
                by_run.setdefault(_utc(run_at), {})[_utc(ts)] = float(value)
    except Exception:
        logger.warning(
            "storage_release.pv_errors_unavailable",
            extra={"context": {"site_id": str(site_id)}},
            exc_info=True,
        )
        return None
    forecasts = evening_runs(windows, by_run)
    rels = day_error_rels(windows, measured, forecasts)
    if len(rels) < min_days:
        return None
    quantiles: dict[float, float] = {}
    for q in qs:
        v = quantile(rels, q)
        if v is None:
            return None
        quantiles[q] = v
    return DayErrorQuantiles(quantiles=quantiles, days=len(rels), model_id=model_id)


def day_windows(now: datetime, days: int) -> list[tuple[datetime, datetime]]:
    """Die ``days`` jüngsten ABGESCHLOSSENEN Tagesfenster (Berlin), neueste zuerst."""
    from_hour, to_hour = DAY_WINDOW
    today = _utc(now).astimezone(BERLIN).date()
    out: list[tuple[datetime, datetime]] = []
    for back in range(0, days + 11):
        if len(out) >= days:
            break
        day = today - timedelta(days=back)
        start = datetime.combine(day, time(from_hour), tzinfo=BERLIN).astimezone(timezone.utc)
        end = datetime.combine(day, time(to_hour), tzinfo=BERLIN).astimezone(timezone.utc)
        if end > _utc(now):
            continue
        out.append((start, end))
    return out


def evening_runs(
    windows: list[tuple[datetime, datetime]],
    by_run: dict[datetime, dict[datetime, float]],
) -> dict[datetime, dict[datetime, float]]:
    """Je Tagesfenster die Prognose des Abend-Laufs um 17:45 (± 15 min) des
    VORTAGS - bei zwei Läufen gewinnt der näher an 17:45, nie der neuere."""
    out: dict[datetime, dict[datetime, float]] = {}
    for start, end in windows:
        day = start.astimezone(BERLIN).date() - timedelta(days=1)
        target = datetime.combine(
            day, time(RUN_HOUR, RUN_MINUTE), tzinfo=BERLIN
        ).astimezone(timezone.utc)
        candidates = [r for r in by_run if abs(r - target) <= RUN_TOLERANCE]
        if not candidates:
            continue
        best = min(candidates, key=lambda r: (abs(r - target), r))
        slots = {ts: v for ts, v in by_run[best].items() if start <= ts < end}
        if slots:
            out[start] = slots
    return out


def day_error_rels(
    windows: list[tuple[datetime, datetime]],
    measured: dict[datetime, float],
    forecasts: dict[datetime, dict[datetime, float]],
) -> list[float]:
    """Der relative Energie-Fehler je VOLLSTÄNDIGEM Tag (``Σ m / Σ f − 1``).
    Ein Tag mit zu wenig gepaarten Viertelstunden oder zu wenig prognostizierter
    Sonne wird verworfen, nie hochgerechnet."""
    rels: list[float] = []
    for start, end in windows:
        predicted = forecasts.get(start)
        if not predicted:
            continue
        act = fc = 0.0
        paired = 0
        slot = start
        while slot < end:
            m = measured.get(slot)
            f = predicted.get(slot)
            if m is not None and f is not None:
                act += max(0.0, m)
                fc += max(0.0, f)
                paired += 1
            slot += timedelta(minutes=15)
        if paired >= MIN_SLOTS_PER_DAY and fc * 0.25 >= MIN_FORECAST_DAY_KWH:
            rels.append(act / fc - 1.0)
    return rels


def _utc(moment: datetime) -> datetime:
    if moment.tzinfo is None:
        return moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)
