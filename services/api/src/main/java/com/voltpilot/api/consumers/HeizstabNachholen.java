package com.voltpilot.api.consumers;

import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Meldet eine Box {@code heizstab_regler} neu - nach ihrem Update -, bekommt sie den
 * Parameterblock ihrer Heizstäbe sofort (Heizstab V1, Paket 3): der Push, den sie hat, entstand
 * noch ohne. Dasselbe Muster wie die Anlagensteuerung (AnlagensteuerungQuelle#nachFaehigkeitsmeldung):
 * nach dem Commit der Meldung, je Anlage eine eigene Transaktion unter ihrem Mandanten; ein Fehler
 * nimmt der Box nie ihre Fähigkeiten, und ein verlorener Anstoß holt der nächste Push nach.
 */
@Component
public class HeizstabNachholen {

    private static final Logger log = LoggerFactory.getLogger(HeizstabNachholen.class);

    private final JdbcTemplate adminJdbc;
    private final ObjectProvider<EntityRegistryService> registry;
    private final TransactionTemplate tx;

    public HeizstabNachholen(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            ObjectProvider<EntityRegistryService> registry, PlatformTransactionManager transaktionen) {
        this.adminJdbc = adminJdbc;
        this.registry = registry;
        this.tx = new TransactionTemplate(transaktionen);
        this.tx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void nachFaehigkeitsmeldung(BoxFaehigkeiten.Gemeldet meldung) {
        if (meldet(meldung.vorher()) || !meldet(meldung.nachher())) {
            return;
        }
        EntityRegistryService r = registry.getIfAvailable();
        if (r == null) {
            return;
        }
        UUID vorher = TenantContext.get();
        try {
            record Anlage(UUID tenantId, UUID siteId) {}
            List<Anlage> anlagen = adminJdbc.query(
                    "SELECT DISTINCT mp.tenant_id, mp.site_id FROM device d "
                            + "JOIN measurement_point mp ON mp.site_id = d.site_id "
                            + "WHERE d.id = ? AND mp.entity_type = ?",
                    (rs, i) -> new Anlage(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class)),
                    meldung.deviceId(), HeizstabGeraet.TYP);
            for (Anlage a : anlagen) {
                TenantContext.set(a.tenantId());
                tx.executeWithoutResult(s -> r.pushRegistryBestEffort(a.siteId()));
            }
            if (!anlagen.isEmpty()) {
                log.info("Box {} meldet {}: Registry-Push mit Heizstab-Block angestoßen ({} Anlage(n))",
                        meldung.deviceId(), HeizstabGeraet.FAEHIGKEIT, anlagen.size());
            }
        } catch (RuntimeException e) {
            log.warn("Anstoß des Heizstab-Reglers für Box {} fehlgeschlagen: {}", meldung.deviceId(), e.getMessage());
        } finally {
            if (vorher == null) {
                TenantContext.clear();
            } else {
                TenantContext.set(vorher);
            }
        }
    }

    static boolean meldet(List<String> supports) {
        return supports != null && supports.contains(HeizstabGeraet.FAEHIGKEIT);
    }
}
