package com.voltpilot.api.topology;

import java.sql.PreparedStatement;
import java.sql.Timestamp;
import java.time.Duration;
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
     * How far back one probe may walk - the FLOOR under the backward search,
     * on {@code time}, the hypertable's OWN partition column, so chunks older
     * than this are excluded instead of read (prod defect 2026-09-09, see
     * {@link #latestValues(UUID, List, Instant)}).
     *
     * <p>Deliberately generous against every real display need: the read-model
     * calls a value FRESH for {@code TopologyService.LIVENESS_WINDOW} = 5 min,
     * so everything this window still admits was already rendered "stale". Three
     * days is 864x that window and survives a long box outage plus a weekend;
     * a channel silent for LONGER reports {@code null} -&gt; health {@code never}
     * ("keine Daten"), never a multi-day-old number worn as the current one.
     */
    public static final Duration LATEST_VALUE_LOOKBACK = Duration.ofDays(3);

    /**
     * One backward probe per requested pair. {@code unnest} of the two
     * parallel arrays drives a nested loop; each iteration is an equality on
     * {@code (entity_id, channel)} plus {@code ORDER BY time DESC LIMIT 1},
     * i.e. exactly the {@code uq_telemetry_v2_entity_channel_time} prefix, and
     * TimescaleDB's ordered ChunkAppend stops at the newest chunk that holds a
     * row (the older ones read "never executed").
     *
     * <p>{@code t.time >= ?} is the FLOOR that makes "stops" true for a pair
     * that holds NO row at all - without it that probe has no reason to stop and
     * walks the site's whole retained history (see
     * {@link #latestValues(UUID, List, Instant)}).
     */
    // Package-private (not private) on purpose: TopologyLatestValueWindowTest
    // asserts the FORM of the statement that actually ships - a copy would only
    // prove the copy.
    static final String LATEST_VALUES =
            "SELECT k.entity_id, k.channel, x.value, x.received_at "
                    + "FROM unnest(?::text[], ?::text[]) AS k(entity_id, channel) "
                    + "CROSS JOIN LATERAL ("
                    + "  SELECT t.value, t.received_at FROM telemetry_v2 t"
                    + "  WHERE t.site_id = ? AND t.entity_id = k.entity_id"
                    + "    AND t.channel = k.channel AND t.time >= ?"
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
     * <p><b>And the probe needs a FLOOR (measured, prod defect 2026-09-09).</b>
     * "Stops at the newest chunk that holds a row" is only true for a pair that
     * HAS a row. A DECLARED channel that never reported - Pilsting/Herzogau ran
     * with two of seven pairs like that, both Fronius {@code pv_power_kw} - has
     * no such chunk, so the probe found no reason to stop and walked the site's
     * whole retained history backwards to return nothing. Measured on the live
     * site: {@code GET /sites/{id}/topology} <b>4,5-14,4 s</b> (cold above 10 s),
     * which tripped the cockpit's {@code ANLAGE_DECISION_TIMEOUT_MS} = 10 s and
     * showed the customer "Diese Anlage konnte gerade nicht geladen werden".
     * Same failure class as the form this replaced (AGENTS.md
     * "Portal-Performance-Welle II": a bound that is NOT on the partition column
     * bounds the RESULT, not the chunks read) - the LATERAL rewrite fixed the
     * pairs that DO report and left the ones that do not unbounded.
     * {@link #LATEST_VALUE_LOOKBACK} is that missing bound, and it sits on
     * {@code time}, the partition column, so an empty pair is answered out of
     * the newest chunks alone.
     *
     * <p>The read-model is UNCHANGED for every pair that reported inside the
     * window - byte-identical value and received_at, proven against the retired
     * statement by {@code HotReadRewriteEqualityTest}. Outside it the answer
     * moves from a days-old number to {@code null} (health {@code never}) ON
     * PURPOSE: liveness is 5 min, so such a number was never current, and the
     * house rule is null over an invented value.
     *
     * <p>The pairs travel as TWO parallel {@code text[]} arrays through
     * {@code unnest}, so the statement has FOUR bind parameters whatever the
     * site's size: one fixed SQL string (the driver's statement cache works),
     * and no way to approach Postgres' 65535-parameter ceiling. A per-pair
     * {@code VALUES} list plans identically but would need a fresh string per
     * pair count.
     */
    public List<LatestValue> latestValues(UUID siteId, List<ChannelKey> keys) {
        return latestValues(siteId, keys, Instant.now().minus(LATEST_VALUE_LOOKBACK));
    }

    /**
     * {@link #latestValues(UUID, List)} with the freshness floor spelled out -
     * the seam the window's tests bind, so they pin the cutoff instead of racing
     * the wall clock. Production always passes
     * {@code now - }{@link #LATEST_VALUE_LOOKBACK}.
     *
     * @param notBefore oldest {@code time} a probe may return; a pair whose
     *     newest sample is older yields NO row (value {@code null}).
     */
    public List<LatestValue> latestValues(UUID siteId, List<ChannelKey> keys, Instant notBefore) {
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
                    ps.setTimestamp(4, Timestamp.from(notBefore));
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
