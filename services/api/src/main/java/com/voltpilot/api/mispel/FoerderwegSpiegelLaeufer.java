package com.voltpilot.api.mispel;

import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.metrics.UemsLaeuferMelder;
import com.voltpilot.api.tenant.TenantContext;
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
 * Der Tageswechsel des Förderwegs (MiSpeL MP-17, Vertrag {@code mispel-foerderweg.md} § 5): eine zum nächsten
 * Monatsersten vorgemerkte Fassung gilt ab 00:00 gesetzlicher Zeit, ohne dass jemand speichert. Optimierer und Box lesen
 * bis MP-14 die Spiegel an der Anlage ({@code netzladen_erlaubt}, {@code plant_kind}); dieser Läufer legt sie je Anlage
 * mit Fassung über {@link FoerderwegService#spiegelNachziehen} um. Stündlich statt einmal um Mitternacht: der Vergleich
 * macht jeden weiteren Takt still und holt nach einem Ausfall nach, statt sich auf „gestern lief ich“ zu verlassen.
 *
 * <p><b>⚠ Wie jeder {@code @Scheduled} ist er im TESTLAUF AUS</b> (surefire-Systemeigenschaft) und in PRODUKTION AN
 * ({@code application.yml}, {@code matchIfMissing}); wer ihn prüft, ruft {@link #lauf()} selbst. Er wirft nie.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.mispel.foerderweg-spiegel.enabled", havingValue = "true", matchIfMissing = true)
public class FoerderwegSpiegelLaeufer {

    private static final Logger log = LoggerFactory.getLogger(FoerderwegSpiegelLaeufer.class);

    private final JdbcTemplate adminJdbc;
    private final FoerderwegRepository wege;
    private final FoerderwegService dienst;

    /** Der Betriebs-Melder (Läufer {@code mispel_foerderweg_spiegel}, MP-8b); ohne Spring der stumme. */
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

    public FoerderwegSpiegelLaeufer(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc, FoerderwegRepository wege,
            FoerderwegService dienst) {
        this.adminJdbc = adminJdbc;
        this.wege = wege;
        this.dienst = dienst;
    }

    @Scheduled(cron = "${voltpilot.mispel.foerderweg-spiegel.cron:30 0 * * * *}", zone = "Europe/Berlin")
    public void takt() {
        try {
            int n = lauf();
            melder.gelaufen(UemsLaeuferMelder.MISPEL_FOERDERWEG_SPIEGEL);
            if (n > 0) {
                log.info("Förderweg-Spiegel: {} Anlage(n) auf die heute geltende Fassung umgelegt", n);
            }
        } catch (RuntimeException e) {
            melder.fehler(UemsLaeuferMelder.MISPEL_FOERDERWEG_SPIEGEL);
            log.warn("Förderweg-Spiegel übersprungen: {}", e.toString());
        }
    }

    /** Ein Takt über alle Kundenbereiche; gibt die Zahl der umgelegten Anlagen zurück. Wirft nie je Anlage. */
    public int lauf() {
        List<UUID> kundenbereiche = adminJdbc.queryForList("SELECT id FROM tenant ORDER BY created_at, id", UUID.class);
        int umgelegt = 0;
        for (UUID tenant : kundenbereiche) {
            if (beendete.beendet(tenant)) continue; // Kundenbereich beendet: der Läufer lässt ihn aus
            try {
                TenantContext.set(tenant);
                for (UUID anlage : wege.anlagenMitFassung()) {
                    try {
                        if (dienst.spiegelNachziehen(anlage)) {
                            umgelegt++;
                        }
                    } catch (RuntimeException e) {
                        melder.fehler(UemsLaeuferMelder.MISPEL_FOERDERWEG_SPIEGEL);
                        log.warn("Förderweg-Spiegel für Anlage {} gescheitert: {}", anlage, e.toString());
                    }
                }
            } catch (RuntimeException e) {
                melder.fehler(UemsLaeuferMelder.MISPEL_FOERDERWEG_SPIEGEL);
                log.warn("Förderweg-Spiegel für Kundenbereich {} gescheitert: {}", tenant, e.toString());
            } finally {
                TenantContext.clear();
            }
        }
        return umgelegt;
    }
}
