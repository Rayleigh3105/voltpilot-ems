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
 * Der Reparaturlauf {@code V20260909010000}: Zeilen, die den alten
 * Rollen-Default {@code power_kw} TRAGEN, bekommen die Messkanäle ihres
 * Entitätstyps - und sonst wird nichts angefasst.
 *
 * <p>Der Zaun ist der eigentliche Prüfgegenstand. Ein zu weiter Lauf hätte zwei
 * Arten von Schaden: er ergänzte einen zweiten Leistungskanal auf einer korrekt
 * komponierten Bootstrap-Anlage (der Speicher-Knoten summierte dann doppelt),
 * oder er räumte eine vom Kunden erweiterte Auswahl ab. Deshalb prüft dieser
 * Test beide Richtungen an EINER Anlage: die beschädigten Zeilen steigen, die
 * gesunden bleiben bytegleich.
 *
 * <p>Vorbild: {@code MeasurementHistoryMoveMigrationTest} - bis zur Fassung DAVOR
 * migrieren, den Altbestand säen, dann den Rest laufen lassen.
 */
@Testcontainers(disabledWithoutDocker = true)
class ComponentCapabilitiesRepairMigrationTest {

    /** Die Fassung unmittelbar VOR dem Reparaturlauf. */
    private static final String VOR_DER_REPARATUR = "20260909000000";

    private static final String TENANT = "30000000-0000-0000-0000-000000000001";
    private static final String SITE = "30000000-0000-0000-0000-000000000002";
    private static final String HYBRID_KAPUTT = "30000000-0000-0000-0000-00000000000a";
    private static final String HYBRID_GESUND = "30000000-0000-0000-0000-00000000000b";
    private static final String HYBRID_ERWEITERT = "30000000-0000-0000-0000-00000000000c";
    private static final String ERZEUGER_KAPUTT = "30000000-0000-0000-0000-00000000000d";
    private static final String NETZ = "30000000-0000-0000-0000-00000000000e";
    private static final String VERBRAUCHER = "30000000-0000-0000-0000-00000000000f";

    private static final String NUR_POWER =
            "{\"measure\":[{\"channel\":\"power_kw\",\"unit\":\"kW\"}]}";
    private static final String DREI_KANAELE =
            "{\"measure\":[{\"channel\":\"soc_pct\",\"unit\":\"%\"},"
                    + "{\"channel\":\"battery_power_kw\",\"unit\":\"kW\"},"
                    + "{\"channel\":\"pv_power_kw\",\"unit\":\"kW\"}]}";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Test
    void derReparaturlaufHebtNurDieZeilenMitDemAltenRollenDefault() throws Exception {
        flyway().target(VOR_DER_REPARATUR).load().migrate();
        execute("INSERT INTO tenant(id,name) VALUES ('" + TENANT + "','Reparatur-Mandant')");
        execute("INSERT INTO site(id,tenant_id,name) VALUES ('" + SITE + "','" + TENANT
                + "','Reparatur-Anlage')");

        // Der Live-Fall: über den Assistenten entstanden, danach bearbeitet -
        // ein einziger Kanal, dazu die komponierten Schreibbefehle.
        point(HYBRID_KAPUTT, "battery-hybrid", "battery-hybrid",
                "{\"measure\":[{\"channel\":\"power_kw\",\"unit\":\"kW\"}],"
                        + "\"actuate\":[{\"command\":\"setpoint_kw\"}]}");
        // Bootstrap-Anlage: vollständig, und sie muss es bleiben.
        point(HYBRID_GESUND, "battery-hybrid", "battery-hybrid", DREI_KANAELE);
        // Kunden-Auswahl: mehr als ein Kanal - der Zaun greift nicht.
        point(HYBRID_ERWEITERT, "battery-hybrid", "battery-hybrid",
                "{\"measure\":[{\"channel\":\"power_kw\",\"unit\":\"kW\"},"
                        + "{\"channel\":\"zisterne_prozent\",\"unit\":\"%\"}]}");
        point(ERZEUGER_KAPUTT, "pv-generation", "producer", NUR_POWER);
        // Für Netz und Verbraucher IST power_kw die Katalog-Wahrheit.
        point(NETZ, "grid-meter", "grid-meter", NUR_POWER);
        point(VERBRAUCHER, "consumer", "generic-load", NUR_POWER);

        // GENAU bis zum Reparaturlauf migrieren: dieser Test prüft SEINEN engen Zaun.
        // Der spätere Backfill V20260915120000 heilt die erweiterte Zeile absichtlich
        // breiter (eigener Test), also darf er hier nicht mitlaufen.
        flyway().target("20260909010000").load().migrate();

        assertThat(channels(HYBRID_KAPUTT))
                .as("ohne pv_power_kw hat das Schaltbild keinen PV-Knoten")
                .isEqualTo("soc_pct,battery_power_kw,pv_power_kw");
        assertThat(text("SELECT capabilities->'actuate'->0->>'command' FROM measurement_point "
                + "WHERE id='" + HYBRID_KAPUTT + "'"))
                .as("nur `measure` wird gesetzt - die Schreibbefehle bleiben stehen")
                .isEqualTo("setpoint_kw");
        assertThat(unitOf(HYBRID_KAPUTT, "soc_pct"))
                .as("der Ladestand ist ein Prozentwert").isEqualTo("%");

        assertThat(channels(HYBRID_GESUND))
                .as("eine korrekt komponierte Anlage wird NICHT angefasst")
                .isEqualTo("soc_pct,battery_power_kw,pv_power_kw");
        assertThat(channels(HYBRID_ERWEITERT))
                .as("mehr als ein Kanal heisst: hier hat jemand gewaehlt")
                .isEqualTo("power_kw,zisterne_prozent");

        assertThat(channels(ERZEUGER_KAPUTT)).isEqualTo("pv_power_kw");
        assertThat(channels(NETZ)).as("power_kw IST die Katalog-Wahrheit des Netz-Zaehlers")
                .isEqualTo("power_kw");
        assertThat(channels(VERBRAUCHER)).isEqualTo("power_kw");
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
