package com.voltpilot.api.repo;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.topology.TopologyRepository;
import com.voltpilot.api.topology.TopologyRepository.ChannelKey;
import com.voltpilot.api.topology.TopologyRepository.LatestValue;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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
 * The acceptance criterion of the 2026-08-24 hot-read rewrite: three statements
 * that read a large hypertable WITHOUT an equality bound the planner could use
 * were reshaped into per-site / per-pair probes, and each must return EXACTLY
 * what the statement it replaced returned - including where both return nothing
 * and including the RLS fence.
 *
 * <p>Each retired statement is spelled out VERBATIM below and runs as the
 * ORACLE against a real TimescaleDB, so this test pins the semantics of the
 * form that was replaced, not a paraphrase of it (the {@link PriceSlotEqualityTest}
 * precedent). The three:
 *
 * <ul>
 *   <li>{@link TopologyRepository#latestValues(UUID, List)} - was one
 *       {@code DISTINCT ON (entity_id, channel)} over the site's whole
 *       telemetry_v2 history (14,6 s / 341 MB external sort on a 5,1-Mio-row
 *       clone, to return 5 rows).</li>
 *   <li>{@link OverviewRepository#lastPlanPerSite(Instant)} - was a fleet-wide
 *       {@code GROUP BY site_id} bounded only on {@code generated_at}, which is
 *       NOT schedule's partition column (335 ms).</li>
 *   <li>The {@code latest_run} CTE of {@code EarningsRepository.expectedMarketValue}
 *       - was a fleet-wide {@code GROUP BY} over forecast with no bound on its
 *       partition column at all (161 ms).</li>
 * </ul>
 *
 * <p>Everything runs on ONE connection as the RLS-scoped app role with
 * {@code app.tenant_id} set, so the fence is live: two of the three rewrites
 * MOVE which table carries the tenant policy (schedule -&gt; site, the
 * forecast join -&gt; site), and a fence that silently widened would be a
 * tenant leak, not a perf win.
 *
 * <p>Auto-skips where Docker is unavailable ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
class HotReadRewriteEqualityTest {

    /** The retired topology read, verbatim. */
    private static final String OLD_LATEST_VALUES =
            "SELECT DISTINCT ON (entity_id, channel) entity_id, channel, value, received_at "
                    + "FROM telemetry_v2 WHERE site_id = ? "
                    + "ORDER BY entity_id, channel, time DESC";

    /** The retired last-plan read, verbatim. */
    private static final String OLD_LAST_PLAN =
            "SELECT site_id, max(generated_at) AS last_run FROM schedule "
                    + "WHERE generated_at >= ? GROUP BY site_id";

    /** The retired latest_run CTE body, verbatim. */
    private static final String OLD_LATEST_RUN =
            "SELECT f.site_id, max(f.run_at) AS run_at "
                    + "FROM forecast f JOIN site s ON s.id = f.site_id "
                    + "WHERE f.kind = 'pv' AND f.model = ? GROUP BY f.site_id";

    /** The shipped latest_run CTE body, verbatim (EarningsRepository). */
    private static final String NEW_LATEST_RUN =
            "SELECT s.id AS site_id, x.run_at FROM site s "
                    + "JOIN LATERAL (SELECT max(f.run_at) AS run_at FROM forecast f "
                    + "  WHERE f.site_id = s.id AND f.kind = 'pv' AND f.model = ?) x ON true";

    private static final UUID TENANT_A = UUID.fromString("aaaaaaaa-0000-0000-0000-000000000001");
    private static final UUID TENANT_B = UUID.fromString("bbbbbbbb-0000-0000-0000-000000000001");
    private static final UUID SITE_A1 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a1");
    private static final UUID SITE_A2 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a2");
    private static final UUID SITE_B1 = UUID.fromString("bbbbbbbb-0000-0000-0000-0000000000b1");
    private static final UUID DEV_A1 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000d1");
    private static final UUID DEV_A2 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000d2");
    private static final UUID DEV_B1 = UUID.fromString("bbbbbbbb-0000-0000-0000-0000000000d1");

    /** The registry pairs of SITE_A1 - exactly what the read-model consumes. */
    private static final String E1 = "aaaaaaaa-0000-0000-0000-0000000000e1";
    private static final String E2 = "aaaaaaaa-0000-0000-0000-0000000000e2";
    private static final List<ChannelKey> KEYS_A1 = List.of(
            new ChannelKey(E1, "soc_pct"),
            new ChannelKey(E1, "battery_power_kw"),
            new ChannelKey(E1, "pv_power_kw"),
            new ChannelKey(E2, "power_kw"));

    private static final Instant NOW = Instant.parse("2026-06-01T12:00:00Z");
    private static final Instant PLAN_WINDOW = NOW.minusSeconds(7 * 86400);

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

        try (Connection c = superuser().getConnection()) {
            tenant(c, TENANT_A, "Tenant A");
            tenant(c, TENANT_B, "Tenant B");
            site(c, SITE_A1, TENANT_A, "A1");
            site(c, SITE_A2, TENANT_A, "A2");
            site(c, SITE_B1, TENANT_B, "B1");
            device(c, DEV_A1, TENANT_A, SITE_A1);
            device(c, DEV_A2, TENANT_A, SITE_A2);
            device(c, DEV_B1, TENANT_B, SITE_B1);

            // --- telemetry_v2: one constellation per row of the read-model ---
            // (a) several samples across several days -> the NEWEST time wins.
            v2(c, SITE_A1, DEV_A1, TENANT_A, E1, "soc_pct", NOW.minusSeconds(20 * 86400), 11);
            v2(c, SITE_A1, DEV_A1, TENANT_A, E1, "soc_pct", NOW.minusSeconds(5 * 86400), 22);
            v2(c, SITE_A1, DEV_A1, TENANT_A, E1, "soc_pct", NOW.minusSeconds(60), 33);
            // (b) exactly ONE sample, and an OLD one - must still be found
            //     (the probe walks back chunk by chunk).
            v2(c, SITE_A1, DEV_A1, TENANT_A, E1, "battery_power_kw",
                    NOW.minusSeconds(30 * 86400), 44);
            // (c) a registry channel that NEVER reported -> no row, value null.
            //     (pv_power_kw deliberately gets nothing.)
            // (d) received_at deliberately != time (store-and-forward replay):
            //     the newest TIME wins, and its own received_at is reported.
            v2(c, SITE_A1, DEV_A1, TENANT_A, E2, "power_kw", NOW.minusSeconds(3 * 86400),
                    NOW.minusSeconds(120), 55);
            v2(c, SITE_A1, DEV_A1, TENANT_A, E2, "power_kw", NOW.minusSeconds(90),
                    NOW.minusSeconds(30), 66);
            // (e) a pair present in telemetry_v2 but NOT in the registry: the old
            //     form fetched it, the read-model DISCARDED it. It must not
            //     change anything - and its value is the NEWEST of the site, so
            //     an off-by-one in the key filter would surface loudly.
            v2(c, SITE_A1, DEV_A1, TENANT_A, E1, "ghost_channel", NOW, 999);
            // (f) the SAME entity+channel under ANOTHER site, NEWER: the site_id
            //     predicate must still fence it out (regression guard for
            //     keeping site_id in the probe).
            v2(c, SITE_A2, DEV_A2, TENANT_A, E1, "soc_pct", NOW.plusSeconds(3600), 777);
            // (g) another tenant entirely -> RLS must hide it.
            v2(c, SITE_B1, DEV_B1, TENANT_B, E1, "soc_pct", NOW.plusSeconds(7200), 888);

            // --- schedule: lastPlanPerSite ---
            plan(c, SITE_A1, TENANT_A, NOW.minusSeconds(3 * 86400), NOW.minusSeconds(3 * 86400));
            plan(c, SITE_A1, TENANT_A, NOW.minusSeconds(3600), NOW.minusSeconds(3600));
            // A2's only run is OLDER than the window -> absent from both forms.
            plan(c, SITE_A2, TENANT_A, NOW.minusSeconds(40 * 86400), NOW.minusSeconds(40 * 86400));
            plan(c, SITE_B1, TENANT_B, NOW.minusSeconds(600), NOW.minusSeconds(600));

            // --- forecast: the latest_run CTE ---
            fc(c, SITE_A1, TENANT_A, "pv", "pv-physical", NOW.minusSeconds(7200));
            fc(c, SITE_A1, TENANT_A, "pv", "pv-physical", NOW.minusSeconds(900));
            fc(c, SITE_A1, TENANT_A, "pv", "pv-residual-xgb", NOW);       // other model
            fc(c, SITE_A1, TENANT_A, "load", "pv-physical", NOW);          // other kind
            fc(c, SITE_A2, TENANT_A, "pv", "pv-physical", NOW.minusSeconds(30 * 86400));
            fc(c, SITE_B1, TENANT_B, "pv", "pv-physical", NOW);
        }
    }

    // ---- topology -----------------------------------------------------------

    @Test
    void latestValuesPerPairMatchTheRetiredDistinctOnForEveryRegistryChannel() throws Exception {
        try (SingleConnectionDataSource ds = appRole(TENANT_A)) {
            Map<String, Row> oracle = oracleLatestValues(ds, SITE_A1);
            Map<String, Row> shipped = shippedLatestValues(ds, SITE_A1, KEYS_A1);

            // Every pair the read-model consumes: identical value AND received_at.
            for (ChannelKey k : KEYS_A1) {
                String key = k.entityId() + "|" + k.channel();
                assertThat(shipped.get(key)).as("pair %s", key).isEqualTo(oracle.get(key));
            }
            // (a) newest sample wins, (b) a lone old sample is still found,
            // (c) a never-reported channel yields NOTHING (null, not zero).
            assertThat(shipped.get(E1 + "|soc_pct").value()).isEqualTo(33.0);
            assertThat(shipped.get(E1 + "|battery_power_kw").value()).isEqualTo(44.0);
            assertThat(shipped).doesNotContainKey(E1 + "|pv_power_kw");
            assertThat(oracle).doesNotContainKey(E1 + "|pv_power_kw");
            // (d) the newest TIME wins and reports ITS received_at, not max(received_at).
            assertThat(shipped.get(E2 + "|power_kw").value()).isEqualTo(66.0);
            assertThat(shipped.get(E2 + "|power_kw").receivedAt())
                    .isEqualTo(NOW.minusSeconds(30));
            // (e) the un-consumed pair: the retired form fetched it, the new one
            //     does not - and it cannot change the read-model either way.
            assertThat(oracle).containsKey(E1 + "|ghost_channel");
            assertThat(shipped).doesNotContainKey(E1 + "|ghost_channel");
            assertThat(shipped.keySet())
                    .containsExactlyInAnyOrderElementsOf(
                            oracle.keySet().stream()
                                    .filter(k -> KEYS_A1.stream()
                                            .anyMatch(c -> (c.entityId() + "|" + c.channel())
                                                    .equals(k)))
                                    .toList());
        }
    }

    @Test
    void latestValuesStayFencedToTheirSiteAndTenant() throws Exception {
        try (SingleConnectionDataSource ds = appRole(TENANT_A)) {
            // (f) A2 holds a NEWER row for the same entity+channel - A1 must not see it.
            assertThat(shippedLatestValues(ds, SITE_A1, KEYS_A1).get(E1 + "|soc_pct").value())
                    .isEqualTo(33.0);
            assertThat(shippedLatestValues(ds, SITE_A2, KEYS_A1).get(E1 + "|soc_pct").value())
                    .isEqualTo(777.0);
        }
        try (SingleConnectionDataSource ds = appRole(TENANT_B)) {
            // (g) RLS: tenant B sees nothing of A1 - through the new form AND the old.
            assertThat(shippedLatestValues(ds, SITE_A1, KEYS_A1)).isEmpty();
            assertThat(oracleLatestValues(ds, SITE_A1)).isEmpty();
        }
    }

    @Test
    void anEmptyKeyListAsksTheDatabaseNothing() throws Exception {
        try (SingleConnectionDataSource ds = appRole(TENANT_A)) {
            TopologyRepository repo = new TopologyRepository(new JdbcTemplate(ds));
            assertThat(repo.latestValues(SITE_A1, List.of())).isEmpty();
            assertThat(repo.latestValues(SITE_A1, null)).isEmpty();
        }
    }

    // ---- overview -----------------------------------------------------------

    @Test
    void lastPlanPerSiteMatchesTheRetiredFleetWideGroupBy() throws Exception {
        try (SingleConnectionDataSource ds = appRole(TENANT_A)) {
            Map<UUID, Instant> oracle = oracleLastPlan(ds, PLAN_WINDOW);
            Map<UUID, Instant> shipped =
                    new OverviewRepository(new JdbcTemplate(ds)).lastPlanPerSite(PLAN_WINDOW);

            assertThat(shipped).isEqualTo(oracle);
            assertThat(shipped).containsOnlyKeys(SITE_A1);
            assertThat(shipped.get(SITE_A1)).isEqualTo(NOW.minusSeconds(3600));
            // A site whose only run is older than the window stays ABSENT (the
            // "kein aktueller Plan" contract), never a fabricated age.
            assertThat(shipped).doesNotContainKey(SITE_A2);
            // The fence moved from schedule to site - tenant B must stay hidden.
            assertThat(shipped).doesNotContainKey(SITE_B1);
        }
        try (SingleConnectionDataSource ds = appRole(TENANT_B)) {
            assertThat(new OverviewRepository(new JdbcTemplate(ds)).lastPlanPerSite(PLAN_WINDOW))
                    .containsOnlyKeys(SITE_B1)
                    .isEqualTo(oracleLastPlan(ds, PLAN_WINDOW));
        }
    }

    // ---- earnings -----------------------------------------------------------

    @Test
    void latestRunCteMatchesTheRetiredFleetWideGroupBy() throws Exception {
        for (UUID tenant : List.of(TENANT_A, TENANT_B)) {
            try (SingleConnectionDataSource ds = appRole(tenant)) {
                Map<UUID, Instant> oracle = runMap(ds, OLD_LATEST_RUN, "pv-physical");
                Map<UUID, Instant> shipped = runMap(ds, NEW_LATEST_RUN, "pv-physical");
                // The new form emits a row per site (NULL run_at where there is
                // none); the CTE's consumer joins on run_at, so a NULL row can
                // never match a forecast row. Compare the non-null answers.
                shipped.values().removeIf(java.util.Objects::isNull);
                assertThat(shipped).as("tenant %s", tenant).isEqualTo(oracle);
            }
        }
        try (SingleConnectionDataSource ds = appRole(TENANT_A)) {
            Map<UUID, Instant> shipped = runMap(ds, NEW_LATEST_RUN, "pv-physical");
            // Newest run of the ASKED model/kind only - a newer row of another
            // model (pv-residual-xgb) or another kind (load) must not win.
            assertThat(shipped.get(SITE_A1)).isEqualTo(NOW.minusSeconds(900));
            assertThat(shipped.get(SITE_A2)).isEqualTo(NOW.minusSeconds(30 * 86400));
            // forecast carries no RLS of its own - `site` is the whole fence.
            assertThat(shipped).doesNotContainKey(SITE_B1);
        }
    }

    // ---- helpers ------------------------------------------------------------

    private record Row(double value, Instant receivedAt) {}

    private static Map<String, Row> shippedLatestValues(DataSource ds, UUID site,
            List<ChannelKey> keys) {
        Map<String, Row> m = new LinkedHashMap<>();
        for (LatestValue v : new TopologyRepository(new JdbcTemplate(ds)).latestValues(site, keys)) {
            m.put(v.entityId() + "|" + v.channel(), new Row(v.value(), v.receivedAt()));
        }
        return m;
    }

    private static Map<String, Row> oracleLatestValues(DataSource ds, UUID site) throws Exception {
        Map<String, Row> m = new LinkedHashMap<>();
        try (Connection c = ds.getConnection();
                PreparedStatement ps = c.prepareStatement(OLD_LATEST_VALUES)) {
            ps.setObject(1, site);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    m.put(rs.getString("entity_id") + "|" + rs.getString("channel"),
                            new Row(rs.getDouble("value"),
                                    rs.getTimestamp("received_at").toInstant()));
                }
            }
        }
        return m;
    }

    private static Map<UUID, Instant> oracleLastPlan(DataSource ds, Instant from) throws Exception {
        Map<UUID, Instant> m = new LinkedHashMap<>();
        try (Connection c = ds.getConnection();
                PreparedStatement ps = c.prepareStatement(OLD_LAST_PLAN)) {
            ps.setTimestamp(1, Timestamp.from(from));
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    Timestamp t = rs.getTimestamp("last_run");
                    if (t != null) {
                        m.put(rs.getObject("site_id", UUID.class), t.toInstant());
                    }
                }
            }
        }
        return m;
    }

    private static Map<UUID, Instant> runMap(DataSource ds, String sql, String model)
            throws Exception {
        Map<UUID, Instant> m = new LinkedHashMap<>();
        try (Connection c = ds.getConnection(); PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, model);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    Timestamp t = rs.getTimestamp("run_at");
                    m.put(rs.getObject("site_id", UUID.class), t == null ? null : t.toInstant());
                }
            }
        }
        return m;
    }

    private static DataSource superuser() {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(POSTGRES.getUsername());
        ds.setPassword(POSTGRES.getPassword());
        return ds;
    }

    /**
     * ONE connection as the RLS-scoped app role with the session tenant set, so
     * every statement of a test shares the {@code app.tenant_id} the policies
     * read (a pooled DataSource would hand out a connection without it).
     */
    private static SingleConnectionDataSource appRole(UUID tenant) throws Exception {
        SingleConnectionDataSource ds = new SingleConnectionDataSource(
                POSTGRES.getJdbcUrl(), "voltpilot_app", "pw_app", true);
        try (PreparedStatement ps = ds.getConnection()
                .prepareStatement("SELECT set_config('app.tenant_id', ?, false)")) {
            ps.setString(1, tenant.toString());
            ps.execute();
        }
        return ds;
    }

    private static void tenant(Connection c, UUID id, String name) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO tenant (id, name) VALUES (?, ?) ON CONFLICT DO NOTHING")) {
            ps.setObject(1, id);
            ps.setString(2, name);
            ps.execute();
        }
    }

    private static void site(Connection c, UUID id, UUID tenant, String name) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, ?, 'DE-LU')")) {
            ps.setObject(1, id);
            ps.setObject(2, tenant);
            ps.setString(3, name);
            ps.execute();
        }
    }

    private static void device(Connection c, UUID id, UUID tenant, UUID site) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO device (id, tenant_id, site_id, external_ref, kind) "
                        + "VALUES (?, ?, ?, ?, 'inverter')")) {
            ps.setObject(1, id);
            ps.setObject(2, tenant);
            ps.setObject(3, site);
            ps.setString(4, "ref-" + id);
            ps.execute();
        }
    }

    private static void v2(Connection c, UUID site, UUID device, UUID tenant, String entity,
            String channel, Instant time, double value) throws Exception {
        v2(c, site, device, tenant, entity, channel, time, time, value);
    }

    private static void v2(Connection c, UUID site, UUID device, UUID tenant, String entity,
            String channel, Instant time, Instant receivedAt, double value) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO telemetry_v2 (time, received_at, tenant_id, site_id, device_id, "
                        + "entity_id, channel, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")) {
            ps.setTimestamp(1, Timestamp.from(time));
            ps.setTimestamp(2, Timestamp.from(receivedAt));
            ps.setObject(3, tenant);
            ps.setObject(4, site);
            ps.setObject(5, device);
            ps.setString(6, entity);
            ps.setString(7, channel);
            ps.setDouble(8, value);
            ps.execute();
        }
    }

    private static void plan(Connection c, UUID site, UUID tenant, Instant generatedAt,
            Instant time) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO schedule (time, tenant_id, site_id, plan_id, generated_at, "
                        + "battery_kw) VALUES (?, ?, ?, gen_random_uuid(), ?, 0)")) {
            ps.setTimestamp(1, Timestamp.from(time));
            ps.setObject(2, tenant);
            ps.setObject(3, site);
            ps.setTimestamp(4, Timestamp.from(generatedAt));
            ps.execute();
        }
    }

    private static void fc(Connection c, UUID site, UUID tenant, String kind, String model,
            Instant runAt) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO forecast (time, tenant_id, site_id, kind, model, value_kw, run_at, "
                        + "horizon_min, method) VALUES (?, ?, ?, ?, ?, 1.0, ?, 15, 'test')")) {
            ps.setTimestamp(1, Timestamp.from(runAt.plusSeconds(900)));
            ps.setObject(2, tenant);
            ps.setObject(3, site);
            ps.setString(4, kind);
            ps.setString(5, model);
            ps.setTimestamp(6, Timestamp.from(runAt));
            ps.execute();
        }
    }
}
