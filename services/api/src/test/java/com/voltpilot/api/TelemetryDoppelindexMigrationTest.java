package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.Test;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * Die Migration V20261115180000 (Lasttest vp-lasttest, Befund B10, Rang 8) auf einer Datenbank AM STAND DAVOR mit
 * Telemetrie in mehreren Chunks: {@code telemetry} trug zwei Indizes auf genau {@code (device_id, time DESC)} -
 * {@code idx_telemetry_device_time} (V1) und den UNIQUE-Index {@code uq_telemetry_device_time} (V20260712000000).
 * Danach ist der schlichte weg, auf der Hypertable UND auf jedem Chunk; der UNIQUE-Index bleibt überall, die
 * Doppel-Einfügung scheitert weiter an ihm, und die Abfrage „jüngster Wert je Box“ geht über ihn.
 *
 * <p>Die Migration läuft ohne Flyway-Transaktion ({@code DROP INDEX CONCURRENTLY}); ein zweiter Lauf desselben SQL
 * ändert nichts. Frischer Container, ohne Spring; ohne Docker übersprungen.
 */
@Testcontainers(disabledWithoutDocker = true)
class TelemetryDoppelindexMigrationTest {

    private static final String VERSION = "20261115180000";
    private static final String STAND_VORHER = "20261115150000";
    private static final String MIGRATION = "/db/migration/V20261115180000__telemetry_doppelindex_entfernen.sql";

    private static final String TENANT = "a1000000-0000-4000-8000-0000000000a8";
    private static final String SITE = "a2000000-0000-4000-8000-0000000000a8";
    private static final String DEVICE = "a3000000-0000-4000-8000-0000000000a8";

    @Container
    final TestDatenbank POSTGRES = new TestDatenbank();

    @Test
    void derDoppelteIndexIstAufHypertableUndChunksWegDerEindeutigeBleibt() throws Exception {
        flyway().target(STAND_VORHER).load().migrate();
        assertThat(angewandt(VERSION)).isFalse();
        exec("INSERT INTO tenant (id, name) VALUES ('" + TENANT + "', 'Kunde Index')");
        exec("INSERT INTO site (id, tenant_id, name) VALUES ('" + SITE + "', '" + TENANT + "', 'Anlage Index')");
        exec("INSERT INTO device (id, tenant_id, site_id, external_ref, kind, status) VALUES ('" + DEVICE + "', '"
                + TENANT + "', '" + SITE + "', 'ref-index', 'inverter', 'claimed')");
        // Drei Wochen alle 10 min: mehrere 7-Tage-Chunks, jeder mit beiden Indizes.
        exec("INSERT INTO telemetry (time, received_at, tenant_id, site_id, device_id, power_kw) "
                + "SELECT g, g, '" + TENANT + "', '" + SITE + "', '" + DEVICE + "', 1.0 "
                + "FROM generate_series(now() - interval '21 days', now(), interval '10 minutes') g");
        int chunks = Integer.parseInt(wert("SELECT count(*)::text FROM show_chunks('telemetry')"));
        assertThat(chunks).isGreaterThanOrEqualTo(3);
        assertThat(indizesMit("idx_telemetry_device_time")).as("vorher: Hypertable + je Chunk").hasSize(chunks + 1);
        assertThat(indizesMit("uq_telemetry_device_time")).hasSize(chunks + 1);

        flyway().load().migrate();
        assertThat(angewandt(VERSION)).isTrue();

        assertThat(indizesMit("idx_telemetry_device_time")).as("nachher: nirgends mehr").isEmpty();
        assertThat(indizesMit("uq_telemetry_device_time")).as("der eindeutige bleibt überall")
                .hasSize(chunks + 1);
        assertThat(wert("SELECT count(*)::text FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid "
                + "WHERE c.relname LIKE '%uq_telemetry_device_time%' AND NOT i.indisvalid")).isEqualTo("0");

        // Die Idempotenz des Writers hängt am eindeutigen Index: eine zweite Zeile derselben Box und Zeit scheitert.
        String ts = wert("SELECT max(time)::text FROM telemetry");
        try {
            exec("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw) VALUES ('" + ts + "', '"
                    + TENANT + "', '" + SITE + "', '" + DEVICE + "', 2.0)");
            throw new AssertionError("doppelte (device_id, time) wurde angenommen");
        } catch (java.sql.SQLException e) {
            assertThat(e.getSQLState()).isEqualTo("23505");
        }

        // „Jüngster Wert je Box“ - der Leseweg, den der schlichte Index bediente - liefert dasselbe; welcher Index ihn
        // bedient, entscheidet der Planer nach Verteilung (bei einer einzigen Box hier der Zeit-Index, im Labor bei
        // 2 000 Boxen der eindeutige mit 5 Buffern). Der entfernte Index taucht in keinem Plan mehr auf.
        exec("ANALYZE telemetry");
        assertThat(wert("SELECT time::text FROM telemetry WHERE device_id = '" + DEVICE
                + "' ORDER BY time DESC LIMIT 1")).isEqualTo(ts);
        String plan = String.join("\n", zeilen("EXPLAIN SELECT time FROM telemetry WHERE device_id = '" + DEVICE
                + "' ORDER BY time DESC LIMIT 1"));
        assertThat(plan).doesNotContain("idx_telemetry_device_time");
    }

    @Test
    void einZweiterLaufDerselbenMigrationAendertNichts() throws Exception {
        flyway().load().migrate();
        String sql = new String(getClass().getResourceAsStream(MIGRATION).readAllBytes(),
                java.nio.charset.StandardCharsets.UTF_8);
        exec(sql);
        assertThat(indizesMit("idx_telemetry_device_time")).isEmpty();
        assertThat(indizesMit("uq_telemetry_device_time")).isNotEmpty();
    }

    private List<String> indizesMit(String name) throws Exception {
        return zeilen("SELECT indexname FROM pg_indexes WHERE indexname LIKE '%" + name + "%' ORDER BY 1");
    }

    private FluentConfiguration flyway() {
        return Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .outOfOrder(true)
                .placeholders(Map.of(
                        "appDbUser", "voltpilot_app", "appDbPassword", "voltpilot_app_test_pw",
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "voltpilot_admin_test_pw"));
    }

    private boolean angewandt(String version) throws Exception {
        return "1".equals(wert("SELECT count(*)::text FROM flyway_schema_history WHERE version = '" + version
                + "' AND success"));
    }

    private String wert(String sql) throws Exception {
        List<String> z = zeilen(sql);
        return z.isEmpty() ? null : z.get(0);
    }

    private List<String> zeilen(String sql) throws Exception {
        List<String> out = new ArrayList<>();
        try (Connection c = POSTGRES.createConnection("");
                Statement s = c.createStatement();
                ResultSet rs = s.executeQuery(sql)) {
            while (rs.next()) {
                out.add(rs.getString(1));
            }
        }
        return out;
    }

    private void exec(String sql) throws Exception {
        try (Connection c = POSTGRES.createConnection("");
                Statement s = c.createStatement()) {
            s.execute(sql);
        }
    }
}
