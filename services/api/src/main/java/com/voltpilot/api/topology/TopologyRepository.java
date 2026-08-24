package com.voltpilot.api.topology;

import java.sql.PreparedStatement;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Queries backing the Anlagen-Topologie-Read-Model (AE1): the latest live value
 * per (entity, channel) from {@code telemetry_v2}, and the capability→role
 * assignment overrides. RLS-scoped like every customer repository (no tenant
 * predicate; the site_id predicate anchors the read to the caller-visible site).
 */
@Repository
public class TopologyRepository {

    /**
     * Latest sample of one entity channel: value + arrival time (liveness).
     * entityId is a String - telemetry_v2.entity_id is TEXT by contract (any
     * MQTT-topic-safe id; the registry UUID is the recommended form, not a
     * constraint), so it must NOT be read as a UUID.
     */
    public record LatestValue(String entityId, String channel, double value, Instant receivedAt) {}

    /** One stored capability→role override. */
    public record RoleOverride(UUID entityId, String capability, String role, boolean primary) {}

    /**
     * One backward probe per requested pair. {@code unnest} of the two
     * parallel arrays drives a nested loop; each iteration is an equality on
     * {@code (entity_id, channel)} plus {@code ORDER BY time DESC LIMIT 1},
     * i.e. exactly the {@code uq_telemetry_v2_entity_channel_time} prefix, and
     * TimescaleDB's ordered ChunkAppend stops at the newest chunk that holds a
     * row (the older ones read "never executed").
     */
    private static final String LATEST_VALUES =
            "SELECT k.entity_id, k.channel, x.value, x.received_at "
                    + "FROM unnest(?::text[], ?::text[]) AS k(entity_id, channel) "
                    + "CROSS JOIN LATERAL ("
                    + "  SELECT t.value, t.received_at FROM telemetry_v2 t"
                    + "  WHERE t.site_id = ? AND t.entity_id = k.entity_id"
                    + "    AND t.channel = k.channel"
                    + "  ORDER BY t.time DESC LIMIT 1) x";

    private final JdbcTemplate jdbc;

    public TopologyRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * One (entity, channel) pair the read-model actually consumes - the driver
     * of {@link #latestValues(UUID, List)}. entityId is a String for the same
     * reason {@link LatestValue} is: telemetry_v2.entity_id is TEXT by contract.
     */
    public record ChannelKey(String entityId, String channel) {}

    /**
     * The newest telemetry_v2 sample of each REQUESTED (entity, channel) pair of
     * a site. Uses received_at for liveness (the store-and-forward rule), value
     * for display.
     *
     * <p>The caller passes the pairs it will actually read (the registry's
     * {@code capabilities.measure[]} channels); every other pair present in
     * telemetry_v2 was fetched and DISCARDED by the old form, so asking only for
     * the consumed pairs is equivalent for the produced read-model - proven
     * against the old statement verbatim by
     * {@code HotReadRewriteEqualityTest} (the PriceSlots precedent).
     *
     * <p><b>Shape is load-bearing (measured, prod defect 2026-08-24).</b> The
     * former {@code SELECT DISTINCT ON (entity_id, channel) ... WHERE site_id = ?
     * ORDER BY entity_id, channel, time DESC} carried NO time bound and no
     * equality on the DISTINCT keys, so it read every row this site ever wrote
     * and sorted them: measured on a 5,1-Mio-row clone <b>14,6 s, external merge
     * sort 341 MB, 4.092.635 rows read - to return 5</b> (prod HAR: 6,7 s TTFB
     * for a 2,4-kB body). TimescaleDB 2.17 has no SkipScan for a MULTI-column
     * DISTINCT ON, so an index cannot rescue that form. Giving each pair its OWN
     * equality bound (the B4 per-site-LATERAL pattern, AGENTS.md
     * "Portal-Performance-Welle") turns it into one backward probe of the
     * EXISTING {@code uq_telemetry_v2_entity_channel_time (entity_id, channel,
     * time)} per pair, stopping at the newest chunk that holds a row:
     * <b>0,95 ms</b>, no new index, no write amplification on the hot ingest
     * path. A pair that never reported yields no row - {@code null} value, as
     * before.
     *
     * <p>The pairs travel as TWO parallel {@code text[]} arrays through
     * {@code unnest}, so the statement has THREE bind parameters whatever the
     * site's size: one fixed SQL string (the driver's statement cache works),
     * and no way to approach Postgres' 65535-parameter ceiling. A per-pair
     * {@code VALUES} list plans identically but would need a fresh string per
     * pair count.
     */
    public List<LatestValue> latestValues(UUID siteId, List<ChannelKey> keys) {
        if (keys == null || keys.isEmpty()) {
            return List.of();
        }
        String[] entityIds = keys.stream().map(ChannelKey::entityId).toArray(String[]::new);
        String[] channels = keys.stream().map(ChannelKey::channel).toArray(String[]::new);
        return jdbc.query(
                con -> {
                    PreparedStatement ps = con.prepareStatement(LATEST_VALUES);
                    ps.setArray(1, con.createArrayOf("text", entityIds));
                    ps.setArray(2, con.createArrayOf("text", channels));
                    ps.setObject(3, siteId);
                    return ps;
                },
                (rs, n) -> new LatestValue(
                        rs.getString("entity_id"),
                        rs.getString("channel"),
                        rs.getDouble("value"),
                        rs.getTimestamp("received_at").toInstant()));
    }

    /** The site's stored role overrides (empty for a defaults-only site). */
    public List<RoleOverride> overrides(UUID siteId) {
        return jdbc.query(
                "SELECT entity_id, capability, role, is_primary FROM entity_role_assignment "
                        + "WHERE site_id = ? ORDER BY entity_id, capability",
                (rs, n) -> new RoleOverride(
                        rs.getObject("entity_id", UUID.class),
                        rs.getString("capability"),
                        rs.getString("role"),
                        rs.getBoolean("is_primary")),
                siteId);
    }

    /** Upsert one capability's role override (re-assignment is idempotent). */
    public void upsertOverride(UUID tenantId, UUID siteId, UUID entityId, String capability,
            String role, boolean primary) {
        jdbc.update(
                "INSERT INTO entity_role_assignment "
                        + "(tenant_id, site_id, entity_id, capability, role, is_primary) "
                        + "VALUES (?, ?, ?, ?, ?, ?) "
                        + "ON CONFLICT (entity_id, capability) DO UPDATE SET "
                        + "role = EXCLUDED.role, is_primary = EXCLUDED.is_primary",
                tenantId, siteId, entityId, capability, role, primary);
    }

    /** Drop one capability's override (revert to the DefaultRole mapping). */
    public void deleteOverride(UUID siteId, UUID entityId, String capability) {
        jdbc.update(
                "DELETE FROM entity_role_assignment WHERE site_id = ? AND entity_id = ? "
                        + "AND capability = ?",
                siteId, entityId, capability);
    }
}
