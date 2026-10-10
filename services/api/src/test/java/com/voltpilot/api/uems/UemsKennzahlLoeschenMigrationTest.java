package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.flywaydb.core.api.output.MigrateResult;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.postgresql.util.PSQLException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Migration {@code V20260915020000__uems_kennzahl_loeschen.sql} (UEMS AP-11 IP-5, V5): eine Kennzahl ohne einen
 * einzigen Wert und ohne lesende Kennzahl wird über GENAU EINE Funktion gelöscht — die Anwendung bekommt kein
 * DELETE auf die Tabellen —, und ihr Kennzeichen bleibt als Grabstein im Verlauf belegt.
 *
 * <p>Der Bestand (eine Kennzahl mit Wert und umbenanntem Kennzeichen, eine Zusammenfassung, die sie liest, Protokoll)
 * wird VOR der Migration geschrieben; {@link Bestandsschutz} beweist, dass sie keine Zeile anfasst.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsKennzahlLoeschenMigrationTest {

    private static final String DIESE = "20260915020000";
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
    private static Kunde a;
    private static Kunde b;
    private static UUID bestandMitWert;
    private static UUID bestandLeser;
    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;

    private record Kunde(UUID tenant, UUID unternehmen, UUID gebaeude, UUID messstelle, UUID bezugsgroesse) {}

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway(POSTGRES.getJdbcUrl()).target(letzteFassungVorDieser()).load().migrate();
        a = kunde("Kunststoffwerk Ahrenberg GmbH");
        b = kunde("Kundenbereich B");
        bestandMitWert = quotient(a, "KZ-0001");
        root.update("UPDATE kennzahl SET kennzeichen = 'KZ-1' WHERE id = ?", bestandMitWert);
        wert(a, bestandMitWert);
        UUID zweite = quotient(a, "KZ-0002");
        bestandLeser = zusammenfassung(a, "KZ-0003", bestandMitWert, zweite);
        root.update("INSERT INTO kennzahl_aenderung (tenant_id, kennzahl_id, art, gilt_ab, rueckwirkend, actor_sub, actor_name, "
                + "actor_rolle, actor_art) VALUES (?, ?, 'kennzahl_fassung_eingetragen', now(), false, 'sub-ik', "
                + "'Ines Kaltenbach', 'energiemanager', 'kunde')", a.tenant(), bestandMitWert);
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());

        flyway(POSTGRES.getJdbcUrl()).target(DIESE).load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, List.of());
        flyway(POSTGRES.getJdbcUrl()).load().migrate();

        app = new JdbcTemplate(new TenantAwareDataSource(ds(POSTGRES.getJdbcUrl(), APP_USER, APP_PW)));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ============================================================ Bestandsschutz

    @Test
    void dieMigrationLaesstDenBestandZeichengleich() {
        for (String tabelle : List.of("kennzahl", "kennzahl_kennzeichen_verlauf", "kennzahl_fassung", "kennzahl_eingang",
                "kennzahl_wert", "kennzahl_aenderung")) {
            assertThat(fingerVorher.get(tabelle)).as("es gibt Bestand in " + tabelle).isNotEqualTo(Bestandsschutz.LEER);
        }
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
    }

    @Test
    void derBestandsvergleichBeisst() {
        Bestandsschutz.mutationsprobe(root, List.of(), "kennzahl", "UPDATE kennzahl SET name = name || ' (Probe)'");
    }

    // ============================================================ Die eine Öffnung

    @Test
    void dieAnwendungLoeschtNurUeberDieFunktion() {
        assertThat(rechte(APP_USER, "kennzahl")).isEqualTo("SI");
        assertThat(rechte(APP_USER, "kennzahl_kennzeichen_verlauf")).isEqualTo("S");
        assertThat(rechte(APP_USER, "kennzahl_fassung")).isEqualTo("SI");
        assertThat(rechte(APP_USER, "kennzahl_eingang")).isEqualTo("SI");
        assertThat(rechte(APP_USER, "kennzahl_wert")).isEqualTo("S");
        assertThat(root.queryForObject("SELECT has_function_privilege(?, 'uems_kennzahl_loeschen(uuid)', 'EXECUTE')",
                Boolean.class, APP_USER)).isTrue();
        assertThat(root.queryForObject("SELECT is_nullable FROM information_schema.columns WHERE table_name = "
                + "'kennzahl_kennzeichen_verlauf' AND column_name = 'kennzahl_id'", String.class)).isEqualTo("YES");
    }

    @Test
    void ohneWertGeloeschtBleibtDasKennzeichenAlsGrabsteinBelegt() {
        UUID kz = quotient(a, "KZ-0010");
        assertThat(als(a.tenant(), () -> app.queryForObject("SELECT uems_kennzahl_loeschen(?)", String.class, kz)))
                .isEqualTo("KZ-0010");
        for (String tabelle : List.of("kennzahl_eingang", "kennzahl_fassung")) {
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE kennzahl_id = ?", Long.class, kz))
                    .as(tabelle).isZero();
        }
        assertThat(root.queryForObject("SELECT count(*) FROM kennzahl WHERE id = ?", Long.class, kz)).isZero();
        assertThat(root.queryForList("SELECT kennzeichen || ':' || coalesce(kennzahl_id::text, 'Grabstein') FROM "
                + "kennzahl_kennzeichen_verlauf WHERE tenant_id = ? AND kennzeichen = 'KZ-0010'", String.class, a.tenant()))
                .containsExactly("KZ-0010:Grabstein");
        abgelehnt("kennzahl_kennzeichen_belegt", () -> quotient(a, "KZ-0010"));
    }

    /** V5: ein Wert oder eine lesende Kennzahl hält sie — für die Funktion und für jeden, der an ihr vorbei löscht. */
    @Test
    void einWertOderEinLeserHaeltDieKennzahl() {
        abgelehnt("kennzahl_hat_werte", () -> alsTue(a.tenant(),
                () -> app.queryForObject("SELECT uems_kennzahl_loeschen(?)", String.class, bestandMitWert)));
        UUID gelesen = root.queryForObject("SELECT eingang_kennzahl_id FROM kennzahl_eingang WHERE kennzahl_id = ? "
                + "AND eingang_kennzahl_id <> ? LIMIT 1", UUID.class, bestandLeser, bestandMitWert);
        PSQLException leser = psql(() -> alsTue(a.tenant(),
                () -> app.queryForObject("SELECT uems_kennzahl_loeschen(?)", String.class, gelesen)), "kennzahl_wird_gelesen");
        assertThat(leser.getServerErrorMessage().getConstraint()).isEqualTo("kennzahl_wird_gelesen");
        assertThat(leser.getMessage()).contains("KZ-0003");
        assertThat(psql(() -> root.update("DELETE FROM kennzahl WHERE id = ?", bestandMitWert), "23503").getSQLState())
                .as("auch der Eigentümer löscht nicht an einem Wert vorbei").isEqualTo("23503");
        assertThat(root.queryForObject("SELECT count(*) FROM kennzahl WHERE id IN (?, ?)", Long.class, bestandMitWert,
                gelesen)).isEqualTo(2L);
    }

    @Test
    void derVerlaufBleibtSonstUnveraenderlich() {
        abgelehntMitMeldung("audit rows are append-only",
                () -> root.update("UPDATE kennzahl_kennzeichen_verlauf SET belegt_am = now() WHERE kennzahl_id = ?", bestandMitWert));
        abgelehntMitMeldung("audit rows are append-only",
                () -> root.update("UPDATE kennzahl_kennzeichen_verlauf SET kennzeichen = 'KZ-9999' WHERE kennzahl_id = ?",
                        bestandMitWert));
    }

    @Test
    void einFremderKundenbereichLoeschtNichts() {
        UUID kz = quotient(a, "KZ-0020");
        assertThat(als(b.tenant(), () -> app.queryForObject("SELECT uems_kennzahl_loeschen(?)", String.class, kz))).isNull();
        assertThat(root.queryForObject("SELECT count(*) FROM kennzahl WHERE id = ?", Long.class, kz)).isEqualTo(1L);
        assertThat(psql(() -> app.queryForObject("SELECT uems_kennzahl_loeschen(?)", String.class, kz), "42501").getSQLState())
                .as("ohne Kundenbereich keine Funktion").isEqualTo("42501");
    }

    /** Out-of-order: eine Datenbank, auf der ALLE anderen Migrationen liegen, bekommt diese als späte Ankunft. */
    @Test
    void dieMigrationTraegtAuchAlsSpaeteAnkunft() throws IOException {
        root.execute("CREATE DATABASE voltpilot_spaet_loeschen");
        Path ohneDiese = Files.createTempDirectory("migrationen-ohne-kennzahl-loeschen");
        try (var dateien = Files.list(MIGRATIONEN)) {
            for (Path datei : dateien.toList()) {
                if (!datei.getFileName().toString().startsWith("V" + DIESE + "__")) {
                    Files.copy(datei, ohneDiese.resolve(datei.getFileName()));
                }
            }
        }
        String url = POSTGRES.getJdbcUrl().replaceFirst("/voltpilot(?=\\?|$)", "/voltpilot_spaet_loeschen");
        flyway(url).locations("filesystem:" + ohneDiese.toAbsolutePath()).load().migrate();
        MigrateResult spaet = flyway(url).outOfOrder(true).load().migrate();
        assertThat(spaet.migrations).extracting(m -> m.version).containsExactly(DIESE);

        JdbcTemplate db = new JdbcTemplate(ds(url, POSTGRES.getUsername(), POSTGRES.getPassword()));
        for (String sql : List.of(
                "SELECT conname || ' ' || pg_get_constraintdef(oid) FROM pg_constraint "
                        + "WHERE conrelid = 'kennzahl_kennzeichen_verlauf'::regclass ORDER BY 1",
                "SELECT tgname || ' ' || tgfoid::regproc::text FROM pg_trigger "
                        + "WHERE tgrelid = 'kennzahl_kennzeichen_verlauf'::regclass AND NOT tgisinternal ORDER BY 1",
                "SELECT p.oid::regprocedure::text || ' ' || p.prosecdef FROM pg_proc p WHERE p.proname = 'uems_kennzahl_loeschen'")) {
            assertThat(db.queryForList(sql, String.class)).as(sql).isNotEmpty().isEqualTo(root.queryForList(sql, String.class));
        }
    }

    // ============================================================ Gerüst

    private static Kunde kunde(String name) {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, name);
        UUID g = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) "
                + "VALUES (?, 'gebaeude', 'Halle 2', 'G-2', 'aktiv') RETURNING id", UUID.class, t);
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-12', 'Montage Linie M1', 'gemessen', 'Strom', "
                + "'Wirkenergie', 'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, t);
        UUID bz = root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, "
                + "periode_art, geltung_art, ort_id) VALUES (?, 'BZ-6', 'Gutteile Montage Halle 2', 'periodenwert', "
                + "'Stück', 'monat', 'gebaeude', ?) RETURNING id", UUID.class, t, g);
        return new Kunde(t, u, g, ms, bz);
    }

    /** Kennzahl (Gebäude) + Fassung 1 + Menge und Bezugsgröße — geschrieben wie der Schreibweg (IP-5). */
    private static UUID quotient(Kunde k, String kennzeichen) {
        UUID id = kennzahlZeile(k, kennzeichen, "quotient", "gebaeude", "ort_id", k.gebaeude());
        UUID f = fassung(k, id, "quotient", "kWh/Stück");
        eingang(k, id, f, "quotient", 0, "zaehler", "messstelle", "messstelle_id", k.messstelle());
        eingang(k, id, f, "quotient", 1, "nenner", "bezugsgroesse", "bezugsgroesse_id", k.bezugsgroesse());
        return id;
    }

    private static UUID zusammenfassung(Kunde k, String kennzeichen, UUID erste, UUID zweite) {
        UUID id = kennzahlZeile(k, kennzeichen, "zusammenfassung", "unternehmen", "unternehmen_id", k.unternehmen());
        UUID f = fassung(k, id, "zusammenfassung", "kWh/Stück");
        eingang(k, id, f, "zusammenfassung", 0, "paar", "kennzahl", "eingang_kennzahl_id", erste);
        eingang(k, id, f, "zusammenfassung", 1, "paar", "kennzahl", "eingang_kennzahl_id", zweite);
        return id;
    }

    private static UUID kennzahlZeile(Kunde k, String kennzeichen, String rechenform, String geltungArt, String spalte,
            UUID objekt) {
        return root.queryForObject("INSERT INTO kennzahl (tenant_id, kennzeichen, name, rechenform, geltung_art, " + spalte
                + ", verantwortlich_sub, verantwortlich_name) VALUES (?, ?, ?, ?, ?, ?, 'sub-ik', 'Ines Kaltenbach') "
                + "RETURNING id", UUID.class, k.tenant(), kennzeichen, "Kennzahl " + kennzeichen, rechenform, geltungArt, objekt);
    }

    private static UUID fassung(Kunde k, UUID kennzahl, String rechenform, String einheit) {
        return root.queryForObject("INSERT INTO kennzahl_fassung (tenant_id, kennzahl_id, nummer, rechenform, herkunft, "
                + "actor_sub, actor_name, actor_rolle, actor_art, einheit) VALUES (?, ?, 1, ?, 'anlage', 'sub-ik', "
                + "'Ines Kaltenbach', 'energiemanager', 'kunde', ?) RETURNING id", UUID.class, k.tenant(), kennzahl,
                rechenform, einheit);
    }

    private static void eingang(Kunde k, UUID kennzahl, UUID fassung, String rechenform, int position, String rolle,
            String art, String spalte, UUID objekt) {
        root.update("INSERT INTO kennzahl_eingang (tenant_id, kennzahl_id, fassung_id, rechenform, position, rolle, art, "
                + spalte + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)", k.tenant(), kennzahl, fassung, rechenform, position, rolle,
                art, objekt);
    }

    /** Ein Wert ohne Zahl (noch keine Version) — so hängt der Rechenlauf ihn an. */
    private static void wert(Kunde k, UUID kennzahl) {
        UUID fassung = root.queryForObject("SELECT id FROM kennzahl_fassung WHERE kennzahl_id = ? AND nummer = 1", UUID.class,
                kennzahl);
        root.update("INSERT INTO kennzahl_wert (tenant_id, kennzahl_id, periode_art, periode_von, periode_bis, zeitzone, "
                + "version, wert, zaehler, nenner, menge_zustand, kennzeichen, abdeckung_prozent, grund, "
                + "definition_fassung_id, berechnet_am) VALUES (?, ?, 'monat', '2026-10-01', '2026-10-31', 'Europe/Berlin', "
                + "NULL, NULL, 6100, NULL, 'keine Werte', '[]'::jsonb, 100, 'nenner_fehlt', ?, now())", k.tenant(), kennzahl,
                fassung);
    }

    private static String rechte(String rolle, String tabelle) {
        StringBuilder s = new StringBuilder();
        for (String[] r : new String[][] {{"S", "SELECT"}, {"I", "INSERT"}, {"U", "UPDATE"}, {"D", "DELETE"},
                {"T", "TRUNCATE"}}) {
            if (Boolean.TRUE.equals(root.queryForObject("SELECT has_table_privilege(?, ?, ?)", Boolean.class, rolle,
                    tabelle, r[1]))) {
                s.append(r[0]);
            }
        }
        return s.toString();
    }

    private static <T> T als(UUID tenant, Supplier<T> arbeit) {
        TenantContext.set(tenant);
        try {
            return arbeit.get();
        } finally {
            TenantContext.clear();
        }
    }

    private static void alsTue(UUID tenant, Runnable arbeit) {
        als(tenant, () -> {
            arbeit.run();
            return null;
        });
    }

    private static PSQLException psql(Runnable arbeit, String erwartet) {
        Throwable t = null;
        try {
            arbeit.run();
        } catch (Throwable e) {
            t = e;
        }
        assertThat(t).as("die Datenbank muss ablehnen (" + erwartet + ")").isNotNull();
        PSQLException p = null;
        for (Throwable c = t; c != null; c = c.getCause()) {
            if (c instanceof PSQLException pe) {
                p = pe;
            }
        }
        assertThat((Object) p).as("eine PSQLException: " + t).isNotNull();
        return p;
    }

    private static void abgelehnt(String constraint, Runnable arbeit) {
        PSQLException p = psql(arbeit, constraint);
        assertThat(p.getServerErrorMessage().getConstraint()).as(p.getMessage()).isEqualTo(constraint);
    }

    private static void abgelehntMitMeldung(String meldung, Runnable arbeit) {
        PSQLException p = psql(arbeit, meldung);
        assertThat(p.getMessage()).contains(meldung);
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
