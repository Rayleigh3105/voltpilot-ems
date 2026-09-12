package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.MessstelleRegeln.Groesse;
import com.voltpilot.api.uems.MessstelleRepository.Messstelle;
import com.voltpilot.api.uems.MessstelleRepository.NeueMessstelle;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
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
 * Die Migration der FORMEL-Terme (UEMS AP-10, {@code messstelle_formel_term},
 * {@code V20260912093000}) gegen eine echte TimescaleDB: der Mandantenzaun steht (ENABLE + FORCE +
 * Policy), eine fremde Formel ist unsichtbar (der zweite Mandant sieht die Terme des ersten NICHT),
 * ein Term hängt nur an einer berechneten Messstelle, und die CHECKs binden Messkanal ODER
 * Messstelle — nie sich selbst.
 */
@Testcontainers(disabledWithoutDocker = true)
class MessstelleFormelTermMigrationTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final Groesse WIRKLEISTUNG = new Groesse("Wirkleistung", "Erzeugung", "kW", "Momentanwert");
    private static final Groesse GEMESSEN = new Groesse("Wirkenergie", "Bezug", "kWh", "Zählerstand");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static MessstelleRepository messstellen;
    private static MessstelleFormelTermRepository terme;

    @BeforeAll
    static void migriere() {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true).baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW))
                .load().migrate();
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        DataSource appDs = new TenantAwareDataSource(ds(APP_USER, APP_PW));
        app = new JdbcTemplate(appDs);
        messstellen = new MessstelleRepository(app);
        terme = new MessstelleFormelTermRepository(app);
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    @Test
    void derZaunStehtUndDieFremdenTermeSindUnsichtbar() {
        UUID a = mandant("Formel A");
        UUID b = mandant("Formel B");
        UUID formelA = berechnet(a, "MS-0001");
        UUID quellA = gemessen(a, "MS-0002");
        UUID formelB = berechnet(b, "MS-0001");
        UUID quellB = gemessen(b, "MS-0002");
        alsTue(a, () -> terme.anlegen(formelA, 0, "messstelle", null, null, quellA, "+", 1.0));
        alsTue(b, () -> terme.anlegen(formelB, 0, "messstelle", null, null, quellB, "+", 1.0));

        // ENABLE + FORCE + eine Policy, die USING UND WITH CHECK an app.tenant_id bindet.
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                + "WHERE relname = 'messstelle_formel_term'", Boolean.class)).isTrue();
        assertThat(root.queryForObject("SELECT count(*) FROM pg_policies WHERE tablename = "
                + "'messstelle_formel_term' AND qual LIKE '%app.tenant_id%' "
                + "AND with_check LIKE '%app.tenant_id%'", Long.class)).isOne();

        // Es gibt Zeilen auf beiden Seiten — sonst bewiese „0 Zeilen" nichts.
        assertThat(root.queryForObject("SELECT count(DISTINCT tenant_id) FROM messstelle_formel_term",
                Long.class)).isGreaterThanOrEqualTo(2);
        // Ohne app.tenant_id: default-deny.
        assertThat(app.queryForObject("SELECT count(*) FROM messstelle_formel_term", Long.class)).isZero();
        // Der zweite Mandant sieht die Terme des ersten NICHT.
        assertThat(als(b, () -> terme.derMessstelle(formelA))).isEmpty();
        assertThat(als(b, () -> terme.derMessstelle(formelB))).hasSize(1);
        assertThat(als(a, () -> terme.derMessstelle(formelA))).hasSize(1);
        // Und B sieht auch über einen rohen COUNT nur die eigenen.
        assertThat(als(b, () -> app.queryForObject(
                "SELECT count(*) FROM messstelle_formel_term WHERE tenant_id <> ?", Long.class, b)))
                .isZero();

        // Die App-Rolle liest und legt an. Seit den Fassungen (V20260912210000, AP-10 IP-3) sind die
        // Terme Historie ihrer Fassung: eine Änderung ist eine neue Fassung, nie UPDATE/DELETE.
        assertThat(rechte(APP_USER, "messstelle_formel_term")).isEqualTo("SI");
    }

    @Test
    void einTermHaengtNurAnEinerBerechnetenMessstelle() {
        UUID t = mandant("Nur berechnet");
        UUID berechnet = berechnet(t, "MS-0001");
        UUID gemessen = gemessen(t, "MS-0002");
        // An der gemessenen: der Trigger lehnt ab.
        abgelehnt("messstelle_formel_term_nur_berechnet", () ->
                alsTue(t, () -> terme.anlegen(gemessen, 0, "messstelle", null, null, berechnet, "+", 1.0)));
        // An der berechneten: nimmt an.
        alsTue(t, () -> terme.anlegen(berechnet, 0, "messstelle", null, null, gemessen, "+", 1.0));
        assertThat(als(t, () -> terme.derMessstelle(berechnet))).hasSize(1);
    }

    @Test
    void dieBindungIstMesskanalOderMessstelleUndNieSichSelbst() {
        UUID t = mandant("Bindung");
        UUID formel = berechnet(t, "MS-0001");
        // messkanal ohne Kanal → CHECK.
        abgelehnt("messstelle_formel_term_bindung_chk", () -> alsTue(t, () -> app.update(
                "INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, position, eingang_art, "
                        + "vorzeichen) VALUES (?, ?, 0, 'messkanal', '+')", t, formel)));
        // messstelle, die auf sich selbst zeigt → CHECK.
        abgelehnt("messstelle_formel_term_nicht_selbst", () -> alsTue(t, () -> app.update(
                "INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, position, eingang_art, "
                        + "quell_messstelle_id, vorzeichen) VALUES (?, ?, 0, 'messstelle', ?, '+')",
                t, formel, formel)));
    }

    // ---- Gerüst --------------------------------------------------------------

    private static UUID mandant(String name) {
        return root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
    }

    private static UUID berechnet(UUID tenant, String kennzeichen) {
        return als(tenant, () -> messstellen.anlegen(new NeueMessstelle(tenant, kennzeichen,
                "Gesamt-PV", "berechnet", "Strom", WIRKLEISTUNG, null))).id();
    }

    private static UUID gemessen(UUID tenant, String kennzeichen) {
        return als(tenant, () -> messstellen.anlegen(new NeueMessstelle(tenant, kennzeichen,
                "Netzbezug", "gemessen", "Strom", GEMESSEN, null))).id();
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

    private static String rechte(String rolle, String tabelle) {
        StringBuilder s = new StringBuilder();
        for (String[] r : new String[][] {{"S", "SELECT"}, {"I", "INSERT"}, {"U", "UPDATE"}, {"D", "DELETE"}}) {
            if (Boolean.TRUE.equals(root.queryForObject("SELECT has_table_privilege(?, ?, ?)",
                    Boolean.class, rolle, tabelle, r[1]))) {
                s.append(r[0]);
            }
        }
        return s.toString();
    }

    private static void abgelehnt(String constraint, Runnable arbeit) {
        Throwable t = null;
        try {
            arbeit.run();
        } catch (Throwable e) {
            t = e;
        }
        assertThat(t).as("die Datenbank muss ablehnen (" + constraint + ")").isNotNull();
        PSQLException p = null;
        for (Throwable c = t; c != null; c = c.getCause()) {
            if (c instanceof PSQLException pe) {
                p = pe;
            }
        }
        assertThat((Object) p).as("eine PSQLException: " + t.getMessage()).isNotNull();
        assertThat(p.getServerErrorMessage().getConstraint()).as(p.getMessage()).isEqualTo(constraint);
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
