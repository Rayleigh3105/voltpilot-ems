package com.voltpilot.api.topology;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.topology.TopologyRepository.ChannelKey;
import com.voltpilot.api.topology.TopologyRepository.LatestValue;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * The regression test of the 2026-09-09 cockpit outage: a DECLARED channel that
 * carries no current telemetry must be answered out of the newest chunks, not by
 * walking the site's whole retained history.
 *
 * <p>The defect, on the live site Pilsting/Herzogau: two of seven
 * (entity, channel) pairs were declared in the registry but silent (both Fronius
 * {@code pv_power_kw}). Each pair is one {@code ORDER BY time DESC LIMIT 1}
 * probe, and the 2026-08-24 rewrite bounded that probe on
 * {@code (site_id, entity_id, channel)} only - three predicates, none of them
 * the hypertable's partition column. A pair that HAS a row still stops at the
 * newest chunk holding one; a pair that has NONE has no such chunk and read
 * every chunk of the retained 90 days to return nothing. Measured:
 * {@code GET /api/v1/sites/{id}/topology} 4,5-14,4 s, past the cockpit's
 * {@code ANLAGE_DECISION_TIMEOUT_MS} = 10 s -> "Diese Anlage konnte gerade nicht
 * geladen werden". Same failure class as the form that rewrite replaced
 * (AGENTS.md "Portal-Performance-Welle II").
 *
 * <p>Both halves are pinned here, against a real TimescaleDB seeded across
 * several chunks:
 *
 * <ul>
 *   <li><b>Behaviour</b> - a silent pair and a long-stale pair yield NO row
 *       ({@code null} -&gt; health {@code never}), a reporting one is unchanged.</li>
 *   <li><b>Cost</b> - the shipped statement leaves the old chunks unexecuted,
 *       while the unbounded predecessor (copied in verbatim as the oracle) walks
 *       every one of them. Chunk execution is read off {@code EXPLAIN ANALYZE},
 *       so the assertion is a plan fact, not a stopwatch.</li>
 * </ul>
 *
 * <p>Auto-skips where Docker is unavailable ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
class TopologyLatestValueWindowTest {

    /**
     * The unbounded probe, verbatim as it shipped between 2026-08-24 and
     * 2026-09-09 - the oracle for BOTH halves: it proves what the old answer was
     * and that it cost every chunk to produce.
     */
    private static final String UNBOUNDED_LATEST_VALUES =
            "SELECT k.entity_id, k.channel, x.value, x.received_at "
                    + "FROM unnest(?::text[], ?::text[]) AS k(entity_id, channel) "
                    + "CROSS JOIN LATERAL ("
                    + "  SELECT t.value, t.received_at FROM telemetry_v2 t"
                    + "  WHERE t.site_id = ? AND t.entity_id = k.entity_id"
                    + "    AND t.channel = k.channel"
                    + "  ORDER BY t.time DESC LIMIT 1) x";

    private static final UUID TENANT = UUID.fromString("cccccccc-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("cccccccc-0000-0000-0000-0000000000a1");
    private static final UUID DEVICE = UUID.fromString("cccccccc-0000-0000-0000-0000000000d1");

    /** A hybrid inverter that reports - the pairs the cockpit actually draws. */
    private static final String E_REPORTING = "cccccccc-0000-0000-0000-0000000000e1";
    /** The Pilsting case: a Fronius whose declared pv_power_kw NEVER arrived. */
    private static final String E_SILENT = "cccccccc-0000-0000-0000-0000000000e2";
    /** The second shape of the same case: it reported once, 40 days ago. */
    private static final String E_STALE = "cccccccc-0000-0000-0000-0000000000e3";

    /** Days of history seeded - well past TimescaleDB's 7-day chunk interval. */
    private static final int HISTORY_DAYS = 40;

    private static Instant now;
    private static Instant cutoff;
    /** Every chunk of telemetry_v2, oldest first (read from the catalog). */
    private static List<String> chunks;

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @BeforeAll
    static void migrateAndSeed() throws Exception {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of(
                        "appDbUser", "voltpilot_app", "appDbPassword", "pw_app",
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "pw_admin"))
                .load()
                .migrate();

        // Real time: chunks are cut from the wall clock, and the shipped call
        // derives its floor from it too.
        now = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        cutoff = now.minus(TopologyRepository.LATEST_VALUE_LOOKBACK);

        try (Connection c = superuser().getConnection()) {
            tenant(c);
            site(c);
            device(c);
            // A reporting pair across the whole history: it is what forces the
            // chunks into existence, so an unbounded probe HAS something to walk.
            for (int d = HISTORY_DAYS; d >= 1; d--) {
                v2(c, E_REPORTING, "power_kw", now.minus(d, ChronoUnit.DAYS), 100.0 + d);
            }
            // ...and its CURRENT sample, the one the cockpit draws.
            v2(c, E_REPORTING, "power_kw", now.minusSeconds(60), 42.0);
            // The defect's two shapes: declared, but nothing current to show.
            //   E_SILENT|pv_power_kw - no row at all, anywhere.
            v2(c, E_STALE, "pv_power_kw", now.minus(HISTORY_DAYS, ChronoUnit.DAYS), 5.0);
            chunks = chunkNamesOldestFirst(c);
        }
        // A one-chunk history could not tell the two forms apart.
        assertThat(chunks).as("seeded chunks of telemetry_v2").hasSizeGreaterThan(2);
    }

    // ---- behaviour ----------------------------------------------------------

    /**
     * The read-model answer: a declared channel without current telemetry is
     * {@code null} (rendered "keine Daten" / health {@code never}), never a
     * days-old number worn as the present one - and the reporting neighbour on
     * the SAME probe is untouched.
     */
    @Test
    void aDeclaredChannelWithoutCurrentTelemetryYieldsNoRow() throws Exception {
        try (SingleConnectionDataSource ds = appRole()) {
            Map<String, Double> values = shipped(ds, List.of(
                    new ChannelKey(E_REPORTING, "power_kw"),
                    new ChannelKey(E_SILENT, "pv_power_kw"),
                    new ChannelKey(E_STALE, "pv_power_kw")));

            assertThat(values.get(E_REPORTING + "|power_kw")).isEqualTo(42.0);
            assertThat(values).doesNotContainKey(E_SILENT + "|pv_power_kw");
            assertThat(values).doesNotContainKey(E_STALE + "|pv_power_kw");

            // The retired form answered the stale pair with its 40-day-old
            // number; dropping it is the deliberate half of the fix.
            assertThat(unbounded(ds, E_STALE, "pv_power_kw")).isEqualTo(5.0);
            assertThat(unbounded(ds, E_SILENT, "pv_power_kw")).isNull();
        }
    }

    // ---- cost ---------------------------------------------------------------

    /**
     * The actual defect: the silent pair must not drag the probe through the
     * history. Read off {@code EXPLAIN ANALYZE} rather than a clock, so it is
     * deterministic - the unbounded oracle executes EVERY chunk (it has no
     * reason to stop), the shipped form only the ones the floor admits.
     */
    @Test
    void theSilentPairNoLongerWalksTheWholeHistory() throws Exception {
        try (SingleConnectionDataSource ds = appRole()) {
            Set<String> old = executedChunks(ds, UNBOUNDED_LATEST_VALUES, null,
                    E_SILENT, "pv_power_kw");
            Set<String> bounded = executedChunks(ds, TopologyRepository.LATEST_VALUES, cutoff,
                    E_SILENT, "pv_power_kw");

            assertThat(old).as("unbounded probe of a silent pair")
                    .containsExactlyInAnyOrderElementsOf(chunks);
            // The 3-day floor spans at most two 7-day chunks, and never the
            // oldest one - that is the whole fix.
            assertThat(bounded).as("bounded probe of a silent pair").hasSizeLessThanOrEqualTo(2);
            assertThat(bounded).doesNotContain(chunks.get(0));
            assertThat(bounded).hasSizeLessThan(old.size());
        }
    }

    /**
     * The form itself, so the floor cannot be dropped or turned into a per-pair
     * string: the bound sits on {@code time} (the PARTITION column - a bound on
     * anything else limits the result, not the chunks read) and travels as a
     * BIND parameter, keeping the statement at four parameters whatever the
     * site's size (fixed SQL string, statement cache, no path towards Postgres'
     * 65535-parameter ceiling).
     */
    @Test
    void theFloorIsBoundOnThePartitionColumnAndStaysOneFixedStatement() {
        assertThat(TopologyRepository.LATEST_VALUES).contains("t.time >= ?");
        assertThat(TopologyRepository.LATEST_VALUES.chars().filter(ch -> ch == '?').count())
                .as("bind parameters, independent of the pair count")
                .isEqualTo(4);
    }

    // ---- helpers ------------------------------------------------------------

    private static Map<String, Double> shipped(DataSource ds, List<ChannelKey> keys) {
        Map<String, Double> m = new LinkedHashMap<>();
        for (LatestValue v : new TopologyRepository(new JdbcTemplate(ds))
                .latestValues(SITE, keys, cutoff)) {
            m.put(v.entityId() + "|" + v.channel(), v.value());
        }
        return m;
    }

    /** The retired statement's answer for one pair ({@code null} = no row). */
    private static Double unbounded(DataSource ds, String entity, String channel)
            throws Exception {
        try (Connection c = ds.getConnection();
                PreparedStatement ps = c.prepareStatement(UNBOUNDED_LATEST_VALUES)) {
            bind(c, ps, entity, channel, null);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? rs.getDouble("value") : null;
            }
        }
    }

    /**
     * The telemetry_v2 chunks the plan actually RAN for one pair. TimescaleDB
     * drops an excluded chunk from the plan entirely (plan-time) or prints it
     * "(never executed)" (startup-time); both count as not walked.
     */
    private static Set<String> executedChunks(DataSource ds, String sql, Instant floor,
            String entity, String channel) throws Exception {
        List<String> plan = new ArrayList<>();
        try (Connection c = ds.getConnection();
                PreparedStatement ps = c.prepareStatement(
                        "EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) " + sql)) {
            bind(c, ps, entity, channel, floor);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    plan.add(rs.getString(1));
                }
            }
        }
        Set<String> executed = new LinkedHashSet<>();
        for (String chunk : chunks) {
            for (String line : plan) {
                if (line.contains(chunk) && !line.contains("never executed")) {
                    executed.add(chunk);
                    break;
                }
            }
        }
        return executed;
    }

    private static void bind(Connection c, PreparedStatement ps, String entity, String channel,
            Instant floor) throws Exception {
        ps.setArray(1, c.createArrayOf("text", new String[] {entity}));
        ps.setArray(2, c.createArrayOf("text", new String[] {channel}));
        ps.setObject(3, SITE);
        if (floor != null) {
            ps.setTimestamp(4, Timestamp.from(floor));
        }
    }

    private static List<String> chunkNamesOldestFirst(Connection c) throws Exception {
        List<String> names = new ArrayList<>();
        try (PreparedStatement ps = c.prepareStatement(
                "SELECT chunk_name FROM timescaledb_information.chunks "
                        + "WHERE hypertable_name = 'telemetry_v2' ORDER BY range_start");
                ResultSet rs = ps.executeQuery()) {
            while (rs.next()) {
                names.add(rs.getString(1));
            }
        }
        return names;
    }

    private static DataSource superuser() {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(POSTGRES.getUsername());
        ds.setPassword(POSTGRES.getPassword());
        return ds;
    }

    /** ONE connection as the RLS-scoped app role with the session tenant set. */
    private static SingleConnectionDataSource appRole() throws Exception {
        SingleConnectionDataSource ds = new SingleConnectionDataSource(
                POSTGRES.getJdbcUrl(), "voltpilot_app", "pw_app", true);
        try (PreparedStatement ps = ds.getConnection()
                .prepareStatement("SELECT set_config('app.tenant_id', ?, false)")) {
            ps.setString(1, TENANT.toString());
            ps.execute();
        }
        return ds;
    }

    private static void tenant(Connection c) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO tenant (id, name) VALUES (?, 'Window') ON CONFLICT DO NOTHING")) {
            ps.setObject(1, TENANT);
            ps.execute();
        }
    }

    private static void site(Connection c) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO site (id, tenant_id, name, bidding_zone) "
                        + "VALUES (?, ?, 'Pilsting-like', 'DE-LU')")) {
            ps.setObject(1, SITE);
            ps.setObject(2, TENANT);
            ps.execute();
        }
    }

    private static void device(Connection c) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO device (id, tenant_id, site_id, external_ref, kind) "
                        + "VALUES (?, ?, ?, 'ref-window', 'inverter')")) {
            ps.setObject(1, DEVICE);
            ps.setObject(2, TENANT);
            ps.setObject(3, SITE);
            ps.execute();
        }
    }

    private static void v2(Connection c, String entity, String channel, Instant time, double value)
            throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO telemetry_v2 (time, received_at, tenant_id, site_id, device_id, "
                        + "entity_id, channel, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")) {
            ps.setTimestamp(1, Timestamp.from(time));
            ps.setTimestamp(2, Timestamp.from(time));
            ps.setObject(3, TENANT);
            ps.setObject(4, SITE);
            ps.setObject(5, DEVICE);
            ps.setString(6, entity);
            ps.setString(7, channel);
            ps.setDouble(8, value);
            ps.execute();
        }
    }
}
