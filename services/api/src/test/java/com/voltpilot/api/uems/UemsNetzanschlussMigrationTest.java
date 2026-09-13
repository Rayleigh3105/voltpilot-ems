package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.nio.file.Files;
import java.nio.file.Path;
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
 * Die Migration {@code V20260913235000} (UEMS AP-10 IP-6): der Netzanschluss als eigenes Objekt am Standort
 * und seine Bindung an eine Anlage, 1 : 1 je Tag (E8).
 *
 * <ul>
 *   <li>Bestandsschutz über den gemeinsamen Vergleich ({@link Bestandsschutz}) — fünf neue, LEERE Tabellen;</li>
 *   <li>die ZWEI Exklusionen: je Anlage UND je Anschluss an einem Tag höchstens eine Bindung; eine Bindung,
 *       die am Vortag endet, und ihre Nachfolgerin am Folgetag stehen nebeneinander;</li>
 *   <li>ein Kennzeichen wird nie weitergegeben — auch nicht nach dem Beenden oder Umbenennen;</li>
 *   <li>eine Bindung gilt nie länger als ihr Anschluss (beide Seiten, das Trigger-Paar aus V20260913160000);</li>
 *   <li>die Anlage darf gehen, ihre Bindung bleibt (W5);</li>
 *   <li>Zaun, Rechte (kein DELETE), erneutes Ausführen und Offboarding.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsNetzanschlussMigrationTest {

    private static final String DIESE = "20260913235000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final List<String> NEU = List.of("netzanschluss", "netzanschluss_kennzeichen",
            "netzanschluss_kennzeichen_seq", "anlage_netzanschluss", "netzanschluss_aenderung");
    private static final LocalDate AN1_SEIT = LocalDate.of(2024, 3, 12);
    private static final LocalDate OKT_1 = LocalDate.of(2026, 10, 1);

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

    private record Kunde(UUID tenant, UUID standort, UUID an1, UUID an2) {}

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();
        a = kunde("Kunststoffwerk Ahrenberg GmbH");
        b = kunde("Kundenbereich B");
        // Der Bestand, an dem diese Migration hängt: Standort, Anlagen und ihre Standort-Zuordnung.
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES (?, ?, ?, ?)",
                a.tenant(), a.an1(), a.standort(), OKT_1);
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

    // ================================================================== Bestandsschutz

    @Test
    void dieMigrationLaesstDenBestandZeichengleich() {
        for (String tabelle : List.of("standort", "site", "anlage_standort", "unternehmen")) {
            assertThat(fingerVorher.get(tabelle)).as("es gibt Bestand in " + tabelle).isNotEqualTo(Bestandsschutz.LEER);
        }
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
        for (String tabelle : NEU) {
            assertThat(fingerVorher).as("neu: " + tabelle).doesNotContainKey(tabelle);
            assertThat(fingerNachMigration.get(tabelle)).as(tabelle + " kommt leer").isEqualTo(Bestandsschutz.LEER);
        }
        // W9: die Anlage bekommt KEINE Spalte netzanschluss_id — die Bindung ist die Tabelle.
        assertThat(root.queryForObject("SELECT count(*) FROM information_schema.columns WHERE table_name = 'site' "
                + "AND column_name LIKE '%netzanschluss%'", Long.class)).isZero();
    }

    @Test
    void derBestandsvergleichBeisst() {
        Bestandsschutz.mutationsprobe(root, List.of(), "standort", "UPDATE standort SET name = name || '!'");
    }

    // ============================================================ 1 : 1 je Tag, zwei Exklusionen

    @Test
    void eineAnlageHaengtAnJedemTagAnGenauEinemAnschluss() {
        Kunde k = kunde("Exklusionen");
        UUID na1 = anschluss(root, k, "NA-1", null, null);
        UUID na2 = anschluss(root, k, "NA-2", null, null);
        bindung(root, k, k.an1(), na1, AN1_SEIT, null);

        // Exklusion 1: dieselbe Anlage am selben Tag an einem zweiten Anschluss.
        abgelehnt("anlage_netzanschluss_eine_je_anlage", () -> bindung(root, k, k.an1(), na2, AN1_SEIT, null));
        // Exklusion 2: derselbe Anschluss am selben Tag an einer zweiten Anlage.
        abgelehnt("anlage_netzanschluss_eine_je_anschluss", () -> bindung(root, k, k.an2(), na1, OKT_1, null));
        assertThat(zurueckgewiesen(() -> bindung(root, k, k.an2(), na1, OKT_1, null))).isEqualTo("23P01");

        // Der Wechsel: die laufende endet am Vortag, die Nachfolgerin beginnt am Folgetag — kein Tag doppelt.
        UUID alt = root.queryForObject("SELECT id FROM anlage_netzanschluss WHERE site_id = ?", UUID.class, k.an1());
        root.update("UPDATE anlage_netzanschluss SET gueltig_bis = ? WHERE id = ?", LocalDate.of(2026, 12, 31), alt);
        bindung(root, k, k.an1(), na2, LocalDate.of(2027, 1, 1), null);
        // … und der frei gewordene Anschluss darf ab dem Folgetag an eine andere Anlage.
        bindung(root, k, k.an2(), na1, LocalDate.of(2027, 1, 1), null);
        assertThat(root.queryForList("SELECT n.kennzeichen FROM anlage_netzanschluss b JOIN netzanschluss n "
                + "ON n.id = b.netzanschluss_id WHERE b.site_id = ? AND daterange(b.gueltig_ab, b.gueltig_bis, '[]') "
                + "@> ?::date", String.class, k.an1(), LocalDate.of(2026, 12, 31))).containsExactly("NA-1");
        assertThat(root.queryForList("SELECT n.kennzeichen FROM anlage_netzanschluss b JOIN netzanschluss n "
                + "ON n.id = b.netzanschluss_id WHERE b.site_id = ? AND daterange(b.gueltig_ab, b.gueltig_bis, '[]') "
                + "@> ?::date", String.class, k.an1(), LocalDate.of(2027, 1, 1))).containsExactly("NA-2");
        // Den letzten Tag der alten zu überlappen, bleibt verboten.
        UUID na3 = anschluss(root, k, "NA-3", null, null);
        abgelehnt("anlage_netzanschluss_eine_je_anlage",
                () -> bindung(root, k, k.an1(), na3, LocalDate.of(2026, 12, 31), LocalDate.of(2026, 12, 31)));

        // Eine aufgehobene Bindung belegt keinen Tag.
        UUID auf = root.queryForObject("SELECT id FROM anlage_netzanschluss WHERE site_id = ? AND gueltig_ab = ?",
                UUID.class, k.an2(), LocalDate.of(2027, 1, 1));
        root.update("UPDATE anlage_netzanschluss SET aufgehoben_am = now() WHERE id = ?", auf);
        bindung(root, k, k.an2(), na1, LocalDate.of(2027, 1, 1), null);
    }

    // ========================================================================= Kennzeichen

    @Test
    void einKennzeichenWirdNieWeitergegebenAuchNichtNachDemBeenden() {
        Kunde k = kunde("Kennzeichen");
        UUID na1 = anschluss(root, k, "NA-1", null, null);
        assertThat(root.queryForList("SELECT kennzeichen FROM netzanschluss_kennzeichen WHERE tenant_id = ?",
                String.class, k.tenant())).containsExactly("NA-1");

        // Beendet: das Kennzeichen bleibt belegt.
        root.update("UPDATE netzanschluss SET gueltig_ab = ?, gueltig_bis = ? WHERE id = ?", OKT_1,
                LocalDate.of(2026, 12, 31), na1);
        abgelehnt("netzanschluss_kennzeichen_eindeutig", () -> anschluss(root, k, "NA-1", null, null));

        // Umbenannt: das FRÜHERE bleibt belegt — für jeden anderen Anschluss.
        root.update("UPDATE netzanschluss SET kennzeichen = 'NA-9' WHERE id = ?", na1);
        abgelehnt("netzanschluss_kennzeichen_belegt", () -> anschluss(root, k, "NA-1", null, null));
        UUID na2 = anschluss(root, k, "NA-2", null, null);
        abgelehnt("netzanschluss_kennzeichen_belegt",
                () -> root.update("UPDATE netzanschluss SET kennzeichen = 'NA-1' WHERE id = ?", na2));
        // Der Anschluss selbst darf zu seinem eigenen früheren zurück.
        root.update("UPDATE netzanschluss SET kennzeichen = 'NA-1' WHERE id = ?", na1);
        assertThat(root.queryForList("SELECT kennzeichen FROM netzanschluss_kennzeichen WHERE tenant_id = ? "
                + "ORDER BY kennzeichen", String.class, k.tenant())).containsExactly("NA-1", "NA-2", "NA-9");

        // Die Belegung wird nie geändert, der Zähler rückt nur vor.
        assertThat(zurueckgewiesen(() -> root.update("UPDATE netzanschluss_kennzeichen SET kennzeichen = 'NA-7' "
                + "WHERE tenant_id = ? AND kennzeichen = 'NA-9'", k.tenant()))).isNotNull();
        root.update("INSERT INTO netzanschluss_kennzeichen_seq (tenant_id, zaehler) VALUES (?, 2)", k.tenant());
        abgelehnt("netzanschluss_kennzeichen_seq_rueckt_nur_vor",
                () -> root.update("UPDATE netzanschluss_kennzeichen_seq SET zaehler = 1 WHERE tenant_id = ?", k.tenant()));
        // Dasselbe Kennzeichen darf ein anderer Kundenbereich tragen.
        Kunde anderer = kunde("Kennzeichen B");
        anschluss(root, anderer, "NA-1", null, null);
    }

    @Test
    void dieFormHaeltDieDatenbankSelbst() {
        Kunde k = kunde("Form");
        abgelehnt("netzanschluss_kennzeichen_format", () -> anschluss(root, k, "na 1", null, null));
        abgelehnt("netzanschluss_malo_form", () -> root.update("INSERT INTO netzanschluss (tenant_id, standort_id, "
                + "kennzeichen, name, malo, messung) VALUES (?, ?, 'NA-1', 'Hauptanschluss', '4711000000', 'RLM')",
                k.tenant(), k.standort()));
        abgelehnt("netzanschluss_messung_chk", () -> root.update("INSERT INTO netzanschluss (tenant_id, standort_id, "
                + "kennzeichen, name, messung) VALUES (?, ?, 'NA-1', 'Hauptanschluss', 'Smart')", k.tenant(), k.standort()));
        abgelehnt("netzanschluss_anschluss_kva_chk", () -> root.update("INSERT INTO netzanschluss (tenant_id, "
                + "standort_id, kennzeichen, name, messung, anschluss_kva) VALUES (?, ?, 'NA-1', 'H', 'RLM', 0)",
                k.tenant(), k.standort()));
        // Ohne Marktlokation ist er anlegbar — null, nicht „0“.
        root.update("INSERT INTO netzanschluss (tenant_id, standort_id, kennzeichen, name, messung) "
                + "VALUES (?, ?, 'NA-1', 'Hauptanschluss', 'SLP')", k.tenant(), k.standort());
        UUID na = root.queryForObject("SELECT id FROM netzanschluss WHERE tenant_id = ?", UUID.class, k.tenant());
        abgelehnt("netzanschluss_standort_bleibt", () -> root.update("UPDATE netzanschluss SET standort_id = ? "
                + "WHERE id = ?", kunde("Umzug").standort(), na));
    }

    // ================================================================ nie länger als der Anschluss

    @Test
    void eineBindungGiltNieLaengerAlsIhrAnschlussVonBeidenSeiten() {
        Kunde k = kunde("Ziel");
        UUID na = anschluss(root, k, "NA-3", OKT_1, LocalDate.of(2027, 12, 31));
        abgelehnt("anlage_netzanschluss_netzanschluss_besteht", () -> bindung(root, k, k.an1(), na, OKT_1, null));
        abgelehnt("anlage_netzanschluss_netzanschluss_besteht",
                () -> bindung(root, k, k.an1(), na, LocalDate.of(2026, 9, 30), LocalDate.of(2027, 12, 31)));
        UUID z = bindung(root, k, k.an1(), na, LocalDate.of(2026, 10, 15), LocalDate.of(2027, 12, 31));

        // Die Seite des Anschlusses: ein Ende, das die Bindung abschnitte, wird abgelehnt — nie still gekürzt.
        abgelehnt("netzanschluss_bindung_besteht",
                () -> root.update("UPDATE netzanschluss SET gueltig_bis = ? WHERE id = ?", LocalDate.of(2027, 6, 30), na));
        assertThat(root.queryForList("SELECT zeile_id FROM uems_zuordnungen_ausserhalb('netzanschluss', ?, ?, ?, ?)",
                UUID.class, k.tenant(), na, OKT_1, LocalDate.of(2027, 6, 30))).containsExactly(z);
        root.update("UPDATE anlage_netzanschluss SET gueltig_bis = ? WHERE id = ?", LocalDate.of(2027, 6, 30), z);
        root.update("UPDATE netzanschluss SET gueltig_bis = ? WHERE id = ?", LocalDate.of(2027, 6, 30), na);

        // Ein Anschluss ohne ersten Tag begrenzt nur nach hinten (das Referenzunternehmen nennt keinen).
        UUID ohne = anschluss(root, k, "NA-1", null, null);
        bindung(root, k, k.an2(), ohne, AN1_SEIT, null);
        root.update("UPDATE netzanschluss SET gueltig_ab = ? WHERE id = ?", AN1_SEIT, ohne);
        abgelehnt("netzanschluss_bindung_besteht",
                () -> root.update("UPDATE netzanschluss SET gueltig_ab = ? WHERE id = ?", AN1_SEIT.plusDays(1), ohne));
    }

    // ============================================================ die Anlage darf gehen (W5)

    @Test
    void dieAnlageDarfGehenIhreBindungBleibt() {
        Kunde k = kunde("Anlage geht");
        UUID na = anschluss(root, k, "NA-1", null, null);
        // Eine Anlage, die es nicht gibt — oder die einem anderen Kundenbereich gehört — wie ein Fremdschlüssel.
        abgelehnt("anlage_netzanschluss_site_fk", () -> bindung(root, k, UUID.randomUUID(), na, OKT_1, null));
        abgelehnt("anlage_netzanschluss_site_fk", () -> bindung(root, k, b.an1(), na, OKT_1, null));
        assertThat(zurueckgewiesen(() -> bindung(root, k, UUID.randomUUID(), na, OKT_1, null))).isEqualTo("23503");

        UUID z = bindung(root, k, k.an2(), na, OKT_1, LocalDate.of(2026, 10, 20));
        root.update("DELETE FROM site WHERE id = ?", k.an2());
        assertThat(root.queryForObject("SELECT count(*) FROM anlage_netzanschluss WHERE id = ?", Long.class, z)).isOne();
    }

    // ============================================================ Zaun, Rechte, Wiederholung, Offboarding

    @Test
    void derZaunStehtUndBeendetWirdStattGeloescht() {
        Kunde k = kunde("Zaun");
        UUID na = als(k.tenant(), () -> anschluss(app, k, "NA-1", null, null));
        UUID z = als(k.tenant(), () -> bindung(app, k, k.an1(), na, AN1_SEIT, null));
        als(k.tenant(), () -> app.update("INSERT INTO netzanschluss_aenderung (tenant_id, netzanschluss_id, art, gilt_ab, "
                + "rueckwirkend, actor_sub, actor_name, actor_art) VALUES (?, ?, 'gebunden', now(), false, 'sub-jw', "
                + "'Jonas Wendlinger', 'kunde')", k.tenant(), na));
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
        assertThat(root.queryForObject("SELECT has_table_privilege(?, 'netzanschluss_kennzeichen', 'INSERT')",
                Boolean.class, APP_USER)).as("die Belegung schreibt nur der Trigger").isFalse();
        assertThat(spaltenMitUpdate("netzanschluss")).containsExactly("anschluss_kva", "gueltig_ab", "gueltig_bis",
                "kennzeichen", "malo", "messung", "name", "netzbetreiber", "updated_at", "vereinbart_kw");
        assertThat(spaltenMitUpdate("anlage_netzanschluss")).containsExactly("aufgehoben_am", "gueltig_bis");
        assertThat(root.queryForObject("SELECT has_sequence_privilege(?, 'netzanschluss_aenderung_id_seq', 'USAGE')",
                Boolean.class, APP_USER)).isTrue();

        // Beenden statt löschen: die App-Rolle hat kein DELETE.
        assertThat(zurueckgewiesen(() -> als(k.tenant(), () -> app.update("DELETE FROM netzanschluss WHERE id = ?", na))))
                .isEqualTo("42501");
        assertThat(zurueckgewiesen(() -> als(k.tenant(), () -> app.update("DELETE FROM anlage_netzanschluss WHERE id = ?", z))))
                .isEqualTo("42501");
        // B schreibt nicht in den Kundenbereich von A, und bindet nicht an A's Anschluss.
        assertThat(zurueckgewiesen(() -> als(b.tenant(), () -> anschluss(app, k, "NA-2", null, null)))).isEqualTo("42501");
        assertThat(zurueckgewiesen(() -> als(b.tenant(), () -> bindung(app, b, b.an1(), na, OKT_1, null))))
                .isEqualTo("23503");
        // Unter dem Zaun: beenden geht (der Trigger sperrt den Anschluss mit dem Recht der App-Rolle).
        als(k.tenant(), () -> app.update("UPDATE anlage_netzanschluss SET gueltig_bis = ? WHERE id = ?",
                LocalDate.of(2026, 12, 31), z));
        als(k.tenant(), () -> app.update("UPDATE netzanschluss SET gueltig_bis = ? WHERE id = ?",
                LocalDate.of(2026, 12, 31), na));
        abgelehnt("netzanschluss_aenderung_rueckwirkend_chk", () -> root.update("INSERT INTO netzanschluss_aenderung "
                + "(tenant_id, netzanschluss_id, art, gilt_ab, rueckwirkend, actor_name, actor_art) VALUES (?, ?, "
                + "'bearbeitet', now() + interval '1 day', true, 'VoltPilot', 'voltpilot')", k.tenant(), na));
        assertThat(zurueckgewiesen(() -> root.update("UPDATE netzanschluss_aenderung SET art = 'bearbeitet' "
                + "WHERE tenant_id = ?", k.tenant()))).isNotNull();
    }

    /** {@code out-of-order: true}: dieselbe Datei ein zweites Mal auf dem neuesten Stand ändert nichts. */
    @Test
    void dieMigrationLaeuftAuchEinZweitesMal() throws Exception {
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());
        String sql = Files.readString(Path.of("src", "main", "resources", "db", "migration",
                "V" + DIESE + "__uems_netzanschluss.sql"))
                .replace("${appDbUser}", APP_USER).replace("${adminDbUser}", ADMIN_USER);
        root.execute(sql);
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of()))).isEmpty();
        assertThat(root.queryForObject("SELECT count(*) FROM pg_trigger WHERE tgfoid = "
                + "'uems_zuordnung_im_ziel()'::regprocedure AND NOT tgisinternal "
                + "AND tgrelid = 'anlage_netzanschluss'::regclass", Long.class)).isOne();
        assertThat(root.queryForObject("SELECT count(*) FROM pg_constraint WHERE conname IN "
                + "('anlage_netzanschluss_eine_je_anlage', 'anlage_netzanschluss_eine_je_anschluss')", Long.class))
                .isEqualTo(2);
    }

    @Test
    void dasOffboardingRaeumtAlleFuenfAb() {
        Kunde k = kunde("Offboarding");
        UUID na = anschluss(root, k, "NA-1", null, null);
        bindung(root, k, k.an1(), na, AN1_SEIT, null);
        root.update("UPDATE netzanschluss SET kennzeichen = 'NA-0001' WHERE id = ?", na);
        root.update("INSERT INTO netzanschluss_kennzeichen_seq (tenant_id, zaehler) VALUES (?, 1)", k.tenant());
        root.update("INSERT INTO netzanschluss_aenderung (tenant_id, netzanschluss_id, art, gilt_ab, rueckwirkend, "
                + "actor_name, actor_art) VALUES (?, ?, 'angelegt', now(), false, 'VoltPilot', 'voltpilot')", k.tenant(), na);
        new TenantRepository(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW))).offboard(k.tenant());
        for (String tabelle : List.of("anlage_netzanschluss", "netzanschluss_kennzeichen", "netzanschluss",
                "netzanschluss_kennzeichen_seq", "netzanschluss_aenderung", "standort", "tenant")) {
            String spalte = tabelle.equals("tenant") ? "id" : "tenant_id";
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE " + spalte + " = ?",
                    Integer.class, k.tenant())).as(tabelle).isZero();
        }
    }

    // ===================================================================== Gerüst

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

    private static UUID anschluss(JdbcTemplate db, Kunde k, String kennzeichen, LocalDate ab, LocalDate bis) {
        return db.queryForObject("INSERT INTO netzanschluss (tenant_id, standort_id, kennzeichen, name, malo, "
                + "netzbetreiber, anschluss_kva, vereinbart_kw, messung, gueltig_ab, gueltig_bis) VALUES (?, ?, ?, ?, "
                + "'47110000001', 'Netzgesellschaft Ahrental (fiktiv)', 630, 550, 'RLM', ?, ?) RETURNING id", UUID.class,
                k.tenant(), k.standort(), kennzeichen, "Anschluss " + kennzeichen, ab, bis);
    }

    private static UUID bindung(JdbcTemplate db, Kunde k, UUID site, UUID netzanschluss, LocalDate ab, LocalDate bis) {
        return db.queryForObject("INSERT INTO anlage_netzanschluss (tenant_id, site_id, netzanschluss_id, gueltig_ab, "
                + "gueltig_bis) VALUES (?, ?, ?, ?, ?) RETURNING id", UUID.class, k.tenant(), site, netzanschluss, ab, bis);
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
