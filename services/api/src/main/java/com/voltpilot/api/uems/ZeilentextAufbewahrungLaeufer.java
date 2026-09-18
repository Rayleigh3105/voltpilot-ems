package com.voltpilot.api.uems;

import com.voltpilot.api.metrics.UemsLaeuferMelder;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Der TAKT der Zeilentext-Aufbewahrung (UEMS AP-09 IP-12, E14): einmal täglich {@link ZeilentextAufbewahrung#lauf}.
 *
 * <p>Täglich genügt: die Frist sind zwei Jahre, ein Tag mehr ist keine andere Aussage. <b>⚠ Wie jeder
 * {@code @Scheduled} ist er im TESTLAUF AUS</b> (surefire-Systemeigenschaft) und in PRODUKTION AN
 * ({@code application.yml}, {@code matchIfMissing}); {@code ZeilentextAufbewahrungWiringTest} prüft die
 * ausgelieferte Vorgabe. Er wirft nie: ein Fehlschlag wird protokolliert und am nächsten Tag erneut versucht.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.uems.zeilentexte.enabled", havingValue = "true", matchIfMissing = true)
public class ZeilentextAufbewahrungLaeufer {

    private static final Logger log = LoggerFactory.getLogger(ZeilentextAufbewahrungLaeufer.class);

    private final ZeilentextAufbewahrung aufbewahrung;

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

    public ZeilentextAufbewahrungLaeufer(ZeilentextAufbewahrung aufbewahrung) {
        this.aufbewahrung = aufbewahrung;
    }

    @Scheduled(cron = "${voltpilot.uems.zeilentexte.cron:0 17 3 * * *}", zone = "Europe/Berlin")
    public void takt() {
        try {
            int entfernt = aufbewahrung.lauf();
            melder.gelaufen(UemsLaeuferMelder.ZEILENTEXTE);
            if (entfernt > 0) {
                log.info("UEMS Zeilentexte nach zwei Jahren entfernt: {}", entfernt);
            }
        } catch (RuntimeException e) {
            melder.fehler(UemsLaeuferMelder.ZEILENTEXTE);
            log.warn("UEMS Zeilentext-Aufbewahrung übersprungen: {}", e.toString());
        }
    }
}
