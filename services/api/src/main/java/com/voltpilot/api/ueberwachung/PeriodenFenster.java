package com.voltpilot.api.ueberwachung;

import com.voltpilot.api.history.HistoryRange;
import java.time.Instant;
import java.time.LocalDate;

/**
 * Die Periodenfenster der {@code menge}/{@code geld}-Leser (Alerting Scheibe 4, Konzept §6.3/§6.4):
 * "Tag, Woche, Monat, Abrechnungszeitraum" - dieselben Europe/Berlin-Kalendergrenzen wie die Fläche
 * ({@link HistoryRange}, Hausregel "Optimierung und Erlösanzeige nutzen dieselben Tarif-/
 * Vergütungsgrundlagen - die Überwachung auch"). "Abrechnungszeitraum" ist der Monat oder das Jahr,
 * je nach {@code site.abrechnung_leistung} (wie {@code PeakShavingRepository}) - KEINE eigene
 * Kalenderform.
 */
final class PeriodenFenster {

    /** Ein halboffenes Fenster {@code [von, bis)} - {@code bis} kann in der Zukunft liegen (die
     * laufende, noch nicht abgeschlossene Periode). */
    record Fenster(Instant von, Instant bis) {
        boolean abgeschlossen(Instant jetzt) {
            return !jetzt.isBefore(bis);
        }
    }

    private PeriodenFenster() {
    }

    /** Die Periode, in der {@code jetzt} liegt. {@code abrechnungLeistung} ist {@code "monat"} oder
     * {@code "jahr"} (nur für {@code periode = "abrechnungszeitraum"} gebraucht, sonst ignoriert). */
    static Fenster aktuelle(String periode, Instant jetzt, String abrechnungLeistung) {
        LocalDate heute = jetzt.atZone(HistoryRange.ZONE).toLocalDate();
        return switch (periode) {
            case "tag" -> fenster(HistoryRange.DAY.window(heute));
            case "woche" -> fenster(HistoryRange.WEEK.window(heute));
            case "monat" -> fenster(HistoryRange.MONTH.window(heute));
            case "abrechnungszeitraum" ->
                fenster("monat".equals(abrechnungLeistung) ? HistoryRange.MONTH.window(heute)
                        : HistoryRange.YEAR.window(heute));
            default -> throw new IllegalArgumentException("PeriodenFenster: unbekannte Periode '" + periode + "'");
        };
    }

    /** Die VORIGE, vollständig abgeschlossene Periode derselben Art - für {@code aenderung} (§6.4). */
    static Fenster vorige(String periode, Instant jetzt, String abrechnungLeistung) {
        Fenster jetzige = aktuelle(periode, jetzt, abrechnungLeistung);
        LocalDate vorherigerTag = jetzige.von().atZone(HistoryRange.ZONE).toLocalDate().minusDays(1);
        return aktuelle(periode, vorherigerTag.atStartOfDay(HistoryRange.ZONE).toInstant(), abrechnungLeistung);
    }

    private static Fenster fenster(HistoryRange.Window w) {
        return new Fenster(w.from(), w.to());
    }
}
