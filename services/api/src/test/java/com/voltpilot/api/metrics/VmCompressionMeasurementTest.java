package com.voltpilot.api.metrics;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.Map;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Lokaler Messlauf fuer AP-07 E7-B. Die Testcontainers-Datenbank enthaelt nur
 * synthetische Daten; die Kopie hat bewusst kein RLS. Es gibt keinen Parameter
 * fuer eine fremde Datenbank und damit keinen versehentlichen Produktionspfad.
 */
@Testcontainers(disabledWithoutDocker = true)
class VmCompressionMeasurementTest {

    private static final int SERIES = 12;
    private static final int DAYS = 90;

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot_compression_probe")
            .withUsername("probe")
            .withPassword("local-synthetic-only");

    @Test
    void measuresPreparedVmLayoutOnANonRlsCopy() throws Exception {
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

        try (Connection c = POSTGRES.createConnection(""); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE vm_compression_probe "
                    + "(LIKE messreihe_viertelstunde INCLUDING ALL)");
            s.execute("SELECT create_hypertable('vm_compression_probe', 'intervall_beginn', "
                    + "chunk_time_interval => INTERVAL '30 days', create_default_indexes => FALSE)");
            s.execute("ALTER TABLE vm_compression_probe SET (timescaledb.compress, "
                    + "timescaledb.compress_segmentby = 'tenant_id, entity_id, messkanal', "
                    + "timescaledb.compress_orderby = 'intervall_beginn DESC')");

            s.execute("""
                    INSERT INTO vm_compression_probe (
                        intervall_beginn, tenant_id, entity_id, messkanal, wertart,
                        mittel, min_wert, max_wert, erster_wert, erster_zeit,
                        letzter_wert, letzter_zeit, erhalten, erwartet, abdeckung_prozent,
                        kadenz_s, kadenz_herkunft, n_good, fassung, katalog, rolle,
                        zustand, endgueltig_ab, zustellart)
                    SELECT zeit,
                           '71000000-0000-0000-0000-000000000016'::uuid,
                           md5('vm-entity-' || serie)::uuid,
                           'power_' || serie,
                           'gauge',
                           100 + serie + sin(slot / 96.0) * 20,
                           99 + serie + sin(slot / 96.0) * 20,
                           101 + serie + sin(slot / 96.0) * 20,
                           100 + serie + sin(slot / 96.0) * 20,
                           zeit,
                           100.2 + serie + sin(slot / 96.0) * 20,
                           zeit + interval '14 minutes',
                           15, 15, 100, 60, 'katalog', 15, 1, '1.0', 'fuehrend',
                           'endgueltig', zeit + interval '10095 minutes', 'direkt'
                      FROM generate_series(0, %d - 1) serie
                      CROSS JOIN generate_series(0, %d - 1) slot
                      CROSS JOIN LATERAL (
                          SELECT timestamptz '2025-01-01 00:00:00Z'
                                 + slot * interval '15 minutes' AS zeit
                      ) z
                    """.formatted(SERIES, DAYS * 96));
            s.execute("ANALYZE vm_compression_probe");

            long rows = singleLong(s, "SELECT count(*) FROM vm_compression_probe");
            s.execute("SELECT compress_chunk(chunk) FROM show_chunks('vm_compression_probe') chunk");

            long before;
            long after;
            try (ResultSet rs = s.executeQuery("SELECT before_compression_total_bytes, "
                    + "after_compression_total_bytes "
                    + "FROM hypertable_compression_stats('vm_compression_probe')")) {
                assertThat(rs.next()).isTrue();
                before = rs.getLong(1);
                after = rs.getLong(2);
            }
            double factor = (double) before / after;
            System.out.printf("VM_COMPRESSION rows=%d before_bytes=%d after_bytes=%d factor=%.2f%n",
                    rows, before, after, factor);

            assertThat(rows).isEqualTo((long) SERIES * DAYS * 96);
            assertThat(after).isPositive().isLessThan(before);
            assertThat(factor).isGreaterThan(1.0);
        }
    }

    private static long singleLong(Statement s, String sql) throws Exception {
        try (ResultSet rs = s.executeQuery(sql)) {
            assertThat(rs.next()).isTrue();
            return rs.getLong(1);
        }
    }
}
