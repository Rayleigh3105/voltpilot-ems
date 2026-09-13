package com.voltpilot.api.uems;

import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Der TAKT des Ersatzwert-Laufs (UEMS AP-08 IP-13): alle fünf Minuten {@link ErsatzwertLauf#lauf}.
 *
 * <p>Fünf Minuten, weil ein Ersatzwert ein Mensch mit Begründung ist, der auf seine Version wartet: schneller
 * fände nichts früher, langsamer ließe ihn im Verlauf zu lange ohne Zahl. Ob der Takt pünktlich war, ändert
 * keine Zahl — die Version ist eine Funktion von Bestand und geltenden Ersatzwerten, nicht der Uhr.
 *
 * <p><b>⚠ Wie jeder {@code @Scheduled} ist er im TESTLAUF AUS</b> (surefire-Systemeigenschaft) und in
 * PRODUKTION AN ({@code application.yml}, {@code matchIfMissing}) — derselbe Konfigurationsblock
 * {@code voltpilot.uems.*} wie Verdichtung, Endgültigkeit und Lücken-Melder; {@code ErsatzwertWiringTest}
 * prüft die ausgelieferte Vorgabe. Er wirft nie: ein Fehlschlag wird protokolliert und beim nächsten Takt
 * erneut versucht — die Transaktion des Ersatzwerts rollt zurück.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.uems.ersatzwert.enabled", havingValue = "true", matchIfMissing = true)
public class ErsatzwertLaeufer {

    private static final Logger log = LoggerFactory.getLogger(ErsatzwertLaeufer.class);

    private final ErsatzwertLauf lauf;

    public ErsatzwertLaeufer(ErsatzwertLauf lauf) {
        this.lauf = lauf;
    }

    @Scheduled(fixedDelayString = "${voltpilot.uems.ersatzwert.interval-ms:300000}",
            initialDelayString = "${voltpilot.uems.ersatzwert.initial-delay-ms:120000}")
    public void takt() {
        try {
            lauf.lauf(Instant.now());
        } catch (RuntimeException e) {
            log.warn("UEMS Ersatzwert-Lauf übersprungen: {}", e.toString());
        }
    }
}
