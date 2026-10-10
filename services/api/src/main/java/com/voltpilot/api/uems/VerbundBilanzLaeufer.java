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
 * Der TAKT der Verbund-Bilanz (AP-15 IP-12): einmal täglich rechnet {@link VerbundBilanzService#rechnen} den Vortag
 * (Europe/Berlin) jeder Anlage MIT Gemeinsamer Steuerung — nur dort; ein Kundenbereich ohne Verbund wird nicht einmal
 * betreten. Ein Tag wird genau einmal gerechnet; ein zweiter Takt am selben Tag schreibt nichts. Ausnahme (A4, IP-30):
 * ein Tag der letzten {@value #NACHRECHNEN_TAGE} Tage davor, der noch {@code unbekannt} steht, wird mit dem heutigen
 * Datenstand neu geurteilt — die Boxen puffern 48 h, eine Viertelstunde kann nach dem ersten Lauf nachgeliefert werden.
 * Danach, im selben Takt und mit demselben Melder, die SCHÄTZUNG des Anteils-Verlusts ({@link AnteilVerlustSchaetzung},
 * Folgepaket zu IP-22) für gestern und dieselben {@value #NACHRECHNEN_TAGE} Tage davor — kein eigener Läufer.
 *
 * <p><b>⚠ Wie jeder {@code @Scheduled} ist er im TESTLAUF AUS</b> (surefire-Systemeigenschaft) und in PRODUKTION AN
 * ({@code application.yml}, {@code matchIfMissing}); wer ihn prüft, ruft {@link #lauf(LocalDate)} selbst. Er wirft
 * nie: ein Fehlschlag je Anlage wird protokolliert, die übrigen laufen weiter.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.uems.verbund-bilanz.enabled", havingValue = "true", matchIfMissing = true)
public class VerbundBilanzLaeufer {

    private static final Logger log = LoggerFactory.getLogger(VerbundBilanzLaeufer.class);

    /** 48 h Puffer der Boxen + ein Tag für die Verdichtung der Viertelstunden. */
    static final int NACHRECHNEN_TAGE = 3;

    private final JdbcTemplate adminJdbc;
    private final VerbundBilanzService bilanz;
    private Clock uhr = Clock.systemUTC();

    /** Der Betriebs-Melder (Läufer {@code verbund_bilanz}), nachgereicht wie bei {@code ZeilentextAufbewahrungLaeufer}. */
    private UemsLaeuferMelder melder = UemsLaeuferMelder.STUMM;

    @Autowired(required = false)
    void melder(UemsLaeuferMelder melder) {
        this.melder = melder;
    }

    /** Die Schätzung des Anteils-Verlusts; ohne sie (schmale Testkontexte) rechnet der Takt nur die Bilanz. */
    private AnteilVerlustSchaetzung schaetzung;

    @Autowired(required = false)
    void schaetzung(AnteilVerlustSchaetzung schaetzung) {
        this.schaetzung = schaetzung;
    }

    /** Beendete Kundenbereiche lässt der Läufer aus (AP-20, E10 = A); ohne Spring gilt KEINE. */
    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
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
            LocalDate gestern = uhr.instant().atZone(GemeinsameSteuerungService.ZONE).toLocalDate().minusDays(1);
            int n = lauf(gestern);
            int nach = nachrechnen(gestern);
            if (nach > 0) {
                log.info("Verbund-Bilanz: {} nachgelieferte(r) Tag(e) neu geurteilt", nach);
            }
            schaetzen(gestern);
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
            if (beendete.beendet(tenant)) continue; // Kundenbereich beendet: der Läufer lässt ihn aus
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

    /**
     * Rechnet in jedem Kundenbereich mit Verbund die Tage [{@code gestern} − {@value #NACHRECHNEN_TAGE}, {@code gestern}
     * − 1] neu, die noch {@code unbekannt} stehen; gibt die Zahl der Tage zurück, deren Urteil sich geändert hat.
     */
    public int nachrechnen(LocalDate gestern) {
        List<UUID> kundenbereiche = adminJdbc.queryForList(
                "SELECT DISTINCT tenant_id FROM steuerungsverbund ORDER BY tenant_id", UUID.class);
        int geaendert = 0;
        for (UUID tenant : kundenbereiche) {
            if (beendete.beendet(tenant)) continue; // Kundenbereich beendet: der Läufer lässt ihn aus
            try {
                TenantContext.set(tenant);
                for (UUID anlage : bilanz.anlagen()) {
                    try {
                        geaendert += bilanz.nachrechnen(anlage, gestern.minusDays(NACHRECHNEN_TAGE),
                                gestern.minusDays(1)).size();
                    } catch (RuntimeException e) {
                        log.warn("Verbund-Bilanz nachrechnen für Anlage {} gescheitert: {}", anlage, e.toString());
                    }
                }
            } finally {
                TenantContext.clear();
            }
        }
        return geaendert;
    }

    /**
     * Rechnet in jedem Kundenbereich mit Verbund, je Anlage mit Gemeinsamer Steuerung, die Schätzung des
     * Anteils-Verlusts für [{@code gestern} − {@value #NACHRECHNEN_TAGE}, {@code gestern}] neu (idempotent); gibt die
     * Zahl der geschriebenen Zeilen zurück.
     */
    public int schaetzen(LocalDate gestern) {
        if (schaetzung == null) {
            return 0;
        }
        List<UUID> kundenbereiche = adminJdbc.queryForList(
                "SELECT DISTINCT tenant_id FROM steuerungsverbund ORDER BY tenant_id", UUID.class);
        int n = 0;
        for (UUID tenant : kundenbereiche) {
            if (beendete.beendet(tenant)) continue; // Kundenbereich beendet: der Läufer lässt ihn aus
            try {
                TenantContext.set(tenant);
                for (UUID anlage : bilanz.anlagen()) {
                    try {
                        n += schaetzung.rechnen(anlage, gestern.minusDays(NACHRECHNEN_TAGE), gestern);
                    } catch (RuntimeException e) {
                        log.warn("Anteils-Verlust schätzen für Anlage {} gescheitert: {}", anlage, e.toString());
                    }
                }
            } finally {
                TenantContext.clear();
            }
        }
        return n;
    }
}
