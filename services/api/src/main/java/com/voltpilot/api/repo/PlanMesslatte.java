package com.voltpilot.api.repo;

import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;

/**
 * Der PLANWERT der Steuerung gegen DENSELBEN durchlaufenden
 * Vergleichsspeicher wie die gemessene Tageszahl (Korrektur M2, Captain
 * 29.09.2026 „mach alle drei“, Minus-Untersuchung vp-erloes-minus-heute-u1 §9).
 *
 * <p><b>Warum nicht mehr {@code Σ(stur_cost_eur − cost_eur)}:</b> der sture
 * Speicher des Optimierers ({@code stur.py}) startet in JEDEM Lauf beim echten
 * Ladestand. Weil je Viertelstunde der jüngste Lauf zählt, kannte der
 * Planwert nie einen Übertrag: nach einem Abendverkauf stand der geplante
 * sture Speicher nachts so leer wie der echte, der gemessene
 * Vergleichsspeicher (Definition A, {@link EarningsRepository}) aber voll.
 * Plan Σ 06.–29.09. 245,74 € gegen gemessen 136,93 €, und „so geplant“ /
 * „anders als geplant“ ({@link SteuerungGrund}) verglichen zwei verschiedene
 * Messlatten.
 *
 * <p><b>Die Regel je Fahrplan-Viertelstunde {@code t}</b> (der jüngste Lauf,
 * dieselbe Slot-Menge wie bisher):
 * <ul>
 *   <li>Der sture Speicher startet am JÜNGSTEN bekannten Stand des
 *       Vergleichsspeichers - aus demselben Walk, mit derselben Batterie (Band
 *       und Betriebsbereich, M1) und demselben Monatsanker. Ist der Eimer vor
 *       {@code t} gemessen, ist das der gemessene Stand; genau so startet der
 *       Plan selbst, denn der jüngste Lauf plant {@code t} ab dem echten
 *       Ladestand kurz davor. Beide Seiten treten also aus ihrem tatsächlichen
 *       Stand an und bewegen sich mit derselben Prognose.</li>
 *   <li>Ist der Eimer vor {@code t} NICHT gemessen (die laufende
 *       Viertelstunde, die Zukunft, eine Messlücke), läuft der sture Speicher
 *       über die Prognose des Fahrplans weiter, Slot für Slot - es sei denn,
 *       ein gemessener Stand ist jünger als sein eigener. Ein alter Stand wird
 *       so nie zweimal entladen.</li>
 *   <li>Die Physik ist {@link StandardSpeicher#schritt} auf der Prognose
 *       ({@code pv_kw}/{@code load_kw} × 0,25 h), bewertet mit der EINEN
 *       Preisformel des Optimierers: {@code cashflow_cost_eur} ist je Richtung
 *       linear durch null, und der sture Speicher bleibt auf der Seite des
 *       Restbedarfs (er lädt nur Überschuss, deckt nur Defizit). Deshalb ist
 *       {@code stur = baseline_cost_eur × Netz_stur / (load − pv)} exakt - ohne
 *       zweite Preiswahrheit.</li>
 * </ul>
 *
 * <p><b>Null-Regel wie bisher:</b> trägt ein gezählter Slot keine Messlatte
 * ({@code stur_cost_eur} NULL: Lauf ohne Ladestand, P7, oder vor Migration
 * V20260867000000), fehlt eine Prognose oder gibt es keinen
 * Vergleichsspeicher (keine Batterie-Stammdaten, kein Eimer im Monat), ist der
 * Planwert null - nie eine Teil-Summe. Der Wert von {@code stur_cost_eur}
 * selbst geht nicht mehr ein; er bleibt die Sicht des einzelnen Laufs (Log).
 *
 * <p>Rein und Docker-frei prüfbar; die Eingaben liefert
 * {@link EarningsRepository}.
 */
public final class PlanMesslatte {

    /** Unter diesem Restbedarf (kWh je Slot) bewegt der sture Speicher nichts. */
    private static final double RUHE_KWH = 1e-9;

    /** Die Länge eines Fahrplan-Slots. */
    private static final Duration SLOT = Duration.ofMinutes(15);

    private PlanMesslatte() {
    }

    /**
     * Der Verlauf des Vergleichsspeichers EINER Anlage aus dem Walk.
     *
     * @param staende Ladestand (kWh), gültig AB dem Zeitpunkt: je Monat der
     *     Start (Anker oder Boden) am Monatsbeginn, danach der Stand nach jedem
     *     covered Eimer an dessen Ende; über Lücken bleibt er stehen
     * @param batterien die Batterie je Monatsbeginn (Band und Betriebsbereich
     *     gelten je Monat)
     */
    public record Vergleich(
            NavigableMap<Instant, Double> staende,
            NavigableMap<Instant, StandardSpeicher.Batterie> batterien) {
    }

    /**
     * Eine Viertelstunde des Fahrplans (der jüngste Lauf, der sie plante).
     *
     * @param messlatte ob der Lauf eine Messlatte trug ({@code stur_cost_eur}
     *     NOT NULL) - nur noch als Beleg, dass er aus einem gemessenen
     *     Ladestand plante
     */
    public record Slot(
            Instant time,
            BigDecimal pvKw,
            BigDecimal loadKw,
            BigDecimal baselineCostEur,
            BigDecimal costEur,
            boolean messlatte) {
    }

    /**
     * Wo die Fahrplan-Slots für {@code [from, …)} zu lesen beginnen: am jüngsten
     * gemessenen Stand vor {@code from}. Von dort an ist die Fortschreibung
     * dieselbe, egal wie groß das Fenster ist - ein Tag sagt dasselbe wie der
     * Monat, der ihn enthält.
     */
    public static Instant leseBeginn(Vergleich vergleich, Instant from) {
        Instant k = vergleich == null ? null : vergleich.staende().floorKey(from);
        return k == null ? from : k;
    }

    /**
     * Σ über die Slots in {@code [from, to)} von (sturer Speicher − Plan),
     * oder null (Null-Regel oben). {@code slots} zeitlich aufsteigend, ab
     * {@link #leseBeginn}; Slots vor {@code from} schreiben den sturen
     * Speicher nur fort.
     */
    public static BigDecimal steuerungEur(Vergleich vergleich, List<Slot> slots,
            Instant from, Instant to) {
        if (vergleich == null || vergleich.staende().isEmpty() || slots == null) {
            return null;
        }
        double summe = 0;
        boolean gezaehlt = false;
        Double fort = null;
        Instant fortAb = null;
        for (Slot slot : slots) {
            boolean zaehlt = !slot.time().isBefore(from) && slot.time().isBefore(to);
            if (zaehlt && !slot.messlatte()) {
                return null;
            }
            if (slot.pvKw() == null || slot.loadKw() == null) {
                if (zaehlt) {
                    return null;
                }
                continue;
            }
            // Der jüngste bekannte Stand: gemessen, wenn er mindestens so jung
            // ist wie die eigene Fortschreibung, sonst die Fortschreibung.
            Map.Entry<Instant, Double> gemessen = vergleich.staende().floorEntry(slot.time());
            Double start = fort != null
                    && (gemessen == null || gemessen.getKey().isBefore(fortAb))
                    ? fort
                    : gemessen == null ? null : gemessen.getValue();
            if (start == null) {
                if (zaehlt) {
                    return null;
                }
                continue;
            }
            StandardSpeicher.Batterie batterie = batterie(vergleich, slot.time());
            double pvKwh = slot.pvKw().doubleValue() * StandardSpeicher.SLOT_HOURS;
            double loadKwh = slot.loadKw().doubleValue() * StandardSpeicher.SLOT_HOURS;
            StandardSpeicher.Schritt schritt =
                    StandardSpeicher.schritt(batterie, start, pvKwh, loadKwh);
            fort = schritt.socKwh();
            fortAb = slot.time().plus(SLOT);
            if (zaehlt) {
                summe += sturKostenEur(slot.baselineCostEur().doubleValue(),
                        loadKwh - pvKwh, schritt) - slot.costEur().doubleValue();
                gezaehlt = true;
            }
        }
        return gezaehlt ? BigDecimal.valueOf(summe) : null;
    }

    /**
     * Der Cashflow des sturen Speichers in einem Slot aus der Baseline
     * desselben Slots: {@code baseline × (Rest + Laden − Entladen) / Rest}.
     */
    static double sturKostenEur(double baselineCostEur, double restKwh,
            StandardSpeicher.Schritt schritt) {
        if (Math.abs(restKwh) < RUHE_KWH) {
            return baselineCostEur;
        }
        double netz = restKwh + schritt.chargeKwh() - schritt.dischargeKwh();
        return baselineCostEur * netz / restKwh;
    }

    private static StandardSpeicher.Batterie batterie(Vergleich vergleich, Instant t) {
        Map.Entry<Instant, StandardSpeicher.Batterie> e = vergleich.batterien().floorEntry(t);
        return e != null ? e.getValue() : vergleich.batterien().firstEntry().getValue();
    }
}
