package com.voltpilot.api.repo;

import com.voltpilot.api.uems.ProtokollAkteur;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * The TTL-bound manual override of a consumer (consumer_override, migration
 * V20260813010000; Inkrement 5 / §11 + §14.13), RLS-scoped through the
 * {@code @Primary} datasource. One row per consumer, replaced on a new override;
 * an EXPIRED row (ends_at &lt; now) is treated as absent by every read so a
 * stale intervention never lingers (§16).
 */
@Repository
public class ConsumerOverrideRepository {

    /** An active manual override; {@code targetValue} is the setpoint kW or null. */
    public record Row(UUID entityId, String kind, String targetCommand, BigDecimal targetValue,
            Instant endsAt, String createdBy) {}

    private final JdbcTemplate jdbc;

    public ConsumerOverrideRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Upsert the site's manual override for a consumer (RLS stamps the tenant). */
    public void put(UUID siteId, UUID entityId, String kind, String command, BigDecimal value,
            Instant endsAt, String createdBy) {
        // Der Urheber im Akteur-Vokabular (AP-03 IP-7) — nur, wenn createdBy der Aufrufer der Anfrage ist.
        ProtokollAkteur wer = ProtokollAkteur.angemeldetAls(createdBy).orElse(null);
        jdbc.update(
                "INSERT INTO consumer_override (entity_id, tenant_id, site_id, kind, "
                        + "target_command, target_value, ends_at, created_by, created_at, "
                        + "actor_sub, actor_name, actor_rolle, actor_art) VALUES "
                        + "(?, NULLIF(current_setting('app.tenant_id', true), '')::uuid, ?, ?, ?, "
                        + "?, ?, ?, now(), ?, ?, ?, ?) ON CONFLICT (entity_id) DO UPDATE SET "
                        + "site_id = EXCLUDED.site_id, kind = EXCLUDED.kind, "
                        + "target_command = EXCLUDED.target_command, "
                        + "target_value = EXCLUDED.target_value, ends_at = EXCLUDED.ends_at, "
                        + "created_by = EXCLUDED.created_by, created_at = now(), "
                        + "actor_sub = EXCLUDED.actor_sub, actor_name = EXCLUDED.actor_name, "
                        + "actor_rolle = EXCLUDED.actor_rolle, actor_art = EXCLUDED.actor_art",
                entityId, siteId, kind, command, value, Timestamp.from(endsAt), createdBy,
                wer == null ? null : wer.sub(), wer == null ? null : wer.name(),
                wer == null ? null : wer.rolle(), wer == null ? null : wer.art());
    }

    public void clear(UUID siteId, UUID entityId) {
        jdbc.update("DELETE FROM consumer_override WHERE site_id = ? AND entity_id = ?",
                siteId, entityId);
    }

    /** The consumer's ACTIVE override (unexpired), or empty. */
    public Optional<Row> active(UUID siteId, UUID entityId) {
        return jdbc.query(
                        "SELECT entity_id, kind, target_command, target_value, ends_at, created_by "
                                + "FROM consumer_override WHERE site_id = ? AND entity_id = ? "
                                + "AND ends_at > now()",
                        (rs, i) -> map(rs), siteId, entityId)
                .stream().findFirst();
    }

    /** Every ACTIVE override of a site (for the cockpit / status). */
    public List<Row> activeForSite(UUID siteId) {
        return jdbc.query(
                "SELECT entity_id, kind, target_command, target_value, ends_at, created_by "
                        + "FROM consumer_override WHERE site_id = ? AND ends_at > now()",
                (rs, i) -> map(rs), siteId);
    }

    private static Row map(java.sql.ResultSet rs) {
        try {
            return new Row(rs.getObject("entity_id", UUID.class), rs.getString("kind"),
                    rs.getString("target_command"), rs.getBigDecimal("target_value"),
                    rs.getTimestamp("ends_at").toInstant(), rs.getString("created_by"));
        } catch (java.sql.SQLException e) {
            throw new IllegalStateException(e);
        }
    }
}
