package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
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
 * Die Migration {@code V20260912160000} (UEMS AP-07 IP-10, Entscheid E9) gegen eine echte
 * TimescaleDB: die erwartete Kadenz wird ein ZEITGÜLTIGES Feld der Quellenbindung — mit Bestand
 * darunter.
 *
 * <p>Der Prüfnachweis:
 *
 * <ul>
 *   <li><b>Bestand nur bei EINDEUTIGER Herleitung.</b> Wo der Messkanal der Bindung genau EINE
 *       Kadenz in der Mess-Selektion hat, steht sie als Fassung 1 („gilt seit dem Beginn der
 *       Bindung", von VoltPilot, nie rückwirkend); wo zwei Boxen verschiedene Zahlen nennen, wo
 *       eine Zeile gar keine nennt oder wo es keine Auswahlzeile gibt, entsteht KEINE Fassung —
 *       dann bleibt die Ableitung wie heute. Nichts wird geraten.</li>
 *   <li><b>Der Bestand bleibt.</b> Jede Zeile jeder berührten Tabelle ist zeichengleich; an
 *       {@code messstelle_quelle} kommt genau EIN neues Constraint dazu (der zusammengesetzte
 *       Schlüssel, den der Mandanten-Fremdschlüssel braucht) — und sonst nichts.</li>
 *   <li><b>Die Zeitform ist die bekannte</b> — halboffen, auf die Minute, je Bindung nur EINE
 *       Fassung zugleich, nur verkürzt, nie umgeschrieben, nie gelöscht; eine Fassung liegt in
 *       ihrer Bindung.</li>
 *   <li><b>Die Schranken sind die des Drahtvertrags</b> (1 … 86 400 s): eine Zahl, die der Box
 *       nicht zustellbar wäre, entsteht gar nicht erst.</li>
 *   <li>der Mandantenzaun, die Rechte der App-Rolle, die neue Protokoll-Art
 *       {@code kadenz_geaendert} neben allen bisherigen, Löschen und Offboarding.</li>
 * </ul>
 *
 * <p>Beispielquelle ist allein das Referenzunternehmen ({@code uems-referenzunternehmen.json}):
 * MS-01 „Netzbezug Halle 1" liest ihre Wirkleistung aus K-3 mit {@code kadenz_s} 10, MS-11
 * „Spritzguss SG07–SG10" aus K-8.2 mit 60. Die uneindeutigen Fälle laufen in einem neutralen
 * Probe-Kundenbereich, der kein Ahrenberg-Objekt vorgibt.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsQuelleKadenzMigrationTest {

    private static final String DIESE = "20260912160000";
    private static final String DATEI = "V20260912160000__uems_quelle_kadenz.sql";

    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    private static final UUID AHRENBERG = UUID.fromString("4e0d0000-0000-0000-0000-000000000001");
    private static final UUID PROBE = UUID.fromString("4e0d0000-0000-0000-0000-000000000002");

    /** Was die Migration nicht anfassen darf — sie schreibt nur daneben. */
    private static final List<String> BESTAND = List.of("messstelle", "messstelle_quelle",
            "device_measurement_selection", "measurement_point", "geraet", "geraet_komponente", "device", "site");

    private static final ObjectMapper MAPPER = new ObjectMapper();

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
    private static JdbcTemplate admin;

    /** Name → Bindung (messstelle_quelle.id) des Bestands. */
    private static final Map<String, UUID> BINDUNGEN = new LinkedHashMap<>();
    private static final Map<String, UUID> KOMPONENTEN = new LinkedHashMap<>();
    private static final Map<String, Instant> BEGINN = new LinkedHashMap<>();
    private static Map<String, Map<String, String>> bestandVorher;
    private static Map<String, Map<String, String>> bestandNachher;
    private static List<Map<String, Object>> fassungenNachDerMigration;

    @BeforeAll
    static void migriereMitBestand() throws IOException {
        referenz = MAPPER.readTree(V2.resolve("uems-referenzunternehmen.json").toFile());
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));

        flyway().target(letzteFassungVorDieser()).load().migrate();
        saeBestand();
        bestandVorher = schnappschuesse();
        flyway().target(DIESE).load().migrate();
        bestandNachher = schnappschuesse();
        fassungenNachDerMigration = root.queryForList(
                "SELECT * FROM quelle_kadenz ORDER BY gueltig_ab, id");
        // Was nach dieser Fassung noch liegt, läuft auch — die Tests prüfen den Endstand.
        flyway().load().migrate();

        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ---- Der Bestand ---------------------------------------------------------------------

    /**
     * Wo die Kadenz aus der Mess-Selektion EINDEUTIG folgt, steht sie als Fassung 1 — und zwar
     * genau zweimal: MS-01 (10 s, Referenz) und MS-11 (60 s, Referenz). Beide gelten ab dem Beginn
     * IHRER Bindung, offen, von VoltPilot, nie rückwirkend, ohne Begründung.
     */
    @Test
    void dieEindeutigeVorgabeWirdAlsFassungEinsUebernommen() {
        assertThat(fassungenNachDerMigration).hasSize(2);
        pruefeFassungEins("MS-01 Wirkleistung", 10);
        pruefeFassungEins("MS-11 Wirkenergie", 60);
    }

    /**
     * Wo sie NICHT eindeutig folgt, entsteht keine Fassung — nichts wird geraten. Drei
     * Ausprägungen: zwei Boxen mit verschiedenen Kadenzen am selben Messkanal, eine Auswahlzeile
     * ganz ohne Zahl, und gar keine Auswahlzeile.
     */
    @Test
    void wasNichtEindeutigFolgtBekommtKeineFassung() {
        for (String name : List.of("Probe zwei Kadenzen", "Probe ohne Zahl", "Probe ohne Auswahl")) {
            assertThat(fassungenNachDerMigration)
                    .as(name)
                    .noneMatch(f -> BINDUNGEN.get(name).equals(f.get("messstelle_quelle_id")));
        }
        // Zwei Boxen mit DERSELBEN Zahl sind dagegen eindeutig — die eine Zahl zählt, nicht die
        // Zahl der Zeilen. (Hier nur als Gegenprobe der Regel, ohne eigene Bindung.)
        assertThat(root.queryForObject("SELECT count(DISTINCT cadence_s) FROM device_measurement_selection "
                + "WHERE entity_id = ?", Integer.class, KOMPONENTEN.get("Probe zwei Kadenzen"))).isEqualTo(2);
    }

    /** Der Bestand bleibt: jede Zeile zeichengleich, und nur EIN neues Constraint kommt dazu. */
    @Test
    void derBestandBleibtZeichengleichBisAufDenNeuenSchluessel() {
        for (String t : BESTAND) {
            assertThat(bestandNachher.get(t).get("zeilen")).as(t + " Zeilen")
                    .isEqualTo(bestandVorher.get(t).get("zeilen"));
            assertThat(bestandNachher.get(t).get("spalten")).as(t + " Spalten")
                    .isEqualTo(bestandVorher.get(t).get("spalten"));
            assertThat(bestandNachher.get(t).get("rechte")).as(t + " Rechte")
                    .isEqualTo(bestandVorher.get(t).get("rechte"));
            assertThat(bestandNachher.get(t).get("rls")).as(t + " RLS")
                    .isEqualTo(bestandVorher.get(t).get("rls"));
            assertThat(bestandNachher.get(t).get("policies")).as(t + " Policies")
                    .isEqualTo(bestandVorher.get(t).get("policies"));
            if (!"messstelle_quelle".equals(t)) {
                assertThat(bestandNachher.get(t).get("constraints")).as(t + " Constraints")
                        .isEqualTo(bestandVorher.get(t).get("constraints"));
                assertThat(bestandNachher.get(t).get("indexe")).as(t + " Indexe")
                        .isEqualTo(bestandVorher.get(t).get("indexe"));
            }
        }
        assertThat(bestandVorher.get("messstelle_quelle").get("zeilen")).isNotBlank();
        // An der Bindung kommt GENAU der zusammengesetzte Schlüssel dazu (und sein Index).
        assertThat(neueZeilen(bestandVorher.get("messstelle_quelle").get("constraints"),
                bestandNachher.get("messstelle_quelle").get("constraints")))
                .containsExactly("uq_messstelle_quelle_id_tenant:UNIQUE (id, tenant_id)");
        assertThat(neueZeilen(bestandVorher.get("messstelle_quelle").get("indexe"),
                bestandNachher.get("messstelle_quelle").get("indexe"))).hasSize(1);
    }

    @Test
    void einErneuterLaufLegtNichtsAnUndAendertNichts() throws IOException {
        Map<String, String> vorher = schnappschuss("quelle_kadenz");
        assertThat(root.queryForObject("SELECT uems_kadenz_bestand()", Integer.class)).isZero();
        fuehreErneutAus(DATEI);
        assertThat(schnappschuss("quelle_kadenz")).isEqualTo(vorher);
    }

    // ---- Der Zaun ------------------------------------------------------------------------

    @Test
    void derZaunStehtAufDerNeuenTabelle() {
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                + "WHERE relname = 'quelle_kadenz'", Boolean.class)).isTrue();
        assertThat(anzahl("SELECT count(*) FROM pg_policies WHERE tablename = 'quelle_kadenz'")).isOne();
        assertThat(app.queryForObject("SELECT count(*) FROM quelle_kadenz", Long.class)).isZero();
        assertThat(als(AHRENBERG, () -> app.queryForObject("SELECT count(*) FROM quelle_kadenz", Long.class)))
                .isEqualTo(2L);
        assertThat(als(PROBE, () -> app.queryForObject("SELECT count(*) FROM quelle_kadenz", Long.class)))
                .isZero();

        // Die Policy hat USING UND WITH CHECK — lesen wie schreiben hängen am Mandanten.
        Map<String, Object> policy = root.queryForMap("SELECT qual, with_check FROM pg_policies "
                + "WHERE tablename = 'quelle_kadenz'");
        assertThat((String) policy.get("qual")).contains("app.tenant_id");
        assertThat((String) policy.get("with_check")).contains("app.tenant_id");

        // Eine Fassung an einer FREMDEN Bindung schreibt die App-Rolle nicht — und sie erfährt
        // dabei nichts über den anderen Kundenbereich: die Bindung „gibt es nicht" (nie 403).
        for (UUID wer : List.of(PROBE, AHRENBERG)) {
            PSQLException p = ablehnung(() -> alsTue(PROBE, () -> app.update(
                    "INSERT INTO quelle_kadenz (tenant_id, messstelle_quelle_id, erwartet_s, herkunft, "
                            + "gueltig_ab, rueckwirkend, actor_sub, actor_name, actor_art) VALUES "
                            + "(?, ?, 30, 'eintrag', ?, false, 's', 'n', 'kunde')", wer,
                    BINDUNGEN.get("MS-01 Wirkleistung"), ts("2027-03-01T00:00:00Z"))));
            assertThat((Object) p).as("fremde Bindung " + wer).isNotNull();
            assertThat(p.getServerErrorMessage().getConstraint()).isEqualTo("quelle_kadenz_bindung_da");
            assertThat(p.getMessage()).contains("gibt es nicht");
        }

        // Der Fremdschlüssel trägt den Mandanten mit und räumt mit der Bindung ab.
        assertThat(root.queryForObject("SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                + "WHERE conname = 'quelle_kadenz_bindung_fk'", String.class))
                .isEqualTo("FOREIGN KEY (messstelle_quelle_id, tenant_id) "
                        + "REFERENCES messstelle_quelle(id, tenant_id) ON DELETE CASCADE");
    }

    @Test
    void dieRechteDerAppRolle() {
        assertThat(root.queryForObject("SELECT coalesce(string_agg(privilege_type, ',' ORDER BY privilege_type), '') "
                + "FROM information_schema.role_table_grants WHERE table_name = 'quelle_kadenz' AND grantee = ?",
                String.class, APP_USER)).isEqualTo("INSERT,SELECT");
        assertThat(root.queryForList("SELECT column_name FROM information_schema.column_privileges "
                + "WHERE table_name = 'quelle_kadenz' AND grantee = ? AND privilege_type = 'UPDATE'",
                String.class, APP_USER)).containsExactly("gueltig_bis");
    }

    // ---- Die Constraints -----------------------------------------------------------------

    /**
     * Die Datenbank hält die Zeitregeln und die Draht-Schranken fest, auch ohne die Schnittstelle.
     */
    @Test
    void dieChecksLehnenAbStattZuRunden() {
        Werkstatt w = new Werkstatt("Werkstatt Checks");
        UUID b = w.bindung("2026-01-01T00:00:00Z", null);

        // Berühren ist erlaubt …
        w.fassung(b, 60, "2026-01-01T00:00:00Z", "2027-01-15T08:00:00Z");
        w.fassung(b, 10, "2027-01-15T08:00:00Z", "2027-05-01T00:00:00Z");
        // … überschneiden nie, auch nicht um eine Minute.
        abgelehnt("23P01", "quelle_kadenz_eine_je_zeitpunkt",
                () -> w.fassung(b, 30, "2027-01-15T07:59:00Z", "2027-01-15T08:01:00Z"));

        abgelehnt("23514", "quelle_kadenz_erwartet_chk", () -> w.fassung(b, 0, "2027-06-01T00:00:00Z", null));
        abgelehnt("23514", "quelle_kadenz_erwartet_chk", () -> w.fassung(b, 86401, "2027-06-01T00:00:00Z", null));
        assertThat(w.fassung(b, 86400, "2027-06-01T00:00:00Z", "2027-06-02T00:00:00Z")).isNotNull();

        abgelehnt("23514", "quelle_kadenz_volle_minute",
                () -> w.fassung(b, 30, "2027-07-01T00:00:30Z", null));
        abgelehnt("23514", "quelle_kadenz_nicht_leer",
                () -> w.fassung(b, 30, "2027-07-01T00:00:00Z", "2027-07-01T00:00:00Z"));
        abgelehnt("23514", "quelle_kadenz_herkunft_chk", () -> root.update(
                "INSERT INTO quelle_kadenz (tenant_id, messstelle_quelle_id, erwartet_s, herkunft, gueltig_ab, "
                        + "rueckwirkend, actor_sub, actor_name, actor_art) VALUES (?, ?, 30, 'geraten', ?, false, "
                        + "'s', 'n', 'kunde')", w.tenant, b, ts("2027-08-01T00:00:00Z")));
        abgelehnt("23514", "quelle_kadenz_bestand_chk", () -> root.update(
                "INSERT INTO quelle_kadenz (tenant_id, messstelle_quelle_id, erwartet_s, herkunft, gueltig_ab, "
                        + "rueckwirkend, actor_sub, actor_name, actor_art) VALUES (?, ?, 30, 'bestand', ?, false, "
                        + "'jemand', 'Jemand', 'kunde')", w.tenant, b, ts("2027-08-01T00:00:00Z")));
        abgelehnt("23514", "quelle_kadenz_rueckwirkend_chk", () -> root.update(
                "INSERT INTO quelle_kadenz (tenant_id, messstelle_quelle_id, erwartet_s, herkunft, gueltig_ab, "
                        + "rueckwirkend, actor_sub, actor_name, actor_art, eingetragen_am) VALUES (?, ?, 30, "
                        + "'eintrag', ?, true, 's', 'n', 'kunde', ?)", w.tenant, b, ts("2027-09-01T00:00:00Z"),
                ts("2027-08-01T00:00:00Z")));
    }

    /** Eine Fassung liegt IN ihrer Bindung — nie davor, nie zum oder nach ihrem Ende. */
    @Test
    void eineFassungLiegtInIhrerBindung() {
        Werkstatt w = new Werkstatt("Werkstatt Bindung");
        UUID offen = w.bindung("2026-05-01T00:00:00Z", null);
        UUID beendet = w.bindung("2026-05-01T00:00:00Z", "2026-09-01T00:00:00Z");

        abgelehnt("23514", "quelle_kadenz_vor_beginn",
                () -> w.fassung(offen, 30, "2026-04-30T23:59:00Z", null));
        assertThat(w.fassung(offen, 30, "2026-05-01T00:00:00Z", null)).isNotNull();
        abgelehnt("23514", "quelle_kadenz_nach_ende",
                () -> w.fassung(beendet, 30, "2026-09-01T00:00:00Z", null));
        assertThat(w.fassung(beendet, 30, "2026-08-31T23:59:00Z", null)).isNotNull();
    }

    /**
     * Eine Fassung wird nur verkürzt: die App-Rolle darf allein {@code gueltig_bis} setzen, nie
     * löschen; der Trigger lässt es nur früher werden und schreibt keiner Rolle einen Wert um.
     */
    @Test
    void eineFassungWirdNurVerkuerztNieVerlaengertNieUmgeschriebenNieGeloescht() {
        Werkstatt w = new Werkstatt("Werkstatt Verkürzen");
        UUID b = w.bindung("2026-01-01T00:00:00Z", null);
        UUID f = w.fassung(b, 60, "2026-01-01T00:00:00Z", "2027-02-01T00:00:00Z");

        assertThat(als(w.tenant, () -> app.update("UPDATE quelle_kadenz SET gueltig_bis = ? WHERE id = ?",
                ts("2027-01-15T08:00:00Z"), f))).isOne();
        abgelehnt("23514", "quelle_kadenz_nur_verkuerzen", () -> alsTue(w.tenant, () -> app.update(
                "UPDATE quelle_kadenz SET gueltig_bis = ? WHERE id = ?", ts("2027-03-01T00:00:00Z"), f)));
        abgelehnt("23514", "quelle_kadenz_nur_verkuerzen", () -> alsTue(w.tenant, () -> app.update(
                "UPDATE quelle_kadenz SET gueltig_bis = NULL WHERE id = ?", f)));
        abgelehntWegen("42501", "permission denied", () -> alsTue(w.tenant, () -> app.update(
                "UPDATE quelle_kadenz SET erwartet_s = 10 WHERE id = ?", f)));
        abgelehntWegen("42501", "permission denied", () -> alsTue(w.tenant, () -> app.update(
                "DELETE FROM quelle_kadenz WHERE id = ?", f)));
        // Auch eine Rolle mit vollem Recht schreibt keinen Wert um.
        abgelehnt("23514", "quelle_kadenz_unveraenderlich", () -> admin.update(
                "UPDATE quelle_kadenz SET erwartet_s = 10 WHERE id = ?", f));
        assertThat(root.queryForObject("SELECT erwartet_s FROM quelle_kadenz WHERE id = ?", Integer.class, f))
                .isEqualTo(60);
    }

    /** Das Protokoll der Messstelle kennt die neue Art — und alle des Stands davor bleiben. */
    @Test
    void dasProtokollKenntDieNeueArtUndAlleBisherigen() {
        Werkstatt w = new Werkstatt("Werkstatt Protokoll");
        alsTue(w.tenant, () -> {
            for (String art : List.of("kadenz_geaendert", "zaehler_gewechselt", "einstellung_geaendert",
                    "quelle_gebunden", "quelle_beendet", "angelegt", "bearbeitet", "angehalten", "fortgesetzt",
                    "archiviert", "nebengroesse_hinzugefuegt", "nebengroesse_archiviert", "ort_zugeordnet",
                    "ort_korrigiert", "stellung_zugeordnet", "stellung_korrigiert")) {
                assertThat(app.update("INSERT INTO messstelle_aenderung (tenant_id, messstelle_id, art, gilt_ab, "
                        + "rueckwirkend, actor_sub, actor_name, actor_art) VALUES (?, ?, ?, ?, false, 'sub', "
                        + "'Probe', 'kunde')", w.tenant, w.messstelle, art, ts("2027-01-15T08:00:00Z")))
                        .as(art).isOne();
            }
            abgelehnt("23514", "messstelle_aenderung_art_chk", () -> app.update(
                    "INSERT INTO messstelle_aenderung (tenant_id, messstelle_id, art, gilt_ab, rueckwirkend, "
                            + "actor_sub, actor_name, actor_art) VALUES (?, ?, 'kadenz_geraten', ?, false, 'sub', "
                            + "'Probe', 'kunde')", w.tenant, w.messstelle, ts("2027-01-15T08:00:00Z")));
        });
    }

    // ---- Löschen und Offboarding ---------------------------------------------------------

    @Test
    void mitDerKomponenteGehtDieBindungUndMitIhrDieFassung() {
        Werkstatt w = new Werkstatt("Werkstatt Löschen");
        UUID b = w.bindung("2026-01-01T00:00:00Z", null);
        w.fassung(b, 60, "2026-01-01T00:00:00Z", null);
        assertThat(anzahl("SELECT count(*) FROM quelle_kadenz WHERE tenant_id = ?", w.tenant)).isOne();

        assertThat(als(w.tenant, () -> app.update("DELETE FROM measurement_point WHERE id = ?", w.komponente)))
                .isOne();
        assertThat(anzahl("SELECT count(*) FROM messstelle_quelle WHERE id = ?", b)).isZero();
        assertThat(anzahl("SELECT count(*) FROM quelle_kadenz WHERE tenant_id = ?", w.tenant)).isZero();
    }

    @Test
    void ohneOffboardingVerweigertDieDatenbankUndDasOffboardingRaeumtAusdruecklichAb() {
        Werkstatt w = new Werkstatt("Werkstatt Offboarding");
        w.fassung(w.bindung("2026-01-01T00:00:00Z", null), 60, "2026-01-01T00:00:00Z", null);

        abgelehnt("23503", null, () -> root.update("DELETE FROM tenant WHERE id = ?", w.tenant));

        new TenantRepository(admin).offboard(w.tenant);
        assertThat(anzahl("SELECT count(*) FROM tenant WHERE id = ?", w.tenant)).isZero();
        assertThat(anzahl("SELECT count(*) FROM quelle_kadenz WHERE tenant_id = ?", w.tenant)).isZero();
    }

    // ---- Gerüst: der Bestand ----------------------------------------------------------------

    private static void pruefeFassungEins(String bindung, int erwartet) {
        Map<String, Object> f = fassungenNachDerMigration.stream()
                .filter(z -> BINDUNGEN.get(bindung).equals(z.get("messstelle_quelle_id")))
                .findFirst().orElseThrow(() -> new AssertionError("keine Fassung für " + bindung));
        assertThat(f.get("erwartet_s")).as(bindung).isEqualTo(erwartet);
        assertThat(f.get("herkunft")).isEqualTo("bestand");
        assertThat(((Timestamp) f.get("gueltig_ab")).toInstant()).isEqualTo(BEGINN.get(bindung));
        assertThat(f.get("gueltig_bis")).isNull();
        assertThat(f.get("rueckwirkend")).isEqualTo(false);
        assertThat(f.get("actor_sub")).isNull();
        assertThat(f.get("actor_art")).isEqualTo("voltpilot");
        assertThat(f.get("actor_name")).isEqualTo("VoltPilot");
        assertThat(f.get("begruendung")).isNull();
        assertThat(f.get("tenant_id")).isEqualTo(AHRENBERG);
    }

    private static void saeBestand() {
        root.update("INSERT INTO tenant (id, name) VALUES (?, ?)", AHRENBERG,
                referenz.at("/unternehmen/name").asText());
        JsonNode an1 = element(referenz.get("anlagen"), "AN-1");
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, AHRENBERG, an1.get("name").asText(),
                OffsetDateTime.parse(an1.get("seit").asText()));
        UUID box = box(AHRENBERG, site, element(referenz.get("boxen"), "E-1").get("seriennummer").asText());

        // MS-01 „Netzbezug Halle 1" ← K-3 (Wirkleistung, 10 s laut Referenz), EINE Auswahlzeile.
        UUID k3 = komponente(AHRENBERG, site, box, "K-3", "grid-meter");
        UUID ms01 = messstelle(AHRENBERG, "MS-0001", "Netzbezug Halle 1", "Wirkleistung", "Bezug", "kW",
                "Momentanwert");
        auswahl(AHRENBERG, site, box, k3, "power_kw", kadenzAusDerReferenz("MS-01"));
        bindung("MS-01 Wirkleistung", AHRENBERG, ms01, "Wirkleistung", "Bezug", k3, "power_kw", "gauge",
                "momentanwert", "2024-03-12T00:00:00Z", null);

        // MS-11 „Spritzguss SG07–SG10" ← K-8.2 (60 s laut Referenz), ZWEI Auswahlzeilen mit
        // DERSELBEN Zahl (zwei Boxen lesen denselben Messkanal) — das bleibt eindeutig.
        UUID box2 = box(AHRENBERG, site, "VP-BOX-AHRENBERG-0002");
        UUID k82 = komponente(AHRENBERG, site, box, "K-8.2", "consumer");
        UUID ms11 = messstelle(AHRENBERG, "MS-0011", "Spritzguss SG07-SG10", "Wirkenergie", "Bezug", "kWh",
                "Zählerstand");
        auswahl(AHRENBERG, site, box, k82, "energy_import_kwh", kadenzAusDerReferenz("MS-11"));
        auswahl(AHRENBERG, site, box2, k82, "energy_import_kwh", kadenzAusDerReferenz("MS-11"));
        bindung("MS-11 Wirkenergie", AHRENBERG, ms11, "Wirkenergie", "Bezug", k82, "energy_import_kwh",
                "counter", "zaehlerstand", "2026-10-01T00:00:00Z", null);

        // Der neutrale Probe-Bereich mit den UNEINDEUTIGEN Fällen.
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kundenbereich Probe')", PROBE);
        UUID ps = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Probe') RETURNING id",
                UUID.class, PROBE);
        UUID pb1 = box(PROBE, ps, "VP-BOX-KADENZ-0001");
        UUID pb2 = box(PROBE, ps, "VP-BOX-KADENZ-0002");

        UUID pk1 = komponente(PROBE, ps, pb1, "Probe zwei Kadenzen", "grid-meter");
        UUID pm1 = messstelle(PROBE, "MS-0001", "Probe zwei Kadenzen", "Wirkleistung", "Bezug", "kW",
                "Momentanwert");
        auswahl(PROBE, ps, pb1, pk1, "power_kw", 10);
        auswahl(PROBE, ps, pb2, pk1, "power_kw", 60);
        bindung("Probe zwei Kadenzen", PROBE, pm1, "Wirkleistung", "Bezug", pk1, "power_kw", "gauge",
                "momentanwert", "2026-01-01T00:00:00Z", null);

        UUID pk2 = komponente(PROBE, ps, pb1, "Probe ohne Zahl", "grid-meter");
        UUID pm2 = messstelle(PROBE, "MS-0002", "Probe ohne Zahl", "Wirkleistung", "Bezug", "kW",
                "Momentanwert");
        auswahl(PROBE, ps, pb1, pk2, "power_kw", null);
        bindung("Probe ohne Zahl", PROBE, pm2, "Wirkleistung", "Bezug", pk2, "power_kw", "gauge",
                "momentanwert", "2026-01-01T00:00:00Z", null);

        UUID pk3 = komponente(PROBE, ps, pb1, "Probe ohne Auswahl", "grid-meter");
        UUID pm3 = messstelle(PROBE, "MS-0003", "Probe ohne Auswahl", "Wirkleistung", "Bezug", "kW",
                "Momentanwert");
        bindung("Probe ohne Auswahl", PROBE, pm3, "Wirkleistung", "Bezug", pk3, "power_kw", "gauge",
                "momentanwert", "2026-01-01T00:00:00Z", null);
    }

    private static int kadenzAusDerReferenz(String kennzeichen) {
        return element(referenz.get("messstellen"), kennzeichen).get("kadenz_s").asInt();
    }

    private static UUID box(UUID tenant, UUID site, String ref) {
        return root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, tenant, site, ref);
    }

    private static UUID komponente(UUID tenant, UUID site, UUID box, String name, String art) {
        UUID id = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, communication, connection_json, created_at) VALUES "
                + "(?, ?, ?, ?, ?, ?, 'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, ?) RETURNING id",
                UUID.class, tenant, site, art, name, art, box, ts("2024-03-12T00:00:00Z"));
        KOMPONENTEN.put(name, id);
        return id;
    }

    private static UUID messstelle(UUID tenant, String kennzeichen, String name, String groesse, String richtung,
            String einheit, String wertart) {
        return root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', ?, ?, ?, ?) RETURNING id",
                UUID.class, tenant, kennzeichen, name, groesse, richtung, einheit, wertart);
    }

    private static void auswahl(UUID tenant, UUID site, UUID box, UUID komponente, String kanal, Integer kadenz) {
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, ?, 1, now(), '2026.09.11.1', "
                + "'test', 'pending_edge', 'live_power', 'fifteen_minute')",
                tenant, site, box, komponente, kanal, kadenz);
    }

    private static void bindung(String name, UUID tenant, UUID messstelle, String groesse, String richtung,
            UUID komponente, String kanal, String wertart, String herleitung, String ab, String bis) {
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, komponente);
        UUID id = root.queryForObject("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, "
                + "entity_id, geraet_id, kanal, kanal_wertart, herleitung, rolle, gueltig_ab, gueltig_bis, "
                + "rueckwirkend, eingetragen_am, actor_sub, actor_name, actor_art) VALUES "
                + "(?, ?, ?, ?, ?, ?, ?, ?, ?, 'fuehrend', ?, ?, false, now(), 'sub', 'Probe', 'kunde') RETURNING id",
                UUID.class, tenant, messstelle, groesse, richtung, komponente, geraet, kanal, wertart, herleitung,
                ts(ab), bis == null ? null : ts(bis));
        BINDUNGEN.put(name, id);
        BEGINN.put(name, Instant.parse(ab));
    }

    /** Ein eigener Kundenbereich je verändernder Test — er berührt den Bestand nicht. */
    private static final class Werkstatt {
        final UUID tenant;
        final UUID site;
        final UUID box;
        final UUID komponente;
        final UUID messstelle;
        private int laufend;

        Werkstatt(String name) {
            tenant = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
            site = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, ?) RETURNING id",
                    UUID.class, tenant, name);
            box = box(tenant, site, "VP-" + tenant.toString().substring(0, 8));
            komponente = komponente(tenant, site, box, name, "grid-meter");
            messstelle = messstelle(tenant, kennzeichen(), name, "Wirkleistung", "Bezug", "kW", "Momentanwert");
        }

        private String kennzeichen() {
            return String.format("MS-%04d", ++laufend);
        }

        /**
         * Je Bindung eine EIGENE Messstelle und ein eigener Kanal: je Größe führt zu jedem
         * Zeitpunkt nur eine Bindung, und ein Messwert speist nur eine Messstelle führend
         * (V20260911250000) — das sind die Regeln der Bindung, nicht dieses Pakets.
         */
        UUID bindung(String ab, String bis) {
            UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                    + "AND gueltig_bis IS NULL", UUID.class, komponente);
            int n = laufend;
            UUID ms = messstelle(tenant, kennzeichen(), "Bindung " + n, "Wirkleistung", "Bezug", "kW",
                    "Momentanwert");
            return root.queryForObject("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, "
                    + "entity_id, geraet_id, kanal, kanal_wertart, herleitung, rolle, gueltig_ab, gueltig_bis, "
                    + "rueckwirkend, eingetragen_am, actor_sub, actor_name, actor_art) VALUES "
                    + "(?, ?, 'Wirkleistung', 'Bezug', ?, ?, ?, 'gauge', 'momentanwert', 'fuehrend', ?, ?, false, "
                    + "now(), 'sub', 'Probe', 'kunde') RETURNING id", UUID.class, tenant, ms, komponente,
                    geraet, "power_kw_" + n, ts(ab), bis == null ? null : ts(bis));
        }

        UUID fassung(UUID bindung, int erwartetS, String ab, String bis) {
            return root.queryForObject("INSERT INTO quelle_kadenz (tenant_id, messstelle_quelle_id, erwartet_s, "
                    + "herkunft, gueltig_ab, gueltig_bis, rueckwirkend, actor_sub, actor_name, actor_art) VALUES "
                    + "(?, ?, ?, 'eintrag', ?, ?, false, 'sub', 'Probe', 'kunde') RETURNING id", UUID.class,
                    tenant, bindung, erwartetS, ts(ab), bis == null ? null : ts(bis));
        }
    }

    private static JsonNode element(JsonNode liste, String kennzeichen) {
        for (JsonNode e : liste) {
            if (kennzeichen.equals(e.path("kennzeichen").asText())) {
                return e;
            }
        }
        throw new AssertionError("nicht in der Referenzdatei: " + kennzeichen);
    }

    private static List<String> neueZeilen(String vorher, String nachher) {
        List<String> alt = List.of(vorher.split("\n"));
        return Arrays.stream(nachher.split("\n")).filter(z -> !alt.contains(z)).toList();
    }

    private static Timestamp ts(String iso) {
        return Timestamp.from(Instant.parse(iso));
    }

    private static long anzahl(String sql, Object... args) {
        return root.queryForObject(sql, Long.class, args);
    }

    // ---- Gerüst: der Schnappschuss einer Tabelle --------------------------------------------

    private static Map<String, Map<String, String>> schnappschuesse() {
        Map<String, Map<String, String>> m = new LinkedHashMap<>();
        for (String t : BESTAND) {
            m.put(t, schnappschuss(t));
        }
        return m;
    }

    private static Map<String, String> schnappschuss(String tabelle) {
        Map<String, String> s = new LinkedHashMap<>();
        s.put("spalten", root.queryForObject("SELECT string_agg(format('%s|%s|%s|%s|%s', column_name, "
                + "data_type, is_nullable, column_default, ordinal_position), E'\\n' ORDER BY ordinal_position) "
                + "FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?",
                String.class, tabelle));
        s.put("zeilen", root.queryForObject("SELECT coalesce(string_agg(z, E'\\n' ORDER BY z), '') FROM "
                + "(SELECT to_jsonb(t)::text AS z FROM " + tabelle + " t) AS zeilen", String.class));
        s.put("constraints", root.queryForObject("SELECT coalesce(string_agg(conname || ':' || "
                + "pg_get_constraintdef(oid), E'\\n' ORDER BY conname), '') FROM pg_constraint "
                + "WHERE conrelid = ?::regclass", String.class, tabelle));
        s.put("indexe", root.queryForObject("SELECT coalesce(string_agg(indexdef, E'\\n' ORDER BY indexname), '') "
                + "FROM pg_indexes WHERE schemaname = 'public' AND tablename = ?", String.class, tabelle));
        s.put("policies", root.queryForObject("SELECT coalesce(string_agg(policyname || ':' || "
                + "coalesce(qual, '') || ':' || coalesce(with_check, ''), E'\\n' ORDER BY policyname), '') "
                + "FROM pg_policies WHERE tablename = ?", String.class, tabelle));
        s.put("rls", root.queryForObject("SELECT relrowsecurity || '/' || relforcerowsecurity FROM pg_class "
                + "WHERE oid = ?::regclass", String.class, tabelle));
        s.put("rechte", root.queryForObject("SELECT coalesce(string_agg(grantee || ':' || privilege_type, ',' "
                + "ORDER BY grantee, privilege_type), '') FROM information_schema.role_table_grants "
                + "WHERE table_schema = 'public' AND table_name = ?", String.class, tabelle));
        return s;
    }

    // ---- Gerüst: Zaun und Ablehnungen --------------------------------------------------------

    private static <T> T als(UUID tenant, Supplier<T> arbeit) {
        UUID vorher = TenantContext.get();
        TenantContext.set(tenant);
        try {
            return arbeit.get();
        } finally {
            if (vorher == null) {
                TenantContext.clear();
            } else {
                TenantContext.set(vorher);
            }
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

    // ---- Gerüst: Flyway ------------------------------------------------------------------

    private static String letzteFassungVorDieser() {
        MigrationVersion diese = MigrationVersion.fromVersion(DIESE);
        return Arrays.stream(flyway().load().info().all())
                .map(MigrationInfo::getVersion)
                .filter(v -> v != null && v.compareTo(diese) < 0)
                .max(Comparator.naturalOrder())
                .orElseThrow()
                .getVersion();
    }

    private static void fuehreErneutAus(String datei) throws IOException {
        String sql;
        try (InputStream in = UemsQuelleKadenzMigrationTest.class.getResourceAsStream("/db/migration/" + datei)) {
            sql = new String(Objects.requireNonNull(in, datei).readAllBytes(), StandardCharsets.UTF_8);
        }
        root.execute(sql.replace("${appDbUser}", APP_USER).replace("${adminDbUser}", ADMIN_USER));
    }

    private static FluentConfiguration flyway() {
        return Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of(
                        "appDbUser", APP_USER, "appDbPassword", APP_PW,
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
