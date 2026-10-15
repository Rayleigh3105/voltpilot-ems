package com.voltpilot.api.ueberwachung;

import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.tenant.TenantContext;
import java.time.Instant;
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
 * Der Takt der Überwachung (Alerting Scheibe 1, Konzept §6.7 "EINE Auswertung, periodisch in der
 * API"): wie {@code AblaufLaeufer} für die Unterstützung - je Kundenbereich unter
 * {@link TenantContext}, mit der LAUFZEITROLLE (nicht der BYPASSRLS-Admin-Rolle). Nur die
 * Kundenbereichs-Liste selbst kommt über die Admin-Rolle (quer über alle Mandanten); die eigentliche
 * Arbeit läuft unter RLS, wie ein Benutzer ohne Zugriffs-Kontext (§6.6: "sieht ohne
 * app.zugriff/app.standort_ids automatisch das ganze Unternehmen" - die Sicht je EMPFÄNGER prüft
 * erst der Zusteller beim Versand).
 *
 * <p>Takt 15 s (Vorgabe, §6.7 "Takt je Werteform": Momentanwerte/Zustände alle 60 s wären auch
 * ausreichend, aber 15 s hält die Dauer-Schwelle "15 Minuten" aus Entscheid 2A auf wenige Sekunden
 * genau, ohne die Hotpaths zu belasten - jeder Takt liest nur die Boxen/Datenquellen EINES
 * Kundenbereichs, kein Trigger auf den Ingest-Tabellen). Schalter {@code voltpilot.ueberwachung.enabled} -
 * Vorgabe AN (Hausregel), im Testlauf AUS (surefire, {@code services/api/pom.xml}).
 */
@Component
@ConditionalOnProperty(name = "voltpilot.ueberwachung.enabled", havingValue = "true", matchIfMissing = true)
public class UeberwachungsLaeufer {

    private static final Logger log = LoggerFactory.getLogger(UeberwachungsLaeufer.class);

    private final JdbcTemplate adminJdbc;
    private final UeberwachungsService dienst;

    /** Beendete Kundenbereiche lässt der Läufer aus (AP-20, E10 = A); ohne Spring gilt KEINE. */
    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    public UeberwachungsLaeufer(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            UeberwachungsService dienst) {
        this.adminJdbc = adminJdbc;
        this.dienst = dienst;
    }

    @Scheduled(fixedDelayString = "${voltpilot.ueberwachung.interval-ms:15000}",
            initialDelayString = "${voltpilot.ueberwachung.initial-delay-ms:20000}")
    public void takt() {
        try {
            lauf(Instant.now());
        } catch (RuntimeException e) {
            log.warn("Überwachung: Takt übersprungen: {}", e.toString());
        }
    }

    /** Ein Takt über alle Kundenbereiche, ältester zuerst. Wirft nie je Kundenbereich. */
    public UeberwachungsService.Lauf lauf(Instant jetzt) {
        List<UUID> kundenbereiche =
                adminJdbc.queryForList("SELECT id FROM tenant ORDER BY created_at, id", UUID.class);
        int gesaet = 0;
        int ausgeloest = 0;
        int erledigt = 0;
        for (UUID tenant : kundenbereiche) {
            if (beendete.beendet(tenant)) {
                continue;
            }
            try {
                TenantContext.set(tenant);
                UeberwachungsService.Lauf l = dienst.lauf(jetzt);
                gesaet += l.gesaet();
                ausgeloest += l.ausgeloest();
                erledigt += l.erledigt();
            } catch (RuntimeException e) {
                log.error("Überwachung: Takt für Kundenbereich {} gescheitert, nichts eingetragen: {}", tenant,
                        e.toString(), e);
            } finally {
                TenantContext.clear();
            }
        }
        return new UeberwachungsService.Lauf(gesaet, ausgeloest, erledigt);
    }
}
