package com.voltpilot.api.provisioning;

import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.tenant.TenantContext;
import java.time.Instant;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

/** Durable move provisioning; broker outages remain visible and retryable. */
@Service
public class MoveProvisioningOutboxService {
    private final JdbcTemplate admin;
    private final JdbcTemplate jdbc;
    private final ObjectProvider<ProvisioningPublisher> provisioning;
    private final EntityRegistryService registry;

    public MoveProvisioningOutboxService(@Qualifier("adminJdbcTemplate") JdbcTemplate admin,
            JdbcTemplate jdbc, ObjectProvider<ProvisioningPublisher> provisioning, EntityRegistryService registry) {
        this.admin = admin;
        this.jdbc = jdbc;
        this.provisioning = provisioning;
        this.registry = registry;
    }

    public void enqueue(UUID tenantId, UUID deviceId, UUID fromSiteId, UUID toSiteId,
            int revision, String externalRef) {
        jdbc.update("INSERT INTO move_provisioning_operation (tenant_id, device_id, from_site_id, to_site_id, revision, external_ref) "
                        + "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (device_id, revision) DO NOTHING",
                tenantId, deviceId, fromSiteId, toSiteId, revision, externalRef);
    }

    @Scheduled(fixedDelayString = "${voltpilot.devices.move-provisioning.interval-ms:2000}")
    public void retryPending() {
        admin.query("SELECT id, tenant_id, device_id, from_site_id, to_site_id, external_ref FROM move_provisioning_operation "
                        + "WHERE status = 'pending' ORDER BY created_at LIMIT 20",
                (org.springframework.jdbc.core.RowCallbackHandler) rs -> process(
                        rs.getLong("id"), rs.getObject("tenant_id", UUID.class),
                        rs.getObject("device_id", UUID.class), rs.getObject("from_site_id", UUID.class),
                        rs.getObject("to_site_id", UUID.class), rs.getString("external_ref")));
    }

    private void process(long id, UUID tenantId, UUID deviceId, UUID fromSiteId, UUID toSiteId,
            String externalRef) {
        UUID previous = TenantContext.get(); TenantContext.set(tenantId);
        try {
            ProvisioningPublisher publisher = provisioning.getIfAvailable();
            boolean clear = publisher == null || publisher.clearRetained(externalRef, tenantId, fromSiteId, deviceId);
            boolean publish = publisher == null || publisher.publishConfig(externalRef, tenantId, toSiteId, deviceId);
            registry.pushRegistryBestEffort(toSiteId);
            String status = clear && publish ? "applied" : "pending";
            admin.update("UPDATE move_provisioning_operation SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ?, "
                            + "applied_at = CASE WHEN ? = 'applied' THEN ? ELSE applied_at END WHERE id = ?",
                    status, status.equals("applied") ? null : "broker_publish_failed", Instant.now(), status, Instant.now(), id);
        } catch (RuntimeException ex) {
            admin.update("UPDATE move_provisioning_operation SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?",
                    ex.getMessage(), Instant.now(), id);
        } finally { if (previous == null) TenantContext.clear(); else TenantContext.set(previous); }
    }
}
