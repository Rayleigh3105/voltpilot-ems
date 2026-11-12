package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.Statement;
import java.sql.ResultSet;
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
 * Die Migration V20261112100000 (S1, vp-mastr-mehrere-einheiten-konzept): die
 * Rückfüllung aus `asset.registry_unit_id` nach `register_einheit` /
 * `einheit_flaeche` auf einer Datenbank AM STAND DAVOR mit echtem Bestand.
 *
 * <p>Geprüft wird das Übergangsversprechen aus report.md Abschnitt 5.4: Datum
 * und Module werden immer übernommen; die Leistung NUR, wenn an der Anlage
 * keine Erzeuger-Komponente mit eigener kWp hängt (sonst ist
 * {@code asset.pv_capacity_kwp} schon die Summe, nicht die Leistung EINER
 * Einheit) - und dass die migrierte Leistung für den unveränderten
 * Ein-Einheit-Fall byte-gleich der heutigen Zahl ist ("Rechnung bleibt
 * gleich"). Nichts an {@code asset} oder am Bestand ändert sich; ein
 * zweiter Lauf der Rückfüllung ist ein No-op (ON CONFLICT DO NOTHING).
 *
 * <p>Frischer Container, ohne Spring; ohne Docker übersprungen.
 */
@Testcontainers(disabledWithoutDocker = true)
class RegisterEinheitMigrationTest {

    private static final String STAND_VORHER = "20261112080000";
    private static final String VERSION = "20261112100000";
    private static final String MIGRATION = "/db/migration/V20261112100000__register_einheit.sql";

    private static final String TENANT = "a1000000-0000-4000-8000-000000000011";
    private static final String SITE_EINFACH = "a2000000-0000-4000-8000-000000000011";
    private static final String SITE_MIT_KOMPONENTE = "a2000000-0000-4000-8000-000000000012";
    private static final String SITE_SPEICHER = "a2000000-0000-4000-8000-000000000013";
    private static final String SITE_OHNE_REGISTER = "a2000000-0000-4000-8000-000000000014";

    @Container
    final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Test
    void einfacheAnlageBekommtEineEinheitMitLeistungUndFlaecheByteGleichDerHeutigenZahl() throws Exception {
        flyway().target(STAND_VORHER).load().migrate();
        exec("INSERT INTO tenant (id, name) VALUES ('" + TENANT + "', 'Kunde Probe')");
        exec("INSERT INTO site (id, tenant_id, name) VALUES ('" + SITE_EINFACH + "', '" + TENANT + "', 'Hof Sonnenfeld')");
        exec("INSERT INTO asset (tenant_id, site_id, type, pv_capacity_kwp, module_count, azimuth_deg, tilt_deg, "
                + "commissioned_on, registry, registry_unit_id, registry_fetched_at) VALUES ('" + TENANT + "', '"
                + SITE_EINFACH + "', 'pv', 8.4, 20, 180, 30, '2014-06-01', 'mastr', 'SEE123456789012', now())");

        flyway().target(VERSION).load().migrate();
        assertThat(angewandt(VERSION)).isTrue();

        assertThat(wert("SELECT count(*) FROM register_einheit WHERE site_id = '" + SITE_EINFACH + "'")).isEqualTo("1");
        assertThat(wert("SELECT art FROM register_einheit WHERE site_id = '" + SITE_EINFACH + "'")).isEqualTo("pv");
        assertThat(wert("SELECT registry_unit_id FROM register_einheit WHERE site_id = '" + SITE_EINFACH + "'"))
                .isEqualTo("SEE123456789012");
        assertThat(wert("SELECT inbetriebnahme::text FROM register_einheit WHERE site_id = '" + SITE_EINFACH + "'"))
                .isEqualTo("2014-06-01");
        assertThat(wert("SELECT r_module::text FROM register_einheit WHERE site_id = '" + SITE_EINFACH + "'"))
                .isEqualTo("20");
        // Rechnung bleibt gleich: die migrierte Leistung ist byte-gleich der
        // heutigen Summen-Zeile (keine Komponente an dieser Anlage).
        assertThat(wert("SELECT re.leistung_kwp::text FROM register_einheit re WHERE re.site_id = '" + SITE_EINFACH + "'"))
                .isEqualTo(wert("SELECT pv_capacity_kwp::text FROM asset WHERE site_id = '" + SITE_EINFACH + "' AND type = 'pv'"));
        assertThat(wert("SELECT bestaetigt_von FROM register_einheit WHERE site_id = '" + SITE_EINFACH + "'"))
                .isNotNull();

        // Richtung und Neigung sind bekannt UND die Leistung ist bekannt: eine Fläche.
        assertThat(wert("SELECT count(*) FROM einheit_flaeche ef JOIN register_einheit re ON re.id = ef.einheit_id "
                + "WHERE re.site_id = '" + SITE_EINFACH + "'")).isEqualTo("1");
        assertThat(wert("SELECT richtung_grad::text FROM einheit_flaeche ef JOIN register_einheit re ON re.id = ef.einheit_id "
                + "WHERE re.site_id = '" + SITE_EINFACH + "'")).isEqualTo("180.0");
        assertThat(wert("SELECT quelle FROM einheit_flaeche ef JOIN register_einheit re ON re.id = ef.einheit_id "
                + "WHERE re.site_id = '" + SITE_EINFACH + "'")).isEqualTo("register");

        // Nichts an der Summen-Zeile ändert sich.
        assertThat(wert("SELECT pv_capacity_kwp::text FROM asset WHERE site_id = '" + SITE_EINFACH + "' AND type = 'pv'"))
                .isEqualTo("8.400");
    }

    @Test
    void mitZusaetzlicherErzeugerKomponenteBleibtDieLeistungLeerStattGeratenZuSein() throws Exception {
        flyway().target(STAND_VORHER).load().migrate();
        exec("INSERT INTO tenant (id, name) VALUES ('" + TENANT + "', 'Kunde Probe')");
        exec("INSERT INTO site (id, tenant_id, name) VALUES ('" + SITE_MIT_KOMPONENTE + "', '" + TENANT + "', 'Hof Zwei Dächer')");
        // asset.pv_capacity_kwp ist hier schon die SUMME (Haupteinheit + Zusatz-Erzeuger) -
        // nicht die Leistung EINER Einheit (Abschnitt 5.4 des Konzepts).
        exec("INSERT INTO asset (tenant_id, site_id, type, pv_capacity_kwp, azimuth_deg, tilt_deg, "
                + "commissioned_on, registry, registry_unit_id, registry_fetched_at) VALUES ('" + TENANT + "', '"
                + SITE_MIT_KOMPONENTE + "', 'pv', 14.7, 180, 30, '2014-06-01', 'mastr', 'SEE223456789012', now())");
        exec("INSERT INTO measurement_point (id, tenant_id, site_id, role, label, capacity_kwp) VALUES "
                + "(gen_random_uuid(), '" + TENANT + "', '" + SITE_MIT_KOMPONENTE + "', 'pv-generation', "
                + "'Wechselrichter Garage', 6.3)");

        flyway().target(VERSION).load().migrate();

        assertThat(wert("SELECT count(*) FROM register_einheit WHERE site_id = '" + SITE_MIT_KOMPONENTE + "'")).isEqualTo("1");
        // Datum wird übernommen, die Leistung NICHT - geraten wäre falscher als keine.
        assertThat(wert("SELECT inbetriebnahme::text FROM register_einheit WHERE site_id = '" + SITE_MIT_KOMPONENTE + "'"))
                .isEqualTo("2014-06-01");
        assertThat(istNull("SELECT leistung_kwp FROM register_einheit WHERE site_id = '" + SITE_MIT_KOMPONENTE + "'")).isTrue();
        assertThat(istNull("SELECT r_leistung_kwp FROM register_einheit WHERE site_id = '" + SITE_MIT_KOMPONENTE + "'")).isTrue();
        // Keine Fläche ohne bekannte Leistung (anteil_kwp verlangt > 0).
        assertThat(wert("SELECT count(*) FROM einheit_flaeche ef JOIN register_einheit re ON re.id = ef.einheit_id "
                + "WHERE re.site_id = '" + SITE_MIT_KOMPONENTE + "'")).isEqualTo("0");
    }

    @Test
    void speicherBekommtEineEinheitMitDenSpeicherwerten() throws Exception {
        flyway().target(STAND_VORHER).load().migrate();
        exec("INSERT INTO tenant (id, name) VALUES ('" + TENANT + "', 'Kunde Probe')");
        exec("INSERT INTO site (id, tenant_id, name) VALUES ('" + SITE_SPEICHER + "', '" + TENANT + "', 'Hof Speicher')");
        exec("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_discharge_kw, max_charge_kw, "
                + "commissioned_on, registry, registry_unit_id, registry_fetched_at) VALUES ('" + TENANT + "', '"
                + SITE_SPEICHER + "', 'battery', 7.68, 5.0, 5.0, '2024-01-01', 'mastr', 'SEE333456789012', now())");

        flyway().target(VERSION).load().migrate();

        assertThat(wert("SELECT art FROM register_einheit WHERE site_id = '" + SITE_SPEICHER + "'")).isEqualTo("speicher");
        assertThat(wert("SELECT speicher_kwh::text FROM register_einheit WHERE site_id = '" + SITE_SPEICHER + "'"))
                .isEqualTo("7.680");
        assertThat(wert("SELECT speicher_kw::text FROM register_einheit WHERE site_id = '" + SITE_SPEICHER + "'"))
                .isEqualTo("5.000");
    }

    @Test
    void anlageOhneRegisternummerBekommtKeineEinheit() throws Exception {
        flyway().target(STAND_VORHER).load().migrate();
        exec("INSERT INTO tenant (id, name) VALUES ('" + TENANT + "', 'Kunde Probe')");
        exec("INSERT INTO site (id, tenant_id, name) VALUES ('" + SITE_OHNE_REGISTER + "', '" + TENANT + "', 'Hof Ohne Register')");
        exec("INSERT INTO asset (tenant_id, site_id, type, pv_capacity_kwp) VALUES ('" + TENANT + "', '"
                + SITE_OHNE_REGISTER + "', 'pv', 5.0)");

        flyway().target(VERSION).load().migrate();

        assertThat(wert("SELECT count(*) FROM register_einheit WHERE site_id = '" + SITE_OHNE_REGISTER + "'")).isEqualTo("0");
    }

    @Test
    void einZweiterLaufDerRueckfuellungAendertNichts() throws Exception {
        flyway().target(STAND_VORHER).load().migrate();
        exec("INSERT INTO tenant (id, name) VALUES ('" + TENANT + "', 'Kunde Probe')");
        exec("INSERT INTO site (id, tenant_id, name) VALUES ('" + SITE_EINFACH + "', '" + TENANT + "', 'Hof Sonnenfeld')");
        exec("INSERT INTO asset (tenant_id, site_id, type, pv_capacity_kwp, azimuth_deg, tilt_deg, "
                + "commissioned_on, registry, registry_unit_id, registry_fetched_at) VALUES ('" + TENANT + "', '"
                + SITE_EINFACH + "', 'pv', 8.4, 180, 30, '2014-06-01', 'mastr', 'SEE123456789012', now())");
        flyway().target(VERSION).load().migrate();
        assertThat(wert("SELECT count(*) FROM register_einheit WHERE site_id = '" + SITE_EINFACH + "'")).isEqualTo("1");

        String sql = new String(Objects.requireNonNull(getClass().getResourceAsStream(MIGRATION), MIGRATION)
                .readAllBytes(), StandardCharsets.UTF_8).replace("${appDbUser}", "voltpilot_app");
        assertThatCode(() -> exec(sql)).doesNotThrowAnyException();

        assertThat(wert("SELECT count(*) FROM register_einheit WHERE site_id = '" + SITE_EINFACH + "'")).isEqualTo("1");
        assertThat(wert("SELECT count(*) FROM einheit_flaeche ef JOIN register_einheit re ON re.id = ef.einheit_id "
                + "WHERE re.site_id = '" + SITE_EINFACH + "'")).isEqualTo("1");
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

    private boolean istNull(String sql) throws Exception {
        try (Connection c = POSTGRES.createConnection("");
                Statement s = c.createStatement();
                ResultSet rs = s.executeQuery(sql)) {
            rs.next();
            return rs.getObject(1) == null;
        }
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
