package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.List;
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
 * Die Migration V20261010203000 (Rückmeldung des Tunnel-Dienstes) auf einer
 * Datenbank AM STAND VON MAIN: die Fernwartung ist ausgeliefert und trägt
 * Zeilen - Box, Techniker-Zugänge, ein offenes Fenster, Protokoll -, wenn
 * diese Migration ankommt. Die frische Datenbank in Versionsreihenfolge deckt
 * {@code FernwartungApiTest} ab.
 *
 * <p>Geprüft wird: keine bestehende Zeile ändert sich, die drei neuen
 * Tabellen halten ihre Regeln an der Datenbankgrenze (nur eine BOX, nur ein
 * bekanntes Fenster), die Admin-Rolle schreibt ohne DELETE, und die App-Rolle
 * sieht nichts. Dazu die späte Ankunft: Die Migration steht für sich, auch
 * wenn eine neuere Version schon angewandt ist.
 *
 * <p>Frischer Container, ohne Spring; ohne Docker übersprungen.
 */
@Testcontainers(disabledWithoutDocker = true)
class FernwartungRueckmeldungMigrationTest {

    private static final String STAND_VORHER = "20261010100000";
    private static final String VERSION = "20261010203000";
    private static final String MIGRATION = "/db/migration/V20261010203000__fernwartung_rueckmeldung.sql";

    private static final String BOX = "11111111-1111-4111-8111-111111111111";
    private static final String TECHNIKER = "22222222-2222-4222-8222-222222222222";
    private static final String FENSTER = "33333333-3333-4333-8333-333333333333";
    private static final String FREMD = "99999999-9999-4999-8999-999999999999";

    private static final List<String> TABELLEN = List.of("fernwartung_rueckmeldung_dienst",
            "fernwartung_rueckmeldung_box", "fernwartung_rueckmeldung_fenster");

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
        exec("INSERT INTO fernwartung_protokoll (akteur, aktion, box_id, techniker_id, fenster_id) VALUES "
                + "('admin', 'fenster_geoeffnet', '" + BOX + "', '" + TECHNIKER + "', '" + FENSTER + "')");
        exec("INSERT INTO fernwartung_dienst_abruf (dienst, zuletzt_am, peers, fenster) VALUES "
                + "('voltpilot-tunnel-dienst', now(), 2, 1)");
        String vorher = abbild();

        // 2. Die Migration kommt an: nichts Bestehendes ändert sich, die neuen Tabellen sind leer.
        flyway().load().migrate();
        assertThat(angewandt(VERSION)).isTrue();
        assertThat(abbild()).isEqualTo(vorher);
        for (String tabelle : TABELLEN) {
            assertThat(wert("SELECT count(*)::text FROM " + tabelle)).as(tabelle).isEqualTo("0");
        }

        // 3. Wiederholbar: ein zweiter Lauf desselben SQL ändert nichts und bricht nicht.
        String sql = new String(Objects.requireNonNull(getClass().getResourceAsStream(MIGRATION), MIGRATION)
                .readAllBytes(), StandardCharsets.UTF_8)
                .replace("${appDbUser}", "voltpilot_app").replace("${adminDbUser}", "voltpilot_admin");
        assertThatCode(() -> exec(sql)).doesNotThrowAnyException();
        assertThat(abbild()).isEqualTo(vorher);

        // 4. Die Admin-Rolle (der Weg der API) legt an und überschreibt.
        admin("INSERT INTO fernwartung_rueckmeldung_dienst (dienst, angenommen_am, gemeldet_um, gestartet_um, "
                + "schluesselausgabe, boxen, fenster) VALUES ('voltpilot-tunnel-dienst', now(), now(), "
                + "now() - interval '1 hour', true, 1, 1)");
        admin("INSERT INTO fernwartung_rueckmeldung_box (box_id, dienst, angenommen_am, verbunden_seit, "
                + "zuletzt_gefragt_um) VALUES ('" + BOX + "', 'voltpilot-tunnel-dienst', now(), NULL, NULL)");
        admin("INSERT INTO fernwartung_rueckmeldung_box (box_id, dienst, angenommen_am, verbunden_seit, "
                + "zuletzt_gefragt_um) VALUES ('" + BOX + "', 'voltpilot-tunnel-dienst', now(), now(), now()) "
                + "ON CONFLICT (box_id) DO UPDATE SET verbunden_seit = excluded.verbunden_seit, "
                + "zuletzt_gefragt_um = excluded.zuletzt_gefragt_um, angenommen_am = excluded.angenommen_am");
        admin("INSERT INTO fernwartung_rueckmeldung_fenster (fenster_id, dienst, angenommen_am, "
                + "schluessel_abgeholt_um) VALUES ('" + FENSTER + "', 'voltpilot-tunnel-dienst', now(), now())");
        assertThat(wert("SELECT count(*)::text || '/' || count(verbunden_seit)::text "
                + "FROM fernwartung_rueckmeldung_box")).as("eine Zeile je Box, überschrieben").isEqualTo("1/1");

        // 5. Was die Tabellen nicht annehmen: eine Meldung zu etwas, das es nicht gibt.
        assertThatThrownBy(() -> admin("INSERT INTO fernwartung_rueckmeldung_box (box_id, dienst, angenommen_am) "
                + "VALUES ('" + FREMD + "', 'x', now())")).as("unbekannte Box")
                .hasMessageContaining("fernwartung_rueckmeldung_box_fk");
        assertThatThrownBy(() -> admin("INSERT INTO fernwartung_rueckmeldung_box (box_id, dienst, angenommen_am) "
                + "VALUES ('" + TECHNIKER + "', 'x', now())")).as("ein Techniker-Zugang ist keine Box")
                .hasMessageContaining("fernwartung_rueckmeldung_box_fk");
        assertThatThrownBy(() -> admin("INSERT INTO fernwartung_rueckmeldung_box (box_id, box_art, dienst, "
                + "angenommen_am) VALUES ('" + TECHNIKER + "', 'techniker', 'x', now())"))
                .hasMessageContaining("fernwartung_rueckmeldung_box_art_chk");
        assertThatThrownBy(() -> admin("INSERT INTO fernwartung_rueckmeldung_fenster (fenster_id, dienst, "
                + "angenommen_am) VALUES ('" + FREMD + "', 'x', now())")).as("unbekanntes Fenster")
                .hasMessageContaining("fernwartung_rueckmeldung_fenster_fenster_id_fkey");
        assertThatThrownBy(() -> admin("INSERT INTO fernwartung_rueckmeldung_dienst (dienst, angenommen_am, "
                + "gemeldet_um, gestartet_um, schluesselausgabe, boxen, fenster) VALUES ('y', now(), now(), "
                + "now() + interval '1 minute', false, 0, 0)"))
                .hasMessageContaining("fernwartung_rueckmeldung_dienst_zeit_chk");

        // 6. Rechte: Admin liest, legt an, überschreibt - und löscht nichts. Die App-Rolle
        //    (der Kunden-Datenpfad) hat kein Recht, und RLS ist der zweite Riegel.
        for (String tabelle : TABELLEN) {
            assertThat(wert("SELECT (has_table_privilege('voltpilot_admin', '" + tabelle + "', 'SELECT') "
                    + "AND has_table_privilege('voltpilot_admin', '" + tabelle + "', 'INSERT') "
                    + "AND has_table_privilege('voltpilot_admin', '" + tabelle + "', 'UPDATE'))::text"))
                    .as(tabelle).isEqualTo("true");
            assertThat(wert("SELECT (has_table_privilege('voltpilot_admin', '" + tabelle + "', 'DELETE') "
                    + "OR has_table_privilege('voltpilot_admin', '" + tabelle + "', 'TRUNCATE'))::text"))
                    .as(tabelle).isEqualTo("false");
            assertThat(wert("SELECT has_any_column_privilege('voltpilot_app', '" + tabelle
                    + "', 'SELECT, INSERT, UPDATE')::text")).as(tabelle).isEqualTo("false");
            assertThat(wert("SELECT (has_table_privilege('voltpilot_app', '" + tabelle + "', 'SELECT') "
                    + "OR has_table_privilege('voltpilot_app', '" + tabelle + "', 'INSERT') "
                    + "OR has_table_privilege('voltpilot_app', '" + tabelle + "', 'UPDATE') "
                    + "OR has_table_privilege('voltpilot_app', '" + tabelle + "', 'DELETE'))::text"))
                    .as(tabelle).isEqualTo("false");
            assertThat(wert("SELECT (relrowsecurity AND relforcerowsecurity)::text FROM pg_class "
                    + "WHERE relname = '" + tabelle + "'")).as(tabelle).isEqualTo("true");
            assertThatThrownBy(() -> admin("DELETE FROM " + tabelle)).as(tabelle)
                    .hasMessageContaining("permission denied");
        }

        // 7. Die bestehenden Tabellen der Fernwartung sind unberührt geblieben.
        assertThat(abbild()).isEqualTo(vorher);
    }

    /**
     * Späte Ankunft (out-of-order): Eine neuere Version ist schon angewandt,
     * wenn diese Migration kommt. Sie setzt nur die Tabellen aus
     * V20261007163700 voraus.
     */
    @Test
    void dieMigrationKommtAuchNachEinerNeuerenVersionAn() throws Exception {
        flyway().target(STAND_VORHER).load().migrate();
        exec("INSERT INTO flyway_schema_history (installed_rank, version, description, type, script, checksum, "
                + "installed_by, execution_time, success) SELECT max(installed_rank) + 1, '20991231235959', "
                + "'spaetere version', 'SQL', 'V20991231235959__spaetere_version.sql', 0, 'voltpilot', 1, true "
                + "FROM flyway_schema_history");
        flyway().ignoreMigrationPatterns("*:missing", "*:future").load().migrate();
        assertThat(angewandt(VERSION)).isTrue();
        for (String tabelle : TABELLEN) {
            assertThat(wert("SELECT count(*)::text FROM " + tabelle)).as(tabelle).isEqualTo("0");
        }
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
                + "|| (SELECT string_agg(p::text, '|' ORDER BY p.id) FROM fernwartung_protokoll p) || ' # ' "
                + "|| (SELECT string_agg(a::text, '|' ORDER BY a.dienst) FROM fernwartung_dienst_abruf a)");
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
