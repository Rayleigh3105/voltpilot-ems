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
 * <p><b>Derselbe Speicher (NS-1 A, Captain 15.10.2026, Untersuchung
 * vp-herzogau-nie-schlechter-k5 §2, §7):</b> die Messlatte rechnet mit der
 * GEMESSENEN Kapazität des echten Speichers ({@link #kapazitaetKwh}), dem Band,
 * das er im selben Monat wirklich fuhr, und trägt das Hin-und-Her einer
 * Viertelstunde, das derselbe Speicher stur auch gehabt hätte
 * ({@link #hinUndHerEur}). Beides misst nur die gemessene Seite; der
 * Python-Zwilling plant mit dem Nennwert, seine Lauf-Messlatte
 * ({@code stur_cost_eur}) ist aber nur Log und Beleg - den Planwert im Portal
 * rechnet {@link PlanMesslatte} gegen diesen Walk.
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

    /**
     * Ab dieser Energie je Viertelstunde ARBEITET der echte Speicher
     * ({@code |battery_charge_kwh − battery_discharge_kwh|}, 2 kW im Mittel) -
     * die eine Schwelle hinter der Kapazität aus der Messung und dem
     * Hin-und-Her, das die Messlatte mitträgt (NS-1 A, Captain 15.10.2026).
     * Darunter liegt, was die Box in einer Ruhe-Viertelstunde tut: 0,5 kW
     * Abstand beim Decken (0,125 kWh) und kleine Defizite, die sie nachregelt.
     * Am Ring der Referenzanlage (14./15.10.2026) ist die Einteilung ab 0,5 kWh
     * stabil, darunter kippen Ruhe-Viertelstunden in „arbeitet“; die Kapazität
     * schwankt zwischen 0,1 und 1,0 kWh Schwelle nur um 59,2-59,7 kWh.
     * Regel und Fälle: {@code stur-speicher-vectors.json}, Blöcke
     * {@code kapazitaet} und {@code bewertung}.
     */
    public static final double ARBEITET_AB_KWH = 0.5;

    /**
     * So viele arbeitende Viertelstunden braucht die Kapazität aus der Messung,
     * sonst gilt der Nennwert. Der Ladestand kommt in ganzen Prozent: jede
     * Ablesung ist bis ±0,5 Punkte ungenau, die Änderung einer Viertelstunde
     * also mit σ ≈ 0,41 Punkten. Eine arbeitende Viertelstunde bewegt den
     * Speicher typisch um 5-10 Punkte; bei 96 Viertelstunden (einen Tag lang
     * Bewegung) bleibt der Rundungsfehler der Summe unter 1 % (0,41 · √96 /
     * (5 · 96)) - deutlich unter dem Unterschied zum Nennwert, um den es geht
     * (Referenzanlage: 59,7 statt 65 kWh, −8 %).
     */
    public static final int KAPAZITAET_MIN_VIERTELSTUNDEN = 96;

    /**
     * Der plausible Rahmen der gemessenen Kapazität als Anteil am Nennwert.
     * Unter 50 % liegt kein gealterter Speicher mehr (Lebensende ist 70-80 %),
     * sondern ein Messfehler; über 120 % rechnet die Messung mehr als diesen
     * Speicher (eine Mehr-Box-Anlage summiert die Speicher-Energien, der
     * Ladestand kommt nur vom primären). Außerhalb gilt der Nennwert.
     */
    static final double KAPAZITAET_MIN_ANTEIL = 0.5;
    static final double KAPAZITAET_MAX_ANTEIL = 1.2;

    private StandardSpeicher() {
    }

    /**
     * Was die Messung über die Größe des echten Speichers sagt: gerichtete
     * Summen über die arbeitenden Viertelstunden (Lade-Viertelstunden zählen
     * positiv, Entlade-Viertelstunden negativ - so heben sich Laden und
     * Entladen nicht auf). Eine Viertelstunde zählt, wenn ihr Vorgänger genau
     * 15 Minuten davor liegt und beide einen Ladestand tragen.
     *
     * @param ladenKwh Σ ± {@code battery_charge_kwh} (AC)
     * @param entladenKwh Σ ± {@code battery_discharge_kwh} (AC)
     * @param prozentpunkte Σ ± Änderung des {@code soc_last_pct} gegen den Vorgänger
     */
    public record Ladestandsmessung(
            long viertelstunden, double ladenKwh, double entladenKwh, double prozentpunkte) {

        /** Zwei Monate zusammen (Monat und Vormonat); null zählt nicht. */
        static Ladestandsmessung zusammen(Ladestandsmessung a, Ladestandsmessung b) {
            if (a == null) {
                return b;
            }
            if (b == null) {
                return a;
            }
            return new Ladestandsmessung(a.viertelstunden() + b.viertelstunden(),
                    a.ladenKwh() + b.ladenKwh(), a.entladenKwh() + b.entladenKwh(),
                    a.prozentpunkte() + b.prozentpunkte());
        }
    }

    /**
     * Die Kapazität der Messlatte (NS-1 A, Captain 15.10.2026: „Kapazität aus
     * der Messung“): so viele kWh fasst der echte Speicher je 100 Punkte
     * SEINES Ladestands. Gespeichert wird {@code η · laden − entladen / η},
     * dieselbe Physik wie {@link #schritt}; geteilt durch die Punkte, um die
     * sich der Ladestand dabei bewegt hat:
     *
     * <pre>
     *   kapazitaet = 100 · (η · Σ±laden − Σ±entladen / η) / Σ±prozentpunkte
     * </pre>
     *
     * Der Nennwert gilt, wenn die Messung keinen belastbaren Wert liefert:
     * weniger als {@link #KAPAZITAET_MIN_VIERTELSTUNDEN} arbeitende
     * Viertelstunden, keine Bewegung, oder ein Wert außerhalb
     * {@link #KAPAZITAET_MIN_ANTEIL}-{@link #KAPAZITAET_MAX_ANTEIL} des
     * Nennwerts. Referenzanlage September 2026: 59,7 kWh statt 65 kWh.
     */
    public static double kapazitaetKwh(double nennKwh, double etaOneWay, Ladestandsmessung m) {
        if (m == null || m.viertelstunden() < KAPAZITAET_MIN_VIERTELSTUNDEN
                || !(m.prozentpunkte() > 0)) {
            return nennKwh;
        }
        double gemessen = 100.0 * (etaOneWay * m.ladenKwh() - m.entladenKwh() / etaOneWay)
                / m.prozentpunkte();
        if (!(gemessen >= KAPAZITAET_MIN_ANTEIL * nennKwh
                && gemessen <= KAPAZITAET_MAX_ANTEIL * nennKwh)) {
            return nennKwh;
        }
        return gemessen;
    }

    /**
     * Die echte Seite einer Viertelstunde, wie der Rollup sie misst: Bezug und
     * Einspeisung brutto je Probe, Laden und Entladen des echten Speichers.
     */
    public record EchteViertelstunde(
            double bezugKwh, double einspeisungKwh, double ladenKwh, double entladenKwh) {
    }

    /**
     * Was die Messlatte vom Hin-und-Her einer Viertelstunde mitträgt (EUR) -
     * „gleich bewertet“ (NS-1 A), ohne die Kachel zu schönen.
     *
     * <p>Die echte Seite ist brutto je Probe bewertet (Bezug und Einspeisung
     * getrennt, Migration {@code V20260922170000}); bezieht und speist eine
     * Anlage in derselben Viertelstunde, kostet sie das
     * {@code min(bezug, einspeisung) · (Bezugspreis − Einspeisewert)} mehr als
     * netto. Der sture Speicher rechnet netto je Viertelstunde. Dieser Betrag
     * geht deshalb in den Speicher-Anteil, wenn derselbe Speicher ihn auch
     * stur gehabt hätte: in einer Viertelstunde, in der der echte Speicher
     * ARBEITET ({@link #ARBEITET_AB_KWH}), ist es Regelverzug beim Folgen
     * (die Box regelt mit 15-25 s Totzeit nach). Wartet der echte Speicher
     * oder ist er leer, hätte ein sturer Speicher das Hin und Her geschluckt -
     * dann bleibt es bei der Steuerung, wie bisher. Referenzanlage 14.10.
     * 15:00 bis 15.10. 13:30: 0,18 € trägt die Messlatte, 0,24 € bleiben bei
     * der Steuerung. {@code savedEur} bleibt brutto, wie die Rechnung des
     * Kunden; die Dreiteilung bleibt exakt.
     */
    public static double hinUndHerEur(EchteViertelstunde echt,
            double importPriceEurKwh, double exportValueEurKwh) {
        if (echt == null
                || !(Math.abs(echt.ladenKwh() - echt.entladenKwh()) >= ARBEITET_AB_KWH)) {
            return 0;
        }
        return Math.max(Math.min(echt.bezugKwh(), echt.einspeisungKwh()), 0)
                * (importPriceEurKwh - exportValueEurKwh);
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

    /** Die Stammdaten-Auflösung mit gemessenem Betriebsbereich, Kapazität = Nennwert. */
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
        return batterie(capacityKwh, maxChargeKw, maxDischargeKw, roundtripEfficiencyPct,
                socMinPct, socMaxPct, backupReserveSocPct, peakReserveSocPct,
                gemessenTiefPct, gemessenHochPct, null);
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
     * <li><b>Kapazität aus der Messung (NS-1 A, Captain 15.10.2026):</b> der
     *     Nennwert {@code capacity_kwh} ist nur der Rückfall; mit einer
     *     belastbaren {@code messung} rechnet der Vergleichsspeicher mit den kWh
     *     je 100 Ladestandspunkte, die der echte Speicher gemessen fasst
     *     ({@link #kapazitaetKwh}). Band, Reserven, Start-Ladestand und der
     *     echte Stand in kWh gelten dann auf dieser Kapazität - Prozent sind
     *     Punkte desselben Ladestands, den die Box misst.</li>
     * <li>NULL-Effizienz = Plattform-Default 92 %; η = sqrt davon.</li>
     * <li>NULL-Bandgrenzen = 5-95 %; ein inkonsistentes Band (min ≥ max)
     *     fällt wie beim Optimierer auf die Defaults zurück statt zu
     *     scheitern.</li>
     * <li><b>Betriebsbereich (M1, Captain 29.09.2026; seit NS-1 A nur noch der
     *     eigene Monat):</b> das Band ist das PLANUNGSband des Optimierers
     *     ({@code asset.soc_min_pct}/{@code soc_max_pct}); die Box hält es als
     *     harte Wächter-Grenze ({@code guards.Clamp}, Stufe 2: kein Laden ab
     *     {@code VP_SOC_MAX_PCT}, kein Entladen bis {@code VP_SOC_MIN_PCT}).
     *     Bricht der echte Speicher trotzdem aus - Pilsting fuhr im September
     *     2-100 % -, weitet der gemessene Bereich DESSELBEN Monats
     *     ({@code gemessenTiefPct}/{@code gemessenHochPct},
     *     {@link #BETRIEBSBEREICH_EIMER}-Regel) das Band. Er verengt es NIE und
     *     wird nicht mehr aus dem Vormonat geerbt: hält der Wächter (Pilsting
     *     im Oktober, 792 Minuten am Boden von 5 %), fahren Steuerung und
     *     Vergleichsspeicher dasselbe Band.</li>
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
            BigDecimal gemessenHochPct,
            Ladestandsmessung messung) {
        if (capacityKwh == null || maxChargeKw == null || maxDischargeKw == null) {
            return null;
        }
        double nennKapazitaet = capacityKwh.doubleValue();
        double charge = maxChargeKw.doubleValue();
        double discharge = maxDischargeKw.doubleValue();
        if (nennKapazitaet <= 0 || charge <= 0 || discharge <= 0) {
            return null;
        }
        double roundtrip = roundtripEfficiencyPct == null
                ? DEFAULT_ROUNDTRIP_EFFICIENCY
                : roundtripEfficiencyPct.doubleValue() / 100.0;
        if (!(roundtrip > 0 && roundtrip <= 1.0)) {
            return null;
        }
        double capacity = kapazitaetKwh(nennKapazitaet, Math.sqrt(roundtrip), messung);
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

        /**
         * Derselbe Slot, gleich bewertet wie die echte Seite: der sture
         * Speicher trägt zusätzlich das Hin-und-Her, das derselbe Speicher in
         * dieser Viertelstunde auch gehabt hätte ({@link #hinUndHerEur}).
         */
        public void slot(double pvKwh, double loadKwh,
                double importPriceEurKwh, double exportValueEurKwh, EchteViertelstunde echt) {
            slot(pvKwh, loadKwh, importPriceEurKwh, exportValueEurKwh);
            speicherEur -= hinUndHerEur(echt, importPriceEurKwh, exportValueEurKwh);
        }

        /**
         * Σ (discharge × importPrice − charge × exportValue) so far, minus the
         * Hin-und-Her the Messlatte carries (only via the five-argument slot).
         */
        public double speicherEur() {
            return speicherEur;
        }

        /** The reference battery's SoC after the last slot (kWh) - the Vergleichsspeicher-Stand. */
        public double socKwh() {
            return socKwh;
        }
    }
}
