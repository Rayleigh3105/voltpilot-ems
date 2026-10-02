"""MiSpeL MP-13: der MiSpeL-Check in der Ganzjahres-Simulation.

Rechnet für DIESELBE Anlage über ein Jahresfenster echter Viertelstundenpreise
(z. B. 10/2025-09/2026) drei Fahrweisen und liefert das Ergebnis als Daten -
die Anzeige baut MP-48 nach abgestimmtem Bedienkonzept:

- **stur** - der sture Speicher (:mod:`voltpilot_optimization.stur`, Greedy-
  Szenario (b)) zu den Bedingungen von heute: die MESSLATTE. Verglichen wird
  immer gegen den sturen Speicher derselben Anlage, nie gegen „ohne Speicher“
  (Captain 04.09.2026).
- **heute** - die unveränderte Produktions-MILP in der Betriebsart von heute:
  A1 im EEG-Modus (Ausschließlichkeitsoption, nur Solarladen, Marktprämie auf
  den Monatsmarktwert), A10/A11 als Händler (Netzladen ohne Saldierung).
- **mitMispel** - dieselbe MILP mit MiSpeL (Festlegung BNetzA Az. 618-25-02,
  Beschluss 01.10.2026, Anlage 1 Abgrenzungsoption): A1 im Mischbetrieb
  (MP-10, zwei Ladewege und Farben) mit Monatszustand (MP-11, Formel (16)) und
  Jahresmarktwert/AW¼ (MP-12); A10/A11 mit der Saldierung ihres Formelsatzes.
  Bewertet wird diese Variante mit dem Rechenwerk (MP-9) über die Formeln
  (1)-(33) - die Mengen, die eine Mengenbestimmung ergäbe, nicht die des
  Optimierers: umlagereduzierende Menge (20) × saldierte Bestandteile und
  förderfähige Einspeisung (32) × Marktprämie auf den Jahresmarktwert.

Ergebnis je Annahmen-Fall (niedrig / mittel / hoch, Konzept § 3 „Gemeinsame
Annahmen“) und als Spanne „Differenz mit MiSpeL - heute“ mit allen Annahmen
und ihrer Herkunft. Formelsätze im Check: A1, A10, A11 (Stufe 1, Konzept
§ 8.5) und - MP-29 - der Basisfall P1 „Stromspeicher“ der Pauschaloption
(Anlage 2 Abschn. 4.1.1, S. 25; Haushalt bis 30 kWp, Kundentyp c1): heute
mit fester Einspeisevergütung und Laden nur aus PV, mit MiSpeL dieselbe
MILP mit Netzladen und dem Jahreszustand aus MP-26 (bis (P1) Prämie auf den
Jahresmarktwert, zwischen (P1) und (P4) nichts, darüber Saldierung bis zum
Jahres-Netzbezug), bewertet mit dem Rechenwerk MP-25 über (P1)-(P15). Jeder
andere Formelsatz bekommt „noch nicht unterstützt“ statt einer Näherung
(A5/A5-Variante brauchen zwei Erzeugungsanlagen mit eigenem anzulegenden
Wert, die das Anlagenmodell der Simulation nicht kennt; P2-P5 Ladepunkt,
mehrere Solaranlagen oder Wärmepumpenzähler ebenso).

Preise und Wetter sind ohne Datenbank einspeisbar
(:func:`voltpilot_optimization.simulation.data.price_rows_from_json`,
:class:`ArchivDateiWetter`); alles hier ist reine Rechnung über injizierte
Daten. Aufruf über die Kommandozeile: ``python -m
voltpilot_optimization.simulation.mispel_check --help``.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field, replace
from datetime import date, datetime
from fractions import Fraction
from typing import Callable

from voltpilot_forecast.domain import GeoLocation, PlantSpec, SiteForecastConfig
from voltpilot_forecast.pv import PhysicalPvForecaster
from voltpilot_forecast.weather import IrradianceSample

from voltpilot_optimization import mispel_abgrenzung, mispel_pauschal
from voltpilot_optimization.domain import BatteryParams
from voltpilot_optimization.marktwertbasis import MarktwertBasis
from voltpilot_optimization.pricing import (
    PLANT_KIND_DIREKTVERMARKTUNG,
    PLANT_KIND_EIGENVERBRAUCH,
    TARIF_DYNAMISCH,
    SiteTariff,
    SupplyPriceComponents,
    berlin_month,
    export_values,
    import_prices,
    marktpraemie_eur_mwh,
    saldierte_bestandteile_eur_mwh,
)
from voltpilot_optimization.simulation.archive import (
    ArchiveWeatherProvider,
    parse_archive_response,
)
from voltpilot_optimization.simulation.data import (
    BERLIN,
    expand_price_rows,
    price_rows_from_json,
    window_slot_starts,
)
from voltpilot_optimization.simulation.profiles import business_series_kw, load_series_kw
from voltpilot_optimization.simulation.runner import (
    SLOT_HOURS,
    Dispatch,
    WeatherSourceLike,
    YearData,
    evaluate,
    run_milp_year,
    scenario_b_dispatch,
)

#: Formelsätze, die der Check rechnet (Konzept § 8.5, Stufe 1 ohne A5; MP-29
#: der Basisfall P1 „Stromspeicher“ der Pauschaloption, A2 Abschn. 4.1.1 S. 25).
CHECK_FORMELSAETZE = ("A1", "A10", "A11", "P1")
PAUSCHAL_FORMELSAETZE = ("P1",)
#: Die Pauschaloption gilt für Solaranlagen bis 30 kWp (A2 Abschn. 2.1.3, S. 9;
#: Pinst zählt alle Solaranlagen hinter der Einspeisestelle, A2 S. 9 Fn. 6).
PAUSCHAL_MAX_KWP = 30.0
#: § 53 EEG: die Einspeisevergütung ist der anzulegende Wert abzüglich 0,4 ct/kWh
#: (Solar) - der Unterschied zwischen heute und der Marktprämie (Konzept § 3 c1).
EV_ABZUG_CT = 0.4
NICHT_UNTERSTUETZT = "noch nicht unterstützt"
FAELLE = ("niedrig", "mittel", "hoch")


@dataclass(frozen=True)
class Annahme:
    """Eine offengelegte Annahme mit Herkunft (Konzept § 3)."""

    wert: object
    quelle: str
    art: str  # belegt | Schätzung | Lesart | Annahme | Näherung

    def json(self, name: str) -> dict:
        return {"name": name, "wert": self.wert, "quelle": self.quelle, "art": self.art}


@dataclass(frozen=True)
class Fall:
    """Die Annahmen eines Falls; alle Werte ct/kWh netto, sofern nicht anders
    genannt. Vorgaben: Konzept § 3 „Gemeinsame Annahmen“ und Kundentyp-Tabellen."""

    verschleiss_ct: float  # je entladene kWh
    wirkungsgrad: float  # Rundlauf
    stromsteuer_ct: float
    beschaffung_ct: float
    realisierung: float  # Anteil des Werts bei voller Voraussicht
    zaehler_z2_eur: float = 0.0  # je Jahr, negativ = Kosten (nur A1)
    bilanzkreis_eur: float = 0.0  # je Jahr, negativ = Kosten (nur A1)
    vermarktung_ct: float = 0.0  # je zusätzlich zurückgespeister kWh (A10/A11)
    direktvermarktung_eur: float = 0.0  # je Jahr, negativ = Kosten (nur P1)
    messstelle_eur: float = 0.0  # Mehrkosten Messstellenbetrieb je Jahr (nur P1)


#: Konzept § 3: Verschleiß 4,0/2,5/1,0 · Rundlauf 0,88/0,90/0,92 · Stromsteuer
#: 2,05/2,05/0 (saldierbar nur über die Kann-Regel § 11a Abs. 3 StromStV, R1
#: O-7) · Beschaffung 1,0/0,6/0,3 · Realisierung 0,55/0,70/0,80 · Z2 und
#: Bilanzkreis aus Kundentyp a2 · Vermarktungsentgelt aus Kundentyp b ·
#: Direktvermarktungsentgelt und Messstellenbetrieb aus Kundentyp c1.
STANDARD_FAELLE = {
    "niedrig": Fall(4.0, 0.88, 2.05, 1.0, 0.55, -800.0, -300.0, 0.5, -120.0, -50.0),
    "mittel": Fall(2.5, 0.90, 2.05, 0.6, 0.70, -450.0, -150.0, 0.3, -60.0, -20.0),
    "hoch": Fall(1.0, 0.92, 0.0, 0.3, 0.80, -200.0, 0.0, 0.2, 0.0, 0.0),
}


@dataclass(frozen=True)
class CheckAnlage:
    """Die Anlage, für die der Check rechnet - ihre Stammdaten löst später die
    API auf (wie bei der Ersparnis-Simulation)."""

    formelsatz: str
    speicher_kwh: float
    speicher_kw: float
    pv_kwp: float = 0.0
    latitude: float = 48.6
    longitude: float = 12.5
    azimuth_deg: float = 180.0
    tilt_deg: float = 30.0
    jahresverbrauch_kwh: float = 0.0  # 0 = kein sonstiger Verbrauch
    profil: str = "gewerbe"
    anzulegender_wert_ct: float | None = None  # A1/P1: Marktprämien-Anlage
    #: P1: die feste Einspeisevergütung von heute (ct/kWh); ``None`` = der
    #: anzulegende Wert abzüglich 0,4 ct (§ 53 EEG).
    einspeiseverguetung_ct: float | None = None
    #: MP-13b: die GEMESSENE Erzeugung im Jahr (kWh) - die simulierte PV-Reihe
    #: wird auf sie skaliert (Form aus Wetter und kWp, Menge aus dem Verlauf);
    #: ``None`` = die Reihe bleibt, wie Wetter und kWp sie ergeben.
    pv_jahreserzeugung_kwh: float | None = None
    netzentgelt_arbeitspreis_ct: float = 4.0
    umlagen_ct: float = 2.946
    konzessionsabgabe_ct: float = 0.11
    ust_pct: float = 0.0  # Gewerbe mit Vorsteuerabzug
    zone: str = "DE-LU"


#: Die Kundentypen des Prüfnachweises (Konzept § 3): die Gewerbe a2 und b und
#: der Haushalt c1 (MP-29) wie in der Ersparnis-Simulation (vp-sim-design-t6
#: § 1.3: 10 kWp, 4 500 kWh/a, 10 kWh Speicher mit C/2, dynamischer Tarif mit
#: dem Haushalts-Preisblatt :data:`pricing.DEFAULT_SUPPLY_COMPONENTS`), heute
#: in der Einspeisevergütung 7,78 ct/kWh (Band ab 01.02.2026), anzulegender
#: Wert in der Direktvermarktung 0,4 ct darüber (§ 53 EEG).
KUNDENTYPEN = {
    "a": CheckAnlage(
        formelsatz="A1", speicher_kwh=65.0, speicher_kw=30.0, pv_kwp=100.0,
        jahresverbrauch_kwh=60_000.0, anzulegender_wert_ct=6.90,
    ),
    "b": CheckAnlage(formelsatz="A10", speicher_kwh=100.0, speicher_kw=50.0),
    "c1": CheckAnlage(
        formelsatz="P1", speicher_kwh=10.0, speicher_kw=5.0, pv_kwp=10.0,
        jahresverbrauch_kwh=4_500.0, profil="haushalt", anzulegender_wert_ct=8.18,
        einspeiseverguetung_ct=7.78, netzentgelt_arbeitspreis_ct=7.6, umlagen_ct=2.946,
        konzessionsabgabe_ct=1.59, ust_pct=19.0,
    ),
}


@dataclass
class CheckDeps:
    """Injizierte Daten: Preise (EUR/MWh je Slot), Wetter, optional amtliche
    Marktwerte Solar (ct/kWh) je Monat (``date`` Monatserster) und je Jahr."""

    load_prices: Callable[[str, list[datetime]], list[float]]
    weather: WeatherSourceLike | None = None
    monatsmarktwerte_ct: dict[date, float] = field(default_factory=dict)
    jahresmarktwerte_ct: dict[int, float] = field(default_factory=dict)
    max_workers: int = 1


class ArchivDateiWetter:
    """Wetter ohne Netz: eine oder mehrere Open-Meteo-Archivantworten (JSON,
    stündlich, UTC) zu einem Index vereint; das Jahr spielt keine Rolle."""

    def __init__(self, bodies: list[str]) -> None:
        self._index: dict[datetime, IrradianceSample] = {}
        for body in bodies:
            self._index.update(parse_archive_response(body))

    def hourly_irradiance(self, latitude, longitude, year):
        return self._index


def json_preisquelle(docs: list[dict]) -> Callable[[str, list[datetime]], list[float]]:
    """``load_prices`` aus Preis-JSON (energy-charts oder kompakt), mit der
    Lückenregel des Datenbankpfads."""
    rows = [row for doc in docs for row in price_rows_from_json(doc)]
    return lambda zone, slot_starts: expand_price_rows(rows, slot_starts)


# ---------------------------------------------------------------------------
# Eingänge
# ---------------------------------------------------------------------------


def _pv_reihe(anlage: CheckAnlage, deps: CheckDeps, slots: list[datetime]) -> list[float]:
    if anlage.pv_kwp <= 0:
        return [0.0] * len(slots)
    if deps.weather is None:
        raise ValueError("PV-Anlage ohne Wetter: CheckDeps.weather fehlt")
    index: dict[datetime, IrradianceSample] = {}
    for year in sorted({s.astimezone(BERLIN).year for s in slots} | {slots[0].year}):
        index.update(deps.weather.hourly_irradiance(anlage.latitude, anlage.longitude, year))
    forecaster = PhysicalPvForecaster(weather=ArchiveWeatherProvider(index=index))
    config = SiteForecastConfig(
        tenant_id="mispel-check",
        site_id="mispel-check",
        location=GeoLocation(anlage.latitude, anlage.longitude),
        plant=PlantSpec(
            capacity_kwp=anlage.pv_kwp,
            tilt_deg=anlage.tilt_deg,
            azimuth_deg=anlage.azimuth_deg,
        ),
    )
    return forecaster.power_series(config, slots)


def _skaliert(pv_kw: list[float], jahres_kwh: float | None, monate: int) -> list[float]:
    """Die PV-Reihe auf die gemessene Erzeugung im Jahr (anteilig je Monat des
    Fensters wie der Jahresverbrauch) - ohne Messung unverändert."""
    roh = sum(pv_kw) * SLOT_HOURS
    if jahres_kwh is None or roh <= 0:
        return pv_kw
    faktor = jahres_kwh * monate / 12 / roh
    return [w * faktor for w in pv_kw]


def anlage_aus_json(doc: dict) -> CheckAnlage:
    """Eine :class:`CheckAnlage` aus JSON (Feldnamen wie im Datentyp) - die
    Eingabe, die der Schreiber je Anlage rechnet (MP-13b, ``--eingang``)."""
    felder = set(CheckAnlage.__dataclass_fields__)
    fremd = sorted(set(doc) - felder)
    if fremd:
        raise ValueError(f"unbekannte Angaben der Anlage: {', '.join(fremd)}")
    return CheckAnlage(**doc)


def marktwerte_naeherung(
    slots: list[datetime], spot: list[float], pv_kw: list[float]
) -> tuple[dict[date, float], dict[int, float]]:
    """Marktwert Solar (ct/kWh) je Monat und Jahresmarktwert als mit der
    Erzeugung DIESER Anlage gewichteter Spotpreis - Näherung für die amtlichen
    Werte (Anlage 1 Nr. 3.3 EEG gewichtet mit der deutschlandweiten Solar-
    Einspeisung). Der Jahresmarktwert gilt je Kalenderjahr (A1 S. 21); ein
    Fenster wie 10/2025-09/2026 enthält aber kein ganzes Kalenderjahr, darum
    bekommt jedes Kalenderjahr des Fensters den Wert über das ganze Fenster
    (wie die Konzept-Rechnung) - drei Wintermonate allein lägen weit darüber."""
    num_m: dict[date, float] = {}
    den_m: dict[date, float] = {}
    for s, p, w in zip(slots, spot, pv_kw):
        m = berlin_month(s)
        num_m[m] = num_m.get(m, 0.0) + w * p
        den_m[m] = den_m.get(m, 0.0) + w
    monat = {m: num_m[m] / den_m[m] / 10.0 for m in num_m if den_m[m] > 0}
    gesamt = sum(den_m.values())
    if gesamt <= 0:
        return monat, {}
    fenster = sum(num_m.values()) / gesamt / 10.0
    return monat, {m.year: fenster for m in num_m}


def _tarif(anlage: CheckAnlage, fall: Fall) -> SiteTariff:
    """Börsenindizierter Bezug mit Preisblatt (ct/kWh netto): Spot + Netzentgelt-
    Arbeitspreis + Stromsteuer + Konzessionsabgabe + Umlagen + Beschaffung."""
    return SiteTariff(
        plant_kind=(
            PLANT_KIND_DIREKTVERMARKTUNG
            if anlage.anzulegender_wert_ct is not None
            else PLANT_KIND_EIGENVERBRAUCH
        ),
        tarif_art=TARIF_DYNAMISCH,
        anzulegender_wert_ct_kwh=anlage.anzulegender_wert_ct,
        pv_capacity_kwp=anlage.pv_kwp or None,
        supply_price=SupplyPriceComponents(
            netzentgelt_arbeitspreis_ct=anlage.netzentgelt_arbeitspreis_ct,
            stromsteuer_ct=fall.stromsteuer_ct,
            konzessionsabgabe_ct=anlage.konzessionsabgabe_ct,
            umlagen_ct=anlage.umlagen_ct,
            vertriebsaufschlag_ct=fall.beschaffung_ct,
            ust_pct=anlage.ust_pct,
        ),
    )


def _aw_viertelstunde(aw_ct: float, spot: float) -> float:
    """AW¼ ohne ÜNB-Liste: die Rückfallregel von MP-12 - anzulegender Wert
    nur in Viertelstunden mit Spot ≥ 0 (§ 51 EEG; Konzept § 8.5, W4)."""
    return aw_ct if spot >= 0 else 0.0


def _fraction(kwh: float) -> Fraction:
    # Rechenwerk rechnet exakt mit Brüchen; Wh-Tausendstel genügen.
    return Fraction(round(kwh * 1_000_000), 1_000_000)


def rechenwerk(
    formelsatz: str, slots: list[datetime], spot: list[float], dispatch: Dispatch,
    aw_ct: float | None,
) -> mispel_abgrenzung.Ergebnis:
    """Die Zählerwerte der simulierten Viertelstunden durch das Rechenwerk
    (MP-9): Z1 am Netzanschluss, Z2 am Speicher (A1 S. 32-33)."""
    qhs = []
    for i, s in enumerate(slots):
        grid, bat = dispatch.grid_kw[i], dispatch.battery_kw[i]
        q = {
            "beginn": s,
            "Z1NB¼": _fraction(max(grid, 0.0) * SLOT_HOURS),
            "Z1NE¼": _fraction(max(-grid, 0.0) * SLOT_HOURS),
        }
        if formelsatz == "A1":
            q["Z2V¼"] = _fraction(max(bat, 0.0) * SLOT_HOURS)
            q["Z2E¼"] = _fraction(max(-bat, 0.0) * SLOT_HOURS)
            q["AW¼"] = _fraction(_aw_viertelstunde(aw_ct or 0.0, spot[i]))
        qhs.append(q)
    return mispel_abgrenzung.rechne(formelsatz, qhs)


# ---------------------------------------------------------------------------
# Ein Fall
# ---------------------------------------------------------------------------


def _summe_kwh(dispatch: Dispatch, vorzeichen: int) -> float:
    return sum(max(vorzeichen * g, 0.0) for g in dispatch.grid_kw) * SLOT_HOURS


def _variante_json(kosten: float, wear: float, dispatch: Dispatch, battery, extra=None) -> dict:
    entladen = sum(-b for b in dispatch.battery_kw if b < 0) * SLOT_HOURS
    doc = {
        "kostenEur": round(kosten, 2),
        "verschleissEur": round(wear, 2),
        "nettoKostenEur": round(kosten + wear, 2),
        "netzbezugKwh": round(_summe_kwh(dispatch, 1), 1),
        "einspeisungKwh": round(_summe_kwh(dispatch, -1), 1),
        "vollzyklen": round(entladen / battery.capacity_kwh, 1),
    }
    doc.update(extra or {})
    return doc


def rechne_fall(
    anlage: CheckAnlage, fall: Fall, slots: list[datetime], spot: list[float],
    load_kw: list[float], pv_kw: list[float], monatsmarktwerte: dict[date, float],
    jahresmarktwerte: dict[int, float], max_workers: int = 1,
    heute_streng: bool = False,
) -> dict:
    """stur / heute / mitMispel für einen Annahmen-Fall. ``heute_streng``:
    der EEG-Modus heute nach der strengen Ausschließlichkeit (MP-45, wie A1
    S. 11 sie beschreibt) statt nach FK3."""
    if anlage.formelsatz in PAUSCHAL_FORMELSAETZE:
        return rechne_fall_pauschal(
            anlage, fall, slots, spot, load_kw, pv_kw, jahresmarktwerte, max_workers
        )
    battery = BatteryParams(
        capacity_kwh=anlage.speicher_kwh,
        max_charge_kw=anlage.speicher_kw,
        max_discharge_kw=anlage.speicher_kw,
        roundtrip_efficiency=fall.wirkungsgrad,
        wear_cost_ct_per_kwh=fall.verschleiss_ct,
    )
    tarif = _tarif(anlage, fall)
    imp = import_prices(tarif, spot)
    saldiert = saldierte_bestandteile_eur_mwh(tarif)
    a1 = anlage.formelsatz == "A1"

    # heute: A1 = EEG-Modus (FK3, Monatsmarktwert); A10/A11 = Händler.
    if a1:
        exp_heute = export_values(tarif, False, spot, slots, monatsmarktwerte)
    else:
        exp_heute = list(spot)
    heute_data = YearData(
        request=None, slot_starts=slots, spot=spot, load_kw=load_kw, pv_kw=pv_kw,
        import_eur_mwh=imp, export_eur_mwh=exp_heute,
    )
    stur = scenario_b_dispatch(heute_data, battery)
    out_stur = evaluate(heute_data, stur, battery)
    # wiederholbar (MP-33c): die Knotengrenze statt der Wanduhr - dieselbe
    # Eingabe ergibt unter jeder Last dieselben Beträge.
    heute = run_milp_year(
        heute_data, battery, netzladen=not a1, max_workers=max_workers,
        export_eur_mwh=exp_heute, strenge=a1 and heute_streng, wiederholbar=True,
    )
    out_heute = evaluate(heute_data, heute, battery)

    # mit MiSpeL: A1 = Mischbetrieb (MP-10/11/12); A10/A11 = Saldierung des
    # Formelsatzes als Preis (A10: jeder Netzbezug umlagereduziert, (20)A10 =
    # (3), A1 S. 96; A11: jede Einspeisung, (16)A11 = (4), A1 S. 100-101).
    misch = None
    imp_misch, exp_misch = imp, list(spot)
    if a1:
        basis = MarktwertBasis(
            mispel_tage=frozenset(s.astimezone(BERLIN).date() for s in slots),
            jahresmarktwert_ct=jahresmarktwerte,
        )
        praemie = marktpraemie_eur_mwh(tarif, spot, slots, {}, basis)
        misch = {"praemie": praemie, "saldiert": saldiert}
    elif anlage.formelsatz == "A10":
        imp_misch = [p - saldiert for p in imp]
    else:
        exp_misch = [p + saldiert for p in spot]
    misch_data = replace(heute_data, import_eur_mwh=imp_misch, export_eur_mwh=exp_misch)
    mit = run_milp_year(
        misch_data, battery, netzladen=True, max_workers=max_workers,
        export_eur_mwh=exp_misch, mischbetrieb=misch, wiederholbar=True,
    )

    # Bewertung mit dem Rechenwerk: Bezug voll, Einspeisung Spot, Gutschrift
    # (20) × saldierte Bestandteile, Marktprämie (32) × (AW - Jahresmarktwert).
    ergebnis = rechenwerk(anlage.formelsatz, slots, spot, mit, anlage.anzulegender_wert_ct)
    roh = sum(
        (imp[i] * max(g, 0.0) - spot[i] * max(-g, 0.0)) * SLOT_HOURS / 1000.0
        for i, g in enumerate(mit.grid_kw)
    )
    nr20 = {"A1": "(20)", "A10": "(20)A10", "A11": "(20)A11"}[anlage.formelsatz]
    monate = {}
    gutschrift = praemie_mit = marktwert_effekt = 0.0
    for key, m in sorted(ergebnis.monate.items()):
        g = float(m[nr20]) * saldiert / 1000.0
        zeile = {"umlagereduzierendeMengeKwh": round(float(m[nr20]), 1),
                 "gutschriftEur": round(g, 2)}
        gutschrift += g
        if a1:
            monat_d = date(int(key[:4]), int(key[5:7]), 1)
            aw = anlage.anzulegender_wert_ct or 0.0
            pj = max(aw - jahresmarktwerte.get(monat_d.year, aw), 0.0)
            pm = max(aw - monatsmarktwerte.get(monat_d, aw), 0.0)
            menge = float(m["(32)"])
            praemie_mit += menge * pj / 100.0
            marktwert_effekt += menge * (pj - pm) / 100.0
            zeile.update({
                "saldierungsfaehigeEinspeisungKwh": round(float(m["(16)"]), 1),
                "foerderfaehigeEinspeisungKwh": round(menge, 1),
                "marktpraemieEur": round(menge * pj / 100.0, 2),
            })
        monate[key] = zeile
    kosten_mit = roh - gutschrift - praemie_mit
    wear_mit = sum(mit.wear_eur)

    netto_stur = out_stur.netto_eur
    netto_heute = out_heute.netto_eur
    netto_mit = kosten_mit + wear_mit
    betrieb = netto_heute - netto_mit  # > 0: MiSpeL besser

    posten = []
    if a1:
        handel = (betrieb - marktwert_effekt) * fall.realisierung
        posten.append(("Netzladen-Handel mit Saldierung", handel,
                       "Simulation: Betrieb heute − mit MiSpeL ohne Marktwert-Effekt × Realisierung"))
        posten.append(("Jahresmarktwert statt Monatsmarktwert", marktwert_effekt,
                       "Rechenwerk (32) × (Prämie auf den Jahres- − auf den Monatsmarktwert)"))
        posten.append(("Zweiter Zähler Z2", fall.zaehler_z2_eur, "Konzept § 3 a2 (Schätzung)"))
        posten.append(("Gesonderter Bilanzkreis", fall.bilanzkreis_eur, "Konzept § 3 a2 (Schätzung)"))
    else:
        mehr_kwh = _summe_kwh(mit, -1) - _summe_kwh(heute, -1)
        posten.append(("Handel mit Saldierung (MiSpeL)",
                       (netto_stur - netto_mit) * fall.realisierung,
                       "Simulation gegen den sturen Speicher × Realisierung"))
        posten.append(("abzüglich Handel heute ohne Saldierung",
                       -(netto_stur - netto_heute) * fall.realisierung,
                       "Simulation gegen den sturen Speicher × Realisierung"))
        posten.append(("Mehr Vermarktungsentgelt auf die zusätzliche Rückspeisung",
                       -max(mehr_kwh, 0.0) * fall.realisierung * fall.vermarktung_ct / 100.0,
                       "Mehrmenge × Realisierung × Entgelt (Konzept § 3 b, Schätzung)"))
    differenz = sum(p[1] for p in posten)

    def vorteil(netto: float) -> dict:
        roh_v = netto_stur - netto
        return {"volleVoraussichtEur": round(roh_v, 2),
                "realisiertEur": round(roh_v * fall.realisierung, 2)}

    return {
        "stur": _variante_json(out_stur.kosten_eur, out_stur.wear_eur, stur, battery),
        "heute": _variante_json(
            out_heute.kosten_eur, out_heute.wear_eur, heute, battery,
            {"vorteilGegenStur": vorteil(netto_heute)},
        ),
        "mitMispel": _variante_json(
            kosten_mit, wear_mit, mit, battery,
            {
                "vorteilGegenStur": vorteil(netto_mit),
                "gutschriftSaldierungEur": round(gutschrift, 2),
                "marktpraemieEur": round(praemie_mit, 2) if a1 else None,
                "rechenwerk": {
                    "formelsatz": anlage.formelsatz,
                    "jahre": {
                        j: {nr: round(float(v), 1) for nr, v in werte.items()}
                        for j, werte in sorted(ergebnis.jahre.items())
                    },
                    "monate": monate,
                },
            },
        ),
        "posten": [
            {"posten": name, "eur": round(eur, 2), "herkunft": herkunft}
            for name, eur, herkunft in posten
        ],
        "differenzEur": round(differenz, 2),
        "rueckfaelle": [
            {"variante": variante, "tag": tag, "grenze": grenze}
            for variante, dispatch in (("heute", heute), ("mitMispel", mit))
            for tag, grenze in dispatch.rueckfaelle
        ],
    }


def rueckfall_hinweis(ergebnisse: dict[str, dict]) -> str | None:
    """MP-33c: der Satz für ``hinweis``, wenn ein Lösungslauf eines Falls auf
    „ohne Gutschrift“ zurückfiel - nie still ein anderer Betrag. ``None`` =
    jeder Lauf bewiesen optimal."""
    tage = sorted({r["tag"] for f in ergebnisse.values() for r in f["rueckfaelle"]})
    if not tage:
        return None
    grenzen = {r["grenze"] for f in ergebnisse.values() for r in f["rueckfaelle"]}
    liste = ", ".join(date.fromisoformat(t).strftime("%d.%m.%Y") for t in tage[:5])
    liste += " …" if len(tage) > 5 else ""
    satz = (
        f"An {len(tage)} {'Tag' if len(tage) == 1 else 'Tagen'} ({liste}) hat der "
        "Solver die Planung mit MiSpeL nicht bis zum Optimum gelöst; dort rechnet "
        "der Check ohne Gutschrift – der Vorteil ist eher zu niedrig geschätzt."
    )
    if "zeitgrenze" in grenzen:
        return satz + " Ein Lauf hat die Zeitgrenze erreicht: ein neuer Lauf kann abweichen."
    return satz + " Jeder Lauf mit derselben Eingabe rechnet dasselbe."


# ---------------------------------------------------------------------------
# Pauschaloption (MP-29)
# ---------------------------------------------------------------------------


def einspeiseverguetung_ct(anlage: CheckAnlage) -> float:
    """Die feste Einspeisevergütung von heute: gepflegt, sonst der anzulegende
    Wert abzüglich 0,4 ct/kWh (§ 53 EEG)."""
    if anlage.einspeiseverguetung_ct is not None:
        return anlage.einspeiseverguetung_ct
    return (anlage.anzulegender_wert_ct or 0.0) - EV_ABZUG_CT


def pauschal_stammdaten(anlage: CheckAnlage) -> dict[str, Fraction]:
    """Pinst und SKinst des Basisfalls P1 (A2 S. 27: installierte Leistung der
    Solaranlagen in kW, nutzbare Speicherkapazität in kWh)."""
    return {"Pinst": _fraction(anlage.pv_kwp), "SKinst": _fraction(anlage.speicher_kwh)}


def pauschal_rechenwerk(
    formelsatz: str, slots: list[datetime], spot: list[float], dispatch: Dispatch,
    aw_ct: float, stammdaten: dict[str, Fraction],
) -> dict[str, Fraction]:
    """Die Zählerwerte der simulierten Viertelstunden durch das Rechenwerk MP-25
    (ein Zähler Z1 am Netzanschluss, A2 S. 27): Z1NB¼, Z1NE¼, AW¼ (Rückfallregel
    von MP-12) und SP¼ je Viertelstunde, die ∑J-Summen (P7), (P9), (P14) über
    das GANZE Fenster - es vertritt ein Kalenderjahr (A2 S. 9, Abschn. 2.1.4:
    Abrechnungsjahr = Kalenderjahr), wie der Jahresstand in der Kette - und
    daraus die Jahreswerte (P1)-(P15) mit den Stammdaten der Anlage."""
    qhs = [
        {
            "beginn": s,
            "Z1NB¼": _fraction(max(dispatch.grid_kw[i], 0.0) * SLOT_HOURS),
            "Z1NE¼": _fraction(max(-dispatch.grid_kw[i], 0.0) * SLOT_HOURS),
            "AW¼": _fraction(_aw_viertelstunde(aw_ct, spot[i])),
            "SP¼": _fraction(spot[i]),
        }
        for i, s in enumerate(slots)
    ]
    ergebnis = mispel_pauschal.rechne(formelsatz, qhs, stammdaten=stammdaten)
    summen = {
        nr: sum((werte[nr] for werte in ergebnis.jahre.values()), mispel_pauschal.NULL)
        for nr in mispel_pauschal.SUMMEN[formelsatz]
    }
    return mispel_pauschal.jahr(formelsatz, summen, stammdaten)


def _pauschal_kosten(
    imp: list[float], spot: list[float], dispatch: Dispatch, werte: dict[str, Fraction],
    praemie_ct: float,
) -> tuple[float, float, float]:
    """Bezug voll minus Einspeisung zum Spot, die Marktprämie auf (P15) und die
    Gutschrift auf (P10) - noch ohne Euro je kWh der Gutschrift (EUR)."""
    roh = sum(
        (imp[i] * max(g, 0.0) - spot[i] * max(-g, 0.0)) * SLOT_HOURS / 1000.0
        for i, g in enumerate(dispatch.grid_kw)
    )
    return roh, float(werte["(P15)"]) * praemie_ct / 100.0, float(werte["(P10)"])


def rechne_fall_pauschal(
    anlage: CheckAnlage, fall: Fall, slots: list[datetime], spot: list[float],
    load_kw: list[float], pv_kw: list[float], jahresmarktwerte: dict[int, float],
    max_workers: int = 1,
) -> dict:
    """stur / heute / mitMispel der Pauschaloption (Basisfall P1) für einen Fall.

    **heute** - feste Einspeisevergütung, der Speicher lädt nur aus PV (EEG-
    Modus, Konzept § 3 c1). **mitMispel** - Direktvermarktung mit der
    Pauschaloption: Netzladen erlaubt, Export zum Spot, der Jahreszustand aus
    MP-26 (Kette: :class:`runner._JahresBuchung`). Bewertet wird mitMispel mit
    dem Rechenwerk MP-25: (P15) = MIN [ (P14) ; (P1) ] × Marktprämie auf den
    Jahresmarktwert (A2 S. 20, S. 32-33) und (P10) = MIN [ (P8) ; (P9) ] ×
    saldierte Bestandteile (A2 S. 30-31) - ohne Wirkungsgrad, die Pauschal-
    option privilegiert keine Speicherverluste (A2 S. 8 Fn. 5).

    Posten (Summe = Differenz):

    - **Einspeisung mit Marktprämie statt Einspeisevergütung** - dieselbe
      Fahrweise von heute, einmal mit Vergütung, einmal mit Spot und Prämie
      auf (P15) bewertet (Rechenwerk, keine Voraussicht im Spiel).
    - **Netzladen-Handel mit der Pauschaloption** - was die neue Fahrweise
      (Netzladen, Verschieben, Jahreszustand) gegenüber heute ohne die
      Gutschrift bringt × Realisierung.
    - **Saldierung oberhalb der Pauschalgrenze** - (P10) × saldierte
      Bestandteile der neuen Fahrweise (Rechenwerk).
    - **Direktvermarktungsentgelt** und **Messstellenbetrieb** - Schätzungen
      aus Konzept § 3 c1.
    """
    battery = BatteryParams(
        capacity_kwh=anlage.speicher_kwh,
        max_charge_kw=anlage.speicher_kw,
        max_discharge_kw=anlage.speicher_kw,
        roundtrip_efficiency=fall.wirkungsgrad,
        wear_cost_ct_per_kwh=fall.verschleiss_ct,
    )
    tarif = _tarif(anlage, fall)
    imp = import_prices(tarif, spot)
    saldiert = saldierte_bestandteile_eur_mwh(tarif)
    aw = anlage.anzulegender_wert_ct or 0.0
    ev = einspeiseverguetung_ct(anlage)
    stammdaten = pauschal_stammdaten(anlage)

    exp_heute = [ev * 10.0] * len(slots)
    heute_data = YearData(
        request=None, slot_starts=slots, spot=spot, load_kw=load_kw, pv_kw=pv_kw,
        import_eur_mwh=imp, export_eur_mwh=exp_heute,
    )
    stur = scenario_b_dispatch(heute_data, battery)
    out_stur = evaluate(heute_data, stur, battery)
    # wiederholbar (MP-33c): die Knotengrenze statt der Wanduhr, wie im Abgrenzungs-Check.
    heute = run_milp_year(
        heute_data, battery, netzladen=False, max_workers=max_workers, export_eur_mwh=exp_heute,
        wiederholbar=True,
    )
    out_heute = evaluate(heute_data, heute, battery)

    basis = MarktwertBasis(
        mispel_tage=frozenset(s.astimezone(BERLIN).date() for s in slots),
        jahresmarktwert_ct=jahresmarktwerte,
    )
    praemie = marktpraemie_eur_mwh(tarif, spot, slots, {}, basis)
    mit_data = replace(heute_data, export_eur_mwh=list(spot))
    mit = run_milp_year(
        mit_data, battery, netzladen=True, max_workers=max_workers, export_eur_mwh=list(spot),
        wiederholbar=True,
        pauschal={
            "praemie": praemie,
            "aw": [_aw_viertelstunde(aw, p) for p in spot],
            "saldiert": saldiert,
            "formelsatz": anlage.formelsatz,
            "stammdaten": {k: str(v) for k, v in stammdaten.items()},
        },
    )

    # Prämie je förderfähiger kWh: anzulegender Wert minus Jahresmarktwert des
    # Bezugsjahres (A2 S. 20) - das Jahr der letzten Viertelstunde.
    bezugsjahr = slots[-1].astimezone(BERLIN).year
    praemie_ct = max(aw - jahresmarktwerte.get(bezugsjahr, aw), 0.0)
    werte_mit = pauschal_rechenwerk(anlage.formelsatz, slots, spot, mit, aw, stammdaten)
    werte_heute = pauschal_rechenwerk(anlage.formelsatz, slots, spot, heute, aw, stammdaten)
    roh_mit, praemie_mit, p10_mit = _pauschal_kosten(imp, spot, mit, werte_mit, praemie_ct)
    roh_h, praemie_h, _ = _pauschal_kosten(imp, spot, heute, werte_heute, praemie_ct)
    gutschrift = p10_mit * saldiert / 1000.0
    wear_mit = sum(mit.wear_eur)
    kosten_mit = roh_mit - praemie_mit - gutschrift
    netto_mit = kosten_mit + wear_mit
    netto_heute = out_heute.netto_eur
    # Die Fahrweise von heute, nach der Pauschaloption bewertet - ohne Gutschrift.
    netto_heute_pauschal = roh_h - praemie_h + out_heute.wear_eur

    posten = [
        ("Einspeisung mit Marktprämie statt Einspeisevergütung", netto_heute - netto_heute_pauschal,
         "Rechenwerk MP-25: Fahrweise heute mit Spot + Prämie auf (P15) statt Vergütung"),
        ("Netzladen-Handel mit der Pauschaloption",
         (netto_heute_pauschal - (netto_mit + gutschrift)) * fall.realisierung,
         "Simulation: heute − mit Pauschaloption ohne Saldierung × Realisierung"),
        ("Saldierung oberhalb der Pauschalgrenze", gutschrift,
         "Rechenwerk MP-25: (P10) × saldierte Bestandteile (A2 S. 30–31)"),
        ("Direktvermarktungsentgelt", fall.direktvermarktung_eur, "Konzept § 3 c1 (Schätzung)"),
        ("Mehrkosten Messstellenbetrieb", fall.messstelle_eur, "Konzept § 3 c1 (Schätzung)"),
    ]
    differenz = sum(p[1] for p in posten)

    def vorteil(netto: float) -> dict:
        roh_v = out_stur.netto_eur - netto
        return {"volleVoraussichtEur": round(roh_v, 2),
                "realisiertEur": round(roh_v * fall.realisierung, 2)}

    return {
        "stur": _variante_json(out_stur.kosten_eur, out_stur.wear_eur, stur, battery),
        "heute": _variante_json(
            out_heute.kosten_eur, out_heute.wear_eur, heute, battery,
            {"vorteilGegenStur": vorteil(netto_heute), "einspeiseverguetungCt": round(ev, 3)},
        ),
        "mitMispel": _variante_json(
            kosten_mit, wear_mit, mit, battery,
            {
                "vorteilGegenStur": vorteil(netto_mit),
                "gutschriftSaldierungEur": round(gutschrift, 2),
                "marktpraemieEur": round(praemie_mit, 2),
                "marktpraemieCtKwh": round(praemie_ct, 3),
                "rechenwerk": {
                    "formelsatz": anlage.formelsatz,
                    "bezugsjahr": "Fenster als ein Kalenderjahr",
                    "jahr": {nr: round(float(v), 3) for nr, v in werte_mit.items()},
                    "heute": {nr: round(float(werte_heute[nr]), 1)
                              for nr in ("(P7)", "(P9)", "(P14)", "(P15)", "(P10)")},
                },
            },
        ),
        "posten": [
            {"posten": name, "eur": round(eur, 2), "herkunft": herkunft}
            for name, eur, herkunft in posten
        ],
        "differenzEur": round(differenz, 2),
        # MP-33c: Läufe, die an der Knotengrenze ohne Saldierung im Jahr planten.
        "rueckfaelle": [
            {"variante": variante, "tag": tag, "grenze": grenze}
            for variante, dispatch in (("heute", heute), ("mitMispel", mit))
            for tag, grenze in dispatch.rueckfaelle
        ],
    }


# ---------------------------------------------------------------------------
# Der Check
# ---------------------------------------------------------------------------


def mispel_check(
    anlage: CheckAnlage,
    deps: CheckDeps,
    beginn: tuple[int, int] = (2025, 10),
    monate: int = 12,
    faelle: dict[str, Fall] | None = None,
    heute_streng: bool = False,
) -> dict:
    """Der MiSpeL-Check einer Anlage über ``monate`` Monate ab ``beginn``
    (Jahr, Monat): je Fall stur / heute / mitMispel, die Posten und die
    Spanne der Differenz „mit MiSpeL − heute“ (positiv = MiSpeL lohnt)."""
    if anlage.formelsatz not in CHECK_FORMELSAETZE:
        return {
            "unterstuetzt": False,
            "formelsatz": anlage.formelsatz,
            "hinweis": (
                f"Formelsatz {anlage.formelsatz}: {NICHT_UNTERSTUETZT}. Der Check "
                f"rechnet {', '.join(CHECK_FORMELSAETZE)} (Konzept § 8.5)."
            ),
        }
    if anlage.formelsatz == "A1" and (anlage.anzulegender_wert_ct is None or anlage.pv_kwp <= 0):
        raise ValueError("A1 braucht eine PV-Anlage mit anzulegendem Wert")
    if anlage.formelsatz in ("A10", "A11") and anlage.pv_kwp > 0:
        raise ValueError(f"{anlage.formelsatz} rechnet ohne Erzeugungsanlage (A1 S. 96, S. 100)")
    if anlage.formelsatz in PAUSCHAL_FORMELSAETZE:
        if anlage.anzulegender_wert_ct is None or anlage.pv_kwp <= 0:
            raise ValueError("P1 braucht eine Solaranlage mit anzulegendem Wert (A2 Abschn. 4.1.1, S. 25)")
        if anlage.pv_kwp > PAUSCHAL_MAX_KWP:
            raise ValueError("Die Pauschaloption gilt für Solaranlagen bis 30 kWp (A2 Abschn. 2.1.3, S. 9)")
        if monate > 12:
            raise ValueError("Die Pauschaloption rechnet je Kalenderjahr (A2 Abschn. 2.1.4, S. 9): "
                             "das Fenster vertritt höchstens ein Jahr")
    if anlage.formelsatz == "A10" and anlage.jahresverbrauch_kwh > 0:
        raise ValueError("A10 ist der reine Netzspeicher ohne sonstigen Verbrauch (A1 S. 96)")
    faelle = faelle or STANDARD_FAELLE
    slots = window_slot_starts(beginn[0], beginn[1], monate)
    spot = deps.load_prices(anlage.zone, slots)
    kwh = anlage.jahresverbrauch_kwh * monate / 12
    if kwh <= 0:
        load_kw = [0.0] * len(slots)
    elif anlage.profil == "gewerbe":
        load_kw = business_series_kw(slots, kwh)
    else:
        load_kw = load_series_kw(anlage.profil, slots, kwh)
    pv_kw = _skaliert(_pv_reihe(anlage, deps, slots), anlage.pv_jahreserzeugung_kwh, monate)

    monatsmw, jahresmw = dict(deps.monatsmarktwerte_ct), dict(deps.jahresmarktwerte_ct)
    naeherung_m, naeherung_j = marktwerte_naeherung(slots, spot, pv_kw)
    genaehert = sorted(
        [m.isoformat()[:7] for m in naeherung_m if m not in monatsmw]
        + [str(j) for j in naeherung_j if j not in jahresmw]
    )
    for m, v in naeherung_m.items():
        monatsmw.setdefault(m, v)
    for j, v in naeherung_j.items():
        jahresmw.setdefault(j, v)

    ergebnisse = {
        name: rechne_fall(
            anlage, fall, slots, spot, load_kw, pv_kw, monatsmw, jahresmw,
            deps.max_workers, heute_streng,
        )
        for name, fall in faelle.items()
    }
    tage: dict[date, list[float]] = {}
    for s, p in zip(slots, spot):
        tage.setdefault(s.astimezone(BERLIN).date(), []).append(p)
    return {
        "unterstuetzt": True,
        "formelsatz": anlage.formelsatz,
        "fenster": {
            "von": slots[0].astimezone(BERLIN).date().isoformat(),
            "bis": (slots[-1].astimezone(BERLIN)).date().isoformat(),
            "viertelstunden": len(slots),
        },
        "preise": {
            "mittelEurMwh": round(sum(spot) / len(spot), 2),
            "tagesspanneMittelEurMwh": round(
                sum(max(v) - min(v) for v in tage.values()) / len(tage), 1
            ),
            "negativeViertelstunden": sum(1 for p in spot if p < 0),
        },
        "anlage": {
            "pvKwp": anlage.pv_kwp,
            "speicherKwh": anlage.speicher_kwh,
            "speicherKw": anlage.speicher_kw,
            "jahresverbrauchKwh": anlage.jahresverbrauch_kwh,
            "profil": anlage.profil if anlage.jahresverbrauch_kwh > 0 else None,
            "anzulegenderWertCt": anlage.anzulegender_wert_ct,
            "einspeiseverguetungCt": (
                einspeiseverguetung_ct(anlage) if anlage.formelsatz in PAUSCHAL_FORMELSAETZE else None
            ),
            "pvJahreserzeugungKwh": anlage.pv_jahreserzeugung_kwh,
        },
        "marktwerteSolarCt": {
            "monat": {m.isoformat()[:7]: round(v, 3) for m, v in sorted(monatsmw.items())},
            "jahr": {str(j): round(v, 3) for j, v in sorted(jahresmw.items())},
            "genaehert": genaehert,
        } if anlage.formelsatz in ("A1",) + PAUSCHAL_FORMELSAETZE else None,
        "faelle": ergebnisse,
        "spanne": {name: ergebnisse[name]["differenzEur"] for name in faelle},
        "annahmen": _annahmen(anlage, faelle, heute_streng),
        "hinweis": rueckfall_hinweis(ergebnisse),
    }


def _annahmen(anlage: CheckAnlage, faelle: dict[str, Fall], heute_streng: bool) -> list[dict]:
    def je_fall(attr: str):
        return {name: getattr(f, attr) for name, f in faelle.items()}

    a = {
        "Vergleich": Annahme(
            "gegen den sturen Speicher derselben Anlage", "Captain 04.09.2026", "belegt"),
        "Fahrweise": Annahme(
            "Produktions-MILP, 365 verkettete Tage, 48-h-Fenster / 24 h festgeschrieben, "
            "volle Voraussicht von Preis, PV und Last im Fenster",
            "simulation/runner.py", "belegt"),
        "Realisierung gegenüber voller Voraussicht": Annahme(
            je_fall("realisierung"), "Konzept § 3", "Schätzung"),
        "Speicher-Verschleiß ct je entladene kWh": Annahme(
            je_fall("verschleiss_ct"), "Konzept § 3; Plattform-Standard 4,0, Pilsting 1,0", "belegt"),
        "Rundlauf-Wirkungsgrad": Annahme(je_fall("wirkungsgrad"), "Konzept § 3", "Schätzung"),
        "Stromsteuer ct/kWh": Annahme(
            je_fall("stromsteuer_ct"),
            "§ 3 StromStG; „hoch“ = saldierbar über § 11a Abs. 3 StromStV (R1 O-7)", "Lesart"),
        "Beschaffungsaufschlag ct/kWh": Annahme(je_fall("beschaffung_ct"), "Konzept § 3", "Schätzung"),
        "Umlagen ct/kWh": Annahme(anlage.umlagen_ct, "R3 § 2.2; pricing.py DEFAULT_SUPPLY_COMPONENTS", "belegt"),
        "Netzentgelt-Arbeitspreis ct/kWh": Annahme(
            anlage.netzentgelt_arbeitspreis_ct, "Konzept § 3 (Gewerbe)", "Schätzung"),
        "Konzessionsabgabe ct/kWh": Annahme(anlage.konzessionsabgabe_ct, "KAV Sondervertrag", "Schätzung"),
        "Saldiert werden": Annahme(
            "Umlagen und Netzentgelt-Arbeitspreis auf die umlagereduzierende Menge (20); "
            "Leistungspreis bleibt", "§ 21 EnFG, § 118 Abs. 6 EnWG; Konzept § 8.5 (MP-10)", "belegt"),
    }
    if anlage.formelsatz == "A1":
        a["Ausschließlichkeitsoption heute"] = (
            Annahme("streng: kein Laden bei gleichzeitigem Netzbezug (MP-45)",
                    "A1 S. 11; Konzept § 8.5 W1", "Lesart")
            if heute_streng
            else Annahme("EEG-Modus nach FK3: Laden bis zur PV-Erzeugung je Viertelstunde",
                         "Konzept § 8.5 W1 = D (Produktion bis zur Rechtsantwort)", "belegt")
        )
        a["AW¼"] = Annahme(
            "anzulegender Wert nur in Viertelstunden mit Spot ≥ 0 (ohne ÜNB-Liste)",
            "MP-12 Rückfallregel; Konzept § 8.5 W4", "Näherung")
        a["Marktwert Solar"] = Annahme(
            "amtlich, sonst mit der Erzeugung der Anlage gewichteter Spot je Monat; "
            "Jahresmarktwert je Kalenderjahr = Wert über das ganze Fenster",
            "Anlage 1 Nr. 3.3 EEG; A1 S. 21", "Näherung")
        a["Zweiter Zähler Z2 €/a"] = Annahme(je_fall("zaehler_z2_eur"), "Konzept § 3 a2", "Schätzung")
        a["Gesonderter Bilanzkreis €/a"] = Annahme(je_fall("bilanzkreis_eur"), "Konzept § 3 a2", "Schätzung")
    elif anlage.formelsatz in PAUSCHAL_FORMELSAETZE:
        a["Heute"] = Annahme(
            "feste Einspeisevergütung, Speicher lädt nur aus PV (EEG-Modus)",
            "Konzept § 3 c1", "belegt")
        a["Einspeisevergütung heute ct/kWh"] = Annahme(
            einspeiseverguetung_ct(anlage),
            "gepflegt" if anlage.einspeiseverguetung_ct is not None
            else "anzulegender Wert − 0,4 ct (§ 53 EEG)", "Lesart")
        a["Mit Pauschaloption"] = Annahme(
            "Direktvermarktung, Netzladen erlaubt; Plan mit dem Jahreszustand (MP-26): bis (P1) "
            "Prämie, zwischen (P1) und (P4) nichts, darüber Saldierung in SP≥0-Zeiten bis (P9); "
            "Jahresrest wie in der Produktion mit dem bisherigen Tempo geschätzt",
            "A2 S. 9–10 Abb. 1, S. 27–33; Konzept § 8.5 MP-26", "belegt")
        a["Pauschalgrenzen"] = Annahme(
            "(P1) = Pinst × 500 kWh/kW, (P3) = (P2)P1 × (P1), (P4) = (P1) + (P3) — Rechenwerk MP-25",
            "A2 S. 28–30", "belegt")
        a["Bezugszeitraum"] = Annahme(
            "das Fenster vertritt ein Kalenderjahr: Kette und Jahressummen in Kalenderfolge "
            "(Januar zuerst), die Monate vor dem Fensterbeginn durch dieselben Monate des Fensters",
            "A2 S. 9 Abschn. 2.1.4 (Abrechnungsjahr = Kalenderjahr)", "Näherung")
        a["AW¼"] = Annahme(
            "anzulegender Wert nur in Viertelstunden mit Spot ≥ 0 (ohne ÜNB-Liste)",
            "MP-12 Rückfallregel; Konzept § 8.5 W4", "Näherung")
        a["Marktwert Solar"] = Annahme(
            "Jahresmarktwert amtlich, sonst der mit der Erzeugung der Anlage gewichtete Spot "
            "über das ganze Fenster", "A2 S. 20; Anlage 1 Nr. 3.3 EEG", "Näherung")
        a["Netzentgelt-Arbeitspreis ct/kWh"] = Annahme(
            anlage.netzentgelt_arbeitspreis_ct,
            "Haushalt: pricing.DEFAULT_SUPPLY_COMPONENTS (Recherche vp-nacht-bezug-e7)", "Schätzung")
        a["Konzessionsabgabe ct/kWh"] = Annahme(
            anlage.konzessionsabgabe_ct, "Haushalt, Stadt ≤ 100 000 EW (KAV)", "Schätzung")
        a["Lastgang"] = Annahme(
            anlage.profil, "Haushaltsprofil der Ersparnis-Simulation (vp-sim-design-t6)", "Annahme")
        a["Saldiert werden"] = Annahme(
            "Umlagen und Netzentgelt-Arbeitspreis auf (P10), ohne Wirkungsgrad",
            "§ 21 EnFG, § 118 Abs. 6 EnWG; A2 S. 8 Fn. 5", "belegt")
        a["Direktvermarktungsentgelt €/a"] = Annahme(
            je_fall("direktvermarktung_eur"), "Konzept § 3 c1 (keine öffentlichen Preise, R3 § 2.3)",
            "Schätzung")
        a["Mehrkosten Messstellenbetrieb €/a"] = Annahme(
            je_fall("messstelle_eur"), "Konzept § 3 c1; ab 7 kW oft ohnehin Pflicht (§ 29 MsbG)",
            "Schätzung")
        a["Anwendbar"] = Annahme(
            "erst ab dem Monatsersten nach der EU-Genehmigung; vorher ist der Check eine "
            "Information vor dem Wechsel", "Tenor Ziff. 9 b, S. 3", "belegt")
    else:
        a["Vermarktungsentgelt Rückspeisung ct/kWh"] = Annahme(
            je_fall("vermarktung_ct"), "Konzept § 3 b", "Schätzung")
    return [annahme.json(name) for name, annahme in a.items()]


# ---------------------------------------------------------------------------
# Kommandozeile
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m voltpilot_optimization.simulation.mispel_check",
        description="MiSpeL-Check: dieselbe Anlage heute gegen mit MiSpeL, als JSON.",
    )
    parser.add_argument("--kundentyp", choices=sorted(KUNDENTYPEN), default="a")
    parser.add_argument("--anlage", help="Anlage als JSON (statt --kundentyp), z. B. die "
                        "Eingabe des Schreibers MP-13b: mispel-check --eingang")
    parser.add_argument("--preise", nargs="+", required=True,
                        help="Preis-JSON (energy-charts oder kompakt), ohne Datenbank")
    parser.add_argument("--wetter", nargs="*", default=[],
                        help="Open-Meteo-Archivantworten (JSON) für die PV-Reihe")
    parser.add_argument("--beginn", default="2025-10", help="erster Monat JJJJ-MM")
    parser.add_argument("--monate", type=int, default=12)
    parser.add_argument("--fall", choices=FAELLE, nargs="*", default=list(FAELLE))
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--heute-streng", action="store_true",
                        help="EEG-Modus heute nach der strengen Ausschließlichkeit (MP-45)")
    args = parser.parse_args(argv)

    docs = []
    for path in args.preise:
        with open(path, encoding="utf-8") as fh:
            docs.append(json.load(fh))
    bodies = []
    for path in args.wetter:
        with open(path, encoding="utf-8") as fh:
            bodies.append(fh.read())
    deps = CheckDeps(
        load_prices=json_preisquelle(docs),
        weather=ArchivDateiWetter(bodies) if bodies else None,
        max_workers=args.workers,
    )
    jahr, monat = (int(x) for x in args.beginn.split("-"))
    faelle = {name: STANDARD_FAELLE[name] for name in args.fall}
    if args.anlage:
        with open(args.anlage, encoding="utf-8") as fh:
            anlage = anlage_aus_json(json.load(fh))
    else:
        anlage = KUNDENTYPEN[args.kundentyp]
    result = mispel_check(
        anlage, deps, (jahr, monat), args.monate, faelle,
        heute_streng=args.heute_streng,
    )
    json.dump(result, sys.stdout, ensure_ascii=False, indent=1)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
