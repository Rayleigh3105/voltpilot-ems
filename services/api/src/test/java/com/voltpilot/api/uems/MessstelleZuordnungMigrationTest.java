package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.MessstelleRegeln.Groesse;
import com.voltpilot.api.uems.MessstelleRepository.NeueMessstelle;
import java.io.IOException;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.List;
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
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Migration {@code V20260911230000} (UEMS AP-04 IP-7, Teil Ort und Stellung) gegen eine
 * echte TimescaleDB: {@code messstelle_ort} und {@code messstelle_stellung} — ihr Mandantenzaun,
 * ihre zeitlosen Regeln als Constraint und die Rechte der App-Rolle. Was über mehrere Zeilen
 * geht (Ziel besteht, Regel 8), urteilt der Schreibweg ({@link MessstelleZuordnungApiTest}).
 *
 * <p>Bewiesen wird: (a) der Zaun steht auf beiden Tabellen (RLS + FORCE + Policy mit USING und
 * WITH CHECK), eine fremde Zeile ist unsichtbar und nicht anhängbar (zusammengesetzte
 * Fremdschlüssel); (b) das Überlappungsverbot mit dem LETZTEN Tag einschließlich ({@code '[]'}),
 * ein aufgehobenes Intervall belegt keinen Tag; (c) genau ein Ziel, das Stellungs-Vokabular,
 * „Unterzähler von“ genau bei „Unterzähler“ und nie auf sich selbst, bis ≥ ab; (d) die
 * App-Rolle beendet und hebt auf, löscht und schreibt nie um; (e) das Protokoll kennt die vier
 * neuen Arten und weiter die alten; (f) ohne Offboarding verweigert die Datenbank, das
 * Offboarding räumt ab und lässt das Protokoll stehen.
 *
 * <p>Beispielquelle ist das Referenzunternehmen: MS-08 „Kühlung Kaltwassersatz“ an B-2 und als
 * Unterzähler von MS-01 in AN-1 ab 12.03.2024, bis 28.02.2027.
 */
@Testcontainers(disabledWithoutDocker = true)
class MessstelleZuordnungMigrationTest {

    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final List<String> TABELLEN = List.of("messstelle_ort", "messstelle_stellung");
    private static final LocalDate ERSTER_TAG = LocalDate.parse("2024-03-12");
    private static final LocalDate UMZUG_VORTAG = LocalDate.parse("2027-02-28");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JsonNode referenz;
    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static TransactionTemplate tx;
    private static MessstelleRepository messstellen;
    private static MessstelleZuordnungRepository zuordnungen;

    @BeforeAll
    static void migriere() throws IOException {
        referenz = new ObjectMapper().readTree(V2.resolve("uems-referenzunternehmen.json").toFile());
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW))
                .load().migrate();
        DataSource appDs = new TenantAwareDataSource(ds(APP_USER, APP_PW));
        app = new JdbcTemplate(appDs);
        tx = new TransactionTemplate(new DataSourceTransactionManager(appDs));
        messstellen = new MessstelleRepository(app);
        zuordnungen = new MessstelleZuordnungRepository(app);
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    /** Ein Kundenbereich mit Standort ST-1, Gebäude G-1, Bereich B-2, Anlage AN-1 und MS-01/MS-08. */
    private record Bestand(UUID tenant, UUID standort, UUID gebaeude, UUID bereich, UUID anlage, UUID ms01,
            UUID ms08) {}

    private static Bestand bestand(String name) {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name) VALUES (?, ?) RETURNING id",
                UUID.class, t, name);
        UUID st = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, "
                + "zeitzone, zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'entwurf') "
                + "RETURNING id", UUID.class, t, u);
        UUID g = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) "
                + "VALUES (?, 'gebaeude', 'Halle 1', 'G-1', 'aktiv') RETURNING id", UUID.class, t);
        UUID b = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) "
                + "VALUES (?, 'bereich', 'Halle 1 Süd', 'B-2', 'aktiv') RETURNING id", UUID.class, t);
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Werk Ahrenberg – Halle 1') "
                + "RETURNING id", UUID.class, t);
        UUID ms01 = als(t, () -> tx.execute(s -> messstellen.anlegen(wieReferenz(t, "MS-01")).id()));
        UUID ms08 = als(t, () -> tx.execute(s -> messstellen.anlegen(wieReferenz(t, "MS-08")).id()));
        return new Bestand(t, st, g, b, site, ms01, ms08);
    }

    // ---- (a) Der Zaun ----------------------------------------------------------

    @Test
    void derZaunStehtAufBeidenTabellenUndEinFremderVerweisGehtNicht() {
        Bestand a = bestand("Zaun A");
        Bestand b = bestand("Zaun B");
        for (Bestand x : List.of(a, b)) {
            als(x.tenant(), () -> zuordnungen.ortEintragen(x.tenant(), x.ms08(), "bereich", x.bereich(),
                    ERSTER_TAG, null, "ines.kaltenbach"));
            als(x.tenant(), () -> zuordnungen.stellungEintragen(x.tenant(), x.ms08(), x.anlage(), "Unterzähler",
                    x.ms01(), ERSTER_TAG, null, "ines.kaltenbach"));
        }
        for (String t : TABELLEN) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                    + "WHERE relname = ?", Boolean.class, t)).as(t).isTrue();
            assertThat(anzahl("SELECT count(*) FROM pg_policies WHERE tablename = ? AND qual LIKE "
                    + "'%app.tenant_id%' AND with_check LIKE '%app.tenant_id%'", t)).as(t).isOne();
            assertThat(anzahl("SELECT count(DISTINCT tenant_id) FROM " + t)).as(t).isGreaterThanOrEqualTo(2);
            assertThat(app.queryForObject("SELECT count(*) FROM " + t, Long.class)).as("ohne Mandant " + t).isZero();
            assertThat(als(b.tenant(), () -> app.queryForObject(
                    "SELECT count(*) FROM " + t + " WHERE tenant_id <> ?", Long.class, b.tenant()))).as(t).isZero();
        }
        assertThat(als(b.tenant(), () -> zuordnungen.orte(a.ms08()))).isEmpty();
        assertThat(als(b.tenant(), () -> zuordnungen.stellungen(a.ms08()))).isEmpty();
        // Die Zeile des Mandanten nennt Ziel und Bezug in der Form des Vertrags.
        MessstelleZuordnungRepository.OrtZeile ort = als(a.tenant(), () -> zuordnungen.orte(a.ms08())).get(0);
        assertThat(ort.zielArt()).isEqualTo("bereich");
        assertThat(ort.kennzeichen()).isEqualTo("B-2");
        assertThat(als(a.tenant(), () -> zuordnungen.stellungen(a.ms08())).get(0).unterzaehlerVonKennzeichen())
                .isEqualTo("MS-01");

        // Die Policy (WITH CHECK) lehnt eine Zeile des fremden Mandanten ab …
        abgelehntWegen("42501", "row-level security", () -> als(b.tenant(), () -> zuordnungen.ortEintragen(
                a.tenant(), a.ms08(), "bereich", a.bereich(), ERSTER_TAG, null, null)));
        // … und die zusammengesetzten Fremdschlüssel (sie prüfen ohne RLS) jeden Verweis hinüber.
        abgelehnt("23503", "messstelle_ort_messstelle_fk", () -> als(b.tenant(), () -> zuordnungen.ortEintragen(
                b.tenant(), a.ms08(), "bereich", b.bereich(), ERSTER_TAG, null, null)));
        abgelehnt("23503", "messstelle_ort_ort_fk", () -> als(b.tenant(), () -> zuordnungen.ortEintragen(
                b.tenant(), b.ms01(), "bereich", a.bereich(), ERSTER_TAG, null, null)));
        abgelehnt("23503", "messstelle_ort_standort_fk", () -> als(b.tenant(), () -> zuordnungen.ortEintragen(
                b.tenant(), b.ms01(), "standort", a.standort(), ERSTER_TAG, null, null)));
        abgelehnt("23503", "messstelle_stellung_site_fk", () -> als(b.tenant(), () -> zuordnungen
                .stellungEintragen(b.tenant(), b.ms01(), a.anlage(), "Hauptzähler", null, ERSTER_TAG, null, null)));
        abgelehnt("23503", "messstelle_stellung_bezug_fk", () -> als(b.tenant(), () -> zuordnungen
                .stellungEintragen(b.tenant(), b.ms01(), b.anlage(), "Unterzähler", a.ms01(), ERSTER_TAG, null,
                        null)));
    }

    // ---- (b) Überlappung -----------------------------------------------------

    @Test
    void jeMessstelleEinOrtUndEineStellungJeTagBisIstDerLetzteTag() {
        Bestand x = bestand("Überlappung");
        UUID t = x.tenant();
        UUID ort = als(t, () -> zuordnungen.ortEintragen(t, x.ms08(), "bereich", x.bereich(), ERSTER_TAG,
                UMZUG_VORTAG, null));
        UUID stellung = als(t, () -> zuordnungen.stellungEintragen(t, x.ms08(), x.anlage(), "Unterzähler",
                x.ms01(), ERSTER_TAG, UMZUG_VORTAG, null));
        // `bis` IST der letzte Tag: ein neues Intervall ab genau diesem Tag überlappt.
        abgelehnt("23P01", "messstelle_ort_keine_ueberlappung", () -> als(t, () -> zuordnungen.ortEintragen(
                t, x.ms08(), "gebaeude", x.gebaeude(), UMZUG_VORTAG, null, null)));
        abgelehnt("23P01", "messstelle_stellung_keine_ueberlappung", () -> als(t, () -> zuordnungen
                .stellungEintragen(t, x.ms08(), x.anlage(), "keine", null, UMZUG_VORTAG, null, null)));
        // Ab dem Folgetag geht es — ohne Lücke, ohne Überlappung (der Umzug am 01.03.2027).
        als(t, () -> zuordnungen.ortEintragen(t, x.ms08(), "gebaeude", x.gebaeude(), UMZUG_VORTAG.plusDays(1),
                null, null));
        // Eine andere Messstelle belegt ihre eigenen Tage.
        als(t, () -> zuordnungen.ortEintragen(t, x.ms01(), "standort", x.standort(), ERSTER_TAG, null, null));
        // Ein aufgehobenes Intervall belegt keinen Tag mehr: an seiner Stelle geht ein neues.
        alsTue(t, () -> assertThat(zuordnungen.stellungAufheben(stellung, java.time.Instant.now())).isTrue());
        als(t, () -> zuordnungen.stellungEintragen(t, x.ms08(), x.anlage(), "keine", null, ERSTER_TAG, null, null));
        // Ein Intervall wird beendet, nie davor: bis < ab lehnt der CHECK ab.
        abgelehnt("23514", "messstelle_ort_bis_nicht_vor_ab", () -> alsTue(t, () -> zuordnungen.ortBeenden(
                ort, ERSTER_TAG.minusDays(1))));
    }

    // ---- (c) Die zeitlosen Regeln -------------------------------------------

    @Test
    void genauEinZielDasVokabularUndDerBezugNurBeiUnterzaehler() {
        Bestand x = bestand("CHECKs");
        UUID t = x.tenant();
        UUID u = root.queryForObject("SELECT id FROM unternehmen WHERE tenant_id = ?", UUID.class, t);
        abgelehnt("23514", "messstelle_ort_genau_ein_ziel", () -> alsTue(t, () -> app.update(
                "INSERT INTO messstelle_ort (tenant_id, messstelle_id, standort_id, ort_id, gueltig_ab) "
                        + "VALUES (?, ?, ?, ?, ?)", t, x.ms08(), x.standort(), x.bereich(), ERSTER_TAG)));
        abgelehnt("23514", "messstelle_ort_genau_ein_ziel", () -> alsTue(t, () -> app.update(
                "INSERT INTO messstelle_ort (tenant_id, messstelle_id, gueltig_ab) VALUES (?, ?, ?)",
                t, x.ms08(), ERSTER_TAG)));
        // Das Unternehmen ist ein Ziel wie jedes andere (MS-19 hängt dort).
        als(t, () -> zuordnungen.ortEintragen(t, x.ms01(), "unternehmen", u, ERSTER_TAG, null, null));
        assertThat(als(t, () -> zuordnungen.orte(x.ms01())).get(0).kennzeichen()).isEqualTo(OrtsbaumAbleitung.UNTERNEHMEN);

        // Das Vokabular von MessstelleRegeln.STELLUNGEN — und nichts sonst (auch keine Schreibweise ohne Umlaut).
        for (String s : MessstelleRegeln.STELLUNGEN) {
            UUID bezug = "Unterzähler".equals(s) ? x.ms01() : null;
            UUID id = als(t, () -> zuordnungen.stellungEintragen(t, x.ms08(), x.anlage(), s, bezug, ERSTER_TAG,
                    null, null));
            alsTue(t, () -> zuordnungen.stellungAufheben(id, java.time.Instant.now()));
        }
        for (String falsch : List.of("Hauptzaehler", "Zwischenzähler", "")) {
            abgelehnt("23514", "messstelle_stellung_chk", () -> als(t, () -> zuordnungen.stellungEintragen(
                    t, x.ms08(), x.anlage(), falsch, null, ERSTER_TAG, null, null)));
        }
        // `bezug_fehlt`, `bezug_nur_bei_unterzaehler`, `selbst` (Vertrag §6) als zeitlose Rückwand.
        abgelehnt("23514", "messstelle_stellung_bezug_genau_bei_unterzaehler", () -> als(t, () -> zuordnungen
                .stellungEintragen(t, x.ms08(), x.anlage(), "Unterzähler", null, ERSTER_TAG, null, null)));
        abgelehnt("23514", "messstelle_stellung_bezug_genau_bei_unterzaehler", () -> als(t, () -> zuordnungen
                .stellungEintragen(t, x.ms08(), x.anlage(), "Erzeuger", x.ms01(), ERSTER_TAG, null, null)));
        abgelehnt("23514", "messstelle_stellung_nicht_selbst", () -> als(t, () -> zuordnungen
                .stellungEintragen(t, x.ms08(), x.anlage(), "Unterzähler", x.ms08(), ERSTER_TAG, null, null)));
    }

    // ---- (d) Rechte, (e) Protokoll, (f) Offboarding ---------------------------

    @Test
    void dieAppRolleBeendetUndHebtAufLoeschtUndSchreibtNieUm() {
        for (String tabelle : TABELLEN) {
            assertThat(recht(APP_USER, tabelle, "SELECT")).isTrue();
            assertThat(recht(APP_USER, tabelle, "INSERT")).isTrue();
            assertThat(recht(APP_USER, tabelle, "UPDATE")).as("kein UPDATE auf der ganzen Zeile").isFalse();
            assertThat(recht(APP_USER, tabelle, "DELETE")).isFalse();
            for (String spalte : List.of("gueltig_bis", "aufgehoben_am")) {
                assertThat(root.queryForObject("SELECT has_column_privilege(?, ?, ?, 'UPDATE')", Boolean.class,
                        APP_USER, tabelle, spalte)).as(tabelle + "." + spalte).isTrue();
            }
            assertThat(recht(ADMIN_USER, tabelle, "DELETE")).as("das Offboarding löscht über die Admin-Rolle").isTrue();
        }
        Bestand x = bestand("Rechte");
        UUID t = x.tenant();
        UUID ort = als(t, () -> zuordnungen.ortEintragen(t, x.ms08(), "bereich", x.bereich(), ERSTER_TAG, null, null));
        UUID stellung = als(t, () -> zuordnungen.stellungEintragen(t, x.ms08(), x.anlage(), "Unterzähler", x.ms01(),
                ERSTER_TAG, null, null));
        alsTue(t, () -> {
            for (String tabelle : TABELLEN) {
                abgelehntWegen("42501", "permission denied", () -> app.update("DELETE FROM " + tabelle));
            }
            abgelehntWegen("42501", "permission denied", () -> app.update(
                    "UPDATE messstelle_ort SET gueltig_ab = gueltig_ab - 1 WHERE id = ?", ort));
            abgelehntWegen("42501", "permission denied", () -> app.update(
                    "UPDATE messstelle_ort SET ort_id = NULL, standort_id = ? WHERE id = ?", x.standort(), ort));
            abgelehntWegen("42501", "permission denied", () -> app.update(
                    "UPDATE messstelle_stellung SET stellung = 'Hauptzähler', unterzaehler_von = NULL WHERE id = ?",
                    stellung));
            abgelehntWegen("42501", "permission denied", () -> app.update(
                    "UPDATE messstelle_stellung SET site_id = site_id WHERE id = ?", stellung));
            assertThat(zuordnungen.ortBeenden(ort, UMZUG_VORTAG)).isTrue();
            assertThat(zuordnungen.stellungBeenden(stellung, UMZUG_VORTAG)).isTrue();
            assertThat(zuordnungen.ortAufheben(ort, java.time.Instant.now())).isTrue();
            // Ein aufgehobenes Intervall ist erledigt: es wird weder beendet noch noch einmal aufgehoben.
            assertThat(zuordnungen.ortBeenden(ort, ERSTER_TAG)).isFalse();
            assertThat(zuordnungen.ortAufheben(ort, java.time.Instant.now())).isFalse();
        });
    }

    @Test
    void dasProtokollKenntDieVierArtenUndWeiterDieAlten() {
        Bestand x = bestand("Protokoll");
        List<String> arten = List.of("angelegt", "bearbeitet", "angehalten", "fortgesetzt", "archiviert",
                "nebengroesse_hinzugefuegt", "nebengroesse_archiviert",
                "ort_zugeordnet", "ort_korrigiert", "stellung_zugeordnet", "stellung_korrigiert");
        for (String art : arten) {
            alsTue(x.tenant(), () -> app.update("INSERT INTO messstelle_aenderung (tenant_id, messstelle_id, art, "
                    + "gilt_ab, rueckwirkend, actor_sub, actor_name, actor_rolle, actor_art) "
                    + "VALUES (?, ?, ?, '2024-03-11T23:00:00Z', true, 'sub-ines', 'Ines Kaltenbach', "
                    + "'kundenadministrator', 'kunde')", x.tenant(), x.ms08(), art));
        }
        assertThat(anzahl("SELECT count(*) FROM messstelle_aenderung WHERE messstelle_id = ?", x.ms08()))
                .isEqualTo(arten.size());
        abgelehnt("23514", "messstelle_aenderung_art_chk", () -> alsTue(x.tenant(), () -> app.update(
                "INSERT INTO messstelle_aenderung (tenant_id, messstelle_id, art, gilt_ab, rueckwirkend, "
                        + "actor_name, actor_art) VALUES (?, ?, 'kostenstelle_zugeordnet', now(), false, "
                        + "'VoltPilot', 'voltpilot')", x.tenant(), x.ms08())));
    }

    @Test
    void ohneOffboardingVerweigertDieDatenbankUndDasOffboardingRaeumtAb() {
        Bestand x = bestand("Offboarding-Probe");
        UUID t = x.tenant();
        als(t, () -> zuordnungen.ortEintragen(t, x.ms08(), "bereich", x.bereich(), ERSTER_TAG, null, null));
        als(t, () -> zuordnungen.stellungEintragen(t, x.ms08(), x.anlage(), "Unterzähler", x.ms01(), ERSTER_TAG,
                null, null));
        alsTue(t, () -> app.update("INSERT INTO messstelle_aenderung (tenant_id, messstelle_id, art, gilt_ab, "
                + "rueckwirkend, actor_name, actor_art) VALUES (?, ?, 'ort_zugeordnet', now(), false, 'VoltPilot', "
                + "'voltpilot')", t, x.ms08()));
        // Nie Kaskade: weder Messstelle noch Bereich noch Anlage mit Zuordnung gehen still.
        abgelehnt("23503", null, () -> root.update("DELETE FROM messstelle WHERE id = ?", x.ms08()));
        abgelehnt("23503", null, () -> root.update("DELETE FROM messstelle WHERE id = ?", x.ms01()));
        abgelehnt("23503", null, () -> root.update("DELETE FROM ort WHERE id = ?", x.bereich()));
        abgelehnt("23503", null, () -> root.update("DELETE FROM site WHERE id = ?", x.anlage()));
        // Während der Laufzeit bleibt das Protokoll append-only — auch für Verwaltungsrolle und Eigentümer.
        abgelehntWegen("42501", "permission denied",
                () -> new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW))
                        .update("DELETE FROM messstelle_aenderung WHERE tenant_id = ?", t));
        abgelehntWegen("P0001", "append-only",
                () -> root.update("DELETE FROM messstelle_aenderung WHERE tenant_id = ?", t));
        abgelehntWegen("P0001", "append-only",
                () -> root.update("UPDATE messstelle_aenderung SET tenant_id = tenant_id WHERE tenant_id = ?", t));

        new TenantRepository(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW))).offboard(t);
        assertThat(anzahl("SELECT count(*) FROM tenant WHERE id = ?", t)).isZero();
        for (String tabelle : TABELLEN) {
            assertThat(anzahl("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?", t)).as(tabelle).isZero();
        }
        // Das Protokoll geht nach der Mandantenzeile mit (AP-20 E10 = A, V20260925234500): ohne Fremdschlüssel,
        // aber nicht mehr übrig.
        assertThat(anzahl("SELECT count(*) FROM messstelle_aenderung WHERE tenant_id = ?", t)).isZero();
    }

    // ---- Gerüst ------------------------------------------------------------------

    private static NeueMessstelle wieReferenz(UUID tenant, String kennzeichen) {
        JsonNode ms = null;
        for (JsonNode m : referenz.get("messstellen")) {
            if (m.get("kennzeichen").asText().equals(kennzeichen)) {
                ms = m;
            }
        }
        JsonNode g = ms.get("hauptgroesse");
        return new NeueMessstelle(tenant, kennzeichen, ms.get("name").asText(), ms.get("art").asText(),
                ms.get("medium").asText(), new Groesse(g.get("groesse").asText(), g.get("richtung").asText(),
                        g.get("einheit").asText(), g.get("wertart").asText()), null);
    }

    private static boolean recht(String rolle, String tabelle, String recht) {
        return Boolean.TRUE.equals(root.queryForObject("SELECT has_table_privilege(?, ?, ?)", Boolean.class,
                rolle, tabelle, recht));
    }

    private static long anzahl(String sql, Object... args) {
        return root.queryForObject(sql, Long.class, args);
    }

    /** Unter dem Zaun des Mandanten — jede Anweisung für sich (eine Ablehnung bricht nichts Folgendes ab). */
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

    private static PSQLException ablehnung(Runnable arbeit) {
        try {
            arbeit.run();
            return null;
        } catch (RuntimeException e) {
            for (Throwable t = e; t != null; t = t.getCause()) {
                if (t instanceof PSQLException p) {
                    return p;
                }
            }
            throw e;
        }
    }

    private static void abgelehnt(String sqlState, String constraint, Runnable arbeit) {
        PSQLException p = ablehnung(arbeit);
        assertThat((Object) p).as("die Datenbank muss ablehnen (" + constraint + ")").isNotNull();
        assertThat(p.getSQLState()).as(p.getMessage()).isEqualTo(sqlState);
        if (constraint != null) {
            assertThat(p.getServerErrorMessage().getConstraint()).as(p.getMessage()).isEqualTo(constraint);
        }
    }

    private static void abgelehntWegen(String sqlState, String nachricht, Runnable arbeit) {
        PSQLException p = ablehnung(arbeit);
        assertThat((Object) p).as("die Datenbank muss ablehnen (" + nachricht + ")").isNotNull();
        assertThat(p.getSQLState()).as(p.getMessage()).isEqualTo(sqlState);
        assertThat(p.getMessage()).contains(nachricht);
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
