package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Proves the Datenhaltung Phase-1 data-retention & compression policies
 * (migration {@code V20260809000000}) land correctly after the api Flyway run
 * against a real TimescaleDB, and - the important half - proves the tables that
 * must stay untouched carry NO policy:
 *
 * <ul>
 *   <li>{@code forecast} (no RLS) is compression-enabled and carries BOTH a
 *       compression and a retention background job.</li>
 *   <li>{@code weather_forecast} and {@code schedule} (RLS) each carry a
 *       retention job (compression is blocked on RLS tables and is never
 *       attempted).</li>
 *   <li>{@code telemetry_v2} (the MIG-B1 fan-out mirror, RLS) carries a 90-day
 *       retention job and nothing else - captain decision 2026-08-31,
 *       migration {@code V20260831020000}, revising the stale p12-k6 exclusion.</li>
 *   <li>Regression guard: {@code telemetry} (the raw ML corpus, captain
 *       decision 2026-08-09) and the reporting-backbone rollups
 *       {@code telemetry_rollup_15m/1h/1d} AND {@code telemetry_v2_rollup_*}
 *       carry NO retention or compression policy at all.</li>
 *   <li>OCPP protocol/status/auth/meter hypertables carry 90-day retention
 *       jobs, while the daily sensitive-data job purges transactionData and
 *       masked local-auth references from stopped transactions.</li>
 *   <li>The UEMS event table {@code messreihe_ereignis} (AP-07 IP-8, migration
 *       {@code V20260911260000}) is NEVER deleted - no job of any kind, no
 *       compression (RLS, E7); only tenant offboarding clears it.</li>
 * </ul>
 *
 * <p>Runs the real {@code db/migration} chain as the Flyway superuser on the
 * exact prod image, so it also serves as the "the migration applies cleanly on a
 * fresh DB" proof. Auto-skips where Docker is unavailable
 * ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
class DataRetentionPolicyTest {

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @BeforeAll
    static void migrate() {
        // Prod-safe core chain only (the policies live in db/migration); no dev
        // seed needed. Fresh DB -> the migration must apply cleanly end to end.
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(java.util.Map.of(
                        "appDbUser", "voltpilot_app", "appDbPassword", "voltpilot_app_test_pw",
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "voltpilot_admin_test_pw"))
                .load()
                .migrate();
    }

    @Test
    void forecastIsCompressedWithCompressionAndRetentionPolicies() throws Exception {
        // forecast is NON-RLS, so native compression is available (the only
        // compressible growing table). It must carry BOTH policies.
        assertThat(compressionEnabled("forecast")).as("forecast compression enabled").isTrue();
        assertThat(hasJob("policy_compression", "forecast"))
                .as("forecast compression policy").isTrue();
        assertThat(hasJob("policy_retention", "forecast"))
                .as("forecast retention policy").isTrue();
    }

    @Test
    void rlsTablesGetRetentionOnlyNeverCompression() throws Exception {
        // weather_forecast + schedule are RLS/FORCE -> compression is blocked;
        // retention is the available lever and must be present.
        assertThat(hasJob("policy_retention", "weather_forecast"))
                .as("weather_forecast retention policy").isTrue();
        assertThat(hasJob("policy_retention", "schedule"))
                .as("schedule retention policy").isTrue();

        // ...and compression must NOT have been (attempted or) enabled on them.
        assertThat(compressionEnabled("weather_forecast"))
                .as("weather_forecast NOT compressed").isFalse();
        assertThat(compressionEnabled("schedule")).as("schedule NOT compressed").isFalse();
        assertThat(hasJob("policy_compression", "weather_forecast")).isFalse();
        assertThat(hasJob("policy_compression", "schedule")).isFalse();
    }

    @Test
    void theEventTableIsNeverDeletedNorCompressed() throws Exception {
        // AP-07 §4.3: events are kept forever (unclaim, purge and site deletion
        // leave them; offboarding is the one way out) - so NO background job at
        // all on the hypertable, and never compression (RLS/FORCE, decision E7).
        assertThat(hasJob("policy_retention", "messreihe_ereignis"))
                .as("messreihe_ereignis must have NO retention policy").isFalse();
        assertThat(hasJob("policy_compression", "messreihe_ereignis"))
                .as("messreihe_ereignis must have NO compression policy").isFalse();
        assertThat(compressionEnabled("messreihe_ereignis"))
                .as("messreihe_ereignis must NOT be compression-enabled").isFalse();
        try (Connection c = admin();
                PreparedStatement ps = c.prepareStatement("SELECT count(*) FROM "
                        + "timescaledb_information.jobs WHERE hypertable_name = 'messreihe_ereignis'")) {
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                assertThat(rs.getLong(1)).as("no job of any kind").isZero();
            }
        }
    }

    /**
     * AP-07 IP-12 (Entscheid E6/E7): die Speicherklasse Viertelstundenwerte behält JEDE Reihe
     * ZEHN JAHRE - Retention genau 3 653 Tage, und keine Kompression, weil sie RLS/FORCE ist.
     * Das Kompressions-LAYOUT ist trotzdem festgelegt und abrufbar, damit ein späterer Umbau
     * (E7-B, nach der Messung aus IP-16) die Daten nicht wandern lassen muss.
     */
    @Test
    void theQuarterHourClassKeepsTenYearsWithoutCompressionButWithAPreparedLayout() throws Exception {
        assertThat(hasJob("policy_retention", "messreihe_viertelstunde"))
                .as("messreihe_viertelstunde retention policy").isTrue();
        assertThat(hasRetentionOf("messreihe_viertelstunde", 3653))
                .as("messreihe_viertelstunde retention is exactly 3653 days (ten years)").isTrue();
        assertThat(hasJob("policy_compression", "messreihe_viertelstunde"))
                .as("messreihe_viertelstunde must have NO compression policy").isFalse();
        assertThat(compressionEnabled("messreihe_viertelstunde"))
                .as("messreihe_viertelstunde must NOT be compression-enabled (RLS/FORCE, E7)").isFalse();

        try (Connection c = admin();
                PreparedStatement ps = c.prepareStatement(
                        "SELECT segmentby, orderby FROM messreihe_viertelstunde_kompression_layout()");
                ResultSet rs = ps.executeQuery()) {
            assertThat(rs.next()).as("the prepared layout is retrievable").isTrue();
            assertThat(rs.getString("segmentby")).isEqualTo("tenant_id, entity_id, messkanal");
            assertThat(rs.getString("orderby")).isEqualTo("intervall_beginn DESC");
        }

        // Die Arbeitsliste und der Laufzustand sind keine Hypertables - sie tragen also weder
        // Retention noch Kompression, und das soll auch so bleiben.
        for (String table : new String[] {
                "messreihe_viertelstunde_arbeit", "messreihe_viertelstunde_lauf"}) {
            try (Connection c = admin();
                    PreparedStatement ps = c.prepareStatement("SELECT count(*) FROM "
                            + "timescaledb_information.hypertables WHERE hypertable_name = ?")) {
                ps.setString(1, table);
                try (ResultSet rs = ps.executeQuery()) {
                    rs.next();
                    assertThat(rs.getLong(1)).as(table + " is a plain table").isZero();
                }
            }
        }
    }

    /**
     * Der Rohwert bleibt bei seinen 90 Tagen: die Viertelstundenklasse tritt NEBEN ihn, nicht an
     * seine Stelle (§4.3). Fiele diese Zusicherung, verlöre A2 seinen Sinn.
     */
    @Test
    void theRawClassKeepsItsNinetyDays() throws Exception {
        assertThat(hasRetentionOf("device_measurement_sample", 90))
                .as("device_measurement_sample retention is still exactly 90 days").isTrue();
        assertThat(compressionEnabled("device_measurement_sample"))
                .as("device_measurement_sample must NOT be compression-enabled").isFalse();
    }

    @Test
    void rawTelemetryAndTheRollupsAreNeverTouched() throws Exception {
        // The regression heart: the raw v1 ML corpus and the permanent reporting
        // backbones (v1 AND v2 rollups) must keep growing untouched. The v2
        // rollups are deliberately kept FOREVER even though telemetry_v2 itself
        // now carries a 90-day retention (captain decision 2026-08-31) - see
        // telemetryV2GetsA90DayRetentionWhileItsRollupsStayForever.
        for (String table : new String[] {
                "telemetry", "telemetry_rollup_15m", "telemetry_rollup_1h", "telemetry_rollup_1d",
                "telemetry_v2_rollup_15m", "telemetry_v2_rollup_1h", "telemetry_v2_rollup_1d"}) {
            assertThat(hasJob("policy_retention", table))
                    .as(table + " must have NO retention policy").isFalse();
            assertThat(hasJob("policy_compression", table))
                    .as(table + " must have NO compression policy").isFalse();
            assertThat(compressionEnabled(table))
                    .as(table + " must NOT be compression-enabled").isFalse();
        }
    }

    @Test
    void telemetryV2GetsA90DayRetentionWhileItsRollupsStayForever() throws Exception {
        // Captain decision 2026-08-31 (scout vp-scale-readiness-p4 §2.1/§7.6):
        // the MIG-B1 fan-out made telemetry_v2 the single largest unbounded
        // storage driver (~3,9 GB/year/plant), so migration V20260831020000
        // caps it at exactly ONE 90-day retention. It is RLS/FORCE, so
        // compression stays blocked and is never attempted.
        assertThat(hasJob("policy_retention", "telemetry_v2"))
                .as("telemetry_v2 retention policy").isTrue();
        assertThat(hasRetentionOf("telemetry_v2", 90))
                .as("telemetry_v2 retention is exactly 90 days").isTrue();
        assertThat(hasJob("policy_compression", "telemetry_v2"))
                .as("telemetry_v2 must have NO compression policy").isFalse();
        assertThat(compressionEnabled("telemetry_v2"))
                .as("telemetry_v2 must NOT be compression-enabled").isFalse();
        // The v2 reporting backbone stays forever (guarded in full by
        // rawTelemetryAndTheRollupsAreNeverTouched).
        assertThat(hasJob("policy_retention", "telemetry_v2_rollup_15m"))
                .as("telemetry_v2_rollup_15m must have NO retention policy").isFalse();
    }

    @Test
    void ocppRawDataGetsRetentionOnlyAndSensitiveTransactionDataIsPurged() throws Exception {
        for (String table : new String[] {
                "ocpp_protocol_event",
                "ocpp_connector_status_event",
                "ocpp_authorization_event",
                "ocpp_meter_sample",
                "ocpp_station_status_event"
        }) {
            assertThat(hasJob("policy_retention", table))
                    .as(table + " retention policy").isTrue();
            assertThat(hasJob("policy_compression", table))
                    .as(table + " must have NO compression policy").isFalse();
            assertThat(compressionEnabled(table))
                    .as(table + " must NOT be compression-enabled").isFalse();
        }
        assertThat(hasProcedureJob("ocpp_sensitive_retention"))
                .as("daily OCPP transaction-data purge job").isTrue();

        try (Connection c = admin()) {
            try (PreparedStatement master = c.prepareStatement("""
                    INSERT INTO tenant (id, name) VALUES
                      ('41000000-0000-0000-0000-000000000002', 'Retention Tenant');
                    INSERT INTO site (id, tenant_id, name) VALUES
                      ('41000000-0000-0000-0000-000000000003',
                       '41000000-0000-0000-0000-000000000002', 'Retention Site');
                    INSERT INTO device (id, tenant_id, site_id, external_ref, status) VALUES
                      ('41000000-0000-0000-0000-000000000001',
                       '41000000-0000-0000-0000-000000000002',
                       '41000000-0000-0000-0000-000000000003', 'retention-device', 'claimed')
                    """)) {
                master.execute();
            }
            try (PreparedStatement insert = c.prepareStatement("""
                        INSERT INTO ocpp_transaction (
                          device_id, charge_point_id, transaction_id, tenant_id, site_id,
                          connector_id, started_at, stopped_at, meter_start, meter_stop,
                          start_id_tag_ref, stop_id_tag_ref, parent_id_tag_ref,
                          transaction_data, updated_at
                        ) VALUES
                        (
                          '41000000-0000-0000-0000-000000000001', 'CP-RETENTION', 1,
                          '41000000-0000-0000-0000-000000000002',
                          '41000000-0000-0000-0000-000000000003', 1,
                          now() - interval '100 days', now() - interval '99 days', 10, 20,
                          'tagref:start', 'tagref:stop', 'tagref:parent',
                          '[{"timestamp":"old","sampledValue":[]}]'::jsonb, now()
                        ),
                        (
                          '41000000-0000-0000-0000-000000000001', 'CP-RETENTION-OPEN', 2,
                          '41000000-0000-0000-0000-000000000002',
                          '41000000-0000-0000-0000-000000000003', 1,
                          now() - interval '100 days', NULL, 10, NULL,
                          'tagref:open-start', NULL, 'tagref:open-parent',
                          '[{"timestamp":"abandoned","sampledValue":[]}]'::jsonb,
                          now() - interval '99 days'
                        ),
                        (
                          '41000000-0000-0000-0000-000000000001', 'CP-RETENTION-ACTIVE', 3,
                          '41000000-0000-0000-0000-000000000002',
                          '41000000-0000-0000-0000-000000000003', 1,
                          now() - interval '100 days', NULL, 10, NULL,
                          'tagref:active-start', NULL, 'tagref:active-parent',
                          '[{"timestamp":"recent","sampledValue":[]}]'::jsonb, now()
                        )
                        """)) {
                insert.executeUpdate();
            }
            try (PreparedStatement purge = c.prepareStatement(
                    "CALL ocpp_sensitive_retention(0, '{}'::jsonb)")) {
                purge.execute();
            }
        }

        try (Connection c = admin();
                PreparedStatement ps = c.prepareStatement("""
                        SELECT transaction_data, start_id_tag_ref, stop_id_tag_ref,
                               parent_id_tag_ref, transaction_data_purged_at
                          FROM ocpp_transaction
                         WHERE charge_point_id IN ('CP-RETENTION', 'CP-RETENTION-OPEN')
                         ORDER BY charge_point_id
                        """)) {
            try (ResultSet rs = ps.executeQuery()) {
                int rows = 0;
                while (rs.next()) {
                    rows++;
                    assertThat(rs.getString("transaction_data")).isEqualTo("[]");
                    assertThat(rs.getString("start_id_tag_ref")).isNull();
                    assertThat(rs.getString("stop_id_tag_ref")).isNull();
                    assertThat(rs.getString("parent_id_tag_ref")).isNull();
                    assertThat(rs.getTimestamp("transaction_data_purged_at")).isNotNull();
                }
                assertThat(rows).isEqualTo(2);
            }
        }
        try (Connection c = admin();
                PreparedStatement ps = c.prepareStatement("""
                        SELECT transaction_data, start_id_tag_ref, transaction_data_purged_at
                          FROM ocpp_transaction
                         WHERE charge_point_id = 'CP-RETENTION-ACTIVE'
                        """)) {
            try (ResultSet rs = ps.executeQuery()) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getString("transaction_data")).contains("recent");
                assertThat(rs.getString("start_id_tag_ref")).isEqualTo("tagref:active-start");
                assertThat(rs.getTimestamp("transaction_data_purged_at")).isNull();
            }
        }
    }

    private boolean hasJob(String procName, String hypertable) throws Exception {
        try (Connection c = admin();
                PreparedStatement ps = c.prepareStatement(
                        "SELECT count(*) FROM timescaledb_information.jobs "
                                + "WHERE proc_name = ? AND hypertable_name = ?")) {
            ps.setString(1, procName);
            ps.setString(2, hypertable);
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getLong(1) > 0;
            }
        }
    }

    /** True iff the hypertable carries a retention job dropping chunks after exactly {@code days}. */
    private boolean hasRetentionOf(String hypertable, int days) throws Exception {
        try (Connection c = admin();
                PreparedStatement ps = c.prepareStatement(
                        "SELECT count(*) FROM timescaledb_information.jobs "
                                + "WHERE proc_name = 'policy_retention' AND hypertable_name = ? "
                                + "AND (config->>'drop_after')::interval = make_interval(days => ?)")) {
            ps.setString(1, hypertable);
            ps.setInt(2, days);
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getLong(1) > 0;
            }
        }
    }

    private boolean compressionEnabled(String hypertable) throws Exception {
        try (Connection c = admin();
                PreparedStatement ps = c.prepareStatement(
                        "SELECT compression_enabled FROM timescaledb_information.hypertables "
                                + "WHERE hypertable_name = ?")) {
            ps.setString(1, hypertable);
            try (ResultSet rs = ps.executeQuery()) {
                assertThat(rs.next()).as(hypertable + " is a hypertable").isTrue();
                return rs.getBoolean(1);
            }
        }
    }

    private boolean hasProcedureJob(String procName) throws Exception {
        try (Connection c = admin();
                PreparedStatement ps = c.prepareStatement(
                        "SELECT count(*) FROM timescaledb_information.jobs "
                                + "WHERE proc_schema = 'public' AND proc_name = ?")) {
            ps.setString(1, procName);
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getLong(1) > 0;
            }
        }
    }

    private Connection admin() throws Exception {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(POSTGRES.getUsername());
        ds.setPassword(POSTGRES.getPassword());
        return ds.getConnection();
    }
}
