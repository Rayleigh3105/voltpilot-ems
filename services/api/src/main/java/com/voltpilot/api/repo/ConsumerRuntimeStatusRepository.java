package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.ConsumerRuntimeStatusDto;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * The edge-reported live state of controllable consumer entities
 * (consumer_runtime_status, migration V20260811000000), RLS-scoped to the
 * current tenant like every device-owned table. The consumers listener
 * replaces a DEVICE's whole set per heartbeat (the entity_observed_state
 * discipline); the portal reads per site / per entity.
 */
@Repository
public class ConsumerRuntimeStatusRepository {

    /** One ingested consumer entity state. */
    public record Row(UUID entityId, String state, String reasonCode, Double actualKw,
            Boolean confirmed, Integer runtimeSecondsToday, Integer startsToday) {
    }

    private final JdbcTemplate jdbc;

    public ConsumerRuntimeStatusRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * The site's consumer entity ids (consumer_profile is the truth of "is a
     * consumer here") - the ingest gate: a reported entity id outside this set
     * is discarded, so a spoofed/foreign id never mints a row.
     */
    public Set<UUID> consumerEntityIds(UUID siteId) {
        return jdbc.queryForList(
                        "SELECT entity_id FROM consumer_profile WHERE site_id = ?", UUID.class, siteId)
                .stream().collect(Collectors.toSet());
    }

    /**
     * Replace the device's whole reported set (one row per entity, wholesale
     * per heartbeat). RLS' WITH CHECK stamps every row into the session tenant.
     *
     * <p><b>Returns the PREVIOUS set</b> - the rows the wholesale delete just
     * removed. That is what the Stufe-5b rule protocol compares the new set
     * against ({@link com.voltpilot.api.rules.RuleEventWriter}), and taking it
     * from the {@code DELETE ... RETURNING} costs nothing: the statement scans
     * exactly those rows anyway. Reading them with a separate SELECT first
     * would be a second query on the hot path.
     */
    @Transactional
    public List<Row> replaceForDevice(UUID deviceId, UUID siteId, Instant reportedAt,
            List<Row> rows) {
        List<Row> previous = jdbc.query(
                "DELETE FROM consumer_runtime_status WHERE device_id = ? "
                        + "RETURNING entity_id, state, reason_code, actual_kw, confirmed, "
                        + "runtime_seconds_today, starts_today",
                (rs, i) -> new Row(rs.getObject("entity_id", UUID.class), rs.getString("state"),
                        rs.getString("reason_code"), (Double) rs.getObject("actual_kw"),
                        (Boolean) rs.getObject("confirmed"),
                        (Integer) rs.getObject("runtime_seconds_today"),
                        (Integer) rs.getObject("starts_today")),
                deviceId);
        for (Row r : rows) {
            jdbc.update(
                    "INSERT INTO consumer_runtime_status (entity_id, tenant_id, site_id, device_id, "
                            + "state, reason_code, actual_kw, confirmed, runtime_seconds_today, "
                            + "starts_today, reported_at, updated_at) "
                            + "VALUES (?, NULLIF(current_setting('app.tenant_id', true), '')::uuid, "
                            + "?, ?, ?, ?, ?, ?, ?, ?, ?, now()) "
                            + "ON CONFLICT (entity_id) DO UPDATE SET "
                            + "site_id = EXCLUDED.site_id, device_id = EXCLUDED.device_id, "
                            + "state = EXCLUDED.state, reason_code = EXCLUDED.reason_code, "
                            + "actual_kw = EXCLUDED.actual_kw, confirmed = EXCLUDED.confirmed, "
                            + "runtime_seconds_today = EXCLUDED.runtime_seconds_today, "
                            + "starts_today = EXCLUDED.starts_today, "
                            + "reported_at = EXCLUDED.reported_at, updated_at = now()",
                    r.entityId(), siteId, deviceId, r.state(), r.reasonCode(), r.actualKw(),
                    r.confirmed(), r.runtimeSecondsToday(), r.startsToday(),
                    Timestamp.from(reportedAt));
        }
        return previous;
    }

    /** All reported consumer states of a site (empty = no evidence yet). */
    public List<ConsumerRuntimeStatusDto> listForSite(UUID siteId) {
        return jdbc.query(
                "SELECT entity_id, state, reason_code, actual_kw, confirmed, "
                        + "runtime_seconds_today, starts_today, reported_at "
                        + "FROM consumer_runtime_status WHERE site_id = ? ORDER BY entity_id",
                (rs, i) -> map(rs), siteId);
    }

    /** One entity's reported state, or empty (=> 204, "Zustand nicht bestätigt"). */
    public Optional<ConsumerRuntimeStatusDto> forEntity(UUID siteId, UUID entityId) {
        return jdbc.query(
                        "SELECT entity_id, state, reason_code, actual_kw, confirmed, "
                                + "runtime_seconds_today, starts_today, reported_at "
                                + "FROM consumer_runtime_status WHERE site_id = ? AND entity_id = ?",
                        (rs, i) -> map(rs), siteId, entityId)
                .stream().findFirst();
    }

    private static ConsumerRuntimeStatusDto map(java.sql.ResultSet rs) {
        try {
            return new ConsumerRuntimeStatusDto(
                    rs.getObject("entity_id", UUID.class),
                    rs.getString("state"),
                    rs.getString("reason_code"),
                    (Double) rs.getObject("actual_kw"),
                    (Boolean) rs.getObject("confirmed"),
                    (Integer) rs.getObject("runtime_seconds_today"),
                    (Integer) rs.getObject("starts_today"),
                    rs.getTimestamp("reported_at").toInstant());
        } catch (java.sql.SQLException e) {
            throw new IllegalStateException(e);
        }
    }
}
