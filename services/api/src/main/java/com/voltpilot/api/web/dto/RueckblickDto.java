package com.voltpilot.api.web.dto;

import java.time.LocalDate;
import java.util.List;

/**
 * Das Blatt "Rückblick" (S3, Konzept vp-prognosen-konzept, E5 = A): je Art
 * (Sonne, Verbrauch) die letzten Tage "am Vortag erwartet" neben "gemessen",
 * dazu der Rückblick-Satz ("An 8 von 10 Tagen höchstens X kWh daneben" - das
 * 0,8-Quantil des Betrags der Abweichung über die letzten
 * {@value #FENSTER_TAGE} Tage).
 *
 * <p>Immer das AKTIVE Modell der jeweiligen Art - derselbe Grundsatz wie die
 * Antwort auf der Prognose-Seite selbst ({@code ForecastDto}): EINE Prognose,
 * ein Ort. {@code tage}/{@code abweichungKwh} fehlen (leer bzw. {@code null}),
 * solange es noch keine oder zu wenige Tagesbewertungen gibt - "Fehlend ist
 * keine Null".
 */
public record RueckblickDto(List<KindRueckblickDto> kinds) {

    /** Das Vergleichsfenster des Rückblick-Satzes (Tage). */
    public static final int FENSTER_TAGE = 28;

    public record KindRueckblickDto(
            /** 'pv' | 'load'. */
            String kind,
            /** Das aktive Modell dieser Art - dessen Rückblick hier steht. */
            String model,
            /** Bis zu sieben Tage, älteste zuerst. */
            List<TagDto> tage,
            /** Das 0,8-Quantil der Tagesabweichung (kWh); {@code null} unter {@value #MIN_TAGE}. */
            Double abweichungKwh,
            /** Wie viele Tage im {@value #FENSTER_TAGE}-Tage-Fenster bewertet sind. */
            int bewerteteTage) {

        /** Unter dieser Zahl bewerteter Tage zeigt die Seite keinen Rückblick-Satz. */
        public static final int MIN_TAGE = 10;
    }

    public record TagDto(LocalDate day, double erwartetKwh, double gemessenKwh) {
    }
}
