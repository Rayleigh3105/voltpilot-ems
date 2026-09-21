package com.voltpilot.api.uems;

import com.voltpilot.api.metrics.UemsLaeuferMelder;
import com.voltpilot.api.tenant.TenantContext;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
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
 * Der VIERTELSTUNDEN-Takt des Vorbehalts aus Messwerten (AP-15 IP-13 Folge; R23 „die Cloud prüft nach jeder
 * Viertelstunde“, A20, §5.5): 10 Minuten nach jedem Viertelstunden-Ende prüft {@link
 * VorbehaltDienst#pruefenViertelstunden} jede Anlage MIT Gemeinsamer Steuerung gegen das Ungeregelte der reifen
 * Viertelstunden von gestern und heute — und erhöht nur. Ohne Verbund bleibt es bei der einen Frage nach den
 * Kundenbereichen; kein Kundenbereich wird betreten.
 *
 * <p><b>Ein eigener Läufer, nicht ein zweiter Takt am {@link VorbehaltLaeufer}:</b> der Betriebs-Melder schwellt
 * „kein Lauf &gt; 3 × Takt“ je Label ({@link UemsLaeuferMelder.Eintrag#takt}) — unter dem Label des Tageslaufs fiele
 * ein stehender Viertelstunden-Takt erst nach drei Tagen auf, hier nach 45 Minuten; und er hat seinen eigenen Not-Aus
 * ({@code voltpilot.uems.vorbehalt.viertelstunde.enabled}) unter dem des Vorbehalts
 * ({@code voltpilot.uems.vorbehalt.enabled}, der auch {@link VorbehaltSchedulingConfig} einschaltet).
 *
 * <p><b>Nachholen.</b> Jeder Takt liest gestern und heute ganz (reif bis {@link VorbehaltRegel#reifBis}): was ein
 * Ausfall bis zu einem Tag verpasst hat oder was vollständig nachgeliefert wurde, zählt beim nächsten Takt. Doppelt
 * geschieht nichts — erhöht wird nur, solange gemessen &gt; geltend.
 *
 * <p><b>⚠ Wie jeder {@code @Scheduled} ist er im TESTLAUF AUS</b> (surefire-Systemeigenschaft) und in PRODUKTION AN
 * ({@code application.yml}, {@code matchIfMissing}); wer ihn prüft, ruft {@link #lauf(Instant)} selbst. Er wirft nie:
 * ein Fehlschlag je Anlage wird protokolliert, die übrigen laufen weiter.
 */
@Component
@ConditionalOnProperty(name = {"voltpilot.uems.vorbehalt.enabled", "voltpilot.uems.vorbehalt.viertelstunde.enabled"},
        havingValue = "true", matchIfMissing = true)
public class VorbehaltViertelstundeLaeufer {

    private static final Logger log = LoggerFactory.getLogger(VorbehaltViertelstundeLaeufer.class);

    private final JdbcTemplate adminJdbc;
    private final VorbehaltDienst vorbehalt;
    private Clock uhr = Clock.systemUTC();

    /** Der Betriebs-Melder (Läufer {@code vorbehalt_viertelstunde}), nachgereicht wie bei {@link VorbehaltLaeufer}. */
    private UemsLaeuferMelder melder = UemsLaeuferMelder.STUMM;

    @Autowired(required = false)
    void melder(UemsLaeuferMelder melder) {
        this.melder = melder;
    }

    public VorbehaltViertelstundeLaeufer(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            VorbehaltDienst vorbehalt) {
        this.adminJdbc = adminJdbc;
        this.vorbehalt = vorbehalt;
    }

    void uhrStellen(Clock clock) {
        uhr = clock;
    }

    @Scheduled(cron = "${voltpilot.uems.vorbehalt.viertelstunde.cron:0 10/15 * * * *}", zone = "Europe/Berlin")
    public void takt() {
        try {
            int n = lauf(uhr.instant());
            melder.gelaufen(UemsLaeuferMelder.VORBEHALT_VIERTELSTUNDE);
            if (n > 0) {
                log.info("Vorbehalt im Viertelstunden-Takt: {} Anlage(n) erhöht", n);
            }
        } catch (RuntimeException e) {
            melder.fehler(UemsLaeuferMelder.VORBEHALT_VIERTELSTUNDE);
            log.warn("Vorbehalt im Viertelstunden-Takt übersprungen: {}", e.toString());
        }
    }

    /** Ein Takt zur Zeit {@code jetzt} über alle Kundenbereiche mit Verbund; gibt die Zahl der Erhöhungen zurück. */
    public int lauf(Instant jetzt) {
        List<UUID> kundenbereiche = adminJdbc.queryForList(
                "SELECT DISTINCT tenant_id FROM steuerungsverbund ORDER BY tenant_id", UUID.class);
        int erhoeht = 0;
        for (UUID tenant : kundenbereiche) {
            try {
                TenantContext.set(tenant);
                for (UUID anlage : vorbehalt.anlagen()) {
                    try {
                        Optional<VorbehaltDienst.Lauf> l = vorbehalt.pruefenViertelstunden(anlage, jetzt);
                        if (l.isPresent() && l.get().urteil() != null) {
                            erhoeht++;
                        }
                    } catch (RuntimeException e) {
                        log.warn("Vorbehalt im Viertelstunden-Takt für Anlage {} um {} gescheitert: {}", anlage,
                                jetzt, e.toString());
                    }
                }
            } finally {
                TenantContext.clear();
            }
        }
        return erhoeht;
    }
}
