package com.voltpilot.api.direktvermarktung;

import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
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
 * Der Takt des Zustell-Abgleichs (Muster {@code PreisZuleitungTakt} / {@code MeasurementConfigReconciler}):
 * beim Start und danach regelmäßig läuft {@link DirektvermarktungZustellung#abgleichen} für jede Anlage, die
 * einen Anschluss über den Entwurf hinaus hat ODER deren Buchführung noch eine Box nennt (Rückzug offen).
 * Der Takt ist die EINE Konvergenz-Maschine - ein verpasster Broker, ein eben hochgeladener Zugang (die
 * Übernahme ist ein eigener Auftrag und ruft hier nichts), ein Box-Tausch: alles holt der nächste Tick nach.
 *
 * <p>Kandidaten findet die Verwaltungsverbindung ({@code adminJdbcTemplate}, BYPASSRLS, read-only);
 * gearbeitet wird je Anlage unter ihrem {@link TenantContext}, damit RLS jede Schreib- und Lesespur fenzt.
 * Aus in Tests ({@code voltpilot.direktvermarktung.zustellung-enabled}, Surefire schaltet es ab).
 */
@Component
@ConditionalOnProperty(name = "voltpilot.direktvermarktung.zustellung-enabled", havingValue = "true")
public class DirektvermarktungZustellungTakt {

    private static final Logger log = LoggerFactory.getLogger(DirektvermarktungZustellungTakt.class);

    private record Kandidat(UUID tenantId, UUID siteId) {}

    private final JdbcTemplate adminJdbc;
    private final DirektvermarktungZustellung zustellung;
    private final BeendeteKundenbereiche beendete;

    @Autowired
    public DirektvermarktungZustellungTakt(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            DirektvermarktungZustellung zustellung, BeendeteKundenbereiche beendete) {
        this.adminJdbc = adminJdbc;
        this.zustellung = zustellung;
        this.beendete = beendete;
    }

    @Scheduled(fixedDelayString = "${voltpilot.direktvermarktung.zustellung-takt-ms:30000}",
            initialDelayString = "${voltpilot.direktvermarktung.zustellung-start-ms:20000}")
    public void tick() {
        try {
            run();
        } catch (RuntimeException e) {
            log.error("direktvermarktung: Zustell-Abgleich fehlgeschlagen, naechster Takt holt auf: {}",
                    e.toString(), e);
        }
    }

    /** Ein Durchlauf; für Tests direkt aufrufbar. */
    public int run() {
        List<Kandidat> kandidaten = adminJdbc.query(
                "SELECT DISTINCT tenant_id, site_id FROM direktvermarktung "
                        + "WHERE box_id IS NOT NULL OR zustand NOT IN ('entwurf', 'beendet') "
                        + "ORDER BY tenant_id, site_id",
                (rs, n) -> new Kandidat(rs.getObject("tenant_id", UUID.class),
                        rs.getObject("site_id", UUID.class)));
        int bearbeitet = 0;
        for (Kandidat k : kandidaten) {
            if (k.tenantId() == null || beendete.beendet(k.tenantId())) {
                continue;
            }
            try {
                TenantContext.set(k.tenantId());
                try {
                    zustellung.abgleichen(k.siteId());
                    bearbeitet++;
                } finally {
                    TenantContext.clear();
                }
            } catch (RuntimeException e) {
                log.warn("direktvermarktung: Abgleich der Anlage {} fehlgeschlagen: {}", k.siteId(), e.toString());
            }
        }
        return bearbeitet;
    }
}
