"""Das VORSPRUNG-BUDGET (NS-2 A, Captain-Entscheid 15.10.2026, Untersuchung
``vp-herzogau-nie-schlechter-k5`` §7, Bauplan NS-P2).

Die Kachel "VoltPilot-Steuerung" zeigt je Anlage, wie weit die Steuerung im
Monat und in den letzten 7 Tagen MIT BESTAND vor dem sturen Speicher liegt
(HZ-3 A; seit NS-1 A gegen dieselbe Messlatte, gegen die ein stur gefahrener
Speicher bei 0,00 EUR landet). Die Garantie: **diese beiden Zahlen fallen nie
tiefer als das Budget unter null** (Vorgabe 0 EUR, je Anlage änderbar,
``OPTIMIZER_VORSPRUNG_BUDGET_ANLAGEN``). Je Kalendertag ohne Bestand ist nichts
garantierbar, solange abends verkauft wird - der Nachkauf landet im Folgetag.

**Wie die Regel hält.** Sie prüft den FERTIGEN Plan - nach dem Lösen und nach
jeder Regel, die Freigaben stempelt (NS-5 B, künftig NS-3 B): je Slot rechnet
sie, was die Box an den Prognosewerten tatsächlich tut (Sollwert plus ihre
Vollmachten und die Defizit-Deckung der Box, :func:`_wirksam`), und daneben
den sturen Vergleichsspeicher (:func:`voltpilot_optimization.simulation.greedy.greedy_dispatch`,
dieselbe EINE Physik wie die Messlatte). Fiele der Vorsprung mit Bestand nach
einem Slot unter ``-Budget``, und fährt der Plan dort anders als stur, fährt
der Slot stur (sofort laden, sofort decken), sofern das den Vorsprung besser
hält. Warum stures Fahren den Vorsprung hält: läuft der echte Speicher stur,
kann der Vorsprung mit Bestand nur gleich bleiben oder wachsen (Bericht §7.1).

**Bewertung des Bestands (asymmetrisch, Bauplan NS-P2).** Ein Rückstand im
Speicher kostet höchstens den Bezugspreis × √0,92 (die Bewertung der api,
25 ct → 23,98 ct). Ein Vorsprung ist nur so viel wert, wie er sicher einbringt:
der Einspeisewert des nächsten Mittags (wird der echte Speicher zuerst voll,
verfällt er zu diesem Preis), höchstens die Bewertung, nie unter null. So ist
der geprüfte Vorsprung nie größer als die Zahl der Kachel.

**Fenster.** Monat (Σ der Tage seit dem Monatsersten) und 7 Tage (der laufende
Tag und die 6 davor - genau das Fenster, das die Kachel morgen zeigt, wenn der
laufende Tag abgeschlossen ist). Über den Horizont rollen beide mit: an jeder
Mitternacht fällt der älteste Tag aus dem 7-Tage-Fenster (die api liefert die
6 Tageswerte mit), am Monatsersten verankert die api den Vergleichsspeicher
neu am echten Stand - der Monat beginnt bei 0, das 7-Tage-Fenster bucht den
Bestand bis dahin.

**Kein Budget, kein Eingriff (fail-soft).** Fehlt der Stand (nicht lesbar,
älter als :data:`HOECHSTALTER`) oder hat ein Fenster eine Lücke (die Kachel
zeigt dort keine Zahl), gibt es für dieses Fenster kein Budget. Ein Fehler in
der Prüfung kostet den Lauf die Regel, nie den Plan.

**Was die Regel nicht abfängt** (Bericht §7.1): Fehler innerhalb einer
Viertelstunde (sie entscheidet mit der Prognose), Messlücken, und alles, was
die Box auch stur anders macht als der ideale Vergleich (Abstand beim Decken,
Haltezeiten). Die Garantie gilt "bis auf eine Viertelstunde".
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from voltpilot_optimization.domain import BatteryParams, OptimizationInput, PlanSlot
from voltpilot_optimization.simulation.greedy import greedy_dispatch
from voltpilot_optimization.slot_trim import PLANNED_IDLE_DEADBAND_KW
from voltpilot_optimization.stur import stur_battery
from voltpilot_optimization.ueberschuss_verbraucher import SLOT_FLAG_UEBERSCHUSS_VERBRAUCHER

logger = logging.getLogger("voltpilot.optimization")

BERLIN = ZoneInfo("Europe/Berlin")

#: Der Grund im Plan-Erklärtext: „fährt stur, Vorsprung aufgebraucht“ - der
#: Slot fährt stur, weil der Plan sonst Monat oder 7 Tage mit Bestand unter
#: das Budget drückte. Steht als erster Code in ``slot_flags`` des Slots, die
#: Bindungen des gelösten Plans entfallen; nur ``ueberschuss_verbraucher``
#: (NS-3 B: der Slot rechnet mit der Grundlast) bleibt daneben stehen.
SLOT_FLAG_VORSPRUNG_AUFGEBRAUCHT = "vorsprung_aufgebraucht"

#: Kleinere Unterschiede zum sturen Verhalten gelten als gleich - wie im
#: Replay der Untersuchung (``varianten.py``, ``TOL``): dort greift die Regel
#: nicht, weil es nichts zu ändern gibt.
ABWEICHUNG_KW = 0.3

#: Älter darf der Stand der api (Ende des letzten gemessenen Eimers) beim
#: Laufbeginn nicht sein: bis dahin gilt "der Vergleichsspeicher hat sich wie
#: der echte bewegt" als Näherung, danach gibt es kein Budget.
HOECHSTALTER = timedelta(minutes=60)

#: Die Uhrzeit (Berlin), deren Einspeisewert einen Vorsprung im Speicher bewertet.
MITTAG = (12, 0)

_EPS_EUR = 1e-9


@dataclass(frozen=True)
class Bericht:
    """Was die Prüfung eines Laufs ergab (Log, Tests, Replay)."""

    #: Warum es kein Budget gab (``None`` = geprüft).
    ohne_budget: str | None = None
    #: Slots, die stur fahren, weil der Vorsprung aufgebraucht war.
    eingriffe: tuple[int, ...] = ()
    #: Tiefster geprüfter Vorsprung je Fenster über den Horizont (EUR).
    tiefster_monat_eur: float | None = None
    tiefster_sieben_eur: float | None = None


def mit_budget(plan, inp: OptimizationInput):
    """Den fertigen Plan gegen das Vorsprung-Budget prüfen.

    Gibt ``(plan, bericht)`` zurück. Ohne Budget (Regel aus) ist ``plan``
    DASSELBE Objekt - byte-identisch zu vorher. Wirft nie: ein Fehler kostet
    den Lauf die Regel, nie den Plan.
    """
    if inp.vorsprung_budget_eur is None:
        return plan, Bericht(ohne_budget="aus")
    try:
        grund = _ohne_budget(inp)
        if grund is not None:
            bericht = Bericht(ohne_budget=grund)
        else:
            slots, bericht = pruefe(plan.slots, inp)
            if bericht.eingriffe:
                plan = replace(plan, slots=slots)
        _log(inp, bericht)
        return plan, bericht
    except Exception:
        logger.warning(
            "vorsprung.failed - Lauf ohne Vorsprung-Budget (NS-2 A)",
            extra={"context": {"site_id": str(inp.site_id)}},
            exc_info=True,
        )
        return plan, Bericht(ohne_budget="fehler")


def _ohne_budget(inp: OptimizationInput) -> str | None:
    """Warum dieser Lauf kein Budget hat, oder ``None``."""
    stand = inp.vorsprung
    if stand is None:
        return "kein_stand"
    # Wie die Vollmachten (P7, Steuerstand): ohne gemessenen Ladestand, an
    # einem nicht gesteuerten oder von einer Kundenregel gehaltenen Speicher
    # gibt es keinen Plan, den die Regel stur stellen könnte.
    if inp.soc_unbekannt:
        return "ladestand_unbekannt"
    if inp.battery_observed or inp.battery_held:
        return "nicht_gesteuert"
    if inp.verbund:
        return "verbund"
    if stand.monat_eur is None and stand.sieben_tage_eur is None:
        return "luecke"
    if not (stand.kapazitaet_kwh > 0.0 and math.isfinite(stand.vorsprung_kwh)):
        return "luecke"
    if inp.slot_starts[0] - _utc(stand.messung_bis) > HOECHSTALTER:
        return "zu_alt"
    return None


def wert_vorsprung_eur(delta_kwh: float, bewertung_eur_kwh: float, mittag_eur_kwh: float) -> float:
    """Der Bestand im Speicher in EUR: ein Rückstand (negativ) mit der
    Bewertung, ein Vorsprung mit dem Einspeisewert des nächsten Mittags -
    höchstens der Bewertung, nie unter null."""
    if delta_kwh < 0.0:
        return delta_kwh * bewertung_eur_kwh
    return delta_kwh * max(min(mittag_eur_kwh, bewertung_eur_kwh), 0.0)


def pruefe(slots: list[PlanSlot], inp: OptimizationInput) -> tuple[list[PlanSlot], Bericht]:
    """Der Kern: die Slots in Zeitfolge gegen das Budget prüfen (siehe Modul).

    ``inp.vorsprung`` und ``inp.vorsprung_budget_eur`` müssen gesetzt sein.
    """
    stand = inp.vorsprung
    budget = inp.vorsprung_budget_eur
    dt = inp.slot_hours
    b = stand.bewertung_ct_kwh / 100.0
    mittag = _mittag_eur_kwh(inp)

    # Der echte Speicher (Plan-Band) und der sture Vergleich (Messlatten-Band).
    batt = inp.battery
    e0 = batt.clamp_soc_kwh(inp.initial_soc_kwh)
    boden = batt.soc_floor_kwh(e0)
    vgl = stur_battery(inp)
    # Der Vergleich steht um den gemeldeten Rückstand tiefer - in PROZENT der
    # Kapazität übertragen (die api rechnet mit der gemessenen, der Plan mit
    # der Nennkapazität), damit beide an derselben Bandstelle stehen.
    es0 = vgl.clamp_soc_kwh(e0 - stand.vorsprung_kwh / stand.kapazitaet_kwh * batt.capacity_kwh)
    vgl_boden = vgl.soc_floor_kwh(es0)
    # Bewertet wird die ENERGIE: der gemeldete Vorsprung plus, was beide
    # Speicher ab hier verschieden laden und entladen.
    versatz = stand.vorsprung_kwh - (e0 - es0)

    # Vorsprung mit Bestand = k + Wert(delta); k trägt Kasse und feste Tage.
    k_monat = None if stand.monat_eur is None else stand.monat_eur - stand.vorsprung_kwh * b
    k_sieben = (
        None if stand.sieben_tage_eur is None
        else stand.sieben_tage_eur - stand.vorsprung_kwh * b
    )
    tage = list(stand.tage_eur)
    tag = stand.tag

    e, es = e0, es0
    eingriffe: list[int] = []
    gewaehlt: list[tuple[float, float, float] | None] = []
    tief_m: float | None = None
    tief_7: float | None = None
    for t, slot in enumerate(slots):
        # Mitternächte und Monatsanker vor diesem Slot (auch die Lücke
        # zwischen dem Stand der api und dem Laufbeginn).
        heute = slot.start.astimezone(BERLIN).date()
        while tag < heute:
            tag = tag + timedelta(days=1)
            if tag.day == 1:
                # Monatsanker der api: der Vergleich springt auf den echten Stand.
                if k_sieben is not None:
                    k_sieben += wert_vorsprung_eur(versatz + e - es, b, mittag[t])
                k_monat = 0.0
                es = vgl.clamp_soc_kwh(e)
                versatz = 0.0
            if k_sieben is not None and tage:
                alt = tage.pop(0)
                k_sieben = None if alt is None else k_sieben - alt

        pv, last = slot.pv_kw, slot.load_kw
        s_ch, s_dis, es_neu = _stur(vgl, es, vgl_boden, pv, last, dt)
        kosten_s = inp.cashflow_cost_eur(t, last - pv + s_ch - s_dis)

        def vorsprung(ch, dis, abregeln):
            e_neu = e + _delta_kwh(batt, ch, dis, dt)
            kasse = kosten_s - inp.cashflow_cost_eur(t, last - pv + abregeln + ch - dis)
            bestand = wert_vorsprung_eur(versatz + e_neu - es_neu, b, mittag[t])
            werte = [k + kasse + bestand for k in (k_monat, k_sieben) if k is not None]
            return (min(werte) if werte else math.inf), kasse, e_neu

        p_ch, p_dis = _wirksam(slot, batt, e, boden, dt)
        lead, kasse, e_neu = vorsprung(p_ch, p_dis, slot.curtail_kw)
        wahl = None
        if lead < -budget - _EPS_EUR:
            o_ch, o_dis, _ = _stur(batt, e, boden, pv, last, dt)
            if abs(p_ch - o_ch) > ABWEICHUNG_KW or abs(p_dis - o_dis) > ABWEICHUNG_KW:
                o_ab = _abregeln_stur(inp, pv, last, o_ch)
                lead_o, kasse_o, e_o = vorsprung(o_ch, o_dis, o_ab)
                if lead_o > lead + _EPS_EUR:
                    wahl = (o_ch, o_dis, o_ab)
                    lead, kasse, e_neu = lead_o, kasse_o, e_o
                    eingriffe.append(t)
        gewaehlt.append(wahl)

        if k_monat is not None:
            k_monat += kasse
            m = k_monat + wert_vorsprung_eur(versatz + e_neu - es_neu, b, mittag[t])
            tief_m = m if tief_m is None else min(tief_m, m)
        if k_sieben is not None:
            k_sieben += kasse
            w = k_sieben + wert_vorsprung_eur(versatz + e_neu - es_neu, b, mittag[t])
            tief_7 = w if tief_7 is None else min(tief_7, w)
        e, es = e_neu, es_neu

    bericht = Bericht(
        eingriffe=tuple(eingriffe),
        tiefster_monat_eur=None if tief_m is None else round(tief_m, 4),
        tiefster_sieben_eur=None if tief_7 is None else round(tief_7, 4),
    )
    if not eingriffe:
        return slots, bericht
    return _neu_gebaut(slots, gewaehlt, inp, e0, boden), bericht


def _wirksam(slot: PlanSlot, batt: BatteryParams, soc: float, boden: float, dt: float):
    """Was die Box in diesem Slot an den PROGNOSEwerten tut: der Sollwert
    plus die Vollmachten des Slots und die Defizit-Deckung der Box
    (``edge-app/core/internal/guards/deficitcover.go``: ein Defizit wird in
    jedem Slot gedeckt, in dem der Plan nicht lädt) - so prüft die Regel das
    Ergebnis, egal welche Regel den Slot gestempelt hat (NS-5 B gibt Ruhe-Slots
    die Überschuss-Freigabe, ohne den Sollwert zu ändern)."""
    ueberschuss = slot.pv_kw - slot.curtail_kw - slot.load_kw
    soll = slot.battery_kw
    ch = dis = 0.0
    if soll > PLANNED_IDLE_DEADBAND_KW:
        ch = soll
        if slot.charge_from_surplus_only:
            ch = min(ch, max(ueberschuss, 0.0))
        if slot.charge_surplus_to_battery:
            ch = max(ch, max(ueberschuss, 0.0))
    else:
        dis = max(-soll, 0.0)
        if soll < -PLANNED_IDLE_DEADBAND_KW and slot.limit_discharge_to_load:
            dis = min(dis, max(-ueberschuss, 0.0))
        dis = max(dis, max(-ueberschuss, 0.0))
        if dis <= PLANNED_IDLE_DEADBAND_KW and ueberschuss > 0.0 and slot.charge_surplus_to_battery:
            ch, dis = ueberschuss, 0.0
    return _begrenzt(batt, soc, boden, ch, dis, dt)


def _stur(batt: BatteryParams, soc: float, boden: float, pv: float, last: float, dt: float):
    """Ein Slot stur (dieselbe Physik wie die Messlatte): ``(laden, entladen, soc danach)``."""
    r = greedy_dispatch(
        batt, load_kw=[last], pv_kw=[pv], initial_soc_kwh=soc,
        soc_floor_kwh=boden, slot_hours=dt,
    )
    kw = r.battery_kw[0]
    return max(kw, 0.0), max(-kw, 0.0), r.soc_kwh[0]


def _abregeln_stur(inp: OptimizationInput, pv: float, last: float, laden: float) -> float:
    """Ein sturer Slot regelt nicht ab - außer, was über der statischen
    Einspeisegrenze läge (die regelt die Box ohnehin am Netzpunkt)."""
    if inp.max_feed_in_kw is None:
        return 0.0
    export = max(pv - last - laden, 0.0)
    return min(max(export - inp.max_feed_in_kw, 0.0), max(pv, 0.0))


def _begrenzt(batt: BatteryParams, soc: float, boden: float, ch: float, dis: float, dt: float):
    eta = batt.one_way_efficiency
    ch = max(min(ch, batt.max_charge_kw, (batt.soc_max_kwh - soc) / (eta * dt)), 0.0)
    dis = max(min(dis, batt.max_discharge_kw, (soc - boden) * eta / dt), 0.0)
    return ch, dis


def _delta_kwh(batt: BatteryParams, ch: float, dis: float, dt: float) -> float:
    eta = batt.one_way_efficiency
    return eta * ch * dt - dis / eta * dt


def _mittag_eur_kwh(inp: OptimizationInput) -> list[float]:
    """Je Slot der Einspeisewert des nächsten Mittags (EUR/kWh): der Slot um
    12:00 Berlin ab diesem Slot; jenseits des letzten Mittags im Horizont
    dieser letzte, ohne jeden Mittag der kleinste Einspeisewert des Horizonts."""
    werte = inp.export_values
    mittage = [
        i for i, s in enumerate(inp.slot_starts)
        if (s.astimezone(BERLIN).hour, s.astimezone(BERLIN).minute) == MITTAG
    ]
    if not mittage:
        kleinster = min(werte) / 1000.0
        return [kleinster] * inp.slots
    out = []
    j = 0
    for t in range(inp.slots):
        while j < len(mittage) - 1 and mittage[j] < t:
            j += 1
        out.append(werte[mittage[j]] / 1000.0)
    return out


def _neu_gebaut(slots, gewaehlt, inp: OptimizationInput, e0: float, boden: float) -> list[PlanSlot]:
    """Die Slots nach der Prüfung: die stur gestellten mit Sollwert, Pflichten
    und Grund; ab dem ersten Eingriff führt jeder Slot die Ladestands-Bahn
    seines Sollwerts nach (und wird gekürzt, wo der Sollwert am neuen Stand
    nicht mehr ginge)."""
    from voltpilot_optimization.config import (
        explain_enabled,
        limit_discharge_enabled,
        load_follow_enabled,
        slot_trim_enabled,
        surplus_charge_enabled,
        unplanned_load_discharge_enabled,
    )

    batt = inp.battery
    dt = inp.slot_hours
    pflichten = explain_enabled()
    schalter = {
        "trim": pflichten and slot_trim_enabled(),
        "follow": pflichten and load_follow_enabled(),
        "absorb": pflichten and surplus_charge_enabled(),
        "unforeseen": pflichten and unplanned_load_discharge_enabled(),
        "limiting": pflichten and limit_discharge_enabled(),
    }
    out: list[PlanSlot] = []
    soc = e0
    geaendert = False
    for t, (slot, wahl) in enumerate(zip(slots, gewaehlt)):
        if wahl is None and not geaendert:
            out.append(slot)
            soc = slot.soc_kwh
            continue
        geaendert = True
        if wahl is not None:
            ch, dis, abregeln = wahl
        else:
            ch, dis, abregeln = max(slot.battery_kw, 0.0), max(-slot.battery_kw, 0.0), slot.curtail_kw
        ch, dis = _begrenzt(batt, soc, boden, ch, dis, dt)
        soc = soc + _delta_kwh(batt, ch, dis, dt)
        battery_kw = ch - dis
        grid_kw = slot.load_kw - slot.pv_kw + abregeln + battery_kw
        neu = dict(
            battery_kw=round(battery_kw, 4),
            grid_kw=round(grid_kw, 4),
            soc_kwh=round(soc, 4),
            curtail_kw=round(abregeln, 4),
            cost_eur=round(inp.cashflow_cost_eur(t, grid_kw), 6),
            wear_cost_eur=round(batt.wear_cost_eur_per_kwh_each_way * (ch + dis) * dt, 6),
        )
        if wahl is not None:
            verbraucher = bool(inp.ueberschuss_verbraucher) and inp.ueberschuss_verbraucher[t]
            neu.update(_stur_pflichten(slot, battery_kw, soc, batt, schalter, verbraucher))
        out.append(replace(slot, **neu))
    return out


def _stur_pflichten(
    slot: PlanSlot, battery_kw: float, soc: float, batt: BatteryParams, schalter, verbraucher: bool
) -> dict:
    """Rolle, Grund und Vollmachten eines stur gestellten Slots: die Box folgt
    der GEMESSENEN Sonne und Last (lädt den Überschuss, deckt das Defizit) -
    wie der sture Speicher, gegen den die Kachel rechnet. Jede Vollmacht nur,
    wo ihr Schalter an ist (sonst ``None`` = nicht bewertet).

    NS-3 B: hat der Lauf hier den Überschuss-Verbraucher aus der Last genommen
    (``verbraucher``), rechnet auch der sture Slot mit der Grundlast - er
    behält den Grund ``ueberschuss_verbraucher`` und, wo er lädt und trimmt,
    ``charge_hold_base_load_kw``: die Box hält die Ladung gegen den
    Verbraucher, wie in jedem anderen Lade-Slot dieses Laufs."""

    def pflicht(name, wert):
        return bool(wert) if schalter[name] else None

    laden = battery_kw > PLANNED_IDLE_DEADBAND_KW
    entladen = battery_kw < -PLANNED_IDLE_DEADBAND_KW
    ruhe = not laden and not entladen
    platz = soc < batt.soc_max_kwh - 1e-6
    ueberschuss = slot.pv_kw - slot.load_kw >= 0.0
    trimmt = schalter["trim"] and laden
    halten = verbraucher and trimmt and math.isfinite(slot.load_kw) and slot.load_kw >= 0.0
    return dict(
        slot_role="pv_speichern" if laden else ("eigenverbrauch" if entladen else "warten"),
        slot_flags=(SLOT_FLAG_VORSPRUNG_AUFGEBRAUCHT,)
        + ((SLOT_FLAG_UEBERSCHUSS_VERBRAUCHER,) if verbraucher else ()),
        charge_hold_base_load_kw=round(slot.load_kw, 3) if halten else None,
        why_next_best=None,
        why_next_best_margin_ct=None,
        charge_from_surplus_only=pflicht("trim", laden),
        charge_surplus_to_battery=pflicht("absorb", laden or (ruhe and ueberschuss and platz)),
        cover_load_from_battery=pflicht("follow", entladen),
        limit_discharge_to_load=pflicht("limiting", entladen),
        unplanned_load_discharge=pflicht("unforeseen", ruhe and not ueberschuss),
    )


def _utc(ts: datetime) -> datetime:
    return ts if ts.tzinfo is not None else ts.replace(tzinfo=timezone.utc)


def _log(inp: OptimizationInput, bericht: Bericht) -> None:
    kontext = {
        "site_id": str(inp.site_id),
        "budget_eur": inp.vorsprung_budget_eur,
        "ohne_budget": bericht.ohne_budget,
        "eingriffe": len(bericht.eingriffe),
        "erster_slot_stur": 0 in bericht.eingriffe,
        "tiefster_monat_eur": bericht.tiefster_monat_eur,
        "tiefster_sieben_eur": bericht.tiefster_sieben_eur,
    }
    if inp.vorsprung is not None:
        kontext.update(
            monat_eur=inp.vorsprung.monat_eur,
            sieben_tage_eur=inp.vorsprung.sieben_tage_eur,
            vorsprung_kwh=inp.vorsprung.vorsprung_kwh,
            messung_bis=_utc(inp.vorsprung.messung_bis).isoformat(),
        )
    logger.info("vorsprung.budget", extra={"context": kontext})
