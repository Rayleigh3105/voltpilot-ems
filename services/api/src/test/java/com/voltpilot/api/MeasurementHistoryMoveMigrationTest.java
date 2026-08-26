package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Map;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Upgrade regression for preview databases which already applied the original
 * PR510 V48/V49 schema. V50 must remove the live-site coupling without changing
 * either applied checksum, and historical samples/events/rollups must retain
 * their site when the stable device moves.
 */
@Testcontainers(disabledWithoutDocker = true)
class MeasurementHistoryMoveMigrationTest {

    private static final String TENANT = "20000000-0000-0000-0000-000000000001";
    private static final String SOURCE = "20000000-0000-0000-0000-000000000002";
    private static final String TARGET = "20000000-0000-0000-0000-000000000003";
    private static final String DEVICE = "20000000-0000-0000-0000-000000000004";
    private static final String POINT = "upgrade.move.point";
    private static final String COUNTER_POINT = "upgrade.move.counter";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Test
    void v49PreviewSchemaUpgradesWithoutChecksumDriftAndPreservesMoveHistory() throws Exception {
        flyway().target("20260849000000").load().migrate();
        execute("INSERT INTO tenant(id,name) VALUES ('" + TENANT + "','Upgrade tenant')");
        execute("INSERT INTO site(id,tenant_id,name) VALUES "
                + "('" + SOURCE + "','" + TENANT + "','Source'),"
                + "('" + TARGET + "','" + TENANT + "','Target')");
        execute("INSERT INTO device(id,tenant_id,site_id,external_ref,status) VALUES "
                + "('" + DEVICE + "','" + TENANT + "','" + SOURCE + "','upgrade-move','online')");
        execute("INSERT INTO device_measurement_sample (time,received_at,tenant_id,site_id,device_id,"
                + "point_key,raw_text,quality,catalog_version,edge_sequence,aggregation_kind,long_term_cadence_s) "
                + "VALUES ('2026-08-24T10:00:00Z','2026-08-24T10:00:00Z','" + TENANT + "','"
                + SOURCE + "','" + DEVICE + "','" + POINT
                + "','9007199254740993','good','upgrade',1,'gauge',300)");
        execute("INSERT INTO device_measurement_event (occurred_at,tenant_id,site_id,device_id,point_key,"
                + "event_kind,value_text,catalog_version,edge_sequence) VALUES "
                + "('2026-08-24T10:00:00Z','" + TENANT + "','" + SOURCE + "','" + DEVICE + "','"
                + POINT + "','state_change','before-move','upgrade',1)");
        execute("INSERT INTO device_measurement_sample (time,received_at,tenant_id,site_id,device_id,"
                + "point_key,raw_numeric,quality,catalog_version,edge_sequence,aggregation_kind,long_term_cadence_s) "
                + "VALUES ('2026-08-24T10:00:10Z','2026-08-24T10:00:10Z','" + TENANT + "','"
                + SOURCE + "','" + DEVICE + "','" + COUNTER_POINT
                + "',100,'good','upgrade',3,'counter',300)");

        assertThatThrownBy(() -> execute("UPDATE device SET site_id='" + TARGET
                + "', revision=revision+1 WHERE id='" + DEVICE + "'"))
                .isInstanceOfSatisfying(SQLException.class,
                        error -> assertThat(error.getSQLState()).isEqualTo("23503"));

        // Applies only V50. Flyway validates the already-recorded V48/V49
        // checksums before doing so; any retroactive edit makes this fail.
        flyway().load().migrate();
        execute("UPDATE device SET site_id='" + TARGET + "', revision=revision+1 WHERE id='" + DEVICE + "'");

        assertThat(text("SELECT site_id::text FROM device_measurement_sample WHERE device_id='"
                + DEVICE + "' AND edge_sequence=1")).isEqualTo(SOURCE);
        assertThat(text("SELECT site_id::text FROM device_measurement_event WHERE device_id='"
                + DEVICE + "' AND edge_sequence=1")).isEqualTo(SOURCE);

        execute("INSERT INTO device_measurement_sample (time,received_at,tenant_id,site_id,device_id,"
                + "point_key,raw_numeric,quality,catalog_version,edge_sequence,aggregation_kind,long_term_cadence_s) "
                + "VALUES ('2026-08-24T10:00:30Z','2026-08-24T10:00:30Z','" + TENANT + "','"
                + TARGET + "','" + DEVICE + "','" + POINT + "',8.5,'good','upgrade',2,'gauge',300)");
        execute("INSERT INTO device_measurement_sample (time,received_at,tenant_id,site_id,device_id,"
                + "point_key,raw_numeric,quality,catalog_version,edge_sequence,aggregation_kind,long_term_cadence_s) "
                + "VALUES ('2026-08-24T10:00:40Z','2026-08-24T10:00:40Z','" + TENANT + "','"
                + TARGET + "','" + DEVICE + "','" + COUNTER_POINT
                + "',110,'good','upgrade',4,'counter',300)");
        execute("INSERT INTO device_measurement_sample (time,received_at,tenant_id,site_id,device_id,"
                + "point_key,raw_numeric,quality,catalog_version,edge_sequence,aggregation_kind,long_term_cadence_s) "
                + "VALUES ('2026-08-24T10:00:50Z','2026-08-24T10:00:50Z','" + TENANT + "','"
                + TARGET + "','" + DEVICE + "','" + COUNTER_POINT
                + "',115,'good','upgrade',5,'counter',300)");
        execute("CALL refresh_device_measurement_rollup('device_measurement_rollup_5m',"
                + "interval '5 minutes','2026-08-24T10:00:00Z')");
        assertThat(count("SELECT count(*) FROM device_measurement_rollup_5m WHERE device_id='"
                + DEVICE + "' AND point_key='" + POINT + "'")).isEqualTo(2L);
        assertThat(count("SELECT count(DISTINCT site_id) FROM device_measurement_rollup_5m WHERE device_id='"
                + DEVICE + "' AND point_key='" + POINT + "'")).isEqualTo(2L);
        assertThat(count("SELECT count(*) FROM device_measurement_rollup_5m WHERE device_id='"
                + DEVICE + "' AND point_key='" + COUNTER_POINT + "'")).isEqualTo(2L);
        assertThat(decimal("SELECT positive_delta FROM device_measurement_rollup_5m WHERE device_id='"
                + DEVICE + "' AND site_id='" + SOURCE + "' AND point_key='" + COUNTER_POINT + "'"))
                .isEqualByComparingTo("0");
        assertThat(decimal("SELECT positive_delta FROM device_measurement_rollup_5m WHERE device_id='"
                + DEVICE + "' AND site_id='" + TARGET + "' AND point_key='" + COUNTER_POINT + "'"))
                .as("der Zielstandort darf nur sein lokales 110-zu-115-Delta erhalten, nicht 100-zu-115")
                .isEqualByComparingTo("5");
    }

    private FluentConfiguration flyway() {
        return Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of(
                        "appDbUser", "voltpilot_app", "appDbPassword", "voltpilot_app_test_pw",
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "voltpilot_admin_test_pw"));
    }

    private void execute(String sql) throws SQLException {
        try (Connection c = POSTGRES.createConnection(""); Statement s = c.createStatement()) {
            s.execute(sql);
        }
    }

    private long count(String sql) throws SQLException {
        try (Connection c = POSTGRES.createConnection(""); Statement s = c.createStatement();
                ResultSet rs = s.executeQuery(sql)) {
            rs.next();
            return rs.getLong(1);
        }
    }

    private String text(String sql) throws SQLException {
        try (Connection c = POSTGRES.createConnection(""); Statement s = c.createStatement();
                ResultSet rs = s.executeQuery(sql)) {
            rs.next();
            return rs.getString(1);
        }
    }

    private java.math.BigDecimal decimal(String sql) throws SQLException {
        try (Connection c = POSTGRES.createConnection(""); Statement s = c.createStatement();
                ResultSet rs = s.executeQuery(sql)) {
            rs.next();
            return rs.getBigDecimal(1);
        }
    }
}
