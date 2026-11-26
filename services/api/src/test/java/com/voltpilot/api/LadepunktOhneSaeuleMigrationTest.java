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
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * Die Migration V20261125100000 (vp-ladepunkte-doppelt) auf einer Datenbank AM STAND DAVOR, die
 * liegen gebliebene Ladepunkte trägt: zwei {@code ev-charger}-Komponenten ohne gemeldete Säule - die
 * benannte der entfernten Wallbox und die namenlose, die ein später Herzschlag angelegt hatte.
 *
 * <p>Geprüft wird beides: genau diese zwei sind danach weg, samt Regel-Anspruch, Rollen-Zuordnung
 * und Steuerprofil - und nichts anderes. Eine gemeldete Säule, eine go-e-Wallbox ohne OCPP und zwei
 * liegen gebliebene Ladepunkte, die der Zählerbaum oder eine Bezugsgröße festhält, stehen unverändert
 * da. Ein zweiter Lauf desselben SQL ändert nichts, und eine Datenbank ohne solche Ladepunkte
 * durchläuft die Migration als No-op.
 *
 * <p>Frischer Container, ohne Spring; ohne Docker übersprungen.
 */
@Testcontainers(disabledWithoutDocker = true)
class LadepunktOhneSaeuleMigrationTest {

    private static final String STAND_VORHER = "20261123100000";
    private static final String VERSION = "20261125100000";
    private static final String MIGRATION =
            "/db/migration/V20261125100000__ladepunkt_ohne_saeule_aufraeumen.sql";

    private static final String TENANT = "a1000000-0000-4000-8000-0000000000c1";
    private static final String SITE = "a2000000-0000-4000-8000-0000000000c1";
    private static final String BOX = "a3000000-0000-4000-8000-0000000000c1";
    private static final String ENTFERNT_MIT_NAME = "b1000000-0000-4000-8000-0000000000c1";
    private static final String ENTFERNT_OHNE_NAME = "b1000000-0000-4000-8000-0000000000c2";
    private static final String GEMELDET = "b1000000-0000-4000-8000-0000000000c3";
    private static final String GOE = "b1000000-0000-4000-8000-0000000000c4";
    private static final String IM_ZAEHLERBAUM = "b1000000-0000-4000-8000-0000000000c5";
    private static final String UNTERVERTEILUNG = "b1000000-0000-4000-8000-0000000000c6";
    private static final String MIT_BEZUG = "b1000000-0000-4000-8000-0000000000c7";
    private static final String UNTERNEHMEN = "e1000000-0000-4000-8000-0000000000c1";
    private static final String BEZUG = "d1000000-0000-4000-8000-0000000000c1";
    private static final String FLOW = "c1000000-0000-4000-8000-0000000000c1";

    @Container
    final TestDatenbank POSTGRES = new TestDatenbank();

    @Test
    void dieMigrationRaeumtNurLadepunkteOhneSaeuleAbUndLaesstAllesAndereStehen() throws Exception {
        // 1. Der Stand vor der Migration, mit dem Bestand einer Anlage, deren Wallbox entfernt wurde.
        flyway().target(STAND_VORHER).load().migrate();
        assertThat(angewandt(VERSION)).isFalse();
        exec("INSERT INTO tenant (id, name) VALUES ('" + TENANT + "', 'Kunde Probe')");
        exec("INSERT INTO site (id, tenant_id, name) VALUES ('" + SITE + "', '" + TENANT + "', 'Anlage Probe')");
        punkt(ENTFERNT_MIT_NAME, "'Wallbox Garage'", "ev-charger");
        punkt(ENTFERNT_OHNE_NAME, "NULL", "ev-charger");
        punkt(GEMELDET, "'Carport'", "ev-charger");
        punkt(GOE, "'go-e Hof'", "wallbox");
        punkt(IM_ZAEHLERBAUM, "'Stellplatz 2'", "ev-charger");
        punkt(UNTERVERTEILUNG, "'Unterverteilung'", "sub-meter");
        punkt(MIT_BEZUG, "'Stellplatz 3'", "ev-charger");

        // Was an der entfernten Wallbox hing: Steuerprofil, Rollen-Zuordnung, Regel-Anspruch.
        exec("INSERT INTO consumer_profile (entity_id, tenant_id, site_id, control_kind, rated_power_kw) "
                + "VALUES ('" + ENTFERNT_MIT_NAME + "', '" + TENANT + "', '" + SITE + "', 'continuous', 11)");
        exec("INSERT INTO entity_role_assignment (tenant_id, site_id, entity_id, capability, role, is_primary) "
                + "VALUES ('" + TENANT + "', '" + SITE + "', '" + ENTFERNT_OHNE_NAME + "', 'power_kw', "
                + "'consumer', false)");
        exec("INSERT INTO flow_claim (entity_id, command, tenant_id, site_id, flow_id, flow_version, flow_name) "
                + "VALUES ('" + ENTFERNT_MIT_NAME + "', 'limit_kw', '" + TENANT + "', '" + SITE + "', '" + FLOW
                + "', 1, 'Ladeziel'), ('" + GEMELDET + "', 'limit_kw', '" + TENANT + "', '" + SITE + "', '" + FLOW
                + "', 1, 'Ladeziel')");

        // Eine Säule, die die Box meldet - ihre Komponente ist der lebende Ladepunkt.
        exec("INSERT INTO device_charge_point (device_id, charge_point_id, tenant_id, site_id, entity_id, "
                + "reported_at) VALUES ('" + BOX + "', 'WB-CARPORT-1', '" + TENANT + "', '" + SITE + "', '"
                + GEMELDET + "', now())");
        // Zwei liegen gebliebene Ladepunkte, die etwas festhält: der Zählerbaum, eine Bezugsgröße.
        exec("INSERT INTO komponente_haengt_an (tenant_id, komponente_id, haengt_an, gueltig_ab) VALUES ('"
                + TENANT + "', '" + IM_ZAEHLERBAUM + "', '" + UNTERVERTEILUNG + "', DATE '2026-11-01')");
        exec("INSERT INTO unternehmen (id, tenant_id, name) VALUES ('" + UNTERNEHMEN + "', '" + TENANT
                + "', 'Probe GmbH')");
        exec("INSERT INTO bezugsgroesse (id, tenant_id, kennzeichen, name, wertart, einheit, periode_art, "
                + "geltung_art, unternehmen_id) VALUES ('" + BEZUG + "', '" + TENANT + "', 'BZ-1', 'Produktion', "
                + "'periodenwert', 'kg', 'monat', 'unternehmen', '" + UNTERNEHMEN + "')");
        exec("INSERT INTO bezugsgroesse_kanalbindung (tenant_id, bezugsgroesse_id, entity_id, kanal, wertart, "
                + "einheit, kadenz_s, von, actor_name, actor_art) VALUES ('" + TENANT + "', '" + BEZUG + "', '"
                + MIT_BEZUG + "', 'energy_kwh', 'counter', 'kWh', 60, '2026-10-01 00:00:00+00', 'kc-probe', "
                + "'kunde')");
        String nachbarnVorher = nachbarn();

        // 2. Die Migration kommt an.
        flyway().target(VERSION).load().migrate();
        assertThat(angewandt(VERSION)).isTrue();

        // Die zwei Ladepunkte ohne Säule sind weg - mit allem, was an ihnen hing.
        assertThat(wert("SELECT count(*) FROM measurement_point WHERE id IN ('" + ENTFERNT_MIT_NAME + "', '"
                + ENTFERNT_OHNE_NAME + "')")).isEqualTo("0");
        assertThat(wert("SELECT count(*) FROM consumer_profile WHERE entity_id = '" + ENTFERNT_MIT_NAME + "'"))
                .isEqualTo("0");
        assertThat(wert("SELECT count(*) FROM entity_role_assignment WHERE entity_id = '" + ENTFERNT_OHNE_NAME
                + "'")).isEqualTo("0");
        assertThat(wert("SELECT count(*) FROM flow_claim WHERE entity_id = '" + ENTFERNT_MIT_NAME + "'"))
                .isEqualTo("0");

        // Nichts anderes: gemeldete Säule (samt Anspruch), go-e, Zählerbaum, Bezugsgröße unverändert.
        assertThat(wert("SELECT count(*) FROM site WHERE id = '" + SITE + "'")).isEqualTo("1");
        assertThat(nachbarn()).isEqualTo(nachbarnVorher);
        assertThat(wert("SELECT count(*) FROM measurement_point WHERE entity_type = 'ev-charger'"))
                .as("gemeldet, im Zählerbaum, mit Bezugsgröße").isEqualTo("3");

        // 3. Wiederholbar: ein zweiter Lauf desselben SQL ändert nichts und bricht nicht.
        String sql = new String(Objects.requireNonNull(getClass().getResourceAsStream(MIGRATION), MIGRATION)
                .readAllBytes(), StandardCharsets.UTF_8);
        assertThatCode(() -> exec(sql)).doesNotThrowAnyException();
        assertThat(nachbarn()).isEqualTo(nachbarnVorher);
    }

    @Test
    void ohneLadepunktOhneSaeuleIstDieMigrationEinNoOp() throws Exception {
        flyway().target(STAND_VORHER).load().migrate();
        exec("INSERT INTO tenant (id, name) VALUES ('" + TENANT + "', 'Kunde Probe')");
        exec("INSERT INTO site (id, tenant_id, name) VALUES ('" + SITE + "', '" + TENANT + "', 'Anlage Probe')");
        punkt(GEMELDET, "'Carport'", "ev-charger");
        punkt(GOE, "'go-e Hof'", "wallbox");
        exec("INSERT INTO device_charge_point (device_id, charge_point_id, tenant_id, site_id, entity_id, "
                + "reported_at) VALUES ('" + BOX + "', 'WB-CARPORT-1', '" + TENANT + "', '" + SITE + "', '"
                + GEMELDET + "', now())");
        String vorher = nachbarn();

        flyway().target(VERSION).load().migrate();

        assertThat(angewandt(VERSION)).isTrue();
        assertThat(nachbarn()).isEqualTo(vorher);
    }

    private void punkt(String id, String labelSql, String art) throws Exception {
        exec("INSERT INTO measurement_point (id, tenant_id, site_id, role, label, entity_type, control) "
                + "VALUES ('" + id + "', '" + TENANT + "', '" + SITE + "', 'consumer', " + labelSql + ", '"
                + art + "', " + ("sub-meter".equals(art) ? "false" : "true") + ")");
    }

    /** Was die Migration nicht anfassen darf (alles außer den zwei Ladepunkten ohne Säule), als ein Text. */
    private String nachbarn() throws Exception {
        String fremd = "NOT IN ('" + ENTFERNT_MIT_NAME + "', '" + ENTFERNT_OHNE_NAME + "')";
        return wert("SELECT coalesce((SELECT string_agg(m::text, '|' ORDER BY m.id) FROM measurement_point m "
                + "WHERE m.id " + fremd + "), '') || ' # '"
                + " || coalesce((SELECT string_agg(c::text, '|' ORDER BY c.entity_id) FROM flow_claim c "
                + "WHERE c.entity_id " + fremd + "), '') || ' # '"
                + " || coalesce((SELECT string_agg(d::text, '|' ORDER BY d.charge_point_id) "
                + "FROM device_charge_point d), '') || ' # '"
                + " || coalesce((SELECT string_agg(k.komponente_id::text, '|') FROM komponente_haengt_an k), '')"
                + " || ' # '"
                + " || coalesce((SELECT string_agg(b.entity_id::text, '|') FROM bezugsgroesse_kanalbindung b), '')");
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
