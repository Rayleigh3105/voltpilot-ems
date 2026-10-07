package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;

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
        return new Zeitraum(wert.menge(), wert.zustand(), ErgebnisZustand.ablesezeitraum(von, bis, zone),
                BezugsdatenRegeln.zuordnung(von, bis, zone));
    }

    /** Die Summe der Ablesezeiträume eines Monats oder Jahres: Menge, Zustand und Kennzeichen, wie sie gespeichert werden. */
    public record Summe(BigDecimal menge, String zustand, List<String> kennzeichen) {}

    /** Ein Jahr hat zwölf Monatsmengen; jede fehlende nennt das Kennzeichen I2 (ergebnis-zustand 1.13). */
    public static final int MONATE_JE_JAHR = 12;

    /**
     * Das Jahr aus den Monaten mit Zahl (Z6, ergebnis-zustand 1.13): die Menge ist ihre Summe, die Kennzeichen sind
     * ihre Ablesezeiträume in zeitlicher Folge. Fehlt ein Monat, ist das Jahr unvollständig und sagt es zuerst
     * („3 von 12 Intervallmengen fehlen — …“, Rang 50 vor der Herkunft) - ohne diesen Satz verletzt es den Vertrag
     * ({@code unvollstaendig_ohne_grund}) und keine Fläche spricht es. Ohne einen Monat mit Zahl: keine Werte.
     *
     * @param monate die Monate des Jahres, die eine Zahl tragen, in zeitlicher Folge
     */
    public static Summe jahr(List<Summe> monate) {
        if (monate.isEmpty()) return new Summe(null, ErgebnisZustand.KEINE_WERTE, List.of());
        BigDecimal menge = BigDecimal.ZERO;
        List<String> kennzeichen = new ArrayList<>();
        for (Summe m : monate) {
            if (m.menge() == null) throw new IllegalArgumentException("ein Monat ohne Zahl zählt nicht zum Jahr");
            menge = menge.add(m.menge());
            kennzeichen.addAll(m.kennzeichen());
        }
        int fehlend = MONATE_JE_JAHR - monate.size();
        if (fehlend < 0) throw new IllegalArgumentException("ein Jahr hat höchstens zwölf Monate");
        if (fehlend == 0) return new Summe(menge, ErgebnisZustand.VOLLSTAENDIG, List.copyOf(kennzeichen));
        kennzeichen.add(0, ErgebnisZustand.intervallmengenFehlen(fehlend, MONATE_JE_JAHR));
        return new Summe(menge, ErgebnisZustand.UNVOLLSTAENDIG, List.copyOf(kennzeichen));
    }

    /** Nach so vielen Kalendermonaten ohne neue Ablesung fehlt sie (Z7); die Wiedervorlage nennt die Zahl im Grund. */
    public static final int UEBERFAELLIG_NACH_MONATEN = 2;

    /** Monatlich ist eine Kalenderkadenz, keine feste Zahl von Sekunden (Z7). */
    public static Instant ueberfaelligAb(Instant letzte, ZoneId zone) {
        return letzte.atZone(zone).plusMonths(UEBERFAELLIG_NACH_MONATEN).toInstant();
    }

    public static LocalDate monat(String text) {
        if (text == null) return null;
        if (!text.matches("[0-9]{4}-[0-9]{2}")) throw new IllegalArgumentException("monat_ungueltig");
        return YearMonth.parse(text).atDay(1);
    }
}
