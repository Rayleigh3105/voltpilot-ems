package com.voltpilot.api.repo;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.LinkedHashMap;
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
 * Der Welle-II-Nachzug für die zwei vergessenen Zwillinge (Scout
 * {@code vp-scale-readiness-p4} §3.2): {@link FleetMetricsRepository#lastPlanPerSite}
 * (alle 60 s im Metrik-Sammler) und {@link AdminFleetRepository#lastPlanPerSite} (je
 * Admin-Puls-Aufruf) trugen bis hierher die fleet-weite {@code GROUP BY site_id}-Form
 * auf dem NICHT-Partitionsschlüssel {@code generated_at} (gemessen <b>296 ms</b> auf
 * 10,3 Mio Zeilen), während ihr {@link OverviewRepository}-Zwilling seit Welle II die
 * per-Anlage-LATERAL fährt (<b>5 ms</b>, 59×). Dieser Test nagelt fest, dass die neue
 * Form auf identischem Seed GENAU dasselbe zurückgibt wie die alte - das
 * {@link HotReadRewriteEqualityTest}-Muster.
 *
 * <p>Die verworfene fleet-weite Anweisung steht VERBATIM als ORACLE und läuft gegen
 * ein echtes TimescaleDB, so pinnt der Test die Semantik der ERSETZTEN Form, nicht
 * eine Umschreibung davon (die {@link PriceSlotEqualityTest}-Präzedenz).
 *
 * <p>Anders als beim {@code OverviewRepository}-Zwilling wandert hier KEINE
 * RLS-Fence: beide Sammler laufen als BYPASSRLS-Rolle {@code voltpilot_admin} und
 * sehen die ganze Flotte über alle Mandanten. Der Test verbindet deshalb als
 * {@code voltpilot_admin} (ohne {@code app.tenant_id}) und beweist, dass beide
 * Mandanten in EINER Antwort erscheinen.
 *
 * <p>Auto-skips where Docker is unavailable ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
class FleetLastPlanRewriteEqualityTest {

    /** Die verworfene fleet-weite Anweisung, verbatim (beide Zwillinge teilten sie). */
    private static final String OLD_LAST_PLAN =
            "SELECT site_id, max(generated_at) AS last_run FROM schedule "
                    + "WHERE generated_at >= ? GROUP BY site_id";

    private static final UUID TENANT_A = UUID.fromString("aaaaaaaa-0000-0000-0000-000000000001");
    private static final UUID TENANT_B = UUID.fromString("bbbbbbbb-0000-0000-0000-000000000001");
    private static final UUID SITE_A1 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a1");
    private static final UUID SITE_A2 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a2");
    private static final UUID SITE_A3 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a3");
    private static final UUID SITE_B1 = UUID.fromString("bbbbbbbb-0000-0000-0000-0000000000b1");

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
            site(c, SITE_A3, TENANT_A, "A3");
            site(c, SITE_B1, TENANT_B, "B1");

            // A1: two runs in the window -> the NEWER one wins.
            plan(c, SITE_A1, TENANT_A, NOW.minusSeconds(3 * 86400), NOW.minusSeconds(3 * 86400));
            plan(c, SITE_A1, TENANT_A, NOW.minusSeconds(3600), NOW.minusSeconds(3600));
            // A2: only run is OLDER than the window -> absent from both forms.
            plan(c, SITE_A2, TENANT_A, NOW.minusSeconds(40 * 86400), NOW.minusSeconds(40 * 86400));
            // A3: no schedule row at all -> absent (the LATERAL emits a NULL
            //     last_run the extractor drops; the GROUP BY yields no row for it).
            // B1: a run in the window under ANOTHER tenant -> the BYPASSRLS admin
            //     role MUST see it (the whole point of the cross-tenant fleet twin).
            plan(c, SITE_B1, TENANT_B, NOW.minusSeconds(600), NOW.minusSeconds(600));
        }
    }

    @Test
    void fleetMetricsLastPlanMatchesTheRetiredFleetWideGroupBy() throws Exception {
        try (SingleConnectionDataSource ds = adminRole()) {
            Map<UUID, Instant> oracle = oracleLastPlan(ds, PLAN_WINDOW);
            Map<UUID, Instant> shipped =
                    new FleetMetricsRepository(new JdbcTemplate(ds)).lastPlanPerSite(PLAN_WINDOW);
            assertResults(shipped, oracle);
        }
    }

    @Test
    void adminFleetLastPlanMatchesTheRetiredFleetWideGroupBy() throws Exception {
        try (SingleConnectionDataSource ds = adminRole()) {
            Map<UUID, Instant> oracle = oracleLastPlan(ds, PLAN_WINDOW);
            Map<UUID, Instant> shipped =
                    new AdminFleetRepository(new JdbcTemplate(ds)).lastPlanPerSite(PLAN_WINDOW);
            assertResults(shipped, oracle);
        }
    }

    /**
     * Both twins are the SAME rewrite, so they must agree with each other on the
     * same connection - a single reference form, no drift between the two callers.
     */
    @Test
    void bothTwinsReturnTheIdenticalMap() throws Exception {
        try (SingleConnectionDataSource ds = adminRole()) {
            Map<UUID, Instant> metrics =
                    new FleetMetricsRepository(new JdbcTemplate(ds)).lastPlanPerSite(PLAN_WINDOW);
            Map<UUID, Instant> admin =
                    new AdminFleetRepository(new JdbcTemplate(ds)).lastPlanPerSite(PLAN_WINDOW);
            assertThat(metrics).isEqualTo(admin);
        }
    }

    private static void assertResults(Map<UUID, Instant> shipped, Map<UUID, Instant> oracle) {
        // Byte-identical to the retired fleet-wide GROUP BY on the same seed.
        assertThat(shipped).isEqualTo(oracle);
        // A1's NEWER in-window run wins; A2 (old run only) and A3 (no run) are
        // absent - the "kein aktueller Plan" contract, never a fabricated age.
        assertThat(shipped).containsOnlyKeys(SITE_A1, SITE_B1);
        assertThat(shipped.get(SITE_A1)).isEqualTo(NOW.minusSeconds(3600));
        assertThat(shipped).doesNotContainKey(SITE_A2);
        assertThat(shipped).doesNotContainKey(SITE_A3);
        // Cross-tenant: the BYPASSRLS admin role sees BOTH tenants in ONE answer
        // (the fleet twin is a platform-wide view, not tenant-scoped).
        assertThat(shipped.get(SITE_B1)).isEqualTo(NOW.minusSeconds(600));
    }

    // ---- helpers ------------------------------------------------------------

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

    private static DataSource superuser() {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(POSTGRES.getUsername());
        ds.setPassword(POSTGRES.getPassword());
        return ds;
    }

    /**
     * ONE connection as the BYPASSRLS {@code voltpilot_admin} role - exactly the
     * role both fleet collectors use ({@code @Qualifier("adminJdbcTemplate")}). No
     * {@code app.tenant_id}: BYPASSRLS ignores the policies entirely, so the whole
     * fleet is visible across tenants.
     */
    private static SingleConnectionDataSource adminRole() {
        return new SingleConnectionDataSource(
                POSTGRES.getJdbcUrl(), "voltpilot_admin", "pw_admin", true);
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
}
