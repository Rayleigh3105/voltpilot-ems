package com.voltpilot.api.direktvermarktung;

import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.tenant.TenantContext;
import java.time.Clock;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Der TAKT der Direktvermarktung über alle Mandanten (Muster {@code AblaufLaeufer}): Start- und Enddaten,
 * die erreicht sind, stellt {@link DirektvermarktungService#naechtlicheUebergaenge(LocalDate)} je Mandant
 * um. Reine Sichtbarkeit nach außen (Vermarktungsart, Protokoll) - ohne ihn bliebe ein erreichtes Datum
 * bis zum nächsten Takt liegen, holt es dann aber nach (Teil-Index auf {@code startdatum}/{@code ende}).
 *
 * <p>⚠ Wie jeder {@code @Scheduled} ist er im TESTLAUF AUS und in Produktion AN (AGENTS.md, Muster
 * {@code AblaufLaeufer}). Beendete Kundenbereiche lässt er aus ({@link BeendeteKundenbereiche},
 * {@code LaeuferBeendetArchitekturTest}) - ohne Spring gilt {@link BeendeteKundenbereiche#KEINE}.
 */
@Component
public class DirektvermarktungNachtlauf {

    private static final Logger log = LoggerFactory.getLogger(DirektvermarktungNachtlauf.class);

    private final JdbcTemplate adminJdbc;
    private final DirektvermarktungService dienst;
    private final Clock clock;

    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    @Autowired
    public DirektvermarktungNachtlauf(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            DirektvermarktungService dienst) {
        this(adminJdbc, dienst, Clock.systemUTC());
    }

    DirektvermarktungNachtlauf(JdbcTemplate adminJdbc, DirektvermarktungService dienst, Clock clock) {
        this.adminJdbc = adminJdbc;
        this.dienst = dienst;
        this.clock = clock;
    }

    @Scheduled(cron = "${voltpilot.direktvermarktung.nachtlauf-cron:0 20 2 * * *}")
    public void takt() {
        lauf(LocalDate.now(clock));
    }

    /** Ein Takt über alle Mandanten. Wirft nie je Mandant - ein gescheiterter Mandant wartet auf den nächsten Takt. */
    public void lauf(LocalDate heute) {
        List<UUID> mandanten = adminJdbc.queryForList("SELECT id FROM tenant ORDER BY created_at, id", UUID.class);
        for (UUID tenant : mandanten) {
            if (beendete.beendet(tenant)) continue; // beendeter Kundenbereich: der Läufer lässt ihn aus
            try {
                TenantContext.set(tenant);
                dienst.naechtlicheUebergaenge(heute);
            } catch (RuntimeException e) {
                log.error("direktvermarktung: Nachtlauf für Mandant {} gescheitert: {}", tenant, e.toString(), e);
            } finally {
                TenantContext.clear();
            }
        }
    }
}
