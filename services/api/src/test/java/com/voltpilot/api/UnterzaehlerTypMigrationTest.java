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
 * Die Migration V20261107120000 (Unterverteilungen, Konzept vp-unterzaehler-anzeige C1) auf einer
 * Datenbank AM AKTUELLEN STAND - der Fall Schramm „Zuhause“: zwei Shelly Pro 3EM als
 * {@code generic-load} („UV Halle“, „UV Keller“) und der Shelly Pro 3EM-400 auf der komponierten
 * {@code grid-meter}-Zeile, alle nur mit {@code power_kw}.
 *
 * <p>Geprüft wird der enge Zaun: genau die Shelly-Zähler werden {@code sub-meter} bzw. bekommen die
 * Zählerkanäle; ein steuerbarer {@code generic-load}, ein Verbraucher über ein anderes Gerät und ein
 * Netz-Zähler ohne Shelly bleiben byte-gleich. Ein zweiter Lauf ändert nichts.
 *
 * <p>Frischer Container, ohne Spring; ohne Docker übersprungen.
 */
@Testcontainers(disabledWithoutDocker = true)
class UnterzaehlerTypMigrationTest {

    private static final String STAND_VORHER = "20261106170000";
    private static final String VERSION = "20261107120000";
    private static final String MIGRATION = "/db/migration/V20261107120000__unterzaehler_typ.sql";

    private static final String TENANT = "11111111-1111-4111-8111-111111111111";
    private static final String SITE = "22222222-2222-4222-8222-222222222222";
    private static final String SITE_ANDERS = "22222222-2222-4222-8222-333333333333";
    private static final String HALLE = "33333333-3333-4333-8333-000000000001";
    private static final String KELLER = "33333333-3333-4333-8333-000000000002";
    private static final String NETZ = "33333333-3333-4333-8333-000000000003";
    private static final String HEIZSTAB_SHELLY = "33333333-3333-4333-8333-000000000004";
    private static final String GOE = "33333333-3333-4333-8333-000000000005";
    private static final String NETZ_ANDERS = "33333333-3333-4333-8333-000000000006";

    private static final String NUR_LEISTUNG = "{\"measure\": [{\"unit\": \"kW\", \"channel\": \"power_kw\"}]}";

    @Container
    final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Test
    void shellyZaehlerWerdenUnterzaehlerUndDerNetzZaehlerBekommtSeineKanaele() throws Exception {
        flyway().target(STAND_VORHER).load().migrate();
        assertThat(angewandt(VERSION)).isFalse();
        exec("INSERT INTO tenant (id, name) VALUES ('" + TENANT + "', 'Kunde Probe')");
        exec("INSERT INTO site (id, tenant_id, name) VALUES ('" + SITE + "', '" + TENANT + "', 'Zuhause')");
        exec("INSERT INTO site (id, tenant_id, name) VALUES ('" + SITE_ANDERS + "', '" + TENANT + "', 'Andere')");
        punkt(HALLE, SITE, "consumer", "UV Halle", "generic-load", "shelly_em_http", false, NUR_LEISTUNG);
        // Ein Unterzähler mit einem dazu gepflegten Kanal: der bleibt hinten stehen.
        punkt(KELLER, SITE, "consumer", "UV Keller", "generic-load", "shelly_em_http", false,
                "{\"measure\": [{\"unit\": \"kW\", \"channel\": \"power_kw\"}, "
                        + "{\"unit\": \"V\", \"channel\": \"voltage_l1_v\"}]}");
        punkt(NETZ, SITE, "grid-meter", "Netzanschluss", "grid-meter", "shelly_em_http", false, NUR_LEISTUNG);
        // Nicht im Zaun: ein steuerbarer Verbraucher über einen Shelly-Zähler (actuate), ein
        // Verbraucher über go-e, ein Netz-Zähler ohne Shelly.
        punkt(HEIZSTAB_SHELLY, SITE, "consumer", "Steuerbar", "generic-load", "shelly_em_http", true,
                "{\"measure\": [{\"unit\": \"kW\", \"channel\": \"power_kw\"}], "
                        + "\"actuate\": [{\"command\": \"on_off\"}]}");
        punkt(GOE, SITE, "consumer", "Wallbox", "generic-load", "goe_http_api", false, NUR_LEISTUNG);
        punkt(NETZ_ANDERS, SITE_ANDERS, "grid-meter", "Netz", "grid-meter", "sunspec_tcp", false, NUR_LEISTUNG);
        String unberuehrt = abbild(HEIZSTAB_SHELLY, GOE, NETZ_ANDERS);

        flyway().target(VERSION).load().migrate();
        assertThat(angewandt(VERSION)).isTrue();

        assertThat(wert("SELECT entity_type FROM measurement_point WHERE id = '" + HALLE + "'")).isEqualTo("sub-meter");
        assertThat(kanaele(HALLE)).isEqualTo(
                "power_kw:kW,energy_kwh:kWh,energy_export_kwh:kWh,power_l1_kw:kW,power_l2_kw:kW,power_l3_kw:kW");
        assertThat(kanaele(KELLER)).isEqualTo("power_kw:kW,energy_kwh:kWh,energy_export_kwh:kWh,power_l1_kw:kW,"
                + "power_l2_kw:kW,power_l3_kw:kW,voltage_l1_v:V");
        assertThat(wert("SELECT entity_type || '/' || control FROM measurement_point WHERE id = '" + KELLER + "'"))
                .isEqualTo("sub-meter/false");
        assertThat(wert("SELECT entity_type FROM measurement_point WHERE id = '" + NETZ + "'")).isEqualTo("grid-meter");
        assertThat(kanaele(NETZ)).isEqualTo(
                "power_kw:kW,energy_kwh:kWh,energy_export_kwh:kWh,power_l1_kw:kW,power_l2_kw:kW,power_l3_kw:kW");
        assertThat(abbild(HEIZSTAB_SHELLY, GOE, NETZ_ANDERS)).isEqualTo(unberuehrt);

        // Wiederholbar: ein zweiter Lauf desselben SQL ändert nichts und bricht nicht.
        String vorher = abbild(HALLE, KELLER, NETZ, HEIZSTAB_SHELLY, GOE, NETZ_ANDERS);
        String sql = new String(Objects.requireNonNull(getClass().getResourceAsStream(MIGRATION), MIGRATION)
                .readAllBytes(), StandardCharsets.UTF_8);
        assertThatCode(() -> exec(sql)).doesNotThrowAnyException();
        assertThat(abbild(HALLE, KELLER, NETZ, HEIZSTAB_SHELLY, GOE, NETZ_ANDERS)).isEqualTo(vorher);
    }

    private void punkt(String id, String site, String rolle, String name, String art, String kommunikation,
            boolean control, String caps) throws Exception {
        exec("INSERT INTO measurement_point (id, tenant_id, site_id, role, label, entity_type, communication, "
                + "connection_json, source_kind, control, capabilities, guard_config) VALUES ('" + id + "', '"
                + TENANT + "', '" + site + "', '" + rolle + "', '" + name + "', '" + art + "', '" + kommunikation
                + "', '{}'::jsonb, 'builtin', " + control + ", '" + caps + "'::jsonb, "
                + "'{\"failsafe\": {\"behavior\": \"measure-only\"}}'::jsonb)");
    }

    /** Die Messkanäle einer Zeile in ihrer Reihenfolge, als „kanal:einheit,…“. */
    private String kanaele(String id) throws Exception {
        return wert("SELECT string_agg((m ->> 'channel') || ':' || (m ->> 'unit'), ',' ORDER BY o) "
                + "FROM measurement_point p, jsonb_array_elements(p.capabilities -> 'measure') "
                + "WITH ORDINALITY AS e(m, o) WHERE p.id = '" + id + "'");
    }

    private String abbild(String... ids) throws Exception {
        return wert("SELECT string_agg(p::text, '|' ORDER BY p.id) FROM measurement_point p WHERE p.id IN ('"
                + String.join("','", ids) + "')");
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
