"""Die MESSLATTE des Fahrplans: derselbe Speicher, nur ohne smarte Steuerung.

Captain-Auftrag 04.09.2026, woertlich: *"Das ist doch Quatsch, du musst Anlage
immer mit Speicher berechnen, einer halt ohne smart Steuerung."* Bis dahin
rechnete die geplante Ersparnis gegen eine Anlage OHNE Speicher
(:meth:`OptimizationInput.baseline_cost_eur`) - der Kunde sah 442 EUR geplant
neben 43 EUR gemessen, weil die zwei Zahlen Verschiedenes massen: die gemessene
Seite trennt seit dem Audit ``vp-geldzahlen-audit-x7`` §2.5 laengst
``savedEur = savedSpeicherEur + savedSteuerungEur``. Dieses Modul liefert die
fehlende Haelfte auf der PLAN-Seite.

**Die Regel wird nicht neu erfunden, sie wird WIEDERVERWENDET.** Der sture
Speicher IST das Greedy-Szenario (b) der Ersparnis-Simulation
(:func:`voltpilot_optimization.simulation.greedy.greedy_dispatch`), dessen
Java-Zwilling ``services/api .../repo/StandardSpeicher.java`` die GEMESSENE
Seite rechnet. Es gibt damit genau EINE Physik an EINEM Ort, und die beiden
Sprachen sind ueber die geteilten Vektoren ``docs/contracts/stur-speicher-vectors.json``
gegeneinander festgenagelt. Wer die Greedy-Semantik dort aendert, aendert
BEIDE Seiten und die Vektoren zusammen.

Was der sture Speicher tut: jeden PV-Ueberschuss sofort laden (bis Leistungs-
und SoC-Grenze), jedes Defizit sofort decken (bis Leistungs- und Boden-Grenze),
sonst nichts. Er kennt keine Preise, laedt nie aus dem Netz (er laedt nur aus
Ueberschuss) und speist nie aus dem Speicher ein (er entlaedt nur bis zum
Defizit).

**Gleiche Eingaben wie der Plan** - dieselbe Batterie (Kapazitaet, Leistungen,
sqrt(eta)-Split, SoC-Band inklusive Reservations-Stack), dieselben Prognosen
(``pv_kw``/``load_kw`` NACH allen Eingabe-Korrekturen, also inklusive
PV-Nowcast-Anker und Nachtboden) und derselbe Start-Ladestand. Der Boden ist
ausdruecklich ``battery.soc_floor_kwh(soc0)`` - der RELAXIERTE Boden, mit dem
auch der MILP rechnet -, damit eine unter der Reserve startende Anlage nicht
plötzlich eine Messlatte bekommt, die Energie hat, die der Plan nicht hat.

**Bewertet wird mit derselben EINEN Preis-Wahrheit** wie ``cost_eur`` und
``baseline_cost_eur``: :meth:`OptimizationInput.cashflow_cost_eur`. Es entsteht
keine zweite Oekonomie - nur eine dritte Trajektorie durch dieselbe Formel.

⚠ **Abregelung: der sture Speicher regelt NICHT ab.** Abregelung ist eine
STEUERUNGS-Entscheidung (sie entsteht im Solver aus dem Exportwert bzw. aus
Netz-/Einspeisegrenzen); ein Standard-Hybridwechselrichter im
Eigenverbrauchsbetrieb kennt sie nicht. Die Messlatte laeuft deshalb wie
``baseline_cost_eur`` OHNE ``curtail_kw``, OHNE Paragraph-14a-Huelle und OHNE
Einspeisegrenze - **genau die Konvention, die die no-battery-Baseline seit je
faehrt**, damit die zwei Referenzen desselben Fensters vergleichbar bleiben.
Folge, bewusst und geerbt: die Abregelung eines Negativpreis-Slots erscheint
als Steuerungs-WERT (richtig - sie ist eine kluge Entscheidung), eine
Abregelung, die nur eine Einspeisegrenze einhaelt, als Steuerungs-ABZUG. Diese
Asymmetrie steckt heute schon in ``batterySavingsPlannedEur`` gegen die
no-battery-Baseline; sie wird hier geerbt, nicht neu eingefuehrt.
"""

from __future__ import annotations

from voltpilot_optimization.domain import OptimizationInput
from voltpilot_optimization.simulation.greedy import GreedyResult, greedy_dispatch


def stur_dispatch(inp: OptimizationInput) -> GreedyResult:
    """Die Trajektorie des sturen Speichers ueber den Plan-Horizont."""
    battery = inp.battery
    soc0 = battery.clamp_soc_kwh(inp.initial_soc_kwh)
    return greedy_dispatch(
        battery,
        load_kw=list(inp.load_kw),
        pv_kw=list(inp.pv_kw),
        initial_soc_kwh=soc0,
        # The PLAN's own band, relaxation included (see module docstring).
        soc_floor_kwh=battery.soc_floor_kwh(soc0),
        slot_hours=inp.slot_hours,
    )


def stur_cost_eur(inp: OptimizationInput) -> list[float]:
    """Je Slot der projizierte Cashflow des STUREN Speichers (EUR, negativ =
    Erloes) - die Messlatte, gegen die ``steuerungPlannedEur`` rechnet.

    Gleiche Preisformel wie ``cost_eur``/``baseline_cost_eur``; der Unterschied
    ist ausschliesslich die Netzleistung, die die drei Strategien erzeugen.
    """
    dispatch = stur_dispatch(inp)
    return [
        inp.cashflow_cost_eur(t, grid_kw) for t, grid_kw in enumerate(dispatch.grid_kw)
    ]
