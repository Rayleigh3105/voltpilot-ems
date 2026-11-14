package com.voltpilot.api.anlagencheck;

import java.time.LocalDate;
import java.util.List;

/**
 * Antwort von {@code GET /api/v1/sites/{id}/speicher-bilanz}: die Karte „Speicher-Bilanz · 30 Tage" auf der
 * Geräteseite des Speichers (Bedienkonzept §6.5, BK-7 = A). Zahlen ungerundet, Wirkungsgrad als Anteil (0..1).
 *
 * @param zustand {@code normal}, {@code wenig} (unter 5 Vollzyklen), {@code ohne_daten}
 * @param satz {@code unauffaellig}, {@code niedriger} oder {@code null} (kein Vergleich möglich)
 * @param monate die letzten 12 vollen Monate („12 Monate ›"), älteste zuerst
 */
public record SpeicherBilanzDto(String zustand, LocalDate von, LocalDate bis, int fensterTage, int tageMitDaten,
        Double hineinKwh, Double herausKwh, Double ausgleichKwh, Double wirkungsgrad, Double verlustKwh,
        Double vollzyklen, Double vollzyklenSeitBeginn, Double kapazitaetKwh, Double vergleichMin, Double vergleichMax,
        int vergleichMonate, String satz, List<MonatDto> monate) {

    /** Ein voller Monat; {@code wirkungsgrad == null}, wenn er zu wenig geladen oder lückenhaft war. */
    public record MonatDto(String monat, double hineinKwh, double herausKwh, Double wirkungsgrad, Double vollzyklen) {}
}
