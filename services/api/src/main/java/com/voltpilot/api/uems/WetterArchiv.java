package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Map;

/**
 * Ein Wetter-Archiv (UEMS AP-17 E9 = C, IP-12b): Tagesmittel der Außentemperatur je Koordinate und Datumsbereich,
 * nur ARCHIV-Tage — nie eine Vorhersage (AP-09 E13). Die Quelle ist Konfiguration des Betreibers
 * ({@code voltpilot.uems.wetter-archiv.quelle}); heute gibt es das Open-Meteo-Archiv, die DWD-Schnittstelle wäre eine
 * zweite Umsetzung hinter derselben Schnittstelle.
 *
 * <p><b>Ein Abruf wirft nie.</b> Scheitert die Quelle, ist das ein {@link Abruf#ausfall Ausfall}: der Tag fehlt, der
 * nächste Abruf holt nach (LA3). Ein Tag, den die Quelle ohne Wert liefert, fehlt ebenso — nie 0.
 */
public interface WetterArchiv {

    /**
     * @param quelle     der Name der Quelle im Kennzeichen („Open-Meteo-Archiv“)
     * @param abgerufen  wann VoltPilot abgerufen hat — die Abrufzeit im Kennzeichen
     * @param tagesmittel je Kalendertag der Zone das Tagesmittel in °C; fehlende Tage fehlen
     * @param ausfall    {@code null} = die Quelle hat geantwortet, sonst der Grund
     */
    record Abruf(String quelle, Instant abgerufen, Map<LocalDate, BigDecimal> tagesmittel, String ausfall) {}

    /** Tagesmittel für {@code von} … {@code bis} (beide einschließlich) in der Zone des Standorts. */
    Abruf tagesmittel(BigDecimal breitengrad, BigDecimal laengengrad, LocalDate von, LocalDate bis, ZoneId zone);
}
