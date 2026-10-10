package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
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
 * Die Migration {@code V20260913235700} (UEMS AP-10 IP-9): der Formel-Typ {@code rest} mit seinem EINEN
 * Parameter, dem Hauptzähler.
 *
 * <ul>
 *   <li>Bestandsschutz über den gemeinsamen Vergleich ({@link Bestandsschutz}) — die neue Spalte ist in jeder
 *       Bestandszeile NULL;</li>
 *   <li>ein Rest trägt genau einen Hauptzähler, eine gewichtete Summe keinen, unbekannte Typen bleiben draußen;</li>
 *   <li>NIE ZWEI Reste je Hauptzähler (auch nicht am Schreibweg vorbei), eine aufgehobene Fassung gibt ihn frei;</li>
 *   <li>ein Rest speichert KEINE Terme (E3) — auch nicht über den Rückweg „Term ohne Fassung“;</li>
 *   <li>Zaun, Rechte (der Hauptzähler eines Rests ändert sich nie) und Offboarding.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsBilanzRestMigrationTest {

    private static final String DIESE = "20260913235700";
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

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;
    private static Kunde a;

    private record Kunde(UUID tenant, UUID hauptzaehler, UUID gesamtwert) {}

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        // Der Bestand der Tabelle, die diese Migration anfasst: eine gewichtete Summe mit einem Baustein-Term
        // (ihre Fassung 1 legt der Term-Trigger an, wie beim Bestand von PR 688).
        a = kunde("Kunststoffwerk Ahrenberg GmbH");
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());

        flyway().target(DIESE).load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, List.of());
        flyway().load().migrate();
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ================================================================== Bestandsschutz

    @Test
    void dieMigrationLaesstDenBestandZeichengleich() {
        for (String tabelle : List.of("messstelle", "messstelle_formel_fassung", "messstelle_formel_term")) {
            assertThat(fingerVorher.get(tabelle)).as("es gibt Bestand in " + tabelle).isNotEqualTo(Bestandsschutz.LEER);
        }
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
        assertThat(root.queryForObject("SELECT count(*) FROM messstelle_formel_fassung WHERE tenant_id = ? "
                + "AND (rest_hauptzaehler_id IS NOT NULL OR formel_typ <> 'gewichtete_summe')", Long.class, a.tenant()))
                .as("kein Bestand wird zum Rest").isZero();
    }

    @Test
    void derBestandsvergleichBeisst() {
        Bestandsschutz.mutationsprobe(root, List.of(), "messstelle", "UPDATE messstelle SET name = name || '!'");
    }

    // ============================================================ ein Rest, ein Hauptzähler

    @Test
    void einRestTraegtGenauEinenHauptzaehlerUndNieZweiJeHauptzaehler() {
        Kunde k = kunde("Kundenbereich Rest");
        UUID rest = berechnete(k, "MS-15");
        alsTue(k.tenant(), () -> restFassung(app, k.tenant(), rest, k.hauptzaehler()));

        UUID zweiter = berechnete(k, "MS-16");
        assertThat(psql(() -> alsTue(k.tenant(), () -> restFassung(app, k.tenant(), zweiter, k.hauptzaehler())))
                .getServerErrorMessage().getConstraint()).isEqualTo("messstelle_formel_fassung_ein_rest_je_hauptzaehler");
        assertThat(psql(() -> alsTue(k.tenant(), () -> app.update("INSERT INTO messstelle_formel_fassung (tenant_id, "
                + "messstelle_id, nummer, formel_typ, herkunft, actor_sub, actor_name, actor_art) VALUES (?, ?, 1, 'rest', 'anlage', "
                + "'sub-test', 'Test', 'kunde')", k.tenant(), zweiter))).getServerErrorMessage().getConstraint())
                .as("ein Rest ohne Hauptzähler ist keiner").isEqualTo("messstelle_formel_fassung_rest_hauptzaehler_chk");
        assertThat(psql(() -> alsTue(k.tenant(), () -> app.update("INSERT INTO messstelle_formel_fassung (tenant_id, "
                + "messstelle_id, nummer, formel_typ, herkunft, actor_sub, actor_name, actor_art, rest_hauptzaehler_id) VALUES "
                + "(?, ?, 1, 'gewichtete_summe', 'anlage', 'sub-test', 'Test', 'kunde', ?)", k.tenant(), zweiter, k.hauptzaehler())))
                .getServerErrorMessage().getConstraint()).isEqualTo("messstelle_formel_fassung_rest_hauptzaehler_chk");
        assertThat(psql(() -> alsTue(k.tenant(), () -> app.update("INSERT INTO messstelle_formel_fassung (tenant_id, "
                + "messstelle_id, nummer, formel_typ, herkunft, actor_sub, actor_name, actor_art) VALUES (?, ?, 1, 'unbekannt', 'anlage', "
                + "'sub-test', 'Test', 'kunde')", k.tenant(), zweiter))).getServerErrorMessage().getConstraint())
                .as("unbekannte Formel-Typen bleiben gesperrt").isEqualTo("messstelle_formel_fassung_typ_chk");
        assertThat(psql(() -> alsTue(k.tenant(), () -> restFassung(app, k.tenant(), zweiter, zweiter)))
                .getServerErrorMessage().getConstraint()).isEqualTo("messstelle_formel_fassung_rest_nicht_selbst");
        // Der Hauptzähler eines anderen Kundenbereichs ist nicht da — der Mandant reist im Verweis mit.
        assertThat(psql(() -> alsTue(k.tenant(), () -> restFassung(app, k.tenant(), zweiter, a.hauptzaehler())))
                .getServerErrorMessage().getConstraint()).isEqualTo("messstelle_formel_fassung_rest_hauptzaehler_fk");

        // Aufgehoben gibt den Hauptzähler frei — und nur dann.
        alsTue(k.tenant(), () -> app.update("UPDATE messstelle_formel_fassung SET aufgehoben_am = now() "
                + "WHERE messstelle_id = ?", rest));
        alsTue(k.tenant(), () -> restFassung(app, k.tenant(), zweiter, k.hauptzaehler()));
    }

    @Test
    void einRestSpeichertKeineTerme() {
        Kunde k = kunde("Kundenbereich Terme");
        UUID rest = berechnete(k, "MS-15");
        UUID fassung = als(k.tenant(), () -> restFassung(app, k.tenant(), rest, k.hauptzaehler()));
        assertThat(psql(() -> alsTue(k.tenant(), () -> app.update("INSERT INTO messstelle_formel_term (tenant_id, "
                + "messstelle_id, fassung_id, position, eingang_art, quell_messstelle_id, vorzeichen, faktor) VALUES "
                + "(?, ?, ?, 0, 'messstelle', ?, '+', 1)", k.tenant(), rest, fassung, k.hauptzaehler())))
                .getServerErrorMessage().getConstraint()).isEqualTo("messstelle_formel_term_nicht_rest");
        // Der Rückweg „ein Term ohne Fassung landet in der einzigen“ führt auch nicht hinein.
        assertThat(psql(() -> alsTue(k.tenant(), () -> app.update("INSERT INTO messstelle_formel_term (tenant_id, "
                + "messstelle_id, position, eingang_art, quell_messstelle_id, vorzeichen, faktor) VALUES "
                + "(?, ?, 0, 'messstelle', ?, '+', 1)", k.tenant(), rest, k.hauptzaehler())))
                .getServerErrorMessage().getConstraint()).isEqualTo("messstelle_formel_term_nicht_rest");
        assertThat(root.queryForObject("SELECT count(*) FROM messstelle_formel_term WHERE messstelle_id = ?", Long.class,
                rest)).isZero();
    }

    // ================================================================ Zaun, Rechte, Offboarding

    @Test
    void derZaunStehtUndDerHauptzaehlerEinesRestsAendertSichNie() {
        Kunde k = kunde("Kundenbereich Zaun");
        Kunde fremd = kunde("Kundenbereich fremd");
        UUID rest = berechnete(k, "MS-15");
        alsTue(k.tenant(), () -> restFassung(app, k.tenant(), rest, k.hauptzaehler()));
        assertThat(als(fremd.tenant(), () -> app.queryForObject("SELECT count(*) FROM messstelle_formel_fassung "
                + "WHERE rest_hauptzaehler_id IS NOT NULL", Long.class))).isZero();
        assertThat(psql(() -> alsTue(k.tenant(), () -> app.update("UPDATE messstelle_formel_fassung "
                + "SET rest_hauptzaehler_id = NULL WHERE messstelle_id = ?", rest))).getSQLState())
                .as("keine Spaltenrechte").isEqualTo("42501");
        assertThat(root.queryForObject("SELECT relforcerowsecurity FROM pg_class WHERE relname = 'messstelle_formel_fassung'",
                Boolean.class)).isTrue();

        new TenantRepository(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW))).offboard(k.tenant());
        for (String tabelle : List.of("messstelle_formel_fassung", "messstelle", "tenant")) {
            String spalte = tabelle.equals("tenant") ? "id" : "tenant_id";
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE " + spalte + " = ?", Long.class,
                    k.tenant())).as(tabelle).isZero();
        }
    }

    // ================================================================ Gerüst

    /** Ein Kundenbereich mit Hauptzähler (gemessen) und einer gewichteten Summe über ihn (Bestand von PR 688). */
    private static Kunde kunde(String name) {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
        UUID hz = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-10', 'Netzbezug Halle 2', 'gemessen', 'Strom', 'Wirkenergie', "
                + "'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, t);
        Kunde k = new Kunde(t, hz, null);
        UUID summe = berechnete(k, "MS-19");
        root.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, position, eingang_art, "
                + "quell_messstelle_id, vorzeichen, faktor) VALUES (?, ?, 0, 'messstelle', ?, '+', 1)", t, summe, hz);
        return new Kunde(t, hz, summe);
    }

    private static UUID berechnete(Kunde k, String kennzeichen) {
        return root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, "
                + "einheit, wertart) VALUES (?, ?, ?, 'berechnet', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', 'Intervallmenge') "
                + "RETURNING id", UUID.class, k.tenant(), kennzeichen, kennzeichen + " berechnet");
    }

    private static UUID restFassung(JdbcTemplate db, UUID tenant, UUID messstelle, UUID hauptzaehler) {
        return db.queryForObject("INSERT INTO messstelle_formel_fassung (tenant_id, messstelle_id, nummer, formel_typ, "
                + "herkunft, actor_sub, actor_name, actor_art, rest_hauptzaehler_id) VALUES (?, ?, 1, 'rest', 'anlage', 'sub-test', "
                + "'Test', 'kunde', ?) RETURNING id", UUID.class, tenant, messstelle, hauptzaehler);
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

    private static PSQLException psql(Runnable arbeit) {
        Throwable t = null;
        try {
            arbeit.run();
        } catch (RuntimeException e) {
            t = e;
        }
        PSQLException p = null;
        for (Throwable c = t; c != null; c = c.getCause()) {
            if (c instanceof PSQLException pe) {
                p = pe;
            }
        }
        assertThat((Object) p).as("eine PSQLException: " + (t == null ? "keine Ausnahme" : t.getMessage())).isNotNull();
        return p;
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
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW,
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
