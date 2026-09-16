package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
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
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Eine FLÄCHE als Nenner einer Kennzahl an der Datenbank (UEMS AP-11 §5.1) — „Netzbezug je m²“ ist die erste
 * anlegbare Kennzahl eines Bestandskunden, und genau das wird hier nachgewiesen.
 *
 * <ul>
 *   <li><b>Sie lässt sich anlegen und rechnet.</b> Der Nenner heißt {@code art: "bezugsflaeche"} mit dem Kurzzeichen
 *       des Gebäudes (G-2); gelesen wird die Ortsstruktur (AP-02 {@code flaeche_gueltigkeit}), nicht eine zweite
 *       Flächen-Tabelle. Oktober 2026: 36 900 kWh ÷ 3 100 m² = 11,9032 kWh/m² — die Zahlen des
 *       Referenzunternehmens (K12, Abnahmefall der Kennzahl KZ-0005).</li>
 *   <li><b>Der Stichtag entscheidet.</b> Halle 2 hat 3 100 m² bis 31.12.2026 und 3 400 m² ab 01.01.2027: Dezember
 *       liest 3 100 (34 300 ÷ 3 100 = 11,0645), Januar 3 400 (38 760 ÷ 3 400 = 11,40) — nie ein zeitgewichtetes
 *       Mittel, nie rückwirkend.</li>
 *   <li><b>Der rückwirkende Auslöser.</b> Wird die Fläche nachträglich geändert ({@code ort_aenderung} /
 *       {@code flaeche_geaendert}), bildet die Korrektur-Kaskade jede Kennzahl, die sie liest, ab „gilt ab“ neu — und
 *       keinen Tag früher. AP-11 IP-9 hat diesen Auslöser bewusst nicht gebaut, weil er damals ins Leere gelaufen
 *       wäre.</li>
 *   <li><b>Die Sperre steht weiter.</b> Eine Bezugsgröße in m² anzulegen bleibt 422 {@code flaeche_aus_struktur} —
 *       ihr Satz nennt jetzt den Weg.</li>
 * </ul>
 *
 * <p>⚠ Der Schreibweg der Fläche ({@code PUT /api/v1/orte/&#123;id&#125;/flaeche}) urteilt „rückwirkend“ nach der
 * ECHTEN Uhr. Der rückwirkende Fall rechnet seine Monate darum relativ zu heute; die ersten beiden Fälle stehen an
 * den Tagen des Referenzunternehmens, weil ihr Lauf seinen Zeitpunkt selbst mitbringt.
 */
@Testcontainers
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class UemsKennzahlFlaecheNennerTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ENERGIE = "sunspec.model_203.totwhimp";
    private static final String KATALOG = "2026.09.11.1";
    private static final ZoneId ZONE = ZoneId.of("Europe/Berlin");
    private static final Path REFERENZ = Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");
    private static final String PFAD = "/api/v1/kennzahlen";
    private static final String BZ_PFAD = "/api/v1/bezugsgroessen";

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

    @Autowired
    KennzahlLauf lauf;

    @Autowired
    KorrekturKaskade kaskade;

    @MockBean
    KennzahlAufrufer aufrufer;

    private static JdbcTemplate root;
    private static JsonNode referenz;
    private static final AtomicInteger NR = new AtomicInteger();

    @BeforeAll
    static void verbinde() throws Exception {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        referenz = MAPPER.readTree(REFERENZ.toFile());
    }

    @BeforeEach
    void aufruferWieHeute() {
        doAnswer(inv -> KorrekturRechte.benutzer(inv.getArgument(0))).when(aufrufer).benutzer(any());
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }

    // ================================================================ 1. sie lässt sich anlegen und rechnet

    /**
     * Das Versprechen des Konzepts: „Netzbezug je m²“ für Halle 2. Der Nenner nennt die Bezugsfläche des Gebäudes,
     * gebunden wird eine Bezugsgröße OHNE eigene Werte — jede Zahl kommt aus der Ortsstruktur.
     */
    @Test
    void netzbezugJeQuadratmeterLaesstSichAnlegenUndRechnetDieZahlDesReferenzunternehmens() throws Exception {
        LocalDate okt = LocalDate.parse("2026-10-01");
        Welt w = halle2(okt, flaecheAb(0), null);
        monat(w, "MS-10", okt, referenzZahl("KZ-0005", "oktober_2026_zaehler"), true);

        JsonNode vorschau = ok(ruf(w, HttpMethod.POST, PFAD + "/vorschau", anfrage("KZ-0005", w)));
        assertThat(vorschau.get("befunde")).as("die Vorschau bindet nichts und urteilt trotzdem: " + vorschau).isEmpty();
        assertThat(vorschau.get("einheit").asText()).isEqualTo("kWh/m²");
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsgroesse WHERE tenant_id = ?", Long.class, w.mandant()))
                .as("die Vorschau legt keine Bezugsgröße an").isZero();

        anlegen(w, "KZ-0005", w.halle2());
        Map<String, Object> zeiger = root.queryForMap("SELECT kennzeichen, name, wertart, einheit, geltung_art, ort_id "
                + "FROM bezugsgroesse WHERE tenant_id = ?", w.mandant());
        assertThat(zeiger).containsEntry("name", "Bezugsfläche").containsEntry("wertart", "stammdatum")
                .containsEntry("einheit", "m²").containsEntry("geltung_art", "gebaeude")
                .containsEntry("ort_id", w.halle2());
        assertThat(String.valueOf(zeiger.get("kennzeichen"))).matches("BZ-[0-9]{4}");
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsgroesse_stammdatum WHERE tenant_id = ?", Long.class,
                w.mandant())).as("der Zeiger trägt keinen eigenen Wert — keine zweite Fläche").isZero();

        lauf.lauf(Instant.parse("2026-11-10T08:00:00Z"));

        Map<String, Object> v = zeile(w, "KZ-0005", "monat", okt);
        assertThat(v.get("version")).isEqualTo(1);
        assertThat(v.get("zustand")).isEqualTo("endgueltig");
        assertThat(vier(v.get("wert"))).as("36 900 kWh ÷ 3 100 m² (Fläche am 31.10.2026)").isEqualTo("11.9032");
        assertThat(eingaenge(v)).extracting(e -> e.get("rolle") + " " + e.get("art") + " " + e.get("einheit"))
                .contains("nenner bezugsgroesse m²");
        assertThat(eingaenge(v).stream().filter(e -> "nenner".equals(e.get("rolle"))).findFirst().orElseThrow())
                .extracting(e -> saetze(e.get("kennzeichen")))
                .isEqualTo(List.of("Stichtag 31.10.2026"));
        assertThat(ok(ruf(w, HttpMethod.GET, PFAD + "/" + w.kz(), null)).get("einheit_anzeige").asText())
                .isEqualTo("kWh je m²");
    }

    // ================================================================ 2. der Stichtag entscheidet

    /**
     * Halle 2 wächst zum 01.01.2027 von 3 100 auf 3 400 m² (Anbau, AP-02 §4.4). Dezember 2026 liest 3 100, Januar
     * 2027 liest 3 400 — jede Periode die Fläche an ihrem LETZTEN Tag (E17), keine Periode das Mittel.
     */
    @Test
    void jedePeriodeLiestDieFlaecheAnIhremLetztenTag() throws Exception {
        LocalDate dez = LocalDate.parse("2026-12-01");
        LocalDate jan = LocalDate.parse("2027-01-01");
        Welt w = halle2(LocalDate.parse("2026-10-01"), flaecheAb(0), flaecheAb(1));
        monat(w, "MS-10", dez, "34300", true);
        monat(w, "MS-10", jan, "38760", true);
        anlegen(w, "KZ-0005", w.halle2());

        lauf.lauf(Instant.parse("2027-02-10T08:00:00Z"));

        assertThat(vier(zeile(w, "KZ-0005", "monat", dez).get("wert"))).as("34 300 ÷ 3 100 (Stichtag 31.12.2026)")
                .isEqualTo("11.0645");
        assertThat(vier(zeile(w, "KZ-0005", "monat", jan).get("wert"))).as("38 760 ÷ 3 400 (Stichtag 31.01.2027)")
                .isEqualTo("11.4000");
        assertThat(nenner(zeile(w, "KZ-0005", "monat", dez))).isEqualTo("3100");
        assertThat(nenner(zeile(w, "KZ-0005", "monat", jan))).isEqualTo("3400");
        assertThat(zeilen(w, "KZ-0005", "monat", dez)).as("der Dezember bekommt keine zweite Version").hasSize(1);
    }

    // ================================================================ 3. der rückwirkende Auslöser

    /**
     * Die Fläche von Halle 2 wird nachträglich geändert — über den echten Schreibweg von AP-02, mit „gilt ab“ im
     * VORLETZTEN Monat. Der Takt der Korrektur-Kaskade bildet danach genau die Kennzahl-Perioden ab diesem Tag neu;
     * der Monat davor behält Version 1 und seine Zahl.
     */
    @Test
    void eineRueckwirkendGeaenderteFlaecheBildetAbGueltigAbNeuUndKeinenTagFrueher() throws Exception {
        LocalDate heute = LocalDate.now(ZONE);
        LocalDate vorletzter = heute.withDayOfMonth(1).minusMonths(2);
        LocalDate letzter = heute.withDayOfMonth(1).minusMonths(1);
        Welt w = halle2(vorletzter.minusMonths(1), "3100", null);
        monat(w, "MS-10", vorletzter, "36900", true);
        monat(w, "MS-10", letzter, "36900", true);
        anlegen(w, "KZ-0005", w.halle2());
        lauf.lauf(heute.withDayOfMonth(10).atStartOfDay(ZONE).toInstant());
        assertThat(vier(zeile(w, "KZ-0005", "monat", vorletzter).get("wert"))).isEqualTo("11.9032");
        assertThat(vier(zeile(w, "KZ-0005", "monat", letzter).get("wert"))).isEqualTo("11.9032");

        Antwort f = ruf(w, HttpMethod.PUT, "/api/v1/orte/" + w.halle2() + "/flaeche",
                Map.of("m2", 3400, "gueltigAb", letzter.toString()));
        assertThat(f.status()).as(f.body().toString()).isEqualTo(200);
        assertThat(root.queryForList("SELECT rueckwirkend FROM ort_aenderung WHERE tenant_id = ? AND objekt_id = ? "
                + "AND art = 'flaeche_geaendert'", Boolean.class, w.mandant(), w.halle2()))
                .as("rückwirkend nach der echten Uhr").containsExactly(true);
        assertThat(zeile(w, "KZ-0005", "monat", letzter).get("version")).as("vor dem Takt ändert sich keine Kennzahl")
                .isEqualTo(1);

        Instant takt = Instant.now();
        kaskade.lauf(takt);

        Map<String, Object> neu = zeile(w, "KZ-0005", "monat", letzter);
        assertThat(neu.get("version")).isEqualTo(2);
        assertThat(vier(neu.get("wert"))).as("36 900 ÷ 3 400").isEqualTo("10.8529");
        assertThat(nenner(neu)).isEqualTo("3400");
        assertThat(saetze(neu.get("kennzeichen"))).contains("korrigiert (Version 2)");
        assertThat(zeilen(w, "KZ-0005", "monat", vorletzter))
                .as("der Monat vor „gilt ab“ bleibt unberührt — keinen Tag früher").hasSize(1);
        assertThat(vier(zeile(w, "KZ-0005", "monat", vorletzter).get("wert"))).isEqualTo("11.9032");
        assertThat(wirkung(w)).containsExactly("ort_flaeche:" + w.halle2() + " 1 gebildet");
        assertThat(meldungen(w)).allSatisfy(m -> assertThat(m).contains("G-2/ab-" + letzter));

        String vorher = tabellen(w);
        kaskade.lauf(takt.plusSeconds(300));
        assertThat(tabellen(w)).as("ein zweiter Takt schreibt nichts").isEqualTo(vorher);
    }

    // ================================================================ 4. die Sperre steht weiter

    /** Eine Bezugsgröße in m² anzulegen bleibt abgelehnt (AP-09 M4) — der Satz nennt jetzt den richtigen Weg. */
    @Test
    void eineBezugsgroesseInQuadratmeternBleibtAbgelehntUndDerSatzNenntDenWeg() throws Exception {
        Welt w = halle2(LocalDate.parse("2026-10-01"), flaecheAb(0), null);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("name", "Bezugsfläche Halle 2");
        m.put("wertart", "stammdatum");
        m.put("einheit", "m²");
        m.put("geltung_art", "gebaeude");
        m.put("geltung_id", w.halle2().toString());
        Antwort a = ruf(w, HttpMethod.POST, BZ_PFAD, m);
        assertThat(a.status()).isEqualTo(422);
        assertThat(a.body().get("code").asText()).isEqualTo("flaeche_aus_struktur");
        assertThat(a.body().get("message").asText()).isEqualTo("Flächen pflegen Sie am Gebäude. Als Nenner einer "
                + "Kennzahl nehmen Sie die Bezugsfläche des Standorts, Gebäudes oder Bereichs.");
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsgroesse WHERE tenant_id = ?", Long.class,
                w.mandant())).as("eine Ablehnung schreibt nichts").isZero();
    }

    // ================================================================ die Welt

    private record Welt(UUID mandant, UUID unternehmen, UUID standort, UUID halle2, UUID anlage,
            Map<String, UUID> komponenten, Map<String, UUID> kzIds) {

        UUID kz() {
            return kzIds().get("KZ-0005");
        }
    }

    private record Antwort(int status, JsonNode body) {}

    /** Werk Ahrenberg mit Halle 2, ihrer Bezugsfläche (Referenzunternehmen) und der Messstelle MS-10. */
    private Welt halle2(LocalDate ab, String erste, String zweite) {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Fläche #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, "Kunststoffwerk Ahrenberg GmbH");
        UUID st = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class,
                t, u);
        UUID halle = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, "
                + "'gebaeude', 'Halle 2', 'G-2', 'aktiv') RETURNING id", UUID.class, t);
        // Halle 2 hängt seit je am Werk: die Fläche darf später beginnen, das Gebäude muss HEUTE bestehen (G1).
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES (?, ?, ?, ?)",
                t, halle, st, LocalDate.parse("2020-01-01"));
        LocalDate wechsel = zweite == null ? null : LocalDate.parse(flaecheTag(1));
        root.update("INSERT INTO flaeche_gueltigkeit (tenant_id, ort_id, m2, gueltig_ab, gueltig_bis) "
                + "VALUES (?, ?, ?, ?, ?)", t, halle, Integer.valueOf(erste), ab,
                wechsel == null ? null : wechsel.minusDays(1));
        if (zweite != null) {
            root.update("INSERT INTO flaeche_gueltigkeit (tenant_id, ort_id, m2, gueltig_ab) VALUES (?, ?, ?, ?)",
                    t, halle, Integer.valueOf(zweite), wechsel);
        }
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, "Halle 2 #" + nr, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
        Welt w = new Welt(t, u, st, halle, anlage, new LinkedHashMap<>(), new LinkedHashMap<>());
        messstelle(w, "MS-10");
        return w;
    }

    /** Box, Komponente, Mess-Selektion, gemessene Messstelle mit führender Quelle, Stellung (Muster AP-11 IP-9). */
    private static void messstelle(Welt w, String kennzeichen) {
        UUID t = w.mandant();
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, t, w.anlage(), "VP-FLAECHE-" + kennzeichen + "-" + UUID.randomUUID());
        UUID komponente = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, communication, connection_json, created_at) VALUES (?, ?, 'modbus-generic', ?, "
                + "'modbus-generic', ?, 'modbus_tcp', '{\"unit_id\":1}'::jsonb, ?) RETURNING id", UUID.class, t,
                w.anlage(), "Zähler " + kennzeichen, box, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, now(), ?, 'test', "
                + "'pending_edge', 'energy_counter', 'fifteen_minute')", t, w.anlage(), box, komponente, ENERGIE, KATALOG);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ?", UUID.class,
                komponente);
        UUID messstelle = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                + "'Zählerstand') RETURNING id", UUID.class, t, kennzeichen, "Netzbezug Halle 2");
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_name, actor_art) "
                + "VALUES (?,?,'Wirkenergie','Bezug',?,?,?,'counter','zaehlerstand','fuehrend',?,false,?,'test','voltpilot')",
                t, messstelle, komponente, geraet, ENERGIE, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")),
                Timestamp.from(Instant.parse("2020-01-01T00:01:00Z")));
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, unterzaehler_von, "
                + "gueltig_ab) VALUES (?,?,?,'Hauptzähler',NULL,?)", t, messstelle, w.anlage(),
                LocalDate.parse("2020-01-01"));
        w.komponenten().put(kennzeichen, komponente);
    }

    /** Ein Monat der Reihe einer Messstelle (AP-08 IP-5) — Version 1 der Verdichtung. */
    private static void monat(Welt w, String kennzeichen, LocalDate erster, String menge, boolean endgueltig) {
        Instant b = erster.atStartOfDay(ZONE).toInstant();
        Instant e = erster.plusMonths(1).atStartOfDay(ZONE).toInstant();
        int tage = erster.lengthOfMonth();
        long stunden = ChronoUnit.HOURS.between(b, e);
        root.update("INSERT INTO messreihe_periode (tag, art, tenant_id, entity_id, messkanal, zeitzone, zeitzone_herkunft, "
                + "beginn, ende, stunden, teile_erwartet, teile_vorhanden, teile_endgueltig, wertart, menge, menge_zustand, "
                + "kennzeichen, erhalten, erwartet, abdeckung_prozent, zustand, endgueltig_ab, version) VALUES (?, 'monat', "
                + "?, ?, ?, 'Europe/Berlin', 'vorgabe', ?, ?, ?, ?, ?, ?, 'counter', ?::numeric, 'vollständig', '[]'::jsonb, "
                + "?, ?, 100, ?, ?, 1)", erster, w.mandant(), w.komponenten().get(kennzeichen), ENERGIE, Timestamp.from(b),
                Timestamp.from(e), stunden, tage, tage, endgueltig ? tage : 0, menge, stunden * 60, stunden * 60,
                endgueltig ? "endgueltig" : "vorlaeufig", Timestamp.from(e.plus(Duration.ofDays(7))));
    }

    // ================================================================ das Referenzunternehmen

    /** Die {@code n}-te Bezugsfläche von Halle 2 im Referenzunternehmen — erfunden wird keine Zahl. */
    private static String flaecheAb(int n) {
        return String.valueOf(gebaeudeFlaeche(n).get("flaeche_m2").asInt());
    }

    private static String flaecheTag(int n) {
        return gebaeudeFlaeche(n).get("gueltig_ab").asText();
    }

    private static JsonNode gebaeudeFlaeche(int n) {
        for (JsonNode g : referenz.path("gebaeude")) {
            if ("G-2".equals(g.path("kennzeichen").asText())) {
                return g.path("bezugsflaechen").get(n);
            }
        }
        throw new AssertionError("G-2 steht nicht im Referenzunternehmen");
    }

    private static String referenzZahl(String kennzeichen, String feld) {
        for (JsonNode k : referenz.path("kennzahlen")) {
            if (kennzeichen.equals(k.path("kennzeichen").asText())) {
                return k.path(feld).asText();
            }
        }
        throw new AssertionError(kennzeichen + " steht nicht im Referenzunternehmen");
    }

    // ================================================================ die echten Schreibwege

    private Map<String, Object> anfrage(String kennzeichen, Welt w) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", kennzeichen);
        m.put("name", "Netzbezug je m² — Halle 2");
        m.put("rechenform", "quotient");
        m.put("geltung_art", "gebaeude");
        m.put("geltung_id", w.halle2().toString());
        m.put("eingaenge", List.of(e("zaehler", "messstelle", "MS-10"), e("nenner", "bezugsflaeche", "G-2")));
        return m;
    }

    private void anlegen(Welt w, String kennzeichen, UUID gebaeude) throws Exception {
        Antwort a = ruf(w, HttpMethod.POST, PFAD, anfrage(kennzeichen, w));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(201);
        w.kzIds().put(kennzeichen, UUID.fromString(a.body().get("id").asText()));
    }

    private static Map<String, Object> e(String rolle, String art, String kennzeichen) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("rolle", rolle);
        m.put("art", art);
        m.put("kennzeichen", kennzeichen);
        return m;
    }

    private Antwort ruf(Welt w, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(jwt().jwt(j -> {
                    j.subject("sub-ines-" + w.mandant());
                    j.claim("preferred_username", "Ines Kaltenbach");
                    j.claim("tenant_id", w.mandant().toString());
                }))
                .contentType(MediaType.APPLICATION_JSON);
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }

    private static JsonNode ok(Antwort a) {
        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        return a.body();
    }

    // ================================================================ lesen

    private static Map<String, Object> zeile(Welt w, String kennzahl, String art, LocalDate von) {
        List<Map<String, Object>> z = zeilen(w, kennzahl, art, von);
        assertThat(z).as(kennzahl + " " + art + " " + von + " hat eine Zeile").isNotEmpty();
        return z.get(z.size() - 1);
    }

    private static List<Map<String, Object>> zeilen(Welt w, String kennzahl, String art, LocalDate von) {
        return root.queryForList("SELECT w.id, w.version, w.wert, w.nenner, w.kennzeichen::text AS kennzeichen, "
                + "w.grund, w.zustand, w.anlass_art, w.anlass_kennung FROM kennzahl_wert w "
                + "JOIN kennzahl k ON k.id = w.kennzahl_id WHERE w.tenant_id = ? AND k.kennzeichen = ? "
                + "AND w.periode_art = ? AND w.periode_von = ? ORDER BY w.version NULLS FIRST, w.berechnet_am",
                w.mandant(), kennzahl, art, von);
    }

    private static List<Map<String, Object>> eingaenge(Map<String, Object> zeile) {
        return root.queryForList("SELECT position, rolle, art, objekt, wert, einheit, version, fassung, "
                + "kennzeichen::text AS kennzeichen FROM kennzahl_wert_eingang WHERE wert_id = ? ORDER BY position",
                zeile.get("id"));
    }

    private static String nenner(Map<String, Object> zeile) {
        Object n = zeile.get("nenner");
        return n == null ? null : new BigDecimal(String.valueOf(n)).stripTrailingZeros().toPlainString();
    }

    private static List<String> meldungen(Welt w) {
        return root.queryForList("SELECT nutzlast ->> 'ausloeser' FROM messreihe_ereignis WHERE tenant_id = ? "
                + "AND art = 'kennzahl_neu_gebildet' ORDER BY 1", String.class, w.mandant());
    }

    private static List<String> wirkung(Welt w) {
        return root.queryForList("SELECT anlass_kennung || ' ' || fassung || ' ' || ergebnis "
                + "FROM messreihe_kaskade_wirkung WHERE tenant_id = ? ORDER BY 1", String.class, w.mandant());
    }

    /** Alles, was ein Auslöser im Kundenbereich schreiben kann, Zeile für Zeile. */
    private static String tabellen(Welt w) {
        StringBuilder s = new StringBuilder();
        for (String tabelle : List.of("kennzahl_wert", "kennzahl_wert_eingang", "messreihe_ereignis",
                "messreihe_kaskade_wirkung", "messreihe_periode_version", "bezugsgroesse", "flaeche_gueltigkeit")) {
            s.append(tabelle).append('=').append(root.queryForObject("SELECT count(*) || ':' || coalesce(md5(string_agg("
                    + "t::text, '|' ORDER BY t::text)), '-') FROM " + tabelle + " t WHERE t.tenant_id = ?", String.class,
                    w.mandant())).append('\n');
        }
        return s.toString();
    }

    private static String vier(Object o) {
        if (o == null || o instanceof JsonNode n && n.isNull()) {
            return null;
        }
        String t = o instanceof JsonNode n ? n.asText() : String.valueOf(o);
        return new BigDecimal(t).setScale(4, RoundingMode.HALF_UP).toPlainString();
    }

    private static List<String> saetze(Object json) {
        try {
            return json == null ? List.of() : MAPPER.readValue(json.toString(), new TypeReference<List<String>>() {});
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }
}
