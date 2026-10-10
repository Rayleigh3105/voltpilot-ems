package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.voltpilot.api.fernwartung.SshTestSchluessel;
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
 * Die Migration V20261009074500 (SSH-Schlüssel am Techniker-Zugang) auf einer
 * Datenbank AM STAND VON MAIN: die Fernwartung ist ausgeliefert
 * (V20261007163700, V20261008213500) und trägt Zeilen - Boxen, aktive,
 * gesperrte und gelöschte Zugänge, Fenster, Protokoll -, wenn diese Migration
 * ankommt. Die frische Datenbank in Versionsreihenfolge deckt
 * {@code FernwartungApiTest} ab.
 *
 * <p>Geprüft wird: keine bestehende Zeile ändert sich, jedes ältere
 * Protokollwort bleibt gültig, die neue Spalte hält ihre Regeln an der
 * Datenbankgrenze, und die Rechte bleiben, wie sie waren.
 *
 * <p>Frischer Container, ohne Spring; ohne Docker übersprungen.
 */
@Testcontainers(disabledWithoutDocker = true)
class FernwartungSshSchluesselMigrationTest {

    private static final String STAND_VORHER = "20261008213500";
    private static final String VERSION = "20261009074500";
    private static final String MIGRATION = "/db/migration/V20261009074500__fernwartung_ssh_schluessel.sql";

    private static final String BOX = "11111111-1111-4111-8111-111111111111";
    private static final String AKTIV = "22222222-2222-4222-8222-222222222222";
    private static final String GESPERRT = "33333333-3333-4333-8333-333333333333";
    private static final String GELOESCHT = "44444444-4444-4444-8444-444444444444";

    private static final String KEY_BOX = "jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM=";
    private static final String KEY_AKTIV = "FY4LLXFaOvh8LPZu/gA4AeS2WJjXkuOUPB4hlxBI8/Y=";
    private static final String KEY_GESPERRT = "Pgf4aS+67rz4HdSHuy8KKgm5e/UP3xnrMWJskXaZB9c=";
    private static final String KEY_GELOESCHT = "dTkajHaCSCVbnmtc9YaXOW4Fvi51HANh0Fg2KTFV3kk=";

    private static final String[] AELTERE_AKTIONEN = {"box_schluessel_hinterlegt", "box_schluessel_getauscht",
        "box_gesperrt", "box_entsperrt", "techniker_angelegt", "techniker_gesperrt", "techniker_entsperrt",
        "techniker_geloescht", "fenster_geoeffnet", "fenster_geschlossen"};

    @Container
    final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Test
    void dieMigrationKommtAufEinerBenutztenDatenbankAnUndHaeltDieSchluesselregel() throws Exception {
        // 1. Der Stand von main, mit Zeilen aus dem Betrieb.
        flyway().target(STAND_VORHER).load().migrate();
        assertThat(angewandt(VERSION)).isFalse();
        exec("INSERT INTO fernwartung_zugang (id, art, edge_ref, public_key, tunnel_adresse, status, "
                + "angelegt_von, geaendert_von) VALUES ('" + BOX + "', 'box', 'edge-zay5sdd', '" + KEY_BOX
                + "', '10.10.16.2/32', 'aktiv', 'admin', 'admin')");
        exec("INSERT INTO fernwartung_zugang (id, art, name, public_key, tunnel_adresse, status, "
                + "angelegt_von, geaendert_von) VALUES "
                + "('" + AKTIV + "', 'techniker', 'Max (Laptop)', '" + KEY_AKTIV + "', '10.10.32.2/32', "
                + "'aktiv', 'admin', 'admin'), "
                + "('" + GESPERRT + "', 'techniker', 'Werkstatt-Tablet', '" + KEY_GESPERRT + "', '10.10.32.3/32', "
                + "'gesperrt', 'admin', 'admin'), "
                + "('" + GELOESCHT + "', 'techniker', 'Max (Laptop)', '" + KEY_GELOESCHT + "', '10.10.32.4/32', "
                + "'gesperrt', 'admin', 'admin')");
        exec("UPDATE fernwartung_zugang SET status = 'geloescht' WHERE id = '" + GELOESCHT + "'");
        exec("INSERT INTO fernwartung_fenster (box_id, techniker_id, grund, beginn, ende, geoeffnet_von) "
                + "VALUES ('" + BOX + "', '" + AKTIV + "', 'Update auf Stufe 2', now() - interval '10 minutes', "
                + "now() + interval '50 minutes', 'admin')");
        for (String aktion : AELTERE_AKTIONEN) {
            exec("INSERT INTO fernwartung_protokoll (akteur, aktion, techniker_id) VALUES ('admin', '" + aktion
                    + "', '" + AKTIV + "')");
        }
        String vorher = abbild();

        // 2. Die Migration kommt an. Keine Zeile geht verloren oder ändert sich;
        //    die neue Spalte ist überall leer.
        flyway().load().migrate();
        assertThat(angewandt(VERSION)).isTrue();
        assertThat(abbild()).isEqualTo(vorher);
        assertThat(wert("SELECT count(*)::text || '/' || count(ssh_public_key)::text FROM fernwartung_zugang"))
                .isEqualTo("4/0");

        // 3. Wiederholbar: ein zweiter Lauf desselben SQL ändert nichts und bricht nicht.
        String sql = new String(Objects.requireNonNull(getClass().getResourceAsStream(MIGRATION), MIGRATION)
                .readAllBytes(), StandardCharsets.UTF_8);
        assertThatCode(() -> exec(sql)).doesNotThrowAnyException();
        assertThat(abbild()).isEqualTo(vorher);

        // 4. Ein Techniker-Zugang trägt einen RSA-Schlüssel in Normalform - aktiv wie gesperrt,
        //    und zwei Zugänge dürfen denselben tragen.
        String rsa = SshTestSchluessel.rsa(2048);
        String rsa4096 = SshTestSchluessel.rsa(4096);
        exec("UPDATE fernwartung_zugang SET ssh_public_key = '" + rsa + "' WHERE id IN ('" + AKTIV + "', '"
                + GESPERRT + "')");
        exec("UPDATE fernwartung_zugang SET ssh_public_key = '" + rsa4096 + "' WHERE id = '" + GESPERRT + "'");
        assertThat(wert("SELECT ssh_public_key FROM fernwartung_zugang WHERE id = '" + AKTIV + "'")).isEqualTo(rsa);

        // 5. Was die Spalte nicht annimmt.
        assertThatThrownBy(() -> exec("UPDATE fernwartung_zugang SET ssh_public_key = '" + rsa + "' WHERE id = '"
                + BOX + "'")).as("eine Box trägt keinen SSH-Schlüssel")
                .hasMessageContaining("fernwartung_zugang_ssh_art_chk");
        for (String unform : new String[] {rsa + " max@laptop", "restrict " + rsa, SshTestSchluessel.ed25519(),
                SshTestSchluessel.rsa(1024), rsa + "\n" + rsa, rsa + "\n", "ssh-rsa ", "",
                "ssh-rsa AAAAC3NzaC1lZDI1NTE5" + rsa.substring(28)}) {
            assertThatThrownBy(() -> exec("UPDATE fernwartung_zugang SET ssh_public_key = '" + unform
                    + "' WHERE id = '" + AKTIV + "'")).as(unform.length() > 30 ? unform.substring(0, 30) : unform)
                    .hasMessageContaining("fernwartung_zugang_ssh_form_chk");
        }

        // 6. Ein gelöschter Zugang ändert sich weiter nie; ein gesperrter nimmt seinen
        //    Schlüssel mit in den Zustand gelöscht.
        assertThatThrownBy(() -> exec("UPDATE fernwartung_zugang SET ssh_public_key = '" + rsa + "' WHERE id = '"
                + GELOESCHT + "'")).hasMessageContaining("endgueltig");
        exec("UPDATE fernwartung_zugang SET status = 'geloescht' WHERE id = '" + GESPERRT + "'");
        assertThat(wert("SELECT ssh_public_key FROM fernwartung_zugang WHERE id = '" + GESPERRT + "'"))
                .isEqualTo(rsa4096);
        assertThatThrownBy(() -> exec("UPDATE fernwartung_zugang SET ssh_public_key = NULL WHERE id = '"
                + GESPERRT + "'")).hasMessageContaining("endgueltig");

        // 7. Das Protokoll kennt die neuen Wörter und jedes ältere; es bleibt append-only.
        for (String aktion : new String[] {"techniker_ssh_schluessel_gesetzt", "techniker_ssh_schluessel_entfernt",
                "techniker_angelegt", "fenster_geoeffnet"}) {
            exec("INSERT INTO fernwartung_protokoll (akteur, aktion, techniker_id) VALUES ('admin', '" + aktion
                    + "', '" + AKTIV + "')");
        }
        assertThatThrownBy(() -> exec("INSERT INTO fernwartung_protokoll (akteur, aktion) VALUES ('admin', "
                + "'techniker_ssh_schluessel_geaendert')")).hasMessageContaining("fernwartung_protokoll_aktion_chk");
        assertThatThrownBy(() -> exec("DELETE FROM fernwartung_protokoll WHERE aktion = "
                + "'techniker_ssh_schluessel_gesetzt'")).hasMessageContaining("append-only");
        assertThat(wert("SELECT count(*)::text FROM fernwartung_protokoll")).isEqualTo(
                String.valueOf(AELTERE_AKTIONEN.length + 4));

        // 8. Rechte: die Admin-Rolle schreibt die Spalte über ihr Tabellenrecht, die
        //    App-Rolle (der Kunden-Datenpfad) sieht sie nicht; DELETE hat niemand bekommen.
        assertThat(wert("SELECT (has_column_privilege('voltpilot_admin', 'fernwartung_zugang', 'ssh_public_key', "
                + "'SELECT') AND has_column_privilege('voltpilot_admin', 'fernwartung_zugang', 'ssh_public_key', "
                + "'UPDATE'))::text")).isEqualTo("true");
        assertThat(wert("SELECT (has_column_privilege('voltpilot_app', 'fernwartung_zugang', 'ssh_public_key', "
                + "'SELECT') OR has_column_privilege('voltpilot_app', 'fernwartung_zugang', 'ssh_public_key', "
                + "'UPDATE'))::text")).isEqualTo("false");
        assertThat(wert("SELECT has_table_privilege('voltpilot_admin', 'fernwartung_zugang', 'DELETE')::text"))
                .isEqualTo("false");
        assertThat(wert("SELECT (relrowsecurity AND relforcerowsecurity)::text FROM pg_class "
                + "WHERE relname = 'fernwartung_zugang'")).isEqualTo("true");
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

    /**
     * Alle Fernwartungs-Zeilen als ein Text, ohne die neue Spalte: was vor und
     * nach der Migration gleich sein muss.
     */
    private String abbild() throws Exception {
        return wert("SELECT (SELECT string_agg((to_jsonb(z) - 'ssh_public_key')::text, '|' ORDER BY z.id) "
                + "FROM fernwartung_zugang z) || ' # ' "
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
