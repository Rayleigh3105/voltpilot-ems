package com.voltpilot.api.uems;

import com.voltpilot.api.metrics.UemsLaeuferMelder;
import com.voltpilot.api.tenant.TenantContext;
import java.time.Clock;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Der TAKT der Verbund-Bilanz (AP-15 IP-12): einmal täglich rechnet {@link VerbundBilanzService#rechnen} den Vortag
 * (Europe/Berlin) jeder Anlage MIT Gemeinsamer Steuerung — nur dort; ein Kundenbereich ohne Verbund wird nicht einmal
 * betreten. Ein Tag wird genau einmal gerechnet; ein zweiter Takt am selben Tag schreibt nichts.
 *
 * <p><b>⚠ Wie jeder {@code @Scheduled} ist er im TESTLAUF AUS</b> (surefire-Systemeigenschaft) und in PRODUKTION AN
 * ({@code application.yml}, {@code matchIfMissing}); wer ihn prüft, ruft {@link #lauf(LocalDate)} selbst. Er wirft
 * nie: ein Fehlschlag je Anlage wird protokolliert, die übrigen laufen weiter.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.uems.verbund-bilanz.enabled", havingValue = "true", matchIfMissing = true)
public class VerbundBilanzLaeufer {

    private static final Logger log = LoggerFactory.getLogger(VerbundBilanzLaeufer.class);

    private final JdbcTemplate adminJdbc;
    private final VerbundBilanzService bilanz;
    private Clock uhr = Clock.systemUTC();

    /** Der Betriebs-Melder (Läufer {@code verbund_bilanz}), nachgereicht wie bei {@code ZeilentextAufbewahrungLaeufer}. */
    private UemsLaeuferMelder melder = UemsLaeuferMelder.STUMM;

    @Autowired(required = false)
    void melder(UemsLaeuferMelder melder) {
        this.melder = melder;
    }

    public VerbundBilanzLaeufer(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc, VerbundBilanzService bilanz) {
        this.adminJdbc = adminJdbc;
        this.bilanz = bilanz;
    }

    void uhrStellen(Clock clock) {
        uhr = clock;
    }

    @Scheduled(cron = "${voltpilot.uems.verbund-bilanz.cron:0 37 4 * * *}", zone = "Europe/Berlin")
    public void takt() {
        try {
            int n = lauf(uhr.instant().atZone(GemeinsameSteuerungService.ZONE).toLocalDate().minusDays(1));
            melder.gelaufen(UemsLaeuferMelder.VERBUND_BILANZ);
            if (n > 0) {
                log.info("Verbund-Bilanz: {} Anlage(n) gerechnet", n);
            }
        } catch (RuntimeException e) {
            melder.fehler(UemsLaeuferMelder.VERBUND_BILANZ);
            log.warn("Verbund-Bilanz übersprungen: {}", e.toString());
        }
    }

    /** Ein Takt für den Tag {@code tag} über alle Kundenbereiche mit Verbund; gibt die Zahl der Ergebnisse zurück. */
    public int lauf(LocalDate tag) {
        List<UUID> kundenbereiche = adminJdbc.queryForList(
                "SELECT DISTINCT tenant_id FROM steuerungsverbund ORDER BY tenant_id", UUID.class);
        int gerechnet = 0;
        for (UUID tenant : kundenbereiche) {
            try {
                TenantContext.set(tenant);
                for (UUID anlage : bilanz.anlagen()) {
                    try {
                        if (bilanz.rechnen(anlage, tag).isPresent()) {
                            gerechnet++;
                        }
                    } catch (RuntimeException e) {
                        log.warn("Verbund-Bilanz für Anlage {} am {} gescheitert: {}", anlage, tag, e.toString());
                    }
                }
            } finally {
                TenantContext.clear();
            }
        }
        return gerechnet;
    }
}
