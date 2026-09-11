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
import java.time.LocalDate;
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
 * Die Migration der BESTANDSÜBERNAHME (UEMS AP-02 IP-9, V20260911290000) an der echten
 * Datenbank: die Vorschlagszeilen ({@code standort_vorschlag}) mit Zaun, Rechten und
 * CHECKs — und die eine Änderung an {@code anlage_standort}, die das Anlagen-Löschen
 * unverändert lässt (W5): der Fremdschlüssel auf {@code site} fällt, seine EINFÜGE-Hälfte
 * bleibt als Trigger mit derselben Ablehnung.
 *
 * <p>Beispielquelle ist allein das Referenzunternehmen
 * ({@code docs/contracts/v2/uems-referenzunternehmen.json}); die Regel selbst prüft
 * {@link OrtsbaumAbleitungVectorsTest} (Familie {@code bestandsuebernahme}), den Dienst
 * {@code BestandsuebernahmeApiTest}.
 *
 * <p>Vorbild: {@link UemsStandortMigrationTest} — bis zur Fassung davor migrieren, den
 * Bestand säen, dann diese Fassung laufen lassen.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsStandortVorschlagMigrationTest {

    private static final String DIESE = "20260911290000";
    private static final String DATEI = "V20260911290000__uems_standort_vorschlag.sql";

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    private static final Path REFERENZ =
            Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final UUID AHRENBERG = UUID.fromString("4e000000-0000-0000-0000-00000000ab01");
    private static final UUID FREMD = UUID.fromString("4e000000-0000-0000-0000-00000000ab02");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static JdbcTemplate admin;
    private static StandortVorschlagRepository vorschlaege;
    private static AnlageStandortRepository zuordnungen;

    private static JsonNode referenz;
    private static Map<String, String> bestandVorher;
    private static Map<String, String> bestandNachher;
    private static long vorschlaegeNachDerMigration;

    /** Die Anlagen des Referenzunternehmens je Kennzeichen (AN-1 …). */
    private static Map<String, UUID> anlagen = new LinkedHashMap<>();
    private static UUID standortAhrenberg;
    private static UUID fremdeAnlage;

    @BeforeAll
    static void migriereMitBestand() throws IOException {
        referenz = MAPPER.readTree(REFERENZ.toFile());
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));

        flyway().target(letzteFassungVorDieser()).load().migrate();
        saeBestand();
        bestandVorher = schnappschuss();

        flyway().target(DIESE).load().migrate();
        bestandNachher = schnappschuss();
        vorschlaegeNachDerMigration =
                root.queryForObject("SELECT count(*) FROM standort_vorschlag", Long.class);

        flyway().load().migrate();

        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        vorschlaege = new StandortVorschlagRepository(app);
        zuordnungen = new AnlageStandortRepository(app);
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ---- (a) die Migration legt nichts an und ändert keinen Bestand ----------

    /**
     * Die Migration legt KEINE Zeile an — die Regel lebt in Java und läuft beim Start
     * ({@code BestandsuebernahmeLaeufer}); und der Bestand bleibt zeichengleich.
     */
    @Test
    void dieMigrationLegtKeineZeileAnUndLaesstDenBestandZeichengleich() {
        assertThat(vorschlaegeNachDerMigration).isZero();
        // Die Schnappschüsse sind nicht leer: der Bestand steht darin.
        assertThat(bestandVorher.get("site"))
                .contains(referenz.at("/anlagen/0/name").asText());
        assertThat(bestandVorher.get("anlage_standort")).isNotBlank();
        for (String t : List.of("tenant", "site", "unternehmen", "standort", "anlage_standort",
                "ort_aenderung")) {
            assertThat(bestandNachher.get(t)).as(t).isEqualTo(bestandVorher.get(t));
        }
    }

    // ---- (b) der Mandantenzaun (A14) ----------------------------------------

    @Test
    void a14DerZaunStehtAufDerNeuenTabelle() {
        alsTue(AHRENBERG, () -> vorschlaege.anlegen(AHRENBERG, anlagen.get("AN-1"),
                referenz.at("/anlagen/0/name").asText(), "Europe/Berlin", LocalDate.parse("2024-03-12")));
        alsTue(FREMD, () -> vorschlaege.anlegen(FREMD, fremdeAnlage, "Anlage des fremden Kundenbereichs",
                "Europe/Berlin", LocalDate.parse("2026-10-01")));

        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                + "WHERE relname = 'standort_vorschlag'", Boolean.class)).isTrue();
        assertThat(anzahl("SELECT count(*) FROM pg_policies WHERE tablename = 'standort_vorschlag' "
                + "AND qual LIKE '%app.tenant_id%' AND with_check LIKE '%app.tenant_id%'")).isOne();
        // Es gibt Zeilen auf beiden Seiten — sonst bewiese „0 Zeilen" nichts.
        assertThat(anzahl("SELECT count(DISTINCT tenant_id) FROM standort_vorschlag"))
                .isGreaterThanOrEqualTo(2);
        // Ohne app.tenant_id: null Zeilen (default-deny).
        assertThat(app.queryForObject("SELECT count(*) FROM standort_vorschlag", Long.class)).isZero();
        // Mit Mandant: nur die eigenen.
        alsTue(FREMD, () -> {
            assertThat(vorschlaege.alle()).extracting(StandortVorschlagRepository.Vorschlag::siteId)
                    .containsExactly(fremdeAnlage);
            assertThat(app.queryForObject("SELECT count(*) FROM standort_vorschlag WHERE tenant_id <> ?",
                    Long.class, FREMD)).isZero();
        });
        // Über den Zaun schreiben: die Policy (WITH CHECK) lehnt ab …
        abgelehntWegen("42501", "row-level security", () -> alsTue(FREMD, () -> vorschlaege.anlegen(
                AHRENBERG, anlagen.get("AN-2"), "Werk Ahrenberg – Halle 2", "Europe/Berlin",
                LocalDate.parse("2026-10-01"))));
        // … und der zusammengesetzte Fremdschlüssel, der ohne RLS prüft, lässt keine
        // Anlage eines fremden Kundenbereichs zu.
        abgelehnt("23503", "standort_vorschlag_site_fk", () -> alsTue(FREMD, () -> vorschlaege.anlegen(
                FREMD, anlagen.get("AN-2"), "Werk Ahrenberg – Halle 2", "Europe/Berlin",
                LocalDate.parse("2026-10-01"))));
    }

    // ---- (c) Rechte und Regeln der Vorschlagszeile ---------------------------

    @Test
    void dieAppRolleLiestUndLegtAnUndSchreibtNieUmUndLoeschtNie() {
        alsTue(AHRENBERG, () -> {
            abgelehntWegen("42501", "permission denied",
                    () -> app.update("UPDATE standort_vorschlag SET name = 'X'"));
            abgelehntWegen("42501", "permission denied",
                    () -> app.update("DELETE FROM standort_vorschlag"));
        });
    }

    @Test
    void jeAnlageHoechstensEinVorschlagUndDieRegelnDerFelder() {
        UUID anlage = neueAnlage(AHRENBERG, "Vorschlags-Probe");
        alsTue(AHRENBERG, () -> {
            assertThat(vorschlaege.anlegen(AHRENBERG, anlage, "Vorschlags-Probe", "Europe/Berlin",
                    LocalDate.parse("2026-09-01"))).isTrue();
            // Ein zweiter Lauf schreibt keinen doppelt und überschreibt keinen.
            assertThat(vorschlaege.anlegen(AHRENBERG, anlage, "Anderer Name", "Europe/Berlin",
                    LocalDate.parse("2026-09-02"))).isFalse();
        });
        assertThat(root.queryForObject("SELECT name FROM standort_vorschlag WHERE site_id = ?",
                String.class, anlage)).isEqualTo("Vorschlags-Probe");

        UUID zweite = neueAnlage(AHRENBERG, "Feld-Probe");
        abgelehnt("23514", "standort_vorschlag_name_chk", () -> alsTue(AHRENBERG,
                () -> vorschlaege.anlegen(AHRENBERG, zweite, "   ", "Europe/Berlin", LocalDate.now())));
        abgelehnt("23514", "standort_vorschlag_name_chk", () -> alsTue(AHRENBERG,
                () -> vorschlaege.anlegen(AHRENBERG, zweite, "x".repeat(121), "Europe/Berlin",
                        LocalDate.now())));
        abgelehnt("23514", "standort_vorschlag_zeitzone_chk", () -> alsTue(AHRENBERG,
                () -> vorschlaege.anlegen(AHRENBERG, zweite, "Feld-Probe", "Europe/London",
                        LocalDate.now())));
    }

    /** Ein Vorschlag hat keine Historie: er geht mit seiner Anlage (CASCADE), nie mit dem Mandanten. */
    @Test
    void derVorschlagGehtMitSeinerAnlageUndDasOffboardingRaeumtIhnAb() {
        UUID t = neuerMandant("Vorschlag-Offboarding");
        UUID a = neueAnlage(t, "Anlage A");
        UUID b = neueAnlage(t, "Anlage B");
        alsTue(t, () -> {
            vorschlaege.anlegen(t, a, "Anlage A", "Europe/Berlin", LocalDate.parse("2026-01-01"));
            vorschlaege.anlegen(t, b, "Anlage B", "Europe/Berlin", LocalDate.parse("2026-01-02"));
        });

        assertThat(root.update("DELETE FROM site WHERE id = ?", a)).isOne();
        assertThat(anzahl("SELECT count(*) FROM standort_vorschlag WHERE tenant_id = ?", t)).isOne();
        // Nie Kaskade vom Mandanten: das Offboarding ist der eine Weg.
        abgelehnt("23503", null, () -> root.update("DELETE FROM tenant WHERE id = ?", t));
        new TenantRepository(admin).offboard(t);
        assertThat(anzahl("SELECT count(*) FROM standort_vorschlag WHERE tenant_id = ?", t)).isZero();
        assertThat(anzahl("SELECT count(*) FROM tenant WHERE id = ?", t)).isZero();
    }

    // ---- (d) W5: die Anlage darf gehen, ihre Zuordnung bleibt ----------------

    /**
     * Der Grabstein an der Datenbankgrenze: kein Fremdschlüssel mehr auf {@code site},
     * die Zeile überlebt die Anlage — und sie behält deren ID, damit der Protokolleintrag
     * und das Intervall dasselbe Ding meinen.
     */
    @Test
    void w5EineZugeordneteAnlageDarfGehenUndIhreZuordnungBleibt() {
        UUID t = neuerMandant("Grabstein-Probe");
        UUID anlage = neueAnlage(t, "Anlage mit Standort");
        UUID standort = probeStandort(t, "ST-1", "Werk der Grabstein-Probe");
        UUID intervall = als(t, () -> zuordnungen.zuordnen(t, anlage, standort,
                LocalDate.parse("2024-03-12"), null, null));
        alsTue(t, () -> zuordnungen.beenden(intervall, LocalDate.parse("2026-09-11")));

        assertThat(root.update("DELETE FROM site WHERE id = ?", anlage)).isOne();
        Map<String, Object> bleibt = root.queryForMap(
                "SELECT site_id, standort_id, gueltig_ab, gueltig_bis FROM anlage_standort WHERE id = ?",
                intervall);
        assertThat(bleibt.get("site_id")).isEqualTo(anlage);
        assertThat(bleibt.get("standort_id")).isEqualTo(standort);
        assertThat(bleibt.get("gueltig_bis").toString()).isEqualTo("2026-09-11");
        // Der Standort selbst bleibt RESTRICT: er wird archiviert, nie gelöscht.
        abgelehnt("23503", "anlage_standort_standort_fk",
                () -> root.update("DELETE FROM standort WHERE id = ?", standort));
    }

    /**
     * Die EINFÜGE-Hälfte des gefallenen Fremdschlüssels: eine Zuordnung nennt eine Anlage,
     * die es gibt, und zwar eine des EIGENEN Kundenbereichs — mit derselben Ablehnung wie
     * vorher (23503 {@code anlage_standort_site_fk}), damit sie einem fremden Mandanten
     * nichts verrät.
     */
    @Test
    void derTriggerHaeltDieEinfuegeHaelfteDesGefallenenFremdschluessels() {
        assertThat(anzahl("SELECT count(*) FROM pg_constraint WHERE conrelid = 'anlage_standort'::regclass "
                + "AND conname = 'anlage_standort_site_fk'")).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM pg_trigger WHERE tgrelid = "
                + "'anlage_standort'::regclass AND NOT tgisinternal AND tgname = 'anlage_standort_anlage_da'",
                Long.class)).isOne();

        UUID standort = standortAhrenberg;
        // Es gibt sie gar nicht …
        abgelehnt("23503", "anlage_standort_site_fk", () -> alsTue(AHRENBERG, () -> zuordnungen.zuordnen(
                AHRENBERG, UUID.randomUUID(), standort, LocalDate.parse("2026-10-01"), null, null)));
        // … oder sie gehört einem anderen Kundenbereich (unter RLS ist sie nicht da).
        abgelehnt("23503", "anlage_standort_site_fk", () -> alsTue(AHRENBERG, () -> zuordnungen.zuordnen(
                AHRENBERG, fremdeAnlage, standort, LocalDate.parse("2026-10-01"), null, null)));
        // Die eigene geht.
        UUID eigene = neueAnlage(AHRENBERG, "Trigger-Probe");
        UUID iv = als(AHRENBERG, () -> zuordnungen.zuordnen(AHRENBERG, eigene, standort,
                LocalDate.parse("2026-10-01"), null, null));
        assertThat(iv).isNotNull();
    }

    // ---- Gerüst -------------------------------------------------------------

    private static void saeBestand() throws IOException {
        root.update("INSERT INTO tenant (id, name) VALUES (?, ?)", AHRENBERG,
                referenz.at("/unternehmen/name").asText());
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Fremder Kundenbereich')", FREMD);
        for (JsonNode a : referenz.get("anlagen")) {
            anlagen.put(a.get("kennzeichen").asText(), root.queryForObject(
                    "INSERT INTO site (tenant_id, name, created_at) VALUES (?,?,?) RETURNING id",
                    UUID.class, AHRENBERG, a.get("name").asText(),
                    OffsetDateTime.parse(a.get("seit").asText())));
        }
        fremdeAnlage = neueAnlage(FREMD, "Anlage des fremden Kundenbereichs");
        standortAhrenberg = probeStandort(AHRENBERG, "ST-1",
                element(referenz.get("standorte"), "ST-1").get("name").asText());
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?,?,?,?)", AHRENBERG, anlagen.get("AN-1"), standortAhrenberg,
                LocalDate.parse("2024-03-12"));
    }

    private static UUID probeStandort(UUID tenant, String kurzzeichen, String name) {
        // Das Unternehmen legt sonst der Backfill von V20260911100000 an; ein Mandant, der
        // NACH ihm entsteht, bekommt es über TenantRepository.create — hier von Hand.
        UUID u = unternehmenVon(tenant);
        return root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, "
                + "zeitzone, zustand) VALUES (?,?,?,?,'Europe/Berlin','entwurf') RETURNING id",
                UUID.class, tenant, u, name, kurzzeichen);
    }

    private static JsonNode element(JsonNode liste, String kennzeichen) {
        for (JsonNode e : liste) {
            if (kennzeichen.equals(e.get("kennzeichen").asText())) {
                return e;
            }
        }
        throw new AssertionError(kennzeichen + " fehlt in der Datei");
    }

    private static UUID neuerMandant(String name) {
        return root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
    }

    /** Das Unternehmen des Kundenbereichs — angelegt, wenn der Mandant nach dem Backfill entstand. */
    private static UUID unternehmenVon(UUID tenant) {
        List<UUID> da = root.queryForList("SELECT id FROM unternehmen WHERE tenant_id = ?", UUID.class,
                tenant);
        return da.isEmpty()
                ? root.queryForObject("INSERT INTO unternehmen (tenant_id, name) VALUES (?, ?) RETURNING id",
                        UUID.class, tenant, "Unternehmen")
                : da.get(0);
    }

    private static UUID neueAnlage(UUID tenant, String name) {
        return root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, ?) RETURNING id",
                UUID.class, tenant, name);
    }

    private static long anzahl(String sql, Object... args) {
        return root.queryForObject(sql, Long.class, args);
    }

    /** Je Bestandstabelle ihre Zeilen als Text — was diese Migration nicht anfassen darf. */
    private static Map<String, String> schnappschuss() {
        Map<String, String> s = new LinkedHashMap<>();
        for (String t : List.of("tenant", "site", "unternehmen", "standort", "anlage_standort",
                "ort_aenderung")) {
            s.put(t, root.queryForObject("SELECT string_agg(x::text, E'\\n' ORDER BY x::text) FROM "
                    + t + " x", String.class));
        }
        return s;
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

    // ---- Gerüst: Flyway -----------------------------------------------------

    private static String letzteFassungVorDieser() {
        MigrationVersion diese = MigrationVersion.fromVersion(DIESE);
        return Arrays.stream(flyway().load().info().all())
                .map(MigrationInfo::getVersion)
                .filter(v -> v != null && v.compareTo(diese) < 0)
                .max(Comparator.naturalOrder())
                .orElseThrow()
                .getVersion();
    }

    /** Dieselbe Datei noch einmal, wie Flyway sie ausführt — sie ist wiederholbar. */
    @Test
    void einErneuterLaufAendertNichts() throws IOException {
        String sql;
        try (InputStream in = UemsStandortVorschlagMigrationTest.class
                .getResourceAsStream("/db/migration/" + DATEI)) {
            sql = new String(Objects.requireNonNull(in, DATEI).readAllBytes(), StandardCharsets.UTF_8);
        }
        long vorher = anzahl("SELECT count(*) FROM standort_vorschlag");
        root.execute(sql.replace("${appDbUser}", APP_USER).replace("${adminDbUser}", ADMIN_USER));
        assertThat(anzahl("SELECT count(*) FROM standort_vorschlag")).isEqualTo(vorher);
        assertThat(anzahl("SELECT count(*) FROM pg_constraint WHERE conrelid = 'anlage_standort'::regclass "
                + "AND conname = 'anlage_standort_site_fk'")).isZero();
        assertThat(anzahl("SELECT count(*) FROM pg_trigger WHERE tgrelid = 'anlage_standort'::regclass "
                + "AND NOT tgisinternal")).isOne();
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
