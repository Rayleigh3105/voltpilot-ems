package com.voltpilot.api.uems;

import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
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
 * Der TAKT des Vorbehalts aus Messwerten (AP-15 IP-13): einmal täglich, nach der Verbund-Bilanz (04:37), prüft
 * {@link VorbehaltDienst#pruefen} jede Anlage MIT Gemeinsamer Steuerung gegen die Höchstwerte des Ungeregelten, die die
 * Bilanz bis gestern gerechnet hat — nur dort; ein Kundenbereich ohne Verbund wird nicht einmal betreten.
 *
 * <p><b>⚠ Wie jeder {@code @Scheduled} ist er im TESTLAUF AUS</b> (surefire-Systemeigenschaft) und in PRODUKTION AN
 * ({@code application.yml}, {@code matchIfMissing}); wer ihn prüft, ruft {@link #lauf(LocalDate)} selbst. Er wirft
 * nie: ein Fehlschlag je Anlage wird protokolliert, die übrigen laufen weiter.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.uems.vorbehalt.enabled", havingValue = "true", matchIfMissing = true)
public class VorbehaltLaeufer {

    private static final Logger log = LoggerFactory.getLogger(VorbehaltLaeufer.class);

    private final JdbcTemplate adminJdbc;
    private final VorbehaltDienst vorbehalt;
    private Clock uhr = Clock.systemUTC();

    /** Der Betriebs-Melder (Läufer {@code vorbehalt}), nachgereicht wie bei {@code VerbundBilanzLaeufer}. */
    private UemsLaeuferMelder melder = UemsLaeuferMelder.STUMM;

    @Autowired(required = false)
    void melder(UemsLaeuferMelder melder) {
        this.melder = melder;
    }

    /** Beendete Kundenbereiche lässt der Läufer aus (AP-20, E10 = A); ohne Spring gilt KEINE. */
    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    public VorbehaltLaeufer(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc, VorbehaltDienst vorbehalt) {
        this.adminJdbc = adminJdbc;
        this.vorbehalt = vorbehalt;
    }

    void uhrStellen(Clock clock) {
        uhr = clock;
    }

    @Scheduled(cron = "${voltpilot.uems.vorbehalt.cron:0 52 4 * * *}", zone = "Europe/Berlin")
    public void takt() {
        try {
            int n = lauf(uhr.instant().atZone(GemeinsameSteuerungService.ZONE).toLocalDate());
            melder.gelaufen(UemsLaeuferMelder.VORBEHALT);
            if (n > 0) {
                log.info("Vorbehalt aus Messwerten: {} Anlage(n) geprüft", n);
            }
        } catch (RuntimeException e) {
            melder.fehler(UemsLaeuferMelder.VORBEHALT);
            log.warn("Vorbehalt aus Messwerten übersprungen: {}", e.toString());
        }
    }

    /** Ein Takt am Tag {@code heute} über alle Kundenbereiche mit Verbund; gibt die Zahl geprüfter Anlagen zurück. */
    public int lauf(LocalDate heute) {
        List<UUID> kundenbereiche = adminJdbc.queryForList(
                "SELECT DISTINCT tenant_id FROM steuerungsverbund ORDER BY tenant_id", UUID.class);
        int geprueft = 0;
        for (UUID tenant : kundenbereiche) {
            if (beendete.beendet(tenant)) continue; // Kundenbereich beendet: der Läufer lässt ihn aus
            try {
                TenantContext.set(tenant);
                for (UUID anlage : vorbehalt.anlagen()) {
                    try {
                        if (vorbehalt.pruefen(anlage, heute).isPresent()) {
                            geprueft++;
                        }
                    } catch (RuntimeException e) {
                        log.warn("Vorbehalt für Anlage {} am {} gescheitert: {}", anlage, heute, e.toString());
                    }
                }
            } finally {
                TenantContext.clear();
            }
        }
        return geprueft;
    }
}
