package com.voltpilot.api.repo;

import java.math.BigDecimal;
import java.math.RoundingMode;

/**
 * Das BESTANDSKONTO des gemessenen Zeitraums - die reine Hälfte der
 * FK2-Gutschrift für den GEMESSENEN Tag (Diagnose {@code vp-tagesbild-minus-f3}
 * §6.1).
 *
 * <p><b>Der behobene Befund.</b> {@code savedEur} ist eine ZAHLUNGSBILANZ ohne
 * Bestandskonto: sie bewertet jede Viertelstunde nur nach dem, was über den
 * Netzanschluss GEFLOSSEN ist. Energie, die in den Speicher wandert, zählt darin
 * als entgangener Einspeise-Erlös (Minus) - ihr Gegenwert (der Abend) existiert
 * mittags noch nicht. Am 21.08.2026 stand deshalb um 12:19 „−4,69 €" über einem
 * ökonomisch einwandfreien Plan, während ≈ 44 kWh im Speicher lagen. Der
 * Juli-Fix FK2 ({@code ScheduleRepository.bankedValue}, PR #144) rechnet genau
 * diese Gutschrift - aber nur für den PLAN auf der Fahrplan-Seite.
 *
 * <p><b>Die Leitentscheidung:</b> {@code savedEur} bleibt, was es ist (die
 * gemessene Kasse). Es entsteht ein ZWEITER, klar als „nach dem Plan bewertet"
 * beschrifteter Posten daneben - nie ein Summand in {@code savedEur}, sonst
 * gäbe es zwei Geldwahrheiten über dieselbe Kasse.
 *
 * <p><b>Die Bewertung ist λ, und zwar bewusst</b> ({@code stored_value_ct_kwh},
 * der vom Optimierer selbst persistierte Wert einer GESPEICHERTEN kWh -
 * Verluste und Verschleiß sind darin schon enthalten, also nie ein zweites η).
 * Zum Tarif oder zum Abendpreis zu bewerten erfände eine Verwendung, die der
 * Plan nicht garantiert. Rückfall ist der Terminalwert des Laufs
 * ({@code terminal_value_eur_per_kwh}, die FK2-Präzedenz); ohne beides bleibt
 * die Bewertung NULL und die Fläche zeigt nur die gemessenen kWh.
 *
 * <p><b>Beide Vorzeichen sind legitim und müssen beide gezeigt werden</b>
 * (FK2-Wortlaut): positiv = in den Folgetag gespeichert, negativ = aus dem
 * Vortag entnommen. Ein Tag, der die Bank des Vortags verbraucht, überclaimt
 * sonst.
 *
 * <p>Rein und Docker-frei prüfbar wie {@link MeasuredSlots} / {@code
 * Tagesprotokoll} / {@code FleetPflege}: die SQL-Hälfte (drei schmale
 * Abfragen) steht in {@link EarningsRepository#storageBank}.
 */
public final class SpeicherBank {

    /** λ kam aus dem persistierten Slot-Wert des Optimierers (der Normalfall). */
    public static final String BASIS_PLAN = "plan";

    /** λ kam aus dem Terminalwert des Laufs (der FK2-Rückfall). */
    public static final String BASIS_TERMINAL = "terminal";

    private static final BigDecimal HUNDRED = BigDecimal.valueOf(100);

    private SpeicherBank() {
    }

    /**
     * Der Bestand eines Zeitraums: wie viel Energie am Ende MEHR (oder weniger)
     * im Speicher steckt als am Anfang, und was der Plan sie wert findet.
     *
     * <p>Jedes Feld ist {@code null}, sobald es nicht belegbar ist - nie eine
     * erfundene 0: ein Speicher, dessen Stand nicht gemessen wurde, hat nicht
     * „nichts gespeichert", und eine Anlage ohne Plan-Bewertung hat keinen
     * Gegenwert von 0 €.
     *
     * @param deltaKwh die Bestandsänderung in kWh (+ gespeichert / − entnommen)
     * @param wertCtKwh die Bewertung je gespeicherter kWh in ct/kWh
     * @param wertEur {@code deltaKwh × wertCtKwh / 100} in EUR
     * @param basis {@link #BASIS_PLAN} oder {@link #BASIS_TERMINAL} - womit
     *     bewertet wurde, damit die Fläche es sagen kann; {@code null} ohne
     *     Bewertung
     */
    public record Bestand(
            BigDecimal deltaKwh, BigDecimal wertCtKwh, BigDecimal wertEur, String basis) {

        /** Nichts Belegbares - vier ehrliche Nullen. */
        public static final Bestand NONE = new Bestand(null, null, null, null);
    }

    /**
     * Die eine Ableitung. Alle Eingaben dürfen fehlen; jede fehlende nimmt genau
     * die Aussagen mit, die auf ihr beruhen.
     *
     * @param socEndPct Ladestand am Ende des Fensters (bzw. JETZT, solange der
     *     Zeitraum läuft), in Prozent
     * @param socStartPct Ladestand unmittelbar VOR dem Fenster, in Prozent
     * @param capacityKwh nutzbare Nennkapazität des primären Speichers
     * @param storedValueCtKwh λ des maßgeblichen Slots (ct/kWh), oder null
     * @param terminalValueEurKwh der Terminalwert des Laufs (EUR/kWh), oder null
     */
    public static Bestand of(BigDecimal socEndPct, BigDecimal socStartPct,
            BigDecimal capacityKwh, BigDecimal storedValueCtKwh,
            BigDecimal terminalValueEurKwh) {
        BigDecimal wertCtKwh = wertCtKwh(storedValueCtKwh, terminalValueEurKwh);
        String basis = wertCtKwh == null ? null
                : storedValueCtKwh != null ? BASIS_PLAN : BASIS_TERMINAL;
        BigDecimal delta = deltaKwh(socEndPct, socStartPct, capacityKwh);
        BigDecimal wertEur = delta == null || wertCtKwh == null ? null
                : delta.multiply(wertCtKwh).divide(HUNDRED, 4, RoundingMode.HALF_UP);
        return new Bestand(delta, wertCtKwh, wertEur, basis);
    }

    /**
     * Die Bestandsänderung in kWh. Ohne beide Ladestände oder ohne eine
     * plausible Kapazität gibt es keine - eine 0 behauptete „der Speicher stand
     * still", was etwas ganz anderes ist als „wir wissen es nicht".
     */
    private static BigDecimal deltaKwh(
            BigDecimal socEndPct, BigDecimal socStartPct, BigDecimal capacityKwh) {
        if (socEndPct == null || socStartPct == null
                || capacityKwh == null || capacityKwh.signum() <= 0) {
            return null;
        }
        return socEndPct.subtract(socStartPct)
                .multiply(capacityKwh)
                .divide(HUNDRED, 3, RoundingMode.HALF_UP);
    }

    /**
     * λ in ct/kWh: der persistierte Slot-Wert gewinnt, sonst der Terminalwert
     * des Laufs (EUR/kWh → ct/kWh). Der Terminalwert ist bewusst nur der
     * RÜCKFALL: λ ist der Wert im maßgeblichen Slot, der Terminalwert der am
     * Horizont-Ende.
     */
    private static BigDecimal wertCtKwh(
            BigDecimal storedValueCtKwh, BigDecimal terminalValueEurKwh) {
        if (storedValueCtKwh != null) {
            return storedValueCtKwh;
        }
        return terminalValueEurKwh == null ? null : terminalValueEurKwh.multiply(HUNDRED);
    }
}
