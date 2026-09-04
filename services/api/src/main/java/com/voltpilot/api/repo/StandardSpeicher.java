package com.voltpilot.api.repo;

import java.math.BigDecimal;

/**
 * Der STUR arbeitende Standard-Speicher - die reine Referenz-Physik hinter der
 * Dreiteilung {@code saved_gesamt = saved_speicher + saved_steuerung} (Audit
 * vp-geldzahlen-audit-x7 §2.5, Befund B1).
 *
 * <p><b>Das Referenz-Modell ist EXAKT das Greedy-Szenario (b)
 * "Standard-Speicher" der Ersparnis-Simulation</b>
 * ({@code services/optimization/voltpilot_optimization/simulation/greedy.py} -
 * unit-getestet, captain-abgenommen): gleiche Physik wie der Optimierer
 * (Kapazität, Lade-/Entladeleistung, sqrt(η)-Split der Round-Trip-Effizienz,
 * SoC-Band inkl. Backup-/Peak-Reserven als Boden), lädt jeden PV-Überschuss
 * sofort, deckt jedes Defizit sofort, lädt nie aus dem Netz, null
 * Preisbewusstsein. <b>Diese Klasse ist der Java-Zwilling dieses Modells -
 * wer die Greedy-Semantik dort ändert, ändert sie hier mit</b> (die
 * SlotEconomics⟷pricing.py-Disziplin). <b>Die EINE Regel und die geteilten
 * Vektoren stehen in {@code docs/contracts/stur-speicher-vectors.json}</b> -
 * beide Zwillinge lesen sie PER PFAD ({@code StandardSpeicherTest} hier,
 * {@code services/optimization/tests/test_stur.py} drüben), damit die
 * GEPLANTE Messlatte des Optimierers ({@code steuerungPlannedEur}) und die
 * GEMESSENE ({@code savedSteuerungEur}) denselben sturen Speicher meinen;
 * die Vektoren von {@code test_simulation.py} sind zusätzlich in
 * {@code StandardSpeicherTest} gespiegelt). Es wird bewusst KEINE neue Ökonomie erfunden: die Bewertung
 * der Slots übernimmt der Aufrufer mit denselben Preis-Kompositionen wie
 * {@code savedEur} ({@code importPriceCtSql}/{@code exportValueCtSql}).
 *
 * <p><b>Die per-Slot-Wertformel</b> (Herleitung, einmal ausgeschrieben): die
 * speicherlose Baseline eines Slots ist
 * {@code max(load−pv,0)·ip − max(pv−load,0)·ev}. Der Standard-Speicher
 * verschiebt davon {@code discharge} kWh vom Import weg (er deckt Defizit,
 * nie mehr als das Defizit) und {@code charge} kWh vom Export weg (er lädt
 * Überschuss, nie mehr als den Überschuss), also ist seine Baseline
 * {@code (max(load−pv,0)−discharge)·ip − (max(pv−load,0)−charge)·ev}. Die
 * Differenz - der Wert des sturen Speichers gegenüber gar keinem - ist damit
 * je Slot exakt
 *
 * <pre>
 *   saved_speicher_slot = discharge · importPrice − charge · exportValue
 * </pre>
 *
 * (jede entladene kWh vermeidet Import zum Tarif, jede geladene kWh entgeht
 * dem Export zum Exportwert - inkl. einer entgangenen DV-Marktprämie, weil
 * {@code ev} sie trägt; in einem Negativpreis-Slot ist {@code −charge·ev}
 * positiv: der sture Speicher vermeidet dort legitim bezahlten Export).
 *
 * <p><b>Gerechnet wird in double</b> (das dokumentierte
 * {@code arbitrageSplit}-Vorbild); die Rekonziliation trägt der Rest-Trick
 * des Aufrufers ({@code saved_steuerung = saved − saved_speicher} als
 * BigDecimal-Subtraktion), nicht die Gleitkomma-Genauigkeit.
 *
 * <p><b>Slot-Lücken:</b> der Walk sieht nur COVERED Slots (dieselbe Menge,
 * die {@code savedEur} summiert - Teile und Summe beschreiben dieselben
 * Slots). Über nicht bewertbare Slots hinweg wird der SoC UNVERÄNDERT
 * getragen: der sture Speicher gilt dort als untätig - alles andere wäre eine
 * Simulation über Messwerte, die es nicht gibt.
 */
public final class StandardSpeicher {

    /** Slot length of the 15-min rollups in hours (greedy.py SLOT_HOURS). */
    public static final double SLOT_HOURS = 0.25;

    /** Platform default usable SoC band (domain.py DEFAULT_SOC_MIN/MAX_FRACTION). */
    private static final double DEFAULT_SOC_MIN_FRACTION = 0.05;
    private static final double DEFAULT_SOC_MAX_FRACTION = 0.95;

    /** Platform default round-trip efficiency (inputs.py load_battery_sites). */
    private static final double DEFAULT_ROUNDTRIP_EFFICIENCY = 0.92;

    private StandardSpeicher() {
    }

    /**
     * Die aufgelösten Batterie-Stammdaten des Referenz-Speichers -
     * {@code null}, wenn sie nicht gepflegt sind (dann wird NICHT geraten,
     * die Dreiteilung bleibt ehrlich aus; Eckpunkt 4 der Umbau-Skizze).
     *
     * @param etaOneWay per-direction efficiency, {@code sqrt(roundtrip)}
     * @param socFloorKwh the effective floor: the technical minimum raised by
     *     the reservation stack (backup/peak reserve), capped at the ceiling
     * @param socMaxKwh the usable ceiling ({@code capacity × soc_max_fraction})
     */
    public record Batterie(
            double capacityKwh,
            double maxChargeKw,
            double maxDischargeKw,
            double etaOneWay,
            double socFloorKwh,
            double socMaxKwh) {
    }

    /**
     * Löst die Spalten, die auch der Optimierer liest, in die Referenz-Physik
     * auf - WÖRTLICH die Regeln von {@code inputs.load_battery_sites} +
     * {@code _soc_band} + {@code BatteryParams.soc_floor_kwh}, damit die
     * Anzeige mit denselben Stammdaten urteilt, mit denen geplant wird:
     *
     * <ul>
     * <li>Kapazität/Leistungen sind PFLICHT - fehlt eine (oder ist sie nicht
     *     positiv), gibt es {@code null} statt einer geratenen Batterie.</li>
     * <li>NULL-Effizienz = Plattform-Default 92 %; η = sqrt davon.</li>
     * <li>NULL-Bandgrenzen = 5-95 %; ein inkonsistentes Band (min ≥ max)
     *     fällt wie beim Optimierer auf die Defaults zurück statt zu
     *     scheitern - der Optimierer plant dann ebenfalls mit den Defaults,
     *     die zwei Urteile bleiben deckungsgleich.</li>
     * <li>Backup-/Peak-Reserve heben den Boden absolut an ({@code max}, nie
     *     additiv), gedeckelt an der Obergrenze - der Reservations-STACK von
     *     {@code soc_floor_kwh}.</li>
     * </ul>
     */
    public static Batterie batterie(
            BigDecimal capacityKwh,
            BigDecimal maxChargeKw,
            BigDecimal maxDischargeKw,
            BigDecimal roundtripEfficiencyPct,
            BigDecimal socMinPct,
            BigDecimal socMaxPct,
            BigDecimal backupReserveSocPct,
            BigDecimal peakReserveSocPct) {
        if (capacityKwh == null || maxChargeKw == null || maxDischargeKw == null) {
            return null;
        }
        double capacity = capacityKwh.doubleValue();
        double charge = maxChargeKw.doubleValue();
        double discharge = maxDischargeKw.doubleValue();
        if (capacity <= 0 || charge <= 0 || discharge <= 0) {
            return null;
        }
        double roundtrip = roundtripEfficiencyPct == null
                ? DEFAULT_ROUNDTRIP_EFFICIENCY
                : roundtripEfficiencyPct.doubleValue() / 100.0;
        if (!(roundtrip > 0 && roundtrip <= 1.0)) {
            return null;
        }
        double socMin = socMinPct == null
                ? DEFAULT_SOC_MIN_FRACTION : socMinPct.doubleValue() / 100.0;
        double socMax = socMaxPct == null
                ? DEFAULT_SOC_MAX_FRACTION : socMaxPct.doubleValue() / 100.0;
        if (!(socMin >= 0 && socMin < socMax && socMax <= 1.0)) {
            // The optimizer's _soc_band discipline: inconsistent master data
            // falls back to the platform band instead of killing the number.
            socMin = DEFAULT_SOC_MIN_FRACTION;
            socMax = DEFAULT_SOC_MAX_FRACTION;
        }
        double socMaxKwh = capacity * socMax;
        double floor = capacity * socMin;
        for (BigDecimal reserve : new BigDecimal[] {backupReserveSocPct, peakReserveSocPct}) {
            if (reserve != null) {
                floor = Math.min(Math.max(floor, capacity * reserve.doubleValue() / 100.0),
                        socMaxKwh);
            }
        }
        return new Batterie(capacity, charge, discharge, Math.sqrt(roundtrip),
                floor, socMaxKwh);
    }

    /**
     * Der Zustands-Walk über die covered Slots EINER Anlage (das
     * {@code arbitrageSplit}-Muster: Slots zeitlich sortiert, Zustand im
     * Speicher geführt).
     *
     * <p><b>Start-SoC (Eckpunkt 3, dokumentierte Näherung):</b> am GEMESSENEN
     * Ladestand des Fensterbeginns, wenn einer vorliegt (der letzte
     * {@code soc_last_pct}-Rollup-Eimer VOR dem Fenster, 7-Tage-Rückschau -
     * die {@code storageBank}-Anker-Disziplin), sonst am SoC-Boden wie in der
     * Simulation. Für lange Fenster ({@code range=all}, Jahr) wäscht sich der
     * Start heraus und der Boden entspricht exakt dem Simulations-Modell; für
     * TAGES-Fenster ist der gemessene Stand der ehrliche Anker - beide
     * Strategien treten aus derselben gemessenen Vergangenheit an, statt dem
     * sturen Speicher einen leeren Morgen anzudichten, den die echte Anlage
     * nicht hatte. Der Start wird wie in {@code greedy_dispatch} in das Band
     * {@code [floor, max]} geklemmt.
     */
    public static final class Walk {

        private final Batterie batterie;
        private double socKwh;
        private double speicherEur;

        public Walk(Batterie batterie, Double startSocKwh) {
            this.batterie = batterie;
            this.socKwh = startSocKwh == null
                    ? batterie.socFloorKwh()
                    : Math.min(Math.max(startSocKwh, batterie.socFloorKwh()),
                            batterie.socMaxKwh());
        }

        /**
         * One covered 15-min slot: dispatch the greedy reference against the
         * MEASURED pv/load energies, value the dispatch at the slot's real
         * prices (EUR/kWh, the one composition truth selected in SQL).
         * Mirrors {@code greedy_dispatch}'s loop body in kWh form
         * (kW × 0.25 h = kWh/slot).
         */
        public void slot(double pvKwh, double loadKwh,
                double importPriceEurKwh, double exportValueEurKwh) {
            double surplus = pvKwh - loadKwh;
            if (surplus > 0) {
                double charge = Math.min(surplus, Math.min(
                        batterie.maxChargeKw() * SLOT_HOURS,
                        (batterie.socMaxKwh() - socKwh) / batterie.etaOneWay()));
                charge = Math.max(charge, 0);
                socKwh += batterie.etaOneWay() * charge;
                speicherEur -= charge * exportValueEurKwh;
            } else if (surplus < 0) {
                double discharge = Math.min(-surplus, Math.min(
                        batterie.maxDischargeKw() * SLOT_HOURS,
                        (socKwh - batterie.socFloorKwh()) * batterie.etaOneWay()));
                discharge = Math.max(discharge, 0);
                socKwh -= discharge / batterie.etaOneWay();
                speicherEur += discharge * importPriceEurKwh;
            }
        }

        /** Σ (discharge × importPrice − charge × exportValue) so far. */
        public double speicherEur() {
            return speicherEur;
        }

        /** The reference battery's SoC after the last slot (kWh; for tests). */
        public double socKwh() {
            return socKwh;
        }
    }
}
