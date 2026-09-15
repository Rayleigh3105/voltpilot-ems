package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.io.IOException;
import java.math.BigInteger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.flywaydb.core.api.output.MigrateResult;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Abwahl einer Kennzahl in einem Bericht ({@code V20260915113000}, UEMS AP-12 IP-6, Q4/V3) fährt die Hausregeln mit:
 * RLS und FORCE mit Mandantenzaun, beschnittene Rechte ohne DELETE für die Anwendung, Mandant und Bericht mit RESTRICT,
 * das Offboarding räumt ab, der Bestand bleibt zeichengleich, und sie trägt als späte Ankunft. Die Bedeutung — keine Zeile
 * heißt gewählt — beweist {@code BerichtAbzugBildungTest} am Abzug.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsBerichtKennzahlAbwahlMigrationTest {

    private static final String DIESE = "20260915113000";
    private static final String TABELLE = "bericht_kennzahl_abwahl";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final Path MIGRATIONEN = Path.of("src", "main", "resources", "db", "migration");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;
    private static Kunde a;
    private static Kunde b;

    private record Kunde(UUID tenant, UUID bericht) {}

    @BeforeAll
    static void bestandUndMigration() throws IOException {
        root = new JdbcTemplate(ds(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway(POSTGRES.getJdbcUrl()).target(letzteFassungVorDieser()).load().migrate();
        a = kunde("Kunststoffwerk Ahrenberg GmbH");
        b = kunde("Kundenbereich B");
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());

        flyway(POSTGRES.getJdbcUrl()).target(DIESE).load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, List.of());
        flyway(POSTGRES.getJdbcUrl()).load().migrate();

        app = new JdbcTemplate(new TenantAwareDataSource(ds(POSTGRES.getJdbcUrl(), APP_USER, APP_PW)));
    }

    // ============================================================ Zaun und Rechte

    @Test
    void rlsUndForce_undDerZaunHaeltGegenEinenFremdenKundenbereich() {
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = ?",
                Boolean.class, TABELLE)).isTrue();
        UUID kennzahl = UUID.randomUUID();
        abwaehlen(a, kennzahl);
        abwaehlen(b, kennzahl);
        TenantContext.set(a.tenant());
        try {
            assertThat(app.queryForList("SELECT tenant_id FROM bericht_kennzahl_abwahl WHERE kennzahl_id = ?",
                    UUID.class, kennzahl)).containsExactly(a.tenant());
            assertThatThrownBy(() -> app.update("INSERT INTO bericht_kennzahl_abwahl (tenant_id, bericht_id, "
                    + "kennzahl_id, abgewaehlt_von_name) VALUES (?, ?, ?, 'Ines Kaltenbach')", b.tenant(), b.bericht(),
                    UUID.randomUUID())).as("WITH CHECK des Zauns").isInstanceOf(DataAccessException.class);
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void dieRechteSindBeschnitten_keinDeleteFuerDieAnwendung() {
        assertThat(recht(APP_USER, "SELECT")).isTrue();
        assertThat(recht(APP_USER, "INSERT")).isTrue();
        assertThat(recht(APP_USER, "UPDATE")).as("nur spaltenweise").isFalse();
        assertThat(recht(APP_USER, "DELETE")).isFalse();
        assertThat(spalte(APP_USER, "aufgehoben_am")).isTrue();
        for (String s : List.of("tenant_id", "bericht_id", "kennzahl_id", "abgewaehlt_am", "abgewaehlt_von_name")) {
            assertThat(spalte(APP_USER, s)).as(s).isFalse();
        }
        assertThat(recht(ADMIN_USER, "SELECT")).isTrue();
        assertThat(recht(ADMIN_USER, "DELETE")).as("das Offboarding").isTrue();
        assertThat(recht(ADMIN_USER, "INSERT")).isFalse();
        assertThat(recht(ADMIN_USER, "UPDATE")).isFalse();
    }

    @Test
    void jeKennzahlHoechstensEineWirksameAbwahl_undEineAufgehobeneBleibtWieSieIst() {
        UUID kennzahl = UUID.randomUUID();
        UUID erste = abwaehlen(a, kennzahl);
        assertThatThrownBy(() -> abwaehlen(a, kennzahl)).isInstanceOf(DataAccessException.class)
                .hasMessageContaining("bericht_kennzahl_abwahl_wirksam_uq");
        TenantContext.set(a.tenant());
        try {
            assertThat(app.update("UPDATE bericht_kennzahl_abwahl SET aufgehoben_am = now() WHERE id = ?", erste))
                    .isEqualTo(1);
            assertThatThrownBy(() -> app.update("UPDATE bericht_kennzahl_abwahl SET aufgehoben_am = now() "
                    + "WHERE id = ?", erste)).isInstanceOf(DataAccessException.class)
                    .hasMessageContaining("bericht_kennzahl_abwahl_aufgehoben");
            assertThatThrownBy(() -> app.update("DELETE FROM bericht_kennzahl_abwahl WHERE id = ?", erste))
                    .isInstanceOf(DataAccessException.class);
        } finally {
            TenantContext.clear();
        }
        assertThat(abwaehlen(a, kennzahl)).as("nach dem Aufheben wieder abwählbar").isNotEqualTo(erste);
    }

    /** Bericht und Kennzahl ohne Fremdschlüssel: weder ihr Löschweg noch der eines Berichts wird enger (IP-4-Regel). */
    @Test
    void keinFremdschluesselAufBerichtOderKennzahl_keinLoeschwegWirdEnger() {
        assertThat(root.queryForList("SELECT confrelid::regclass::text FROM pg_constraint WHERE conrelid = ?::regclass "
                + "AND contype = 'f' ORDER BY 1", String.class, TABELLE)).containsExactly("tenant");
        assertThat(root.queryForList("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = ?::regclass "
                + "AND contype = 'f'", String.class, TABELLE)).allSatisfy(d -> assertThat(d).contains("RESTRICT"));
    }

    @Test
    void dasOffboardingRaeumtDieAbwahlAb_undLaesstDenAnderenKundenbereich() {
        Kunde weg = kunde("Offboarding");
        abwaehlen(weg, UUID.randomUUID());
        abwaehlen(b, UUID.randomUUID());
        long andere = root.queryForObject("SELECT count(*) FROM bericht_kennzahl_abwahl WHERE tenant_id <> ?", Long.class,
                weg.tenant());

        new TenantRepository(new JdbcTemplate(ds(POSTGRES.getJdbcUrl(), ADMIN_USER, ADMIN_PW))).offboard(weg.tenant());

        assertThat(root.queryForObject("SELECT count(*) FROM bericht_kennzahl_abwahl WHERE tenant_id = ?", Long.class,
                weg.tenant())).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM bericht_kennzahl_abwahl WHERE tenant_id <> ?", Long.class,
                weg.tenant())).isEqualTo(andere);
        assertThat(root.queryForObject("SELECT count(*) FROM tenant WHERE id = ?", Long.class, weg.tenant())).isZero();
    }

    // ============================================================ Bestand, out-of-order

    @Test
    void dieMigrationLegtNurDanebenUndLaesstDenBestandZeichengleich() {
        assertThat(fingerVorher).doesNotContainKey(TABELLE);
        assertThat(fingerVorher.get("bericht")).as("es gibt Berichte").isNotEqualTo(Bestandsschutz.LEER);
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
        assertThat(fingerNachMigration).containsEntry(TABELLE, Bestandsschutz.LEER);
    }

    /** Der Vergleich beißt noch: eine geänderte Bestandszeile fällt auf. */
    @Test
    void derBestandsvergleichFaengtEineGeaenderteZeile() {
        Bestandsschutz.mutationsprobe(root, List.of(), "unternehmen", "UPDATE unternehmen SET name = name || ' (Probe)'");
    }

    @Test
    void dieMigrationTraegtAuchAlsSpaeteAnkunft() throws IOException {
        root.execute("CREATE DATABASE voltpilot_spaet");
        Path ohneDiese = Files.createTempDirectory("migrationen-ohne-abwahl");
        try (var dateien = Files.list(MIGRATIONEN)) {
            for (Path datei : dateien.toList()) {
                if (!datei.getFileName().toString().startsWith("V" + DIESE + "__")) {
                    Files.copy(datei, ohneDiese.resolve(datei.getFileName()));
                }
            }
        }
        String url = POSTGRES.getJdbcUrl().replaceFirst("/voltpilot(?=\\?|$)", "/voltpilot_spaet");
        flyway(url).locations("filesystem:" + ohneDiese.toAbsolutePath()).load().migrate();
        MigrateResult spaet = flyway(url).outOfOrder(true).load().migrate();
        assertThat(spaet.migrations).extracting(m -> m.version).containsExactly(DIESE);

        JdbcTemplate db = new JdbcTemplate(ds(url, POSTGRES.getUsername(), POSTGRES.getPassword()));
        for (String sql : List.of(
                "SELECT column_name || ':' || data_type || ':' || is_nullable FROM information_schema.columns "
                        + "WHERE table_schema = 'public' AND table_name = '" + TABELLE + "' ORDER BY ordinal_position",
                "SELECT conname || ' ' || pg_get_constraintdef(oid) FROM pg_constraint "
                        + "WHERE conrelid = '" + TABELLE + "'::regclass ORDER BY 1",
                "SELECT indexname || ' ' || indexdef FROM pg_indexes WHERE tablename = '" + TABELLE + "' ORDER BY 1",
                "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = '" + TABELLE + "'::regclass ORDER BY 1",
                "SELECT policyname || ' ' || qual || ' ' || with_check FROM pg_policies WHERE tablename = '" + TABELLE + "'",
                "SELECT grantee || ' ' || privilege_type FROM information_schema.role_table_grants "
                        + "WHERE table_name = '" + TABELLE + "' ORDER BY 1",
                "SELECT grantee || ' ' || column_name || ' ' || privilege_type FROM information_schema.column_privileges "
                        + "WHERE table_name = '" + TABELLE + "' AND privilege_type = 'UPDATE' ORDER BY 1")) {
            assertThat(db.queryForList(sql, String.class)).as(sql).isNotEmpty()
                    .isEqualTo(root.queryForList(sql, String.class));
        }
    }

    // ===================================================================== Gerüst

    private static Kunde kunde(String name) {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, name);
        UUID s = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, ?, 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u, "Werk " + name);
        UUID bericht = root.queryForObject("INSERT INTO bericht (tenant_id, kennung, vorlage, vorlage_fassung, geltung_art, "
                + "standort_id, zeitraum_art, zeitraum_schluessel, zeitzone, angelegt_von_name) VALUES (?, 'BR-2026-0001', "
                + "'monatsbericht_standort', 1, 'standort', ?, 'monat', '2026-10', 'Europe/Berlin', 'Ines Kaltenbach') "
                + "RETURNING id", UUID.class, t, s);
        return new Kunde(t, bericht);
    }

    /** Eine Abwahl, geschrieben wie die Anwendung sie schreibt — im Zaun des Kundenbereichs. */
    private static UUID abwaehlen(Kunde k, UUID kennzahl) {
        TenantContext.set(k.tenant());
        try {
            return app.queryForObject("INSERT INTO bericht_kennzahl_abwahl (tenant_id, bericht_id, kennzahl_id, "
                    + "abgewaehlt_von_sub, abgewaehlt_von_name) VALUES (?, ?, ?, 'sub-ik', 'Ines Kaltenbach') RETURNING id",
                    UUID.class, k.tenant(), k.bericht(), kennzahl);
        } finally {
            TenantContext.clear();
        }
    }

    private static boolean recht(String rolle, String recht) {
        return Boolean.TRUE.equals(root.queryForObject("SELECT has_table_privilege(?, ?, ?)", Boolean.class, rolle,
                TABELLE, recht));
    }

    private static boolean spalte(String rolle, String spalte) {
        return Boolean.TRUE.equals(root.queryForObject("SELECT has_column_privilege(?, ?, ?, 'UPDATE')", Boolean.class,
                rolle, TABELLE, spalte));
    }

    private static String letzteFassungVorDieser() throws IOException {
        BigInteger diese = new BigInteger(DIESE);
        try (var dateien = Files.list(MIGRATIONEN)) {
            return dateien.map(p -> p.getFileName().toString())
                    .filter(n -> n.startsWith("V") && n.contains("__"))
                    .map(n -> n.substring(1, n.indexOf("__")))
                    .filter(v -> v.matches("[0-9]+") && new BigInteger(v).compareTo(diese) < 0)
                    .max(Comparator.comparing(BigInteger::new))
                    .orElseThrow();
        }
    }

    private static FluentConfiguration flyway(String url) {
        return Flyway.configure()
                .dataSource(url, POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW));
    }

    private static DataSource ds(String url, String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(url);
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
