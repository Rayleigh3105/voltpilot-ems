package com.voltpilot.api.uems;

import com.voltpilot.api.metrics.UemsLaeuferMelder;
import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
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

    /**
     * AP-14 IP-9: der Betriebs-Melder (§3.5, Schicht „Läufer“). Nachgereicht statt in den Konstruktor
     * gelegt, damit kein bestehender Aufrufer sich ändert; {@link UemsLaeuferMelder#STUMM} hält ihn
     * ohne Spring UND in den Minimal-Kontexten der Wiring-Tests gültig (darum
     * {@code required = false}). Melden darf einen Lauf NIE brechen — der Melder schluckt alles.
     */
    private UemsLaeuferMelder melder = UemsLaeuferMelder.STUMM;

    @Autowired(required = false)
    void melder(UemsLaeuferMelder melder) {
        this.melder = melder;
    }

    public ViertelstundeLaeufer(ViertelstundeVerdichter verdichter) {
        this.verdichter = verdichter;
    }

    @Scheduled(fixedDelayString = "${voltpilot.uems.viertelstunde.interval-ms:300000}",
            initialDelayString = "${voltpilot.uems.viertelstunde.initial-delay-ms:60000}")
    public void takt() {
        try {
            verdichter.lauf(Instant.now());
            melder.gelaufen(UemsLaeuferMelder.VIERTELSTUNDE);
        } catch (RuntimeException e) {
            melder.fehler(UemsLaeuferMelder.VIERTELSTUNDE);
            log.warn("UEMS Viertelstunden-Verdichtung übersprungen: {}", e.toString());
        }
    }
}
