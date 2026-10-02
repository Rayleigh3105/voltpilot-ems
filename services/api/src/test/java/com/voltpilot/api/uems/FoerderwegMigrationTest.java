package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.voltpilot.api.mispel.FoerderwegRegeln;
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
 * Die Migration {@code V20261002141500} (MiSpeL MP-5, Förderweg je Einspeisestelle) auf einer BEFÜLLTEN Datenbank:
 * Anlagen mit allen vier Schalter-Kombinationen vorher, dann bis zum neuesten Stand. Geprüft wird: kein Bestand
 * ändert sich (Fingerabdruck), {@code site_foerderweg} beginnt leer, jede Anlage hat den Förderweg ihrer Schalter
 * und dessen Spiegel ist bitgenau der Schalter; RLS + FORCE, beschnittene Rechte, der Mandantenzaun. Die frische
 * Datenbank migriert {@code FoerderwegApiTest}.
 */
@Testcontainers(disabledWithoutDocker = true)
class FoerderwegMigrationTest {

    private static final String DIESE = "20261002141500";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

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
        assertThat(root.queryForObject("SELECT to_regclass('site_foerderweg') IS NULL", Boolean.class)).isTrue();

        UUID t1 = root.queryForObject("INSERT INTO tenant (name) VALUES ('MiSpeL MP-5 A') RETURNING id", UUID.class);
        UUID t2 = root.queryForObject("INSERT INTO tenant (name) VALUES ('MiSpeL MP-5 B') RETURNING id", UUID.class);
        Object[][] schalter = {{false, "eigenverbrauch"}, {false, "direktvermarktung"}, {true, "eigenverbrauch"},
                {true, "direktvermarktung"}};
        for (Object[] s : schalter) {
            root.update("INSERT INTO site (tenant_id, name, plant_kind, netzladen_erlaubt) VALUES (?, ?, ?, ?)", t1,
                    "Anlage " + s[0] + " " + s[1], s[1], s[0]);
        }
        UUID fremd = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Fremd') RETURNING id",
                UUID.class, t2);
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());

        flyway().target(DIESE).load().migrate();
        Map<String, String> danach = Bestandsschutz.fingerabdruck(root, List.of());
        flyway().load().migrate();
        assertThat(Bestandsschutz.abweichungen(vorher, danach)).as("die Migration ändert keinen Bestand").isEmpty();
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of())))
                .as("auch nach dem ganzen Lauf").isEmpty();
        assertThat(root.queryForObject("SELECT count(*) FROM site_foerderweg", Integer.class)).isZero();

        // Jede Bestandsanlage hat den Förderweg ihrer Schalter — und sein Spiegel ist der Schalter.
        for (Map<String, Object> s : root.queryForList("SELECT netzladen_erlaubt, plant_kind FROM site WHERE tenant_id = ?",
                t1)) {
            boolean netz = (Boolean) s.get("netzladen_erlaubt");
            String art = (String) s.get("plant_kind");
            FoerderwegRegeln.Foerderweg weg = FoerderwegRegeln.ausBestand(netz, art).foerderweg();
            assertThat(weg).isEqualTo(netz ? FoerderwegRegeln.Foerderweg.UNGEFOERDERT
                    : "direktvermarktung".equals(art) ? FoerderwegRegeln.Foerderweg.MARKTPRAEMIE_AUSSCHLIESSLICHKEIT
                    : FoerderwegRegeln.Foerderweg.EINSPEISEVERGUETUNG);
            assertThat(FoerderwegRegeln.netzladenNachher(weg, null, netz)).isEqualTo(netz);
            assertThat(weg.plantKind() == null ? art : weg.plantKind()).isEqualTo(art);
        }

        // RLS + FORCE und die beschnittenen Rechte.
        assertThat(root.queryForMap("SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
                + "WHERE relname = 'site_foerderweg'")).containsEntry("relrowsecurity", true)
                .containsEntry("relforcerowsecurity", true);
        assertThat(recht(root, APP_USER, "SELECT")).isTrue();
        assertThat(recht(root, APP_USER, "INSERT")).isTrue();
        assertThat(recht(root, APP_USER, "DELETE")).isFalse();
        assertThat(recht(root, APP_USER, "UPDATE")).isFalse();
        assertThat(root.queryForObject("SELECT has_column_privilege(?, 'site_foerderweg', 'aufgehoben_am', 'UPDATE')",
                Boolean.class, APP_USER)).isTrue();
        assertThat(root.queryForObject("SELECT has_column_privilege(?, 'site_foerderweg', 'foerderweg', 'UPDATE')",
                Boolean.class, APP_USER)).isFalse();
        assertThat(recht(root, ADMIN_USER, "DELETE")).isTrue();

        // Der Mandantenzaun: die App-Rolle sieht nur ihre Zeilen und schreibt keine fremden.
        UUID eigene = root.queryForObject("SELECT id FROM site WHERE tenant_id = ? LIMIT 1", UUID.class, t1);
        root.update("INSERT INTO site_foerderweg (tenant_id, site_id, foerderweg, gueltig_ab) VALUES (?, ?, "
                + "'ungefoerdert', '2026-10-01')", t2, fremd);
        JdbcTemplate app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        TenantContext.set(t1);
        try {
            app.update("INSERT INTO site_foerderweg (tenant_id, site_id, foerderweg, formelsatz, einverstaendnis, "
                    + "gueltig_ab) VALUES (?, ?, 'marktpraemie_abgrenzung', 'A1', TRUE, '2026-10-01')", t1, eigene);
            assertThat(app.queryForObject("SELECT count(*) FROM site_foerderweg", Integer.class)).isEqualTo(1);
            assertThatThrownBy(() -> app.update("INSERT INTO site_foerderweg (tenant_id, site_id, foerderweg, "
                    + "gueltig_ab) VALUES (?, ?, 'ungefoerdert', '2026-11-01')", t2, fremd))
                    .rootCause().hasMessageContaining("row-level security");
            assertThatThrownBy(() -> app.update("INSERT INTO site_foerderweg (tenant_id, site_id, foerderweg, "
                    + "gueltig_ab) VALUES (?, ?, 'marktpraemie_abgrenzung', '2026-11-01')", t1, eigene))
                    .as("Abgrenzung ohne Formelsatz").rootCause().hasMessageContaining("site_foerderweg_formelsatz_passt_chk");
            assertThatThrownBy(() -> app.update("INSERT INTO site_foerderweg (tenant_id, site_id, foerderweg, "
                    + "formelsatz, gueltig_ab) VALUES (?, ?, 'marktpraemie_abgrenzung', 'A2', '2026-11-01')", t1,
                    eigene)).rootCause().hasMessageContaining("site_foerderweg_formelsatz_chk");
        } finally {
            TenantContext.clear();
        }
        // Die Anlage nimmt ihre Fassungen mit (ON DELETE CASCADE).
        root.update("DELETE FROM site WHERE id = ?", fremd);
        assertThat(root.queryForObject("SELECT count(*) FROM site_foerderweg WHERE site_id = ?", Integer.class, fremd))
                .isZero();
    }

    private static boolean recht(JdbcTemplate root, String rolle, String recht) {
        return root.queryForObject("SELECT has_table_privilege(?, 'site_foerderweg', ?)", Boolean.class, rolle, recht);
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
