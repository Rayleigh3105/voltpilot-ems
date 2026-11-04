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
 * Die Migration V20261104190000 (die „Batterie mit eigenem BMS" ist aus dem Produkt entfernt) auf einer Datenbank
 * AM STAND DAVOR, die noch solche Batterien trägt: Komponente, Definition, Rollen-Zuordnung (die ausdrückliche
 * Speiser-Bindung), flow_claim, Bezugsgrößen-Kanalbindung und der generierte Lese-Flow.
 *
 * <p>Geprüft wird beides: Alles dieses Typs ist danach weg - und nichts anderes. Die Anlage bleibt lesbar, der
 * Hybrid-Speicher, der Selbstbau-Sensor und ein Kunden-Flow stehen unverändert da. Ein zweiter Lauf desselben SQL
 * ändert nichts, und eine Datenbank ohne solche Batterien durchläuft die Migration als No-op.
 *
 * <p>Frischer Container, ohne Spring; ohne Docker übersprungen.
 */
@Testcontainers(disabledWithoutDocker = true)
class BatterieEigenesBmsEntfernenMigrationTest {

    private static final String STAND_VORHER = "20261104160000";
    private static final String VERSION = "20261104190000";
    private static final String MIGRATION = "/db/migration/V20261104190000__batterie_eigenes_bms_entfernen.sql";

    private static final String TENANT = "a1000000-0000-4000-8000-000000000001";
    private static final String SITE = "a2000000-0000-4000-8000-000000000001";
    private static final String BATTERIE_MQTT = "b1000000-0000-4000-8000-000000000001";
    private static final String BATTERIE_HTTP = "b1000000-0000-4000-8000-000000000002";
    private static final String HYBRID = "b1000000-0000-4000-8000-000000000003";
    private static final String SELBSTBAU = "b1000000-0000-4000-8000-000000000004";
    private static final String BEZUG = "d1000000-0000-4000-8000-000000000001";
    private static final String UNTERNEHMEN = "e1000000-0000-4000-8000-000000000001";
    private static final String FLOW_MQTT = "c1000000-0000-4000-8000-000000000001";
    private static final String FLOW_HTTP = "c1000000-0000-4000-8000-000000000002";
    private static final String FLOW_KUNDE = "c1000000-0000-4000-8000-000000000003";

    @Container
    final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Test
    void dieMigrationRaeumtNurDieBatterienMitEigenemBmsAbUndLaesstDieAnlageLesbar() throws Exception {
        // 1. Der Stand vor der Migration, mit Bestand aus dem Betrieb.
        flyway().target(STAND_VORHER).load().migrate();
        assertThat(angewandt(VERSION)).isFalse();
        exec("INSERT INTO tenant (id, name) VALUES ('" + TENANT + "', 'Kunde Probe')");
        exec("INSERT INTO site (id, tenant_id, name) VALUES ('" + SITE + "', '" + TENANT + "', 'Anlage Probe')");
        punkt(BATTERIE_MQTT, "storage", "Batterie MQTT", "user-defined-battery", "mqtt_local");
        punkt(BATTERIE_HTTP, "storage", "Batterie HTTP", "user-defined-battery", "http_local");
        punkt(HYBRID, "battery-hybrid", "Hybrid-Speicher", "battery-hybrid", "solarman_v5");
        punkt(SELBSTBAU, "meter", "Selbstbau-Sensor", "modbus-generic", "modbus_baukasten");

        for (String id : new String[] {BATTERIE_MQTT, BATTERIE_HTTP, HYBRID}) {
            exec("INSERT INTO component_definition (entity_id, version, tenant_id, site_id, role, label, "
                    + "communication, source_kind, created_by) SELECT id, 1, tenant_id, site_id, role, label, "
                    + "communication, 'custom', 'kc-probe' FROM measurement_point WHERE id = '" + id + "'");
            exec("INSERT INTO entity_role_assignment (tenant_id, site_id, entity_id, capability, role, is_primary) "
                    + "VALUES ('" + TENANT + "', '" + SITE + "', '" + id + "', 'soc_pct', 'storage', true)");
        }
        exec("INSERT INTO flow_claim (entity_id, command, tenant_id, site_id, flow_id, flow_version, flow_name) "
                + "VALUES ('" + BATTERIE_MQTT + "', 'setpoint_kw', '" + TENANT + "', '" + SITE + "', '" + FLOW_MQTT
                + "', 1, 'Lesen'), ('" + HYBRID + "', 'setpoint_kw', '" + TENANT + "', '" + SITE + "', '"
                + FLOW_KUNDE + "', 1, 'Regel')");
        exec("INSERT INTO unternehmen (id, tenant_id, name) VALUES ('" + UNTERNEHMEN + "', '" + TENANT
                + "', 'Probe GmbH')");
        exec("INSERT INTO bezugsgroesse (id, tenant_id, kennzeichen, name, wertart, einheit, periode_art, "
                + "geltung_art, unternehmen_id) VALUES ('" + BEZUG + "', '" + TENANT + "', 'BZ-1', 'Zyklen', "
                + "'periodenwert', 'kg', 'monat', 'unternehmen', '" + UNTERNEHMEN + "')");
        exec("INSERT INTO bezugsgroesse_kanalbindung (tenant_id, bezugsgroesse_id, entity_id, kanal, wertart, "
                + "einheit, kadenz_s, von, actor_name, actor_art) VALUES ('" + TENANT + "', '" + BEZUG + "', '"
                + BATTERIE_MQTT + "', 'zyklen', 'counter', 'kWh', 60, '2026-10-01 00:00:00+00', 'kc-probe', "
                + "'kunde')");
        flow(FLOW_MQTT, "mqtt-device", "Batterie MQTT lesen");
        flow(FLOW_HTTP, "http-device", "Batterie HTTP lesen");
        flow(FLOW_KUNDE, "consumer-policy", "Regel des Kunden");
        String nachbarnVorher = nachbarn();
        assertThat(wert("SELECT count(*) FROM measurement_point WHERE entity_type = 'user-defined-battery'"))
                .isEqualTo("2");

        // 2. Die Migration kommt an.
        flyway().target(VERSION).load().migrate();
        assertThat(angewandt(VERSION)).isTrue();

        // Alles dieses Typs ist weg: Komponente, Definitionen, Rollen, Claim, generierte Flows.
        assertThat(wert("SELECT count(*) FROM measurement_point WHERE entity_type = 'user-defined-battery'"))
                .isEqualTo("0");
        assertThat(wert("SELECT count(*) FROM component_definition WHERE entity_id IN ('" + BATTERIE_MQTT + "', '"
                + BATTERIE_HTTP + "')")).isEqualTo("0");
        assertThat(wert("SELECT count(*) FROM entity_role_assignment WHERE entity_id IN ('" + BATTERIE_MQTT + "', '"
                + BATTERIE_HTTP + "')")).isEqualTo("0");
        assertThat(wert("SELECT count(*) FROM flow_claim WHERE entity_id = '" + BATTERIE_MQTT + "'")).isEqualTo("0");
        assertThat(wert("SELECT count(*) FROM bezugsgroesse_kanalbindung WHERE entity_id = '" + BATTERIE_MQTT + "'"))
                .isEqualTo("0");
        assertThat(wert("SELECT count(*) FROM bezugsgroesse WHERE id = '" + BEZUG + "'")).as("die Bezugsgröße bleibt")
                .isEqualTo("1");
        assertThat(wert("SELECT count(*) FROM flow_definition WHERE flow_id IN ('" + FLOW_MQTT + "', '" + FLOW_HTTP
                + "')")).isEqualTo("0");

        // Nichts anderes: die Anlage ist lesbar, Hybrid, Selbstbau-Sensor und der Kunden-Flow unverändert.
        assertThat(wert("SELECT count(*) FROM site WHERE id = '" + SITE + "'")).isEqualTo("1");
        assertThat(nachbarn()).isEqualTo(nachbarnVorher);

        // 3. Wiederholbar: ein zweiter Lauf desselben SQL ändert nichts und bricht nicht.
        String sql = new String(Objects.requireNonNull(getClass().getResourceAsStream(MIGRATION), MIGRATION)
                .readAllBytes(), StandardCharsets.UTF_8);
        assertThatCode(() -> exec(sql)).doesNotThrowAnyException();
        assertThat(nachbarn()).isEqualTo(nachbarnVorher);
    }

    @Test
    void ohneBatterienMitEigenemBmsIstDieMigrationEinNoOp() throws Exception {
        flyway().target(STAND_VORHER).load().migrate();
        exec("INSERT INTO tenant (id, name) VALUES ('" + TENANT + "', 'Kunde Probe')");
        exec("INSERT INTO site (id, tenant_id, name) VALUES ('" + SITE + "', '" + TENANT + "', 'Anlage Probe')");
        punkt(HYBRID, "battery-hybrid", "Hybrid-Speicher", "battery-hybrid", "solarman_v5");
        flow(FLOW_KUNDE, "consumer-policy", "Regel des Kunden");
        String vorher = nachbarn();

        flyway().target(VERSION).load().migrate();

        assertThat(angewandt(VERSION)).isTrue();
        assertThat(nachbarn()).isEqualTo(vorher);
    }

    private void punkt(String id, String rolle, String name, String art, String kommunikation) throws Exception {
        exec("INSERT INTO measurement_point (id, tenant_id, site_id, role, label, entity_type, communication, "
                + "connection_json, source_kind) VALUES ('" + id + "', '" + TENANT + "', '" + SITE + "', '" + rolle
                + "', '" + name + "', '" + art + "', '" + kommunikation + "', '{}'::jsonb, 'custom')");
    }

    private void flow(String id, String herkunft, String name) throws Exception {
        exec("INSERT INTO flow_definition (flow_id, flow_version, tenant_id, site_id, name, runtime, lifecycle, "
                + "document) VALUES ('" + id + "', 1, '" + TENANT + "', '" + SITE + "', '" + name + "', 'edge', "
                + "'active', '{\"origin\":{\"kind\":\"" + herkunft + "\"}}'::jsonb)");
    }

    /** Was die Migration nicht anfassen darf (alles außer dem Batterie-Bestand), als ein Text. */
    private String nachbarn() throws Exception {
        String fremd = "NOT IN ('" + BATTERIE_MQTT + "', '" + BATTERIE_HTTP + "')";
        return wert("SELECT (SELECT string_agg(m::text, '|' ORDER BY m.id) FROM measurement_point m "
                + "WHERE m.id " + fremd + ") || ' # '"
                + " || (SELECT string_agg(d::text, '|' ORDER BY d.entity_id) FROM component_definition d "
                + "WHERE d.entity_id " + fremd + ") || ' # '"
                + " || (SELECT string_agg(r::text, '|' ORDER BY r.entity_id) FROM entity_role_assignment r "
                + "WHERE r.entity_id " + fremd + ") || ' # '"
                + " || (SELECT string_agg(f::text, '|' ORDER BY f.flow_id) FROM flow_definition f "
                + "WHERE f.flow_id NOT IN ('" + FLOW_MQTT + "', '" + FLOW_HTTP + "')) || ' # '"
                + " || (SELECT string_agg(c::text, '|' ORDER BY c.entity_id) FROM flow_claim c "
                + "WHERE c.entity_id " + fremd + ")");
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
