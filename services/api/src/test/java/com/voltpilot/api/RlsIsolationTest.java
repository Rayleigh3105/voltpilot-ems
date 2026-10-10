package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Proves Row-Level-Security isolation directly at the JDBC layer against a real
 * TimescaleDB: connecting as the non-privileged app role and setting
 * {@code app.tenant_id} scopes every table to that tenant. This is the headline
 * tenant-isolation guarantee (architecture §9/§14.1).
 *
 * <p>Auto-skips where Docker is unavailable ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
class RlsIsolationTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";
    private static final String TENANT_B = "10000000-0000-0000-0000-000000000001";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @BeforeAll
    static void migrate() throws Exception {
        // Flyway as the superuser creates the app role, schema, RLS + dev seed.
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration", "classpath:db/dev")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(java.util.Map.of(
                        "appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "voltpilot_admin_test_pw"))
                .load()
                .migrate();
        ahrenberg();
    }

    private DataSource appDataSource() {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(APP_USER);
        ds.setPassword(APP_PW);
        return ds;
    }

    @Test
    void tenantSeesOnlyItsOwnSites() throws Exception {
        // Tenant A is the dev-seeded multi-site fleet (V100 + V20260706020000).
        assertThat(sitesForTenant(TENANT_A)).containsExactlyInAnyOrder(
                "Demo Site Berlin", "Solarpark Dachau", "Hof Lindenberg");
        assertThat(sitesForTenant(TENANT_B)).containsExactly("Nordwind Hamburg");
    }

    @Test
    void tenantSeesOnlyItsOwnDevicesAndTelemetry() throws Exception {
        assertThat(scalar(TENANT_A, "SELECT count(*) FROM device")).isEqualTo(3L);
        assertThat(scalar(TENANT_A, "SELECT count(DISTINCT tenant_id) FROM telemetry")).isEqualTo(1L);
        assertThat(scalar(TENANT_B, "SELECT count(*) FROM device")).isEqualTo(1L);
        assertThat(scalar(TENANT_B, "SELECT count(DISTINCT tenant_id) FROM telemetry")).isEqualTo(1L);
        // And each tenant's telemetry is genuinely its own, never the other's.
        assertThat(scalar(TENANT_A,
                "SELECT count(*) FROM telemetry WHERE tenant_id = '" + TENANT_B + "'")).isEqualTo(0L);
    }

    @Test
    void withoutTenantContextNothingIsVisible() throws Exception {
        try (Connection c = appDataSource().getConnection();
                Statement s = c.createStatement();
                ResultSet rs = s.executeQuery("SELECT count(*) FROM site")) {
            rs.next();
            // Default-deny: no app.tenant_id set => zero rows.
            assertThat(rs.getLong(1)).isZero();
        }
    }

    // ------------------------------------------------ UEMS AP-03 IP-5: der Standort-Zaun `site_scope`

    private static final String AHRENBERG = "a3000000-0000-0000-0000-000000000001";
    private static final String ST1 = "a3000000-0000-0000-0001-000000000001";
    private static final String ST2 = "a3000000-0000-0000-0001-000000000002";
    private static final String ST3 = "a3000000-0000-0000-0001-000000000003";
    private static final String AN1 = "a3000000-0000-0000-0002-000000000001";
    private static final String AN2 = "a3000000-0000-0000-0002-000000000002";
    private static final String AN3 = "a3000000-0000-0000-0002-000000000003";
    private static final String AN4 = "a3000000-0000-0000-0002-000000000004";
    /** Heute in der Zeitzone des Unternehmens — derselbe Tag, den {@code uems_zugriff_heute} rechnet. */
    private static final String HEUTE = "(now() AT TIME ZONE 'Europe/Berlin')::date";
    /** Peter Hollerbach: Bearbeiter nur für Werk Lindach (AP-03 A1). */
    private static final String PETER = "{" + ST2 + "}";
    /** Claudia: Leser für Werk Ahrenberg und Werk Lindach (AP-03 A13, A16). */
    private static final String CLAUDIA = "{" + ST1 + "," + ST2 + "}";
    private static final List<String> STANDORT_TABELLEN =
            List.of("site", "standort", "anlage_standort", "ort", "measurement_point", "device");

    /**
     * AP-03 A1, die Hälfte des Zauns (IP-5): Peter sieht auf keiner Standort-Tabelle etwas von Werk Ahrenberg — auch
     * nicht über die Kennung, und genau diese Abfrage stellt {@code Geltungsbereich.requireSite} (dann 404). Totals,
     * Kennzahlen und Exporte aus A1 sind IP-10/IP-11.
     */
    @Test
    void a1EinStandortBearbeiterSiehtNurSeinenStandort() throws Exception {
        assertThat(spalte(PETER, "SELECT name FROM site")).containsExactly("Anlage Lindach");
        assertThat(spalte(PETER, "SELECT kurzzeichen FROM standort")).containsExactly("ST-2");
        assertThat(spalte(PETER, "SELECT site_id::text FROM anlage_standort")).containsExactly(AN3);
        assertThat(spalte(PETER, "SELECT kurzzeichen FROM ort")).containsExactly("G-2");
        assertThat(spalte(PETER, "SELECT label FROM measurement_point")).containsExactly("Netzbezug Lindach");
        assertThat(spalte(PETER, "SELECT external_ref FROM device")).containsExactly("rls-ahrenberg-an3");
        assertThat(spalte(PETER, "SELECT EXISTS (SELECT 1 FROM site WHERE id = '" + AN1 + "')::text"))
                .containsExactly("false");
    }

    /**
     * AP-03 A13, die Hälfte des Zauns (IP-5): Werk Ahrenberg Nord gibt es für Claudia nicht — nicht lesbar, nicht
     * änderbar (0 Zeilen, also 404 statt einer Bestätigung). Dasselbe gilt für Halle 2, die heute dort hängt, und für
     * die Anlage ohne Standort. 403 {@code recht_fehlt} INNERHALB ihrer Standorte ist IP-6.
     */
    @Test
    void a13EinFremderStandortIstUnsichtbarUndUnveraenderbar() throws Exception {
        assertThat(spalte(CLAUDIA, "SELECT kurzzeichen FROM standort ORDER BY kurzzeichen"))
                .containsExactly("ST-1", "ST-2");
        assertThat(spalte(CLAUDIA, "SELECT count(*)::text FROM standort WHERE id = '" + ST3 + "'")).containsExactly("0");
        assertThat(aendere(CLAUDIA, "UPDATE standort SET name = 'fremd' WHERE id = '" + ST3 + "'")).isZero();
        assertThat(aendere(CLAUDIA, "UPDATE site SET name = 'fremd' WHERE id = '" + AN2 + "'")).isZero();
        assertThat(aendere(CLAUDIA, "UPDATE site SET name = 'fremd' WHERE id = '" + AN4 + "'")).isZero();
        assertThat(aendere(CLAUDIA, "UPDATE measurement_point SET label = 'fremd' WHERE site_id = '" + AN2 + "'"))
                .isZero();
        assertThat(aendere(CLAUDIA, "UPDATE ort SET name = 'fremd' WHERE kurzzeichen = 'G-3'")).isZero();
        assertThat(aendere(CLAUDIA, "DELETE FROM device WHERE site_id = '" + AN2 + "'")).isZero();
        assertThat(aendereUndRollZurueck(CLAUDIA, "UPDATE site SET name = name WHERE id = '" + AN1 + "'"))
                .isEqualTo(1);
    }

    /**
     * AP-03 A16: Rechte hängen am Standort von HEUTE, Daten am Stichtag. Halle 2 ist heute nach Werk Ahrenberg Nord
     * umgezogen: Claudia sieht die Anlage nicht mehr, ihre beendete Zuordnung an Werk Ahrenberg aber weiter (Berichte
     * über die Vergangenheit); Werk Ahrenberg Nord sieht Halle 2 ab heute. Ein Gebäude, dessen Zuordnung gestern
     * endete, ist weg; ein Bereich folgt seinem Gebäude.
     */
    @Test
    void a16DieAnlageFolgtIhremStandortVonHeuteUndDieVergangenheitBleibtLesbar() throws Exception {
        assertThat(spalte(CLAUDIA, "SELECT name FROM site ORDER BY name")).containsExactly("Anlage Lindach", "Halle 1");
        assertThat(spalte(CLAUDIA, "SELECT site_id::text || ' ' || standort_id::text || ' ' || (gueltig_bis IS NULL) "
                + "FROM anlage_standort")).containsExactlyInAnyOrder(AN1 + " " + ST1 + " true",
                        AN2 + " " + ST1 + " false", AN3 + " " + ST2 + " true");
        assertThat(spalte(CLAUDIA, "SELECT kurzzeichen FROM ort ORDER BY kurzzeichen")).containsExactly("B-1", "G-1", "G-2");
        assertThat(spalte(CLAUDIA, "SELECT label FROM measurement_point ORDER BY label"))
                .containsExactly("Netzbezug Halle 1", "Netzbezug Lindach");
        assertThat(spalte("{" + ST3 + "}", "SELECT name FROM site")).containsExactly("Halle 2");
        assertThat(spalte("{" + ST3 + "}", "SELECT label FROM measurement_point")).containsExactly("Zähler Halle 2");
        assertThat(spalte(CLAUDIA, "SELECT external_ref FROM device ORDER BY external_ref"))
                .containsExactly("rls-ahrenberg-an1", "rls-ahrenberg-an3");
    }

    /**
     * Schreiben: der enge Zaun legt nie etwas an einem fremden Standort an (WITH CHECK); am eigenen geht es. Eine
     * Anlage, die er nicht sieht, kann er nicht einmal zuordnen — die Einfüge-Prüfung von {@code anlage_standort}
     * (W5-Grabstein) liest {@code site} unter derselben Rolle und antwortet wie für eine fremde Anlage.
     */
    @Test
    void derEngeZaunLegtNieEtwasAnEinemFremdenStandortAn() throws Exception {
        assertThatThrownBy(() -> aendere(CLAUDIA, "INSERT INTO anlage_standort (tenant_id, site_id, standort_id, "
                + "gueltig_ab, gueltig_bis) VALUES ('" + AHRENBERG + "', '" + AN1 + "', '" + ST3 + "', '2020-01-01', "
                + "'2020-12-31')")).hasMessageContaining("row-level security");
        assertThatThrownBy(() -> aendere(CLAUDIA, "INSERT INTO anlage_standort (tenant_id, site_id, standort_id, "
                + "gueltig_ab) VALUES ('" + AHRENBERG + "', '" + AN4 + "', '" + ST1 + "', '2030-01-01')"))
                .hasMessageContaining("anlage_standort_site_fk");
        assertThatThrownBy(() -> aendere(CLAUDIA, "INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type) VALUES ('" + AHRENBERG + "', '" + AN2 + "', 'grid-meter', 'fremd', 'grid-meter')"))
                .hasMessageContaining("row-level security");
        assertThatThrownBy(() -> aendere(CLAUDIA, "INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, "
                + "zeitzone, zustand) SELECT tenant_id, id, 'Neu', 'ST-9', 'Europe/Berlin', 'aktiv' FROM unternehmen"))
                .hasMessageContaining("row-level security");
        assertThat(aendereUndRollZurueck(CLAUDIA, "INSERT INTO anlage_standort (tenant_id, site_id, standort_id, "
                + "gueltig_ab, gueltig_bis) VALUES ('" + AHRENBERG + "', '" + AN1 + "', '" + ST2 + "', '2020-01-01', "
                + "'2020-12-31')")).isEqualTo(1);
    }

    /**
     * Bestand: ohne Zugriff (frische Verbindung: NULL; nach dem Zurücksetzen: leer) und unternehmensweit sieht jede
     * Standort-Tabelle genau die Zeilen des Kundenbereichs — dieselben wie der Mandanten-Zaun allein. Die
     * Standort-Kennungen spielen unternehmensweit keine Rolle.
     */
    @Test
    void ohneZugriffUndUnternehmensweitBleibenAlleZeilenDesKundenbereichs() throws Exception {
        for (String tabelle : STANDORT_TABELLEN) {
            String zaehle = "SELECT count(*) FROM " + tabelle;
            long alle = superuserZahl(zaehle + " WHERE tenant_id = '" + AHRENBERG + "'");
            assertThat(alle).as(tabelle).isPositive();
            assertThat(scalar(AHRENBERG, zaehle)).as(tabelle + ", ohne Zugriff").isEqualTo(alle);
            assertThat(zahl(AHRENBERG, "", "", zaehle)).as(tabelle + ", zurückgesetzt").isEqualTo(alle);
            assertThat(zahl(AHRENBERG, "unternehmen", "{}", zaehle)).as(tabelle + ", unternehmensweit").isEqualTo(alle);
            assertThat(zahl(AHRENBERG, "unternehmen", PETER, zaehle)).as(tabelle + ", mit Kennungen").isEqualTo(alle);
        }
        assertThat(sitesForTenant(TENANT_A)).containsExactlyInAnyOrder(
                "Demo Site Berlin", "Solarpark Dachau", "Hof Lindenberg");
    }

    /** Fail closed: ohne Standort (Kundenkonto ohne Zuweisung) und bei jedem anderen Wert als „unternehmen" nichts. */
    @Test
    void ohneStandortUndMitUnbekanntemWertSiehtDerEngeZaunNichts() throws Exception {
        for (String tabelle : STANDORT_TABELLEN) {
            String zaehle = "SELECT count(*) FROM " + tabelle;
            assertThat(zahl(AHRENBERG, "standorte", "{}", zaehle)).as(tabelle + ", ohne Standort").isZero();
            assertThat(zahl(AHRENBERG, "Unternehmen", "{}", zaehle)).as(tabelle + ", Tippfehler").isZero();
        }
    }

    /** Der Standort-Zaun öffnet nie den Mandanten-Zaun: Kennungen von Ahrenberg nützen in einem anderen Kundenbereich nichts. */
    @Test
    void derStandortZaunOeffnetNieDenMandantenZaun() throws Exception {
        String alleDrei = "{" + ST1 + "," + ST2 + "," + ST3 + "}";
        for (String tabelle : STANDORT_TABELLEN) {
            String fremd = "SELECT count(*) FROM " + tabelle + " WHERE tenant_id = '" + AHRENBERG + "'";
            assertThat(zahl(TENANT_B, "standorte", alleDrei, fremd)).as(tabelle).isZero();
            assertThat(zahl(TENANT_B, "unternehmen", "{}", fremd)).as(tabelle).isZero();
            assertThat(zahl(null, "unternehmen", alleDrei, fremd)).as(tabelle + ", ohne Mandant").isZero();
        }
    }

    @Test
    void everyOcppTableIsForceRlsAndRejectsCrossTenantWrites() throws Exception {
        String[] tables = {
                "ocpp_station", "ocpp_connector_state", "ocpp_protocol_event",
                "ocpp_connector_status_event", "ocpp_authorization_event", "ocpp_transaction",
                "ocpp_meter_sample", "ocpp_station_status_event", "ocpp_configuration_key",
                "ocpp_configuration_unknown_key", "ocpp_station_capability", "ocpp_action",
                "ocpp_action_audit", "ocpp_action_intent"
        };
        try (Connection c = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()); Statement s = c.createStatement()) {
            s.executeUpdate("INSERT INTO ocpp_station (device_id, charge_point_id, tenant_id, site_id, "
                    + "last_seen, updated_at) VALUES "
                    + "('00000000-0000-0000-0000-000000000003','RLS-A','" + TENANT_A
                    + "','00000000-0000-0000-0000-000000000002',now(),now()),"
                    + "('10000000-0000-0000-0000-000000000003','RLS-B','" + TENANT_B
                    + "','10000000-0000-0000-0000-000000000002',now(),now()) "
                    + "ON CONFLICT DO NOTHING");
            try (ResultSet rs = s.executeQuery("SELECT count(*) FROM pg_class WHERE relname IN ('"
                    + String.join("','", tables) + "') AND relrowsecurity AND relforcerowsecurity")) {
                rs.next();
                assertThat(rs.getInt(1)).isEqualTo(tables.length);
            }
        }

        assertThat(scalar(TENANT_A, "SELECT count(*) FROM ocpp_station WHERE charge_point_id LIKE 'RLS-%'"))
                .isEqualTo(1);
        assertThat(scalar(TENANT_B, "SELECT count(*) FROM ocpp_station WHERE charge_point_id LIKE 'RLS-%'"))
                .isEqualTo(1);
        assertThat(scalar(TENANT_A, "SELECT count(*) FROM ocpp_station WHERE tenant_id='" + TENANT_B + "'"))
                .isZero();
        for (String table : tables) {
            assertThat(scalarWithoutTenant("SELECT count(*) FROM " + table))
                    .as(table + " default-deny").isZero();
        }

        try (Connection c = appDataSource().getConnection()) {
            setTenant(c, TENANT_A);
            assertThatThrownBy(() -> {
                try (Statement s = c.createStatement()) {
                    s.executeUpdate("INSERT INTO ocpp_station (device_id, charge_point_id, tenant_id, site_id, "
                            + "updated_at) VALUES ('10000000-0000-0000-0000-000000000003',"
                            + "'FORGED','" + TENANT_B + "','10000000-0000-0000-0000-000000000002',now())");
                }
            }).hasMessageContaining("row-level security");
        }

        // Even the schema owner cannot manufacture a mixed tenant/site/device
        // tuple or bypass the free-text secret boundary. These constraints are
        // independent backstops beneath RLS and the repository redactor.
        try (Connection c = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()); Statement s = c.createStatement()) {
            assertThatThrownBy(() -> s.executeUpdate(
                    "INSERT INTO ocpp_station (device_id, charge_point_id, tenant_id, site_id, updated_at) "
                            + "VALUES ('10000000-0000-0000-0000-000000000003','MIXED','" + TENANT_A
                            + "','00000000-0000-0000-0000-000000000002',now())"))
                    .hasMessageContaining("ocpp_station_device_scope_fk");
            assertThatThrownBy(() -> s.executeUpdate(
                    "INSERT INTO ocpp_protocol_event (occurred_at,event_id,tenant_id,site_id,device_id,"
                            + "charge_point_id,direction,message_type,action,error_description,payload) VALUES ("
                            + "now(),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','" + TENANT_A + "',"
                            + "'00000000-0000-0000-0000-000000000002',"
                            + "'00000000-0000-0000-0000-000000000003','CP-SECRET','internal','Event',"
                            + "'SecretProbe','AuthorizationKey=must-not-land','{}')"))
                    .hasMessageContaining("ocpp_protocol_error_description_redacted_chk");
        }
    }

    @Test
    void ocppActionAuditIsAppendOnlyForTheApplicationRole() throws Exception {
        try (Connection c = appDataSource().getConnection()) {
            setTenant(c, TENANT_A);
            try (Statement s = c.createStatement()) {
                s.executeUpdate("INSERT INTO ocpp_action (id,tenant_id,site_id,device_id,charge_point_id,"
                        + "action,state,correlation_id,idempotency_key,request_hash,conflict_key,actor,"
                        + "prepared_at,deadline_at,updated_at) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','"
                        + TENANT_A + "','00000000-0000-0000-0000-000000000002',"
                        + "'00000000-0000-0000-0000-000000000003','AUDIT-CP','ClearCache','prepared',"
                        + "'audit-correlation','audit-key',repeat('a',64),'ClearCache','tester',now(),now()+interval '1 minute',now())");
                s.executeUpdate("INSERT INTO ocpp_action_audit(action_id,tenant_id,site_id,device_id,"
                        + "charge_point_id,actor,state) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','"
                        + TENANT_A + "','00000000-0000-0000-0000-000000000002',"
                        + "'00000000-0000-0000-0000-000000000003','AUDIT-CP','tester','prepared')");
            }
        }
        assertThatThrownBy(() -> execute(TENANT_A, "UPDATE ocpp_action_audit SET state='rewritten' WHERE action_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'"))
                .hasMessageContaining("permission denied");
        assertThatThrownBy(() -> execute(TENANT_A, "DELETE FROM ocpp_action_audit WHERE action_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'"))
                .hasMessageContaining("permission denied");
        assertThatThrownBy(() -> execute(TENANT_A, "DELETE FROM ocpp_action WHERE id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'"))
                .hasMessageContaining("permission denied");
        assertThat(scalar(TENANT_B, "SELECT purge_ocpp_action_scope(NULL::uuid, "
                + "'00000000-0000-0000-0000-000000000003'::uuid)")).isZero();
        assertThat(scalar(TENANT_A, "SELECT purge_ocpp_action_scope(NULL::uuid, "
                + "'00000000-0000-0000-0000-000000000003'::uuid)")).isEqualTo(1L);
        assertThat(scalar(TENANT_A, "SELECT count(*) FROM ocpp_action_audit "
                + "WHERE action_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'")).isZero();
    }

    @Test
    void measurementSelectionsAndImmutableEventsAreTenantFenced() throws Exception {
        try (Connection c = appDataSource().getConnection()) {
            setTenant(c, TENANT_A);
            try (Statement s = c.createStatement()) {
                s.executeUpdate("INSERT INTO device_measurement_selection (tenant_id, site_id, "
                        + "device_id, point_key, enabled, cadence_s, desired_revision, enabled_at, "
                        + "catalog_version, changed_by, apply_status, apply_reason, "
                        + "retention_class, raw_retention_days, long_term_cadence_s, "
                        + "long_term_strategy) VALUES ('" + TENANT_A + "', "
                        + "'00000000-0000-0000-0000-000000000002', "
                        + "'00000000-0000-0000-0000-000000000003', 'test.rls.point', TRUE, 60, "
                        + "1, now(), '2026.08.25.1', 'test', 'pending_edge', 'wartet', "
                        + "'thermal_bms', 90, 900, 'fifteen_minute')");
                s.executeUpdate("INSERT INTO device_measurement_selection_event (tenant_id, "
                        + "site_id, device_id, point_key, desired_revision, idempotency_key, "
                        + "requested_enabled, requested_cadence_s, enabled_at, catalog_version, actor, "
                        + "apply_status, apply_reason, retention_class, raw_retention_days, "
                        + "long_term_cadence_s, long_term_strategy) VALUES ('" + TENANT_A + "', "
                        + "'00000000-0000-0000-0000-000000000002', "
                        + "'00000000-0000-0000-0000-000000000003', 'test.rls.point', 1, "
                        + "'00000000-0000-0000-0000-000000000099', TRUE, 60, now(), '2026.08.25.1', "
                        + "'test', 'pending_edge', 'wartet', 'thermal_bms', 90, 900, "
                        + "'fifteen_minute')");
            }
        }

        assertThat(scalar(TENANT_A, "SELECT count(*) FROM device_measurement_selection "
                + "WHERE point_key = 'test.rls.point'")).isEqualTo(1L);
        assertThat(scalar(TENANT_B, "SELECT count(*) FROM device_measurement_selection "
                + "WHERE point_key = 'test.rls.point'")).isZero();
        assertThat(scalar(TENANT_B, "SELECT count(*) FROM device_measurement_selection_event "
                + "WHERE point_key = 'test.rls.point'")).isZero();

        // Even a direct app-role attacker cannot pair its tenant with a foreign
        // site/device UUID. Current desired state binds the live triple; history
        // independently binds both the stable device and historical site to the
        // row's tenant so preserving an old site never weakens tenant isolation.
        assertThatThrownBy(() -> execute(TENANT_A,
                "INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, "
                        + "point_key, enabled, cadence_s, desired_revision, enabled_at, "
                        + "catalog_version, changed_by, apply_status, retention_class, "
                        + "raw_retention_days, long_term_strategy) VALUES ('" + TENANT_A + "', "
                        + "'10000000-0000-0000-0000-000000000002', "
                        + "'10000000-0000-0000-0000-000000000003', 'attack', TRUE, 60, 2, now(), "
                        + "'2026.08.25.1', 'attacker', 'pending_edge', 'unclassified', 90, 'none')"))
                .hasMessageContaining("device_measurement_selection_device_fk");

        assertThatThrownBy(() -> execute(TENANT_A,
                "INSERT INTO device_measurement_selection_event (tenant_id, site_id, device_id, "
                        + "point_key, desired_revision, idempotency_key, requested_enabled, "
                        + "requested_cadence_s, enabled_at, catalog_version, actor, apply_status, "
                        + "retention_class, raw_retention_days, long_term_strategy) VALUES ('"
                        + TENANT_A + "', '00000000-0000-0000-0000-000000000002', "
                        + "'10000000-0000-0000-0000-000000000003', 'attack.device', 2, "
                        + "'00000000-0000-0000-0000-000000000097', TRUE, 60, now(), "
                        + "'2026.08.25.1', 'attacker', 'pending_edge', 'unclassified', 90, 'none')"))
                .hasMessageContaining("device_measurement_selection_event_device_tenant_fk");
        assertThatThrownBy(() -> execute(TENANT_A,
                "INSERT INTO device_measurement_selection_event (tenant_id, site_id, device_id, "
                        + "point_key, desired_revision, idempotency_key, requested_enabled, "
                        + "requested_cadence_s, enabled_at, catalog_version, actor, apply_status, "
                        + "retention_class, raw_retention_days, long_term_strategy) VALUES ('"
                        + TENANT_A + "', '10000000-0000-0000-0000-000000000002', "
                        + "'00000000-0000-0000-0000-000000000003', 'attack.site', 2, "
                        + "'00000000-0000-0000-0000-000000000098', TRUE, 60, now(), "
                        + "'2026.08.25.1', 'attacker', 'pending_edge', 'unclassified', 90, 'none')"))
                .hasMessageContaining("device_measurement_selection_event_site_tenant_fk");

        // The application role has no UPDATE/DELETE privilege on audit rows.
        assertThatThrownBy(() -> execute(TENANT_A,
                "UPDATE device_measurement_selection_event SET apply_reason = 'rewritten' "
                        + "WHERE point_key = 'test.rls.point'"))
                .hasMessageContaining("permission denied");
        assertThatThrownBy(() -> execute(TENANT_A,
                "DELETE FROM device_measurement_selection_event "
                        + "WHERE point_key = 'test.rls.point'"))
                .hasMessageContaining("permission denied");
    }

    @Test
    void additionalSamplesAreTenantFencedAndRollUpBySemanticKind() throws Exception {
        String site = "00000000-0000-0000-0000-000000000002";
        String device = "00000000-0000-0000-0000-000000000003";
        try (Connection c = appDataSource().getConnection()) {
            setTenant(c, TENANT_A);
            try (Statement s = c.createStatement()) {
                s.executeUpdate("INSERT INTO device_measurement_sample "
                        + "(time,tenant_id,site_id,device_id,point_key,raw_numeric,decoded_numeric,"
                        + "quality,catalog_version,edge_sequence,aggregation_kind,long_term_cadence_s) "
                        + "VALUES "
                        + "('2026-08-25T12:00:01Z','" + TENANT_A + "','" + site + "','" + device
                        + "','test.rollup.gauge',100,10,'good','2026.08.25.1',1,'gauge',300),"
                        + "('2026-08-25T12:00:31Z','" + TENANT_A + "','" + site + "','" + device
                        + "','test.rollup.gauge',200,20,'good','2026.08.25.1',2,'gauge',300),"
                        + "('2026-08-25T12:00:01Z','" + TENANT_A + "','" + site + "','" + device
                        + "','test.rollup.counter',1000,100,'good','2026.08.25.1',3,'counter',900),"
                        + "('2026-08-25T12:16:01Z','" + TENANT_A + "','" + site + "','" + device
                        + "','test.rollup.counter',1100,110,'good','2026.08.25.1',4,'counter',900),"
                        + "('2026-08-25T12:31:01Z','" + TENANT_A + "','" + site + "','" + device
                        + "','test.rollup.counter',50,5,'good','2026.08.25.1',5,'counter',900),"
                        + "(now()-INTERVAL '30 days','" + TENANT_A + "','" + site + "','" + device
                        + "','test.rollup.replay',300,30,'good','2026.08.25.1',6,'gauge',300),"
                        + "(now()-INTERVAL '30 days'+INTERVAL '1 second','" + TENANT_A + "','" + site
                        + "','" + device + "','test.rollup.replay',9990,999,'invalid',"
                        + "'2026.08.25.1',7,'gauge',300)");
            }
        }

        assertThat(scalar(TENANT_A, "SELECT count(*) FROM device_measurement_sample "
                + "WHERE point_key LIKE 'test.rollup.%'")).isEqualTo(7L);
        assertThat(scalar(TENANT_B, "SELECT count(*) FROM device_measurement_sample "
                + "WHERE point_key LIKE 'test.rollup.%'")).isZero();
        assertThat(scalarWithoutTenant("SELECT count(*) FROM device_measurement_sample")).isZero();

        try (Connection c = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()); Statement s = c.createStatement()) {
            s.execute("CALL refresh_device_measurement_rollup('device_measurement_rollup_5m', "
                    + "INTERVAL '5 minutes', '2026-08-25T11:00:00Z')");
            s.execute("CALL refresh_device_measurement_rollup('device_measurement_rollup_15m', "
                    + "INTERVAL '15 minutes', '2026-08-25T11:00:00Z')");
            // The scheduled job must include replay well beyond the old two-day
            // horizon, while an invalid value in the same bucket contributes
            // neither to average nor sample_count.
            s.execute("CALL device_measurement_rollup_job(0, '{}'::jsonb)");
            try (ResultSet rs = s.executeQuery("SELECT avg_numeric FROM device_measurement_rollup_5m "
                    + "WHERE point_key='test.rollup.gauge'")) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getDouble(1)).isEqualTo(15.0);
            }
            try (ResultSet rs = s.executeQuery("SELECT sum(positive_delta),sum(counter_reset_count) "
                    + "FROM device_measurement_rollup_15m WHERE point_key='test.rollup.counter'")) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getDouble(1)).isEqualTo(10.0);
                assertThat(rs.getLong(2)).isEqualTo(1L);
            }
            try (ResultSet rs = s.executeQuery("SELECT avg_numeric,sample_count "
                    + "FROM device_measurement_rollup_5m WHERE point_key='test.rollup.replay'")) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getBigDecimal(1)).isEqualByComparingTo("30");
                assertThat(rs.getLong(2)).isEqualTo(1L);
            }
            try (ResultSet rs = s.executeQuery("SELECT count(*) FROM timescaledb_information.jobs "
                    + "WHERE proc_name='policy_retention' AND hypertable_name="
                    + "'device_measurement_sample' AND config->>'drop_after'='90 days'")) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getLong(1)).isEqualTo(1L);
            }
        }
    }

    /**
     * Der Zaun-Riss aus dem Skalierungs-Gutachten (vp-scale-readiness-p4 §4.2):
     * {@code forecast} ist die eine Kundendaten-Tabelle OHNE RLS (komprimiert
     * seit V20260809000000 - RLS und Kompression schließen sich aus), also
     * hängt ihre Mandantentrennung an Code-Disziplin. Seit V20260831010000 ist
     * der App-Rolle wenigstens das DELETE entzogen; der eine legitime Löschweg
     * (die Site-Löschkaskade) läuft über die tenant-gebundene
     * SECURITY-DEFINER-Funktion, deren Zaun HIER bewiesen wird.
     */
    @Test
    void forecastDeleteIsRevokedAndThePurgeFunctionIsTenantBound() throws Exception {
        String siteA = "00000000-0000-0000-0000-000000000002";
        String siteB = "10000000-0000-0000-0000-000000000002";
        // Seed one row per tenant as the backend role - the real forecast
        // writers (services/forecast, optimizer) use backend credentials too.
        try (Connection c = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()); Statement s = c.createStatement()) {
            s.executeUpdate("DELETE FROM forecast WHERE method = 'rls-test'");
            s.executeUpdate("INSERT INTO forecast (time, tenant_id, site_id, kind, model, "
                    + "value_kw, run_at, horizon_min, method) VALUES "
                    + "(now(), '" + TENANT_A + "', '" + siteA + "', 'load', 'load-persistence', "
                    + "1.0, now(), 60, 'rls-test'), "
                    + "(now(), '" + TENANT_B + "', '" + siteB + "', 'load', 'load-persistence', "
                    + "2.0, now(), 60, 'rls-test')");
        }
        try {
            // No RLS: the app role SEES both tenants' rows. Exactly this state
            // is why every read path must carry the site fence itself
            // (ForecastTableDisciplineTest) and why DELETE is revoked.
            assertThat(scalar(TENANT_A, "SELECT count(*) FROM forecast WHERE method = 'rls-test'"))
                    .isEqualTo(2L);

            // The hardening itself: direct DELETE is gone for the app role.
            assertThatThrownBy(() -> execute(TENANT_A, "DELETE FROM forecast WHERE method = 'rls-test'"))
                    .hasMessageContaining("permission denied");

            // The one legitimate delete path is the tenant-bound function:
            // without tenant context it throws, ...
            assertThatThrownBy(() -> scalarWithoutTenant(
                    "SELECT purge_forecast_for_site('" + siteA + "'::uuid)"))
                    .hasMessageContaining("tenant context required");
            // ...a FOREIGN site id deletes NOTHING in the caller's tenant, ...
            assertThat(scalar(TENANT_A, "SELECT purge_forecast_for_site('" + siteB + "'::uuid)"))
                    .isZero();
            assertThat(scalar(TENANT_A, "SELECT count(*) FROM forecast WHERE method = 'rls-test'"))
                    .isEqualTo(2L);
            // ...and the own site removes exactly the own tenant's row.
            assertThat(scalar(TENANT_A, "SELECT purge_forecast_for_site('" + siteA + "'::uuid)"))
                    .isEqualTo(1L);
            assertThat(scalar(TENANT_A, "SELECT count(*) FROM forecast WHERE method = 'rls-test'"))
                    .isEqualTo(1L);
            assertThat(scalar(TENANT_B, "SELECT count(*) FROM forecast "
                    + "WHERE method = 'rls-test' AND tenant_id = '" + TENANT_B + "'"))
                    .isEqualTo(1L);
        } finally {
            try (Connection c = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                    POSTGRES.getUsername(), POSTGRES.getPassword()); Statement s = c.createStatement()) {
                s.executeUpdate("DELETE FROM forecast WHERE method = 'rls-test'");
            }
        }
    }

    private List<String> sitesForTenant(String tenantId) throws Exception {
        List<String> names = new ArrayList<>();
        try (Connection c = appDataSource().getConnection()) {
            setTenant(c, tenantId);
            try (Statement s = c.createStatement();
                    ResultSet rs = s.executeQuery("SELECT name FROM site ORDER BY name")) {
                while (rs.next()) {
                    names.add(rs.getString(1));
                }
            }
        }
        return names;
    }

    private long scalar(String tenantId, String sql) throws Exception {
        try (Connection c = appDataSource().getConnection()) {
            setTenant(c, tenantId);
            try (Statement s = c.createStatement(); ResultSet rs = s.executeQuery(sql)) {
                rs.next();
                return rs.getLong(1);
            }
        }
    }

    private long scalarWithoutTenant(String sql) throws Exception {
        try (Connection c = appDataSource().getConnection();
                Statement s = c.createStatement(); ResultSet rs = s.executeQuery(sql)) {
            rs.next();
            return rs.getLong(1);
        }
    }

    private void execute(String tenantId, String sql) throws Exception {
        try (Connection c = appDataSource().getConnection()) {
            setTenant(c, tenantId);
            try (Statement s = c.createStatement()) {
                s.executeUpdate(sql);
            }
        }
    }

    private void setTenant(Connection c, String tenantId) throws Exception {
        try (PreparedStatement ps = c.prepareStatement("SELECT set_config('app.tenant_id', ?, false)")) {
            ps.setString(1, tenantId);
            ps.execute();
        }
    }

    /**
     * Kunststoffwerk Ahrenberg im Kleinen (AP-00 §4.4, AP-02 Leitbeispiel): Werk Ahrenberg (ST-1) mit Halle 1 (AN-1),
     * Werk Lindach (ST-2) mit seiner Anlage (AN-3), Werk Ahrenberg Nord (ST-3), an das Halle 2 (AN-2) HEUTE umgezogen
     * ist, und eine Anlage ohne Standort (AN-4). Gebäude G-1 mit Bereich B-1 an ST-1, G-2 an ST-2, G-3 bis gestern an
     * ST-1. Je Anlage mit Standort eine Messkomponente und ein Gerät.
     */
    private static void ahrenberg() throws Exception {
        String t = "'" + AHRENBERG + "'";
        try (Connection c = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()); Statement s = c.createStatement()) {
            s.execute("INSERT INTO tenant (id, name) VALUES (" + t + ", 'Kunststoffwerk Ahrenberg GmbH')");
            s.execute("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (" + t
                    + ", 'Kunststoffwerk Ahrenberg GmbH', 'Europe/Berlin')");
            s.execute("INSERT INTO standort (id, tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                    + "SELECT v.id::uuid, u.tenant_id, u.id, v.name, v.kz, 'Europe/Berlin', 'aktiv' FROM unternehmen u, "
                    + "(VALUES ('" + ST1 + "', 'Werk Ahrenberg', 'ST-1'), ('" + ST2 + "', 'Werk Lindach', 'ST-2'), ('"
                    + ST3 + "', 'Werk Ahrenberg Nord', 'ST-3')) v(id, name, kz) WHERE u.tenant_id = " + t);
            s.execute("INSERT INTO site (id, tenant_id, name) VALUES ('" + AN1 + "', " + t + ", 'Halle 1'), ('" + AN2
                    + "', " + t + ", 'Halle 2'), ('" + AN3 + "', " + t + ", 'Anlage Lindach'), ('" + AN4 + "', " + t
                    + ", 'Anlage ohne Standort')");
            s.execute("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab, gueltig_bis) VALUES ("
                    + t + ", '" + AN1 + "', '" + ST1 + "', '2024-01-01', NULL), (" + t + ", '" + AN2 + "', '" + ST1
                    + "', '2024-01-01', " + HEUTE + " - 1), (" + t + ", '" + AN2 + "', '" + ST3 + "', " + HEUTE
                    + ", NULL), (" + t + ", '" + AN3 + "', '" + ST2 + "', '2024-01-01', NULL)");
            s.execute("INSERT INTO ort (id, tenant_id, art, name, kurzzeichen, zustand) VALUES "
                    + "('a3000000-0000-0000-0003-000000000001', " + t + ", 'gebaeude', 'Halle 1', 'G-1', 'aktiv'), "
                    + "('a3000000-0000-0000-0003-000000000002', " + t + ", 'bereich', 'Halle 1 Nord', 'B-1', 'aktiv'), "
                    + "('a3000000-0000-0000-0003-000000000003', " + t + ", 'gebaeude', 'Werkhalle Lindach', 'G-2', 'aktiv'), "
                    + "('a3000000-0000-0000-0003-000000000004', " + t + ", 'gebaeude', 'Altes Lager', 'G-3', 'aktiv')");
            s.execute("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab, gueltig_bis) VALUES "
                    + "(" + t + ", 'a3000000-0000-0000-0003-000000000001', '" + ST1 + "', '2024-01-01', NULL), "
                    + "(" + t + ", 'a3000000-0000-0000-0003-000000000003', '" + ST2 + "', '2024-01-01', NULL), "
                    + "(" + t + ", 'a3000000-0000-0000-0003-000000000004', '" + ST1 + "', '2024-01-01', " + HEUTE + " - 1)");
            s.execute("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_ort_id, gueltig_ab) VALUES (" + t
                    + ", 'a3000000-0000-0000-0003-000000000002', 'a3000000-0000-0000-0003-000000000001', '2024-01-01')");
            s.execute("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type) VALUES ("
                    + t + ", '" + AN1 + "', 'grid-meter', 'Netzbezug Halle 1', 'grid-meter'), ("
                    + t + ", '" + AN2 + "', 'grid-meter', 'Zähler Halle 2', 'grid-meter'), ("
                    + t + ", '" + AN3 + "', 'grid-meter', 'Netzbezug Lindach', 'grid-meter')");
            s.execute("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (" + t + ", '" + AN1
                    + "', 'rls-ahrenberg-an1'), (" + t + ", '" + AN2 + "', 'rls-ahrenberg-an2'), (" + t + ", '" + AN3
                    + "', 'rls-ahrenberg-an3')");
        }
    }

    private List<String> spalte(String standortIds, String sql) throws Exception {
        return spalte(AHRENBERG, "standorte", standortIds, sql);
    }

    /** Die erste Spalte jeder Zeile — auf einer Verbindung mit genau den Sitzungs-Einstellungen, die IP-4 setzt. */
    private List<String> spalte(String tenantId, String zugriff, String standortIds, String sql) throws Exception {
        try (Connection c = appDataSource().getConnection()) {
            setZugriff(c, tenantId, zugriff, standortIds);
            List<String> aus = new ArrayList<>();
            try (Statement s = c.createStatement(); ResultSet rs = s.executeQuery(sql)) {
                while (rs.next()) {
                    aus.add(rs.getString(1));
                }
            }
            return aus;
        }
    }

    private long zahl(String tenantId, String zugriff, String standortIds, String sql) throws Exception {
        return Long.parseLong(spalte(tenantId, zugriff, standortIds, sql).get(0));
    }

    private int aendere(String standortIds, String sql) throws Exception {
        try (Connection c = appDataSource().getConnection()) {
            setZugriff(c, AHRENBERG, "standorte", standortIds);
            try (Statement s = c.createStatement()) {
                return s.executeUpdate(sql);
            }
        }
    }

    private int aendereUndRollZurueck(String standortIds, String sql) throws Exception {
        try (Connection c = appDataSource().getConnection()) {
            setZugriff(c, AHRENBERG, "standorte", standortIds);
            c.setAutoCommit(false);
            try (Statement s = c.createStatement()) {
                return s.executeUpdate(sql);
            } finally {
                c.rollback();
            }
        }
    }

    private static long superuserZahl(String sql) throws Exception {
        try (Connection c = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()); Statement s = c.createStatement(); ResultSet rs = s.executeQuery(sql)) {
            rs.next();
            return rs.getLong(1);
        }
    }

    private static void setZugriff(Connection c, String tenantId, String zugriff, String standortIds) throws Exception {
        try (PreparedStatement ps = c.prepareStatement("SELECT set_config('app.tenant_id', ?, false), "
                + "set_config('app.zugriff', ?, false), set_config('app.standort_ids', ?, false)")) {
            ps.setString(1, tenantId);
            ps.setString(2, zugriff);
            ps.setString(3, standortIds);
            ps.execute();
        }
    }
}
