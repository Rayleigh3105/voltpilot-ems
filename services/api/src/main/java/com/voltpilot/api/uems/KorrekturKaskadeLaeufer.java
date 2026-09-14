package com.voltpilot.api.uems;

import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Der TAKT der Korrektur-Kaskade (UEMS AP-08 IP-17): alle fünf Minuten {@link KorrekturKaskade#lauf}.
 *
 * <p>Fünf Minuten, weil hinter jeder Freigabe ein Mensch steht, der seine Zahl bis zum Jahr sehen will — und weil der
 * Ersatzwert-Lauf im selben Takt die Viertelstunden bildet, denen die Kaskade folgt. Ob der Takt pünktlich war, ändert
 * keine Zahl: jede Stufe ist eine Funktion ihrer Teile, nicht der Uhr. Es gibt KEINE zweite Bestätigung: die Freigabe
 * war die Entscheidung, der Rest ist Rechnen (E9 neben E14).
 *
 * <p><b>⚠ Wie jeder {@code @Scheduled} ist er im TESTLAUF AUS</b> (surefire-Systemeigenschaft) und in PRODUKTION AN
 * ({@code application.yml}, {@code matchIfMissing}) — derselbe Block {@code voltpilot.uems.*};
 * {@code KorrekturKaskadeWiringTest} prüft die ausgelieferte Vorgabe. Er wirft nie: ein Fehlschlag wird protokolliert
 * und beim nächsten Takt erneut versucht — die Transaktion des Anlasses rollt ganz zurück.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.uems.kaskade.enabled", havingValue = "true", matchIfMissing = true)
public class KorrekturKaskadeLaeufer {

    private static final Logger log = LoggerFactory.getLogger(KorrekturKaskadeLaeufer.class);

    private final KorrekturKaskade kaskade;

    public KorrekturKaskadeLaeufer(KorrekturKaskade kaskade) {
        this.kaskade = kaskade;
    }

    @Scheduled(fixedDelayString = "${voltpilot.uems.kaskade.interval-ms:300000}",
            initialDelayString = "${voltpilot.uems.kaskade.initial-delay-ms:180000}")
    public void takt() {
        try {
            kaskade.lauf(Instant.now());
        } catch (RuntimeException e) {
            log.warn("UEMS Korrektur-Kaskade übersprungen: {}", e.toString());
        }
    }
}
