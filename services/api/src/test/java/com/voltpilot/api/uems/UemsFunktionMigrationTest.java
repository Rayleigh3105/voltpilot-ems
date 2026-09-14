package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Instant;
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
 * Die Migration {@code V20260914190000} (UEMS AP-01 IP-2): die Funktion je Standort und die Teilnahme
 * je Anlage.
 *
 * <ul>
 *   <li>Bestandsschutz über den gemeinsamen Vergleich ({@link Bestandsschutz}) — zwei neue, LEERE
 *       Tabellen; {@code site_profile_state} als BYTE-Vergleich (seine Zeilen als Text, vorher = nachher);</li>
 *   <li>die Form hält die Datenbank selbst: Vokabular, Messen ohne „angehalten“, Zeitpunkt je Zustand,
 *       eine laufende Funktion je Standort, eine laufende Teilnahme je Anlage, Teilnahme nur an „Steuern“;</li>
 *   <li>die Anlage darf gehen, ihre Teilnahme bleibt (W5);</li>
 *   <li>Zaun, Rechte (kein DELETE, nur Zustand und Zeitpunkte änderbar), erneutes Ausführen und
 *       Offboarding.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsFunktionMigrationTest {

    private static final String DIESE = "20260914190000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final List<String> NEU = List.of("funktion", "funktion_teilnahme");
    private static final Instant LSK_SEIT = Instant.parse("2024-05-01T22:00:00Z");

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
    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;
    private static String profilstandVorher;
    private static String profilstandNachMigration;

    private record Kunde(UUID tenant, UUID standort, UUID an1, UUID an2) {}

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();
        a = kunde("Kunststoffwerk Ahrenberg GmbH");
        b = kunde("Kundenbereich B");
        // Der Bestand, aus dem der Umstieg liest: AN-1 mit Lastspitzenkappung „an" seit 02.05.2024.
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "DATE '2024-03-12')", a.tenant(), a.an1(), a.standort());
        root.update("INSERT INTO site_profile_state (site_id, profile, state, tenant_id, updated_at) "
                + "VALUES (?, 'lastspitzenkappung', 'an', ?, ?)", a.an1(), a.tenant(), Timestamp.from(LSK_SEIT));
        root.update("INSERT INTO site_profile_state (site_id, profile, state, tenant_id, updated_at) "
                + "VALUES (?, 'marktvermarktung', 'aus', ?, now())", b.an1(), b.tenant());
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());
        profilstandVorher = profilstand();

        flyway().target(DIESE).load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, List.of());
        profilstandNachMigration = profilstand();
        flyway().load().migrate();
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ================================================================== Bestandsschutz

    @Test
    void dieMigrationLaesstDenBestandZeichengleich() {
        for (String tabelle : List.of("standort", "site", "anlage_standort", "unternehmen", "site_profile_state")) {
            assertThat(fingerVorher.get(tabelle)).as("es gibt Bestand in " + tabelle).isNotEqualTo(Bestandsschutz.LEER);
        }
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
        for (String tabelle : NEU) {
            assertThat(fingerVorher).as("neu: " + tabelle).doesNotContainKey(tabelle);
            assertThat(fingerNachMigration.get(tabelle)).as(tabelle + " kommt leer").isEqualTo(Bestandsschutz.LEER);
        }
    }

    /** §6.2: „keine Änderung an site_profile_state" — als Byte-Vergleich jeder Zeile, nicht als Behauptung. */
    @Test
    void siteProfileStateIstByteGleich() {
        assertThat(profilstandVorher).contains("lastspitzenkappung|an|").contains("marktvermarktung|aus|");
        assertThat(profilstandNachMigration).isEqualTo(profilstandVorher);
        assertThat(profilstand()).isEqualTo(profilstandVorher);
    }

    @Test
    void derBestandsvergleichBeisst() {
        Bestandsschutz.mutationsprobe(root, List.of(), "site_profile_state",
                "UPDATE site_profile_state SET state = 'aus' WHERE profile = 'lastspitzenkappung'");
    }

    // ============================================================ Die Form

    @Test
    void dieFormHaeltDieDatenbankSelbst() {
        Kunde k = kunde("Form");
        abgelehnt("funktion_funktion_chk", () -> funktion(root, k, "auswerten", "aktiv"));
        abgelehnt("funktion_zustand_chk", () -> funktion(root, k, "steuern", "kein_objekt"));
        // Messen kennt nur entwurf · aktiv · archiviert (Vertrag `zustaende_messen`).
        abgelehnt("funktion_messen_zustand_chk", () -> root.update("INSERT INTO funktion (tenant_id, standort_id, "
                + "funktion, zustand, angehalten_seit, geaendert_von) VALUES (?, ?, 'messen', 'angehalten', now(), "
                + "'VoltPilot')", k.tenant(), k.standort()));
        abgelehnt("funktion_messen_zustand_chk", () -> funktion(root, k, "messen", "eingerichtet"));
        // Der Zeitpunkt gehört zum Zustand.
        abgelehnt("funktion_archiviert_chk", () -> funktion(root, k, "steuern", "archiviert"));
        abgelehnt("funktion_angehalten_chk", () -> funktion(root, k, "steuern", "angehalten"));
        abgelehnt("funktion_geaendert_von_chk", () -> root.update("INSERT INTO funktion (tenant_id, standort_id, "
                + "funktion, zustand, geaendert_von) VALUES (?, ?, 'steuern', 'aktiv', ' ')", k.tenant(), k.standort()));

        // E6 = C: je Standort EINE laufende Funktion jeder Art — eine archivierte daneben ist die Geschichte.
        UUID steuern = funktion(root, k, "steuern", "aktiv");
        UUID messen = funktion(root, k, "messen", "aktiv");
        abgelehnt("uq_funktion_je_standort", () -> funktion(root, k, "steuern", "eingerichtet"));
        root.update("UPDATE funktion SET zustand = 'archiviert', archiviert_am = now() WHERE id = ?", steuern);
        UUID neu = funktion(root, k, "steuern", "entwurf");

        // Die Teilnahme: nur an „Steuern", Zeitpunkt je Zustand, nie gestartet heißt nie gestartet.
        abgelehnt("funktion_teilnahme_funktion_fk", () -> teilnahme(root, k, messen, k.an1(), "aktiv"));
        abgelehnt("funktion_teilnahme_nur_steuern_chk", () -> root.update("INSERT INTO funktion_teilnahme "
                + "(tenant_id, funktion_id, funktion, site_id, zustand) VALUES (?, ?, 'messen', ?, 'aktiv')",
                k.tenant(), messen, k.an1()));
        abgelehnt("funktion_teilnahme_zustand_chk", () -> teilnahme(root, k, neu, k.an1(), "kein_objekt"));
        abgelehnt("funktion_teilnahme_beendet_chk", () -> teilnahme(root, k, neu, k.an1(), "archiviert"));
        abgelehnt("funktion_teilnahme_angehalten_chk", () -> teilnahme(root, k, neu, k.an1(), "angehalten"));
        abgelehnt("funktion_teilnahme_nie_gestartet_chk", () -> root.update("INSERT INTO funktion_teilnahme "
                + "(tenant_id, funktion_id, site_id, zustand, gestartet_am) VALUES (?, ?, ?, 'eingerichtet', now())",
                k.tenant(), neu, k.an1()));

        // Eine laufende Teilnahme je Anlage; nach dem Beenden ist eine neue Aufnahme eine neue Zeile.
        UUID t = teilnahme(root, k, neu, k.an1(), "aktiv");
        assertThat(root.queryForObject("SELECT funktion FROM funktion_teilnahme WHERE id = ?", String.class, t))
                .isEqualTo("steuern");
        abgelehnt("uq_funktion_teilnahme_je_anlage", () -> teilnahme(root, k, neu, k.an1(), "entwurf"));
        root.update("UPDATE funktion_teilnahme SET zustand = 'archiviert', beendet_am = now() WHERE id = ?", t);
        teilnahme(root, k, neu, k.an1(), "entwurf");
        teilnahme(root, k, neu, k.an2(), "aktiv");
    }

    /** W5: kein Fremdschlüssel auf site — die Einfüge-Hälfte hält der Trigger, das Löschen der Anlage geht. */
    @Test
    void dieAnlageDarfGehenIhreTeilnahmeBleibt() {
        Kunde k = kunde("W5");
        UUID f = funktion(root, k, "steuern", "aktiv");
        abgelehnt("funktion_teilnahme_site_fk", () -> teilnahme(root, k, f, UUID.randomUUID(), "aktiv"));
        // Eine Anlage eines ANDEREN Mandanten gilt als nicht vorhanden.
        abgelehnt("funktion_teilnahme_site_fk", () -> teilnahme(root, k, f, b.an1(), "aktiv"));
        UUID t = teilnahme(root, k, f, k.an2(), "aktiv");
        assertThat(root.update("DELETE FROM site WHERE id = ?", k.an2())).isOne();
        assertThat(root.queryForObject("SELECT count(*) FROM funktion_teilnahme WHERE id = ?", Long.class, t)).isOne();
    }

    // ============================================================ Zaun, Rechte, Wiederholung, Offboarding

    @Test
    void derZaunStehtUndBeendetWirdStattGeloescht() {
        Kunde k = kunde("Zaun");
        UUID f = als(k.tenant(), () -> funktion(app, k, "steuern", "aktiv"));
        UUID t = als(k.tenant(), () -> teilnahme(app, k, f, k.an1(), "aktiv"));
        for (String tabelle : NEU) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = ?",
                    Boolean.class, tabelle)).as(tabelle + ": ENABLE + FORCE").isTrue();
            assertThat(root.queryForObject("SELECT count(*) FROM pg_policies WHERE tablename = ? AND qual IS NOT NULL "
                    + "AND with_check IS NOT NULL", Long.class, tabelle)).as(tabelle + ": USING und WITH CHECK").isOne();
            assertThat(app.queryForObject("SELECT count(*) FROM " + tabelle, Long.class)).as(tabelle + " ohne Mandant")
                    .isZero();
            assertThat(als(b.tenant(), () -> app.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?",
                    Long.class, k.tenant()))).as(tabelle + ": B sieht A nicht").isZero();
            assertThat(root.queryForObject("SELECT has_table_privilege(?, ?, 'DELETE') OR has_table_privilege(?, ?, "
                    + "'TRUNCATE')", Boolean.class, APP_USER, tabelle, APP_USER, tabelle)).as(tabelle + " kein DELETE")
                    .isFalse();
            assertThat(root.queryForObject("SELECT has_table_privilege(?, ?, 'DELETE') AND NOT has_table_privilege(?, ?, "
                    + "'INSERT')", Boolean.class, ADMIN_USER, tabelle, ADMIN_USER, tabelle)).as(tabelle + " Offboarding")
                    .isTrue();
        }
        assertThat(spaltenMitUpdate("funktion")).containsExactly("aktiv_seit", "angehalten_seit", "archiviert_am",
                "eingerichtet_am", "geaendert_von", "updated_at", "zustand");
        assertThat(spaltenMitUpdate("funktion_teilnahme")).containsExactly("angehalten_seit", "beendet_am",
                "eingerichtet_am", "gestartet_am", "updated_at", "zustand");

        assertThat(zurueckgewiesen(() -> als(k.tenant(), () -> app.update("DELETE FROM funktion_teilnahme WHERE id = ?", t))))
                .isEqualTo("42501");
        assertThat(zurueckgewiesen(() -> als(k.tenant(), () -> app.update("DELETE FROM funktion WHERE id = ?", f))))
                .isEqualTo("42501");
        // Nie umgehängt: Standort, Anlage, Funktion und Herkunft sind nicht änderbar.
        assertThat(zurueckgewiesen(() -> als(k.tenant(), () -> app.update("UPDATE funktion_teilnahme SET site_id = ? "
                + "WHERE id = ?", k.an2(), t)))).isEqualTo("42501");
        assertThat(zurueckgewiesen(() -> als(k.tenant(), () -> app.update("UPDATE funktion_teilnahme SET uebernommen = true "
                + "WHERE id = ?", t)))).isEqualTo("42501");
        // B schreibt nicht in den Kundenbereich von A und hängt keine Teilnahme an A's Funktion.
        assertThat(zurueckgewiesen(() -> als(b.tenant(), () -> funktion(app, k, "messen", "aktiv")))).isEqualTo("42501");
        assertThat(zurueckgewiesen(() -> als(b.tenant(), () -> teilnahme(app, b, f, b.an1(), "aktiv"))))
                .isEqualTo("23503");
        // Unter dem Zaun: anhalten und beenden gehen.
        als(k.tenant(), () -> app.update("UPDATE funktion_teilnahme SET zustand = 'angehalten', angehalten_seit = now(), "
                + "updated_at = now() WHERE id = ?", t));
        als(k.tenant(), () -> app.update("UPDATE funktion SET zustand = 'archiviert', archiviert_am = now(), "
                + "geaendert_von = 'Jonas Wendlinger' WHERE id = ?", f));
    }

    /** {@code out-of-order: true}: dieselbe Datei ein zweites Mal auf dem neuesten Stand ändert nichts. */
    @Test
    void dieMigrationLaeuftAuchEinZweitesMal() throws Exception {
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());
        String sql = Files.readString(Path.of("src", "main", "resources", "db", "migration",
                "V" + DIESE + "__uems_funktion.sql"))
                .replace("${appDbUser}", APP_USER).replace("${adminDbUser}", ADMIN_USER);
        root.execute(sql);
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of()))).isEmpty();
        assertThat(root.queryForObject("SELECT count(*) FROM pg_trigger WHERE tgrelid = 'funktion_teilnahme'::regclass "
                + "AND NOT tgisinternal", Long.class)).isOne();
        assertThat(root.queryForObject("SELECT count(*) FROM pg_indexes WHERE indexname IN "
                + "('uq_funktion_je_standort', 'uq_funktion_teilnahme_je_anlage', 'idx_funktion_teilnahme_funktion')",
                Long.class)).isEqualTo(3);
        assertThat(spaltenMitUpdate("funktion_teilnahme")).containsExactly("angehalten_seit", "beendet_am",
                "eingerichtet_am", "gestartet_am", "updated_at", "zustand");
        assertThat(profilstand()).isEqualTo(profilstandVorher);
    }

    @Test
    void dasOffboardingRaeumtBeideAb() {
        Kunde k = kunde("Offboarding");
        UUID f = funktion(root, k, "steuern", "aktiv");
        teilnahme(root, k, f, k.an1(), "aktiv");
        new TenantRepository(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW))).offboard(k.tenant());
        for (String tabelle : List.of("funktion_teilnahme", "funktion", "standort", "tenant")) {
            String spalte = tabelle.equals("tenant") ? "id" : "tenant_id";
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE " + spalte + " = ?",
                    Integer.class, k.tenant())).as(tabelle).isZero();
        }
    }

    // ===================================================================== Gerüst

    /** Die Zeilen von site_profile_state als Text, Spalte für Spalte — der Byte-Vergleich. */
    private static String profilstand() {
        return root.queryForObject("SELECT coalesce(string_agg(site_id || '|' || profile || '|' || state || '|' "
                + "|| tenant_id || '|' || updated_at, E'\\n' ORDER BY site_id, profile), 'leer') FROM site_profile_state",
                String.class);
    }

    private static Kunde kunde(String name) {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, name);
        UUID st = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        UUID an1 = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Werk Ahrenberg – Halle 1') "
                + "RETURNING id", UUID.class, t);
        UUID an2 = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Werk Ahrenberg – Halle 2') "
                + "RETURNING id", UUID.class, t);
        return new Kunde(t, st, an1, an2);
    }

    private static UUID funktion(JdbcTemplate db, Kunde k, String funktion, String zustand) {
        return db.queryForObject("INSERT INTO funktion (tenant_id, standort_id, funktion, zustand, geaendert_von) "
                + "VALUES (?, ?, ?, ?, 'VoltPilot (Bestandsübernahme)') RETURNING id", UUID.class, k.tenant(),
                k.standort(), funktion, zustand);
    }

    private static UUID teilnahme(JdbcTemplate db, Kunde k, UUID funktion, UUID site, String zustand) {
        return db.queryForObject("INSERT INTO funktion_teilnahme (tenant_id, funktion_id, site_id, zustand) "
                + "VALUES (?, ?, ?, ?) RETURNING id", UUID.class, k.tenant(), funktion, site, zustand);
    }

    private static List<String> spaltenMitUpdate(String tabelle) {
        return root.queryForList("SELECT column_name FROM information_schema.columns c WHERE table_name = ? "
                + "AND has_column_privilege(?, c.table_name, c.column_name, 'UPDATE') ORDER BY column_name",
                String.class, tabelle, APP_USER);
    }

    private static <T> T als(UUID tenant, Supplier<T> arbeit) {
        TenantContext.set(tenant);
        try {
            return arbeit.get();
        } finally {
            TenantContext.clear();
        }
    }

    private static PSQLException psql(Runnable arbeit) {
        Throwable t = null;
        try {
            arbeit.run();
        } catch (Throwable e) {
            t = e;
        }
        assertThat(t).as("die Datenbank muss ablehnen").isNotNull();
        PSQLException p = null;
        for (Throwable c = t; c != null; c = c.getCause()) {
            if (c instanceof PSQLException pe) {
                p = pe;
            }
        }
        assertThat((Object) p).as("eine PSQLException: " + t.getMessage()).isNotNull();
        return p;
    }

    private static String zurueckgewiesen(Runnable arbeit) {
        return psql(arbeit).getSQLState();
    }

    private static void abgelehnt(String constraint, Runnable arbeit) {
        PSQLException p = psql(arbeit);
        assertThat(p.getServerErrorMessage().getConstraint()).as(p.getMessage()).isEqualTo(constraint);
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
