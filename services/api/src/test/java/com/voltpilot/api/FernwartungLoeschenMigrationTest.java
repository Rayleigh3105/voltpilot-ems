package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
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
 * Die Migration V20261008213500 (ein gesperrter Techniker-Zugang lässt sich
 * löschen) auf einer Datenbank AM AKTUELLEN STAND: die Fernwartung ist schon
 * ausgeliefert (V20261007163700) und trägt Zeilen, wenn diese Migration
 * ankommt. Die frische Datenbank in Versionsreihenfolge deckt
 * {@code FernwartungApiTest} ab.
 *
 * <p>Geprüft wird, was eine CHECK-Erweiterung auf bestehenden Zeilen kaputt
 * machen kann und was die Migration neu verspricht: keine Zeile geht verloren
 * oder ändert sich, die älteren Wörter bleiben gültig, und die Löschregel gilt
 * an der Datenbankgrenze - auch für den Schema-Eigentümer.
 *
 * <p>Frischer Container, ohne Spring; ohne Docker übersprungen.
 */
@Testcontainers(disabledWithoutDocker = true)
class FernwartungLoeschenMigrationTest {

    private static final String STAND_VORHER = "20261007163700";
    private static final String VERSION = "20261008213500";
    private static final String MIGRATION = "/db/migration/V20261008213500__fernwartung_zugang_loeschen.sql";

    private static final String BOX = "11111111-1111-4111-8111-111111111111";
    private static final String AKTIV = "22222222-2222-4222-8222-222222222222";
    private static final String GESPERRT = "33333333-3333-4333-8333-333333333333";

    private static final String KEY_BOX = "jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM=";
    private static final String KEY_AKTIV = "FY4LLXFaOvh8LPZu/gA4AeS2WJjXkuOUPB4hlxBI8/Y=";
    private static final String KEY_GESPERRT = "Pgf4aS+67rz4HdSHuy8KKgm5e/UP3xnrMWJskXaZB9c=";
    private static final String KEY_NEU = "dTkajHaCSCVbnmtc9YaXOW4Fvi51HANh0Fg2KTFV3kk=";

    @Container
    final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Test
    void dieMigrationKommtAufEinerBenutztenDatenbankAnUndHaeltDieLoeschregel() throws Exception {
        // 1. Der Stand vor dieser Migration, mit Zeilen aus dem Betrieb.
        flyway().target(STAND_VORHER).load().migrate();
        assertThat(angewandt(VERSION)).isFalse();
        exec("INSERT INTO fernwartung_zugang (id, art, edge_ref, public_key, tunnel_adresse, status, "
                + "angelegt_von, geaendert_von) VALUES ('" + BOX + "', 'box', 'edge-zay5sdd', '" + KEY_BOX
                + "', '10.10.16.2/32', 'gesperrt', 'admin', 'admin')");
        exec("INSERT INTO fernwartung_zugang (id, art, name, public_key, tunnel_adresse, status, "
                + "angelegt_von, geaendert_von) VALUES "
                + "('" + AKTIV + "', 'techniker', 'Max (Laptop)', '" + KEY_AKTIV + "', '10.10.32.3/32', "
                + "'aktiv', 'admin', 'admin'), "
                + "('" + GESPERRT + "', 'techniker', 'Max (Laptop)', '" + KEY_GESPERRT + "', '10.10.32.2/32', "
                + "'gesperrt', 'admin', 'admin')");
        exec("INSERT INTO fernwartung_fenster (box_id, techniker_id, grund, beginn, ende, geoeffnet_von, "
                + "geschlossen_am, geschlossen_von) VALUES ('" + BOX + "', '" + GESPERRT + "', 'Erster Einsatz', "
                + "now() - interval '2 hours', now() - interval '1 hour', 'admin', now() - interval '90 minutes', "
                + "'admin')");
        for (String aktion : new String[] {"techniker_angelegt", "fenster_geoeffnet", "fenster_geschlossen",
                "techniker_gesperrt"}) {
            exec("INSERT INTO fernwartung_protokoll (akteur, aktion, techniker_id) VALUES ('admin', '" + aktion
                    + "', '" + GESPERRT + "')");
        }
        String vorher = abbild();

        // 2. Die Migration kommt an. Keine Zeile geht verloren oder ändert sich.
        //    Bis zu IHRER Version, nicht weiter: spätere Migrationen (etwa die
        //    Spalte ssh_public_key aus V20261009074500) haben ihren eigenen Test.
        flyway().target(VERSION).load().migrate();
        assertThat(angewandt(VERSION)).isTrue();
        assertThat(abbild()).isEqualTo(vorher);

        // 3. Wiederholbar: ein zweiter Lauf desselben SQL ändert nichts und bricht nicht.
        String sql = new String(Objects.requireNonNull(getClass().getResourceAsStream(MIGRATION), MIGRATION)
                .readAllBytes(), StandardCharsets.UTF_8);
        assertThatCode(() -> exec(sql)).doesNotThrowAnyException();
        assertThat(abbild()).isEqualTo(vorher);

        // 4. Die Löschregel: nur aus gesperrt, nur Techniker, nie beim Anlegen.
        assertThatThrownBy(() -> exec("UPDATE fernwartung_zugang SET status = 'geloescht' WHERE id = '" + AKTIV
                + "'")).hasMessageContaining("nur ein gesperrter");
        assertThatThrownBy(() -> exec("UPDATE fernwartung_zugang SET status = 'geloescht' WHERE id = '" + BOX + "'"))
                .as("eine Box ist nicht löschbar").hasMessageContaining("fernwartung_zugang_geloescht_chk");
        assertThatThrownBy(() -> exec("INSERT INTO fernwartung_zugang (art, name, public_key, tunnel_adresse, "
                + "status, angelegt_von, geaendert_von) VALUES ('techniker', 'Neu', '" + KEY_NEU
                + "', '10.10.32.9/32', 'geloescht', 'admin', 'admin')")).hasMessageContaining("nicht als geloescht");
        assertThatThrownBy(() -> exec("UPDATE fernwartung_zugang SET status = 'weg' WHERE id = '" + GESPERRT + "'"))
                .hasMessageContaining("fernwartung_zugang_status_chk");

        exec("UPDATE fernwartung_zugang SET status = 'geloescht', geaendert_am = now(), geaendert_von = 'admin' "
                + "WHERE id = '" + GESPERRT + "'");
        exec("INSERT INTO fernwartung_protokoll (akteur, aktion, techniker_id) VALUES ('admin', "
                + "'techniker_geloescht', '" + GESPERRT + "')");
        assertThat(wert("SELECT status FROM fernwartung_zugang WHERE id = '" + GESPERRT + "'")).isEqualTo("geloescht");

        // 5. Endgültig: kein Weg zurück, kein anderer Schlüssel, keine andere Adresse.
        for (String aenderung : new String[] {"status = 'gesperrt'", "status = 'aktiv'",
                "public_key = '" + KEY_NEU + "'", "tunnel_adresse = '10.10.32.9/32'", "name = 'Anders'"}) {
            assertThatThrownBy(() -> exec("UPDATE fernwartung_zugang SET " + aenderung + " WHERE id = '" + GESPERRT
                    + "'")).as(aenderung).hasMessageContaining("endgueltig");
        }

        // 6. Adresse und Schlüssel bleiben vergeben; die Zeile lässt sich auch
        //    vom Eigentümer nicht entfernen, solange das Protokoll sie nennt.
        assertThatThrownBy(() -> exec("INSERT INTO fernwartung_zugang (art, name, public_key, tunnel_adresse, "
                + "angelegt_von, geaendert_von) VALUES ('techniker', 'Neu', '" + KEY_GESPERRT
                + "', '10.10.32.9/32', 'admin', 'admin')")).hasMessageContaining("public_key");
        assertThatThrownBy(() -> exec("INSERT INTO fernwartung_zugang (art, name, public_key, tunnel_adresse, "
                + "angelegt_von, geaendert_von) VALUES ('techniker', 'Neu', '" + KEY_NEU
                + "', '10.10.32.2/32', 'admin', 'admin')")).hasMessageContaining("tunnel_adresse");
        assertThatThrownBy(() -> exec("DELETE FROM fernwartung_zugang WHERE id = '" + GESPERRT + "'"))
                .hasMessageContaining("foreign key");
        assertThatThrownBy(() -> exec("DELETE FROM fernwartung_protokoll WHERE techniker_id = '" + GESPERRT + "'"))
                .hasMessageContaining("append-only");

        // 7. Die anderen Zugänge sind unberührt, Sperren und Entsperren gehen weiter.
        assertThatCode(() -> {
            exec("UPDATE fernwartung_zugang SET status = 'gesperrt' WHERE id = '" + AKTIV + "'");
            exec("UPDATE fernwartung_zugang SET status = 'aktiv' WHERE id = '" + AKTIV + "'");
            exec("UPDATE fernwartung_zugang SET status = 'aktiv' WHERE id = '" + BOX + "'");
        }).doesNotThrowAnyException();
        assertThat(wert("SELECT string_agg(f.grund || ' · ' || t.name, ',') FROM fernwartung_fenster f "
                + "JOIN fernwartung_zugang t ON t.id = f.techniker_id")).as("das Fenster nennt ihn weiter")
                .isEqualTo("Erster Einsatz · Max (Laptop)");
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

    /** Alle Fernwartungs-Zeilen als ein Text: was vor und nach der Migration gleich sein muss. */
    private String abbild() throws Exception {
        return wert("SELECT (SELECT string_agg(z::text, '|' ORDER BY z.id) FROM fernwartung_zugang z) || ' # ' "
                + "|| (SELECT string_agg(f::text, '|' ORDER BY f.id) FROM fernwartung_fenster f) || ' # ' "
                + "|| (SELECT string_agg(p::text, '|' ORDER BY p.id) FROM fernwartung_protokoll p)");
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
}
