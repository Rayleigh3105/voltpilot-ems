package com.voltpilot.api.provisioning;

import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.tenant.TenantContext;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

@Service
public class MoveProvisioningOutboxService {

    record PendingMove(long id, UUID tenantId, UUID deviceId, UUID fromSiteId,
            UUID toSiteId, String externalRef) {}

    private final JdbcTemplate admin;
    private final ObjectProvider<ProvisioningPublisher> provisioning;
    private final EntityRegistryService registry;

    /** Beendete Kundenbereiche lässt der Läufer aus (AP-20, E10 = A); ohne Spring gilt KEINE. */
    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    public MoveProvisioningOutboxService(
            @Qualifier("adminJdbcTemplate") JdbcTemplate admin,
            ObjectProvider<ProvisioningPublisher> provisioning,
            EntityRegistryService registry) {
        this.admin = admin;
        this.provisioning = provisioning;
        this.registry = registry;
    }

    @Scheduled(fixedDelayString = "${voltpilot.devices.move-provisioning.interval-ms:2000}")
    public void retryPending() {
        List<PendingMove> pending = admin.query(
                "SELECT id, tenant_id, device_id, from_site_id, to_site_id, external_ref "
                        + "FROM move_provisioning_operation WHERE status = 'pending' "
                        + "AND NOT (tenant_id = ANY (?::uuid[])) " // Kundenbereich beendet: bleibt liegen
                        + "ORDER BY created_at LIMIT 20",
                (rs, rowNum) -> new PendingMove(
                        rs.getLong("id"), rs.getObject("tenant_id", UUID.class),
                        rs.getObject("device_id", UUID.class),
                        rs.getObject("from_site_id", UUID.class),
                        rs.getObject("to_site_id", UUID.class), rs.getString("external_ref")),
                (Object) beendete.sqlFeld());
        pending.forEach(this::process);
    }

    private void process(PendingMove move) {
        UUID previous = TenantContext.get();
        TenantContext.set(move.tenantId());
        try {
            ProvisioningPublisher publisher = provisioning.getIfAvailable();
            if (publisher == null) {
                admin.update("UPDATE move_provisioning_operation SET status = 'refused', "
                                + "attempts = attempts + 1, last_error = ?, updated_at = ? "
                                + "WHERE id = ?",
                        "mqtt_not_configured", Instant.now(), move.id());
                return;
            }
            boolean clear = publisher.clearRetained(move.externalRef(), move.tenantId(),
                    move.fromSiteId(), move.deviceId());
            boolean publish = publisher.publishConfig(move.externalRef(), move.tenantId(),
                    move.toSiteId(), move.deviceId());
            EntityRegistryService.PushOutcome registryOutcome =
                    registry.pushRegistryBestEffort(move.toSiteId());
            boolean refused = !registryOutcome.attempted()
                    && "no_gateway_device".equals(registryOutcome.reason());
            String status = clear && publish && registryOutcome.published()
                    ? "applied" : (refused ? "refused" : "pending");
            String error = "applied".equals(status) ? null
                    : (registryOutcome.reason() == null
                            ? "broker_publish_failed" : registryOutcome.reason());
            Instant now = Instant.now();
            admin.update("UPDATE move_provisioning_operation SET status = ?, "
                            + "attempts = attempts + 1, last_error = ?, updated_at = ?, "
                            + "applied_at = CASE WHEN ? = 'applied' THEN ? ELSE applied_at END "
                            + "WHERE id = ?",
                    status, error, now, status, now, move.id());
        } catch (RuntimeException ex) {
            admin.update("UPDATE move_provisioning_operation SET attempts = attempts + 1, "
                            + "last_error = ?, updated_at = ? WHERE id = ?",
                    ex.getMessage(), Instant.now(), move.id());
        } finally {
            if (previous == null) {
                TenantContext.clear();
            } else {
                TenantContext.set(previous);
            }
        }
    }
}
