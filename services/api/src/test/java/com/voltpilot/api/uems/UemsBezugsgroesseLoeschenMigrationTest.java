package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.sql.Connection;
import java.time.LocalDate;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
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
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Migration {@code V20260913120000__uems_bezugsgroesse_loeschen.sql} (UEMS AP-09 IP-5, Befund 3
 * aus IP-4): die Anwendung darf eine Bezugsgröße OHNE Wert löschen (M6) — eng: nur diese Tabelle,
 * ein Trigger lehnt das Löschen mit Werten für jede Rolle ab, und das Kennzeichen bleibt als
 * Grabstein im Verlauf belegt (M2). Dazu die Protokoll-Art {@code geloescht} (Befund 4).
 *
 * <p>Der Bestand (Bezugsgrößen mit Werten, umbenannten Kennzeichen, Protokoll) wird VOR der
 * Migration geschrieben; {@link Bestandsschutz} beweist, dass sie keine Zeile anfasst.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsBezugsgroesseLoeschenMigrationTest {

    private static final String DIESE = "20260913120000";
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
    private static Kunde a;
    private static Kunde b;
    private static UUID bestandMitWert;
    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;

    private record Kunde(UUID tenant, UUID unternehmen, UUID standort) {}

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();
        a = kunde("Kunststoffwerk Ahrenberg GmbH");
        b = kunde("Kundenbereich B");
        // Der Bestand aus IP-4: eine Bezugsgröße mit Wert und umbenanntem Kennzeichen, eine ohne Wert, Protokoll.
        bestandMitWert = bezugsgroesse(root, a, "BZ-0001");
        root.update("UPDATE bezugsgroesse SET kennzeichen = 'BZ-1' WHERE id = ?", bestandMitWert);
        erstwert(root, a, bestandMitWert);
        bezugsgroesse(root, a, "BZ-0002");
        protokoll(root, a, bestandMitWert, "angelegt");
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());

        flyway().target(DIESE).load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, List.of());
        flyway().load().migrate();

        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ============================================================ Bestandsschutz

    @Test
    void dieMigrationLaesstDenBestandZeichengleich() {
        assertThat(fingerVorher.get("bezugsgroesse")).as("es gibt Bezugsgrößen").isNotEqualTo(Bestandsschutz.LEER);
        assertThat(fingerVorher.get("bezugsgroesse_kennzeichen_verlauf")).isNotEqualTo(Bestandsschutz.LEER);
        assertThat(fingerVorher.get("bezugsgroesse_wert")).isNotEqualTo(Bestandsschutz.LEER);
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
    }

    @Test
    void derBestandsvergleichBeisst() {
        Bestandsschutz.mutationsprobe(root, List.of(), "bezugsgroesse",
                "UPDATE bezugsgroesse SET name = name || ' (Probe)'");
    }

    // ============================================================ Die eine Öffnung

    @Test
    void dieAnwendungDarfNurDieBezugsgroesseLoeschen() {
        assertThat(rechte(APP_USER, "bezugsgroesse")).isEqualTo("SID");
        assertThat(rechte(APP_USER, "bezugsgroesse_kennzeichen_verlauf")).isEqualTo("S");
        assertThat(rechte(APP_USER, "bezugsgroesse_wert")).isEqualTo("S");
        assertThat(rechte(APP_USER, "bezugsgroesse_aenderung")).isEqualTo("SI");
        assertThat(root.queryForObject("SELECT is_nullable FROM information_schema.columns WHERE table_name = "
                + "'bezugsgroesse_kennzeichen_verlauf' AND column_name = 'bezugsgroesse_id'", String.class)).isEqualTo("YES");
    }

    /** M6: auch eine Rücknahme ist ein Wert — und keine Rolle löscht an einem Wert vorbei, auch nicht der Eigentümer. */
    @Test
    void einWertVerhindertDasLoeschenFuerJedeRolle() {
        Kunde k = kunde("Mit Wert");
        UUID bg = bezugsgroesse(root, k, "BZ-0001");
        erstwert(root, k, bg);
        abgelehnt("bezugsgroesse_hat_werte", () -> alsTue(k.tenant(), () -> app.update("DELETE FROM bezugsgroesse WHERE id = ?", bg)));
        abgelehnt("bezugsgroesse_hat_werte", () -> root.update("DELETE FROM bezugsgroesse WHERE id = ?", bg));
        root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, periode_von, "
                + "periode_bis, zeitzone, fassung, ersetzt_fassung, vorgang, status, betrag, begruendung, herkunft_art, "
                + "actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, ?, 'periodenwert', 'kg', 'monat', '2025-10-01', "
                + "'2025-10-31', 'Europe/Berlin', 2, 1, 'ruecknahme', 'zurueckgenommen', NULL, 'Falsche Artikelgruppe', "
                + "'eingabe', 'sub-ik', 'Ines Kaltenbach', 'energiemanager', 'kunde')", k.tenant(), bg);
        abgelehnt("bezugsgroesse_hat_werte", () -> alsTue(k.tenant(), () -> app.update("DELETE FROM bezugsgroesse WHERE id = ?", bg)));
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsgroesse_wert WHERE bezugsgroesse_id = ?", Long.class, bg)).isEqualTo(2);
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsgroesse WHERE id = ?", Long.class, bg)).isOne();
    }

    /** M2: das Kennzeichen einer gelöschten Bezugsgröße bleibt belegt — beide, das heutige und das frühere. */
    @Test
    void ohneWertGeloeschtBleibtJedesKennzeichenAlsGrabsteinBelegt() {
        Kunde k = kunde("Grabstein");
        UUID bg = als(k.tenant(), () -> bezugsgroesse(app, k, "BZ-0100"));
        alsTue(k.tenant(), () -> app.update("UPDATE bezugsgroesse SET kennzeichen = 'BZ-0101' WHERE id = ?", bg));
        assertThat(als(k.tenant(), () -> app.update("DELETE FROM bezugsgroesse WHERE id = ?", bg))).isOne();

        assertThat(root.queryForList("SELECT kennzeichen || ':' || coalesce(bezugsgroesse_id::text, 'grabstein') "
                + "FROM bezugsgroesse_kennzeichen_verlauf WHERE tenant_id = ? ORDER BY kennzeichen", String.class, k.tenant()))
                .containsExactly("BZ-0100:grabstein", "BZ-0101:grabstein");
        for (String kz : List.of("BZ-0100", "BZ-0101")) {
            abgelehnt("bezugsgroesse_kennzeichen_belegt", () -> alsTue(k.tenant(), () -> bezugsgroesse(app, k, kz)));
        }
        // Ein anderer Kundenbereich darf dasselbe Kennzeichen tragen.
        als(b.tenant(), () -> bezugsgroesse(app, b, "BZ-0100"));
    }

    /** Der Grabstein ist die EINZIGE Änderung, die der Verlauf zulässt — alles andere bleibt append-only. */
    @Test
    void derVerlaufBleibtSonstUnveraenderlich() {
        Kunde k = kunde("Verlauf");
        UUID bg = bezugsgroesse(root, k, "BZ-0200");
        UUID andere = bezugsgroesse(root, k, "BZ-0201");
        abgelehntMitMeldung("audit rows are append-only", () -> root.update(
                "UPDATE bezugsgroesse_kennzeichen_verlauf SET belegt_am = now() WHERE bezugsgroesse_id = ?", bg));
        abgelehntMitMeldung("audit rows are append-only", () -> root.update(
                "UPDATE bezugsgroesse_kennzeichen_verlauf SET bezugsgroesse_id = ? WHERE bezugsgroesse_id = ?", andere, bg));
        abgelehntMitMeldung("audit rows are append-only", () -> root.update(
                "UPDATE bezugsgroesse_kennzeichen_verlauf SET bezugsgroesse_id = NULL, kennzeichen = 'BZ-0299' "
                        + "WHERE bezugsgroesse_id = ?", bg));
        root.update("DELETE FROM bezugsgroesse WHERE id = ?", bg);
        abgelehntMitMeldung("audit rows are append-only", () -> root.update(
                "UPDATE bezugsgroesse_kennzeichen_verlauf SET bezugsgroesse_id = ? WHERE kennzeichen = 'BZ-0200' "
                        + "AND tenant_id = ?", andere, k.tenant()));
    }

    /** Befund 4: die Liste der Protokoll-Arten ist der Stand von IP-4 plus {@code geloescht} — und weiter geschlossen. */
    @Test
    void dasProtokollKenntGeloeschtUndSonstNichtsNeues() {
        for (String art : List.of("angelegt", "bearbeitet", "archiviert", "geloescht")) {
            protokoll(root, a, UUID.randomUUID(), art);
        }
        abgelehnt("bezugsgroesse_aenderung_art_chk", () -> protokoll(root, a, UUID.randomUUID(), "entfernt"));
    }

    @Test
    void einFremderKundenbereichLoeschtNichts() {
        UUID bg = als(a.tenant(), () -> bezugsgroesse(app, a, "BZ-0300"));
        assertThat(als(b.tenant(), () -> app.update("DELETE FROM bezugsgroesse WHERE id = ?", bg))).isZero();
        assertThat(app.update("DELETE FROM bezugsgroesse WHERE id = ?", bg)).as("ohne Mandant").isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsgroesse WHERE id = ?", Long.class, bg)).isOne();
    }

    /**
     * Die Gleichzeitigkeit zu M6: ein erster Wert, der NOCH NICHT bestätigt ist, lässt das Löschen warten
     * (DELETE braucht FOR UPDATE, das Einfügen hält FOR KEY SHARE) — danach lehnt der Trigger ab.
     */
    @Test
    void dasLoeschenWartetAufEinenGleichzeitigenErstenWert() throws Exception {
        Kunde k = kunde("Rennen");
        UUID bg = bezugsgroesse(root, k, "BZ-0400");
        DataSource appDs = ds(APP_USER, APP_PW);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try (Connection eins = appDs.getConnection(); Connection zwei = appDs.getConnection()) {
            JdbcTemplate s1 = sitzung(eins, k.tenant());
            JdbcTemplate s2 = sitzung(zwei, k.tenant());
            erstwert(s1, k, bg);
            int pid = s2.queryForObject("SELECT pg_backend_pid()", Integer.class);
            Future<Integer> loeschen = pool.submit(() -> s2.update("DELETE FROM bezugsgroesse WHERE id = ?", bg));
            warteBis(() -> Boolean.TRUE.equals(root.queryForObject(
                    "SELECT wait_event_type = 'Lock' FROM pg_stat_activity WHERE pid = ?", Boolean.class, pid)));
            eins.commit();
            PSQLException p = null;
            try {
                loeschen.get(10, TimeUnit.SECONDS);
            } catch (java.util.concurrent.ExecutionException e) {
                for (Throwable c = e; c != null; c = c.getCause()) {
                    if (c instanceof PSQLException pe) {
                        p = pe;
                    }
                }
            }
            assertThat((Object) p).as("das Löschen scheitert nach dem bestätigten Wert").isNotNull();
            assertThat(p.getServerErrorMessage().getConstraint()).isEqualTo("bezugsgroesse_hat_werte");
            zwei.rollback();
        } finally {
            pool.shutdownNow();
        }
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsgroesse WHERE id = ?", Long.class, bg)).isOne();
    }

    /** Das Offboarding räumt auch einen Grabstein ab (Kinder zuerst, V20260913104500). */
    @Test
    void dasOffboardingRaeumtAuchDenGrabsteinAb() {
        Kunde k = kunde("Offboarding mit Grabstein");
        UUID weg = bezugsgroesse(root, k, "BZ-0500");
        UUID bleibt = bezugsgroesse(root, k, "BZ-0501");
        erstwert(root, k, bleibt);
        root.update("DELETE FROM bezugsgroesse WHERE id = ?", weg);
        protokoll(root, k, weg, "geloescht");

        new TenantRepository(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW))).offboard(k.tenant());

        for (String tabelle : List.of("bezugsgroesse_wert", "bezugsgroesse_kennzeichen_verlauf", "bezugsgroesse",
                "bezugsgroesse_aenderung", "unternehmen", "tenant")) {
            String spalte = tabelle.equals("tenant") ? "id" : "tenant_id";
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE " + spalte + " = ?", Long.class,
                    k.tenant())).as(tabelle).isZero();
        }
    }

    // ===================================================================== Gerüst

    private static Kunde kunde(String name) {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, name);
        UUID st = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        return new Kunde(t, u, st);
    }

    private static UUID bezugsgroesse(JdbcTemplate db, Kunde k, String kennzeichen) {
        return db.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, "
                + "geltung_art, standort_id) VALUES (?, ?, ?, 'periodenwert', 'kg', 'monat', 'standort', ?) RETURNING id",
                UUID.class, k.tenant(), kennzeichen, "Produktionsmenge " + kennzeichen, k.standort());
    }

    /** Ein Erstwert Oktober 2025, 312 400 kg. */
    private static void erstwert(JdbcTemplate db, Kunde k, UUID bg) {
        db.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, periode_von, "
                + "periode_bis, zeitzone, fassung, vorgang, status, betrag, herkunft_art, actor_sub, actor_name, "
                + "actor_rolle, actor_art) VALUES (?, ?, 'periodenwert', 'kg', 'monat', ?, ?, 'Europe/Berlin', 1, "
                + "'erstwert', 'wirksam', ?, 'eingabe', 'sub-ik', 'Ines Kaltenbach', 'energiemanager', 'kunde')",
                k.tenant(), bg, LocalDate.of(2025, 10, 1), LocalDate.of(2025, 10, 31), new BigDecimal("312400"));
    }

    private static void protokoll(JdbcTemplate db, Kunde k, UUID bg, String art) {
        db.update("INSERT INTO bezugsgroesse_aenderung (tenant_id, bezugsgroesse_id, art, gilt_ab, rueckwirkend, "
                + "actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, ?, ?, date_trunc('minute', now()), false, "
                + "'sub-ik', 'Ines Kaltenbach', 'energiemanager', 'kunde')", k.tenant(), bg, art);
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

    private static JdbcTemplate sitzung(Connection verbindung, UUID tenant) throws java.sql.SQLException {
        verbindung.setAutoCommit(false);
        JdbcTemplate db = new JdbcTemplate(new SingleConnectionDataSource(verbindung, true));
        db.queryForObject("SELECT set_config('app.tenant_id', ?, false)", String.class, tenant.toString());
        return db;
    }

    private static void warteBis(BooleanSupplier bedingung) throws InterruptedException {
        for (int i = 0; i < 200 && !bedingung.getAsBoolean(); i++) {
            Thread.sleep(50);
        }
        assertThat(bedingung.getAsBoolean()).as("die zweite Sitzung wartet auf die Sperre").isTrue();
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
