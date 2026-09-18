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
 * Der TAKT des Lücken-Melders (UEMS AP-07 IP-9): alle fünf Minuten {@link LueckenMelder#lauf}.
 *
 * <p><b>Fünf Minuten, weil die Herzschlag-Toleranz fünf Minuten ist</b> (AP-06: letzter Herzschlag
 * 14:00, erkannt 14:05): ein langsamerer Takt ließe eine schweigende Box länger unbemerkt, ein
 * schnellerer fände nichts früher — die Einheiten tragen ihren Fälligkeitszeitpunkt selbst, und der
 * Takt ist nur, wie oft nachgesehen wird. Ob er pünktlich war, ändert nie ein {@code von}: das kommt
 * aus den Daten, nicht aus der Uhr des Laufs.
 *
 * <p><b>⚠ Wie jeder {@code @Scheduled} ist er im TESTLAUF AUS</b> (surefire-Systemeigenschaft) und
 * in PRODUKTION AN ({@code application.yml}, {@code matchIfMissing}) — dieselbe Form und derselbe
 * Konfigurationsblock {@code voltpilot.uems.*} wie Verdichtung und Endgültigkeit. Wer ihn prüft,
 * ruft {@code LueckenMelder.lauf(...)} selbst; dass die AUSGELIEFERTE Vorgabe AN ist, prüft
 * {@code LueckenWiringTest} an der echten {@code application.yml}.
 *
 * <p>Er wirft nie: ein Fehlschlag wird protokolliert und beim nächsten Takt erneut versucht — der
 * Stand rollt mit seiner Transaktion zurück, und jede Meldung ist wiederholbar.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.uems.luecken.enabled", havingValue = "true", matchIfMissing = true)
public class LueckenLaeufer {

    private static final Logger log = LoggerFactory.getLogger(LueckenLaeufer.class);

    private final LueckenMelder melder;

    /**
     * AP-14 IP-9: der Betriebs-Melder (§3.5, Schicht „Läufer“). Nachgereicht statt in den Konstruktor
     * gelegt, damit kein bestehender Aufrufer sich ändert; {@link UemsLaeuferMelder#STUMM} hält ihn
     * ohne Spring UND in den Minimal-Kontexten der Wiring-Tests gültig (darum
     * {@code required = false}). Melden darf einen Lauf NIE brechen — der Melder schluckt alles.
     */
    private UemsLaeuferMelder betrieb = UemsLaeuferMelder.STUMM;

    @Autowired(required = false)
    void betriebsMelder(UemsLaeuferMelder betrieb) {
        this.betrieb = betrieb;
    }

    public LueckenLaeufer(LueckenMelder melder) {
        this.melder = melder;
    }

    @Scheduled(fixedDelayString = "${voltpilot.uems.luecken.interval-ms:300000}",
            initialDelayString = "${voltpilot.uems.luecken.initial-delay-ms:90000}")
    public void takt() {
        try {
            melder.lauf(Instant.now());
            betrieb.gelaufen(UemsLaeuferMelder.LUECKEN);
        } catch (RuntimeException e) {
            betrieb.fehler(UemsLaeuferMelder.LUECKEN);
            log.warn("UEMS Lücken-Melder übersprungen: {}", e.toString());
        }
    }
}
