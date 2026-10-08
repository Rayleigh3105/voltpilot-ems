package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Konzept Nachweisen n1, Runde 2, PR 6 (V20261007150000): die Mappe „Unterlagen zusammenstellen“ und ihr Abruf-Protokoll
 * unter der wirklichen App-Rolle. Die Datenbank hält Anlass, Gruppen und offene Teile an den Wörtern des Vertrags, die
 * Prüfsummen, den Akteur, die Dateien nur gemeinsam; eine Mappe ändert sich nie, nur ihre Dateien werden nach der Frist
 * geleert; die App-Rolle löscht nie; Mandanten- und Standort-Zaun; die Migration legt nur daneben und trägt auch als
 * späte Ankunft.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsMappeMigrationTest {

    private static final String DIESE = "20261007150000";
    private static final String APP = "voltpilot_app", ADMIN = "voltpilot_admin", PW = "n3b_mappe_test_pw";
    private static final List<String> TABELLEN = List.of("energiemanagement_mappe", "energiemanagement_mappe_abruf");
    private static final String SHA = "a".repeat(64);
    /** Spätere Migrationen, die auf diese aufbauen: sie reisen bei der späten Ankunft mit. */
    private static final List<String> BAUEN_DARAUF_AUF = List.of();

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root, app, admin;
    private static Map<String, String> fingerVorher, fingerNachMigration;

    private record Kunde(UUID tenant, UUID st1, UUID st2) {}

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway(POSTGRES.getJdbcUrl()).target(letzteFassungVorDieser()).load().migrate();
        TenantContext.clear();
        kunde("Kunststoffwerk Ahrenberg GmbH");
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());
        flyway(POSTGRES.getJdbcUrl()).target(DIESE).load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, List.of());
        flyway(POSTGRES.getJdbcUrl()).load().migrate();
        app = new JdbcTemplate(new TenantAwareDataSource(ds(POSTGRES.getJdbcUrl(), APP, PW)));
        admin = new JdbcTemplate(ds(POSTGRES.getJdbcUrl(), ADMIN, PW));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ============================================================ CHECKs an den Wörtern des Vertrags

    @Test
    void anlassGruppenUndOffeneTeileStehenGenauAufDenWoerternDesVertrags() {
        Kunde k = kunde("Wörter");
        TenantContext.set(k.tenant());
        for (String anlass : EnergiemanagementRegeln.VOKABULARE.get("mappe_anlass")) {
            mappe(k, anlass, "{grundlagen}", "{}");
        }
        checkFehler("energiemanagement_mappe_anlass_chk", () -> mappe(k, "zertifizierung", "{grundlagen}", "{}"));
        // Review P6-0: der Anlass ist ein Block der Datenbank-Funktion wie jedes andere Vokabular des Vertrags.
        assertThat(root.queryForList("SELECT wort FROM energiemanagement_vokabular() WHERE vokabular = 'mappe_anlass' ORDER BY nr",
                String.class)).containsExactlyElementsOf(EnergiemanagementRegeln.VOKABULARE.get("mappe_anlass"));
        mappe(k, "eigene_ablage", "{" + String.join(",", EnergiemanagementRegeln.VOKABULARE.get("verzeichnis_gruppe")) + "}",
                "{" + String.join(",", EnergiemanagementRegeln.VOKABULARE.get("teil")) + "}");
        checkFehler("energiemanagement_mappe_gruppen_chk", () -> mappe(k, "eigene_ablage", "{}", "{}"));
        checkFehler("energiemanagement_mappe_gruppen_chk", () -> mappe(k, "eigene_ablage", "{grundlagen,sonstiges}", "{}"));
        checkFehler("energiemanagement_mappe_offen_chk", () -> mappe(k, "eigene_ablage", "{grundlagen}", "{Kontext}"));
        String sql = "INSERT INTO energiemanagement_mappe (tenant_id, anlass, von, bis, gruppen, stichtag, eintraege, gilt, "
                + "pdf, pdf_sha256, csv, csv_sha256, abrufbar_bis, actor_sub, actor_name, actor_art) VALUES (?, "
                + "'eigene_ablage', ?::date, '2029-04-30', '{grundlagen}', now(), ?, 0, ?, ?, ?, ?, now() + interval '30 days', "
                + "'IK', 'Ines Kaltenbach', 'kunde')";
        checkFehler("energiemanagement_mappe_zeitraum_chk", () -> app.update(sql, k.tenant(), "2029-05-01", 0,
                new byte[] {1}, SHA, new byte[] {1}, SHA));
        checkFehler("energiemanagement_mappe_zahlen_chk", () -> app.update(sql, k.tenant(), null, -1,
                new byte[] {1}, SHA, new byte[] {1}, SHA));
        checkFehler("energiemanagement_mappe_sha_chk", () -> app.update(sql, k.tenant(), null, 0,
                new byte[] {1}, "sha256:" + SHA, new byte[] {1}, SHA));
        checkFehler("energiemanagement_mappe_dateien_chk", () -> app.update(sql, k.tenant(), null, 0,
                new byte[] {1}, SHA, null, SHA));
    }

    // ============================================================ nie ändern, nur leeren, nie löschen

    @Test
    void eineMappeAendertSichNieNurIhreDateienGehenNachDerFristUndDieAppRolleLoeschtNie() {
        Kunde k = kunde("Nie ändern");
        TenantContext.set(k.tenant());
        UUID m = mappe(k, "audit_von_aussen", "{grundlagen}", "{kontext}");
        // Vor der Frist: auch das Leeren ist verwehrt; nach der Frist geht genau das Leeren, einmal.
        checkFehler("energiemanagement_mappe_frist", () -> app.update(
                "UPDATE energiemanagement_mappe SET pdf = NULL, csv = NULL WHERE id = ?", m));
        checkState("42501", null, () -> app.update("UPDATE energiemanagement_mappe SET anlass = 'eigene_ablage' WHERE id = ?", m));
        checkState("42501", null, () -> app.update("UPDATE energiemanagement_mappe SET abrufbar_bis = now() WHERE id = ?", m));
        checkState("42501", null, () -> app.update("DELETE FROM energiemanagement_mappe WHERE id = ?", m));
        checkFehler("energiemanagement_mappe_nur_leeren", () -> root.update(
                "UPDATE energiemanagement_mappe SET anlass = 'eigene_ablage' WHERE id = ?", m));
        abgelaufen(m);
        checkFehler("energiemanagement_mappe_nur_leeren", () -> app.update(
                "UPDATE energiemanagement_mappe SET pdf = '\\x00'::bytea, csv = NULL WHERE id = ?", m));
        assertThat(app.update("UPDATE energiemanagement_mappe SET pdf = NULL, csv = NULL WHERE id = ?", m)).isOne();
        checkFehler("energiemanagement_mappe_nur_leeren", () -> app.update(
                "UPDATE energiemanagement_mappe SET pdf = NULL, csv = NULL WHERE id = ?", m));
        assertThat(root.queryForObject("SELECT pdf IS NULL AND csv IS NULL AND anlass = 'audit_von_aussen' "
                + "FROM energiemanagement_mappe WHERE id = ?", Boolean.class, m)).isTrue();

        // Das Protokoll: nur anhängen.
        UUID a = app.queryForObject("INSERT INTO energiemanagement_mappe_abruf (tenant_id, mappe_id, format, actor_sub, "
                + "actor_name, actor_art) VALUES (?, ?, 'pdf', 'RF', 'Robert Falk', 'kunde') RETURNING id", UUID.class,
                k.tenant(), m);
        checkFehler("energiemanagement_mappe_abruf_format_chk", () -> app.update("INSERT INTO energiemanagement_mappe_abruf "
                + "(tenant_id, mappe_id, format, actor_sub, actor_name, actor_art) VALUES (?, ?, 'zip', 'RF', 'Robert Falk', "
                + "'kunde')", k.tenant(), m));
        checkState("42501", null, () -> app.update("UPDATE energiemanagement_mappe_abruf SET format = 'csv' WHERE id = ?", a));
        checkState("42501", null, () -> app.update("DELETE FROM energiemanagement_mappe_abruf WHERE id = ?", a));

        assertThat(root.queryForList("SELECT column_name FROM information_schema.column_privileges WHERE grantee = ? "
                + "AND table_name = 'energiemanagement_mappe' AND privilege_type = 'UPDATE' ORDER BY column_name",
                String.class, APP)).containsExactly("csv", "pdf");
        for (String t : TABELLEN) {
            assertThat(root.queryForObject("SELECT has_table_privilege(?, ?, 'DELETE') OR has_table_privilege(?, ?, "
                    + "'TRUNCATE')", Boolean.class, APP, t, APP, t)).as(t + ": die App-Rolle löscht nie").isFalse();
            assertThat(root.queryForObject("SELECT has_table_privilege(?, ?, 'DELETE')", Boolean.class, ADMIN, t))
                    .as(t + ": Offboarding").isTrue();
        }
    }

    // ============================================================ Mandant und Zaun

    @Test
    void mandantUndStandortZaun() {
        Kunde k = kunde("Zaun");
        Kunde fremd = kunde("Zaun, fremd");
        TenantContext.set(k.tenant());
        UUID m = mappe(k, "anfrage_behoerde", "{berichte}", "{}");
        for (String t : TABELLEN) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = ?",
                    Boolean.class, t)).as(t).isTrue();
            assertThat(root.queryForObject("SELECT count(*) FROM pg_policies WHERE tablename = ? AND policyname = "
                    + "'site_scope' AND permissive = 'RESTRICTIVE'", Integer.class, t)).as(t).isOne();
            assertThat(root.queryForObject("SELECT count(*) FROM pg_policies WHERE tablename = ? AND permissive = "
                    + "'PERMISSIVE'", Integer.class, t)).as(t + ": nur die Mandanten-Policy öffnet").isOne();
        }
        Integer weit = eng(k.tenant(), null, j -> j.queryForObject("SELECT count(*) FROM energiemanagement_mappe",
                Integer.class));
        Integer standorte = eng(k.tenant(), List.of(k.st1(), k.st2()), j -> j.queryForObject(
                "SELECT count(*) FROM energiemanagement_mappe", Integer.class));
        assertThat(weit).isOne();
        assertThat(standorte).as("im engen Standort-Zaun keine Mappe").isZero();
        checkState("42501", null, () -> eng(k.tenant(), List.of(k.st1()), j -> j.update("INSERT INTO "
                + "energiemanagement_mappe_abruf (tenant_id, mappe_id, format, actor_sub, actor_name, actor_art) "
                + "VALUES (?, ?, 'pdf', 'CB', 'Claudia Berger', 'kunde')", k.tenant(), m)));
        TenantContext.set(fremd.tenant());
        assertThat(app.queryForObject("SELECT count(*) FROM energiemanagement_mappe", Integer.class)).isZero();
        checkState("23503", "energiemanagement_mappe_abruf_mappe_fk", () -> app.update("INSERT INTO "
                + "energiemanagement_mappe_abruf (tenant_id, mappe_id, format, actor_sub, actor_name, actor_art) "
                + "VALUES (?, ?, 'pdf', 'FR', 'Frieda Fremd', 'kunde')", fremd.tenant(), m));
    }

    @Test
    void dasOffboardingRaeumtProtokollUndMappeAb() {
        Kunde k = kunde("Offboarding");
        TenantContext.set(k.tenant());
        UUID m = mappe(k, "audit_von_aussen", "{grundlagen}", "{}");
        app.update("INSERT INTO energiemanagement_mappe_abruf (tenant_id, mappe_id, format, actor_sub, actor_name, "
                + "actor_art) VALUES (?, ?, 'csv', 'IK', 'Ines Kaltenbach', 'kunde')", k.tenant(), m);
        TenantContext.clear();
        new TenantRepository(admin).offboard(k.tenant());
        for (String t : TABELLEN) {
            assertThat(root.queryForObject("SELECT count(*) FROM " + t + " WHERE tenant_id = ?", Integer.class, k.tenant()))
                    .as(t).isZero();
        }
        assertThat(root.queryForObject("SELECT count(*) FROM tenant WHERE id = ?", Integer.class, k.tenant())).isZero();
    }

    // ============================================================ Bestand und Reihenfolge

    @Test
    void dieMigrationLegtNurDanebenUndLaesstDenBestandZeichengleich() {
        assertThat(fingerVorher).hasSizeGreaterThan(100).doesNotContainKeys(TABELLEN.toArray(String[]::new));
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
        for (String tabelle : TABELLEN) {
            assertThat(fingerNachMigration).as(tabelle).containsEntry(tabelle, Bestandsschutz.LEER);
        }
    }

    /** Out-of-order: auf einer Datenbank mit ALLEN anderen Migrationen kommt diese zuletzt an und trägt genauso. */
    @Test
    void dieMigrationTraegtAuchAlsSpaeteAnkunft() throws IOException {
        root.execute("CREATE DATABASE voltpilot_spaet");
        String url = POSTGRES.getJdbcUrl().replace("/voltpilot?", "/voltpilot_spaet?");
        Path ohneDiese = Files.createTempDirectory("ohne-mappe");
        try (var dateien = Files.list(Path.of("src", "main", "resources", "db", "migration"))) {
            for (Path datei : dateien.toList()) {
                String name = datei.getFileName().toString();
                if (!name.startsWith("V" + DIESE + "__")
                        && BAUEN_DARAUF_AUF.stream().noneMatch(v -> name.startsWith("V" + v + "__"))) {
                    Files.copy(datei, ohneDiese.resolve(datei.getFileName()));
                }
            }
        }
        flyway(url).locations("filesystem:" + ohneDiese).load().migrate();
        var spaet = flyway(url).outOfOrder(true).load().migrate();
        List<String> spaeteAnkunft = new ArrayList<>(List.of(DIESE));
        spaeteAnkunft.addAll(BAUEN_DARAUF_AUF);
        assertThat(spaet.migrations).extracting(m -> m.version).containsExactlyElementsOf(spaeteAnkunft);
        JdbcTemplate spaetDb = new JdbcTemplate(ds(url, POSTGRES.getUsername(), POSTGRES.getPassword()));
        String tabellen = "(" + String.join(", ", TABELLEN.stream().map(t -> "'" + t + "'").toList()) + ")";
        for (String sql : List.of(
                "SELECT string_agg(conrelid::regclass || ':' || conname || ':' || pg_get_constraintdef(oid), '|' "
                        + "ORDER BY conrelid::regclass::text, conname) FROM pg_constraint WHERE conrelid::regclass::text IN "
                        + tabellen,
                "SELECT string_agg(indexname || ':' || indexdef, '|' ORDER BY indexname) FROM pg_indexes WHERE tablename IN "
                        + tabellen,
                "SELECT string_agg(tablename || ':' || policyname || ':' || permissive || ':' || qual, '|' "
                        + "ORDER BY tablename, policyname) FROM pg_policies WHERE tablename IN " + tabellen,
                "SELECT string_agg(tgname, '|' ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal "
                        + "AND tgrelid::regclass::text IN " + tabellen)) {
            assertThat(spaetDb.queryForObject(sql, String.class)).as(sql).isNotNull()
                    .isEqualTo(root.queryForObject(sql, String.class));
        }
    }

    // ============================================================ Gerüst

    private static Kunde kunde(String name) {
        UUID tenant = root.queryForObject("INSERT INTO tenant(name) VALUES (?) RETURNING id", UUID.class, name);
        UUID unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name) VALUES (?,?) RETURNING id",
                UUID.class, tenant, name);
        UUID st1 = UUID.randomUUID(), st2 = UUID.randomUUID();
        for (Object[] s : new Object[][] {{st1, "Werk Ahrenberg", "AHR"}, {st2, "Werk Lindach", "LIN"}}) {
            root.update("INSERT INTO standort (id, tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                    + "VALUES (?, ?, ?, ?, ?, 'Europe/Berlin', 'aktiv')", s[0], tenant, unternehmen, s[1], s[2]);
        }
        return new Kunde(tenant, st1, st2);
    }

    private static UUID mappe(Kunde k, String anlass, String gruppen, String offen) {
        return app.queryForObject("INSERT INTO energiemanagement_mappe (tenant_id, anlass, von, bis, gruppen, offen, "
                + "stichtag, eintraege, gilt, pdf, pdf_sha256, csv, csv_sha256, abrufbar_bis, actor_sub, actor_name, "
                + "actor_rolle, actor_art) VALUES (?, ?, '2028-04-30', '2029-04-30', ?::text[], ?::text[], now(), 3, 2, "
                + "'\\x25504446'::bytea, ?, '\\xefbbbf'::bytea, ?, now() + interval '30 days', 'IK', 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde') RETURNING id", UUID.class, k.tenant(), anlass, gruppen, offen, SHA, SHA);
    }

    /** Stellt die Frist der Mappe in die Vergangenheit - nur ohne Trigger (eine Mappe ändert sich sonst nie). */
    private static void abgelaufen(UUID mappe) {
        root.execute("BEGIN; SET LOCAL session_replication_role = replica; UPDATE energiemanagement_mappe SET "
                + "abrufbar_bis = now() - interval '1 day' WHERE id = '" + mappe + "'; COMMIT;");
    }

    private static <T> T eng(UUID tenant, List<UUID> standorte, Function<JdbcTemplate, T> arbeit) {
        try (Connection c = ds(POSTGRES.getJdbcUrl(), APP, PW).getConnection()) {
            try (var ps = c.prepareStatement("SELECT set_config('app.tenant_id', ?, false), "
                    + "set_config('app.zugriff', ?, false), set_config('app.standort_ids', ?, false)")) {
                ps.setString(1, tenant.toString());
                ps.setString(2, standorte == null ? "unternehmen" : "standorte");
                ps.setString(3, standorte == null ? null : "{" + String.join(",", standorte.stream().map(UUID::toString)
                        .toList()) + "}");
                ps.execute();
            }
            return arbeit.apply(new JdbcTemplate(new SingleConnectionDataSource(c, true)));
        } catch (SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    private static void checkState(String state, String einschraenkung, Runnable aktion) {
        Throwable fehler = catchThrowable(aktion::run);
        assertThat(fehler).as("erwartet SQLSTATE " + state).isInstanceOf(DataAccessException.class);
        Throwable ursache = ((DataAccessException) fehler).getMostSpecificCause();
        assertThat(ursache).isInstanceOf(SQLException.class);
        assertThat(((SQLException) ursache).getSQLState()).as(ursache.getMessage()).isEqualTo(state);
        if (einschraenkung != null) {
            assertThat(ursache.getMessage()).contains(einschraenkung);
        }
    }

    private static void checkFehler(String constraint, Runnable aktion) {
        Throwable fehler = catchThrowable(aktion::run);
        assertThat(fehler).as("erwartet CHECK " + constraint).isInstanceOf(DataAccessException.class);
        Throwable ursache = ((DataAccessException) fehler).getMostSpecificCause();
        assertThat(((SQLException) ursache).getSQLState()).as(ursache.getMessage()).isEqualTo("23514");
        assertThat(ursache.getMessage() + " " + ((org.postgresql.util.PSQLException) ursache).getServerErrorMessage()
                .getConstraint()).contains(constraint);
    }

    private static String letzteFassungVorDieser() {
        MigrationVersion diese = MigrationVersion.fromVersion(DIESE);
        return Arrays.stream(flyway(POSTGRES.getJdbcUrl()).load().info().all())
                .map(MigrationInfo::getVersion)
                .filter(v -> v != null && v.compareTo(diese) < 0)
                .max(Comparator.naturalOrder())
                .orElseThrow()
                .getVersion();
    }

    private static FluentConfiguration flyway(String url) {
        return Flyway.configure()
                .dataSource(url, POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP, "appDbPassword", PW, "adminDbUser", ADMIN, "adminDbPassword", PW));
    }

    private static DataSource ds(String url, String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(url);
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
