"""Die Defizitdeckung der Box im Plan (PH-1 A, Captain-Entscheid 15.11.2026).

Die Box deckt in jedem Slot, in dem der Plan nicht laedt, ein gemessenes
Hausdefizit aus dem Speicher, bis die Untergrenze erreicht ist
(``edge-app/core/internal/guards/deficitcover.go``, Captain-Entscheid
28.08.2026, Vertrauensregel). Einen Schutz fuer einen spaeteren Verkauf hat die
Regel nicht. Bis PH-1 stand sie im LP nur als Kommentar: Ein Plan, der 0 kW als
Halten fuer einen hoeheren Morgenverkauf plante, wurde von der Box nicht
ausgefuehrt. Herzogau 02.11.2026: Plan 0 kW ab 16:00, die Box deckte 2-4 kW Haus
(``follow.path: deficit_cover``), der Speicher waere gegen 22-23 Uhr leer
gewesen und der geplante Verkauf am 03.11. um 08:00/09:00 ohne Bestand
(Scout ``vp-herzogau-speicher-wartet-bezug`` §3).

Seither rechnet der Plan die Regel mit, die Box und ihre Regel bleiben
unveraendert. In :func:`voltpilot_optimization.solver.build_model` und, fuer die
N=1-Gleichheit der Golden-Suite wortgleich, in
:class:`voltpilot_optimization.modules.DefizitDeckungModule` gilt je Slot ``t``
mit einem prognostizierten Hausdefizit ``d_t = last_t - pv_t`` ueber
:data:`DECKUNG_AB_KW`::

    discharge_t >= min(d_t, max_discharge) * (1 - is_charging_t - boden_t)   (defizit_deckung)
    soc_{t+1}   <= boden + (soc_max - boden) * (1 - boden_t)                 (defizit_boden)
    charge_t    >= LADEN_AB_KW * is_charging_t                               (defizit_laden)

- ``boden_t`` (binaer, ``boden_erreicht``) sagt: Der Slot endet an der
  Untergrenze der Box. Nur dann darf weniger als das Defizit fliessen. So
  deckt der Plan wie die Box, bis der Speicher leer ist, und danach nicht mehr.
  Die Untergrenze ist :attr:`BatteryParams.effective_floor_soc_pct`, also
  genau der Wert, den der Plan der Box als ``effective_floor_soc_pct``
  mitgibt. Ein Anfangsstand darunter braucht keine Sonderregel: Der Slot endet
  dann ohnehin unter der Grenze, und die Box deckt dort nicht.
- ``defizit_laden``: Die Box zaehlt einen Sollwert erst ueber
  ``DeficitCoverChargeDeadbandKw`` (0,05 kW) als Laden. Ohne diese Zeile
  koennte der Plan ``is_charging = 1`` bei 0 kW Ladung setzen und sich so ein
  Halten erschleichen, das die Box nicht ausfuehrt. Im EEG-Modus ist das schon
  durch ``strenge_ausschliesslichkeit`` (EN-2 A) ausgeschlossen: Ein Slot mit
  Hausdefizit kann dort gar nicht laden.
- Ein Verkauf ueber das Defizit hinaus bleibt erlaubt (``discharge`` darf
  groesser sein): Die Box laesst eine Entladung, die tiefer als das Defizit
  geht, unveraendert laufen.
- Mit harter §14a-Grenze (``grid_import_cap``, nur im Lauf, der sie haelt)
  bekommt ``defizit_deckung`` eine Luecke ``deckung_luecke_t >= 0``, die
  :data:`LUECKE_EUR_PER_KWH` kostet. Die Box haelt keine Reserve fuer eine
  spaetere §14a-Spitze: Sie deckt, bis der Speicher leer ist, und danach ist
  die Grenze nicht mehr zu halten. Hart gerechnet waere ein solcher Lauf
  unloesbar, und die Anlage bekaeme nur noch den Rueckfallplan ohne Grenze.
  Die Luecke laesst die Grenze gewinnen, nur dort, wo beides zusammen
  unmoeglich ist. ``solver.optimize`` schreibt dann eine Warnung ins Log. Sonst
  ist sie 0, und der Plan deckt wie die Box.

Die Schwelle :data:`DECKUNG_AB_KW` ist ``FollowEngageMarginKw`` aus
``loadfollow.go``: Erst wenn der Sollwert das Hausdefizit um mehr als 0,2 kW
verfehlt, regelt die Box nach. Dann deckt sie das ganze Defizit (Ziel Netz 0).
Die Haltezeit von 60 s (``DeficitCoverHold``) ist in einer Viertelstunde mit
stehendem Defizit vernachlaessigbar und bleibt aussen vor, ebenso die
Ruhegruende der Box (Pause, Handeingriff), die der Plan nicht kennt.

Nicht im Modell, ausdruecklich:

- ein Speicher, den der Plan nicht steuert (``battery_held``,
  ``soc_unbekannt``, ``battery_observed``): Seine Bahn liegt per Schranke fest,
  die Regel haette dort nichts zu entscheiden und koennte das Modell
  unloesbar machen;
- eine Anlage im Verbund (AP-15 IP-14): ``verbund_einspeisung`` zaehlt die
  Entladung des Speichers als Einspeisung seiner Box. Mit einem kleinen
  Einspeise-Anteil waere die erzwungene Deckung dort unloesbar;
- im Co-Optimierer jede Anlage ausser genau einem Speicher ohne steuerbare
  Verbraucher: Wie die Box ein Defizit auf mehrere Speicher verteilt und wie
  ein geplanter Verbraucher das Defizit verschiebt, ist nicht entschieden.

Was damit im Plan sichtbar wird (die Box tat es schon immer):

- Halten bei Hausdefizit gibt es nur noch ueber Laden. Mit Netzladen erlaubt
  laedt der Plan dafuer mindestens :data:`LADEN_AB_KW` aus dem Netz; im
  EEG-Modus kann ein Defizit-Slot nicht laden, der Bestand geht ins Haus
  oder vorher in einen Verkauf.
- Dynamischer Tarif: In Defizit-Slots ohne Laden wartet der Speicher nicht
  auf einen teureren Abend.
- Leistungspreis: Eine flache Teilentladung gegen eine lange Spitze vertieft
  die Box auf das ganze Defizit, bis der Speicher leer ist. Der Plan verspricht
  diese Kappung nicht mehr; Energie fuer Spitzen haelt nur die Spitzenreserve
  (``peak_reserve_pct``) in der Untergrenze.
- Bei exakt flachem, symmetrischem Preis ist "jetzt verkaufen" so viel wert
  wie "spaeter das Haus decken"; der Frueh-Brecher waehlt dann "jetzt".

Nachweis: ``tests/test_defizitdeckung.py``, Replay des 02.11.2026 im PR.
"""

from __future__ import annotations

from typing import Any, Callable

from pyomo.environ import (
    Binary,
    ConcreteModel,
    Constraint,
    NonNegativeReals,
    Var,
    value,
)

from voltpilot_optimization.domain import BatteryParams

#: Ab welchem prognostizierten Hausdefizit die Box deckt (kW):
#: ``FollowEngageMarginKw`` in ``edge-app/core/internal/guards/loadfollow.go``.
DECKUNG_AB_KW = 0.2

#: Mindestladung eines Slots, den der Plan als Laden fuehrt, wo die Regel gilt
#: (kW). Liegt ueber ``DeficitCoverChargeDeadbandKw`` (0,05 kW, deficitcover.go),
#: damit auch ein gerundeter Sollwert an der Box noch als Laden zaehlt, und ueber
#: der PV-Totzone der Rollen (``PV_SOURCE_DEADBAND_KW`` 0,1 kW in explain.py,
#: schedule.ts, SlotEconomics.java): eine Netzladung, mit der ein Haendler-Plan
#: haelt, heisst dann "guenstig laden" und nicht "PV speichern".
LADEN_AB_KW = 0.15

#: Preis einer nicht gedeckten kWh Hausdefizit im Lauf mit harter §14a-Grenze
#: (EUR/kWh). Liegt ueber jedem Preis, den der Plan sonst sieht (Day-ahead
#: hoechstens 4 EUR/kWh, Festpreise weit darunter). So nutzt der Plan die Luecke
#: nur, wo Grenze und Deckung zusammen unloesbar sind, nie fuer einen Verkauf.
LUECKE_EUR_PER_KWH = 10.0


def deckung_kw(
    load_kw: list[float], pv_kw: list[float], max_discharge_kw: float
) -> dict[int, float]:
    """Je Slot mit Hausdefizit ueber :data:`DECKUNG_AB_KW`: was die Box deckt.

    Das prognostizierte Defizit ``max(last, 0) - max(pv, 0)``, gekappt bei der
    Entladeleistung. Slots ohne Defizit fehlen im Ergebnis, dort entsteht keine
    Zeile im Modell."""
    out: dict[int, float] = {}
    for t, (last, pv) in enumerate(zip(load_kw, pv_kw)):
        defizit = max(last, 0.0) - max(pv, 0.0)
        if defizit > DECKUNG_AB_KW:
            out[t] = min(defizit, max_discharge_kw)
    return out


def boden_kwh(params: BatteryParams) -> float:
    """Die Untergrenze der Box in kWh: der konfigurierte Reservestapel
    (:attr:`BatteryParams.effective_floor_soc_pct`), hoechstens ``soc_max``."""
    return min(
        params.capacity_kwh * params.effective_floor_soc_pct / 100.0,
        params.soc_max_kwh,
    )


def baue(
    m: ConcreteModel,
    *,
    load_kw: list[float],
    pv_kw: list[float],
    params: BatteryParams,
    slot_hours: float,
    mit_luecke: bool,
    charge: Callable[[int], Any],
    discharge: Callable[[int], Any],
    is_charging: Callable[[int], Any],
    soc_ende: Callable[[int], Any],
):
    """Die Regel ins Modell ``m`` bauen - EINE Umsetzung fuer
    ``solver.build_model`` und ``modules.DefizitDeckungModule``; die Zugriffe
    auf die Variablen des Speichers reicht der Aufrufer herein (v1 ``[t]``,
    Co-Modell ``[0, t]``). Gibt den Zielfunktionsterm der Luecke zurueck
    (``0.0`` ohne Luecke). Ohne Slot mit Hausdefizit kommt nichts ins Modell."""
    deckung = deckung_kw(load_kw, pv_kw, params.max_discharge_kw)
    if not deckung:
        return 0.0
    slots = sorted(deckung)
    boden = boden_kwh(params)
    spanne = params.soc_max_kwh - boden
    m.boden_erreicht = Var(slots, domain=Binary)
    if mit_luecke:
        m.deckung_luecke = Var(
            slots,
            domain=NonNegativeReals,
            bounds=lambda model, t: (0.0, deckung[t]),
        )

    def _deckung(model, t):
        gedeckt = discharge(t)
        if mit_luecke:
            gedeckt = gedeckt + model.deckung_luecke[t]
        return gedeckt >= deckung[t] * (
            1 - is_charging(t) - model.boden_erreicht[t]
        )

    m.defizit_deckung = Constraint(slots, rule=_deckung)
    m.defizit_boden = Constraint(
        slots,
        rule=lambda model, t: soc_ende(t)
        <= boden + spanne * (1 - model.boden_erreicht[t]),
    )
    m.defizit_laden = Constraint(
        slots, rule=lambda model, t: charge(t) >= LADEN_AB_KW * is_charging(t)
    )
    return luecke_kosten(m, slot_hours)


def luecke_kosten(m: ConcreteModel, slot_hours: float):
    """Der Zielfunktionsterm der Luecke (``0.0``, wenn keine gebaut ist)."""
    if not hasattr(m, "deckung_luecke"):
        return 0.0
    return LUECKE_EUR_PER_KWH * slot_hours * sum(m.deckung_luecke.values())


def luecke_kwh(m: ConcreteModel, slot_hours: float) -> float:
    """Die im geloesten Modell nicht gedeckte Energie (kWh); 0 ohne Luecke."""
    if not hasattr(m, "deckung_luecke"):
        return 0.0
    return sum(float(value(v)) for v in m.deckung_luecke.values()) * slot_hours
