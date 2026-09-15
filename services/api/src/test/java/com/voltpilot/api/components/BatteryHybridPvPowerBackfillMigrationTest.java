package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

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
 * Der Backfill {@code V20260915120000}: JEDE {@code battery-hybrid}-Zeile, der
 * {@code pv_power_kw} fehlt, bekommt die kanonischen drei Kanäle - der breitere
 * Nachfolger des eng gezäunten {@code V20260909010000}, der nur den Fall
 * {@code measure == [power_kw]} heilte.
 *
 * <p>Geprüft wird an EINER Anlage: der reproduzierte Captain-Fall (drei Kanäle
 * ohne {@code pv_power_kw}) und die früher DURCHGEFALLENEN Formen (kundenweit
 * erweitert, nacktes {@code power_kw}) steigen; die schon gesunde Zeile bleibt
 * bytegleich, ein Netz-Zähler bleibt unberührt, und nach dem Lauf fehlt keiner
 * Batterie mehr der Kanal (idempotent).
 *
 * <p>Vorbild: {@code ComponentCapabilitiesRepairMigrationTest} - bis zur Fassung
 * DAVOR migrieren, den Altbestand säen, dann den Rest laufen lassen.
 */
@Testcontainers(disabledWithoutDocker = true)
class BatteryHybridPvPowerBackfillMigrationTest {

    /** Die Fassung unmittelbar VOR dem Backfill. */
    private static final String VOR_DEM_BACKFILL = "20260914100200";

    private static final String TENANT = "31000000-0000-0000-0000-000000000001";
    private static final String SITE = "31000000-0000-0000-0000-000000000002";
    private static final String HYBRID_CAPTAIN = "31000000-0000-0000-0000-00000000000a";
    private static final String HYBRID_NUR_POWER = "31000000-0000-0000-0000-00000000000b";
    private static final String HYBRID_ERWEITERT = "31000000-0000-0000-0000-00000000000c";
    private static final String HYBRID_GESUND = "31000000-0000-0000-0000-00000000000d";
    private static final String NETZ = "31000000-0000-0000-0000-00000000000e";

    private static final String DREI_KANAELE =
            "{\"measure\": [{\"channel\": \"soc_pct\", \"unit\": \"%\"}, "
                    + "{\"channel\": \"battery_power_kw\", \"unit\": \"kW\"}, "
                    + "{\"channel\": \"pv_power_kw\", \"unit\": \"kW\"}]}";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Test
    void derBackfillHebtJedeBatterieOhnePvPowerAufDenKanonischenStand() throws Exception {
        flyway().target(VOR_DEM_BACKFILL).load().migrate();
        execute("INSERT INTO tenant(id,name) VALUES ('" + TENANT + "','Backfill-Mandant')");
        execute("INSERT INTO site(id,tenant_id,name) VALUES ('" + SITE + "','" + TENANT
                + "','Backfill-Anlage')");

        // Der Captain-Fall: drei sinnvolle Kanäle, aber pv_power_kw fehlt (der eng
        // gezäunte V20260909010000 fasste ihn nicht an - measure ist kein [power_kw]).
        point(HYBRID_CAPTAIN, "battery-hybrid", "battery-hybrid",
                "{\"measure\": [{\"channel\": \"soc_pct\", \"unit\": \"%\"}, "
                        + "{\"channel\": \"battery_power_kw\", \"unit\": \"kW\"}], "
                        + "\"actuate\": [{\"command\": \"setpoint_kw\"}]}");
        // Nacktes power_kw (der alte Rollen-Default) - der Kollisions-Kanal fliegt raus.
        point(HYBRID_NUR_POWER, "battery-hybrid", "battery-hybrid",
                "{\"measure\": [{\"channel\": \"power_kw\", \"unit\": \"kW\"}]}");
        // Kunden-Auswahl: power_kw PLUS ein echtes Zusatz-Register - power_kw fliegt raus,
        // zisterne_prozent bleibt (nicht kollidierend).
        point(HYBRID_ERWEITERT, "battery-hybrid", "battery-hybrid",
                "{\"measure\": [{\"channel\": \"power_kw\", \"unit\": \"kW\"}, "
                        + "{\"channel\": \"zisterne_prozent\", \"unit\": \"%\"}]}");
        // Schon gesund: bleibt bytegleich.
        point(HYBRID_GESUND, "battery-hybrid", "battery-hybrid", DREI_KANAELE);
        // Ein Netz-Zähler misst laut Katalog wirklich power_kw - er ist keine Batterie.
        point(NETZ, "grid-meter", "grid-meter",
                "{\"measure\": [{\"channel\": \"power_kw\", \"unit\": \"kW\"}]}");

        String gesundVorher = text(
                "SELECT capabilities::text FROM measurement_point WHERE id='" + HYBRID_GESUND + "'");

        flyway().load().migrate();

        // Der Captain-Fall trägt jetzt den PV-Kanal - der PV-Knoten entsteht wieder.
        assertThat(channels(HYBRID_CAPTAIN))
                .as("die Batterie ohne pv_power_kw wird auf die kanonischen drei Kanäle gehoben")
                .isEqualTo("soc_pct,battery_power_kw,pv_power_kw");
        assertThat(unitOf(HYBRID_CAPTAIN, "pv_power_kw")).isEqualTo("kW");
        assertThat(text("SELECT capabilities->'actuate'->0->>'command' FROM measurement_point "
                + "WHERE id='" + HYBRID_CAPTAIN + "'"))
                .as("nur `measure` wird gesetzt - die Schreibbefehle bleiben stehen")
                .isEqualTo("setpoint_kw");

        // Nacktes power_kw wird durch die drei Kanäle ERSETZT (keine Doppelsummierung).
        assertThat(channels(HYBRID_NUR_POWER)).isEqualTo("soc_pct,battery_power_kw,pv_power_kw");

        // Erweiterte Auswahl: power_kw raus, das echte Zusatz-Register bleibt MIT Einheit.
        assertThat(channels(HYBRID_ERWEITERT))
                .as("kanonische drei voran, das nicht kollidierende Kunden-Register bleibt")
                .isEqualTo("soc_pct,battery_power_kw,pv_power_kw,zisterne_prozent");
        assertThat(unitOf(HYBRID_ERWEITERT, "zisterne_prozent")).isEqualTo("%");

        // Schon gesunde Zeile: unangetastet, bytegleich.
        assertThat(text("SELECT capabilities::text FROM measurement_point WHERE id='"
                + HYBRID_GESUND + "'"))
                .as("eine bereits vollständige Batterie wird NICHT umgeschrieben")
                .isEqualTo(gesundVorher);

        // Der Netz-Zähler ist keine Batterie - power_kw ist seine Katalog-Wahrheit.
        assertThat(channels(NETZ)).isEqualTo("power_kw");

        // Idempotent/vollständig: danach fehlt keiner Batterie mehr der Kanal, ein zweiter
        // Lauf träfe keine Zeile.
        assertThat(text("SELECT count(*)::text FROM measurement_point "
                + "WHERE entity_type='battery-hybrid' "
                + "AND NOT (capabilities->'measure' @> '[{\"channel\": \"pv_power_kw\"}]')"))
                .as("keine battery-hybrid-Zeile ohne pv_power_kw mehr")
                .isEqualTo("0");
    }

    // ---- Gerüst -------------------------------------------------------------

    private void point(String id, String role, String entityType, String capabilities)
            throws SQLException {
        execute("INSERT INTO measurement_point(id,tenant_id,site_id,role,entity_type,capabilities) "
                + "VALUES ('" + id + "','" + TENANT + "','" + SITE + "','" + role + "','"
                + entityType + "','" + capabilities + "'::jsonb)");
    }

    private String channels(String id) throws SQLException {
        return text("SELECT string_agg(m->>'channel', ',' ORDER BY ord) "
                + "FROM measurement_point mp, "
                + "jsonb_array_elements(mp.capabilities->'measure') WITH ORDINALITY AS t(m, ord) "
                + "WHERE mp.id='" + id + "'");
    }

    private String unitOf(String id, String channel) throws SQLException {
        return text("SELECT m->>'unit' FROM measurement_point mp, "
                + "jsonb_array_elements(mp.capabilities->'measure') AS m "
                + "WHERE mp.id='" + id + "' AND m->>'channel'='" + channel + "'");
    }

    private FluentConfiguration flyway() {
        return Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of(
                        "appDbUser", "voltpilot_app", "appDbPassword", "voltpilot_app_test_pw",
                        "adminDbUser", "voltpilot_admin",
                        "adminDbPassword", "voltpilot_admin_test_pw"));
    }

    private void execute(String sql) throws SQLException {
        try (Connection c = POSTGRES.createConnection(""); Statement s = c.createStatement()) {
            s.execute(sql);
        }
    }

    private String text(String sql) throws SQLException {
        try (Connection c = POSTGRES.createConnection(""); Statement s = c.createStatement();
                ResultSet rs = s.executeQuery(sql)) {
            rs.next();
            return rs.getString(1);
        }
    }
}
