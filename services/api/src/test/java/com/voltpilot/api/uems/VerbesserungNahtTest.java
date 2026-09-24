package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.Date;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Auffälligkeits-Naht (UEMS AP-18 IP-15, A1, E4 = A): je endgültigem Monatswert mit Urteil {@code schlechter} genau ein
 * Vermerk in derselben Transaktion wie der Wert, mit der kanonischen Kopie der Vergleichszeile und ihrer Prüfsumme;
 * andere Urteile und Kennzahlen ohne freigegebene Fassung schreiben nichts; Schalter aus → die Naht schweigt.
 *
 * <p><b>Zwei Jahre früher</b> (Muster {@code BezugsbasisVergleichApiTest}): Dezember 2027 (R1) ist hier Dezember 2025,
 * Juli 2028 (R11) ist Juli 2026 — {@code bezugsgroesse_wert} nimmt nur Perioden an, die vor der echten Uhr der Datenbank
 * enden. BB-0001 Fassung 2 (Modell mit einer Einflussgröße, 10 523 + 0,2343 × kg, Band 2 %) gilt ab 01.11.2025.
 *
 * <p>Der Takt-Weg fährt {@link KennzahlLauf#lauf} gegen eine gemessene Messstelle mit endgültigem Monat (Muster
 * {@code UemsProduktionsrueckgangAbnahmeTest}); der Kaskaden-Weg schreibt Version 2 und ruft die Naht in DERSELBEN
 * Verbindung der Verwaltungsrolle, wie {@link KennzahlKaskade} es nach {@code KennzahlNeuGebildet.melden} tut.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class VerbesserungNahtTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String PFAD = "/api/v1/kennzahlen";
    private static final ZoneId ZONE = ZoneId.of("Europe/Berlin");
    private static final String ENERGIE = "sunspec.model_203.totwhimp";
    private static final String KATALOG = "2026.09.11.1";
    /** R1: Dezember wird am 07. endgültig (Monatsende + 7 Tage) — der Takt danach, 05:12 Ortszeit. */
    private static final Instant TAKT_R1 = Instant.parse("2026-01-08T04:12:00Z");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", () -> APP_USER);
        registry.add("spring.datasource.password", () -> APP_PW);
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
        registry.add("spring.flyway.placeholders.appDbUser", () -> APP_USER);
        registry.add("spring.flyway.placeholders.appDbPassword", () -> APP_PW);
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot");
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot/protocol/openid-connect/certs");
    }

    @Autowired
    MockMvc mvc;

    @MockBean
    KennzahlAufrufer aufrufer;

    @Autowired
    KennzahlService kennzahlen;

    @Autowired
    KennzahlLauf lauf;

    @Autowired
    VerbesserungNaht naht;

    @Autowired
    @Qualifier("adminJdbcTemplate")
    JdbcTemplate admin;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Welt(UUID mandant, UUID st1, UUID g2, UUID bz1, UUID kz4, UUID ohneBasis) {}

    @FunctionalInterface
    private interface Schritt {
        void fahren(Connection con) throws SQLException;
    }

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void aufruferWieHeute() {
        doAnswer(inv -> KorrekturRechte.benutzer(inv.getArgument(0))).when(aufrufer).benutzer(any());
        kennzahlen.uhrStellen(Clock.fixed(Instant.parse("2026-04-15T09:00:00Z"), ZoneOffset.UTC));
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
        kennzahlen.uhrStellen(Clock.systemUTC());
        ReflectionTestUtils.setField(naht, "eingeschaltet", true);
    }

    // ================================================================ Takt (R1, Schalter)

    /** R1 im Takt: der Lauf schreibt den Dezember endgültig und vermerkt in DERSELBEN Transaktion; der zweite Takt nichts. */
    @Test
    void r1DerTaktVermerktDenDezemberEinmal() throws Exception {
        Welt w = welt();
        UUID kz = gemesseneKennzahl(w, "KZ-0014", "MS-30", "78000");

        KennzahlLauf.Lauf l = lauf.lauf(TAKT_R1);

        assertThat(l.endgueltig()).as("lauf gibt die endgültig geschriebenen Monatswerte zurück")
                .anySatisfy(n -> {
                    assertThat(n.kennzahl()).isEqualTo(kz);
                    assertThat(n.periodeArt()).isEqualTo("monat");
                    assertThat(n.von()).isEqualTo(LocalDate.parse("2025-12-01"));
                });
        List<Map<String, Object>> v = vermerke(w, kz);
        assertThat(v).hasSize(1);
        Map<String, Object> r1 = v.get(0);
        assertThat(r1.get("periode")).isEqualTo("2025-12");
        assertThat(r1.get("fassung")).isEqualTo(2);
        assertThat(r1.get("zustand")).isEqualTo("offen");
        assertThat(r1.get("standort_id")).as("Standort der Geltung G-2").isEqualTo(w.st1());
        assertThat(((Timestamp) r1.get("vermerkt_am")).toInstant()).as("die Uhr des Takts").isEqualTo(TAKT_R1);
        JsonNode anlass = MAPPER.readTree((String) r1.get("anlass"));
        assertThat(anlass.get("kennzahl").asText()).isEqualTo("KZ-0014");
        assertThat(anlass.at("/bereinigt/urteil").asText()).isEqualTo("schlechter");
        assertThat(anlass.at("/bereinigt/delta_prozent").asText()).isEqualTo("12.9");
        assertThat(anlass.at("/bereinigt/erwartet").asText()).isEqualTo("69098");
        assertThat(anlass.at("/bereinigt/gemessen/version").asInt()).isEqualTo(1);
        assertThat(anlass.has("roh")).as("die rohe Veränderung trägt kein Urteil (VG3)").isFalse();
        assertThat(r1.get("anlass_pruefsumme")).isEqualTo(BezugsbasisGrundlage.pruefsumme((String) r1.get("anlass")));
        assertThat(root.queryForObject("SELECT bericht_pruefsumme(anlass) = anlass_pruefsumme FROM auffaelligkeit WHERE id = ?",
                Boolean.class, r1.get("id"))).isTrue();
        assertThat(root.queryForObject("SELECT zustand FROM kennzahl_wert WHERE kennzahl_id = ? AND periode_art = 'monat' "
                + "AND periode_von = '2025-12-01'", String.class, kz)).isEqualTo("endgueltig");

        KennzahlLauf.Lauf zweiter = lauf.lauf(TAKT_R1.plus(Duration.ofHours(1)));
        assertThat(zweiter.endgueltig()).noneMatch(n -> n.kennzahl().equals(kz));
        assertThat(vermerke(w, kz)).as("ein zweiter Takt schreibt nichts").hasSize(1);
    }

    /** Schalter aus: der Takt bildet den endgültigen Wert trotzdem — die Naht schweigt und holt nichts nach. */
    @Test
    void schalterAusDieNahtSchweigtDieWerteEntstehen() throws Exception {
        Welt w = welt();
        UUID kz = gemesseneKennzahl(w, "KZ-0015", "MS-31", "78000");
        ReflectionTestUtils.setField(naht, "eingeschaltet", false);

        KennzahlLauf.Lauf l = lauf.lauf(TAKT_R1);

        assertThat(l.endgueltig()).anyMatch(n -> n.kennzahl().equals(kz) && n.von().equals(LocalDate.parse("2025-12-01")));
        assertThat(root.queryForObject("SELECT count(*) FROM kennzahl_wert WHERE kennzahl_id = ? AND periode_art = 'monat' "
                + "AND periode_von = '2025-12-01' AND zustand = 'endgueltig'", Long.class, kz)).isOne();
        assertThat(vermerke(w, kz)).isEmpty();

        ReflectionTestUtils.setField(naht, "eingeschaltet", true);
        lauf.lauf(TAKT_R1.plus(Duration.ofHours(1)));
        assertThat(vermerke(w, kz)).as("nichts wird nachgeholt").isEmpty();
    }

    // ================================================================ die Naht in der Transaktion

    /** R1 an der Naht: genau ein Vermerk, ein zweiter Aufruf über denselben Monat schreibt keinen (idempotent). */
    @Test
    void r1GenauEinVermerkIdempotent() throws Exception {
        Welt w = welt();
        List<VerbesserungNaht.Vermerk> erster = vermerken(w, w.kz4(), "KZ-0004", "2025-12-01", 1, TAKT_R1);
        assertThat(erster).singleElement().satisfies(v -> {
            assertThat(v.periode()).isEqualTo("2025-12");
            assertThat(v.bezugsbasis()).isEqualTo("BB-0001");
            assertThat(v.fassung()).isEqualTo(2);
            assertThat(v.anlassPruefsumme()).startsWith("sha256:");
        });
        assertThat(vermerken(w, w.kz4(), "KZ-0004", "2025-12-01", 1, TAKT_R1.plus(Duration.ofHours(1)))).isEmpty();
        assertThat(vermerke(w, w.kz4())).hasSize(1);
    }

    /** R11: Juli (2,5 % mehr als erwartet) ist schlechter — ein Vermerk. */
    @Test
    void r11JuliSchlechterEinVermerk() throws Exception {
        Welt w = welt();
        List<VerbesserungNaht.Vermerk> v = vermerken(w, w.kz4(), "KZ-0004", "2026-07-01", 1,
                Instant.parse("2026-08-07T04:12:00Z"));
        assertThat(v).singleElement().satisfies(x -> assertThat(x.periode()).isEqualTo("2026-07"));
        JsonNode anlass = MAPPER.readTree((String) vermerke(w, w.kz4()).get(0).get("anlass"));
        assertThat(anlass.at("/bereinigt/delta_prozent").asText()).isEqualTo("2.5");
        assertThat(anlass.at("/bereinigt/urteil").asText()).isEqualTo("schlechter");
    }

    /** `besser` (Januar −3,5 %), `im_rahmen` (November) und `nicht_anwendbar` (März außerhalb der Spannweite): nichts. */
    @Test
    void besserImRahmenUndNichtAnwendbarSchreibenNichts() throws Exception {
        Welt w = welt();
        Instant takt = Instant.parse("2026-04-08T04:12:00Z");
        for (String monat : List.of("2026-01-01", "2025-11-01", "2026-03-01")) {
            assertThat(vermerken(w, w.kz4(), "KZ-0004", monat, 1, takt)).as(monat).isEmpty();
        }
        assertThat(vermerke(w, w.kz4())).isEmpty();
    }

    /** R13: ohne Bezugsbasis schreibt die Naht nichts; ein Monat, der zur Uhr des Laufs nicht vorbei ist, auch nicht. */
    @Test
    void r13OhneBasisUndOhneVergangenenMonatNichts() throws Exception {
        Welt w = welt();
        assertThat(vermerken(w, w.ohneBasis(), "KZ-0007", "2025-12-01", 1, TAKT_R1)).isEmpty();
        assertThat(vermerke(w, w.ohneBasis())).isEmpty();
        assertThat(vermerken(w, w.kz4(), "KZ-0004", "2025-12-01", 1, Instant.parse("2025-12-31T12:00:00Z")))
                .as("der Monat liegt nicht vor dem Vermerk").isEmpty();
        assertThat(vermerke(w, w.kz4())).isEmpty();
    }

    /**
     * Der Kaskaden-Weg: November war im Rahmen; die Kaskade schreibt Version 2 (88 000 kWh, +2,9 %) und ruft die Naht in
     * DERSELBEN Transaktion — sie liest die noch nicht festgeschriebene Version 2 und vermerkt. Rollt die Transaktion
     * zurück, gibt es auch keinen Vermerk.
     */
    @Test
    void kaskadeKorrekturMachtNovemberSchlechterEinVermerkInDerselbenTransaktion() throws Exception {
        Welt w = welt();
        Instant kaskade = Instant.parse("2026-02-10T10:05:00Z");
        KennzahlLauf.Neu v2 = new KennzahlLauf.Neu(w.kz4(), "KZ-0004", "monat", LocalDate.parse("2025-11-01"),
                LocalDate.parse("2025-11-30"), ZONE, 2);

        assertThatThrownBy(() -> inTransaktion(con -> {
            version2(con, w, "2025-11-01", "88000", "320000", kaskade);
            assertThat(naht.vermerken(con, w.mandant(), List.of(v2), kaskade)).hasSize(1);
            throw new SQLException("Kaskade bricht ab");
        })).hasMessageContaining("Kaskade");
        assertThat(vermerke(w, w.kz4())).as("zurückgerollt mit dem Wert").isEmpty();

        inTransaktion(con -> {
            version2(con, w, "2025-11-01", "88000", "320000", kaskade);
            assertThat(naht.vermerken(con, w.mandant(), List.of(v2), kaskade)).singleElement()
                    .satisfies(v -> assertThat(v.periode()).isEqualTo("2025-11"));
        });
        List<Map<String, Object>> v = vermerke(w, w.kz4());
        assertThat(v).hasSize(1);
        JsonNode anlass = MAPPER.readTree((String) v.get(0).get("anlass"));
        assertThat(anlass.at("/bereinigt/gemessen/version").asInt()).isEqualTo(2);
        assertThat(anlass.at("/bereinigt/delta_prozent").asText()).isEqualTo("2.9");
    }

    /** Die Verwaltungsrolle hängt an (Naht), ändert und löscht nie außer im Offboarding; die App-Rolle löscht nie. */
    @Test
    void rechteNurAnhaengen() {
        assertThat(root.queryForObject("SELECT has_table_privilege('voltpilot_admin', 'auffaelligkeit', 'INSERT')",
                Boolean.class)).isTrue();
        assertThat(root.queryForObject("SELECT has_table_privilege('voltpilot_admin', 'auffaelligkeit', 'UPDATE')",
                Boolean.class)).isFalse();
        assertThat(root.queryForObject("SELECT has_table_privilege(?, 'auffaelligkeit', 'DELETE') "
                + "OR has_table_privilege(?, 'auffaelligkeit', 'TRUNCATE')", Boolean.class, APP_USER, APP_USER)).isFalse();
    }

    // ================================================================ die Welt

    private List<VerbesserungNaht.Vermerk> vermerken(Welt w, UUID kennzahl, String kennzeichen, String monat, int version,
            Instant jetzt) throws Exception {
        LocalDate von = LocalDate.parse(monat);
        KennzahlLauf.Neu n = new KennzahlLauf.Neu(kennzahl, kennzeichen, "monat", von, von.plusMonths(1).minusDays(1),
                ZONE, version);
        List<List<VerbesserungNaht.Vermerk>> aus = new java.util.ArrayList<>();
        inTransaktion(con -> aus.add(naht.vermerken(con, w.mandant(), List.of(n), jetzt)));
        return aus.get(0);
    }

    private void inTransaktion(Schritt schritt) throws SQLException {
        admin.execute((Connection con) -> {
            boolean autoCommit = con.getAutoCommit();
            con.setAutoCommit(false);
            try {
                schritt.fahren(con);
                con.commit();
                return null;
            } catch (Exception e) {
                con.rollback();
                throw e instanceof SQLException sql ? sql : new SQLException("Transaktion abgebrochen", e);
            } finally {
                con.setAutoCommit(autoCommit);
            }
        });
    }

    private static List<Map<String, Object>> vermerke(Welt w, UUID kennzahl) {
        return root.queryForList("SELECT * FROM auffaelligkeit WHERE tenant_id = ? AND kennzahl_id = ? ORDER BY periode",
                w.mandant(), kennzahl);
    }

    private Welt welt() throws Exception {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Naht #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, "Kunststoffwerk Ahrenberg GmbH");
        UUID st1 = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        UUID g2 = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, 'gebaeude', "
                + "'Halle 2', 'G-2', 'aktiv') RETURNING id", UUID.class, t);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2020-01-01')", t, g2, st1);
        for (String ms : List.of("MS-20", "MS-21")) {
            UUID id = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                    + "richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                    + "'Zählerstand') RETURNING id", UUID.class, t, ms, "Messstelle " + ms);
            root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, ort_id, standort_id, gueltig_ab) "
                    + "VALUES (?, ?, ?, NULL, '2020-01-01')", t, id, g2);
        }
        UUID bz1 = root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, "
                + "periode_art, geltung_art, ort_id) VALUES (?, 'BZ-1', 'Produktionsmenge Spritzguss', 'periodenwert', "
                + "'kg', 'monat', 'gebaeude', ?) RETURNING id", UUID.class, t, g2);
        Welt ohne = new Welt(t, st1, g2, bz1, null, null);
        UUID kz4 = kennzahl(ohne, "KZ-0004", "MS-20");
        UUID kz7 = kennzahl(ohne, "KZ-0007", "MS-21");
        Welt w = new Welt(t, st1, g2, bz1, kz4, kz7);

        // Oktober als Vormonat, November im Rahmen, Dezember R1, Januar besser, März außerhalb, Juli R11.
        String[][] spritzguss = {{"2025-10-01", "88000", "310000"}, {"2025-11-01", "85500", "320000"},
            {"2025-12-01", "78000", "250000"}, {"2026-01-01", "78000", "300000"}, {"2026-03-01", "100000", "390000"},
            {"2026-07-01", "82833", "300000"}};
        for (String[] m : spritzguss) {
            monat(w, kz4, "MS-20", true, m[0], m[1], m[2]);
            monat(w, kz7, "MS-21", false, m[0], m[1], m[2]);
        }

        TenantContext.set(t);
        UUID bb1 = basis(w, kz4);
        fassung(t, bb1, 1, bz1, "verhaeltnis", "2024-10/2024-10", "2024-11-01", "2025-10-31", "0.2837", null, null, null,
                null);
        fassung(t, bb1, 2, bz1, "regression_eine_variable", "2024-11/2025-10", "2025-11-01", null, "0.2685",
                "{\"a\": 10523, \"b\": 0.2343}", "0.8", "254000", "341000");
        TenantContext.clear();
        return w;
    }

    /**
     * Eine Kennzahl, die der Takt selbst bildet: gemessene Messstelle mit führender Quelle und einem endgültigen
     * Dezember in {@code messreihe_periode} (Version 1), dazu ihre Bezugsbasis mit der Fassung 2 von BB-0001.
     */
    private UUID gemesseneKennzahl(Welt w, String kennzeichen, String ms, String kwh) throws Exception {
        UUID t = w.mandant();
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, "Halle 2 " + ms + " #" + NR.incrementAndGet(),
                Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, anlage, "VP-NAHT-" + ms + "-" + UUID.randomUUID());
        UUID komponente = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, communication, connection_json, created_at) VALUES (?, ?, 'modbus-generic', ?, "
                + "'modbus-generic', ?, 'modbus_tcp', '{\"unit_id\":1}'::jsonb, ?) RETURNING id", UUID.class, t, anlage,
                "Zähler " + ms, box, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, now(), ?, 'test', "
                + "'pending_edge', 'energy_counter', 'fifteen_minute')", t, anlage, box, komponente, ENERGIE, KATALOG);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ?", UUID.class,
                komponente);
        UUID messstelle = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                + "'Zählerstand') RETURNING id", UUID.class, t, ms, "Zähler " + ms);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_name, actor_art) "
                + "VALUES (?,?,'Wirkenergie','Bezug',?,?,?,'counter','zaehlerstand','fuehrend',?,false,?,'test','voltpilot')",
                t, messstelle, komponente, geraet, ENERGIE, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")),
                Timestamp.from(Instant.parse("2020-01-01T00:01:00Z")));
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, unterzaehler_von, "
                + "gueltig_ab) VALUES (?,?,?,'Hauptzähler',NULL,?)", t, messstelle, anlage, LocalDate.parse("2020-01-01"));
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, ort_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, NULL, '2020-01-01')", t, messstelle, w.g2());

        LocalDate dez = LocalDate.parse("2025-12-01");
        Instant b = dez.atStartOfDay(ZONE).toInstant();
        Instant e = dez.plusMonths(1).atStartOfDay(ZONE).toInstant();
        long stunden = ChronoUnit.HOURS.between(b, e);
        int tage = dez.lengthOfMonth();
        root.update("INSERT INTO messreihe_periode (tag, art, tenant_id, entity_id, messkanal, zeitzone, zeitzone_herkunft, "
                + "beginn, ende, stunden, teile_erwartet, teile_vorhanden, teile_endgueltig, wertart, menge, menge_zustand, "
                + "kennzeichen, erhalten, erwartet, abdeckung_prozent, zustand, endgueltig_ab, version) VALUES (?, 'monat', "
                + "?, ?, ?, 'Europe/Berlin', 'vorgabe', ?, ?, ?, ?, ?, ?, 'counter', ?::numeric, 'vollständig', '[]'::jsonb, "
                + "?, ?, 100, 'endgueltig', ?, 1)", dez, t, komponente, ENERGIE, Timestamp.from(b), Timestamp.from(e),
                stunden, tage, tage, tage, kwh, stunden * 60, stunden * 60, Timestamp.from(e.plus(Duration.ofDays(7))));

        UUID kz = kennzahl(w, kennzeichen, ms);
        TenantContext.set(t);
        UUID bb = basis(w, kz);
        fassung(t, bb, 1, w.bz1(), "verhaeltnis", "2024-10/2024-10", "2024-11-01", "2025-10-31", "0.2837", null, null,
                null, null);
        fassung(t, bb, 2, w.bz1(), "regression_eine_variable", "2024-11/2025-10", "2025-11-01", null, "0.2685",
                "{\"a\": 10523, \"b\": 0.2343}", "0.8", "254000", "341000");
        TenantContext.clear();
        return kz;
    }

    /** Eine endgültige Monatszeile der Kennzahl (Version 1, wie der Rechenlauf sie schreibt) und — einmal — BZ-1. */
    private static void monat(Welt w, UUID kennzahl, String ms, boolean mitBezugswert, String erster, String zaehlerText,
            String nennerText) {
        LocalDate von = LocalDate.parse(erster);
        LocalDate bis = von.plusMonths(1).minusDays(1);
        BigDecimal zaehler = new BigDecimal(zaehlerText);
        BigDecimal nenner = new BigDecimal(nennerText);
        Timestamp am = Timestamp.from(von.plusMonths(1).atStartOfDay().toInstant(ZoneOffset.UTC).plusSeconds(7200));
        UUID fassung = root.queryForObject("SELECT id FROM kennzahl_fassung WHERE kennzahl_id = ? AND nummer = 1",
                UUID.class, kennzahl);
        UUID wert = UUID.randomUUID();
        root.update("INSERT INTO kennzahl_wert (id, tenant_id, kennzahl_id, periode_art, periode_von, periode_bis, zeitzone, "
                + "version, wert, zaehler, nenner, menge_zustand, kennzeichen, zustand, endgueltig_ab, "
                + "definition_fassung_id, berechnet_am) VALUES (?, ?, ?, 'monat', ?, ?, 'Europe/Berlin', 1, ?, ?, ?, "
                + "'vollständig', '[]'::jsonb, 'endgueltig', ?, ?, ?)", wert, w.mandant(), kennzahl, Date.valueOf(von),
                Date.valueOf(bis), zaehler.divide(nenner, 20, RoundingMode.HALF_UP), zaehler, nenner, am, fassung, am);
        root.update("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, kennzahl_id, position, rolle, art, objekt, "
                + "messstelle_id, wert, einheit, menge_zustand, version) VALUES (?, ?, ?, 0, 'zaehler', 'messstelle', "
                + "?, (SELECT id FROM messstelle WHERE tenant_id = ? AND kennzeichen = ?), ?, 'kWh', 'vollständig', 1)",
                w.mandant(), wert, kennzahl, ms, w.mandant(), ms, zaehler);
        root.update("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, kennzahl_id, position, rolle, art, objekt, "
                + "bezugsgroesse_id, wert, einheit, menge_zustand, fassung) VALUES (?, ?, ?, 1, 'nenner', 'bezugsgroesse', "
                + "'BZ-1', ?, ?, 'kg', 'vollständig', 1)", w.mandant(), wert, kennzahl, w.bz1(), nenner);
        if (mitBezugswert) {
            root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, "
                    + "periode_von, periode_bis, zeitzone, fassung, vorgang, status, betrag, herkunft_art, actor_sub, "
                    + "actor_name, actor_rolle, actor_art) VALUES (?, ?, 'periodenwert', 'kg', 'monat', ?, ?, 'Europe/Berlin', "
                    + "1, 'erstwert', 'wirksam', ?, 'eingabe', 'IK', 'Ines Kaltenbach', 'energiemanager', 'kunde')",
                    w.mandant(), w.bz1(), Date.valueOf(von), Date.valueOf(bis), nenner);
        }
    }

    /** Version 2 eines endgültigen Monats, wie die Kaskade sie schreibt (Anlass der Korrektur), in {@code con}. */
    private static void version2(Connection con, Welt w, String erster, String zaehlerText, String nennerText,
            Instant am) throws SQLException {
        LocalDate von = LocalDate.parse(erster);
        BigDecimal zaehler = new BigDecimal(zaehlerText);
        BigDecimal nenner = new BigDecimal(nennerText);
        try (var ps = con.prepareStatement("INSERT INTO kennzahl_wert (tenant_id, kennzahl_id, periode_art, periode_von, "
                + "periode_bis, zeitzone, version, wert, zaehler, nenner, menge_zustand, kennzeichen, zustand, endgueltig_ab, "
                + "definition_fassung_id, berechnet_am, anlass_art, anlass_kennung) SELECT tenant_id, kennzahl_id, "
                + "periode_art, periode_von, periode_bis, zeitzone, 2, ?, ?, ?, menge_zustand, kennzeichen, zustand, "
                + "endgueltig_ab, definition_fassung_id, ?, 'eingang', 'K-2026-0901' FROM kennzahl_wert "
                + "WHERE tenant_id = ? AND kennzahl_id = ? AND periode_art = 'monat' AND periode_von = ? AND version = 1")) {
            ps.setBigDecimal(1, zaehler.divide(nenner, 20, RoundingMode.HALF_UP));
            ps.setBigDecimal(2, zaehler);
            ps.setBigDecimal(3, nenner);
            ps.setTimestamp(4, Timestamp.from(am));
            ps.setObject(5, w.mandant());
            ps.setObject(6, w.kz4());
            ps.setDate(7, Date.valueOf(von));
            assertThat(ps.executeUpdate()).isOne();
        }
    }

    /** Die Bezugsbasis über die Route von IP-7. */
    private UUID basis(Welt w, UUID kennzahl) throws Exception {
        MvcResult r = mvc.perform(request(HttpMethod.POST, PFAD + "/" + kennzahl + "/bezugsbasen").with(ines(w))
                .contentType(MediaType.APPLICATION_JSON)).andReturn();
        assertThat(r.getResponse().getStatus()).as(r.getResponse().getContentAsString()).isEqualTo(201);
        return UUID.fromString(MAPPER.readTree(r.getResponse().getContentAsString(StandardCharsets.UTF_8))
                .get("id").asText());
    }

    /** Eine freigegebene Fassung, direkt geschrieben (Muster {@code BezugsbasisVergleichApiTest}). */
    private static void fassung(UUID t, UUID basis, int nummer, UUID bz, String methode, String referenzperiode,
            String giltAb, String giltBis, String basiswert, String koeffizienten, String streuung, String von,
            String bis) {
        UUID f = root.queryForObject("INSERT INTO bezugsbasis_fassung (tenant_id, bezugsbasis_id, fassung, referenzperiode, "
                + "methode, datenlage, gilt_ab, gilt_bis, beendet_am, beendet_grund, toleranz_prozent, anpassungsgruende, "
                + "begruendung, basiswert, koeffizienten, streuung_prozent, actor_sub, actor_name, actor_rolle, actor_art, "
                + "freigabe_status, freigabe_sub, freigabe_name, freigabe_rolle, freigabe_art, freigabe_am, freigegeben_am) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2.0, ?::text[], 'Freigabe im Naht-Test.', ?, ?::jsonb, ?, "
                + "'IK', 'Ines Kaltenbach', 'energiemanager', 'kunde', 'freigegeben', 'IK', 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde', now(), now()) RETURNING id", UUID.class, t, basis, nummer, referenzperiode,
                methode, nummer == 1 && "verhaeltnis".equals(methode) ? "vorlaeufig" : "vollstaendig",
                Date.valueOf(giltAb), giltBis == null ? null : Date.valueOf(giltBis),
                giltBis == null ? null : Timestamp.from(Instant.parse("2026-04-15T09:00:00Z")),
                giltBis == null ? null : "Fassung 2 ersetzt das Verhältnis.",
                nummer > 1 ? "{referenzperiode_vervollstaendigt}" : "{}", new BigDecimal(basiswert), koeffizienten,
                streuung == null ? null : new BigDecimal(streuung));
        root.update("INSERT INTO bezugsbasis_variable (tenant_id, fassung_id, position, bezugsgroesse_id, "
                + "bezugsgroesse_fassung, spannweite_von, spannweite_bis) VALUES (?, ?, 1, ?, 1, ?, ?)", t, f, bz,
                von == null ? null : new BigDecimal(von), bis == null ? null : new BigDecimal(bis));
    }

    private UUID kennzahl(Welt w, String kennzeichen, String ms) throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", kennzeichen);
        m.put("name", kennzeichen + " Stromeinsatz je kg");
        m.put("rechenform", "quotient");
        m.put("geltung_art", "gebaeude");
        m.put("geltung_id", w.g2().toString());
        m.put("eingaenge", List.of(e("zaehler", "messstelle", ms), e("nenner", "bezugsgroesse", "BZ-1")));
        MvcResult r = mvc.perform(request(HttpMethod.POST, PFAD).with(ines(w)).contentType(MediaType.APPLICATION_JSON)
                .content(MAPPER.writeValueAsString(m))).andReturn();
        assertThat(r.getResponse().getStatus()).as(kennzeichen + " " + r.getResponse().getContentAsString())
                .isEqualTo(201);
        return UUID.fromString(MAPPER.readTree(r.getResponse().getContentAsString(StandardCharsets.UTF_8))
                .get("id").asText());
    }

    private static Map<String, Object> e(String rolle, String art, String kennzeichen) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("rolle", rolle);
        m.put("art", art);
        m.put("kennzeichen", kennzeichen);
        return m;
    }

    private static org.springframework.test.web.servlet.request.RequestPostProcessor ines(Welt w) {
        return jwt().jwt(j -> {
            j.subject("sub-ines-" + w.mandant());
            j.claim("preferred_username", "Ines Kaltenbach");
            j.claim("tenant_id", w.mandant().toString());
        });
    }
}
