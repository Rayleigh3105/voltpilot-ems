package com.voltpilot.api.repo;

import com.voltpilot.api.consumers.HeizstabStufe;
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

    /**
     * One ingested consumer entity state. {@code stufe}/{@code reglerJson} are set only for a
     * heating rod switched in stages (Heizstab-Konzept V1, heizstab-shelly.md / heizstab-regler.md);
     * {@code stufeEnergieKwhHeute} is the assumed energy of the day the repository writes forward
     * from the previous heartbeat (HeizstabStufe#energieFortschreiben).
     */
    public record Row(UUID entityId, String state, String reasonCode, Double actualKw,
            Boolean confirmed, Integer runtimeSecondsToday, Integer startsToday,
            HeizstabStufe.Stufe stufe, java.math.BigDecimal stufeEnergieKwhHeute, String reglerJson) {

        /** Every consumer without stages - the shape before Heizstab V1. */
        public Row(UUID entityId, String state, String reasonCode, Double actualKw,
                Boolean confirmed, Integer runtimeSecondsToday, Integer startsToday) {
            this(entityId, state, reasonCode, actualKw, confirmed, runtimeSecondsToday, startsToday,
                    null, null, null);
        }

        Row mitEnergie(java.math.BigDecimal kwh) {
            return new Row(entityId, state, reasonCode, actualKw, confirmed, runtimeSecondsToday,
                    startsToday, stufe, kwh, reglerJson);
        }
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
                        + "runtime_seconds_today, starts_today, stufe_json::text AS stufe_json, "
                        + "stufe_energie_kwh_heute, heizstab_json::text AS heizstab_json",
                (rs, i) -> new Row(rs.getObject("entity_id", UUID.class), rs.getString("state"),
                        rs.getString("reason_code"), (Double) rs.getObject("actual_kw"),
                        (Boolean) rs.getObject("confirmed"),
                        (Integer) rs.getObject("runtime_seconds_today"),
                        (Integer) rs.getObject("starts_today"),
                        HeizstabStufe.ausJson(rs.getString("stufe_json")),
                        rs.getBigDecimal("stufe_energie_kwh_heute"), rs.getString("heizstab_json")),
                deviceId);
        java.util.Map<UUID, Row> vorher = new java.util.HashMap<>();
        previous.forEach(p -> vorher.put(p.entityId(), p));
        for (int i = 0; i < rows.size(); i++) {
            Row r = rows.get(i);
            if (r.stufe() != null) {
                // Heizstab V1: the assumed energy of the day, written forward from the previous
                // heartbeat - handed back IN PLACE so the ledger reads the same number.
                Row p = vorher.get(r.entityId());
                java.math.BigDecimal kwh = HeizstabStufe.energieFortschreiben(p == null ? null
                        : new HeizstabStufe.VorigeStufe(p.stufe(), p.runtimeSecondsToday(),
                                p.stufeEnergieKwhHeute()), r.runtimeSecondsToday(), r.stufe());
                r = r.mitEnergie(kwh);
                rows.set(i, r);
            }
            jdbc.update(
                    "INSERT INTO consumer_runtime_status (entity_id, tenant_id, site_id, device_id, "
                            + "state, reason_code, actual_kw, confirmed, runtime_seconds_today, "
                            + "starts_today, reported_at, updated_at, stufe_json, "
                            + "stufe_energie_kwh_heute, heizstab_json) "
                            + "VALUES (?, NULLIF(current_setting('app.tenant_id', true), '')::uuid, "
                            + "?, ?, ?, ?, ?, ?, ?, ?, ?, now(), ?::jsonb, ?, ?::jsonb) "
                            + "ON CONFLICT (entity_id) DO UPDATE SET "
                            + "site_id = EXCLUDED.site_id, device_id = EXCLUDED.device_id, "
                            + "state = EXCLUDED.state, reason_code = EXCLUDED.reason_code, "
                            + "actual_kw = EXCLUDED.actual_kw, confirmed = EXCLUDED.confirmed, "
                            + "runtime_seconds_today = EXCLUDED.runtime_seconds_today, "
                            + "starts_today = EXCLUDED.starts_today, "
                            + "reported_at = EXCLUDED.reported_at, updated_at = now(), "
                            + "stufe_json = EXCLUDED.stufe_json, "
                            + "stufe_energie_kwh_heute = EXCLUDED.stufe_energie_kwh_heute, "
                            + "heizstab_json = EXCLUDED.heizstab_json",
                    r.entityId(), siteId, deviceId, r.state(), r.reasonCode(), r.actualKw(),
                    r.confirmed(), r.runtimeSecondsToday(), r.startsToday(),
                    Timestamp.from(reportedAt), r.stufe() == null ? null : r.stufe().alsJson(),
                    r.stufeEnergieKwhHeute(), r.reglerJson());
        }
        return previous;
    }

    /**
     * The row was reported by a box that takes part in operation (UEMS AP-07 IP-11): the state an
     * ausgebaut box last reported stays stored, but it is no evidence of the consumer's state now.
     */
    private static final String BOX_AKTIV =
            "EXISTS (SELECT 1 FROM device d WHERE d.id = s.device_id AND d.ausgebaut_am IS NULL)";

    /** All reported consumer states of a site (empty = no evidence yet). */
    public List<ConsumerRuntimeStatusDto> listForSite(UUID siteId) {
        return jdbc.query(
                "SELECT entity_id, state, reason_code, actual_kw, confirmed, "
                        + "runtime_seconds_today, starts_today, reported_at, " + STUFE_SPALTEN
                        + " FROM consumer_runtime_status s WHERE s.site_id = ? AND " + BOX_AKTIV
                        + " ORDER BY entity_id",
                (rs, i) -> map(rs), siteId);
    }

    /** One entity's reported state, or empty (=> 204, "Zustand nicht bestätigt"). */
    public Optional<ConsumerRuntimeStatusDto> forEntity(UUID siteId, UUID entityId) {
        return jdbc.query(
                        "SELECT entity_id, state, reason_code, actual_kw, confirmed, "
                                + "runtime_seconds_today, starts_today, reported_at, " + STUFE_SPALTEN
                                + " FROM consumer_runtime_status s WHERE s.site_id = ? AND s.entity_id = ? AND "
                                + BOX_AKTIV,
                        (rs, i) -> map(rs), siteId, entityId)
                .stream().findFirst();
    }

    /** Heizstab V1: the stage, the controller verdict and the assumed energy of the day. */
    private static final String STUFE_SPALTEN =
            "stufe_json::text AS stufe_json, heizstab_json::text AS heizstab_json, stufe_energie_kwh_heute";

    private static final com.fasterxml.jackson.databind.ObjectMapper JSON =
            new com.fasterxml.jackson.databind.ObjectMapper();

    private static com.fasterxml.jackson.databind.JsonNode json(String raw) {
        if (raw == null) {
            return null;
        }
        try {
            return JSON.readTree(raw);
        } catch (Exception e) {
            return null;
        }
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
                    rs.getTimestamp("reported_at").toInstant(),
                    json(rs.getString("stufe_json")), json(rs.getString("heizstab_json")),
                    rs.getBigDecimal("stufe_energie_kwh_heute"));
        } catch (java.sql.SQLException e) {
            throw new IllegalStateException(e);
        }
    }
}
