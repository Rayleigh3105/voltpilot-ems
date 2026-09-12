package com.voltpilot.writer;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;

/**
 * Z6 (UEMS AP-08 E4) im Writer — der Zwilling von {@code VerbrauchRegeln.ueberlauf} (services/api)
 * und {@code verbrauch.ueberlauf} (Python-Referenz). Der Writer hängt nicht an der api; deshalb
 * steht die EINE Entscheidung hier ein zweites Mal und wird wie diese gegen dieselbe Datei
 * {@code docs/contracts/v2/verbrauch-vectors.json} geprüft ({@code UeberlaufRegelZwillingTest}).
 *
 * <p>Ein Überlauf ist es nur, wenn der Stand FÄLLT, der Wertebereich (Modul) UND der Höchstzuwachs
 * je Kadenz deklariert sind und {@code Modul − alt + neu ≤ Höchstzuwachs × (Zeitabstand ÷ Kadenz)}
 * gilt. Fehlt eine Angabe, wird nichts geraten: die Antwort ist {@code null}.
 */
final class UeberlaufRegel {

    /** Dieselbe Rechengenauigkeit wie die api und der Python-Zwilling (28 Stellen, half-even). */
    private static final MathContext RECHNUNG = new MathContext(28, RoundingMode.HALF_EVEN);

    private UeberlaufRegel() {}

    /** Der Zuwachs über den Überlauf (in Rohwert-Einheit), sonst {@code null}. */
    static BigDecimal ueberlauf(BigDecimal alt, Instant zeitAlt, BigDecimal neu, Instant zeitNeu,
            Duration kadenz, BigDecimal wertebereichModul, BigDecimal hoechstzuwachsJeKadenz) {
        if (wertebereichModul == null || hoechstzuwachsJeKadenz == null || neu.compareTo(alt) >= 0) {
            return null;
        }
        BigDecimal ueber = wertebereichModul.subtract(alt).add(neu);
        BigDecimal kadenzen = BigDecimal.valueOf(Duration.between(zeitAlt, zeitNeu).toNanos())
                .divide(BigDecimal.valueOf(kadenz.toNanos()), RECHNUNG);
        return ueber.compareTo(hoechstzuwachsJeKadenz.multiply(kadenzen)) <= 0 ? ueber : null;
    }
}
