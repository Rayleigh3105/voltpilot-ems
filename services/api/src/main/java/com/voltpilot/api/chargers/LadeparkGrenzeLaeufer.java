package com.voltpilot.api.chargers;

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
 * Der Tageswechsel des Grenzblatts (UEMS AP-15 IP-3, Folgepaket): eine Fassung am Netzanschluss oder eine Bindung,
 * die an einem SPÄTEREN Tag beginnt oder endet, ändert den wirksamen Bezug, ohne dass jemand speichert. Stündlich
 * fragt dieser Läufer je Anlage mit Ladepark-Rahmen {@link ChargingConfigService#netzgrenzeNachziehen} — der vergleicht
 * den heute wirksamen mit dem zuletzt zugestellten Wert und stellt nur bei einem Unterschied zu. Stündlich statt
 * täglich, weil „heute“ der Tag des Standorts ist (dieselbe Tagesregel wie {@code AnlageGrenzen}); der Vergleich macht
 * jeden weiteren Takt still und holt nach einem Ausfall nach, statt sich auf „gestern lief ich“ zu verlassen.
 *
 * <p><b>⚠ Wie jeder {@code @Scheduled} ist er im TESTLAUF AUS</b> (surefire-Systemeigenschaft) und in PRODUKTION AN
 * ({@code application.yml}, {@code matchIfMissing}); wer ihn prüft, ruft {@link #lauf()} selbst. Er wirft nie.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.uems.ladepark-grenze.enabled", havingValue = "true", matchIfMissing = true)
public class LadeparkGrenzeLaeufer {

    private static final Logger log = LoggerFactory.getLogger(LadeparkGrenzeLaeufer.class);

    private final JdbcTemplate adminJdbc;
    private final LadeparkNetzgrenzeRepository zugestellt;
    private final ChargingConfigService ladepark;

    /** Der Betriebs-Melder (Läufer {@code ladepark_grenze}), nachgereicht wie bei {@code ZeilentextAufbewahrungLaeufer}. */
    private UemsLaeuferMelder melder = UemsLaeuferMelder.STUMM;

    @Autowired(required = false)
    void melder(UemsLaeuferMelder melder) {
        this.melder = melder;
    }

    public LadeparkGrenzeLaeufer(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            LadeparkNetzgrenzeRepository zugestellt, ChargingConfigService ladepark) {
        this.adminJdbc = adminJdbc;
        this.zugestellt = zugestellt;
        this.ladepark = ladepark;
    }

    @Scheduled(cron = "${voltpilot.uems.ladepark-grenze.cron:0 1 * * * *}", zone = "UTC")
    public void takt() {
        try {
            int n = lauf();
            melder.gelaufen(UemsLaeuferMelder.LADEPARK_GRENZE);
            if (n > 0) {
                log.info("Grenzblatt-Anstoß: {} Ladepark-Dokument(e) mit neuem Bezug zugestellt", n);
            }
        } catch (RuntimeException e) {
            melder.fehler(UemsLaeuferMelder.LADEPARK_GRENZE);
            log.warn("Grenzblatt-Anstoß übersprungen: {}", e.toString());
        }
    }

    /** Ein Takt über alle Kundenbereiche; gibt die Zahl der zugestellten Dokumente zurück. Wirft nie je Anlage. */
    public int lauf() {
        List<UUID> kundenbereiche = adminJdbc.queryForList("SELECT id FROM tenant ORDER BY created_at, id", UUID.class);
        int zugestellte = 0;
        for (UUID tenant : kundenbereiche) {
            try {
                TenantContext.set(tenant);
                for (UUID anlage : zugestellt.anlagenMitRahmen()) {
                    try {
                        if (ladepark.netzgrenzeNachziehen(tenant, anlage)) {
                            zugestellte++;
                        }
                    } catch (RuntimeException e) {
                        log.warn("Grenzblatt-Anstoß für Anlage {} gescheitert: {}", anlage, e.toString());
                    }
                }
            } catch (RuntimeException e) {
                log.warn("Grenzblatt-Anstoß für Kundenbereich {} gescheitert: {}", tenant, e.toString());
            } finally {
                TenantContext.clear();
            }
        }
        return zugestellte;
    }
}
