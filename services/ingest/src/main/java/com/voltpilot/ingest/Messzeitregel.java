package com.voltpilot.ingest;

import java.time.Instant;
import java.util.Optional;

/**
 * Die Messzeit-Plausibilität der Datenannahme (UEMS AP-07 E13, Captain-Entscheid 10.09.2026):
 * liegt eine Messzeit mehr als {@code zukunftHoechstensS} NACH der Eingangszeit (Uhr der Cloud),
 * geht die Uhr der Box vor → {@code clock_ahead}; liegt sie mehr als
 * {@code vergangenheitHoechstensS} davor → {@code too_old}. Genau auf der Grenze wird angenommen.
 * Gerechnet in ganzen Sekunden wie Schritt 1 „Zeit“ des Herkunftsvertrags
 * ({@code services/api .../uems/MesswertHerkunft}).
 *
 * <p>Die Grenzen stehen EINMAL als benannte Konfiguration in {@code application.yml}
 * ({@code voltpilot.datenannahme}); {@link #E13} sind dieselben Zahlen für Tests.
 * {@code MesszeitregelTest} hält beide an {@code events-vocabulary-vectors.json}
 * ({@code regeln}) und rechnet die Zeit-Fälle von {@code messwert-herkunft-vectors.json} nach.
 */
public record Messzeitregel(long zukunftHoechstensS, long vergangenheitHoechstensS) {

    /** E13: 5 Minuten Zukunft, 90 × 24 h Vergangenheit. */
    public static final Messzeitregel E13 = new Messzeitregel(300L, 90L * 86_400L);

    /** Warum eine Messzeit nicht angenommen wird, und um wie viele Sekunden. */
    public record Abweichung(Ereignisart art, long sekunden) {}

    /** Leer = plausibel; sonst {@code clock_ahead} mit {@code vor_s} bzw. {@code too_old} mit {@code alter_s}. */
    public Optional<Abweichung> pruefe(Instant messzeit, Instant eingang) {
        long vorS = messzeit.getEpochSecond() - eingang.getEpochSecond();
        if (vorS > zukunftHoechstensS) {
            return Optional.of(new Abweichung(Ereignisart.CLOCK_AHEAD, vorS));
        }
        if (-vorS > vergangenheitHoechstensS) {
            return Optional.of(new Abweichung(Ereignisart.TOO_OLD, -vorS));
        }
        return Optional.empty();
    }
}
