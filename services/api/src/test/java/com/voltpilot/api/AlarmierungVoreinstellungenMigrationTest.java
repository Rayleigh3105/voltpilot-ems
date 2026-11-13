package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

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
 * Die Migration V20261113160000 (Kunden-Alarmierung P2, Voreinstellungen) auf einer Datenbank AM AKTUELLEN STAND: die
 * Alarmierung ist ausgeliefert und trägt Konten mit und ohne eigene Einstellungen, wenn diese Migration ankommt.
 *
 * <p>Geprüft wird der Nachtrag für den Bestand: KA-1 A (jedes Kundenkonto mit Adresse und ohne eigenen Weg bekommt den
 * Weg mit seiner Anmelde-Adresse; wer schon einen hat - bestätigt oder abgeschaltet - bleibt unberührt), KA-3 A (ein
 * Probelauf, den niemand gewählt hat, endet) und KA-5 A (Regeln ab Werk nennen auch Bearbeiter und Bedienberechtigt,
 * der Preis-Hinweis bleibt). Und: ein zweiter Lauf derselben Datei ändert nichts.
 *
 * <p>Frischer Container, ohne Spring; ohne Docker übersprungen.
 */
@Testcontainers(disabledWithoutDocker = true)
class AlarmierungVoreinstellungenMigrationTest {

    private static final String STAND_VORHER = "20261112153000";
    private static final String VERSION = "20261113160000";
    private static final String MIGRATION = "/db/migration/V20261113160000__alarmierung_voreinstellungen.sql";

    private static final String KB = "a0000000-0000-4000-8000-000000000001";

    @Container
    final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Test
    void derBestandBekommtDieVoreinstellungenOhneEigeneEinstellungenZuUeberschreiben() throws Exception {
        // 1. Der Stand vor dieser Migration, mit Konten aus dem Betrieb.
        flyway().target(STAND_VORHER).load().migrate();
        assertThat(angewandt(VERSION)).isFalse();
        exec("INSERT INTO tenant (id, name) VALUES ('" + KB + "', 'Bestand GmbH')");
        konto("sub-ohne-weg", "benutzer", "aktiv", "'ohne@example.test'");
        konto("sub-angelegt", "benutzer", "angelegt", "' angelegt@example.test '");
        konto("sub-eigen", "benutzer", "aktiv", "'anmeldung@example.test'");
        konto("sub-abgeschaltet", "benutzer", "aktiv", "'aus@example.test'");
        konto("sub-unbestaetigt", "benutzer", "aktiv", "'konto@example.test'");
        konto("sub-entfernt", "benutzer", "entfernt", "'weg@example.test'");
        konto("sub-ohne-adresse", "benutzer", "aktiv", "NULL");
        konto("sub-partner", "partner", "aktiv", "'partner@example.test'");
        exec("INSERT INTO zustellweg (tenant_id, benutzer_sub, weg, ziel, bestaetigt_am, aktiv, ab_schwere) VALUES "
                + "('" + KB + "', 'sub-eigen', 'email', 'eigen@example.test', now() - interval '3 days', true, 'dringend'), "
                + "('" + KB + "', 'sub-abgeschaltet', 'email', 'aus@example.test', now() - interval '3 days', false, 'warnung'), "
                + "('" + KB + "', 'sub-unbestaetigt', 'email', 'andere@example.test', NULL, true, 'warnung')");
        regel("b0000000-0000-4000-8000-000000000001", "box.erreichbar", "ab_werk", "warnung",
                "[{\"rolle\":\"kundenadministrator\"},{\"rolle\":\"energiemanager\"}]", "NULL");
        regel("b0000000-0000-4000-8000-000000000002", "anlage.preis.jetzt", "ab_werk", "hinweis",
                "[{\"rolle\":\"kundenadministrator\"}]", "NULL");
        regel("b0000000-0000-4000-8000-000000000003", "anlage.netz.leistung", "eigen", "warnung",
                "[{\"person\":\"sub-eigen\"}]", "now() + interval '20 days'");
        regel("b0000000-0000-4000-8000-000000000004", "anlage.netz.leistung", "eigen", "warnung",
                "[{\"person\":\"sub-eigen\"}]", "NULL");
        String eigeneWegeVorher = wert("SELECT string_agg(benutzer_sub || '|' || ziel || '|' || aktiv || '|' || ab_schwere "
                + "|| '|' || coalesce(bestaetigt_am::text, '-'), ',' ORDER BY benutzer_sub) FROM zustellweg");

        // 2. Die Migration kommt an.
        flyway().target(VERSION).load().migrate();
        assertThat(angewandt(VERSION)).isTrue();

        // KA-1 A: wer keinen Weg hatte, hat jetzt den mit seiner Anmelde-Adresse (getrimmt), eingeschaltet, bestätigt.
        assertThat(wert("SELECT string_agg(benutzer_sub || '|' || ziel || '|' || aktiv || '|' || ab_schwere || '|' "
                + "|| (bestaetigt_am IS NOT NULL), ',' ORDER BY benutzer_sub) FROM zustellweg WHERE herkunft = 'anmeldung'"))
                .isEqualTo("sub-angelegt|angelegt@example.test|true|warnung|true,"
                        + "sub-ohne-weg|ohne@example.test|true|warnung|true");
        // Wer schon einen Weg hatte - bestätigt, abgeschaltet oder unbestätigt -, behält ihn unverändert.
        assertThat(wert("SELECT string_agg(benutzer_sub || '|' || ziel || '|' || aktiv || '|' || ab_schwere "
                + "|| '|' || coalesce(bestaetigt_am::text, '-'), ',' ORDER BY benutzer_sub) FROM zustellweg "
                + "WHERE herkunft = 'eigen'")).isEqualTo(eigeneWegeVorher);
        // Entfernte Konten, Konten ohne Adresse und Partner bekommen keinen.
        assertThat(wert("SELECT count(*)::text FROM zustellweg WHERE benutzer_sub IN "
                + "('sub-entfernt', 'sub-ohne-adresse', 'sub-partner')")).isEqualTo("0");
        // Jeder Weg hat einen eigenen Abmelde-Schlüssel.
        assertThat(wert("SELECT (count(*) = count(DISTINCT abmelde_token) AND min(length(abmelde_token)) = 64)::text "
                + "FROM zustellweg")).isEqualTo("true");

        // KA-3 A: der erzwungene Probelauf ist vorbei, die Marke sagt „nicht gewählt“.
        assertThat(wert("SELECT string_agg(id::text || '|' || coalesce(probelauf_bis::text, '-') || '|' "
                + "|| probelauf_gewaehlt, ',' ORDER BY id) FROM ueberwachung WHERE herkunft = 'eigen'"))
                .isEqualTo("b0000000-0000-4000-8000-000000000003|-|false,b0000000-0000-4000-8000-000000000004|-|false");

        // KA-5 A: die Box-Regel ab Werk nennt auch die Zuständigen am Standort, der Preis-Hinweis bleibt.
        assertThat(wert("SELECT empfaenger::text FROM ueberwachung WHERE id = 'b0000000-0000-4000-8000-000000000001'"))
                .isEqualTo("[{\"rolle\": \"kundenadministrator\"}, {\"rolle\": \"energiemanager\"}, "
                        + "{\"rolle\": \"bearbeiter\"}, {\"rolle\": \"bedienberechtigt\"}]");
        assertThat(wert("SELECT empfaenger::text FROM ueberwachung WHERE id = 'b0000000-0000-4000-8000-000000000002'"))
                .isEqualTo("[{\"rolle\": \"kundenadministrator\"}]");

        // 3. Wiederholbar: ein zweiter Lauf derselben Datei ändert nichts und bricht nicht - auch kein Probelauf, den
        //    jemand inzwischen selbst gewählt hat.
        exec("UPDATE ueberwachung SET probelauf_bis = now() + interval '30 days', probelauf_gewaehlt = true "
                + "WHERE id = 'b0000000-0000-4000-8000-000000000004'");
        String vorher = abbild();
        String sql = new String(Objects.requireNonNull(getClass().getResourceAsStream(MIGRATION), MIGRATION)
                .readAllBytes(), StandardCharsets.UTF_8).replace("${appDbUser}", "voltpilot_app");
        assertThatCode(() -> exec(sql)).doesNotThrowAnyException();
        assertThat(abbild()).isEqualTo(vorher);

        // 4. Ein Konto, das danach entsteht, bekommt den Weg sofort (Trigger), eins mit eigenem Weg behält ihn.
        konto("sub-neu", "benutzer", "aktiv", "'neu@example.test'");
        assertThat(wert("SELECT ziel || '|' || herkunft FROM zustellweg WHERE benutzer_sub = 'sub-neu'"))
                .isEqualTo("neu@example.test|anmeldung");
        exec("UPDATE benutzer SET email = 'umgezogen@example.test' WHERE sub IN ('sub-neu', 'sub-eigen')");
        assertThat(wert("SELECT string_agg(benutzer_sub || '|' || ziel, ',' ORDER BY benutzer_sub) FROM zustellweg "
                + "WHERE benutzer_sub IN ('sub-neu', 'sub-eigen')"))
                .isEqualTo("sub-eigen|eigen@example.test,sub-neu|umgezogen@example.test");
    }

    private void konto(String sub, String konto, String zustand, String emailSql) throws Exception {
        exec("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, email, zustand) VALUES ('" + KB + "', '" + sub
                + "', '" + konto + "', '" + sub + "', " + emailSql + ", '" + zustand + "')");
    }

    private void regel(String id, String wertart, String herkunft, String schwere, String empfaenger,
            String probelaufBisSql) throws Exception {
        exec("INSERT INTO ueberwachung (id, tenant_id, wertart, bezug, bedingung, schwere, empfaenger, herkunft, "
                + "angelegt_von, probelauf_bis) VALUES ('" + id + "', '" + KB + "', '" + wertart
                + "', jsonb_build_object('anlage', '" + id + "'), '{\"art\":\"zustand\"}'::jsonb, '" + schwere + "', '"
                + empfaenger + "'::jsonb, '" + herkunft + "', 'system', " + probelaufBisSql + ")");
    }

    private String abbild() throws Exception {
        return wert("SELECT (SELECT string_agg(z::text, '|' ORDER BY z.id) FROM zustellweg z) || ' # ' "
                + "|| (SELECT string_agg(u::text, '|' ORDER BY u.id) FROM ueberwachung u)");
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
