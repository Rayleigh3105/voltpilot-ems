package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.components.ComponentConnectionReceipts;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import io.micrometer.core.instrument.MeterRegistry;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import org.yaml.snakeyaml.Yaml;

/**
 * Die Einstellungs-Fassungen je Quelle (UEMS AP-04 IP-11) Ende zu Ende gegen echtes Keycloak +
 * TimescaleDB: {@code GET/POST /api/v1/geraete/{id}/einstellungen} und der Hebel „Auf ×10 stellen"
 * im {@code PUT} der Komponente (W5).
 *
 * <p>Bewiesen wird der Prüfnachweis von IP-11:
 * <ul>
 *   <li><b>A4</b> — GR-2 Netzzähler 600/5 → 1000/5 A, im Gerät eingestellt, ab 15.01.2027 09:00:
 *       Fassung 2 gilt genau ab dort, die erste endet genau dort, der Folgen-Satz ist der des
 *       Vertrags, das Protokoll steht an GR-2 und an MS-01/MS-02 — und der ROLLUP-HASH aller
 *       gespeicherten Werte (Messreihen, Verdichtungen, Komponenten, ihre Fassungen, die Zustellung
 *       an die Box) ist vorher und nachher identisch.</li>
 *   <li><b>A5</b> — EK-2 (K-8.2 an C-1) 250/5 → 400/5 A, von VoltPilot angewendet, tatsächlich
 *       schon am 20.01.2027 getauscht: „angewendet — Zustellung ausstehend", geplant, der
 *       Folgen-Satz nennt den falsch erfassten Zeitraum, KEINE Änderung an der Box (keine
 *       Zustellung, keine Komponenten-Fassung), keine Neuberechnung (Hash identisch).</li>
 *   <li>die Regeln an der Schnittstelle: 409 Beginn belegt, 422 vor dem Beginn / nach dem Ausbau /
 *       tatsächlich-Zeitpunkt / keine Speisung, 400 unverändert / Zeitpunkt / Wert / Anfrage — und
 *       jede Ablehnung schreibt nichts;</li>
 *   <li>ein fremdes Gerät ist 404, nie 403;</li>
 *   <li>der Hebel: der PUT setzt {@code power_scale} weiter sofort und verlangt weiter den Test
 *       (ohne Beleg 422, dann auch keine Fassung); mit Beleg steht danach die Fassung 1 aus der
 *       bisherigen Verbindung („automatisch", seit Beginn) und die Fassung „×10, angewendet,
 *       gültig ab jetzt" mit dem Kunden als Urheber;</li>
 *   <li>der Hebel ist ABGESICHERT: scheitert der Einstellungs-Weg an der Datenbank, rollt nur sein
 *       Savepoint zurück — der PUT antwortet wie vorher, Verbindung, Komponenten-Fassung und
 *       Zustellung sind geschrieben, keine Einstellungs-Fassung, der Fehler-Zähler steigt um 1.</li>
 * </ul>
 *
 * <p>Die Ahrenberg-Werte kommen aus der Referenzdatei und den Fällen der Vektor-Datei
 * ({@code quelle-einstellung-vectors.json}); das Wandlerverhältnis von GR-2 nennt die Referenz
 * nicht — es ist die {@code annahme} des A4-Falls. Welche Messstellen eine Quelle speist, sagt die
 * Quellenbindung (IP-13, {@code messstelle_quelle}) — hier mit den führenden Quellen der Referenz
 * (MS-01/MS-02 ← K-3 an GR-2, MS-11 ← K-8.2 an C-1), eingetragen, wie IP-13 sie schreibt.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class QuelleEinstellungApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path CONTRACTS = Path.of("..", "..", "docs", "contracts");
    private static final String DEYE = "builtin:deye:sun-30k-sg01hp3";

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Container
    static final KeycloakContainer KEYCLOAK = new KeycloakContainer(
            "quay.io/keycloak/keycloak:26.0.5")
            .withRealmImportFile("keycloak/voltpilot-realm.json");

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

        String realm = KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot";
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> realm);
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> realm + "/protocol/openid-connect/certs");
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Autowired
    QuelleEinstellungService service;

    @Autowired
    ComponentConnectionReceipts receipts;

    @Autowired
    MeterRegistry metriken;

    private record Anrufer(String benutzer, UUID kundenbereich) {}

    private record Token(String wert, long geholt) {}

    private static final Anrufer DEMO = new Anrufer("demo", null);
    private static final Anrufer DEMO2 = new Anrufer("demo2", null);
    private static final Anrufer ADMIN_OHNE_KUNDENBEREICH = new Anrufer("admin", null);
    private static final Map<String, Token> TOKENS = new ConcurrentHashMap<>();

    private static JsonNode referenz;
    private static JsonNode vektoren;
    private static Map<String, Object> schemas;
    private static JdbcTemplate root;

    private static UUID ahrenberg;
    private static Anrufer ah;
    private static final Map<String, UUID> ANLAGEN = new LinkedHashMap<>();
    private static final Map<String, UUID> BOXEN = new LinkedHashMap<>();
    private static final Map<String, UUID> KOMPONENTEN = new LinkedHashMap<>();
    private static final Map<String, UUID> EINBAUTEN = new LinkedHashMap<>();
    private static final Map<String, UUID> MESSSTELLEN = new LinkedHashMap<>();

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void ladeVertrag() throws IOException {
        referenz = MAPPER.readTree(CONTRACTS.resolve("v2").resolve("uems-referenzunternehmen.json").toFile());
        vektoren = MAPPER.readTree(CONTRACTS.resolve("v2").resolve("quelle-einstellung-vectors.json").toFile());
        try (InputStream in = Files.newInputStream(CONTRACTS.resolve("openapi.yaml"))) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
        }
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    /** Einmal je Klasse, sobald der Spring-Kontext (und mit ihm Flyway) steht. */
    @BeforeEach
    void saeEinmal() {
        synchronized (QuelleEinstellungApiTest.class) {
            if (ahrenberg == null) {
                saeReferenz();
            }
        }
    }

    @AfterEach
    void uhrZurueck() {
        service.uhrStellen(Clock.systemUTC());
    }

    // ---- A4 ------------------------------------------------------------------------------

    /**
     * A4: GR-2 Netzzähler, Wandlerverhältnis 600/5 → 1000/5 A, im Gerät eingestellt, gültig ab
     * 15.01.2027 09:00, Begründung „Zählerplatz umgerüstet". Fassung 2 gilt ab dort; kein
     * gespeicherter Wert ändert sich (Rollup-Hash identisch); Protokoll an GR-2, MS-01 und MS-02;
     * „Stand am" zeigt vor 09:00 die erste, ab 09:00 die zweite Fassung.
     */
    @Test
    void aVierWandlerwechselAnGrZweiDokumentiertUndKeinGespeicherterWertAendertSich() {
        JsonNode fall = fall("fassung", "A4:");
        JsonNode in = fall.get("input");
        JsonNode exp = fall.get("expected");
        UUID gr2 = EINBAUTEN.get("GR-2");
        assertThat(zeit(in.get("beginn"))).isEqualTo(root.queryForObject("SELECT eingebaut_am FROM geraet WHERE id = ?",
                Timestamp.class, gr2).toInstant());
        String hashVorher = rollupHash();
        assertThat(hashVorher).isNotBlank();

        service.uhrStellen(Clock.fixed(zeit(in.get("jetzt")), ZoneOffset.UTC));
        JsonNode f1 = in.at("/bestehende/0");
        JsonNode erste = status(201, post(gr2, antrag(null, null, "wandler_strom", f1.get("wert"),
                f1.get("anwendung").asText(), f1.get("gueltig_ab").asText(), null, "Bestand dokumentiert")));
        assertThat(erste.at("/fassung/rueckwirkend").asBoolean()).as("nachgetragen seit dem Einbau").isTrue();
        assertThat(erste.get("beendet").isNull()).isTrue();

        JsonNode neu = in.get("neu");
        JsonNode a = status(201, post(gr2, antrag(null, null, neu.get("art").asText(), neu.get("wert"),
                neu.get("anwendung").asText(), neu.get("gueltig_ab").asText(), null, "Zählerplatz umgerüstet")));
        JsonNode fassung = a.get("fassung");
        assertThat(zeit(fassung.get("gueltig_ab"))).isEqualTo(zeit(exp.get("gueltig_ab")));
        assertThat(fassung.get("gueltig_bis").isNull()).isTrue();
        assertThat(fassung.get("rueckwirkend").asBoolean()).isEqualTo(exp.get("rueckwirkend").asBoolean());
        assertThat(fassung.get("wert_text").asText()).isEqualTo("1.000/5 A");
        assertThat(fassung.get("art_kundenwort").asText()).isEqualTo("Wandlerverhältnis Strom");
        assertThat(fassung.get("anwendung_text").asText()).isEqualTo("im Gerät eingestellt — dokumentiert");
        assertThat(fassung.get("zustellung").isNull()).as("dokumentiert: nichts zuzustellen").isTrue();
        assertThat(fassung.get("herkunft").asText()).isEqualTo("eintrag");
        assertThat(fassung.get("status").asText()).isEqualTo("gueltig");
        assertThat(fassung.get("begruendung").asText()).isEqualTo("Zählerplatz umgerüstet");
        assertThat(fassung.at("/eingetragen/art").asText()).isEqualTo("voltpilot");
        assertThat(fassung.at("/eingetragen/rolle").asText()).isEqualTo("voltpilot_betrieb");
        assertThat(zeit(a.at("/beendet/gueltig_bis"))).isEqualTo(zeit(exp.at("/beendet/gueltig_bis")));
        assertThat(a.at("/beendet/wert_text").asText()).isEqualTo("600/5 A");
        assertThat(texte(a.get("folgen"))).isEqualTo(texte(fall("folgen", "A4:").get("expected")));
        // Protokoll an der Quelle (die Fassung selbst) UND an beiden Messstellen des Zählers — je
        // ein Eintrag „einstellung_geaendert" mit „gilt ab", alt → neu und Begründung.
        assertThat(texte(a.get("messstellen"))).containsExactly("MS-01", "MS-02");
        for (String ms : List.of("MS-01", "MS-02")) {
            List<Map<String, Object>> eintraege = root.queryForList("SELECT gilt_ab, rueckwirkend, grund, "
                    + "alt::text AS alt, neu::text AS neu, actor_art FROM messstelle_aenderung WHERE messstelle_id = ? "
                    + "AND art = 'einstellung_geaendert' ORDER BY gilt_ab", MESSSTELLEN.get(ms));
            assertThat(eintraege).as(ms).hasSize(2);
            Map<String, Object> e = eintraege.get(1);
            assertThat(((Timestamp) e.get("gilt_ab")).toInstant()).isEqualTo(zeit(exp.get("gueltig_ab")));
            assertThat(e.get("rueckwirkend")).isEqualTo(false);
            assertThat(e.get("grund")).isEqualTo("Zählerplatz umgerüstet");
            assertThat(json(e.get("alt")).get("wert_text").asText()).isEqualTo("600/5 A");
            JsonNode neuImProtokoll = json(e.get("neu"));
            assertThat(neuImProtokoll.get("wert_text").asText()).isEqualTo("1.000/5 A");
            assertThat(neuImProtokoll.get("geraet").asText()).isEqualTo("GR-2");
            assertThat(neuImProtokoll.get("einstellung").asText()).isEqualTo(fassung.get("id").asText());
            assertThat(eintraege.get(0).get("alt")).as("die erste Fassung hatte keinen Vorgänger").isNull();
        }

        // „Stand am": vor 09:00 die erste, ab 09:00 die zweite — die Historie hat beide.
        JsonNode vor = status(200, get(gr2, "2027-01-15T07:59:00Z"));
        assertThat(vor.get("gueltig")).hasSize(1);
        assertThat(vor.at("/gueltig/0/wert_text").asText()).isEqualTo("600/5 A");
        JsonNode ab = status(200, get(gr2, "2027-01-15T08:00:00Z"));
        assertThat(ab.at("/gueltig/0/wert_text").asText()).isEqualTo("1.000/5 A");
        assertThat(ab.get("historie")).hasSize(2);
        assertThat(ab.get("geraet").asText()).isEqualTo("GR-2");
        assertThat(ab.get("einbau").asText()).isEqualTo("GR-2");

        JsonNode register = status(200, rufe(HttpMethod.GET,
                "/api/v1/messstellen?stichtag=2027-01-15T08:00:00Z", ah, null));
        for (String ms : List.of("MS-01", "MS-02")) {
            JsonNode zeile = element(register.get("register"), ms);
            assertThat(zeile.get("fakten")).as(ms).hasSize(1);
            assertThat(zeile.at("/fakten/0/art").asText()).isEqualTo("einstellung_geaendert");
            assertThat(zeit(zeile.at("/fakten/0/gilt_ab"))).isEqualTo(zeit(exp.get("gueltig_ab")));
        }

        // KEIN gespeicherter Wert hat sich geändert.
        assertThat(rollupHash()).isEqualTo(hashVorher);
    }

    // ---- A5 ------------------------------------------------------------------------------

    /**
     * A5: EK-2 (K-8.2 an C-1, → MS-11): 250/5 → 400/5 A, von VoltPilot angewendet, gültig ab dem
     * Tausch der Referenz (01.02.2027), tatsächlich schon am 20.01.2027 getauscht. Die Fassung steht
     * als „angekündigt, Zustellung ausstehend"; die Folgen-Karte nennt den falsch erfassten Zeitraum;
     * die Box bekommt nichts, nichts wird neu berechnet (Rollup-Hash identisch).
     */
    @Test
    void aFuenfAngewendeterWandlerfaktorWirktNurAbGueltigkeitsbeginnUndDieBoxBekommtNichts() {
        JsonNode fall = fall("fassung", "A5:");
        JsonNode in = fall.get("input");
        JsonNode exp = fall.get("expected");
        UUID c1 = EINBAUTEN.get("C-1");
        UUID k82 = KOMPONENTEN.get("K-8.2");
        JsonNode wandler = element(referenz.get("komponenten"), "K-8.2").get("wandler");
        String hashVorher = rollupHash();
        long zustellungenVorher = root.queryForObject("SELECT count(*) FROM component_activation_outbox "
                + "WHERE tenant_id = ?", Long.class, ahrenberg);

        service.uhrStellen(Clock.fixed(zeit(in.get("jetzt")), ZoneOffset.UTC));
        JsonNode f1 = wandler.get(0);
        status(201, post(c1, antrag(k82, null, "wandler_strom", wert(f1), "angewendet", f1.get("gueltig_ab").asText(),
                null, null)));
        JsonNode neu = in.get("neu");
        assertThat(zeit(neu.get("gueltig_ab"))).isEqualTo(zeit(wandler.get(1).get("gueltig_ab")));
        JsonNode a = status(201, post(c1, antrag(k82, null, "wandler_strom", wert(wandler.get(1)), "angewendet",
                neu.get("gueltig_ab").asText(), neu.get("tatsaechlich_ab").asText(), "Stromwandler EK-2 getauscht")));
        JsonNode fassung = a.get("fassung");
        assertThat(fassung.get("entity_id").asText()).isEqualTo(k82.toString());
        assertThat(zeit(fassung.get("gueltig_ab"))).isEqualTo(zeit(exp.get("gueltig_ab")));
        assertThat(fassung.get("status").asText()).as("angekündigt").isEqualTo("geplant");
        assertThat(fassung.get("zustellung").asText()).isEqualTo("ausstehend");
        assertThat(fassung.get("anwendung_text").asText()).isEqualTo("angewendet — Zustellung ausstehend");
        assertThat(fassung.get("rueckwirkend").asBoolean()).isFalse();
        assertThat(zeit(fassung.get("tatsaechlich_ab"))).isEqualTo(zeit(neu.get("tatsaechlich_ab")));
        assertThat(zeit(a.at("/beendet/gueltig_bis"))).isEqualTo(zeit(exp.at("/beendet/gueltig_bis")));
        assertThat(texte(a.get("folgen"))).isEqualTo(texte(fall("folgen", "A5:").get("expected")));
        assertThat(texte(a.get("messstellen"))).containsExactly("MS-11");
        assertThat(root.queryForObject("SELECT count(*) FROM messstelle_aenderung WHERE messstelle_id = ? "
                + "AND art = 'einstellung_geaendert'", Long.class, MESSSTELLEN.get("MS-11"))).isEqualTo(2L);

        JsonNode vorher = status(200, get(c1, "2027-01-31T22:59:00Z"));
        assertThat(vorher.at("/gueltig/0/wert_text").asText()).isEqualTo("250/5 A");
        JsonNode danach = status(200, get(c1, "2027-01-31T23:00:00Z"));
        assertThat(danach.at("/gueltig/0/wert_text").asText()).isEqualTo("400/5 A");
        assertThat(danach.at("/gueltig/0/zustellung").asText()).isEqualTo("ausstehend");

        // Keine Zustellung an die Box, keine Komponenten-Fassung, keine Neuberechnung.
        assertThat(root.queryForObject("SELECT count(*) FROM component_activation_outbox WHERE tenant_id = ?",
                Long.class, ahrenberg)).isEqualTo(zustellungenVorher);
        assertThat(rollupHash()).isEqualTo(hashVorher);
    }

    // ---- Die Regeln an der Schnittstelle ---------------------------------------------------

    /**
     * Jede Ablehnung trägt den Code des Vertrags (bzw. der Schnittstelle) mit seinem Status und
     * schreibt nichts; eine Fassung vor einer späteren legt sich dazwischen.
     */
    @Test
    void dieRegelnDerSchnittstelleUndJedeAblehnungSchreibtNichts() {
        UUID gr3 = EINBAUTEN.get("GR-3");
        service.uhrStellen(Clock.fixed(Instant.parse("2026-10-20T08:15:00Z"), ZoneOffset.UTC));
        JsonNode tausend = MAPPER.createObjectNode().put("impulse_je_kwh", 1000);
        JsonNode erste = status(201, post(gr3, antrag(null, null, "impulswertigkeit", tausend, "dokumentiert",
                "2024-03-12T00:00:00+01:00", null, null)));
        assertThat(erste.at("/fassung/rueckwirkend").asBoolean()).isTrue();
        long vorher = fassungenAn(gr3);

        abgelehnt(post(gr3, antrag(null, null, "impulswertigkeit", MAPPER.createObjectNode().put("impulse_je_kwh", 1000.0),
                "dokumentiert", "2026-01-01T00:00:00+01:00", null, null)), 400, "unveraendert");
        JsonNode belegt = abgelehnt(post(gr3, antrag(null, null, "impulswertigkeit",
                MAPPER.createObjectNode().put("impulse_je_kwh", 2000), "dokumentiert", "2024-03-12T00:00:00+01:00",
                null, null)), 409, "beginn_belegt");
        assertThat(belegt.at("/bestehend/wert_text").asText()).isEqualTo("1.000 Impulse je kWh");
        JsonNode frueh = abgelehnt(post(gr3, antrag(null, null, "impulswertigkeit",
                MAPPER.createObjectNode().put("impulse_je_kwh", 2000), "dokumentiert", "2024-03-11T23:59:00+01:00",
                null, null)), 422, "vor_beginn");
        assertThat(zeit(frueh.get("beginn"))).isEqualTo(Instant.parse("2024-03-11T23:00:00Z"));
        abgelehnt(post(gr3, antrag(null, null, "impulswertigkeit", MAPPER.createObjectNode().put("impulse_je_kwh", 2000),
                "dokumentiert", "2026-06-01T00:00:30+02:00", null, null)), 400, "zeitpunkt_ungueltig");
        abgelehnt(post(gr3, antrag(null, null, "impulswertigkeit", MAPPER.createObjectNode().put("impulse_je_kwh", 0),
                "dokumentiert", "2026-06-01T00:00:00+02:00", null, null)), 400, "wert_ungueltig");
        abgelehnt(post(gr3, antrag(null, null, "impulswertigkeit", MAPPER.createObjectNode().put("impulse_je_kwh", 2000),
                "dokumentiert", "2026-06-01T00:00:00+02:00", "2026-06-01T00:00:00+02:00", null)), 422,
                "tatsaechlich_ungueltig");
        ObjectNode fremdesFeld = antrag(null, null, "impulswertigkeit", tausend, "dokumentiert",
                "2026-06-01T00:00:00+02:00", null, null);
        fremdesFeld.put("gueltig_bis", "2026-07-01T00:00:00+02:00");
        assertThat(abgelehnt(post(gr3, fremdesFeld), 400, "anfrage_ungueltig").get("feld").asText())
                .isEqualTo("gueltig_bis");
        assertThat(abgelehnt(post(gr3, antrag(null, null, "phasenlage", tausend, "dokumentiert",
                "2026-06-01T00:00:00+02:00", null, null)), 400, "anfrage_ungueltig").get("feld").asText())
                .isEqualTo("art");
        assertThat(abgelehnt(post(gr3, antrag(null, "power_kw", "impulswertigkeit", tausend, "dokumentiert",
                "2026-06-01T00:00:00+02:00", null, null)), 400, "anfrage_ungueltig").get("feld").asText())
                .isEqualTo("kanal");
        // K-3 speist GR-2, nicht GR-3.
        abgelehnt(post(gr3, antrag(KOMPONENTEN.get("K-3"), null, "impulswertigkeit", tausend, "dokumentiert",
                "2026-06-01T00:00:00+02:00", null, null)), 422, "keine_speisung");
        // Z-5a ist seit dem Zählerwechsel ausgebaut (Referenz: 18.11.2026 10:40).
        JsonNode z5a = element(element(referenz.get("geraete"), "GR-4").get("einbauten"), "Z-5a");
        JsonNode ausgebaut = abgelehnt(post(EINBAUTEN.get("Z-5a"), antrag(null, null, "impulswertigkeit", tausend,
                "dokumentiert", z5a.get("gueltig_bis").asText(), null, null)), 422, "nach_ende");
        assertThat(zeit(ausgebaut.get("ende"))).isEqualTo(zeit(z5a.get("gueltig_bis")));
        assertThat(fassungenAn(gr3)).as("keine Ablehnung schreibt").isEqualTo(vorher);
        assertThat(root.queryForObject("SELECT count(*) FROM quelle_einstellung WHERE geraet_id = ?", Long.class,
                EINBAUTEN.get("Z-5a"))).isZero();

        // Später, dann dazwischen: die neue gilt bis zur nächsten.
        JsonNode spaeter = status(201, post(gr3, antrag(null, null, "impulswertigkeit",
                MAPPER.createObjectNode().put("impulse_je_kwh", 2000), "dokumentiert", "2026-06-01T00:00:00+02:00",
                null, null)));
        assertThat(zeit(spaeter.at("/beendet/gueltig_bis"))).isEqualTo(Instant.parse("2026-05-31T22:00:00Z"));
        JsonNode dazwischen = status(201, post(gr3, antrag(null, null, "impulswertigkeit",
                MAPPER.createObjectNode().put("impulse_je_kwh", 1500), "dokumentiert", "2025-01-01T00:00:00+01:00",
                null, null)));
        assertThat(zeit(dazwischen.at("/fassung/gueltig_bis"))).isEqualTo(Instant.parse("2026-05-31T22:00:00Z"));
        assertThat(zeit(dazwischen.at("/beendet/gueltig_bis"))).isEqualTo(Instant.parse("2024-12-31T23:00:00Z"));
        assertThat(texte(dazwischen.get("messstellen"))).as("GR-3 speist keine Messstelle der Referenz").isEmpty();

        // Ein Stichtag, der kein Zeitpunkt ist: 400 in derselben Form.
        assertThat(abgelehnt(rufe(HttpMethod.GET, "/api/v1/geraete/" + gr3 + "/einstellungen?stichtag=2026-06-01",
                ah, null), 400, "anfrage_ungueltig").get("feld").asText()).isEqualTo("stichtag");
    }

    // ---- Der Zaun ------------------------------------------------------------------------

    @Test
    void einFremdesGeraetIst404NieDer403() {
        UUID gr2 = EINBAUTEN.get("GR-2");
        ObjectNode a = antrag(null, null, "impulswertigkeit", MAPPER.createObjectNode().put("impulse_je_kwh", 1000),
                "dokumentiert", "2026-10-01T00:00:00+02:00", null, null);
        assertThat(rufe(HttpMethod.GET, "/api/v1/geraete/" + gr2 + "/einstellungen", DEMO2, null)
                .getStatusCode().value()).isEqualTo(404);
        assertThat(rufe(HttpMethod.POST, "/api/v1/geraete/" + gr2 + "/einstellungen", DEMO2, a)
                .getStatusCode().value()).isEqualTo(404);
        assertThat(rufe(HttpMethod.GET, "/api/v1/geraete/" + gr2 + "/einstellungen", ADMIN_OHNE_KUNDENBEREICH, null)
                .getStatusCode().value()).isEqualTo(404);
        assertThat(rufe(HttpMethod.GET, "/api/v1/geraete/" + UUID.randomUUID() + "/einstellungen", ah, null)
                .getStatusCode().value()).isEqualTo(404);
        assertThat(rufe(HttpMethod.GET, "/api/v1/geraete/" + gr2 + "/einstellungen", null, null)
                .getStatusCode().value()).isEqualTo(401);
        assertThat(root.queryForObject("SELECT count(*) FROM quelle_einstellung WHERE geraet_id = ? "
                + "AND art = 'impulswertigkeit'", Long.class, gr2)).isZero();
    }

    /** Die Antwort trägt genau die Felder der OpenAPI — auch die der Bestands-Fassung. */
    @Test
    void dieAntwortTraegtGenauDieFelderDerOpenApi() {
        JsonNode liste = status(200, get(EINBAUTEN.get("GR-3"), null));
        assertThat(felder(liste)).containsExactlyInAnyOrderElementsOf(eigenschaften("Einstellungen"));
        JsonNode antwort = status(201, post(EINBAUTEN.get("GR-5"), antrag(null, null, "zaehlerkonstante",
                MAPPER.createObjectNode().put("je_kwh", 375), "dokumentiert", "2026-10-01T00:00:00+02:00", null,
                null)));
        assertThat(felder(antwort)).containsExactlyInAnyOrderElementsOf(eigenschaften("EinstellungEingetragen"));
        assertThat(felder(antwort.get("fassung"))).containsExactlyInAnyOrderElementsOf(eigenschaften("EinstellungFassung"));
        assertThat(felder(antwort.at("/fassung/eingetragen")))
                .containsExactlyInAnyOrderElementsOf(eigenschaften("EinstellungEintrag"));
    }

    // ---- Der Hebel (W5) ------------------------------------------------------------------

    /**
     * Der Hebel „Auf ×10 stellen" ruft den PUT der Komponente mit {@code power_scale = "10"}.
     * Bisher: der Wert gilt sofort, der Verbindungstest bleibt Pflicht. Das bleibt — ohne Beleg 422
     * und dann auch KEINE Fassung. Mit Beleg steht danach in derselben Transaktion die Fassung 1 aus
     * der bisherigen Verbindung (Skalierung automatisch, beide Vorzeichen — seit Beginn der Speisung)
     * und die Fassung „×10, angewendet, gültig ab jetzt" mit dem Kunden als Urheber. Ein PUT ohne
     * geänderte Einstellung schreibt keine Fassung.
     */
    @Test
    void derHebelSchreibtEineFassungUndSonstBleibtDerPutWieErWar() throws Exception {
        String kunde = token("demo");
        UUID site = anlageAnlegen(kunde, "Hebel-Anlage");
        try {
            claim(kunde, site, "edge-einstellung-hebel-01");
            speicher(kunde, site);
            Map<String, Object> verbindung = deyeVerbindung();
            verbindung.put("power_scale", 0);
            verbindung.put("invert_grid_sign", false);
            verbindung.put("invert_batt_sign", false);
            receipts.record(site, DEYE, 1, verbindung);
            assertThat(komponentenRuf(HttpMethod.POST, "/api/v1/sites/" + site + "/components", kunde,
                    speichern(DEYE, "inverter", verbindung)).getStatusCode().value()).isEqualTo(200);
            JsonNode zeile = nachRolle(komponenten(kunde, site), "battery-hybrid");
            UUID komponente = UUID.fromString(zeile.get("id").asText());
            int fassungDerKomponente = zeile.get("definitionVersion").asInt();
            UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                    + "AND gueltig_bis IS NULL", UUID.class, komponente);
            assertThat(fassungenAn(geraet)).as("vor der ersten Änderung keine Fassung").isZero();

            // Der Hebel setzt das Feld auf „10" (Text, wie SKALIERUNG_X10 im Portal).
            Map<String, Object> x10 = new LinkedHashMap<>(verbindung);
            x10.put("power_scale", "10");
            Map<String, Object> bearbeiten = speichern(DEYE, "inverter", x10);
            bearbeiten.put("expectedRevision", fassungDerKomponente);
            ResponseEntity<String> ohneBeleg = komponentenRuf(HttpMethod.PUT, "/api/v1/sites/" + site + "/components/"
                    + komponente, kunde, bearbeiten);
            assertThat(ohneBeleg.getStatusCode().value()).as("die Testpflicht bleibt").isEqualTo(422);
            assertThat(fassungenAn(geraet)).as("abgelehnt: nichts geschrieben").isZero();

            receipts.record(site, DEYE, 1, x10);
            Instant vorher = Instant.now().truncatedTo(ChronoUnit.MINUTES);
            ResponseEntity<String> geaendert = komponentenRuf(HttpMethod.PUT, "/api/v1/sites/" + site + "/components/"
                    + komponente, kunde, bearbeiten);
            Instant nachher = Instant.now().truncatedTo(ChronoUnit.MINUTES).plus(1, ChronoUnit.MINUTES);
            assertThat(geaendert.getStatusCode().value()).isEqualTo(200);
            JsonNode neueZeile = nachRolle(MAPPER.readTree(geaendert.getBody()), "battery-hybrid");
            assertThat(neueZeile.at("/connection/power_scale").asText()).as("der Wert gilt sofort").isEqualTo("10");
            assertThat(neueZeile.get("definitionVersion").asInt()).isEqualTo(fassungDerKomponente + 1);
            assertThat(root.queryForObject("SELECT count(*) FROM component_activation_outbox WHERE entity_id = ? "
                    + "AND revision = ?", Long.class, komponente, fassungDerKomponente + 1))
                    .as("zugestellt wie bisher: über die Verbindung").isOne();

            JsonNode einstellungen = status(200, rufe(HttpMethod.GET, "/api/v1/geraete/" + geraet + "/einstellungen",
                    DEMO, null));
            Map<String, List<JsonNode>> je = new HashMap<>();
            for (JsonNode f : einstellungen.get("historie")) {
                je.computeIfAbsent(f.get("art").asText() + "|" + f.get("kanal").asText(""), x -> new ArrayList<>()).add(f);
            }
            List<JsonNode> skalierung = je.get("skalierung|");
            assertThat(skalierung).hasSize(2);
            JsonNode alt = skalierung.get(0);
            JsonNode hebel = skalierung.get(1);
            assertThat(alt.get("herkunft").asText()).isEqualTo("bestand");
            assertThat(alt.get("wert_text").asText()).isEqualTo("automatisch");
            assertThat(alt.get("zustellung").asText()).isEqualTo("verbindung");
            assertThat(alt.at("/eingetragen/von").asText()).isEqualTo("VoltPilot");
            assertThat(hebel.get("herkunft").asText()).isEqualTo("verbindung");
            assertThat(hebel.get("wert_text").asText()).isEqualTo("×10");
            assertThat(hebel.get("anwendung").asText()).isEqualTo("angewendet");
            assertThat(hebel.get("anwendung_text").asText()).isEqualTo("angewendet — mit der Verbindung zugestellt");
            assertThat(hebel.get("gueltig_bis").isNull()).isTrue();
            assertThat(hebel.get("rueckwirkend").asBoolean()).isFalse();
            assertThat(hebel.get("begruendung").asText()).isEqualTo(QuelleEinstellungService.GRUND_VERBINDUNG);
            assertThat(hebel.at("/eingetragen/von").asText()).isEqualTo("demo");
            assertThat(hebel.at("/eingetragen/art").asText()).isEqualTo("kunde");
            assertThat(hebel.at("/eingetragen/rolle").asText()).isEqualTo("kundenadministrator");
            Instant ab = zeit(hebel.get("gueltig_ab"));
            assertThat(ab).isBetween(vorher, nachher);
            assertThat(zeit(alt.get("gueltig_bis"))).as("die alte endet genau dort").isEqualTo(ab);
            assertThat(zeit(alt.get("gueltig_ab"))).isEqualTo(root.queryForObject("SELECT gueltig_ab FROM "
                    + "geraet_komponente WHERE entity_id = ? AND gueltig_bis IS NULL", Timestamp.class, komponente)
                    .toInstant());
            for (String kanal : List.of("power_kw", "battery_power_kw")) {
                List<JsonNode> vz = je.get("vorzeichen_umgekehrt|" + kanal);
                assertThat(vz).as(kanal).hasSize(1);
                assertThat(vz.get(0).get("wert_text").asText()).isEqualTo("nein");
                assertThat(vz.get(0).get("gueltig_bis").isNull()).isTrue();
            }

            // Nur der Name ändert sich: keine neue Fassung.
            long fassungen = fassungenAn(geraet);
            Map<String, Object> umbenennen = speichern(DEYE, "inverter", x10);
            umbenennen.put("label", "Hybrid Nord");
            umbenennen.put("expectedRevision", fassungDerKomponente + 1);
            assertThat(komponentenRuf(HttpMethod.PUT, "/api/v1/sites/" + site + "/components/" + komponente, kunde,
                    umbenennen).getStatusCode().value()).isEqualTo(200);
            assertThat(fassungenAn(geraet)).isEqualTo(fassungen);
        } finally {
            root.update("DELETE FROM site WHERE id = ?", site);
        }
    }

    /**
     * Die Absicherung des Hebels: ein Fehler der Datenbank im Einstellungs-Weg (hier ein
     * Test-Doppelgänger — ein Trigger, der jede Fassung dieser Komponente ablehnt, also genau eine
     * echte SQL-Ausnahme mitten in der Transaktion des PUT) rollt nur den Savepoint des
     * Einstellungs-Wegs zurück. Der PUT antwortet wie vorher (200, kein UnexpectedRollbackException),
     * die neue Verbindung, die Komponenten-Fassung und ihre Zustellung sind geschrieben, es steht
     * KEINE Einstellungs-Fassung da (auch nicht die Fassung 1 — derselbe Savepoint), und der Zähler
     * {@code voltpilot_einstellung_fassung_total{ergebnis="fehler"}} steigt um genau 1.
     */
    @Test
    void einFehlerImEinstellungswegLaesstDenPutSchreibenWieVorher() throws Exception {
        String kunde = token("demo");
        UUID site = anlageAnlegen(kunde, "Hebel-Absicherung");
        try {
            claim(kunde, site, "edge-einstellung-hebel-02");
            speicher(kunde, site);
            Map<String, Object> verbindung = deyeVerbindung();
            verbindung.put("power_scale", 0);
            receipts.record(site, DEYE, 1, verbindung);
            assertThat(komponentenRuf(HttpMethod.POST, "/api/v1/sites/" + site + "/components", kunde,
                    speichern(DEYE, "inverter", verbindung)).getStatusCode().value()).isEqualTo(200);
            JsonNode zeile = nachRolle(komponenten(kunde, site), "battery-hybrid");
            UUID komponente = UUID.fromString(zeile.get("id").asText());
            int fassungDerKomponente = zeile.get("definitionVersion").asInt();
            UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                    + "AND gueltig_bis IS NULL", UUID.class, komponente);

            root.execute("CREATE OR REPLACE FUNCTION test_einstellung_scheitert() RETURNS trigger "
                    + "LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity_id = '" + komponente + "'::uuid THEN "
                    + "RAISE EXCEPTION 'erzwungener Fehler im Einstellungs-Weg' USING ERRCODE = 'check_violation'; "
                    + "END IF; RETURN NEW; END $$");
            root.execute("CREATE TRIGGER test_einstellung_scheitert BEFORE INSERT ON quelle_einstellung "
                    + "FOR EACH ROW EXECUTE FUNCTION test_einstellung_scheitert()");
            try {
                double fehlerVorher = fehlerZaehler();
                Map<String, Object> x10 = new LinkedHashMap<>(verbindung);
                x10.put("power_scale", "10");
                receipts.record(site, DEYE, 1, x10);
                Map<String, Object> bearbeiten = speichern(DEYE, "inverter", x10);
                bearbeiten.put("expectedRevision", fassungDerKomponente);
                ResponseEntity<String> antwort = komponentenRuf(HttpMethod.PUT, "/api/v1/sites/" + site
                        + "/components/" + komponente, kunde, bearbeiten);

                assertThat(antwort.getStatusCode().value()).as(antwort.getBody()).isEqualTo(200);
                JsonNode neueZeile = nachRolle(MAPPER.readTree(antwort.getBody()), "battery-hybrid");
                assertThat(neueZeile.at("/connection/power_scale").asText()).isEqualTo("10");
                assertThat(neueZeile.get("definitionVersion").asInt()).isEqualTo(fassungDerKomponente + 1);
                assertThat(root.queryForObject("SELECT connection_json ->> 'power_scale' FROM measurement_point "
                        + "WHERE id = ?", String.class, komponente)).as("gespeichert, nicht nur geantwortet")
                        .isEqualTo("10");
                assertThat(root.queryForObject("SELECT count(*) FROM component_activation_outbox WHERE entity_id = ? "
                        + "AND revision = ?", Long.class, komponente, fassungDerKomponente + 1)).isOne();
                assertThat(fassungenAn(geraet)).as("der Savepoint ist zurückgerollt").isZero();
                assertThat(fehlerZaehler()).isEqualTo(fehlerVorher + 1);
            } finally {
                root.execute("DROP TRIGGER IF EXISTS test_einstellung_scheitert ON quelle_einstellung");
                root.execute("DROP FUNCTION IF EXISTS test_einstellung_scheitert()");
            }
        } finally {
            root.update("DELETE FROM site WHERE id = ?", site);
        }
    }

    private double fehlerZaehler() {
        return metriken.get(QuelleEinstellungService.ZAEHLER).tag("ergebnis", "fehler").counter().count();
    }

    // ---- Gerüst: das Referenzunternehmen -----------------------------------------------------

    /**
     * AN-1 mit K-1 (GR-1), K-3 (GR-2), K-4 (GR-3), K-5 (GR-4 mit dem Zählerwechsel Z-5a → Z-5b), K-6
     * (GR-5), K-7 (GR-6);
     * AN-2 mit C-1 (GR-7) und EK-1 … EK-4; die Messstellen MS-01, MS-02 und MS-11 der Referenz; dazu
     * Messreihen und Verdichtungen an K-3 und K-8.2 für den Rollup-Hash.
     */
    private static void saeReferenz() {
        ahrenberg = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                referenz.at("/unternehmen/name").asText());
        ah = new Anrufer("admin", ahrenberg);
        for (String a : List.of("AN-1", "AN-2")) {
            JsonNode anlage = element(referenz.get("anlagen"), a);
            ANLAGEN.put(a, root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) "
                    + "RETURNING id", UUID.class, ahrenberg, anlage.get("name").asText(), ts(anlage.get("seit"))));
        }
        for (String b : List.of("E-1", "E-2")) {
            JsonNode box = element(referenz.get("boxen"), b);
            BOXEN.put(b, root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, created_at) "
                    + "VALUES (?, ?, ?, ?) RETURNING id", UUID.class, ahrenberg,
                    ANLAGEN.get(box.get("heimat_anlage").asText()), box.get("seriennummer").asText(),
                    ts(box.get("in_betrieb_ab"))));
        }
        // In der Reihenfolge der Referenz: der Anlege-Weg vergibt GR-1 … GR-6 genau wie dort.
        for (String k : List.of("K-1", "K-3", "K-4", "K-5", "K-6", "K-7")) {
            JsonNode komponente = element(referenz.get("komponenten"), k);
            JsonNode geraet = element(referenz.get("geraete"), komponente.get("geraet").asText());
            JsonNode quelle = element(referenz.get("datenquellen"), geraet.get("datenquelle").asText());
            ObjectNode verbindung = MAPPER.createObjectNode().put("ip", quelle.get("adresse").asText())
                    .put("port", quelle.get("port").asInt()).put("unit_id", geraet.get("modbus_geraete_id").asInt());
            String art = "K-1".equals(k) ? "battery-hybrid" : "K-3".equals(k) ? "grid-meter" : "modbus-generic";
            UUID id = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                    + "device_id, control, communication, connection_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, "
                    + "?::jsonb, ?) RETURNING id", UUID.class, ahrenberg, ANLAGEN.get("AN-1"), art,
                    komponente.get("name").asText(), art, BOXEN.get("E-1"), "battery-hybrid".equals(art),
                    "K-1".equals(k) ? "sunspec_tcp" : "modbus_tcp", verbindung.toString(),
                    ts(komponente.get("in_betrieb_ab")));
            KOMPONENTEN.put(k, id);
            Map<String, Object> einbau = root.queryForMap("SELECT g.id, g.kennzeichen FROM geraet_komponente v "
                    + "JOIN geraet g ON g.id = v.geraet_id WHERE v.entity_id = ?", id);
            assertThat(einbau.get("kennzeichen")).as(k).isEqualTo(geraet.get("kennzeichen").asText());
            EINBAUTEN.put(komponente.get("geraet").asText(), (UUID) einbau.get("id"));
        }
        // Der Zählerwechsel an K-5: Z-5a endet, Z-5b beginnt — so, wie IP-17 ihn schreiben wird.
        JsonNode gr4 = element(referenz.get("geraete"), "GR-4");
        JsonNode z5a = element(gr4.get("einbauten"), "Z-5a");
        JsonNode z5b = element(gr4.get("einbauten"), "Z-5b");
        UUID alt = EINBAUTEN.get("GR-4");
        root.update("UPDATE geraet SET einbau_kennzeichen = ?, seriennummer = ?, ausgebaut_am = ? WHERE id = ?",
                z5a.get("kennzeichen").asText(), z5a.get("seriennummer").asText(), ts(z5a.get("gueltig_bis")), alt);
        root.update("UPDATE geraet_komponente SET gueltig_bis = ? WHERE geraet_id = ?", ts(z5a.get("gueltig_bis")), alt);
        UUID neu = root.queryForObject("INSERT INTO geraet (tenant_id, site_id, kennzeichen, einbau_kennzeichen, "
                + "geraeteart, seriennummer, geraete_id, eingebaut_am) VALUES (?, ?, 'GR-4', ?, 'zaehler', ?, ?, ?) "
                + "RETURNING id", UUID.class, ahrenberg, ANLAGEN.get("AN-1"), z5b.get("kennzeichen").asText(),
                z5b.get("seriennummer").asText(), gr4.get("modbus_geraete_id").asInt(), ts(z5b.get("gueltig_ab")));
        root.update("INSERT INTO geraet_komponente (tenant_id, geraet_id, entity_id, gueltig_ab) VALUES (?, ?, ?, ?)",
                ahrenberg, neu, KOMPONENTEN.get("K-5"), ts(z5b.get("gueltig_ab")));
        EINBAUTEN.put("Z-5a", alt);
        EINBAUTEN.put("Z-5b", neu);

        // GR-7: der WAGO-Controller C-1 mit EK-1 … EK-4 — je Karte eine Komponente, gespeist über die Karte.
        JsonNode gr7 = element(referenz.get("geraete"), "GR-7");
        Timestamp ab = ts(gr7.at("/einbauten/0/gueltig_ab"));
        UUID c1 = root.queryForObject("INSERT INTO geraet (tenant_id, site_id, kennzeichen, einbau_kennzeichen, "
                + "geraeteart, hersteller, typ, geraete_id, eingebaut_am) VALUES (?, ?, uems_geraet_kennzeichen(?), ?, "
                + "'controller', ?, ?, ?, ?) RETURNING id", UUID.class, ahrenberg, ANLAGEN.get("AN-2"), ahrenberg,
                gr7.at("/einbauten/0/kennzeichen").asText(), gr7.get("hersteller").asText(), gr7.get("typ").asText(),
                gr7.get("modbus_geraete_id").asInt(), ab);
        EINBAUTEN.put("C-1", c1);
        int ek = 0;
        for (String k : List.of("K-8.1", "K-8.2", "K-8.3", "K-8.4")) {
            JsonNode komponente = element(referenz.get("komponenten"), k);
            UUID karte = root.queryForObject("INSERT INTO geraet_teil (tenant_id, geraet_id, steckplatz, bezeichnung, "
                    + "typ, eingebaut_am) VALUES (?, ?, ?, ?, ?, ?) RETURNING id", UUID.class, ahrenberg, c1,
                    komponente.get("steckplatz").asInt(), "EK-" + (++ek), komponente.get("kartentyp").asText(), ab);
            UUID id = root.queryForObject("WITH k AS (INSERT INTO measurement_point (tenant_id, site_id, role, "
                    + "label, entity_type, device_id, created_at) VALUES (?, ?, 'modbus-generic', ?, 'modbus-generic', "
                    + "?, ?) RETURNING id) INSERT INTO geraet_komponente (tenant_id, geraet_id, entity_id, teil_id, "
                    + "gueltig_ab) SELECT ?, ?, k.id, ?, ? FROM k RETURNING entity_id", UUID.class, ahrenberg,
                    ANLAGEN.get("AN-2"), komponente.get("name").asText(), BOXEN.get("E-2"),
                    ts(komponente.get("in_betrieb_ab")), ahrenberg, c1, karte, ab);
            KOMPONENTEN.put(k, id);
        }

        // Die Messstellen der Referenz, die aus K-3 und K-8.2 lesen.
        for (String ms : List.of("MS-01", "MS-02", "MS-11")) {
            JsonNode m = element(referenz.get("messstellen"), ms);
            JsonNode g = m.get("hauptgroesse");
            MESSSTELLEN.put(ms, root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, "
                    + "groesse, richtung, einheit, wertart) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id", UUID.class,
                    ahrenberg, ms, m.get("name").asText(), m.get("art").asText(), m.get("medium").asText(),
                    g.get("groesse").asText(), g.get("richtung").asText(), g.get("einheit").asText(),
                    g.get("wertart").asText()));
        }
        // Ihre führenden Quellen, wie IP-13 sie schreibt: Komponente + Einbau + Kanal ab dem Beginn der
        // Referenz (fuehrende_quelle) — die Kanalnamen sind die Messwerte der Mess-Selektion.
        binde("MS-01", "K-3", EINBAUTEN.get("GR-2"), "sunspec.model_203.totwhimp");
        binde("MS-02", "K-3", EINBAUTEN.get("GR-2"), "sunspec.model_203.totwhexp");
        binde("MS-11", "K-8.2", c1, "wago.energiekarte.wirkenergie_bezug");

        // Gespeicherte Werte vor und nach den Wechseln — sie dürfen sich nie ändern.
        for (Object[] reihe : new Object[][] {{"K-3", "AN-1", "E-1", "power_kw"}, {"K-8.2", "AN-2", "E-2", "power_kw"}}) {
            UUID entity = KOMPONENTEN.get((String) reihe[0]);
            for (String t : List.of("2027-01-15T07:45:00Z", "2027-01-15T08:15:00Z", "2027-01-25T09:00:00Z",
                    "2027-01-31T23:15:00Z")) {
                root.update("INSERT INTO telemetry_v2 (time, received_at, tenant_id, site_id, device_id, entity_id, "
                        + "channel, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", Timestamp.from(Instant.parse(t)),
                        Timestamp.from(Instant.parse(t)), ahrenberg, ANLAGEN.get((String) reihe[1]),
                        BOXEN.get((String) reihe[2]), entity.toString(), reihe[3], 12.5);
            }
            for (String tag : List.of("2027-01-14T23:00:00Z", "2027-01-31T23:00:00Z")) {
                root.update("INSERT INTO telemetry_v2_rollup_1d (bucket, tenant_id, site_id, entity_id, channel, "
                        + "avg_value, min_value, max_value, last_value, n_samples) VALUES (?, ?, ?, ?, ?, 12, 3, 40, "
                        + "15, 96)", Timestamp.from(Instant.parse(tag)), ahrenberg, ANLAGEN.get((String) reihe[1]),
                        entity.toString(), reihe[3]);
            }
        }
    }

    /** Eine führende Quellenbindung der Referenz, ab dem Beginn ihrer {@code fuehrende_quelle}. */
    private static void binde(String messstelle, String komponente, UUID einbau, String kanal) {
        JsonNode m = element(referenz.get("messstellen"), messstelle);
        JsonNode g = m.get("hauptgroesse");
        JsonNode quelle = m.at("/fuehrende_quelle/0");
        assertThat(quelle.get("komponente").asText()).isEqualTo(komponente);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_name, "
                + "actor_art) VALUES (?, ?, ?, ?, ?, ?, ?, 'counter', 'zaehlerstand', 'fuehrend', ?, false, ?, "
                + "'VoltPilot', 'voltpilot')", ahrenberg, MESSSTELLEN.get(messstelle), g.get("groesse").asText(),
                g.get("richtung").asText(), KOMPONENTEN.get(komponente), einbau, kanal, ts(quelle.get("gueltig_ab")),
                ts(quelle.get("gueltig_ab")));
    }

    private static JsonNode json(Object text) {
        try {
            return MAPPER.readTree((String) text);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * Der Rollup-Hash des Kundenbereichs: je Tabelle mit gespeicherten Werten ein md5 über jede
     * Zeile — Messreihen und ihre Verdichtungen, Komponenten mit Verbindung, Komponenten-Fassungen,
     * Mess-Selektion, die Zustellungen an die Box und die Geräte.
     */
    private static String rollupHash() {
        StringBuilder s = new StringBuilder();
        for (String t : List.of("telemetry_v2", "telemetry_v2_rollup_15m", "telemetry_v2_rollup_1h",
                "telemetry_v2_rollup_1d", "device_measurement_sample", "device_measurement_rollup_5m",
                "device_measurement_rollup_15m", "measurement_point", "component_definition",
                "component_activation_outbox", "device_measurement_selection", "geraet", "geraet_komponente")) {
            if (root.queryForObject("SELECT to_regclass(?) IS NOT NULL", Boolean.class, t)) {
                s.append(t).append('=').append(root.queryForObject("SELECT md5(coalesce(string_agg(z, E'\\n' ORDER BY z), "
                        + "'')) FROM (SELECT to_jsonb(x)::text AS z FROM " + t + " x WHERE x.tenant_id = ?) AS zeilen",
                        String.class, ahrenberg)).append('\n');
            }
        }
        return s.toString();
    }

    private static long fassungenAn(UUID geraet) {
        return root.queryForObject("SELECT count(*) FROM quelle_einstellung WHERE geraet_id = ?", Long.class, geraet);
    }

    // ---- Gerüst: Anträge und Antworten -----------------------------------------------------

    private static ObjectNode antrag(UUID komponente, String kanal, String art, JsonNode wert, String anwendung,
            String gueltigAb, String tatsaechlichAb, String begruendung) {
        ObjectNode a = MAPPER.createObjectNode();
        if (komponente != null) {
            a.put("entity_id", komponente.toString());
        }
        if (kanal != null) {
            a.put("kanal", kanal);
        }
        a.put("art", art);
        a.set("wert", wert);
        a.put("anwendung", anwendung);
        a.put("gueltig_ab", gueltigAb);
        if (tatsaechlichAb != null) {
            a.put("tatsaechlich_ab", tatsaechlichAb);
        }
        if (begruendung != null) {
            a.put("begruendung", begruendung);
        }
        return a;
    }

    /** Der Wandler einer Karte der Referenz als Wert der Art {@code wandler_strom}. */
    private static JsonNode wert(JsonNode wandler) {
        return MAPPER.createObjectNode().put("primaer_a", wandler.get("primaer_a").decimalValue())
                .put("sekundaer_a", wandler.get("sekundaer_a").decimalValue());
    }

    private ResponseEntity<JsonNode> post(UUID geraet, JsonNode antrag) {
        return rufe(HttpMethod.POST, "/api/v1/geraete/" + geraet + "/einstellungen", ah, antrag);
    }

    private ResponseEntity<JsonNode> get(UUID geraet, String stichtag) {
        return rufe(HttpMethod.GET, "/api/v1/geraete/" + geraet + "/einstellungen"
                + (stichtag == null ? "" : "?stichtag=" + stichtag), ah, null);
    }

    private ResponseEntity<JsonNode> rufe(HttpMethod methode, String pfad, Anrufer wer, Object rumpf) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        if (wer != null) {
            headers.setBearerAuth(token(wer.benutzer()));
            if (wer.kundenbereich() != null) {
                headers.set("X-Tenant-Id", wer.kundenbereich().toString());
            }
        }
        return rest.exchange("http://localhost:" + port + pfad, methode, new HttpEntity<>(rumpf, headers),
                JsonNode.class);
    }

    private static JsonNode status(int soll, ResponseEntity<JsonNode> r) {
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(soll);
        return r.getBody();
    }

    private static JsonNode abgelehnt(ResponseEntity<JsonNode> r, int soll, String code) {
        JsonNode body = status(soll, r);
        assertThat(body.get("code").asText()).as(body.toString()).isEqualTo(code);
        assertThat(body.get("message").asText()).isNotBlank();
        return body;
    }

    private static JsonNode fall(String familie, String namensanfang) {
        for (JsonNode c : vektoren.at("/cases/" + familie)) {
            if (c.get("name").asText().startsWith(namensanfang)) {
                return c;
            }
        }
        throw new AssertionError("kein Fall " + namensanfang + " in " + familie);
    }

    private static List<String> texte(JsonNode arr) {
        List<String> out = new ArrayList<>();
        arr.forEach(n -> out.add(n.asText()));
        return out;
    }

    private static List<String> felder(JsonNode n) {
        List<String> f = new ArrayList<>();
        n.fieldNames().forEachRemaining(f::add);
        return f;
    }

    @SuppressWarnings("unchecked")
    private static List<String> eigenschaften(String schema) {
        Map<String, Object> s = (Map<String, Object>) schemas.get(schema);
        assertThat(s).as(schema).isNotNull();
        return new ArrayList<>(((Map<String, Object>) s.get("properties")).keySet());
    }

    private static JsonNode element(JsonNode liste, String kennzeichen) {
        for (JsonNode e : liste) {
            if (kennzeichen.equals(e.get("kennzeichen").asText())) {
                return e;
            }
        }
        throw new AssertionError("nicht in der Referenzdatei: " + kennzeichen);
    }

    private static Instant zeit(JsonNode n) {
        return OffsetDateTime.parse(n.asText()).toInstant();
    }

    private static Timestamp ts(JsonNode n) {
        return Timestamp.from(zeit(n));
    }

    // ---- Gerüst: der Weg des Hebels (wie ComponentApiTest) ---------------------------------

    private static Map<String, Object> deyeVerbindung() {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("ip", "192.168.0.28");
        c.put("port", 8899);
        c.put("serial", "2985159064");
        c.put("mb_slave_id", 1);
        return c;
    }

    private static Map<String, Object> speichern(String vorlage, String rolle, Map<String, Object> verbindung) {
        Map<String, Object> body = new HashMap<>();
        body.put("templateRef", vorlage);
        body.put("role", rolle);
        body.put("connection", verbindung);
        return body;
    }

    private ResponseEntity<String> komponentenRuf(HttpMethod methode, String pfad, String token, Object rumpf) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return rest.exchange("http://localhost:" + port + pfad, methode, new HttpEntity<>(rumpf, headers), String.class);
    }

    private JsonNode komponenten(String token, UUID site) throws IOException {
        ResponseEntity<String> r = komponentenRuf(HttpMethod.GET, "/api/v1/sites/" + site + "/components", token, null);
        assertThat(r.getStatusCode().value()).isEqualTo(200);
        return MAPPER.readTree(r.getBody());
    }

    private static JsonNode nachRolle(JsonNode antwort, String rolle) {
        for (JsonNode z : antwort.get("components")) {
            if (rolle.equals(z.path("role").asText())) {
                return z;
            }
        }
        throw new AssertionError("keine Komponente mit Rolle " + rolle);
    }

    private UUID anlageAnlegen(String token, String name) {
        ResponseEntity<Map<String, Object>> r = rest.exchange("http://localhost:" + port + "/api/v1/sites",
                HttpMethod.POST, new HttpEntity<>(Map.of("name", name), bearer(token)),
                new ParameterizedTypeReference<>() {});
        assertThat(r.getStatusCode().value()).isEqualTo(201);
        return UUID.fromString((String) r.getBody().get("id"));
    }

    private void claim(String token, UUID site, String ref) {
        ResponseEntity<Map<String, Object>> r = rest.exchange("http://localhost:" + port + "/api/v1/devices/claim",
                HttpMethod.POST, new HttpEntity<>(Map.of("externalRef", ref, "siteId", site.toString(),
                        "kind", "inverter"), bearer(token)), new ParameterizedTypeReference<>() {});
        assertThat(r.getStatusCode().value()).isIn(200, 201);
    }

    private void speicher(String token, UUID site) {
        ResponseEntity<String> r = rest.exchange("http://localhost:" + port + "/api/v1/sites/" + site + "/battery",
                HttpMethod.PUT, new HttpEntity<>(Map.of("capacityKwh", 30, "maxChargeKw", 15, "maxDischargeKw", 15),
                        bearer(token)), String.class);
        assertThat(r.getStatusCode().value()).isEqualTo(200);
    }

    private HttpHeaders bearer(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return headers;
    }

    private String token(String benutzer) {
        Token t = TOKENS.get(benutzer);
        if (t != null && System.currentTimeMillis() - t.geholt() < 5 * 60_000) {
            return t.wert();
        }
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", "voltpilot-api");
        form.add("client_secret", "voltpilot-api-dev-secret");
        form.add("username", benutzer);
        form.add("password", benutzer);
        form.add("scope", "openid");
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        @SuppressWarnings("unchecked")
        Map<String, Object> body = new TestRestTemplate().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).as("token response").containsKey("access_token");
        String wert = (String) body.get("access_token");
        TOKENS.put(benutzer, new Token(wert, System.currentTimeMillis()));
        return wert;
    }
}
