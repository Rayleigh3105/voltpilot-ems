package com.voltpilot.api.uems;

import com.voltpilot.api.metrics.UemsLaeuferMelder;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Der TAKT der Frist für {@code plan_zustellung} (AP-15 IP-11): einmal täglich
 * {@link PlanZustellungAufbewahrung#lauf}. <b>⚠ Wie jeder {@code @Scheduled} ist er im TESTLAUF AUS</b>
 * (surefire-Systemeigenschaft) und in PRODUKTION AN ({@code application.yml}, {@code matchIfMissing});
 * {@code PlanZustellungAufbewahrungWiringTest} prüft die ausgelieferte Vorgabe. Er wirft nie: ein
 * Fehlschlag wird protokolliert und am nächsten Tag erneut versucht.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.uems.plan-zustellung.enabled", havingValue = "true", matchIfMissing = true)
public class PlanZustellungAufbewahrungLaeufer {

    private static final Logger log = LoggerFactory.getLogger(PlanZustellungAufbewahrungLaeufer.class);

    private final PlanZustellungAufbewahrung aufbewahrung;

    /** Der Betriebs-Melder, nachgereicht wie bei {@link ZeilentextAufbewahrungLaeufer}. */
    private UemsLaeuferMelder melder = UemsLaeuferMelder.STUMM;

    @Autowired(required = false)
    void melder(UemsLaeuferMelder melder) {
        this.melder = melder;
    }

    public PlanZustellungAufbewahrungLaeufer(PlanZustellungAufbewahrung aufbewahrung) {
        this.aufbewahrung = aufbewahrung;
    }

    @Scheduled(cron = "${voltpilot.uems.plan-zustellung.cron:0 47 3 * * *}", zone = "Europe/Berlin")
    public void takt() {
        try {
            int entfernt = aufbewahrung.lauf();
            melder.gelaufen(UemsLaeuferMelder.PLAN_ZUSTELLUNG);
            if (entfernt > 0) {
                log.info("Plan-Zustellungen jenseits der Frist entfernt: {}", entfernt);
            }
        } catch (RuntimeException e) {
            melder.fehler(UemsLaeuferMelder.PLAN_ZUSTELLUNG);
            log.warn("Frist der Plan-Zustellungen übersprungen: {}", e.toString());
        }
    }
}
