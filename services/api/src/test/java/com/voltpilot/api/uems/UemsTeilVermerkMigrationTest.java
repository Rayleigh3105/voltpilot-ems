package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
 * Konzept Nachweisen n1, Runde 2, PR 1 (V20261007004500): „Trifft bei uns zurzeit nicht zu“ unter der wirklichen
 * App-Rolle. Die Datenbank hält den Teil aus dem Vokabular {@code teil}, den Satz mit 10 bis 500 Zeichen, „entschieden
 * von“ als Person desselben Mandanten, den Akteur, das Aufheben ganz oder gar nicht, höchstens einen geltenden Vermerk
 * je Teil, „nur anhängen“ bis auf das einmalige Aufheben, den Mandanten- und den Standort-Zaun und die Rechte selbst;
 * das Vokabular wächst als Vereinigung, die Migration legt nur daneben und trägt auch als späte Ankunft.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsTeilVermerkMigrationTest {

    private static final String DIESE = "20261007004500";
    private static final String APP = "voltpilot_app", ADMIN = "voltpilot_admin", PW = "n1_teil_vermerk_test_pw";
    private static final List<String> TABELLEN = List.of("energiemanagement_teil_vermerk");
    private static final String SATZ = "Risiken und Chancen bewerten wir im Jahresgespräch der Geschäftsführung.";
    /** Spätere Migrationen, die auf diese aufbauen: sie reisen bei der späten Ankunft mit. */
    private static final List<String> BAUEN_DARAUF_AUF = List.of();

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root, app, admin;
    private static Map<String, String> fingerVorher, fingerNachMigration;
    private static List<String> vokabularVorher, vokabularNachMigration;

    /** Ein Kundenbereich mit Unternehmen, zwei Standorten und der Person Robert Falk (ohne Konto). */
    private record Kunde(UUID tenant, UUID st1, UUID st2, UUID rf) {
    }

    @BeforeAll
    static void bestandUndMigration() {
        root = new JdbcTemplate(ds(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway(POSTGRES.getJdbcUrl()).target(letzteFassungVorDieser()).load().migrate();
        TenantContext.clear();
        kunde("Kunststoffwerk Ahrenberg GmbH");
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());
        vokabularVorher = vokabular(root);
        flyway(POSTGRES.getJdbcUrl()).target(DIESE).load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, List.of());
        vokabularNachMigration = vokabular(root);
        flyway(POSTGRES.getJdbcUrl()).load().migrate();
        app = new JdbcTemplate(new TenantAwareDataSource(ds(POSTGRES.getJdbcUrl(), APP, PW)));
        admin = new JdbcTemplate(ds(POSTGRES.getJdbcUrl(), ADMIN, PW));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ============================================================ Vokabular und CHECKs

    /** Vereinigung, nie enger: jedes Wort von vorher Zeile für Zeile mit seiner Nummer, dazu genau der Block teil. */
    @Test
    void dasVokabularWaechstNurUmDieAchtzehnTeileDesVertrags() throws IOException {
        assertThat(vokabularNachMigration).containsAll(vokabularVorher);
        List<String> neu = new ArrayList<>(vokabularNachMigration);
        neu.removeAll(vokabularVorher);
        JsonNode vertrag = new ObjectMapper().readTree(Path.of("../../docs/contracts/v2/energiemanagement-vectors.json")
                .toFile());
        List<String> teile = new ArrayList<>();
        vertrag.path("vokabulare").path("teil").forEach(w -> teile.add(w.asText()));
        assertThat(teile).hasSize(18).containsExactlyElementsOf(EnergiemanagementRegeln.VOKABULARE.get("teil"));
        List<String> erwartet = new ArrayList<>();
        for (int i = 0; i < teile.size(); i++) {
            erwartet.add("teil/" + (i + 1) + "/" + teile.get(i));
        }
        assertThat(neu).containsExactlyInAnyOrderElementsOf(erwartet);
        assertThat(vokabularVorher).noneMatch(w -> w.startsWith("teil/"));
    }

    @Test
    void jederChecksHaeltSeinenTeil() {
        Kunde k = kunde("Checks");
        TenantContext.set(k.tenant());
        checkFehler("energiemanagement_teil_vermerk_teil_chk", () -> vermerk(k, "sonstiges", SATZ));
        checkFehler("energiemanagement_teil_vermerk_teil_chk", () -> vermerk(k, "Risiken und Chancen", SATZ));
        checkFehler("energiemanagement_teil_vermerk_satz_chk", () -> vermerk(k, "kontext", "Neun Zeic"));
        checkFehler("energiemanagement_teil_vermerk_satz_chk", () -> vermerk(k, "kontext", "   Neun Zeic   "));
        checkFehler("energiemanagement_teil_vermerk_satz_chk", () -> vermerk(k, "kontext", "x".repeat(501)));
        vermerk(k, "kontext", "Zehn Zeich");
        vermerk(k, "berichte", "y".repeat(500));
        // Der Akteur: Name, Art aus der Liste, ohne Subject nur VoltPilot selbst.
        String sql = "INSERT INTO energiemanagement_teil_vermerk(tenant_id,teil,satz,entschieden_von,entschieden_am,"
                + "actor_sub,actor_name,actor_rolle,actor_art) VALUES (?,?,?,?,'2029-04-30',?,?,?,?)";
        checkFehler("energiemanagement_teil_vermerk_actor_chk", () -> app.update(sql, k.tenant(), "aufgaben", SATZ,
                k.rf(), "IK", " ", "energiemanager", "kunde"));
        checkFehler("energiemanagement_teil_vermerk_actor_chk", () -> app.update(sql, k.tenant(), "aufgaben", SATZ,
                k.rf(), null, "Ines Kaltenbach", "energiemanager", "kunde"));
        checkFehler("energiemanagement_teil_vermerk_actor_art_chk", () -> app.update(sql, k.tenant(), "aufgaben", SATZ,
                k.rf(), "IK", "Ines Kaltenbach", "energiemanager", "maschine"));
        checkFehler("energiemanagement_teil_vermerk_actor_rolle_chk", () -> app.update(sql, k.tenant(), "aufgaben",
                SATZ, k.rf(), "IK", "Ines Kaltenbach", "chef", "kunde"));
        app.update(sql, k.tenant(), "aufgaben", SATZ, k.rf(), "RF", "Robert Falk", "einsicht", "kunde");
        // Das Aufheben ganz oder gar nicht.
        UUID v = vermerk(k, "risiken_chancen", SATZ);
        checkFehler("energiemanagement_teil_vermerk_aufgehoben_chk", () -> app.update(
                "UPDATE energiemanagement_teil_vermerk SET aufgehoben_am = now() WHERE id = ?", v));
        checkFehler("energiemanagement_teil_vermerk_aufgehoben_chk", () -> app.update(
                "UPDATE energiemanagement_teil_vermerk SET aufgehoben_name = 'Ines Kaltenbach', aufgehoben_art = 'kunde' "
                        + "WHERE id = ?", v));
        checkFehler("energiemanagement_teil_vermerk_aufgehoben_chk", () -> app.update(
                "UPDATE energiemanagement_teil_vermerk SET aufgehoben_am = now(), aufgehoben_name = 'Ines Kaltenbach', "
                        + "aufgehoben_art = 'maschine' WHERE id = ?", v));
        assertThat(app.queryForObject("SELECT count(*) FROM energiemanagement_teil_vermerk", Integer.class)).isEqualTo(4);
    }

    // ============================================================ höchstens ein geltender Vermerk, nur anhängen

    @Test
    void hoechstensEinGeltenderVermerkJeTeilUndEinAufgehobenerBleibtDaneben() {
        Kunde k = kunde("Geltend");
        TenantContext.set(k.tenant());
        UUID erster = vermerk(k, "risiken_chancen", SATZ);
        checkState("23505", "energiemanagement_teil_vermerk_geltend_uq", () -> vermerk(k, "risiken_chancen", SATZ));
        aufheben(erster);
        UUID zweiter = vermerk(k, "risiken_chancen", SATZ);
        assertThat(zweiter).isNotEqualTo(erster);
        assertThat(app.queryForObject("SELECT count(*) FROM energiemanagement_teil_vermerk WHERE teil = 'risiken_chancen'",
                Integer.class)).isEqualTo(2);
        // Ein anderer Kundenbereich vermerkt denselben Teil unabhängig.
        Kunde anderer = kunde("Geltend, anderer");
        TenantContext.set(anderer.tenant());
        vermerk(anderer, "risiken_chancen", SATZ);
    }

    @Test
    void nurAnhaengenBisAufDasEinmaligeAufhebenUndDieAppRolleLoeschtNie() {
        Kunde k = kunde("Nur anhängen");
        TenantContext.set(k.tenant());
        UUID v = vermerk(k, "kontext", SATZ);
        // Die App-Rolle ändert nur die Spalten des Aufhebens und löscht nie; auch der Eigentümer ändert nichts sonst.
        checkState("42501", null, () -> app.update("UPDATE energiemanagement_teil_vermerk SET satz = ? WHERE id = ?",
                SATZ + " Neu.", v));
        checkState("42501", null, () -> app.update("UPDATE energiemanagement_teil_vermerk SET entschieden_am = "
                + "'2029-01-01' WHERE id = ?", v));
        checkState("42501", null, () -> app.update("DELETE FROM energiemanagement_teil_vermerk WHERE id = ?", v));
        checkFehler("energiemanagement_teil_vermerk_nur_anhaengen", () -> root.update(
                "UPDATE energiemanagement_teil_vermerk SET satz = ? WHERE id = ?", SATZ + " Neu.", v));
        checkFehler("energiemanagement_teil_vermerk_nur_anhaengen", () -> root.update(
                "UPDATE energiemanagement_teil_vermerk SET aufgehoben_am = now(), aufgehoben_name = 'Ines Kaltenbach', "
                        + "aufgehoben_art = 'kunde', teil = 'aufgaben' WHERE id = ?", v));
        aufheben(v);
        // Aufgehoben ist endgültig, für jede Rolle.
        checkFehler("energiemanagement_teil_vermerk_endgueltig", () -> app.update(
                "UPDATE energiemanagement_teil_vermerk SET aufgehoben_name = 'Ines Kaltenbach' WHERE id = ?", v));
        checkFehler("energiemanagement_teil_vermerk_endgueltig", () -> root.update(
                "UPDATE energiemanagement_teil_vermerk SET aufgehoben_am = NULL, aufgehoben_name = NULL, "
                        + "aufgehoben_art = NULL, aufgehoben_sub = NULL, aufgehoben_rolle = NULL WHERE id = ?", v));
        assertThat(app.update("UPDATE energiemanagement_teil_vermerk SET aufgehoben_name = aufgehoben_name WHERE id = ?",
                v)).as("dasselbe noch einmal ist keine Änderung").isOne();

        assertThat(root.queryForObject("SELECT has_table_privilege(?, 'energiemanagement_teil_vermerk', 'SELECT') AND "
                + "has_table_privilege(?, 'energiemanagement_teil_vermerk', 'INSERT')", Boolean.class, APP, APP)).isTrue();
        assertThat(root.queryForObject("SELECT has_table_privilege(?, 'energiemanagement_teil_vermerk', 'DELETE') OR "
                + "has_table_privilege(?, 'energiemanagement_teil_vermerk', 'TRUNCATE') OR "
                + "has_table_privilege(?, 'energiemanagement_teil_vermerk', 'UPDATE')", Boolean.class, APP, APP, APP))
                .as("kein DELETE, kein UPDATE über die ganze Zeile").isFalse();
        assertThat(root.queryForList("SELECT column_name FROM information_schema.column_privileges WHERE grantee = ? "
                + "AND table_name = 'energiemanagement_teil_vermerk' AND privilege_type = 'UPDATE' ORDER BY column_name",
                String.class, APP)).containsExactly("aufgehoben_am", "aufgehoben_art", "aufgehoben_name",
                        "aufgehoben_rolle", "aufgehoben_sub");
        assertThat(root.queryForObject("SELECT has_table_privilege(?, 'energiemanagement_teil_vermerk', 'DELETE')",
                Boolean.class, ADMIN)).as("Offboarding").isTrue();
    }

    // ============================================================ Mandant, Zaun, Person

    @Test
    void mandantUndStandortZaunUndEntschiedenVonIstEinePersonDesselbenMandanten() {
        Kunde k = kunde("Zaun");
        Kunde fremd = kunde("Zaun, fremd");
        TenantContext.set(k.tenant());
        UUID v = vermerk(k, "risiken_chancen", SATZ);
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = "
                + "'energiemanagement_teil_vermerk'", Boolean.class)).isTrue();
        assertThat(root.queryForObject("SELECT count(*) FROM pg_policies WHERE tablename = 'energiemanagement_teil_vermerk' "
                + "AND policyname = 'site_scope' AND permissive = 'RESTRICTIVE'", Integer.class)).isOne();
        assertThat(root.queryForObject("SELECT count(*) FROM pg_policies WHERE tablename = 'energiemanagement_teil_vermerk' "
                + "AND permissive = 'PERMISSIVE'", Integer.class)).as("nur die Mandanten-Policy öffnet").isOne();

        // Unternehmensweit sichtbar, im engen Standort-Zaun nicht, und dort auch nicht anzulegen.
        Integer weit = eng(k.tenant(), null, j -> j.queryForObject("SELECT count(*) FROM energiemanagement_teil_vermerk",
                Integer.class));
        Integer standorte = eng(k.tenant(), List.of(k.st1(), k.st2()), j -> j.queryForObject(
                "SELECT count(*) FROM energiemanagement_teil_vermerk", Integer.class));
        assertThat(weit).isOne();
        assertThat(standorte).isZero();
        checkState("42501", null, () -> eng(k.tenant(), List.of(k.st1()), j -> j.update(
                "INSERT INTO energiemanagement_teil_vermerk(tenant_id,teil,satz,entschieden_von,entschieden_am,actor_sub,"
                        + "actor_name,actor_art) VALUES (?,'kontext',?,?,'2029-04-30','IK','Ines Kaltenbach','kunde')",
                k.tenant(), SATZ, k.rf())));
        // Ein fremder Mandant sieht nichts, und der Mandant kommt nie aus einer fremden Kennung.
        TenantContext.set(fremd.tenant());
        assertThat(app.queryForObject("SELECT count(*) FROM energiemanagement_teil_vermerk", Integer.class)).isZero();
        assertThat(app.update("UPDATE energiemanagement_teil_vermerk SET aufgehoben_am = now(), "
                + "aufgehoben_name = 'Fremd', aufgehoben_art = 'kunde' WHERE id = ?", v)).isZero();
        checkState("42501", null, () -> vermerk(new Kunde(k.tenant(), k.st1(), k.st2(), k.rf()), "kontext", SATZ));
        // „entschieden von“ ist eine Person DESSELBEN Mandanten; eine genannte Person ist nicht löschbar.
        TenantContext.set(k.tenant());
        checkState("23503", "energiemanagement_teil_vermerk_entschieden_von_fk",
                () -> vermerk(new Kunde(k.tenant(), k.st1(), k.st2(), fremd.rf()), "kontext", SATZ));
        checkState("23503", "energiemanagement_teil_vermerk_entschieden_von_fk",
                () -> root.update("DELETE FROM energiemanagement_person WHERE id = ?", k.rf()));
    }

    @Test
    void dasOffboardingRaeumtDieVermerkeVorDenPersonenAb() {
        Kunde k = kunde("Offboarding");
        TenantContext.set(k.tenant());
        UUID v = vermerk(k, "risiken_chancen", SATZ);
        aufheben(v);
        vermerk(k, "risiken_chancen", SATZ);
        vermerk(k, "kontext", SATZ);
        TenantContext.clear();
        new TenantRepository(admin).offboard(k.tenant());
        for (String t : List.of("energiemanagement_teil_vermerk", "energiemanagement_person")) {
            assertThat(root.queryForObject("SELECT count(*) FROM " + t + " WHERE tenant_id = ?", Integer.class, k.tenant()))
                    .as(t).isZero();
        }
        assertThat(root.queryForObject("SELECT count(*) FROM tenant WHERE id = ?", Integer.class, k.tenant())).isZero();
    }

    // ============================================================ Bestand und Reihenfolge

    @Test
    void dieMigrationLegtNurDanebenUndLaesstDenBestandZeichengleich() {
        assertThat(fingerVorher).hasSizeGreaterThan(100).doesNotContainKeys(TABELLEN.toArray(String[]::new));
        assertThat(fingerVorher.get("energiemanagement_person")).as("es gibt Bestand").isNotEqualTo(Bestandsschutz.LEER);
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
        for (String tabelle : TABELLEN) {
            assertThat(fingerNachMigration).as(tabelle).containsEntry(tabelle, Bestandsschutz.LEER);
        }
    }

    @Test
    void derBestandsvergleichFaengtEineGeaenderteZeile() {
        Bestandsschutz.mutationsprobe(root, List.of(), "unternehmen", "UPDATE unternehmen SET name = name || ' (Probe)'");
    }

    /** Out-of-order: auf einer Datenbank mit ALLEN anderen Migrationen kommt diese zuletzt an und trägt genauso. */
    @Test
    void dieMigrationTraegtAuchAlsSpaeteAnkunft() throws IOException {
        root.execute("CREATE DATABASE voltpilot_spaet");
        String url = POSTGRES.getJdbcUrl().replace("/voltpilot?", "/voltpilot_spaet?");
        Path ohneDiese = Files.createTempDirectory("ohne-teil-vermerk");
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
                        + "AND tgrelid::regclass::text IN " + tabellen,
                "SELECT string_agg(format('%s/%s/%s', vokabular, nr, wort), '|' ORDER BY vokabular, nr) "
                        + "FROM energiemanagement_vokabular()")) {
            assertThat(spaetDb.queryForObject(sql, String.class)).as(sql).isNotNull()
                    .isEqualTo(root.queryForObject(sql, String.class));
        }
    }

    // ============================================================ Gerüst

    /** Ein Kundenbereich mit Unternehmen, zwei Standorten, dem Konto IK und Robert Falk als Person ohne Konto. */
    private static Kunde kunde(String name) {
        UUID tenant = root.queryForObject("INSERT INTO tenant(name) VALUES (?) RETURNING id", UUID.class, name);
        UUID unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name) VALUES (?,?) RETURNING id",
                UUID.class, tenant, name);
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,'IK','benutzer',"
                + "'Ines Kaltenbach','aktiv')", tenant);
        UUID st1 = UUID.randomUUID(), st2 = UUID.randomUUID();
        for (Object[] s : new Object[][] {{st1, "Werk Ahrenberg", "AHR"}, {st2, "Werk Lindach", "LIN"}}) {
            root.update("INSERT INTO standort (id, tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                    + "VALUES (?, ?, ?, ?, ?, 'Europe/Berlin', 'aktiv')", s[0], tenant, unternehmen, s[1], s[2]);
        }
        UUID rf = root.queryForObject("INSERT INTO energiemanagement_person(tenant_id,name,funktion,actor_sub,actor_name,"
                + "actor_rolle,actor_art) VALUES (?,'Robert Falk','Geschäftsführer','IK','Ines Kaltenbach','energiemanager',"
                + "'kunde') RETURNING id", UUID.class, tenant);
        return new Kunde(tenant, st1, st2, rf);
    }

    private static UUID vermerk(Kunde k, String teil, String satz) {
        return app.queryForObject("INSERT INTO energiemanagement_teil_vermerk(tenant_id,teil,satz,entschieden_von,"
                + "entschieden_am,actor_sub,actor_name,actor_rolle,actor_art) VALUES (?,?,?,?,'2029-04-30','IK',"
                + "'Ines Kaltenbach','energiemanager','kunde') RETURNING id", UUID.class, k.tenant(), teil, satz, k.rf());
    }

    private static void aufheben(UUID vermerk) {
        assertThat(app.update("UPDATE energiemanagement_teil_vermerk SET aufgehoben_am = now(), aufgehoben_sub = 'JW', "
                + "aufgehoben_name = 'Jonas Wendlinger', aufgehoben_rolle = 'kundenadministrator', aufgehoben_art = 'kunde' "
                + "WHERE id = ?", vermerk)).isOne();
    }

    private static List<String> vokabular(JdbcTemplate db) {
        return db.queryForList("SELECT format('%s/%s/%s', vokabular, nr, wort) FROM energiemanagement_vokabular()",
                String.class);
    }

    /**
     * Eine Verbindung der App-Rolle mit Zugriff wie `TenantAwareDataSource`: {@code standorte} = null heißt
     * unternehmensweit, sonst der enge Zaun über genau diese Standorte.
     */
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

    /** SQLSTATE und, wo genannt, der Name der Einschränkung in der Meldung. */
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
