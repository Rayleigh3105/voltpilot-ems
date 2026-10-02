"""MiSpeL MP-22: Pilot-Durchstich im Simulator (E6 = D, sofort).

Eine Simulator-Anlage mit den Zählern Z1 (Netzanschluss) und Z2 (Speicher) im
Förderweg „Marktprämie mit Abgrenzungsoption“ (Formelsatz A1, A1 S. 32–40)
läuft einen Kalendermonat — Oktober 2026, der erste Monat nach dem Beschluss
vom 01.10.2026 — durch die Teile, die auch die echte Anlage durchläuft:

1. **Optimierer im Mischbetrieb** (MP-10/MP-11/MP-12): je Berliner Tag ein
   Produktions-Plan (:func:`solver.optimize`) mit dem Monatszustand der schon
   festgeschriebenen Tage, Marktprämie mit Jahresmarktwert nur bei AW¼ > 0.
2. **Plan zur Box** (MP-14): die echte Nutzlast
   (:func:`publisher.build_schedule_payload`) mit ``foerderweg`` — die Box
   prüft sie in Go (``edge-app/core/internal/plan/mispel_durchstich_test.go``).
3. **Zählerwerte**: die festgeschriebenen Viertelstunden als Z1NB¼/Z1NE¼
   (Netz) und Z2V¼/Z2E¼ (Speicher) in kWh mit drei Nachkommastellen (Wh, die
   Auflösung eines Zählerregisters).
4. **Rechenwerk** (MP-9): Formeln (1)–(33) von A1 auf diesen Viertelstunden,
   exakt — der Monatslauf der Cloud (MP-8) muss dieselben Zahlen liefern
   (``services/api/.../MispelDurchstichSimulatorTest``), ebenso Nachweis
   (MP-16) und Kundenansicht (MP-18).

Eingänge ohne Netz und ohne Datenbank: Day-Ahead-Preise Oktober/November 2025
(SMARD, CC BY 4.0, ``tests/fixtures/day-ahead-de-lu-2025-10-bis-2026-09.json``)
viertelstundengenau auf Oktober/November 2026 übertragen — beide Oktober haben
2 980 Viertelstunden, der Wechsel auf Winterzeit liegt im Monat (25.10.2026
bzw. 26.10.2025, eine Viertelstunde fällt dadurch für einen Tag um eine Stunde
anders); ein synthetisches Oktoberwetter (Tagesbogen um den Sonnenmittag
11:10 UTC, Bewölkung je Tag aus einer festen Folge); das Gewerbe-Lastprofil
des MiSpeL-Checks. AW¼ > 0 nach der Rückfallregel von MP-12 (Spot ≥ 0, § 51
EEG), wie die ÜNB-Liste der Regel ``viertelstunde`` sie für die Anlage hätte.

Neu schreiben (≈ 2 min, HiGHS):
``python -m voltpilot_optimization.simulation.mispel_durchstich --schreiben``.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from fractions import Fraction
from pathlib import Path
from uuid import UUID, uuid5

from voltpilot_forecast.weather import IrradianceSample

from voltpilot_optimization import mispel_abgrenzung
from voltpilot_optimization.domain import BatteryParams, OptimizationInput
from voltpilot_optimization.marktwertbasis import MarktwertBasis
from voltpilot_optimization.pricing import (
    import_prices,
    marktpraemie_eur_mwh,
    saldierte_bestandteile_eur_mwh,
)
from voltpilot_optimization.publisher import EDGE_PLAN_SLOTS, build_schedule_payload
from voltpilot_optimization.simulation.data import (
    BERLIN,
    expand_price_rows,
    price_rows_from_json,
    window_slot_starts,
)
from voltpilot_optimization.simulation.mispel_check import (
    KUNDENTYPEN,
    STANDARD_FAELLE,
    CheckDeps,
    _pv_reihe,
    _tarif,
    marktwerte_naeherung,
)
from voltpilot_optimization.simulation.profiles import business_series_kw
from voltpilot_optimization.simulation.runner import (
    SLOT_HOURS,
    WINDOW_SLOTS,
    _MonatsBuchung,
)
from voltpilot_optimization.solver import optimize

MONAT = (2026, 10)
FOERDERWEG = "marktpraemie_abgrenzung"
FORMELSATZ = "A1"
#: Gewerbe-Kundentyp a des MiSpeL-Checks (Konzept § 3): 100 kWp, 65 kWh /
#: 30 kW, 60 MWh/a, AW 6,90 ct/kWh; Annahmen-Fall „mittel“.
ANLAGE = KUNDENTYPEN["a"]
FALL = STANDARD_FAELLE["mittel"]
#: Feste Kennungen der Simulator-Anlage — die Nutzlast trägt sie, und eine
#: zufällige ``plan_id`` machte die Fixture bei jedem Lauf anders.
NAMENSRAUM = UUID("6d5a3c2e-22a0-4f6b-9a51-0c0de0022022")
MANDANT = uuid5(NAMENSRAUM, "mandant")
ANLAGE_ID = uuid5(NAMENSRAUM, "anlage")
BOX = uuid5(NAMENSRAUM, "box")

REPO = Path(__file__).resolve().parents[4]
PREISE = REPO / "services/optimization/tests/fixtures/day-ahead-de-lu-2025-10-bis-2026-09.json"
FIXTURE = REPO / "services/optimization/tests/fixtures/mispel-durchstich-2026-10.json"
BOX_FIXTURE = REPO / "edge-app/core/internal/plan/testdata/mispel-durchstich-2026-10.jsonl"

#: Bewölkung je Oktobertag (1 = klar), feste Folge statt Zufall.
BEWOELKUNG = (
    1.0, 0.9, 0.35, 0.6, 0.95, 0.2, 0.75, 0.85, 1.0, 0.5, 0.3, 0.7, 0.9, 0.65, 0.15, 0.4,
    0.8, 1.0, 0.95, 0.55, 0.25, 0.6, 0.85, 0.45, 0.7, 0.9, 0.3, 0.2, 0.65, 0.8, 0.5,
)


class SimulatorWetter:
    """Stündliche Globalstrahlung ohne Netz: ein Sinusbogen um den Sonnenmittag
    (11:10 UTC bei 12,5° Ost), Tageslänge von 11,3 h am 1. auf 9,8 h am
    31. Oktober, Scheitel 450 W/m² (ein sehr sonniger Oktober) × Bewölkung des Tages."""

    def hourly_irradiance(self, latitude, longitude, year):
        index: dict[datetime, IrradianceSample] = {}
        start = datetime(year, 10, 1, tzinfo=timezone.utc) - timedelta(days=1)
        for h in range(24 * 64):
            t = start + timedelta(hours=h)
            tag = (t.date() - date(year, 10, 1)).days
            wolke = BEWOELKUNG[tag % len(BEWOELKUNG)]
            laenge = 11.3 - 1.5 * min(max(tag, 0), 30) / 30
            x = (t.hour + t.minute / 60 + 0.5 - (11.17 - laenge / 2)) / laenge
            if 0 < x < 1:
                index[t] = IrradianceSample(ghi_w_m2=450.0 * wolke * math.sin(math.pi * x) ** 1.2)
        return index


def _berliner_tage(slots: list[datetime], monat: tuple[int, int]) -> list[tuple[date, int, int]]:
    """(Tag, erster Index, Index nach dem letzten) je Berliner Tag des Monats."""
    tage: dict[date, list[int]] = {}
    for i, s in enumerate(slots):
        lokal = s.astimezone(BERLIN)
        if (lokal.year, lokal.month) == monat:
            tage.setdefault(lokal.date(), []).append(i)
    return [(d, idx[0], idx[-1] + 1) for d, idx in sorted(tage.items())]


def _kwh(kw: float) -> Fraction:
    """Zählerwert einer Viertelstunde: kWh auf drei Nachkommastellen (Wh)."""
    return Fraction(round(kw * SLOT_HOURS * 1000), 1000)


def _text(f: Fraction) -> str:
    """Exakte Zahl wie der Nachweis (MP-8): Dezimal, sonst ``z/n``."""
    n = f.denominator
    while n % 2 == 0:
        n //= 2
    while n % 5 == 0:
        n //= 5
    if n != 1:
        return f"{f.numerator}/{f.denominator}"
    stellen = 0
    while (f * 10**stellen).denominator != 1:
        stellen += 1
    ziffern = str(abs((f * 10**stellen).numerator)).rjust(stellen + 1, "0")
    vorzeichen = "-" if f < 0 else ""
    if stellen == 0:
        return vorzeichen + ziffern
    return f"{vorzeichen}{ziffern[:-stellen]}.{ziffern[-stellen:]}"


def durchstich(preis_doc: dict) -> dict:
    """Ein Monat Simulator-Anlage Ende zu Ende bis zum Rechenwerk."""
    jahr, monat = MONAT
    slots = window_slot_starts(jahr, monat, 2)
    vorlage = window_slot_starts(jahr - 1, monat, 2)
    if len(slots) != len(vorlage):
        raise ValueError("Preisvorlage und Monat haben verschieden viele Viertelstunden")
    spot = expand_price_rows(price_rows_from_json(preis_doc), vorlage)
    last = business_series_kw(slots, ANLAGE.jahresverbrauch_kwh * 2 / 12)
    pv = _pv_reihe(ANLAGE, CheckDeps(load_prices=None, weather=SimulatorWetter()), slots)

    tarif = _tarif(ANLAGE, FALL)
    imp = import_prices(tarif, spot)
    saldiert = saldierte_bestandteile_eur_mwh(tarif)
    tage = _berliner_tage(slots, MONAT)
    m_von, m_bis = tage[0][1], tage[-1][2]
    _, jahresmw = marktwerte_naeherung(slots[m_von:m_bis], spot[m_von:m_bis], pv[m_von:m_bis])
    basis = MarktwertBasis(
        mispel_tage=frozenset(s.astimezone(BERLIN).date() for s in slots),
        jahresmarktwert_ct=jahresmw,
    )
    praemie = marktpraemie_eur_mwh(tarif, spot, slots, {}, basis)
    battery = BatteryParams(
        capacity_kwh=ANLAGE.speicher_kwh,
        max_charge_kw=ANLAGE.speicher_kw,
        max_discharge_kw=ANLAGE.speicher_kw,
        roundtrip_efficiency=FALL.wirkungsgrad,
        wear_cost_ct_per_kwh=FALL.verschleiss_ct,
    )

    soc = battery.soc_floor_kwh(battery.soc_max_kwh)
    buchung = _MonatsBuchung()
    netz, speicher, plaene, box = [], [], [], []
    for tag, i0, i1 in tage:
        fenster = slice(i0, i0 + WINDOW_SLOTS)
        inp = OptimizationInput(
            tenant_id=MANDANT,
            site_id=ANLAGE_ID,
            device_id=BOX,
            battery=battery,
            slot_starts=slots[fenster],
            prices_eur_mwh=spot[fenster],
            load_kw=last[fenster],
            pv_kw=pv[fenster],
            initial_soc_kwh=soc,
            netzladen_erlaubt=True,
            import_price_eur_mwh=imp[fenster],
            export_value_eur_mwh=spot[fenster],
        )
        inp = replace(
            inp,
            foerderweg=FOERDERWEG,
            mischbetrieb=True,
            mispel_formelsatz=FORMELSATZ,
            mispel_praemie_eur_mwh=praemie[fenster],
            saldierte_bestandteile_eur_mwh=saldiert,
            mispel_monatsstand=buchung.staende(
                slots[i0], slots[fenster], battery.roundtrip_efficiency
            ),
        )
        plan = optimize(inp, uuid5(NAMENSRAUM, f"plan {tag}"), slots[i0], explain_plan=False)
        fest = plan.slots[: i1 - i0]
        soc = fest[-1].soc_kwh
        buchung.buche(slots[i0], fest)
        netz += [s.grid_kw for s in fest]
        speicher += [s.battery_kw for s in fest]
        nutzlast = build_schedule_payload(plan)
        plaene.append({
            "tag": tag.isoformat(),
            "plan_id": nutzlast["plan_id"],
            "foerderweg": nutzlast.get("foerderweg"),
            "grid_charge_allowed": nutzlast.get("grid_charge_allowed"),
            "viertelstunden": i1 - i0,
            "nutzlast_viertelstunden": len(nutzlast["slots"]),
        })
        n = min(EDGE_PLAN_SLOTS, i1 - i0)
        box.append({
            "nutzlast": nutzlast,
            "pv_kw": [round(v, 3) for v in pv[i0:i0 + n]],
            "last_kw": [round(v, 3) for v in last[i0:i0 + n]],
        })

    qhs = []
    aw = []
    for k, i in enumerate(range(m_von, m_bis)):
        aw.append(1 if spot[i] >= 0 else 0)
        qhs.append({
            "beginn": slots[i],
            "Z1NB¼": _kwh(max(netz[k], 0.0)),
            "Z1NE¼": _kwh(max(-netz[k], 0.0)),
            "Z2V¼": _kwh(max(speicher[k], 0.0)),
            "Z2E¼": _kwh(max(-speicher[k], 0.0)),
            "AW¼": Fraction(aw[-1]),
        })
    ergebnis = mispel_abgrenzung.rechne(FORMELSATZ, qhs)
    schluessel = f"{jahr:04d}-{monat:02d}"
    monatswerte = ergebnis.monate[schluessel]

    netzladen = sum(
        max(speicher[k] - pv[i], 0.0) * SLOT_HOURS for k, i in enumerate(range(m_von, m_bis))
    )
    doc = {
        "$comment": (
            "MiSpeL MP-22: ein Monat Simulator-Anlage (Z1/Z2, Abgrenzungsoption A1) aus Optimierer im "
            "Mischbetrieb und Plan zur Box, Zählerwerte je Viertelstunde und das Rechenwerk (1)-(33) darauf. "
            "Erzeugt von voltpilot_optimization.simulation.mispel_durchstich - nicht von Hand ändern."
        ),
        "monat": schluessel,
        "anlage": {
            "foerderweg": FOERDERWEG,
            "formelsatz": FORMELSATZ,
            "awRegel": "viertelstunde",
            "anzulegenderWertCt": ANLAGE.anzulegender_wert_ct,
            "pvKwp": ANLAGE.pv_kwp,
            "speicherKwh": ANLAGE.speicher_kwh,
            "speicherKw": ANLAGE.speicher_kw,
            "jahresverbrauchKwh": ANLAGE.jahresverbrauch_kwh,
            "umlagenCt": ANLAGE.umlagen_ct,
            "netzentgeltArbeitspreisCt": ANLAGE.netzentgelt_arbeitspreis_ct,
            "jahresmarktwertCt": {str(j): round(v, 4) for j, v in jahresmw.items()},
            "mandant": str(MANDANT),
            "anlageId": str(ANLAGE_ID),
            "box": str(BOX),
        },
        "quellen": {
            "preise": "SMARD Day-Ahead DE-LU 10-11/2025 (CC BY 4.0), viertelstundengenau auf 10-11/2026",
            "wetter": "synthetisch (SimulatorWetter), Bewölkung je Tag fest",
            "last": "Gewerbe-Lastprofil des MiSpeL-Checks, 60 MWh/a",
            "aw": "AW¼ > 0 bei Spot >= 0 (Rückfallregel MP-12, § 51 EEG)",
        },
        "kennzahlen": {
            "pvKwh": round(sum(pv[m_von:m_bis]) * SLOT_HOURS, 3),
            "lastKwh": round(sum(last[m_von:m_bis]) * SLOT_HOURS, 3),
            "planNetzladenKwh": round(netzladen, 3),
            "negativeViertelstunden": len(aw) - sum(aw),
        },
        "viertelstunden": {
            "beginn": slots[m_von].isoformat().replace("+00:00", "Z"),
            "anzahl": m_bis - m_von,
            "Z1NB": [_text(q["Z1NB¼"]) for q in qhs],
            "Z1NE": [_text(q["Z1NE¼"]) for q in qhs],
            "Z2V": [_text(q["Z2V¼"]) for q in qhs],
            "Z2E": [_text(q["Z2E¼"]) for q in qhs],
            "AWgroesserNull": aw,
        },
        "rechenwerk": {k: _text(v) for k, v in monatswerte.items()},
        "plaene": plaene,
    }
    return {"fixture": doc, "box": box}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--schreiben", action="store_true", help="Fixtures neu schreiben")
    args = parser.parse_args(argv)
    with open(PREISE, encoding="utf-8") as fh:
        out = durchstich(json.load(fh))
    text = json.dumps(out["fixture"], ensure_ascii=False, indent=1) + "\n"
    zeilen = "".join(json.dumps(z, ensure_ascii=False, separators=(",", ":")) + "\n" for z in out["box"])
    if args.schreiben:
        FIXTURE.write_text(text, encoding="utf-8")
        BOX_FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        BOX_FIXTURE.write_text(zeilen, encoding="utf-8")
    json.dump({"rechenwerk": out["fixture"]["rechenwerk"], "kennzahlen": out["fixture"]["kennzahlen"]},
              sys.stdout, ensure_ascii=False, indent=1)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
