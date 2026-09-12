package com.voltpilot.api.uems;

import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Der TAKT der Speicherklasse Viertelstundenwerte (UEMS AP-07 IP-12): alle fünf Minuten einmal
 * {@link ViertelstundeVerdichter#lauf(Instant)}.
 *
 * <p>Fünf Minuten, weil §4.3 es so nennt und weil es der Takt ist, in dem schon die Bestands-
 * Rollups laufen (V20260848000000). Ein vorläufiger Wert ist damit spätestens fünf Minuten nach
 * dem Rohwert da; eine Nachlieferung bringt ihr Intervall im nächsten Takt auf den neuen Stand,
 * ganz gleich wie alt es ist — der Lauf sucht über die EINGANGSZEIT, nicht über ein Fenster.
 *
 * <p><b>⚠ Wie jeder {@code @Scheduled} ist er im TESTLAUF AUS</b> (surefire-Systemeigenschaft) und
 * in PRODUKTION AN ({@code application.yml}, {@code matchIfMissing}) — die dokumentierte Falle mit
 * den zwischengespeicherten Testkontexten und den gestoppten Testcontainern. Wer ihn prüft, ruft
 * {@code ViertelstundeVerdichter.lauf(...)} selbst. Dass die AUSGELIEFERTE Vorgabe AN ist, prüft
 * {@code ViertelstundeWiringTest} an der echten {@code application.yml}.
 *
 * <p>Er wirft nie: ein Fehlschlag wird protokolliert und beim nächsten Takt erneut versucht — die
 * Arbeitsliste hat den Eintrag noch, weil Entnahme und Schreiben in einer Transaktion liegen.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.uems.viertelstunde.enabled",
        havingValue = "true", matchIfMissing = true)
public class ViertelstundeLaeufer {

    private static final Logger log = LoggerFactory.getLogger(ViertelstundeLaeufer.class);

    private final ViertelstundeVerdichter verdichter;

    public ViertelstundeLaeufer(ViertelstundeVerdichter verdichter) {
        this.verdichter = verdichter;
    }

    @Scheduled(fixedDelayString = "${voltpilot.uems.viertelstunde.interval-ms:300000}",
            initialDelayString = "${voltpilot.uems.viertelstunde.initial-delay-ms:60000}")
    public void takt() {
        try {
            verdichter.lauf(Instant.now());
        } catch (RuntimeException e) {
            log.warn("UEMS Viertelstunden-Verdichtung übersprungen: {}", e.toString());
        }
    }
}
