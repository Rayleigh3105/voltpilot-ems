package com.voltpilot.api.optimizer;

import com.voltpilot.api.repo.EinspeiseverguetungRepository.Grundlage;
import com.voltpilot.api.web.dto.EinspeiseverguetungDto;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;

/**
 * Der Stand der Karte "Einspeisevergütung": aus der {@link Grundlage} einer
 * Anlage, was heute wirkt und woher es kommt. Rein, ohne Datenbank - die eine
 * Frage, ob die Einspeisung FEST bewertet ist und womit, beantwortet die
 * SQL-Wahrheit der Erlöse ({@code Grundlage.quelle} =
 * {@link SlotEconomics#exportVerguetungQuelleSql}); hier wird sie nur benannt
 * und um die Zahlen ergänzt, die die Karte zeigt. So kann die Karte nie einen
 * Satz behaupten, mit dem die Erlöse nicht rechnen.
 *
 * <p>Der hergeleitete Satz kommt aus demselben {@link EegRates}-Satzplan wie
 * Optimierer und Erlöse (inkl. {@code OPTIMIZER_EEG_RATES_JSON}); die Angabe
 * des Kunden ist eine Ebene darüber und ändert den Satzplan nicht.
 */
public final class EinspeiseverguetungStand {

    /**
     * Ab dieser Inbetriebnahme rechnet der Satzplan exakt (die Bänder des EEG
     * 2023, {@link EegRates} / config.py "EEG 2023 (exact)"); davor stehen
     * Jahresstufen und vor 2012 das erste Band - ein Näherungswert, den die
     * Karte so nennt und für den sie die genaue Angabe anbietet.
     */
    static final LocalDate GENAUER_SATZPLAN_AB = LocalDate.of(2022, 7, 30);

    /** ct/kWh mit einer Stelle mehr, als das Portal zeigt (SchedulePricingService). */
    private static final int CT_SCALE = 3;

    private EinspeiseverguetungStand() {
    }

    /** Der Stand der Karte aus der Grundlage einer Anlage. */
    public static EinspeiseverguetungDto von(Grundlage g, EegRates rates) {
        LocalDate inbetrieb = g.inbetriebnahme();
        Double kwp = g.leistungKwp() == null ? null : g.leistungKwp().doubleValue();
        BigDecimal hergeleitet = inbetrieb == null ? null
                : ct(rates.festeVerguetungCtPerKwh(inbetrieb, kwp));
        String zustand = zustand(g);
        BigDecimal wirksam = switch (zustand) {
            case "angegeben" -> g.angegebenCtKwh();
            case "eeg" -> hergeleitet;
            default -> null;
        };
        boolean direktvermarktung = "direktvermarktung".equals(g.plantKind());
        return new EinspeiseverguetungDto(
                zustand,
                wirksam,
                g.angegebenCtKwh(),
                // Die Antwort zählt nur ohne Datum - mit Datum wird sie nicht gezeigt.
                inbetrieb == null ? g.inbetriebnahmeAbSolarspitzengesetz() : null,
                hergeleitet,
                inbetrieb != null && inbetrieb.isBefore(GENAUER_SATZPLAN_AB),
                inbetrieb,
                g.leistungKwp(),
                inbetrieb == null ? null : LocalDate.of(inbetrieb.getYear() + 20, 12, 31),
                SlotEconomics.solarspitzengesetzGilt(inbetrieb, g.inbetriebnahmeAbSolarspitzengesetz()),
                direktvermarktung ? g.anzulegenderWertCtKwh() : null);
    }

    /**
     * Das geschlossene Vokabular von {@link EinspeiseverguetungDto#zustand()}.
     * Die feste Bewertung ({@code angegeben}/{@code eeg}) nennt allein die
     * SQL-Herkunft; die übrigen Zustände sagen nur, WARUM sie fehlt: zuerst die
     * Veräußerungsform (bei Direktvermarktung gibt es keinen festen Satz, mit
     * oder ohne Netzladen), dann Netzladen (Ausschließlichkeitsprinzip), dann
     * die fehlende Grundlage.
     */
    static String zustand(Grundlage g) {
        if ("direktvermarktung".equals(g.plantKind())) {
            return "direktvermarktung";
        }
        if (g.netzladenErlaubt()) {
            return "netzladen";
        }
        if (g.quelle() != null) {
            return g.quelle();
        }
        return g.inbetriebnahme() != null ? "eeg_abgelaufen" : "ohne_angabe";
    }

    private static BigDecimal ct(double value) {
        return BigDecimal.valueOf(value).setScale(CT_SCALE, RoundingMode.HALF_UP);
    }
}
