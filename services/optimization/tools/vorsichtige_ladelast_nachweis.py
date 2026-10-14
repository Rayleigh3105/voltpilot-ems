"""Nachweis zu Paket P1 (Captain-Entscheid HZ-1 A vom 14.10.2026): die
gespeicherten Optimierer-Läufe eines Zeitraums MIT und OHNE vorsichtige
Lade-Last nachrechnen (:mod:`voltpilot_optimization.vorsichtige_ladelast`).

Aufruf aus ``services/optimization`` in der Testumgebung (Solver installiert)::

    PYTHONPATH=.:../forecast python tools/vorsichtige_ladelast_nachweis.py \\
        --diag <ordner mit diag_P_<tag>.json> --von 2026-10-01 --bis 2026-10-13

``--diag`` ist der Ordner ``cloud/`` des Scouts ``vp-herzogau-minus-erloes-k4``:
je Tag alle Läufe der Admin-Route ``optimizer-diagnostics`` einer Anlage
(Plan, Prognosen, Preise, Ladestand je Lauf). Die Dateien sind Messwerte einer
Kundenanlage und liegen deshalb nicht im Repo.

RECHENWEG
---------
Jeder Tag wird für sich von 00:00 Uhr an mit dem gemessenen Ladestand dieses
Zeitpunkts gerechnet, beide Varianten aus demselben Stand:

1. Je Viertelstunde der Lauf, der an ihrem Anfang gerechnet hat, mit seinen
   gespeicherten Eingaben (Last- und PV-Reihe einschließlich der Messfenster im
   ersten Slot, Bezugspreis, Einspeisewert), aber mit dem NACHGERECHNETEN
   Ladestand. Ohne Lauf fährt die Box den letzten Plan weiter.
2. Der Solver von heute (``solver.optimize`` mit Erklär-Schicht und
   In-Slot-Vollmachten) rechnet den Plan; Variante MIT bekommt dazu
   ``charge_load_kw`` aus der Regel des Moduls.
3. Die Box führt den ersten Slot gegen die GEMESSENE Sonne und Last aus
   (Mittel der Messfenster am Slot-Anfang und -Ende, Sicherheitsaufschlag der
   Last abgezogen - die Näherung des Scout-Werkzeugs ``rekon.py``):
   Laden mit ``charge_from_surplus_only`` höchstens bis zum gemessenen
   Überschuss, mit ``charge_surplus_to_battery`` bis zu ihm hinauf; Entladen
   mit ``limit_discharge_to_load`` höchstens bis zum Defizit, mit
   ``cover_load_from_battery`` bis zu ihm hinauf; ein 0-kW-Slot deckt ein
   Defizit trotzdem (Captain-Entscheid 28.08.2026, ``agent.go``) und nimmt
   Überschuss nur mit ``charge_surplus_to_battery``. Grenzen 30 kW, 5-95 %,
   Wirkungsgrad je Richtung sqrt(0,92); ein Prozentpunkt sind 0,616 kWh (an den
   echten Viertelstunden des 27./28.09.2026 geeicht), der Plan rechnet wie in
   Produktion mit 65 kWh.

Die vorsichtige Lade-Last braucht die gemessene Last der letzten 7 Tage. In
Produktion liest sie das 15-min-Rollup; hier steht dafür (``--m7-quelle``):

* ``prognose`` (Vorgabe): die Viertelstunden-Mittel, die das Persistenz-Modell
  ``load-persistence`` gesehen hat - die gespeicherte Lastprognose eines Laufs
  für ``t`` ist das Mittel von ``t - 1 Tag`` (``services/forecast`` load.py).
  Das sind dieselben rohen ``telemetry``-Zeilen, die auch das Rollup mittelt.
* ``box``: die Messfenster der Läufe (die Sicht der Box).

Nicht nachgebildet: die Nacht-Wertfunktion (die Diagnose trägt ihre Quantile
nicht; beide Varianten rechnen ohne sie), Sekunden-Regelung der Box.

KRITERIEN (Entscheid HZ-1 A)
----------------------------
* 13.10.: Ladestand um 12:45 Uhr (vor dem Anlauf des Verbrauchers) >= 85 %.
* 3., 4., 6., 7., 9.10.: der Preisvorteil des späteren Ladens bleibt zu
  mindestens 80 % erhalten. Preisvorteil wie im Scout-Bericht: (mittlerer
  Einspeisewert, zu dem ein sturer Speicher an denselben Messwerten lädt,
  minus mittlerer Einspeisewert der eigenen Ladung) x eigene Lademenge; der
  sture Speicher läuft durchgehend vom ersten Tag an.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from voltpilot_optimization.domain import BatteryParams, OptimizationInput
from voltpilot_optimization.pricing import SiteTariff, grid_charge_hurdle_ct_kwh
from voltpilot_optimization.solver import optimize
from voltpilot_optimization.vorsichtige_ladelast import (
    TAGE,
    TOLERANZ_SLOTS,
    hoechste_last_der_tageszeit,
    vorsichtige_ladelast,
)

BERLIN = ZoneInfo("Europe/Berlin")
Q = timedelta(minutes=15)
DT = 0.25
ETA = math.sqrt(0.92)
CAP_PLAN = 65.0  # kWh, Nennwert - damit rechnet der Plan
CAP_ECHT = 61.6  # kWh je 100 Prozentpunkte, geeicht (Scout-Werkzeug rekon.py)
P_MAX = 30.0
SOC_MIN, SOC_MAX = 5.0, 95.0
FEED_IN_KW = 75.0
SITE = UUID("063012ff-4be7-4c1f-85c4-498bf555bd12")
TENANT = UUID("e09aa026-9a21-48ee-a117-84f2f9552d74")
KRITERIUM_TAG = date(2026, 10, 13)
KRITERIUM_ZEIT = time(12, 45)
KRITERIUM_SOC = 85.0
VORTEIL_TAGE = [date(2026, 10, d) for d in (3, 4, 6, 7, 9)]
VORTEIL_ANTEIL = 0.80
TOT_KW = 0.05
BEZUG_CT = 25.0


def _zeit(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)


def _last_gemessen(slot0_kw: float) -> float:
    """Den Sicherheitsaufschlag des Laufs (5 %, höchstens 2 kW) abziehen."""
    return slot0_kw / 1.05 if slot0_kw <= 42.0 else slot0_kw - 2.0


@dataclass
class Daten:
    laeufe: dict[datetime, dict]  # Slot-Anfang (UTC) -> Lauf in Kraft
    pv: dict[datetime, float]  # gemessene Sonne je Slot (kW)
    last: dict[datetime, float]  # gemessene Last je Slot (kW, Sicht der Box)
    last_prognose: dict[datetime, float]  # Slot -> Mittel, wie es das Persistenz-Modell sah


def lade(ordner: Path) -> Daten:
    alle: list[dict] = []
    for datei in sorted(ordner.glob("diag_P_*.json")):
        alle += json.loads(datei.read_text())["laeufe"]
    alle.sort(key=lambda lauf: lauf["generatedAt"])
    laeufe: dict[datetime, dict] = {}
    for lauf in alle:
        if not lauf["n"]:
            continue
        slot = _zeit(lauf["time"][0])
        gen = _zeit(lauf["generatedAt"])
        regulaer = gen.minute % 15 == 0 and gen.second < 30
        if slot not in laeufe or (regulaer and not laeufe[slot]["_regulaer"]):
            laeufe[slot] = {**lauf, "_regulaer": regulaer, "_gen": gen}
    fenster_pv = {s: lauf["pvKw"][0] for s, lauf in laeufe.items()}
    fenster_last = {s: _last_gemessen(lauf["loadKw"][0]) for s, lauf in laeufe.items()}
    pv: dict[datetime, float] = {}
    last: dict[datetime, float] = {}
    for s in laeufe:
        ende = s + Q
        pv[s] = (fenster_pv[s] + fenster_pv.get(ende, fenster_pv[s])) / 2
        last[s] = (fenster_last[s] + fenster_last.get(ende, fenster_last[s])) / 2
    # Was das Persistenz-Modell gemessen hat: Prognose fuer t = Mittel von
    # t - 1 Tag. Nur Slots ab dem neunten (Last-Korrektur und Aufschlag sind
    # dort ausgeklungen) und nur Quellen, die zum Laufzeitpunkt sicher
    # abgeschlossen waren; der juengste Lauf gewinnt.
    last_prognose: dict[datetime, float] = {}
    for lauf in alle:
        gen = _zeit(lauf["generatedAt"])
        for i in range(8, lauf["n"]):
            quelle = _zeit(lauf["time"][i]) - timedelta(days=1)
            if quelle + Q <= gen - timedelta(minutes=30):
                last_prognose[quelle] = lauf["loadKw"][i]
    return Daten(laeufe=laeufe, pv=pv, last=last, last_prognose=last_prognose)


def gemessen_bis(daten: Daten, quelle: str, jetzt: datetime) -> dict[datetime, float]:
    """Die gemessene Last je Slot, wie sie zum Zeitpunkt ``jetzt`` bekannt war."""
    if quelle == "box":
        return {s: v for s, v in daten.last.items() if s + 2 * Q <= jetzt}
    return {s: v for s, v in daten.last_prognose.items() if s + Q <= jetzt}


def eingabe(lauf: dict, soc_pct: float, charge_load: list[float] | None) -> OptimizationInput:
    batterie = lauf["battery"]
    tarif = SiteTariff(tarif_art=lauf["tarifArt"], tarif_param_ct_kwh=lauf["tarifParamCtKwh"])
    return OptimizationInput(
        tenant_id=TENANT,
        site_id=SITE,
        device_id=None,
        battery=BatteryParams(
            capacity_kwh=CAP_PLAN,
            max_charge_kw=P_MAX,
            max_discharge_kw=P_MAX,
            soc_min_fraction=batterie["socMinPct"] / 100.0,
            soc_max_fraction=batterie["socMaxPct"] / 100.0,
            wear_cost_ct_per_kwh=batterie["wearCostCtPerKwh"],
        ),
        slot_starts=[_zeit(t) for t in lauf["time"]],
        prices_eur_mwh=[p * 10.0 for p in lauf["solverPriceCtKwh"]],
        load_kw=list(lauf["loadKw"]),
        pv_kw=list(lauf["pvKw"]),
        initial_soc_kwh=soc_pct / 100.0 * CAP_PLAN,
        netzladen_erlaubt=lauf["netzladenErlaubt"],
        max_feed_in_kw=FEED_IN_KW,
        import_price_eur_mwh=[p * 10.0 for p in lauf["importPriceCtKwh"]],
        export_value_eur_mwh=[p * 10.0 for p in lauf["exportValueCtKwh"]],
        grid_charge_hurdle_ct_kwh=grid_charge_hurdle_ct_kwh(tarif),
        charge_load_kw=charge_load,
    )


def box(slot, pv: float, last: float, soc_pct: float) -> tuple[float, float]:
    """Was die Box in der Viertelstunde lädt und entlädt (kW AC)."""
    ueberschuss = pv - last
    soll = slot.battery_kw
    laden = entladen = 0.0
    if soll > TOT_KW:
        laden = soll
        if slot.charge_from_surplus_only:
            laden = min(laden, max(ueberschuss, 0.0))
        if slot.charge_surplus_to_battery:
            laden = max(laden, max(ueberschuss, 0.0))
    elif soll < -TOT_KW:
        entladen = -soll
        if slot.limit_discharge_to_load:
            entladen = min(entladen, max(-ueberschuss, 0.0))
        if slot.cover_load_from_battery:
            entladen = max(entladen, max(-ueberschuss, 0.0))
    elif ueberschuss > 0.0:
        laden = ueberschuss if slot.charge_surplus_to_battery else 0.0
    else:
        entladen = -ueberschuss
    raum = (SOC_MAX - soc_pct) / 100.0 * CAP_ECHT
    vorrat = (soc_pct - SOC_MIN) / 100.0 * CAP_ECHT
    laden = max(min(laden, P_MAX, raum / ETA / DT), 0.0)
    entladen = max(min(entladen, P_MAX, vorrat * ETA / DT), 0.0)
    return laden, entladen


def soc_am_anfang(lauf: dict) -> float | None:
    """Gemessener Ladestand am Laufbeginn (die Diagnose nennt den Stand am
    Slot-ENDE; die geplante Änderung des ersten Slots wird zurückgerechnet)."""
    ende = lauf["socPct"][0]
    if ende is None:
        return None
    plan = lauf["batteryKw"][0] or 0.0
    delta = (ETA * plan * DT if plan > 0 else plan * DT / ETA) / CAP_PLAN * 100.0
    return ende - delta


def tag_slots(tag: date) -> list[datetime]:
    anfang = datetime.combine(tag, time(0), tzinfo=BERLIN).astimezone(timezone.utc)
    ende = datetime.combine(tag + timedelta(days=1), time(0), tzinfo=BERLIN).astimezone(
        timezone.utc
    )
    out = []
    s = anfang
    while s < ende:
        out.append(s)
        s += Q
    return out


def rechne_tag(aufgabe: tuple) -> dict:
    ordner, tag_text, quelle, mit, fenster, tage, toleranz = aufgabe
    daten = lade(ordner)
    tag = date.fromisoformat(tag_text)
    slots = tag_slots(tag)
    # Ab dem ersten Lauf des Tages mit gemessenem Ladestand (meist 00:00 Uhr).
    while slots and (
        daten.laeufe.get(slots[0]) is None or soc_am_anfang(daten.laeufe[slots[0]]) is None
    ):
        slots = slots[1:]
    if not slots:
        return {"tag": tag_text, "mit": mit, "fehlt": "kein Lauf mit Ladestand"}
    soc = soc_am_anfang(daten.laeufe[slots[0]])
    plan = None
    zeilen = []
    gehoben_slots = 0
    for s in slots:
        lauf = daten.laeufe.get(s)
        if lauf is not None:
            charge_load = None
            if mit:
                eingang = eingabe(lauf, soc, None)
                hoechste = hoechste_last_der_tageszeit(
                    gemessen_bis(daten, quelle, s),
                    eingang.slot_starts,
                    s,
                    tage=tage,
                    toleranz_slots=toleranz,
                )
                charge_load = vorsichtige_ladelast(
                    eingang.load_kw,
                    hoechste,
                    eingang.pv_kw if fenster == "laufend" else None,
                )
            plan = optimize(eingabe(lauf, soc, charge_load), uuid4(), lauf["_gen"])
            if charge_load is not None and charge_load[1] > lauf["loadKw"][1]:
                gehoben_slots += 1
        if plan is None or s not in daten.pv:
            zeilen.append({"t": s, "soc": soc, "laden": 0.0, "entladen": 0.0, "fehlt": True})
            continue
        slot = next((x for x in plan.slots if x.start == s), None)
        if slot is None:
            zeilen.append({"t": s, "soc": soc, "laden": 0.0, "entladen": 0.0, "fehlt": True})
            continue
        laden, entladen = box(slot, daten.pv[s], daten.last[s], soc)
        lauf_preis = daten.laeufe.get(s) or {}
        preis = (lauf_preis.get("exportValueCtKwh") or [slot.price_eur_mwh / 10.0])[0]
        bezug_preis = (lauf_preis.get("importPriceCtKwh") or [BEZUG_CT])[0]
        netz = daten.last[s] - daten.pv[s] + laden - entladen
        zeilen.append(
            {
                "t": s,
                "soc": soc,
                "laden": laden,
                "entladen": entladen,
                "soll": slot.battery_kw,
                "preis": preis,
                "bezug_preis": bezug_preis,
                "ergebnis": (max(-netz, 0.0) * preis - max(netz, 0.0) * bezug_preis) * DT / 100.0,
            }
        )
        soc += (ETA * laden - entladen / ETA) * DT / CAP_ECHT * 100.0
    return {
        "tag": tag_text,
        "mit": mit,
        "zeilen": [{**z, "t": z["t"].isoformat()} for z in zeilen],
        "soc_ende": soc,
        "laeufe_gehoben": gehoben_slots,
    }


def stur(daten: Daten, tage: list[date]) -> dict[datetime, float]:
    """Laden des sturen Vergleichsspeichers (kW je Slot) an denselben
    Messwerten, durchgehend vom ersten Tag an (Scout-Werkzeug ``rekon.Stur``)."""
    slots = [s for tag in tage for s in tag_slots(tag)]
    erster = daten.laeufe.get(slots[0])
    soc_kwh = (soc_am_anfang(erster) or SOC_MIN) / 100.0 * CAP_PLAN
    tief, hoch = CAP_PLAN * SOC_MIN / 100.0, CAP_PLAN * SOC_MAX / 100.0
    out = {}
    for s in slots:
        if s not in daten.pv:
            out[s] = 0.0
            continue
        ueberschuss = (daten.pv[s] - daten.last[s]) * DT
        laden = 0.0
        if ueberschuss > 0:
            laden = max(min(ueberschuss, P_MAX * DT, (hoch - soc_kwh) / ETA), 0.0)
            soc_kwh += ETA * laden
        elif ueberschuss < 0:
            entladen = max(min(-ueberschuss, P_MAX * DT, (soc_kwh - tief) * ETA), 0.0)
            soc_kwh -= entladen / ETA
        out[s] = laden / DT
    return out


def kennzahlen(ergebnis: dict, stur_kw: dict[datetime, float], daten: Daten) -> dict:
    zeilen = ergebnis["zeilen"]
    geladen = sum(z["laden"] for z in zeilen) * DT
    lade_preis = (
        sum(z["laden"] * z.get("preis", 0.0) for z in zeilen) * DT / geladen if geladen > 0 else None
    )
    stur_geladen = stur_preis_summe = 0.0
    for z in zeilen:
        s = datetime.fromisoformat(z["t"])
        lauf = daten.laeufe.get(s)
        if lauf is None:
            continue
        stur_geladen += stur_kw.get(s, 0.0) * DT
        stur_preis_summe += stur_kw.get(s, 0.0) * DT * lauf["exportValueCtKwh"][0]
    stur_preis = stur_preis_summe / stur_geladen if stur_geladen > 0 else None
    vorteil = None
    if geladen >= 5.0 and stur_geladen >= 5.0:
        vorteil = (stur_preis - lade_preis) / 100.0 * geladen
    soc_1245 = None
    for z in zeilen:
        lokal = datetime.fromisoformat(z["t"]).astimezone(BERLIN)
        if lokal.time() == KRITERIUM_ZEIT:
            soc_1245 = z["soc"]
    erstes_laden = next(
        (
            datetime.fromisoformat(z["t"]).astimezone(BERLIN).strftime("%H:%M")
            for z in zeilen
            if z["laden"] > 1.0
        ),
        None,
    )
    return {
        "geladen_kwh": geladen,
        "lade_ct": lade_preis,
        "stur_ct": stur_preis,
        "vorteil_eur": vorteil,
        "soc_1245": soc_1245,
        "soc_max": max(z["soc"] for z in zeilen),
        "soc_ende": ergebnis["soc_ende"],
        "ergebnis_eur": sum(z.get("ergebnis", 0.0) for z in zeilen),
        # Der Bestand am Tagesende, bewertet wie im Scout-Bericht: was er an
        # Bezug zum Bezugspreis erspart.
        "bestand_eur": ergebnis["soc_ende"] / 100.0 * CAP_ECHT * ETA * BEZUG_CT / 100.0,
        "erstes_laden": erstes_laden,
        "laeufe_gehoben": ergebnis["laeufe_gehoben"],
    }


def gemessen_tag(daten: Daten, tag: date) -> dict:
    """Der echte Tag laut Diagnose (Ladestand je Lauf) - die Gegenprobe der
    Nachrechnung OHNE."""
    werte = {}
    for s in tag_slots(tag):
        lauf = daten.laeufe.get(s)
        if lauf is not None and (soc := soc_am_anfang(lauf)) is not None:
            werte[s] = soc
    soc_1245 = next(
        (v for s, v in werte.items() if s.astimezone(BERLIN).time() == KRITERIUM_ZEIT), None
    )
    return {"soc_1245": soc_1245, "soc_max": max(werte.values()) if werte else None}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--diag", type=Path, required=True)
    parser.add_argument("--von", type=date.fromisoformat, default=date(2026, 10, 1))
    parser.add_argument("--bis", type=date.fromisoformat, default=date(2026, 10, 13))
    parser.add_argument("--m7-quelle", choices=("prognose", "box"), default="prognose")
    parser.add_argument(
        "--fenster",
        choices=("laufend", "horizont"),
        default="laufend",
        help="laufend: nur im laufenden Sonnenfenster (wie in Produktion); "
        "horizont: jede Überschuss-Viertelstunde des Horizonts",
    )
    parser.add_argument("--tage", type=int, default=TAGE, help="Empfindlichkeit: Tage zurück")
    parser.add_argument(
        "--toleranz", type=int, default=TOLERANZ_SLOTS, help="Empfindlichkeit: Toleranz in Slots"
    )
    parser.add_argument("--prozesse", type=int, default=2)
    parser.add_argument("--json", type=Path, help="Ergebnis zusätzlich als JSON")
    args = parser.parse_args(argv)

    tage = []
    tag = args.von
    while tag <= args.bis:
        tage.append(tag)
        tag += timedelta(days=1)
    daten = lade(args.diag)
    aufgaben = [
        (args.diag, t.isoformat(), args.m7_quelle, mit, args.fenster, args.tage, args.toleranz)
        for t in tage
        for mit in (False, True)
    ]
    with ProcessPoolExecutor(max_workers=max(args.prozesse, 1)) as pool:
        ergebnisse = list(pool.map(rechne_tag, aufgaben))
    stur_kw = stur(daten, tage)

    tabelle = []
    for t in tage:
        ohne = next(e for e in ergebnisse if e["tag"] == t.isoformat() and not e["mit"])
        mit = next(e for e in ergebnisse if e["tag"] == t.isoformat() and e["mit"])
        if "fehlt" in ohne or "fehlt" in mit:
            tabelle.append({"tag": t.isoformat(), "fehlt": ohne.get("fehlt") or mit.get("fehlt")})
            continue
        tabelle.append(
            {
                "tag": t.isoformat(),
                "echt": gemessen_tag(daten, t),
                "ohne": kennzahlen(ohne, stur_kw, daten),
                "mit": kennzahlen(mit, stur_kw, daten),
            }
        )

    def f(x, n=1, suffix=""):
        return "–" if x is None else f"{x:.{n}f}{suffix}"

    print(
        f"M7-Quelle: {args.m7_quelle}, Fenster: {args.fenster}, "
        f"Tage: {args.tage}, Toleranz: {args.toleranz} Slots"
    )
    print(
        "| Tag | echt SoC 12:45 / max | ohne: SoC 12:45 / max, erstes Laden, geladen, Ø ct, Vorteil "
        "| mit: SoC 12:45 / max, erstes Laden, geladen, Ø ct, Vorteil | Vorteil erhalten "
        "| Tagesergebnis mit Bestand mit−ohne |"
    )
    print("|---|---|---|---|---|---|")
    urteile = []
    for z in tabelle:
        if "fehlt" in z:
            print(f"| {z['tag']} | {z['fehlt']} | | | | |")
            continue
        o, m, e = z["ohne"], z["mit"], z["echt"]
        anteil = None
        if o["vorteil_eur"] and m["vorteil_eur"] is not None and o["vorteil_eur"] > 0:
            anteil = m["vorteil_eur"] / o["vorteil_eur"]
        print(
            f"| {z['tag'][8:]}.{z['tag'][5:7]}. | {f(e['soc_1245'], 0)} / {f(e['soc_max'], 0)} % "
            f"| {f(o['soc_1245'], 0)} / {f(o['soc_max'], 0)} %, {o['erstes_laden'] or '–'}, "
            f"{f(o['geladen_kwh'])} kWh, {f(o['lade_ct'])} ct, {f(o['vorteil_eur'], 2)} € "
            f"| {f(m['soc_1245'], 0)} / {f(m['soc_max'], 0)} %, {m['erstes_laden'] or '–'}, "
            f"{f(m['geladen_kwh'])} kWh, {f(m['lade_ct'])} ct, {f(m['vorteil_eur'], 2)} € "
            f"| {f(None if anteil is None else anteil * 100, 0, ' %')} "
            f"| {f(m['ergebnis_eur'] + m['bestand_eur'] - o['ergebnis_eur'] - o['bestand_eur'], 2)} € "
            f"(Ende {f(o['soc_ende'], 0)} → {f(m['soc_ende'], 0)} %) |"
        )
        tag = date.fromisoformat(z["tag"])
        if tag == KRITERIUM_TAG:
            urteile.append(
                (f"{z['tag']} SoC 12:45 mit >= {KRITERIUM_SOC:.0f} %", (m["soc_1245"] or 0) >= KRITERIUM_SOC)
            )
        if tag in VORTEIL_TAGE:
            urteile.append(
                (
                    f"{z['tag']} Vorteil erhalten >= {VORTEIL_ANTEIL * 100:.0f} %",
                    anteil is not None and anteil >= VORTEIL_ANTEIL,
                )
            )
    print()
    for text, ok in urteile:
        print(f"{'erfüllt ' if ok else 'GERISSEN'}  {text}")
    if args.json:
        args.json.write_text(
            json.dumps(
                {
                    "m7_quelle": args.m7_quelle,
                    "fenster": args.fenster,
                    "tage_zurueck": args.tage,
                    "toleranz_slots": args.toleranz,
                    "tage": tabelle,
                },
                indent=1,
            )
        )
    return 0 if all(ok for _, ok in urteile) else 1


if __name__ == "__main__":
    sys.exit(main())
