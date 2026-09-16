package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Locale;

/** AP-09 Z6/E5: die Auswahl eines Monats verteilt keinen gemessenen Betrag. */
public final class AblesungRegeln {
    private AblesungRegeln() {}

    public record Zeitraum(BigDecimal menge, String zustand, String kennzeichen,
            BezugsdatenRegeln.Zuordnung zuordnung) {}

    public static Zeitraum zeitraum(Instant von, BigDecimal anfang, Instant bis, BigDecimal ende,
            String einheit, ZoneId zone) {
        VerbrauchRegeln.Ergebnis wert = VerbrauchRegeln.ergebnis(new ReihenKontext(einheit, zone),
                "zaehlerstand", List.of(new VerbrauchRegeln.Rohwert(von, anfang),
                        new VerbrauchRegeln.Rohwert(bis, ende)), von, bis, Duration.between(von, bis),
                List.of(), BigDecimal.ONE, null, null, false);
        DateTimeFormatter datum = DateTimeFormatter.ofPattern("dd.MM. HH:mm", Locale.GERMANY).withZone(zone);
        return new Zeitraum(wert.menge(), wert.zustand(), "Ablesezeitraum " + datum.format(von) + " – "
                + datum.format(bis) + " (Zuordnung durch den Kunden)", BezugsdatenRegeln.zuordnung(von, bis, zone));
    }

    /** Monatlich ist eine Kalenderkadenz, keine feste Zahl von Sekunden (Z7). */
    public static Instant ueberfaelligAb(Instant letzte, ZoneId zone) {
        return letzte.atZone(zone).plusMonths(2).toInstant();
    }

    public static LocalDate monat(String text) {
        if (text == null) return null;
        if (!text.matches("[0-9]{4}-[0-9]{2}")) throw new IllegalArgumentException("monat_ungueltig");
        return YearMonth.parse(text).atDay(1);
    }
}
