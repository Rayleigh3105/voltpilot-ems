package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.Map;
import java.util.Objects;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Migration V20261105233000 (letzter Handshake je Techniker-Zugang aus der
 * Rückmeldung des Tunnel-Dienstes) auf einer Datenbank AM STAND VON MAIN, mit
 * Zugängen, Fenster und einer Rückmeldung aus dem Betrieb. Geprüft wird: nichts
 * Bestehendes ändert sich, die Tabelle nimmt nur Techniker-Zugänge, die
 * Admin-Rolle schreibt ohne DELETE, die App-Rolle sieht nichts; dazu die späte
 * Ankunft nach einer neueren Version.
 *
 * <p>Frischer Container, ohne Spring; ohne Docker übersprungen.
 */
@Testcontainers(disabledWithoutDocker = true)
class FernwartungRueckmeldungTechnikerMigrationTest {

    private static final String STAND_VORHER = "20261105230000";
    private static final String VERSION = "20261105233000";
    private static final String MIGRATION =
            "/db/migration/V20261105233000__fernwartung_rueckmeldung_techniker.sql";
    private static final String TABELLE = "fernwartung_rueckmeldung_techniker";

    private static final String BOX = "11111111-1111-4111-8111-111111111111";
    private static final String TECHNIKER = "22222222-2222-4222-8222-222222222222";
    private static final String FENSTER = "33333333-3333-4333-8333-333333333333";
    private static final String FREMD = "99999999-9999-4999-8999-999999999999";

    @Container
    final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Test
    void dieMigrationKommtAufEinerBenutztenDatenbankAnUndHaeltIhreRegeln() throws Exception {
        // 1. Der Stand von main, mit Zeilen aus dem Betrieb.
        flyway().target(STAND_VORHER).load().migrate();
        assertThat(angewandt(VERSION)).isFalse();
        exec("INSERT INTO fernwartung_zugang (id, art, edge_ref, public_key, tunnel_adresse, status, "
                + "angelegt_von, geaendert_von) VALUES ('" + BOX + "', 'box', 'edge-zay5sdd', "
                + "'jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM=', '10.10.16.2/32', 'aktiv', 'admin', 'admin')");
        exec("INSERT INTO fernwartung_zugang (id, art, name, public_key, tunnel_adresse, status, "
                + "angelegt_von, geaendert_von) VALUES ('" + TECHNIKER + "', 'techniker', 'Alex (Laptop)', "
                + "'FY4LLXFaOvh8LPZu/gA4AeS2WJjXkuOUPB4hlxBI8/Y=', '10.10.32.2/32', 'aktiv', 'admin', 'admin')");
        exec("INSERT INTO fernwartung_fenster (id, box_id, techniker_id, grund, beginn, ende, geoeffnet_von) "
                + "VALUES ('" + FENSTER + "', '" + BOX + "', '" + TECHNIKER + "', 'Update auf Stufe 2', "
                + "now() - interval '10 minutes', now() + interval '50 minutes', 'admin')");
        exec("INSERT INTO fernwartung_rueckmeldung_box (box_id, dienst, angenommen_am, verbunden_seit) "
                + "VALUES ('" + BOX + "', 'voltpilot-tunnel-dienst', now(), now())");
        String vorher = abbild();

        // 2. Die Migration kommt an: nichts Bestehendes ändert sich, die neue Tabelle ist leer.
        flyway().load().migrate();
        assertThat(angewandt(VERSION)).isTrue();
        assertThat(abbild()).isEqualTo(vorher);
        assertThat(wert("SELECT count(*)::text FROM " + TABELLE)).isEqualTo("0");

        // 3. Wiederholbar.
        String sql = new String(Objects.requireNonNull(getClass().getResourceAsStream(MIGRATION), MIGRATION)
                .readAllBytes(), StandardCharsets.UTF_8)
                .replace("${appDbUser}", "voltpilot_app").replace("${adminDbUser}", "voltpilot_admin");
        assertThatCode(() -> exec(sql)).doesNotThrowAnyException();
        assertThat(abbild()).isEqualTo(vorher);

        // 4. Die Admin-Rolle legt an und überschreibt; NULL heißt "der Server kennt keinen Handshake".
        admin("INSERT INTO " + TABELLE + " (techniker_id, dienst, angenommen_am, letzter_handshake_um) "
                + "VALUES ('" + TECHNIKER + "', 'voltpilot-tunnel-dienst', now(), NULL)");
        admin("INSERT INTO " + TABELLE + " (techniker_id, dienst, angenommen_am, letzter_handshake_um) "
                + "VALUES ('" + TECHNIKER + "', 'voltpilot-tunnel-dienst', now(), now()) "
                + "ON CONFLICT (techniker_id) DO UPDATE SET letzter_handshake_um = excluded.letzter_handshake_um, "
                + "angenommen_am = excluded.angenommen_am");
        assertThat(wert("SELECT count(*)::text || '/' || count(letzter_handshake_um)::text FROM " + TABELLE))
                .as("eine Zeile je Zugang, überschrieben").isEqualTo("1/1");

        // 5. Nur Techniker-Zugänge, die es gibt.
        assertThatThrownBy(() -> admin("INSERT INTO " + TABELLE + " (techniker_id, dienst, angenommen_am) "
                + "VALUES ('" + FREMD + "', 'x', now())")).as("unbekannter Zugang")
                .hasMessageContaining("fernwartung_rueckmeldung_techniker_fk");
        assertThatThrownBy(() -> admin("INSERT INTO " + TABELLE + " (techniker_id, dienst, angenommen_am) "
                + "VALUES ('" + BOX + "', 'x', now())")).as("eine Box ist kein Techniker-Zugang")
                .hasMessageContaining("fernwartung_rueckmeldung_techniker_fk");
        assertThatThrownBy(() -> admin("INSERT INTO " + TABELLE + " (techniker_id, techniker_art, dienst, "
                + "angenommen_am) VALUES ('" + BOX + "', 'box', 'x', now())"))
                .hasMessageContaining("fernwartung_rueckmeldung_techniker_art_chk");

        // 6. Rechte: Admin liest, legt an, überschreibt, löscht nicht; die App-Rolle hat nichts.
        assertThat(wert("SELECT (has_table_privilege('voltpilot_admin', '" + TABELLE + "', 'SELECT') "
                + "AND has_table_privilege('voltpilot_admin', '" + TABELLE + "', 'INSERT') "
                + "AND has_table_privilege('voltpilot_admin', '" + TABELLE + "', 'UPDATE'))::text"))
                .isEqualTo("true");
        assertThat(wert("SELECT (has_table_privilege('voltpilot_admin', '" + TABELLE + "', 'DELETE') "
                + "OR has_table_privilege('voltpilot_admin', '" + TABELLE + "', 'TRUNCATE'))::text"))
                .isEqualTo("false");
        assertThat(wert("SELECT has_any_column_privilege('voltpilot_app', '" + TABELLE
                + "', 'SELECT, INSERT, UPDATE')::text")).isEqualTo("false");
        assertThat(wert("SELECT (relrowsecurity AND relforcerowsecurity)::text FROM pg_class "
                + "WHERE relname = '" + TABELLE + "'")).isEqualTo("true");
        assertThatThrownBy(() -> admin("DELETE FROM " + TABELLE)).hasMessageContaining("permission denied");

        // 7. Die bestehenden Tabellen sind unberührt geblieben.
        assertThat(abbild()).isEqualTo(vorher);
    }

    /** Späte Ankunft (out-of-order): Eine neuere Version ist schon angewandt. */
    @Test
    void dieMigrationKommtAuchNachEinerNeuerenVersionAn() throws Exception {
        flyway().target(STAND_VORHER).load().migrate();
        exec("INSERT INTO flyway_schema_history (installed_rank, version, description, type, script, checksum, "
                + "installed_by, execution_time, success) SELECT max(installed_rank) + 1, '20991231235959', "
                + "'spaetere version', 'SQL', 'V20991231235959__spaetere_version.sql', 0, 'voltpilot', 1, true "
                + "FROM flyway_schema_history");
        flyway().ignoreMigrationPatterns("*:missing", "*:future").load().migrate();
        assertThat(angewandt(VERSION)).isTrue();
        assertThat(wert("SELECT count(*)::text FROM " + TABELLE)).isEqualTo("0");
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

    /** Alle Zeilen der bestehenden Fernwartungs-Tabellen als ein Text. */
    private String abbild() throws Exception {
        return wert("SELECT (SELECT string_agg(z::text, '|' ORDER BY z.id) FROM fernwartung_zugang z) || ' # ' "
                + "|| (SELECT string_agg(f::text, '|' ORDER BY f.id) FROM fernwartung_fenster f) || ' # ' "
                + "|| (SELECT string_agg(b::text, '|' ORDER BY b.box_id) FROM fernwartung_rueckmeldung_box b)");
    }

    private boolean angewandt(String version) throws Exception {
        return "1".equals(wert("SELECT count(*)::text FROM flyway_schema_history WHERE version = '" + version
                + "' AND success"));
    }

    private String wert(String sql) throws Exception {
        try (Connection c = POSTGRES.createConnection("");
                Statement s = c.createStatement();
                ResultSet rs = s.executeQuery(sql)) {
            rs.next();
            return rs.getString(1);
        }
    }

    private void exec(String sql) throws Exception {
        try (Connection c = POSTGRES.createConnection("");
                Statement s = c.createStatement()) {
            s.execute(sql);
        }
    }

    /** Als die Rolle, mit der die API die Fernwartung schreibt. */
    private void admin(String sql) throws Exception {
        try (Connection c = DriverManager.getConnection(POSTGRES.getJdbcUrl(), "voltpilot_admin",
                "voltpilot_admin_test_pw");
                Statement s = c.createStatement()) {
            s.execute(sql);
        }
    }
}
