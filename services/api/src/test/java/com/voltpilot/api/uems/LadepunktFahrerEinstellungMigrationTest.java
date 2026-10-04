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
 * Die Migration {@code V20261004114700} (MiSpeL MP-41a, Einstellungen des Fahrers am Ladepunkt) auf einer BEFÜLLTEN
 * Datenbank: ein bidirektionaler Ladepunkt mit Fähigkeit und Fahrzeugfenster vorher, dann bis zum neuesten Stand.
 * Geprüft wird: kein Bestand ändert sich (Fingerabdruck), beide Tabellen beginnen leer — jeder Ladepunkt hat damit
 * Zurückspeisen „aus“ —, RLS + FORCE, Rechte, die CHECKs (Vokabular des Fahrplans 2.0, Akku schonen, Wochentag), der
 * Mandantenzaun und dass die Komponente ihre Zeilen mitnimmt. Die frische Datenbank migriert
 * {@code LadepunktBidirektionalApiTest}.
 */
@Testcontainers(disabledWithoutDocker = true)
class LadepunktFahrerEinstellungMigrationTest {

    private static final String DIESE = "20261004114700";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final List<String> TABELLEN = List.of("ladepunkt_fahrer_einstellung", "ladepunkt_abfahrt");

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
        assertThat(root.queryForObject("SELECT to_regclass('ladepunkt_fahrer_einstellung') IS NULL", Boolean.class))
                .isTrue();

        UUID t1 = root.queryForObject("INSERT INTO tenant (name) VALUES ('MiSpeL MP-41a A') RETURNING id", UUID.class);
        UUID t2 = root.queryForObject("INSERT INTO tenant (name) VALUES ('MiSpeL MP-41a B') RETURNING id", UUID.class);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Haus Albers') RETURNING id",
                UUID.class, t1);
        UUID fremdeAnlage = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Fremd') RETURNING id",
                UUID.class, t2);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, "
                + "'VP-BOX-MP41A-A', 'claimed') RETURNING id", UUID.class, t1, anlage);
        UUID fremdeBox = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, "
                + "'VP-BOX-MP41A-B', 'claimed') RETURNING id", UUID.class, t2, fremdeAnlage);
        UUID wallbox = komponente(root, t1, anlage, box, "wallbox");
        UUID fremd = komponente(root, t2, fremdeAnlage, fremdeBox, "ev-charger");
        root.update("INSERT INTO ladepunkt_faehigkeit (tenant_id, site_id, komponente_id, nutzbarkeit, v2h, v2g, "
                + "gueltig_ab) VALUES (?, ?, ?, 'bidirektional', TRUE, TRUE, '2026-10-01')", t1, anlage, wallbox);
        root.update("INSERT INTO ladepunkt_fahrzeugfenster (komponente_id, tenant_id, site_id, mindest_soc_pct, "
                + "kapazitaet_kwh) VALUES (?, ?, ?, 40, 64)", wallbox, t1, anlage);
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());

        flyway().target(DIESE).load().migrate();
        Map<String, String> danach = Bestandsschutz.fingerabdruck(root, List.of());
        flyway().load().migrate();
        assertThat(Bestandsschutz.abweichungen(vorher, danach)).as("die Migration ändert keinen Bestand").isEmpty();
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of())))
                .as("auch nach dem ganzen Lauf").isEmpty();
        for (String tabelle : TABELLEN) {
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle, Integer.class)).as(tabelle).isZero();
            assertThat(root.queryForMap("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ?",
                    tabelle)).as(tabelle).containsEntry("relrowsecurity", true).containsEntry("relforcerowsecurity", true);
            assertThat(recht(root, tabelle, APP_USER, "INSERT")).as(tabelle).isTrue();
            assertThat(recht(root, tabelle, APP_USER, "DELETE")).as(tabelle).isTrue();
            assertThat(recht(root, tabelle, ADMIN_USER, "DELETE")).as(tabelle).isTrue();
            assertThat(recht(root, tabelle, ADMIN_USER, "INSERT")).as(tabelle).isFalse();
        }
        assertThat(recht(root, "ladepunkt_fahrer_einstellung", APP_USER, "UPDATE")).isTrue();
        assertThat(recht(root, "ladepunkt_abfahrt", APP_USER, "UPDATE")).isFalse();

        // Der Mandantenzaun und die CHECKs.
        root.update("INSERT INTO ladepunkt_fahrer_einstellung (komponente_id, tenant_id, site_id, rueckspeisen) "
                + "VALUES (?, ?, ?, 'v2g')", fremd, t2, fremdeAnlage);
        JdbcTemplate app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        TenantContext.set(t1);
        try {
            app.update("INSERT INTO ladepunkt_fahrer_einstellung (komponente_id, tenant_id, site_id, rueckspeisen, "
                    + "vollzyklen_je_tag) VALUES (?, ?, ?, 'v2h', 0.5)", wallbox, t1, anlage);
            assertThat(app.queryForObject("SELECT count(*) FROM ladepunkt_fahrer_einstellung", Integer.class))
                    .isEqualTo(1);
            assertThat(app.queryForObject("SELECT rueckspeisen FROM ladepunkt_fahrer_einstellung", String.class))
                    .isEqualTo("v2h");
            assertThatThrownBy(() -> app.update("INSERT INTO ladepunkt_fahrer_einstellung (komponente_id, tenant_id, "
                    + "site_id) VALUES (?, ?, ?)", fremd, t2, fremdeAnlage))
                    .rootCause().hasMessageContaining("row-level security");
            assertThatThrownBy(() -> app.update("UPDATE ladepunkt_fahrer_einstellung SET rueckspeisen = 'ja'"))
                    .rootCause().hasMessageContaining("ladepunkt_fahrer_einstellung_rueckspeisen_chk");
            assertThatThrownBy(() -> app.update("UPDATE ladepunkt_fahrer_einstellung SET vollzyklen_je_tag = 3"))
                    .rootCause().hasMessageContaining("ladepunkt_fahrer_einstellung_zyklen_chk");
            assertThatThrownBy(() -> app.update("UPDATE ladepunkt_fahrer_einstellung SET naechste_fahrt_abfahrt = "
                    + "now()")).rootCause().hasMessageContaining("ladepunkt_fahrer_einstellung_naechste_chk");
            app.update("INSERT INTO ladepunkt_abfahrt (komponente_id, tenant_id, wochentag, abfahrt, abfahrt_soc_pct) "
                    + "VALUES (?, ?, 1, '07:15', 80), (?, ?, 2, '07:15', 80)", wallbox, t1, wallbox, t1);
            assertThatThrownBy(() -> app.update("INSERT INTO ladepunkt_abfahrt (komponente_id, tenant_id, wochentag, "
                    + "abfahrt, abfahrt_soc_pct) VALUES (?, ?, 1, '09:00', 80)", wallbox, t1))
                    .rootCause().hasMessageContaining("ladepunkt_abfahrt_pkey");
            assertThatThrownBy(() -> app.update("INSERT INTO ladepunkt_abfahrt (komponente_id, tenant_id, wochentag, "
                    + "abfahrt, abfahrt_soc_pct) VALUES (?, ?, 8, '09:00', 80)", wallbox, t1))
                    .rootCause().hasMessageContaining("ladepunkt_abfahrt_wochentag_chk");
        } finally {
            TenantContext.clear();
        }
        // Die Komponente nimmt ihre Zeilen mit (ON DELETE CASCADE).
        root.update("DELETE FROM measurement_point WHERE id = ?", wallbox);
        for (String tabelle : TABELLEN) {
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE komponente_id = ?",
                    Integer.class, wallbox)).as(tabelle).isZero();
        }
        assertThat(root.queryForObject("SELECT count(*) FROM ladepunkt_fahrer_einstellung WHERE tenant_id = ?",
                Integer.class, t2)).isEqualTo(1);
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
