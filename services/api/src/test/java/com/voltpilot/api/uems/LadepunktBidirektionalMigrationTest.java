package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Migration {@code V20261002214500} (MiSpeL MP-31, bidirektionaler Ladepunkt) auf einer BEFÜLLTEN Datenbank:
 * Ladepunkte (OCPP-Säule mit Freigabe und Herzschlag-Spiegel, Wallbox) vorher, dann bis zum neuesten Stand. Geprüft
 * wird: kein Bestand ändert sich (Fingerabdruck), die drei Tabellen beginnen leer — jeder heutige Ladepunkt gilt damit
 * als unidirektional —, RLS + FORCE, beschnittene Rechte, die CHECKs der Fn. 21/22, der Mandantenzaun und dass die
 * Komponente ihre Zeilen mitnimmt. Die frische Datenbank migriert {@code LadepunktBidirektionalApiTest}.
 */
@Testcontainers(disabledWithoutDocker = true)
class LadepunktBidirektionalMigrationTest {

    private static final String DIESE = "20261002214500";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final List<String> TABELLEN = List.of("ladepunkt_faehigkeit", "ladepunkt_fahrzeugfenster",
            "ladepunkt_anwesenheit");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Test
    void befuellteDatenbankBehaeltIhrVerhaltenBitgenau() {
        flyway().target(letzteFassungVorDieser()).load().migrate();
        JdbcTemplate root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        assertThat(root.queryForObject("SELECT to_regclass('ladepunkt_faehigkeit') IS NULL", Boolean.class)).isTrue();

        UUID t1 = root.queryForObject("INSERT INTO tenant (name) VALUES ('MiSpeL MP-31 A') RETURNING id", UUID.class);
        UUID t2 = root.queryForObject("INSERT INTO tenant (name) VALUES ('MiSpeL MP-31 B') RETURNING id", UUID.class);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Hof') RETURNING id",
                UUID.class, t1);
        UUID fremdeAnlage = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Fremd') RETURNING id",
                UUID.class, t2);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, "
                + "'VP-BOX-MP31-A', 'claimed') RETURNING id", UUID.class, t1, anlage);
        UUID fremdeBox = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, "
                + "'VP-BOX-MP31-B', 'claimed') RETURNING id", UUID.class, t2, fremdeAnlage);
        UUID saeule = komponente(root, t1, anlage, box, "ev-charger");
        UUID wallbox = komponente(root, t1, anlage, box, "wallbox");
        UUID fremd = komponente(root, t2, fremdeAnlage, fremdeBox, "ev-charger");
        root.update("INSERT INTO site_charge_point_allowlist (site_id, charge_point_id, tenant_id, label, rated_kw) "
                + "VALUES (?, 'CP-1', ?, 'Garage', 11)", anlage, t1);
        root.update("INSERT INTO device_charge_point (device_id, charge_point_id, tenant_id, site_id, entity_id, "
                + "reported_at) VALUES (?, 'CP-1', ?, ?, ?, now())", box, t1, anlage, saeule);
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());

        flyway().target(DIESE).load().migrate();
        Map<String, String> danach = Bestandsschutz.fingerabdruck(root, List.of());
        flyway().load().migrate();
        assertThat(Bestandsschutz.abweichungen(vorher, danach)).as("die Migration ändert keinen Bestand").isEmpty();
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of())))
                .as("auch nach dem ganzen Lauf").isEmpty();
        for (String tabelle : TABELLEN) {
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle, Integer.class)).as(tabelle).isZero();
            // RLS + FORCE.
            assertThat(root.queryForMap("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ?",
                    tabelle)).as(tabelle).containsEntry("relrowsecurity", true).containsEntry("relforcerowsecurity", true);
            assertThat(recht(root, tabelle, ADMIN_USER, "DELETE")).as(tabelle).isTrue();
        }
        // Fähigkeit: anhängen und aufheben, nie umschreiben oder löschen.
        assertThat(recht(root, "ladepunkt_faehigkeit", APP_USER, "INSERT")).isTrue();
        assertThat(recht(root, "ladepunkt_faehigkeit", APP_USER, "DELETE")).isFalse();
        assertThat(recht(root, "ladepunkt_faehigkeit", APP_USER, "UPDATE")).isFalse();
        assertThat(root.queryForObject("SELECT has_column_privilege(?, 'ladepunkt_faehigkeit', 'aufgehoben_am', "
                + "'UPDATE')", Boolean.class, APP_USER)).isTrue();
        assertThat(root.queryForObject("SELECT has_column_privilege(?, 'ladepunkt_faehigkeit', 'nutzbarkeit', "
                + "'UPDATE')", Boolean.class, APP_USER)).isFalse();
        // Fahrzeugfenster: der laufende Stand wird ersetzt.
        assertThat(recht(root, "ladepunkt_fahrzeugfenster", APP_USER, "UPDATE")).isTrue();
        assertThat(recht(root, "ladepunkt_anwesenheit", APP_USER, "DELETE")).isTrue();

        // Der Mandantenzaun und die CHECKs der Festlegung.
        root.update("INSERT INTO ladepunkt_faehigkeit (tenant_id, site_id, komponente_id, nutzbarkeit, v2h, "
                + "gueltig_ab) VALUES (?, ?, ?, 'bidirektional', TRUE, '2026-10-01')", t2, fremdeAnlage, fremd);
        JdbcTemplate app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        TenantContext.set(t1);
        try {
            app.update("INSERT INTO ladepunkt_faehigkeit (tenant_id, site_id, komponente_id, nutzbarkeit, v2h, v2g, "
                    + "gueltig_ab) VALUES (?, ?, ?, 'bidirektional', TRUE, TRUE, '2026-10-01')", t1, anlage, saeule);
            assertThat(app.queryForObject("SELECT count(*) FROM ladepunkt_faehigkeit", Integer.class)).isEqualTo(1);
            assertThatThrownBy(() -> app.update("INSERT INTO ladepunkt_faehigkeit (tenant_id, site_id, komponente_id, "
                    + "nutzbarkeit, v2h, gueltig_ab) VALUES (?, ?, ?, 'bidirektional', TRUE, '2026-11-01')", t2,
                    fremdeAnlage, fremd)).rootCause().hasMessageContaining("row-level security");
            assertThatThrownBy(() -> app.update("INSERT INTO ladepunkt_faehigkeit (tenant_id, site_id, komponente_id, "
                    + "nutzbarkeit, v2h, gueltig_ab) VALUES (?, ?, ?, 'unidirektional', TRUE, '2026-11-01')", t1,
                    anlage, wallbox)).rootCause().hasMessageContaining("ladepunkt_faehigkeit_betriebsweise_chk");
            assertThatThrownBy(() -> app.update("INSERT INTO ladepunkt_faehigkeit (tenant_id, site_id, komponente_id, "
                    + "nutzbarkeit, gueltig_ab) VALUES (?, ?, ?, 'bidirektional', '2026-11-01')", t1, anlage,
                    wallbox)).rootCause().hasMessageContaining("ladepunkt_faehigkeit_betriebsweise_chk");
            assertThatThrownBy(() -> app.update("INSERT INTO ladepunkt_faehigkeit (tenant_id, site_id, komponente_id, "
                    + "nutzbarkeit, v2g, rueckspeisung_bei_einspeisung_unterbunden, gueltig_ab) VALUES (?, ?, ?, "
                    + "'bidirektional', TRUE, TRUE, '2026-11-01')", t1, anlage, wallbox))
                    .rootCause().hasMessageContaining("ladepunkt_faehigkeit_unterbunden_chk");
            // Die Komponente gehört zur Anlage: eine andere Anlage im Schlüssel scheitert am Fremdschlüssel.
            UUID zweite = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Zweite') RETURNING id",
                    UUID.class, t1);
            assertThatThrownBy(() -> app.update("INSERT INTO ladepunkt_faehigkeit (tenant_id, site_id, komponente_id, "
                    + "nutzbarkeit, gueltig_ab) VALUES (?, ?, ?, 'unidirektional', '2026-11-01')", t1, zweite, saeule))
                    .rootCause().hasMessageContaining("ladepunkt_faehigkeit_komponente_fk");
            app.update("INSERT INTO ladepunkt_fahrzeugfenster (komponente_id, tenant_id, site_id, mindest_soc_pct) "
                    + "VALUES (?, ?, ?, 30)", saeule, t1, anlage);
            app.update("INSERT INTO ladepunkt_anwesenheit (komponente_id, tenant_id, wochentag, ankunft, abfahrt) "
                    + "VALUES (?, ?, 1, '18:00', '07:00')", saeule, t1);
            assertThatThrownBy(() -> app.update("INSERT INTO ladepunkt_anwesenheit (komponente_id, tenant_id, "
                    + "wochentag, ankunft, abfahrt) VALUES (?, ?, 8, '18:00', '07:00')", saeule, t1))
                    .rootCause().hasMessageContaining("ladepunkt_anwesenheit_wochentag_chk");
        } finally {
            TenantContext.clear();
        }
        // Die Komponente nimmt ihre Zeilen mit (ON DELETE CASCADE) — Fähigkeit, Fenster und Anwesenheit.
        root.update("DELETE FROM measurement_point WHERE id = ?", saeule);
        for (String tabelle : TABELLEN) {
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE komponente_id = ?",
                    Integer.class, saeule)).as(tabelle).isZero();
        }
        assertThat(root.queryForObject("SELECT count(*) FROM ladepunkt_faehigkeit WHERE tenant_id = ?", Integer.class,
                t2)).isEqualTo(1);
    }

    private static UUID komponente(JdbcTemplate root, UUID t, UUID anlage, UUID box, String typ) {
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "device_id, control, communication, connection_json, capabilities) VALUES (?, ?, ?, ?, ?, ?, false, "
                + "'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, "
                + "'{\"measure\":[{\"channel\":\"power_kw\",\"unit\":\"kW\"}]}'::jsonb) RETURNING id", UUID.class, t,
                anlage, typ, typ, typ, box);
    }

    private static boolean recht(JdbcTemplate root, String tabelle, String rolle, String recht) {
        return root.queryForObject("SELECT has_table_privilege(?, ?, ?)", Boolean.class, rolle, tabelle, recht);
    }

    private static String letzteFassungVorDieser() {
        MigrationVersion diese = MigrationVersion.fromVersion(DIESE);
        return Arrays.stream(flyway().load().info().all())
                .map(MigrationInfo::getVersion)
                .filter(v -> v != null && v.compareTo(diese) < 0)
                .max(Comparator.naturalOrder())
                .orElseThrow()
                .getVersion();
    }

    private static FluentConfiguration flyway() {
        return Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of(
                        "appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW));
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
