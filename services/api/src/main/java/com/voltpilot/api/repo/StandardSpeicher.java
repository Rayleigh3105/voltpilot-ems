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

    /**
     * So viele Viertelstunden muss der echte Speicher einen Ladestand erreicht
     * haben, damit er zum gemessenen Betriebsbereich zählt (der vierte
     * niedrigste {@code soc_min_pct} bzw. vierte höchste {@code soc_max_pct}
     * eines Berliner Monats): ein einzelner Ausreißer-Wert verschiebt die
     * Messlatte nicht. Regel und Fälle: {@code stur-speicher-vectors.json},
     * Block {@code betriebsbereich}.
     */
    public static final int BETRIEBSBEREICH_EIMER = 4;

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

    /** Die Stammdaten-Auflösung ohne gemessenen Betriebsbereich (nur das Band). */
    public static Batterie batterie(
            BigDecimal capacityKwh,
            BigDecimal maxChargeKw,
            BigDecimal maxDischargeKw,
            BigDecimal roundtripEfficiencyPct,
            BigDecimal socMinPct,
            BigDecimal socMaxPct,
            BigDecimal backupReserveSocPct,
            BigDecimal peakReserveSocPct) {
        return batterie(capacityKwh, maxChargeKw, maxDischargeKw, roundtripEfficiencyPct,
                socMinPct, socMaxPct, backupReserveSocPct, peakReserveSocPct, null, null);
    }

    /**
     * Löst die Spalten, die auch der Optimierer liest, in die Referenz-Physik
     * auf - die Regeln von {@code inputs.load_battery_sites} +
     * {@code _soc_band} + {@code BatteryParams.soc_floor_kwh}, erweitert um
     * den GEMESSENEN Betriebsbereich des echten Speichers:
     *
     * <ul>
     * <li>Kapazität/Leistungen sind PFLICHT - fehlt eine (oder ist sie nicht
     *     positiv), gibt es {@code null} statt einer geratenen Batterie.</li>
     * <li>NULL-Effizienz = Plattform-Default 92 %; η = sqrt davon.</li>
     * <li>NULL-Bandgrenzen = 5-95 %; ein inkonsistentes Band (min ≥ max)
     *     fällt wie beim Optimierer auf die Defaults zurück statt zu
     *     scheitern.</li>
     * <li><b>Betriebsbereich (Korrektur M1, Captain 29.09.2026 „mach alle
     *     drei“, Minus-Untersuchung vp-erloes-minus-heute-u1 §9):</b> das Band
     *     ist das PLANUNGSband des Optimierers ({@code asset.soc_min_pct}/
     *     {@code soc_max_pct} sind zugleich die Wächter-Grenzen der Box), nicht
     *     der Bereich, den derselbe Speicher ohne smarte Steuerung fährt. Der
     *     Deye in Pilsting plant 5-95 %, fährt aber gemessen 2-100 %; ein
     *     Vergleichsspeicher mit 5-95 % war kleiner als der echte, und der
     *     Unterschied erschien als „Vorsprung“ der Steuerung. Deshalb weitet
     *     der gemessene Bereich ({@code gemessenTiefPct}/{@code gemessenHochPct},
     *     {@link #BETRIEBSBEREICH_EIMER}-Regel, je Monat aus diesem und dem
     *     Vormonat) das Band - er verengt es NIE: was die Steuerung planen
     *     darf, darf der Vergleichsspeicher auch.</li>
     * <li>Backup-/Peak-Reserve heben den Boden danach absolut an ({@code max},
     *     nie additiv), gedeckelt an der Obergrenze - der Reservations-STACK
     *     von {@code soc_floor_kwh}.</li>
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
            BigDecimal peakReserveSocPct,
            BigDecimal gemessenTiefPct,
            BigDecimal gemessenHochPct) {
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
        if (gemessenTiefPct != null && gemessenTiefPct.signum() >= 0) {
            socMin = Math.min(socMin, gemessenTiefPct.doubleValue() / 100.0);
        }
        if (gemessenHochPct != null && gemessenHochPct.doubleValue() <= 100.0) {
            socMax = Math.max(socMax, gemessenHochPct.doubleValue() / 100.0);
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
     * Ein Slot der Referenz-Physik ({@code greedy_dispatch}s Schleifenkörper in
     * kWh je Slot): geladene bzw. entladene AC-Energie und der Ladestand
     * danach. Genau eine der beiden Energien ist positiv, oder keine.
     */
    public record Schritt(double chargeKwh, double dischargeKwh, double socKwh) {
    }

    /**
     * Die sture Regel für EINEN Slot ab {@code socKwh}: jeden Überschuss
     * sofort laden (bis Leistungs- und SoC-Grenze), jedes Defizit sofort decken
     * (bis Leistungs- und Boden-Grenze). Der {@link Walk} rechnet damit über
     * gemessene Energien, {@link PlanMesslatte} über die Prognose des
     * Fahrplans - dieselbe Physik an EINER Stelle.
     */
    public static Schritt schritt(Batterie batterie, double socKwh, double pvKwh, double loadKwh) {
        double surplus = pvKwh - loadKwh;
        if (surplus > 0) {
            double charge = Math.min(surplus, Math.min(
                    batterie.maxChargeKw() * SLOT_HOURS,
                    (batterie.socMaxKwh() - socKwh) / batterie.etaOneWay()));
            charge = Math.max(charge, 0);
            return new Schritt(charge, 0, socKwh + batterie.etaOneWay() * charge);
        }
        if (surplus < 0) {
            double discharge = Math.min(-surplus, Math.min(
                    batterie.maxDischargeKw() * SLOT_HOURS,
                    (socKwh - batterie.socFloorKwh()) * batterie.etaOneWay()));
            discharge = Math.max(discharge, 0);
            return new Schritt(0, discharge, socKwh - discharge / batterie.etaOneWay());
        }
        return new Schritt(0, 0, socKwh);
    }

    /**
     * Der Zustands-Walk über die covered Slots EINER Anlage (das
     * {@code arbitrageSplit}-Muster: Slots zeitlich sortiert, Zustand im
     * Speicher geführt).
     *
     * <p><b>Start-SoC (Eckpunkt 3, dokumentierte Näherung):</b> am GEMESSENEN
     * Ladestand zum Berliner MONATSBEGINN, wenn einer vorliegt (der letzte
     * {@code soc_last_pct}-Rollup-Eimer VOR dem 1., 00:00, 7-Tage-Rückschau -
     * die {@code storageBank}-Anker-Disziplin), sonst am SoC-Boden wie in der
     * Simulation. Beide Strategien treten so einmal im Monat aus derselben
     * gemessenen Vergangenheit an, statt dem sturen Speicher einen leeren
     * Morgen anzudichten, den die echte Anlage nicht hatte. Danach führt der
     * sture Speicher seinen EIGENEN Ladestand über jede Mitternacht (Definition
     * A, Captain 24.09.2026): ein Tag, der am Stand der gesteuerten Anlage neu
     * begänne, schenkte der Steuerung jeden Übertrag über Mitternacht. Wo der
     * Walk anfängt und neu verankert, entscheidet
     * {@code EarningsRepository.speicherWalk}; diese Klasse kennt nur einen
     * Start. Der Start wird wie in {@code greedy_dispatch} in das Band
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
            Schritt s = schritt(batterie, socKwh, pvKwh, loadKwh);
            socKwh = s.socKwh();
            speicherEur += s.dischargeKwh() * importPriceEurKwh
                    - s.chargeKwh() * exportValueEurKwh;
        }

        /** Σ (discharge × importPrice − charge × exportValue) so far. */
        public double speicherEur() {
            return speicherEur;
        }

        /** The reference battery's SoC after the last slot (kWh) - the Vergleichsspeicher-Stand. */
        public double socKwh() {
            return socKwh;
        }
    }
}
