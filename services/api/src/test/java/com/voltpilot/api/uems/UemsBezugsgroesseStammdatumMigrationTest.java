package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.time.LocalDate;
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
 * Die Migration {@code V20260914151500__uems_bezugsgroesse_stammdatum.sql} (UEMS AP-09 IP-6, E15): die
 * Bezugs-Stammdaten mit Gültigkeit ab einem Tag — das Muster der Bezugsfläche, aber NIE eine Fläche (E17).
 *
 * <p>Der Bestand (Ortsstruktur mit Flächen, eine Bezugsgröße mit Wert und Protokoll) wird VOR der Migration
 * geschrieben; {@link Bestandsschutz} beweist, dass sie keine Zeile anfasst — auch keine Fläche.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsBezugsgroesseStammdatumMigrationTest {

    private static final String DIESE = "20260914151500";
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

    private record Kunde(UUID tenant, UUID unternehmen, UUID standort, UUID halle) {}

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();
        Kunde a = kunde("Kunststoffwerk Ahrenberg GmbH");
        root.update("INSERT INTO flaeche_gueltigkeit (tenant_id, ort_id, m2, gueltig_ab, gueltig_bis) "
                + "VALUES (?, ?, 3100, '2026-10-01', '2026-12-31')", a.tenant(), a.halle());
        root.update("INSERT INTO flaeche_gueltigkeit (tenant_id, ort_id, m2, gueltig_ab) VALUES (?, ?, 3400, '2027-01-01')",
                a.tenant(), a.halle());
        UUID bg = periodenwert(root, a, "BZ-0001");
        root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, periode_von, "
                + "periode_bis, zeitzone, fassung, vorgang, status, betrag, herkunft_art, actor_sub, actor_name, "
                + "actor_rolle, actor_art) VALUES (?, ?, 'periodenwert', 'kg', 'monat', '2025-10-01', '2025-10-31', "
                + "'Europe/Berlin', 1, 'erstwert', 'wirksam', 312400, 'eingabe', 'sub-ik', 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde')", a.tenant(), bg);
        root.update("INSERT INTO bezugsgroesse_aenderung (tenant_id, bezugsgroesse_id, art, gilt_ab, rueckwirkend, "
                + "actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, ?, 'angelegt', date_trunc('minute', now()), "
                + "false, 'sub-ik', 'Ines Kaltenbach', 'energiemanager', 'kunde')", a.tenant(), bg);
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
        assertThat(fingerVorher.get("flaeche_gueltigkeit")).as("es gibt Flächen").isNotEqualTo(Bestandsschutz.LEER);
        assertThat(fingerVorher.get("bezugsgroesse_wert")).isNotEqualTo(Bestandsschutz.LEER);
        assertThat(fingerVorher.get("bezugsgroesse_aenderung")).isNotEqualTo(Bestandsschutz.LEER);
        assertThat(fingerNachMigration.get("bezugsgroesse_stammdatum")).as("keine kopierte Fläche").isEqualTo(Bestandsschutz.LEER);
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
    }

    @Test
    void derBestandsvergleichBeisst() {
        Bestandsschutz.mutationsprobe(root, List.of(), "flaeche_gueltigkeit", "UPDATE flaeche_gueltigkeit SET m2 = m2 + 1");
    }

    // ============================================================ Zaun und Rechte

    @Test
    void dieTabelleHatDenZaunUndEngeRechte() {
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                + "WHERE relname = 'bezugsgroesse_stammdatum'", Boolean.class)).isTrue();
        Map<String, Object> policy = root.queryForMap("SELECT qual, with_check FROM pg_policies "
                + "WHERE tablename = 'bezugsgroesse_stammdatum'");
        assertThat((String) policy.get("qual")).contains("app.tenant_id");
        assertThat((String) policy.get("with_check")).contains("app.tenant_id");
        assertThat(rechte(APP_USER)).as("kein DELETE; INSERT und UPDATE nur spaltenweise").isEqualTo("S");
        for (String spalte : List.of("tenant_id", "bezugsgroesse_id", "wertart", "einheit", "wert", "gueltig_ab", "gueltig_bis",
                "created_by")) {
            assertThat(spaltenrecht(APP_USER, spalte, "INSERT")).as("INSERT " + spalte).isTrue();
        }
        assertThat(rechte(ADMIN_USER)).isEqualTo("SD");
        for (String spalte : List.of("gueltig_bis", "aufgehoben_am")) {
            assertThat(spaltenrecht(APP_USER, spalte, "UPDATE")).as("UPDATE " + spalte).isTrue();
        }
        for (String spalte : List.of("wert", "gueltig_ab", "einheit", "wertart", "bezugsgroesse_id", "tenant_id", "created_at")) {
            assertThat(spaltenrecht(APP_USER, spalte, "UPDATE")).as("UPDATE " + spalte).isFalse();
        }
        assertThat(spaltenrecht(APP_USER, "created_at", "INSERT")).as("die Eintragszeit setzt die Datenbank").isFalse();
        // Die Rechte der bestehenden Tabellen bleiben, wie sie waren.
        assertThat(tabellenrechte(APP_USER, "bezugsgroesse_wert")).isEqualTo("S");
        assertThat(tabellenrechte(APP_USER, "flaeche_gueltigkeit")).isEqualTo("SI");
    }

    @Test
    void ohneMandantKeineZeileUndFremdIstNichtDa() {
        Kunde a = kunde("Zaun A");
        Kunde b = kunde("Zaun B");
        UUID bg = mitarbeitende(root, a);
        stammdatum(root, a, bg, "180", "2026-10-01", null);
        assertThat(app.queryForObject("SELECT count(*) FROM bezugsgroesse_stammdatum", Long.class)).as("ohne app.tenant_id").isZero();
        assertThat(als(b.tenant(), () -> app.queryForObject("SELECT count(*) FROM bezugsgroesse_stammdatum", Long.class))).isZero();
        assertThat(als(a.tenant(), () -> app.queryForObject("SELECT count(*) FROM bezugsgroesse_stammdatum", Long.class))).isOne();
        PSQLException p = psql(() -> als(b.tenant(), () -> stammdatum(app, a, bg, "190", "2027-01-01", null)));
        assertThat(p.getMessage()).contains("row-level security");
        assertThat(als(b.tenant(), () -> app.update("UPDATE bezugsgroesse_stammdatum SET aufgehoben_am = now()"))).isZero();
    }

    // ============================================================ Die Tabelle selbst

    /** Je Bezugsgröße ein Wert je Tag; ein aufgehobenes Intervall belegt keinen Tag, aneinanderstoßende sind erlaubt. */
    @Test
    void jeTagEinWertUndEineKorrekturHebtAuf() {
        Kunde k = kunde("Exklusion");
        UUID bg = mitarbeitende(root, k);
        als(k.tenant(), () -> {
            stammdatum(app, k, bg, "180", "2026-10-01", "2026-12-31");
            stammdatum(app, k, bg, "185", "2027-01-01", null);
            return null;
        });
        abgelehnt("bezugsgroesse_stammdatum_keine_ueberlappung",
                () -> als(k.tenant(), () -> stammdatum(app, k, bg, "182", "2026-12-31", "2026-12-31")));
        als(k.tenant(), () -> app.update("UPDATE bezugsgroesse_stammdatum SET aufgehoben_am = now() "
                + "WHERE bezugsgroesse_id = ? AND gueltig_ab = '2027-01-01'", bg));
        als(k.tenant(), () -> stammdatum(app, k, bg, "186", "2027-01-01", null));
        abgelehnt("bezugsgroesse_stammdatum_bis_nicht_vor_ab",
                () -> als(k.tenant(), () -> stammdatum(app, k, bg, "1", "2028-01-02", "2028-01-01")));
        PSQLException umschreiben = psql(() -> als(k.tenant(), () -> app.update(
                "UPDATE bezugsgroesse_stammdatum SET wert = 999 WHERE bezugsgroesse_id = ?", bg)));
        assertThat(umschreiben.getMessage()).contains("permission denied");
        PSQLException loeschen = psql(() -> als(k.tenant(), () -> app.update(
                "DELETE FROM bezugsgroesse_stammdatum WHERE bezugsgroesse_id = ?", bg)));
        assertThat(loeschen.getMessage()).contains("permission denied");
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsgroesse_stammdatum WHERE bezugsgroesse_id = ?",
                Long.class, bg)).isEqualTo(3);
    }

    /**
     * E17 in der Datenbank: eine Einheit der Größe {@code flaeche} bekommt nie ein Stammdatum — auch nicht an einer
     * Bezugsgröße in m², die es nur an der Anwendung vorbei gibt. „Nicht erhoben“ ist keine 0, und nur ein
     * Stammdatum hat Gültigkeiten.
     */
    @Test
    void eineFlaecheWirdHierNieGespeichert() {
        Kunde k = kunde("Keine Fläche");
        UUID flaeche = root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, "
                + "geltung_art, ort_id) VALUES (?, 'BZ-0004', 'Bezugsfläche', 'stammdatum', 'm²', 'gebaeude', ?) RETURNING id",
                UUID.class, k.tenant(), k.halle());
        abgelehnt("bezugsgroesse_stammdatum_keine_flaeche_chk", () -> root.update("INSERT INTO bezugsgroesse_stammdatum "
                + "(tenant_id, bezugsgroesse_id, einheit, wert, gueltig_ab) VALUES (?, ?, 'm²', 3100, '2026-10-01')",
                k.tenant(), flaeche));
        UUID bg = mitarbeitende(root, k);
        abgelehnt("bezugsgroesse_stammdatum_wert_chk", () -> stammdatum(root, k, bg, "0", "2026-10-01", null));
        UUID pw = periodenwert(root, k, "BZ-0002");
        abgelehnt("bezugsgroesse_stammdatum_wertart_chk", () -> root.update("INSERT INTO bezugsgroesse_stammdatum "
                + "(tenant_id, bezugsgroesse_id, wertart, einheit, wert, gueltig_ab) VALUES (?, ?, 'periodenwert', 'kg', 1, "
                + "'2026-10-01')", k.tenant(), pw));
        abgelehnt("bezugsgroesse_stammdatum_bedeutung_fk", () -> root.update("INSERT INTO bezugsgroesse_stammdatum "
                + "(tenant_id, bezugsgroesse_id, einheit, wert, gueltig_ab) VALUES (?, ?, 'kg', 1, '2026-10-01')",
                k.tenant(), pw));
        assertThat(root.queryForObject("SELECT bezugsdaten_groesse('m²')", String.class)).isEqualTo("flaeche");
        assertThat(root.queryForObject("SELECT bezugsdaten_groesse('Quadratmeter')", String.class)).isNull();
    }

    /** M1/M6: ein Stammdatum-Wert ist ein Wert — Einheit und Geltungsbereich bleiben fest, gelöscht wird nicht. */
    @Test
    void einStammdatumWertHaeltDieBedeutungFest() {
        Kunde k = kunde("Bedeutung");
        UUID bg = mitarbeitende(root, k);
        stammdatum(root, k, bg, "180", "2026-10-01", null);
        abgelehnt("bezugsgroesse_stammdatum_bedeutung_fk",
                () -> root.update("UPDATE bezugsgroesse SET einheit = 'Schichten' WHERE id = ?", bg));
        abgelehnt("bezugsgroesse_geltung_nach_erstem_wert", () -> root.update("UPDATE bezugsgroesse SET geltung_art = "
                + "'standort', unternehmen_id = NULL, standort_id = ? WHERE id = ?", k.standort(), bg));
        abgelehnt("bezugsgroesse_hat_werte", () -> als(k.tenant(), () -> app.update("DELETE FROM bezugsgroesse WHERE id = ?", bg)));
        assertThat(root.update("UPDATE bezugsgroesse SET name = 'Mitarbeitende gesamt' WHERE id = ?", bg)).isOne();
        // Ohne Wert bleibt alles wie vorher: löschbar.
        UUID leer = periodenwert(root, k, "BZ-0003");
        assertThat(als(k.tenant(), () -> app.update("DELETE FROM bezugsgroesse WHERE id = ?", leer))).isOne();
    }

    @Test
    void dasProtokollKenntDenEintrag() {
        Kunde k = kunde("Protokoll");
        UUID bg = mitarbeitende(root, k);
        for (String art : List.of("angelegt", "bearbeitet", "archiviert", "geloescht", "stammdatum_eingetragen")) {
            assertThat(protokoll(k, bg, art)).as(art).isOne();
        }
        abgelehnt("bezugsgroesse_aenderung_art_chk", () -> protokoll(k, bg, "flaeche_geaendert"));
    }

    @Test
    void dasOffboardingRaeumtDieStammdatenAb() {
        Kunde k = kunde("Offboarding");
        UUID bg = mitarbeitende(root, k);
        stammdatum(root, k, bg, "180", "2026-10-01", "2026-12-31");
        stammdatum(root, k, bg, "185", "2027-01-01", null);
        protokoll(k, bg, "stammdatum_eingetragen");

        new TenantRepository(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW))).offboard(k.tenant());

        for (String tabelle : List.of("bezugsgroesse_stammdatum", "bezugsgroesse", "bezugsgroesse_aenderung",
                "flaeche_gueltigkeit", "unternehmen", "tenant")) {
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
        UUID g = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) "
                + "VALUES (?, 'gebaeude', 'Halle 2', 'G-2', 'aktiv') RETURNING id", UUID.class, t);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES (?, ?, ?, '2026-01-01')",
                t, g, st);
        return new Kunde(t, u, st, g);
    }

    private static UUID periodenwert(JdbcTemplate db, Kunde k, String kennzeichen) {
        return db.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, "
                + "geltung_art, standort_id) VALUES (?, ?, ?, 'periodenwert', 'kg', 'monat', 'standort', ?) RETURNING id",
                UUID.class, k.tenant(), kennzeichen, "Produktionsmenge " + kennzeichen, k.standort());
    }

    private static UUID mitarbeitende(JdbcTemplate db, Kunde k) {
        return db.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, geltung_art, "
                + "unternehmen_id) VALUES (?, 'BZ-0006', 'Mitarbeitende', 'stammdatum', 'Personen', 'unternehmen', ?) "
                + "RETURNING id", UUID.class, k.tenant(), k.unternehmen());
    }

    private static int stammdatum(JdbcTemplate db, Kunde k, UUID bg, String wert, String ab, String bis) {
        return db.update("INSERT INTO bezugsgroesse_stammdatum (tenant_id, bezugsgroesse_id, einheit, wert, gueltig_ab, "
                + "gueltig_bis, created_by) VALUES (?, ?, 'Personen', ?, ?, ?, 'sub-ik')", k.tenant(), bg, new BigDecimal(wert),
                LocalDate.parse(ab), bis == null ? null : LocalDate.parse(bis));
    }

    private static int protokoll(Kunde k, UUID bg, String art) {
        return root.update("INSERT INTO bezugsgroesse_aenderung (tenant_id, bezugsgroesse_id, art, gilt_ab, rueckwirkend, "
                + "actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, ?, ?, date_trunc('minute', now()), false, "
                + "'sub-ik', 'Ines Kaltenbach', 'energiemanager', 'kunde')", k.tenant(), bg, art);
    }

    private static String rechte(String rolle) {
        return tabellenrechte(rolle, "bezugsgroesse_stammdatum");
    }

    private static String tabellenrechte(String rolle, String tabelle) {
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

    private static boolean spaltenrecht(String rolle, String spalte, String recht) {
        return Boolean.TRUE.equals(root.queryForObject("SELECT has_column_privilege(?, 'bezugsgroesse_stammdatum', ?, ?)",
                Boolean.class, rolle, spalte, recht));
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
        assertThat((Object) p).as("eine PSQLException: " + t).isNotNull();
        return p;
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
