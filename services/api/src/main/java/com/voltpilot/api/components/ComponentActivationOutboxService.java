package com.voltpilot.api.components;

import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.tenant.TenantContext;
import java.time.Instant;
import java.util.UUID;
import java.util.Optional;
import com.voltpilot.api.web.dto.ComponentActivationStatusDto;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

/** Durable, post-commit activation with retry and an honest outcome. */
@Service
public class ComponentActivationOutboxService {
    private final JdbcTemplate admin;
    private final JdbcTemplate jdbc;
    private final EntityRegistryService registry;

    /** Beendete Kundenbereiche lässt der Läufer aus (AP-20, E10 = A); ohne Spring gilt KEINE. */
    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    public ComponentActivationOutboxService(@Qualifier("adminJdbcTemplate") JdbcTemplate admin,
            JdbcTemplate jdbc, EntityRegistryService registry) {
        this.admin = admin;
        this.jdbc = jdbc;
        this.registry = registry;
    }

    public void enqueue(UUID tenantId, UUID siteId, UUID entityId, int revision, String operation) {
        jdbc.update("INSERT INTO component_activation_outbox (tenant_id, site_id, operation, entity_id, revision) "
                        + "VALUES (?, ?, ?, ?, ?) ON CONFLICT (entity_id, revision) DO NOTHING",
                tenantId, siteId, operation, entityId, revision);
    }

    public Optional<ComponentActivationStatusDto> status(UUID entityId) {
        return jdbc.query("SELECT revision, status, attempts, last_error, updated_at, applied_at "
                        + "FROM component_activation_outbox WHERE entity_id = ? ORDER BY revision DESC LIMIT 1",
                (rs, n) -> new ComponentActivationStatusDto(rs.getInt("revision"), rs.getString("status"),
                        rs.getInt("attempts"), rs.getString("last_error"),
                        rs.getObject("updated_at", java.time.OffsetDateTime.class).toInstant(),
                        rs.getObject("applied_at", java.time.OffsetDateTime.class) == null ? null
                                : rs.getObject("applied_at", java.time.OffsetDateTime.class).toInstant()), entityId)
                .stream().findFirst();
    }

    @Scheduled(fixedDelayString = "${voltpilot.components.activation.interval-ms:2000}")
    public void retryPending() {
        admin.query("SELECT id, tenant_id, site_id FROM component_activation_outbox "
                        + "WHERE status = 'pending' AND NOT (tenant_id = ANY (?::uuid[])) ORDER BY created_at LIMIT 20",
                (org.springframework.jdbc.core.RowCallbackHandler) rs -> process(
                        rs.getLong("id"), rs.getObject("tenant_id", UUID.class),
                        rs.getObject("site_id", UUID.class)),
                (Object) beendete.sqlFeld()); // Kundenbereich beendet: bleibt liegen
    }

    private void process(long id, UUID tenantId, UUID siteId) {
        UUID previous = TenantContext.get();
        TenantContext.set(tenantId);
        try {
            EntityRegistryService.PushOutcome outcome = registry.pushRegistryBestEffort(siteId);
            String status = outcome.published() ? "applied"
                    : (!outcome.attempted() && "no_gateway_device".equals(outcome.reason())
                        ? "refused" : "pending");
            admin.update("UPDATE component_activation_outbox SET status = ?, attempts = attempts + 1, "
                            + "last_error = ?, updated_at = ?, applied_at = CASE WHEN ? = 'applied' THEN ? ELSE applied_at END WHERE id = ?",
                    status, outcome.reason(), Instant.now(), status, Instant.now(), id);
        } catch (RuntimeException ex) {
            admin.update("UPDATE component_activation_outbox SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?",
                    ex.getMessage(), Instant.now(), id);
        } finally {
            if (previous == null) TenantContext.clear(); else TenantContext.set(previous);
        }
    }
}
