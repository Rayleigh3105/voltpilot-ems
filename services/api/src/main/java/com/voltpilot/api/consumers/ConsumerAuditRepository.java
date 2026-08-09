package com.voltpilot.api.consumers;

import com.voltpilot.api.tenant.TenantContext;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Append-only audit trail of consumer-policy lifecycle actions (§16: "Jede
 * Änderung, Aktivierung, Pause ... wird auditiert"). RLS-scoped like every
 * consumer table; the app role holds INSERT+SELECT only - rows are never
 * updated or deleted through the app.
 */
@Repository
public class ConsumerAuditRepository {

    public record AuditRow(long id, UUID entityId, String eventType, UUID policyId,
            Integer policyVersion, String actor, String detail, Instant occurredAt) {}

    private final JdbcTemplate jdbc;

    public ConsumerAuditRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public void append(UUID siteId, UUID entityId, String eventType, UUID policyId,
            Integer policyVersion, String actor, String detail) {
        jdbc.update(
                "INSERT INTO consumer_audit_event (tenant_id, site_id, entity_id, event_type, "
                        + "policy_id, policy_version, actor, detail) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                TenantContext.get(), siteId, entityId, eventType, policyId, policyVersion,
                actor, detail);
    }

    /** Newest first, per consumer (support/diagnosis read). */
    public List<AuditRow> forConsumer(UUID siteId, UUID entityId, int limit) {
        return jdbc.query(
                "SELECT id, entity_id, event_type, policy_id, policy_version, actor, detail, "
                        + "occurred_at FROM consumer_audit_event "
                        + "WHERE site_id = ? AND entity_id = ? ORDER BY occurred_at DESC, id DESC "
                        + "LIMIT ?",
                (rs, n) -> new AuditRow(rs.getLong("id"),
                        rs.getObject("entity_id", UUID.class),
                        rs.getString("event_type"),
                        rs.getObject("policy_id", UUID.class),
                        (Integer) rs.getObject("policy_version"),
                        rs.getString("actor"),
                        rs.getString("detail"),
                        rs.getObject("occurred_at", java.time.OffsetDateTime.class).toInstant()),
                siteId, entityId, limit);
    }
}
