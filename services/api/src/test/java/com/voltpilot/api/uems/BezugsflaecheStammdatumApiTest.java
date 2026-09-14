package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.tenant.TenantContext;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
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
 * UEMS AP-09 IP-6 gegen die echte Kette: die Bezugsflächen werden aus der Ortsstruktur GELESEN
 * ({@code GET /api/v1/bezugsflaechen}, {@code bezugsflaechen} an der Liste der Bezugsgrößen), zum Stichtag
 * „letzter Tag der Periode“ (E17) mit den Übergängen als Kennzeichen (S3) — und die Stammdaten, die AP-09
 * selbst hält (Mitarbeitende, E15), bekommen ihre Route {@code GET/PUT /api/v1/bezugsgroessen/{id}/stammdatum}.
 *
 * <p>Die Flächen der Tests stehen dort, wo sie hingehören: in {@code flaeche_gueltigkeit} — B6 mit der
 * Eintragszeit des Referenzfalls direkt geschrieben, der Flächenwechsel mitten im Monat über die Route der
 * Ortsstruktur ({@code PUT /api/v1/orte/{id}/flaeche}). Keine Bezugsgrößen-Tabelle trägt je eine Fläche.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class BezugsflaecheStammdatumApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2", "bezugsdaten-vectors.json");
    private static final String FLAECHEN = "/api/v1/bezugsflaechen";
    private static final String BEZUGSGROESSEN = "/api/v1/bezugsgroessen";
    private static final String NB = " ";

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

    private static JdbcTemplate root;
    private static JsonNode vertrag;
    private static final AtomicInteger NR = new AtomicInteger();

    /** Ein Kundenbereich mit Werk Ahrenberg (ST-1), Halle 2 (G-2) und dem Bereich Halle 1 Nord (B-1, ohne Fläche). */
    private record Welt(UUID mandant, UUID unternehmen, UUID standort, UUID halle2, UUID bereich) {}

    private record Antwort(int status, JsonNode body) {}

    @BeforeAll
    static void verbinde() throws Exception {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        vertrag = MAPPER.readTree(VEKTOREN.toFile());
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }

    // ============================================================= B6: Plan-Abnahme 2

    /**
     * B6 (Plan-Abnahme 2): Halle 2 3 100 → 3 400 m² ab 01.01.2027, eingetragen am 15.01.2027. Der Nenner je
     * Monat ist der Wert am LETZTEN Tag — Oktober und Dezember 2026 bleiben 3 100 m², Januar 2027 liest 3 400 m²
     * mit dem Abzeichen „rückwirkend (14 Tage)“. Die Erwartung kommt aus der Vektor-Datei.
     */
    @Test
    void b6DerNennerJeMonatIstDerStandAmLetztenTag() throws Exception {
        Welt w = welt();
        flaecheB6(w);
        JsonNode soll = b6Pruefung("stammdatum").path("ergebnis");

        JsonNode halle = flaeche(ruf(w, HttpMethod.GET, FLAECHEN + "?periode_art=monat&von=2026-10-01&bis=2027-01-31", null),
                w.halle2());
        assertThat(felder(halle.path("bezugsflaeche"))).containsExactly("name", "wertart", "einheit", "herkunft_art",
                "geltung_art", "geltung_id", "geltung_kennzeichen", "geltung_name", "schreibbar", "pflegen");
        assertThat(halle.path("bezugsflaeche").path("geltung_kennzeichen").asText()).isEqualTo("G-2");
        assertThat(halle.path("bezugsflaeche").path("herkunft_art").asText()).isEqualTo("stammdatum_ap02");
        assertThat(halle.path("bezugsflaeche").path("schreibbar").asBoolean()).isFalse();
        assertThat(texte(halle.path("perioden").findValues("periode"))).containsExactly("2026-10", "2026-11", "2026-12", "2027-01");
        soll.path("je_periode").fields().forEachRemaining(e -> {
            JsonNode p = periode(halle, e.getKey());
            assertThat(p.path("betrag").asText()).as("Nenner " + e.getKey()).isEqualTo(e.getValue().asText());
            assertThat(p.path("stichtag").asText()).as("Stichtag " + e.getKey())
                    .isEqualTo(soll.path("stichtage").path(e.getKey()).asText());
            assertThat(texte(p.path("kennzeichen"))).as("kein Übergang in " + e.getKey()).isEmpty();
            assertThat(p.path("quelle").asText()).isEqualTo("eigen");
        });
        JsonNode januar = periode(halle, "2027-01");
        assertThat(januar.path("gilt_ab").asText()).isEqualTo("2027-01-01");
        assertThat(januar.path("eingetragen_am").asText()).isEqualTo("2027-01-15");
        assertThat(januar.path("abzeichen").asText()).isEqualTo("rückwirkend (" + soll.path("rueckwirkend_tage").asInt() + " Tage)");
        assertThat(periode(halle, "2026-10").path("abzeichen").isNull()).as("eingetragen vor dem Beginn").isTrue();

        // Der Standort hat keine eigene Fläche: die Summe seiner Gebäude, und er sagt es.
        JsonNode werk = flaeche(ruf(w, HttpMethod.GET, FLAECHEN + "?periode_art=monat&von=2026-10-01&bis=2027-01-31", null),
                w.standort());
        assertThat(periode(werk, "2027-01").path("betrag").asText()).isEqualTo("3400");
        assertThat(periode(werk, "2027-01").path("quelle").asText()).isEqualTo("aus_gebaeuden_summiert");
        assertThat(periode(werk, "2027-01").path("gilt_ab").isNull()).isTrue();
    }

    // ======================================================== S3: Wechsel mitten in der Periode

    /**
     * Die Fläche ändert sich am 15.03.2027 — eingetragen über die Route der ORTSSTRUKTUR. Das Lesemodell sieht sie
     * sofort (keine Kopie): März liest den Stand am 31.03. (3 500 m²) und nennt den Übergang; Februar bleibt
     * 3 400 m². Keine Tabelle der Bezugsgrößen hat dafür eine Zeile bekommen.
     */
    @Test
    void einFlaechenwechselMittenImMonatWirdGelesenUndGenannt() throws Exception {
        Welt w = welt();
        flaecheB6(w);
        String vorher = bezugsgroessenTabellen(w);
        Antwort gesetzt = ruf(w, HttpMethod.PUT, "/api/v1/orte/" + w.halle2() + "/flaeche",
                Map.of("m2", 3500, "gueltigAb", "2027-03-15"));
        assertThat(gesetzt.status()).as(gesetzt.body().toString()).isEqualTo(200);

        JsonNode halle = flaeche(ruf(w, HttpMethod.GET, FLAECHEN + "?periode_art=monat&von=2027-02-01&bis=2027-03-31", null),
                w.halle2());
        assertThat(periode(halle, "2027-02").path("betrag").asText()).isEqualTo("3400");
        assertThat(texte(periode(halle, "2027-02").path("kennzeichen"))).isEmpty();
        JsonNode maerz = periode(halle, "2027-03");
        assertThat(maerz.path("stichtag").asText()).isEqualTo("2027-03-31");
        assertThat(maerz.path("betrag").asText()).as("Stichtag = letzter Tag, nie ein Mittel").isEqualTo("3500");
        assertThat(maerz.path("gilt_ab").asText()).isEqualTo("2027-03-15");
        assertThat(texte(maerz.path("kennzeichen"))).containsExactly("Fläche geändert am 15.03.2027 (3.400 → 3.500" + NB + "m²)");

        // Die Jahres-Periode enthält beide Übergänge — in ihrer Reihenfolge.
        JsonNode jahr = periode(flaeche(ruf(w, HttpMethod.GET, FLAECHEN + "?periode_art=jahr&von=2027-01-01&bis=2027-12-31", null),
                w.halle2()), "2027");
        assertThat(jahr.path("betrag").asText()).isEqualTo("3500");
        assertThat(texte(jahr.path("kennzeichen"))).containsExactly("Fläche geändert am 15.03.2027 (3.400 → 3.500" + NB + "m²)");

        assertThat(bezugsgroessenTabellen(w)).as("die Fläche wird nirgends kopiert").isEqualTo(vorher);
        assertThat(root.queryForObject("SELECT count(*) FROM flaeche_gueltigkeit WHERE ort_id = ? AND aufgehoben_am IS NULL",
                Long.class, w.halle2())).isEqualTo(3);
    }

    // ============================================================== null, nie 0

    /** Vor dem ersten Tag einer Fläche ist der Nenner „nicht erhoben“ — {@code null}, nie 0 — und ein Objekt ohne jede Fläche ist keine Bezugsfläche. */
    @Test
    void eineFlaecheOhneGueltigkeitErgibtNullUndKeineNull() throws Exception {
        Welt w = welt();
        flaecheB6(w);
        Antwort a = ruf(w, HttpMethod.GET, FLAECHEN + "?periode_art=monat&von=2026-09-01&bis=2026-10-31", null);
        JsonNode halle = flaeche(a, w.halle2());
        JsonNode september = periode(halle, "2026-09");
        assertThat(september.path("betrag").isNull()).as("keine Fläche am 30.09.2026").isTrue();
        assertThat(september.path("quelle").isNull()).isTrue();
        assertThat(september.path("gilt_ab").isNull()).isTrue();
        assertThat(texte(september.path("kennzeichen"))).isEmpty();
        assertThat(periode(halle, "2026-10").path("betrag").asText()).isEqualTo("3100");
        assertThat(a.body().path("bezugsflaechen").findValues("geltung_id").stream().map(JsonNode::asText).toList())
                .as("der Bereich ohne Fläche ist keine Bezugsfläche").doesNotContain(w.bereich().toString());

        // Die Woche, in der die Fläche beginnt: gelesen der Stichtag, genannt der Beginn.
        JsonNode woche = periode(flaeche(ruf(w, HttpMethod.GET, FLAECHEN + "?periode_art=woche&von=2026-09-28&bis=2026-10-04", null),
                w.halle2()), "2026-W40");
        assertThat(woche.path("stichtag").asText()).isEqualTo("2026-10-04");
        assertThat(woche.path("betrag").asText()).isEqualTo("3100");
        assertThat(texte(woche.path("kennzeichen"))).containsExactly("Fläche erst ab 01.10.2026 erhoben (3.100" + NB + "m²)");

        // Ein Kundenbereich ohne Fläche: eine leere Liste, kein Fehler, keine Null-Fläche.
        Welt leer = welt();
        Antwort nichts = ruf(leer, HttpMethod.GET, FLAECHEN + "?periode_art=monat&von=2026-10-01&bis=2026-10-31", null);
        assertThat(nichts.status()).isEqualTo(200);
        assertThat(nichts.body().path("bezugsflaechen").size()).isZero();
    }

    // ======================================================= nicht schreibbar

    /**
     * Eine gelesene Bezugsfläche ist nicht schreibbar: die Route kennt keinen Schreibweg (405), eine Bezugsgröße
     * in m² wird nicht angelegt, und ein Stammdatum in m² — das es nur an der Anwendung vorbei geben könnte —
     * bekommt keinen Wert. Nach jedem Versuch sind Flächen und Bezugsgrößen Zeichen für Zeichen dieselben.
     */
    @Test
    void eineGeleseneBezugsflaecheIstNichtSchreibbar() throws Exception {
        Welt w = welt();
        flaecheB6(w);
        String vorher = bezugsgroessenTabellen(w) + flaechenTabelle(w);
        for (HttpMethod m : List.of(HttpMethod.PUT, HttpMethod.POST, HttpMethod.DELETE, HttpMethod.PATCH)) {
            Antwort a = ruf(w, m, FLAECHEN, Map.of("geltung_id", w.halle2().toString(), "wert", "9999"));
            assertThat(a.status()).as(m + " " + FLAECHEN).isEqualTo(405);
        }
        Antwort anlegen = ruf(w, HttpMethod.POST, BEZUGSGROESSEN, bezugsgroesse("Bezugsfläche Halle 2", "stammdatum", "m²",
                "gebaeude", w.halle2()));
        assertThat(anlegen.body().path("code").asText()).isEqualTo("flaeche_aus_struktur");
        assertThat(anlegen.status()).isEqualTo(422);
        assertThat(bezugsgroessenTabellen(w) + flaechenTabelle(w)).isEqualTo(vorher);

        // An der Anwendung vorbei angelegt: die Route schreibt ihr trotzdem keinen Wert.
        UUID vorbei = root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, "
                + "geltung_art, ort_id) VALUES (?, 'BZ-0099', 'Bezugsfläche Halle 2', 'stammdatum', 'm²', 'gebaeude', ?) "
                + "RETURNING id", UUID.class, w.mandant(), w.halle2());
        String mitVorbei = bezugsgroessenTabellen(w) + flaechenTabelle(w);
        Antwort wert = ruf(w, HttpMethod.PUT, BEZUGSGROESSEN + "/" + vorbei + "/stammdatum",
                Map.of("wert", "3400", "gueltig_ab", "2027-01-01"));
        assertThat(wert.body().path("code").asText()).isEqualTo("flaeche_aus_struktur");
        assertThat(wert.status()).isEqualTo(422);
        assertThat(bezugsgroessenTabellen(w) + flaechenTabelle(w)).isEqualTo(mitVorbei);

        // Die Liste der Bezugsgrößen zeigt die Fläche — ohne ID und Kennzeichen einer Bezugsgröße.
        JsonNode liste = ruf(w, HttpMethod.GET, BEZUGSGROESSEN, null).body();
        JsonNode halle = null;
        for (JsonNode f : liste.path("bezugsflaechen")) {
            if (f.path("geltung_id").asText().equals(w.halle2().toString())) {
                halle = f;
            }
        }
        assertThat(halle).isNotNull();
        assertThat(halle.has("id")).isFalse();
        assertThat(halle.has("kennzeichen")).isFalse();
        assertThat(halle.path("schreibbar").asBoolean()).isFalse();
        assertThat(halle.path("pflegen").asText()).isEqualTo(satz("flaeche_aus_struktur"));
    }

    // ============================================================== Mandantenzaun

    /** Fremd ist nicht da: keine fremde Fläche in der Liste, 404 auf ein fremdes Stammdatum — lesen wie schreiben. */
    @Test
    void derMandantenzaunHaelt() throws Exception {
        Welt a = welt();
        flaecheB6(a);
        UUID mitarbeitende = mitarbeitende(a);
        assertThat(ruf(a, HttpMethod.PUT, BEZUGSGROESSEN + "/" + mitarbeitende + "/stammdatum",
                Map.of("wert", "180", "gueltig_ab", "2026-01-01")).status()).isEqualTo(200);

        Welt b = welt();
        Antwort fremdeFlaechen = ruf(b, HttpMethod.GET, FLAECHEN + "?periode_art=monat&von=2026-10-01&bis=2027-01-31", null);
        assertThat(fremdeFlaechen.body().path("bezugsflaechen").size()).isZero();
        assertThat(ruf(b, HttpMethod.GET, BEZUGSGROESSEN, null).body().path("bezugsflaechen").size()).isZero();
        String vorher = bezugsgroessenTabellen(a);
        Antwort lesen = ruf(b, HttpMethod.GET, BEZUGSGROESSEN + "/" + mitarbeitende + "/stammdatum", null);
        assertThat(lesen.status()).isEqualTo(404);
        assertThat(lesen.body().path("code").asText()).isEqualTo("nicht_gefunden");
        Antwort schreiben = ruf(b, HttpMethod.PUT, BEZUGSGROESSEN + "/" + mitarbeitende + "/stammdatum",
                Map.of("wert", "999", "gueltig_ab", "2026-02-01"));
        assertThat(schreiben.status()).isEqualTo(404);
        assertThat(bezugsgroessenTabellen(a)).as("der fremde Versuch schreibt nichts").isEqualTo(vorher);
    }

    // ============================================================ E15: Mitarbeitende

    /**
     * E15/S4: 180 Mitarbeitende ab 01.01.2026, 185 ab 15.03.2026 (die 180 enden am 14.03.), am selben Tag
     * berichtigt auf 186 (die 185 bleiben aufgehoben lesbar), derselbe Wert später schreibt nichts. Je Vorgang
     * GENAU EIN Protokolleintrag mit „rückwirkend“; März liest 186 am 31.03. und nennt den Übergang — ein
     * Übergang am ERSTEN Tag einer Periode läge nicht in ihr (S3).
     */
    @Test
    void mitarbeitendeFolgenDemFlaechenMuster() throws Exception {
        Welt w = welt();
        UUID bg = mitarbeitende(w);
        ZoneId zone = ZoneId.of("Europe/Berlin");
        long tage = ChronoUnit.DAYS.between(LocalDate.of(2026, 1, 1), LocalDate.now(zone));

        Antwort erste = ruf(w, HttpMethod.PUT, BEZUGSGROESSEN + "/" + bg + "/stammdatum", Map.of("wert", "180", "gueltig_ab", "2026-01-01"));
        assertThat(erste.status()).as(erste.body().toString()).isEqualTo(200);
        assertThat(felder(erste.body())).containsExactly("bezugsgroesse_id", "kennzeichen", "name", "einheit", "zeitzone",
                "schreibbar", "intervalle", "periode_art", "von", "bis", "perioden");
        assertThat(erste.body().path("intervalle").get(0).path("abzeichen").asText())
                .isEqualTo("rückwirkend (" + tage + (tage == 1 ? " Tag)" : " Tage)"));

        ruf(w, HttpMethod.PUT, BEZUGSGROESSEN + "/" + bg + "/stammdatum", Map.of("wert", "185", "gueltig_ab", "2026-03-15"));
        Antwort korrektur = ruf(w, HttpMethod.PUT, BEZUGSGROESSEN + "/" + bg + "/stammdatum", Map.of("wert", "186", "gueltig_ab", "2026-03-15"));
        assertThat(intervalle(korrektur.body())).containsExactly(
                "180|2026-01-01|2026-03-14|wirksam", "185|2026-03-15|offen|aufgehoben", "186|2026-03-15|offen|wirksam");
        Antwort gleich = ruf(w, HttpMethod.PUT, BEZUGSGROESSEN + "/" + bg + "/stammdatum", Map.of("wert", "186.0", "gueltig_ab", "2026-04-01"));
        assertThat(intervalle(gleich.body())).isEqualTo(intervalle(korrektur.body()));
        assertThat(root.queryForList("SELECT art || ':' || rueckwirkend FROM bezugsgroesse_aenderung WHERE bezugsgroesse_id = ? "
                + "ORDER BY id", String.class, bg)).containsExactly("angelegt:false", "stammdatum_eingetragen:true",
                "stammdatum_eingetragen:true", "stammdatum_eingetragen:true");

        JsonNode mit = ruf(w, HttpMethod.GET, BEZUGSGROESSEN + "/" + bg + "/stammdatum?periode_art=monat&von=2026-02-01&bis=2026-03-31", null).body();
        assertThat(mit.path("perioden").get(0).path("betrag").asText()).isEqualTo("180");
        assertThat(texte(mit.path("perioden").get(0).path("kennzeichen"))).isEmpty();
        assertThat(mit.path("perioden").get(1).path("betrag").asText()).isEqualTo("186");
        assertThat(mit.path("perioden").get(1).path("stichtag").asText()).isEqualTo("2026-03-31");
        assertThat(texte(mit.path("perioden").get(1).path("kennzeichen")))
                .containsExactly("Mitarbeitende geändert am 15.03.2026 (180 → 186" + NB + "Personen)");
        JsonNode dezember = ruf(w, HttpMethod.GET, BEZUGSGROESSEN + "/" + bg + "/stammdatum?periode_art=monat&von=2025-12-01&bis=2025-12-31", null)
                .body().path("perioden").get(0);
        assertThat(dezember.path("betrag").isNull()).as("vor dem ersten Wert: null, nie 0").isTrue();

        // M1/M6: ein Stammdatum-Wert ist ein Wert.
        JsonNode bezugsgroesse = ruf(w, HttpMethod.GET, BEZUGSGROESSEN + "/" + bg, null).body();
        assertThat(bezugsgroesse.path("hat_werte").asBoolean()).isTrue();
        Map<String, Object> andereEinheit = bezugsgroesse("Mitarbeitende", "stammdatum", "Schichten", "unternehmen", w.unternehmen());
        andereEinheit.put("kennzeichen", bezugsgroesse.path("kennzeichen").asText());
        assertThat(ruf(w, HttpMethod.PUT, BEZUGSGROESSEN + "/" + bg, andereEinheit).body().path("code").asText())
                .isEqualTo("bedeutung_fest");
        assertThat(ruf(w, HttpMethod.DELETE, BEZUGSGROESSEN + "/" + bg, null).body().path("code").asText()).isEqualTo("hat_werte");
    }

    /** Die Ablehnungen der Stammdatum-Route in der Prüfreihenfolge des Vertrags — mit Kundensatz, und keine schreibt etwas. */
    @Test
    void dieStammdatumRouteLehntMitDenSaetzenDesVertragsAb() throws Exception {
        Welt w = welt();
        UUID bg = mitarbeitende(w);
        Antwort periodenwert = ruf(w, HttpMethod.POST, BEZUGSGROESSEN, mitPeriode(bezugsgroesse("Produktionsmenge Spritzguss",
                "periodenwert", "kg", "standort", w.standort()), "monat"));
        UUID pw = UUID.fromString(periodenwert.body().path("id").asText());
        String vorher = bezugsgroessenTabellen(w);

        abgelehnt(w, HttpMethod.PUT, BEZUGSGROESSEN + "/" + pw + "/stammdatum", Map.of("wert", "180", "gueltig_ab", "2026-01-01"),
                "kein_stammdatum");
        abgelehnt(w, HttpMethod.GET, BEZUGSGROESSEN + "/" + pw + "/stammdatum", null, "kein_stammdatum");
        abgelehnt(w, HttpMethod.PUT, BEZUGSGROESSEN + "/" + bg + "/stammdatum", Map.of("wert", "0", "gueltig_ab", "2026-01-01"),
                "wert_ungueltig");
        abgelehnt(w, HttpMethod.PUT, BEZUGSGROESSEN + "/" + bg + "/stammdatum", Map.of("wert", "180,5", "gueltig_ab", "2026-01-01"),
                "wert_ungueltig");
        abgelehnt(w, HttpMethod.PUT, BEZUGSGROESSEN + "/" + bg + "/stammdatum", Map.of("wert", 180, "gueltig_ab", "2026-01-01"),
                "anfrage_ungueltig");
        abgelehnt(w, HttpMethod.PUT, BEZUGSGROESSEN + "/" + bg + "/stammdatum", Map.of("wert", "180", "gueltigAb", "2026-01-01"),
                "anfrage_ungueltig");
        abgelehnt(w, HttpMethod.PUT, BEZUGSGROESSEN + "/" + bg + "/stammdatum", Map.of("wert", "180", "gueltig_ab", "01.01.2026"),
                "anfrage_ungueltig");
        abgelehnt(w, HttpMethod.PUT, BEZUGSGROESSEN + "/" + UUID.randomUUID() + "/stammdatum",
                Map.of("wert", "180", "gueltig_ab", "2026-01-01"), "nicht_gefunden");
        abgelehnt(w, HttpMethod.GET, FLAECHEN + "?periode_art=quartal&von=2026-01-01&bis=2026-03-31", null, "wort_unbekannt");
        abgelehnt(w, HttpMethod.GET, FLAECHEN + "?periode_art=monat&von=2026-03-01&bis=2026-01-31", null, "zeitraum_ungueltig");
        abgelehnt(w, HttpMethod.GET, FLAECHEN + "?periode_art=monat&von=2026-03-01", null, "anfrage_ungueltig");
        assertThat(bezugsgroessenTabellen(w)).isEqualTo(vorher);

        // M6 spricht vor der Wertart (Prüfreihenfolge `stammdatum`).
        ruf(w, HttpMethod.POST, BEZUGSGROESSEN + "/" + pw + "/archivieren", null);
        abgelehnt(w, HttpMethod.PUT, BEZUGSGROESSEN + "/" + pw + "/stammdatum", Map.of("wert", "0", "gueltig_ab", "2026-01-01"),
                "archiviert");
    }

    // ================================================================ Gerüst

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Bezugsflächen #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, "Kunststoffwerk Ahrenberg GmbH");
        UUID st = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        UUID g = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) "
                + "VALUES (?, 'gebaeude', 'Halle 2', 'G-2', 'aktiv') RETURNING id", UUID.class, t);
        UUID be = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) "
                + "VALUES (?, 'bereich', 'Halle 1 Nord', 'B-1', 'aktiv') RETURNING id", UUID.class, t);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES (?, ?, ?, '2026-01-01')",
                t, g, st);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_ort_id, gueltig_ab) VALUES (?, ?, ?, '2026-01-01')",
                t, be, g);
        return new Welt(t, u, st, g, be);
    }

    /** B6 so, wie die Ortsstruktur ihn gespeichert hätte — mit den Eintragszeiten des Referenzfalls. */
    private static void flaecheB6(Welt w) {
        root.update("INSERT INTO flaeche_gueltigkeit (tenant_id, ort_id, m2, gueltig_ab, gueltig_bis, created_at, created_by) "
                + "VALUES (?, ?, 3100, '2026-10-01', '2026-12-31', '2026-09-30 10:00+02', 'sub-ines')", w.mandant(), w.halle2());
        root.update("INSERT INTO flaeche_gueltigkeit (tenant_id, ort_id, m2, gueltig_ab, gueltig_bis, created_at, created_by) "
                + "VALUES (?, ?, 3400, '2027-01-01', NULL, '2027-01-15 14:40+01', 'sub-ines')", w.mandant(), w.halle2());
    }

    private UUID mitarbeitende(Welt w) throws Exception {
        Antwort a = ruf(w, HttpMethod.POST, BEZUGSGROESSEN, bezugsgroesse("Mitarbeitende", "stammdatum", "Personen",
                "unternehmen", w.unternehmen()));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(201);
        return UUID.fromString(a.body().path("id").asText());
    }

    private static Map<String, Object> bezugsgroesse(String name, String wertart, String einheit, String geltungArt, UUID geltung) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("name", name);
        m.put("wertart", wertart);
        m.put("einheit", einheit);
        m.put("periode_art", null);
        m.put("geltung_art", geltungArt);
        m.put("geltung_id", geltung.toString());
        return m;
    }

    private static Map<String, Object> mitPeriode(Map<String, Object> m, String periodeArt) {
        m.put("periode_art", periodeArt);
        return m;
    }

    /** Die erste Prüfung der Regel {@code regel} im Fall B6 der Vektor-Datei. */
    private static JsonNode b6Pruefung(String regel) {
        for (JsonNode fall : vertrag.path("cases")) {
            if ("B6".equals(fall.path("id").asText())) {
                for (JsonNode p : fall.path("pruefungen")) {
                    if (regel.equals(p.path("regel").asText())) {
                        return p;
                    }
                }
            }
        }
        throw new IllegalStateException("B6 · " + regel + " fehlt in der Vektor-Datei");
    }

    private static String satz(String code) {
        for (JsonNode a : vertrag.path("verwalten").path("ablehnungen")) {
            if (code.equals(a.path("code").asText())) {
                return a.path("satz").asText();
            }
        }
        throw new IllegalStateException("Code " + code + " fehlt im Vertrag");
    }

    private static JsonNode flaeche(Antwort a, UUID geltung) {
        assertThat(a.status()).as(a.body().toString()).isEqualTo(200);
        for (JsonNode f : a.body().path("bezugsflaechen")) {
            if (f.path("bezugsflaeche").path("geltung_id").asText().equals(geltung.toString())) {
                return f;
            }
        }
        throw new AssertionError("keine Bezugsfläche für " + geltung + " in " + a.body());
    }

    private static JsonNode periode(JsonNode flaeche, String periode) {
        for (JsonNode p : flaeche.path("perioden")) {
            if (periode.equals(p.path("periode").asText())) {
                return p;
            }
        }
        throw new AssertionError("keine Periode " + periode + " in " + flaeche);
    }

    private static List<String> intervalle(JsonNode stammdatum) {
        List<String> aus = new ArrayList<>();
        stammdatum.path("intervalle").forEach(i -> aus.add(i.path("wert").asText() + "|" + i.path("gueltig_ab").asText() + "|"
                + (i.path("gueltig_bis").isNull() ? "offen" : i.path("gueltig_bis").asText()) + "|"
                + (i.path("aufgehoben_am").isNull() ? "wirksam" : "aufgehoben")));
        return aus;
    }

    /** Die Tabellen der Bezugsgrößen des Kundenbereichs als Text. */
    private static String bezugsgroessenTabellen(Welt w) {
        return tabellen(w, List.of("bezugsgroesse", "bezugsgroesse_kennzeichen_verlauf", "bezugsgroesse_wert",
                "bezugsgroesse_stammdatum", "bezugsgroesse_aenderung"));
    }

    private static String flaechenTabelle(Welt w) {
        return tabellen(w, List.of("flaeche_gueltigkeit", "ort_aenderung"));
    }

    private static String tabellen(Welt w, List<String> namen) {
        StringBuilder s = new StringBuilder();
        for (String tabelle : namen) {
            s.append(tabelle).append('=').append(root.queryForObject("SELECT coalesce(string_agg(to_jsonb(t)::text, '|' "
                    + "ORDER BY to_jsonb(t)::text), '') FROM " + tabelle + " t WHERE tenant_id = ?", String.class, w.mandant()))
                    .append('\n');
        }
        return s.toString();
    }

    private void abgelehnt(Welt w, HttpMethod methode, String pfad, Object body, String code) throws Exception {
        Antwort a = ruf(w, methode, pfad, body);
        JsonNode soll = null;
        for (JsonNode x : vertrag.path("verwalten").path("ablehnungen")) {
            if (x.path("code").asText().equals(code)) {
                soll = x;
            }
        }
        assertThat(soll).as("Code " + code + " steht im Vertrag").isNotNull();
        assertThat(a.body().path("code").asText()).as(methode + " " + pfad + " → " + a.body()).isEqualTo(code);
        assertThat(a.status()).as(code).isEqualTo(soll.path("status").asInt());
        assertThat(a.body().path("message").asText()).as("Kundensatz " + code).isEqualTo(soll.path("satz").asText());
    }

    private static List<String> texte(JsonNode liste) {
        List<String> aus = new ArrayList<>();
        liste.forEach(x -> aus.add(x.asText()));
        return aus;
    }

    private static List<String> texte(List<JsonNode> liste) {
        return liste.stream().map(JsonNode::asText).toList();
    }

    private static List<String> felder(JsonNode n) {
        List<String> aus = new ArrayList<>();
        n.fieldNames().forEachRemaining(aus::add);
        return aus;
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
        JsonNode json;
        try {
            json = text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            json = NullNode.getInstance();
        }
        return new Antwort(r.getResponse().getStatus(), json);
    }
}
