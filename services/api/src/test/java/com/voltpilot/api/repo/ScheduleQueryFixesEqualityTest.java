package com.voltpilot.api.repo;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.web.dto.SchedulePlanDto;
import com.voltpilot.api.web.dto.ScheduleSlotDto;
import com.voltpilot.api.optimizer.OptimizerProperties;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
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
 * Acceptance of the 2026-11-04 schedule query fixes (scout
 * vp-anlagen-cockpit-perf, B2/B3): the reads must return EXACTLY what the forms
 * they replaced returned, on a hypertable that carries many versions per slot
 * (one optimizer run every 15 minutes, 192 slots each - the real shape).
 *
 * <ul>
 *   <li>{@link ScheduleRepository#latestForSite} gained a time window around
 *       the run stamp; the retired form had none.</li>
 *   <li>{@link EarningsRepository#planSlots} dropped {@code site_id} from its
 *       {@code DISTINCT ON} when ONE site is asked for; the fleet form (site
 *       == null) keeps both columns.</li>
 *   <li>The role setting of V20261104100000 reaches new app-role sessions.</li>
 * </ul>
 *
 * <p>Each retired statement is spelled out verbatim below and runs as the
 * ORACLE against a real TimescaleDB as the RLS-scoped app role (fence live).
 * Auto-skips where Docker is unavailable.
 */
@Testcontainers(disabledWithoutDocker = true)
class ScheduleQueryFixesEqualityTest {

    /** The retired slot read of latestForSite, verbatim (no time window). */
    private static final String OLD_LATEST_SLOTS =
            "SELECT time, battery_kw, plan_id FROM schedule "
                    + "WHERE site_id = ? AND generated_at = ? ORDER BY time ASC";

    /** The retired planSlots body, verbatim (two distinct columns). */
    private static final String OLD_PLAN_SLOTS =
            "SELECT site_id, time, pv_kw, load_kw, baseline_cost_eur, cost_eur,"
                    + " stur_cost_eur IS NOT NULL AS messlatte"
                    + " FROM ("
                    + "  SELECT DISTINCT ON (site_id, time) site_id, time, pv_kw, load_kw,"
                    + "    baseline_cost_eur, cost_eur, stur_cost_eur"
                    + "  FROM schedule WHERE time >= ? AND time < ?"
                    + "  AND site_id = ?"
                    + "  ORDER BY site_id, time, generated_at DESC) s "
                    + "WHERE baseline_cost_eur IS NOT NULL AND cost_eur IS NOT NULL "
                    + "ORDER BY site_id, time";

    private static final UUID TENANT_A = UUID.fromString("aaaaaaaa-0000-0000-0000-000000000002");
    private static final UUID TENANT_B = UUID.fromString("bbbbbbbb-0000-0000-0000-000000000002");
    private static final UUID SITE_A1 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a1");
    private static final UUID SITE_A2 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a2");
    private static final UUID SITE_B1 = UUID.fromString("bbbbbbbb-0000-0000-0000-0000000000b1");

    /** First run of the fixture; runs follow every 15 minutes. */
    private static final Instant T0 = Instant.parse("2026-10-01T00:00:00Z");
    private static final int RUNS = 12;
    private static final int HORIZON_SLOTS = 192;

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
            for (UUID[] s : new UUID[][] {
                    {SITE_A1, TENANT_A}, {SITE_A2, TENANT_A}, {SITE_B1, TENANT_B}}) {
                for (int run = 0; run < RUNS; run++) {
                    Instant generatedAt = T0.plusSeconds(run * 900L);
                    // Each run starts at its own stamp and plans 48 h ahead, like
                    // the optimizer; slot values differ per run so a wrong
                    // version would show.
                    for (int i = 0; i < HORIZON_SLOTS; i++) {
                        slot(c, s[0], s[1], generatedAt, generatedAt.plusSeconds(i * 900L),
                                run * 1000 + i);
                    }
                }
            }
            // The NEWEST version of one slot has no costs: planSlots must drop the
            // slot, not fall back to an older version that still has them.
            nullCostSlot(c, SITE_A1, TENANT_A, T0.plusSeconds((RUNS - 1) * 900L),
                    T0.plusSeconds(13 * 900L));
        }
    }

    @Test
    void latestForSiteReturnsTheNewestRunExactlyAsTheRetiredFormDid() throws Exception {
        Instant newest = T0.plusSeconds((RUNS - 1) * 900L);
        try (SingleConnectionDataSource ds = appRole(TENANT_A)) {
            JdbcTemplate jdbc = new JdbcTemplate(ds);
            SchedulePlanDto plan = new ScheduleRepository(jdbc).latestForSite(SITE_A1);

            List<Object[]> oracle = jdbc.query(OLD_LATEST_SLOTS,
                    (rs, i) -> new Object[] {
                            rs.getTimestamp("time").toInstant(),
                            rs.getBigDecimal("battery_kw"),
                            rs.getObject("plan_id", UUID.class)},
                    SITE_A1, Timestamp.from(newest));

            assertThat(plan).isNotNull();
            assertThat(plan.generatedAt()).isEqualTo(newest);
            // Every slot of the 48 h horizon, none cut off at either end.
            assertThat(plan.slots()).hasSize(HORIZON_SLOTS).hasSameSizeAs(oracle);
            for (int i = 0; i < oracle.size(); i++) {
                ScheduleSlotDto slot = plan.slots().get(i);
                assertThat(slot.start()).isEqualTo(oracle.get(i)[0]);
                assertThat(slot.batteryKw()).isEqualByComparingTo((BigDecimal) oracle.get(i)[1]);
            }
            // The plan meta comes from the same run (not a stale version).
            assertThat(plan.planId()).isEqualTo(oracle.get(0)[2]);
            assertThat(plan.slots().get(0).batteryKw())
                    .isEqualByComparingTo(BigDecimal.valueOf((RUNS - 1) * 1000));
        }
    }

    @Test
    void latestForSiteStaysFencedToItsTenantAndSite() throws Exception {
        try (SingleConnectionDataSource ds = appRole(TENANT_B)) {
            // RLS: tenant B sees nothing of A1 - old and new form alike.
            assertThat(new ScheduleRepository(new JdbcTemplate(ds)).latestForSite(SITE_A1))
                    .isNull();
        }
    }

    @Test
    void theWindowConstantCoversTheOptimizerHorizonInConfigPy() throws Exception {
        Path config = Path.of("..", "optimization", "voltpilot_optimization", "config.py");
        Matcher m = Pattern.compile("(?m)^DEFAULT_HORIZON_SLOTS\\s*=\\s*(\\d+)")
                .matcher(Files.readString(config));
        assertThat(m.find()).as("DEFAULT_HORIZON_SLOTS in config.py").isTrue();
        long horizonHours = Long.parseLong(m.group(1)) * 15 / 60;
        // A longer horizon without raising the window would cut the plan's tail.
        assertThat((long) ScheduleRepository.PLAN_HORIZON_HOURS)
                .as("PLAN_HORIZON_HOURS must cover the optimizer horizon")
                .isGreaterThanOrEqualTo(horizonHours);
    }

    @Test
    void planSlotsForOneSiteEqualsTheTwoColumnFormAndFleetFormStillGroupsBySite()
            throws Exception {
        Instant from = T0;
        Instant to = T0.plusSeconds(4 * 3600L);
        try (SingleConnectionDataSource ds = appRole(TENANT_A)) {
            JdbcTemplate jdbc = new JdbcTemplate(ds);
            EarningsRepository earnings = new EarningsRepository(
                    jdbc, new OptimizerProperties(4.0, 0.3, null, null, false));

            List<PlanMesslatte.Slot> oracle = jdbc.query(OLD_PLAN_SLOTS,
                    (rs, i) -> new PlanMesslatte.Slot(
                            rs.getTimestamp("time").toInstant(),
                            rs.getBigDecimal("pv_kw"),
                            rs.getBigDecimal("load_kw"),
                            rs.getBigDecimal("baseline_cost_eur"),
                            rs.getBigDecimal("cost_eur"),
                            rs.getBoolean("messlatte")),
                    Timestamp.from(from), Timestamp.from(to), SITE_A1);
            Map<UUID, List<PlanMesslatte.Slot>> single = earnings.planSlots(from, to, SITE_A1);

            assertThat(oracle).hasSize(15); // 16 quarter hours, one without costs
            assertThat(single).containsOnlyKeys(SITE_A1);
            assertThat(single.get(SITE_A1)).isEqualTo(oracle);
            // Newest run wins per slot: slot i of the first hour comes from the
            // run stamped at the same quarter hour (index 0 of that run).
            assertThat(single.get(SITE_A1).get(1).costEur())
                    .isEqualByComparingTo(BigDecimal.valueOf(1000));

            // Fleet form (site == null): both of the tenant's sites, nothing of B.
            Map<UUID, List<PlanMesslatte.Slot>> fleet = earnings.planSlots(from, to, null);
            assertThat(fleet).containsOnlyKeys(SITE_A1, SITE_A2);
            assertThat(fleet.get(SITE_A1)).isEqualTo(oracle);
            assertThat(fleet.get(SITE_A2)).hasSize(16); // A2 has no cost-less slot
        }
    }

    @Test
    void theAppRoleGetsCustomPlansFromItsRoleSetting() throws Exception {
        try (SingleConnectionDataSource ds = appRole(TENANT_A)) {
            assertThat(new JdbcTemplate(ds).queryForObject(
                    "SHOW plan_cache_mode", String.class)).isEqualTo("force_custom_plan");
        }
    }

    // ---- fixtures -----------------------------------------------------------

    private static DataSource superuser() {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(POSTGRES.getUsername());
        ds.setPassword(POSTGRES.getPassword());
        return ds;
    }

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

    /** One plan slot; {@code value} lands in battery_kw and cost_eur (run*1000+index). */
    private static void slot(Connection c, UUID site, UUID tenant, Instant generatedAt,
            Instant time, int value) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO schedule (time, tenant_id, site_id, plan_id, generated_at, "
                        + "battery_kw, pv_kw, load_kw, baseline_cost_eur, cost_eur) "
                        + "VALUES (?, ?, ?, ?, ?, ?, 1, 2, ?, ?)")) {
            ps.setTimestamp(1, Timestamp.from(time));
            ps.setObject(2, tenant);
            ps.setObject(3, site);
            ps.setObject(4, UUID.nameUUIDFromBytes(
                    (site + "|" + generatedAt).getBytes()));
            ps.setTimestamp(5, Timestamp.from(generatedAt));
            ps.setBigDecimal(6, BigDecimal.valueOf(value));
            ps.setBigDecimal(7, BigDecimal.valueOf(value + 1));
            ps.setBigDecimal(8, BigDecimal.valueOf(value));
            ps.execute();
        }
    }

    /** A newest-run slot without costs (both columns null). */
    private static void nullCostSlot(Connection c, UUID site, UUID tenant, Instant generatedAt,
            Instant time) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "UPDATE schedule SET baseline_cost_eur = NULL, cost_eur = NULL "
                        + "WHERE site_id = ? AND generated_at = ? AND time = ?")) {
            ps.setObject(1, site);
            ps.setTimestamp(2, Timestamp.from(generatedAt));
            ps.setTimestamp(3, Timestamp.from(time));
            ps.execute();
        }
    }
}
