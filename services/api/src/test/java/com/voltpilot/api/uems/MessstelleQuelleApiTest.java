package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
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
 * Die Quellenbindung (UEMS AP-04 IP-13) Ende zu Ende gegen echtes Keycloak + TimescaleDB:
 * {@code POST/GET /api/v1/messstellen/{id}/quellen}, {@code PUT …/quellen/{qid}/beenden} und
 * {@code speist} im Messkanal-Read-Model. Die Anlage, ihre Komponenten, Geräte und Zeitpunkte sind
 * die des Referenzunternehmens ({@code uems-referenzunternehmen.json}); die Urteile die des
 * Vertrags ({@code messstelle-vectors.json}).
 *
 * <p>Bewiesen wird:
 * <ul>
 *   <li>der <b>Zeitstrahl von MS-06</b>: Bestandsübernahme an Z-5a ab 12.03.2024 (rückwirkend),
 *       Zählerwechsel am 18.11.2026 10:40, Z-5b ab 10:40 beendet Z-5a genau dort mit dem Endstand
 *       1 083 415,2 kWh (Regel 2), rückwirkend 25 min — der Zeitstrahl ist genau der der
 *       Referenzdatei; die sieben Minuten bis zu den ersten Werten von Z-5b sind KEINE
 *       Bindungslücke (Vertrag §9 Nr. 2), eine Lücke entsteht nur durch ausdrückliches Beenden
 *       (MS-07);</li>
 *   <li>die Fehler nach §5.12: Überlappung 409, Messwert schon führend 409, Passung 422 je Grund
 *       (samt dem Vorzeichen-Fall von MS-01: ohne Anteil 422, mit Anteil gebunden — AP-08 IP-7),
 *       Vergleich ohne Zweck 400,
 *       kein Gerät zum Zeitpunkt 422 (vor dem Einbau, über den Ausbau hinaus), Beenden vor Beginn
 *       400, zweimal beenden 409, die Form der Anfrage 400;</li>
 *   <li>Vergleichsquellen stehen überlappend nebeneinander; Lücken sind erlaubt und sichtbar;</li>
 *   <li>je Schreibvorgang GENAU EIN Protokolleintrag mit Urheber, ein abgelehnter schreibt nichts;</li>
 *   <li>das Archivieren beendet die offenen Quellen zum Archivzeitpunkt;</li>
 *   <li>der Mandantenzaun: fremd ist 404, nie 403;</li>
 *   <li>die Messstelle trägt ihre Quellen in der Form des Vertrags ({@code messstelle.schema.json}),
 *       die Antworten genau die Felder der OpenAPI.</li>
 * </ul>
 * Den Zählerwechsel am Gerät schreibt die Datenbank von Hand, so wie ihn IP-17 schreiben wird.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class MessstelleQuelleApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final Path CONTRACTS = Path.of("..", "..", "docs", "contracts");
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final UUID DEMO_KUNDENBEREICH = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final ObjectMapper MAPPER = new ObjectMapper();

    // Die Messwerte der Referenz-Komponenten, als Punkte des Messpunkt-Katalogs.
    private static final String ENERGIE_BEZUG = "sunspec.model_203.totwhimp";
    private static final String ENERGIE_ABGABE = "sunspec.model_203.totwhexp";
    /** Die Wirkleistung am Zählpunkt: ein Vorzeichen-Wert (Katalog import_export). */
    private static final String LEISTUNG_VORZEICHEN = "sunspec.model_203.w";
    private static final String SPANNUNG = "sunspec.model_203.phv";
    private static final String ERZEUGUNG_ZEHNTEL = "kaco_http.energy-total";

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
    MessstelleQuelleService quellen;

    private record Anrufer(String benutzer, UUID kundenbereich) {}

    private record Token(String wert, long geholt) {}

    private static final Anrufer DEMO = new Anrufer("demo", null);
    private static final Map<String, Token> TOKENS = new ConcurrentHashMap<>();

    private static JsonNode referenz;
    private static JsonNode schema;
    private static Map<String, Object> schemas;
    private static JdbcTemplate root;

    /** Ein Kundenbereich mit AN-1 des Referenzunternehmens: Box E-1, K-1 … K-7 und ihre Geräte. */
    private record Werk(UUID tenant, Anrufer admin, UUID an1, UUID box, Map<String, UUID> komponenten) {
        UUID k(String kennzeichen) {
            return komponenten.get(kennzeichen);
        }
    }

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void ladeVertrag() throws IOException {
        referenz = MAPPER.readTree(V2.resolve("uems-referenzunternehmen.json").toFile());
        schema = MAPPER.readTree(V2.resolve("messstelle.schema.json").toFile());
        try (InputStream in = Files.newInputStream(CONTRACTS.resolve("openapi.yaml"))) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
        }
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    @AfterEach
    void uhrZurueck() {
        quellen.uhrStellen(Clock.systemUTC());
    }

    // ---- MS-06: der Zeitstrahl des Referenzunternehmens ---------------------------------------

    /**
     * DER Plan-Fall (A1, §5.13/§5.14, Vektor {@code ms-06-zaehlerwechsel-zeitstrahl}): Die
     * Bestandsübernahme bindet MS-06 am 01.10.2026 09:14 rückwirkend ab 12.03.2024 an Z-5a. Am
     * 18.11.2026 wird Z-5a um 10:40 ausgebaut, Z-5b eingebaut; um 11:05 trägt Ines Kaltenbach Z-5b
     * ab 10:40 ein — die neue Quelle beendet Z-5a genau dort und trägt seinen Endstand. Der
     * Zeitstrahl ist genau der der Referenzdatei, ohne Fuge.
     */
    @Test
    void derZeitstrahlVonMs06IstDerDerReferenzdatei() throws IOException {
        Werk w = ahrenberg("Zeitstrahl MS-06");
        JsonNode ms06 = referenzMessstelle("MS-06");
        String id = anlegen(w.admin(), wieReferenz("MS-06", ms06)).get("id").asText();
        JsonNode gr4 = element(referenz.get("geraete"), "GR-4");
        JsonNode z5a = element(gr4.get("einbauten"), "Z-5a");
        JsonNode z5b = element(gr4.get("einbauten"), "Z-5b");
        JsonNode referenzQuellen = ms06.get("fuehrende_quelle");

        // 1) Bestandsübernahme (§5.14, 01.10.2026 09:14): rückwirkend ab Beginn des Verlaufs.
        uhr("2026-10-01T09:14:00+02:00");
        Map<String, Object> bestand = binden(w.k("K-5"), ENERGIE_BEZUG, "fuehrend", null,
                referenzQuellen.at("/0/gueltig_ab").asText());
        bestand.put("grund", "Bestandsübernahme");
        ResponseEntity<JsonNode> r1 = rufe(HttpMethod.POST, "/api/v1/messstellen/" + id + "/quellen", w.admin(), bestand);
        assertThat(r1.getStatusCode().value()).as(String.valueOf(r1.getBody())).isEqualTo(201);
        JsonNode v1 = r1.getBody();
        assertThat(r1.getHeaders().getLocation()).hasToString("/api/v1/messstellen/" + id + "/quellen/"
                + v1.at("/quelle/id").asText());
        assertThat(v1.at("/quelle/geraet/geraet").asText()).isEqualTo("GR-4");
        assertThat(v1.at("/quelle/geraet/einbau").asText()).isEqualTo(z5a.get("kennzeichen").asText());
        assertThat(v1.at("/quelle/herleitung").asText()).isEqualTo("zaehlerstand");
        assertThat(v1.at("/quelle/status").asText()).isEqualTo("gilt");
        assertThat(v1.at("/quelle/rueckwirkend").asBoolean()).isTrue();
        assertThat(v1.get("beendet").isNull()).isTrue();
        JsonNode rueck = fall("rueckwirkung", "ms-06-bestandsuebernahme-in-tagen").get("expected");
        assertThat(v1.get("rueckwirkung")).isEqualTo(rueck);
        assertThat(v1.get("hinweise")).isEmpty();
        assertThat(rufe(HttpMethod.GET, "/api/v1/messstellen/" + id + "/quellen/" + v1.at("/quelle/id").asText(),
                w.admin(), null).getBody()).isEqualTo(v1.get("quelle"));

        // 2) Der Zählerwechsel am Gerät (IP-17 schreibt ihn; hier die Datenbank von Hand).
        zaehlerwechsel(w);

        // Kein Gerät zum Zeitpunkt: vor dem Einbau von Z-5a, und über dessen Ausbau hinaus.
        uhr("2026-11-18T11:05:00+01:00");
        long vorher = eintraege(w.tenant());
        ResponseEntity<JsonNode> vorEinbau = rufe(HttpMethod.POST, "/api/v1/messstellen/" + id + "/quellen",
                w.admin(), binden(w.k("K-5"), ENERGIE_BEZUG, "fuehrend", null, "2024-03-11T23:00:00+01:00"));
        abgelehnt(vorEinbau, 422, "kein_geraet_zum_zeitpunkt");
        assertThat(zeitpunkt(vorEinbau.getBody().get("zeitpunkt"))).isEqualTo(zeitpunkt("2024-03-11T23:00:00+01:00"));
        ResponseEntity<JsonNode> ueberAusbau = rufe(HttpMethod.POST, "/api/v1/messstellen/" + id + "/quellen",
                w.admin(), binden(w.k("K-5"), ENERGIE_BEZUG, "vergleich", "Plausibilität", "2026-11-18T10:00:00+01:00"));
        abgelehnt(ueberAusbau, 422, "kein_geraet_zum_zeitpunkt");
        assertThat(zeitpunkt(ueberAusbau.getBody().get("zeitpunkt"))).isEqualTo(zeitpunkt(z5a.get("gueltig_bis")));
        assertThat(ueberAusbau.getBody().get("message").asText()).contains("Z-5a");
        assertThat(eintraege(w.tenant())).as("abgelehnt schreibt nichts").isEqualTo(vorher);
        assertThat(quellenDer(id)).isOne();

        // 3) Z-5b ab 10:40, eingetragen 11:05, mit Endstand von Z-5a und Anfangsstand von Z-5b.
        Map<String, Object> wechsel = binden(w.k("K-5"), ENERGIE_BEZUG, "fuehrend", null,
                referenzQuellen.at("/1/gueltig_ab").asText());
        wechsel.put("endstand_vorgaenger", stand(z5a.get("endstand_kwh").asDouble(), "kWh"));
        wechsel.put("anfangsstand", stand(z5b.get("anfangsstand_kwh").asDouble(), "kWh"));
        ResponseEntity<JsonNode> r2 = rufe(HttpMethod.POST, "/api/v1/messstellen/" + id + "/quellen", w.admin(), wechsel);
        assertThat(r2.getStatusCode().value()).as(String.valueOf(r2.getBody())).isEqualTo(201);
        JsonNode v2 = r2.getBody();
        JsonNode vektor = fall("bindung", "ms-06-zaehlerwechsel-zeitstrahl").get("expected");
        assertThat(v2.at("/quelle/geraet/einbau").asText()).isEqualTo(z5b.get("kennzeichen").asText());
        assertThat(v2.at("/quelle/anfangsstand/wert").asDouble()).isEqualTo(z5b.get("anfangsstand_kwh").asDouble());
        assertThat(v2.at("/beendet/id").asText()).isEqualTo(v1.at("/quelle/id").asText());
        assertThat(v2.at("/beendet/geraet/einbau").asText()).isEqualTo(vektor.at("/beendet/einbau").asText());
        assertThat(zeitpunkt(v2.at("/beendet/gueltig_bis"))).isEqualTo(zeitpunkt(vektor.at("/beendet/gueltig_bis")));
        assertThat(v2.at("/beendet/endstand/wert").asDouble()).isEqualTo(vektor.at("/beendet/endstand/wert").asDouble());
        assertThat(v2.at("/beendet/endstand/einheit").asText()).isEqualTo("kWh");
        assertThat(v2.at("/beendet/status").asText()).isEqualTo("beendet");
        assertThat(v2.get("rueckwirkung")).isEqualTo(fall("rueckwirkung", "ms-06-wechsel-25-minuten").get("expected"));
        assertThat(v2.at("/quelle/rueckwirkend").asBoolean()).isEqualTo(vektor.get("rueckwirkend").asBoolean());
        assertThat(v2.at("/quelle/herleitung").asText()).isEqualTo(vektor.get("herleitung").asText());
        assertThat(v2.get("hinweise")).isEqualTo(vektor.get("hinweise"));

        // Der Zeitstrahl: genau die führenden Quellen der Referenzdatei, ohne Fuge um 10:40.
        JsonNode liste = ok(rufe(HttpMethod.GET, "/api/v1/messstellen/" + id + "/quellen", w.admin(), null));
        JsonNode haupt = liste.at("/groessen/0");
        assertThat(haupt.get("hauptgroesse").asBoolean()).isTrue();
        JsonNode strahl = haupt.get("zeitstrahl");
        assertThat(strahl).hasSize(referenzQuellen.size());
        for (int i = 0; i < referenzQuellen.size(); i++) {
            JsonNode q = referenzQuellen.get(i);
            JsonNode a = strahl.get(i);
            assertThat(a.get("quelle").isNull()).as("keine Bindungslücke").isFalse();
            assertThat(zeitpunkt(a.get("von"))).isEqualTo(zeitpunkt(q.get("gueltig_ab")));
            assertThat(q.get("gueltig_bis").isNull() ? a.get("bis").isNull()
                    : zeitpunkt(a.get("bis")).equals(zeitpunkt(q.get("gueltig_bis")))).isTrue();
            JsonNode quelle = quelleMitId(liste, a.get("quelle").asText());
            assertThat(quelle.at("/geraet/einbau").asText()).isEqualTo(q.get("einbau").asText());
            assertThat(quelle.at("/geraet/geraet").asText()).isEqualTo(q.get("geraet").asText());
            assertThat(quelle.get("kanal_wertart").asText()).isEqualTo(q.get("kanal_wertart").asText());
        }

        // Zum Stichtag: bis 10:39 führt Z-5a, ab 10:40 Z-5b (ein „+“ in der URL wird kein Leerzeichen).
        assertThat(ok(rufe(HttpMethod.GET, "/api/v1/messstellen/" + id + "/quellen?stichtag=2026-11-18T10:39:00%2B01:00",
                w.admin(), null)).at("/groessen/0/fuehrend/geraet/einbau").asText()).isEqualTo("Z-5a");
        assertThat(ok(rufe(HttpMethod.GET, "/api/v1/messstellen/" + id + "/quellen?stichtag=2026-11-18T10:40:00+01:00",
                w.admin(), null)).at("/groessen/0/fuehrend/geraet/einbau").asText()).isEqualTo("Z-5b");
        assertThat(ok(rufe(HttpMethod.GET, "/api/v1/messstellen/" + id + "/quellen?stichtag=2024-03-11",
                w.admin(), null)).at("/groessen/0/fuehrend").isNull()).as("vor dem Verlauf: keine Quelle, nie 0").isTrue();
        // Die Nebengröße hat (noch) keine Quelle — ihr eigener, leerer Zeitstrahl.
        assertThat(liste.at("/groessen/1/groesse").asText()).isEqualTo("Wirkleistung");
        assertThat(liste.at("/groessen/1/fuehrend").isNull()).isTrue();
        assertThat(liste.at("/groessen/1/zeitstrahl")).isEmpty();

        // Die Messstelle trägt ihre Quellen in der Form des Vertrags.
        JsonNode m = ok(rufe(HttpMethod.GET, "/api/v1/messstellen/" + id, w.admin(), null));
        assertThat(m.get("fuehrende_quelle")).hasSize(2);
        assertThat(m.at("/fuehrende_quelle/0/einbau").asText()).isEqualTo("Z-5a");
        assertThat(m.at("/fuehrende_quelle/0/endstand/wert").asDouble()).isEqualTo(z5a.get("endstand_kwh").asDouble());
        assertThat(m.at("/fuehrende_quelle/1/anfangsstand/wert").asDouble()).isEqualTo(z5b.get("anfangsstand_kwh").asDouble());
        assertThat(m.at("/fuehrende_quelle/1/gueltig_bis").isNull()).isTrue();
        ObjectNode vertrag = m.deepCopy();
        List.of("id", "fehlt", "angehalten_ab", "archiviert_am").forEach(vertrag::remove);
        assertThat(UemsSchemaLaeufer.verstoesse(vertrag, schema)).isEmpty();

        // Je Schreibvorgang genau ein Eintrag, mit Urheber und „rückwirkend“, eingetragen um „jetzt“.
        List<Map<String, Object>> protokoll = protokoll(id).stream()
                .filter(e -> e.get("art").toString().startsWith("quelle_")).toList();
        assertThat(protokoll).extracting(e -> e.get("art")).containsExactly("quelle_gebunden", "quelle_gebunden");
        assertThat(protokoll).allSatisfy(e -> {
            assertThat(e.get("rueckwirkend")).isEqualTo(true);
            assertThat(e.get("actor_name")).isEqualTo("admin");
            assertThat(e.get("actor_art")).isEqualTo("voltpilot");
        });
        assertThat(((Timestamp) protokoll.get(1).get("created_at")).toInstant())
                .isEqualTo(zeitpunkt("2026-11-18T11:05:00+01:00"));
        assertThat(((Timestamp) protokoll.get(1).get("gilt_ab")).toInstant()).isEqualTo(zeitpunkt(z5b.get("gueltig_ab")));
        JsonNode neu = json(protokoll.get(1).get("neu"));
        assertThat(neu.get("einbau").asText()).isEqualTo("Z-5b");
        assertThat(neu.at("/beendet/einbau").asText()).isEqualTo("Z-5a");
        assertThat(neu.at("/beendet/endstand/wert").asDouble()).isEqualTo(z5a.get("endstand_kwh").asDouble());
        assertThat(json(protokoll.get(1).get("alt")).at("/beendet/gueltig_bis").isNull()).isTrue();
        assertThat(json(protokoll.get(0).get("grund") == null ? null : "\"" + protokoll.get(0).get("grund") + "\"")
                .asText()).isEqualTo("Bestandsübernahme");

        // speist: der Messkanal nennt MS-06 — bis 10:39 an Z-5a, ab 10:40 an Z-5b.
        for (String stichtag : List.of("2026-11-18T10:39:00%2B01:00", "2026-11-18T10:45:00%2B01:00")) {
            JsonNode kanaele = ok(rufe(HttpMethod.GET, "/api/v1/sites/" + w.an1() + "/komponenten/" + w.k("K-5")
                    + "/messkanaele?stichtag=" + stichtag, w.admin(), null)).get("messkanaele");
            JsonNode energie = kanal(kanaele, ENERGIE_BEZUG);
            assertThat(energie.get("speist")).hasSize(1);
            assertThat(energie.at("/speist/0/messstelle").asText()).isEqualTo("MS-06");
            assertThat(energie.at("/speist/0/messstelle_id").asText()).isEqualTo(id);
            assertThat(energie.at("/speist/0/groesse").asText()).isEqualTo("Wirkenergie");
            assertThat(energie.at("/speist/0/richtung").asText()).isEqualTo("Bezug");
            assertThat(energie.at("/speist/0/rolle").asText()).isEqualTo("fuehrend");
            assertThat(kanal(kanaele, LEISTUNG_VORZEICHEN).get("speist")).isEmpty();
        }
        JsonNode vorDemVerlauf = ok(rufe(HttpMethod.GET, "/api/v1/sites/" + w.an1() + "/komponenten/" + w.k("K-5")
                + "/messkanaele?stichtag=2024-03-11", w.admin(), null)).get("messkanaele");
        assertThat(kanal(vorDemVerlauf, ENERGIE_BEZUG).get("speist")).isEmpty();
        assertThat(rufe(HttpMethod.GET, "/api/v1/sites/" + w.an1() + "/komponenten/" + w.k("K-5")
                + "/messkanaele?stichtag=gestern", w.admin(), null).getStatusCode().value()).isEqualTo(400);

        // Überlappung (Vektor ms-06-ueberlappung-abgelehnt): der Wechsel ein zweites Mal → 409.
        ResponseEntity<JsonNode> doppelt = rufe(HttpMethod.POST, "/api/v1/messstellen/" + id + "/quellen", w.admin(),
                binden(w.k("K-5"), ENERGIE_BEZUG, "fuehrend", null, referenzQuellen.at("/1/gueltig_ab").asText()));
        JsonNode ueberlappt = fall("bindung", "ms-06-ueberlappung-abgelehnt").get("expected");
        abgelehnt(doppelt, 409, ueberlappt.get("fehler").asText());
        assertThat(doppelt.getBody().at("/bestehend/einbau").asText()).isEqualTo(ueberlappt.at("/bestehend/einbau").asText());
        assertThat(doppelt.getBody().get("message").asText()).isEqualTo(
                "MS-06 hat ab 18.11.2026 10:40 bereits eine führende Quelle (Z-5b). Beenden Sie diese oder wählen Sie "
                        + "einen anderen Zeitpunkt.");
        assertThat(quellenDer(id)).isEqualTo(2);
    }

    // ---- 409: ein Messwert führt nur EINE Messstelle; Vergleichsquellen überlappen --------------

    @Test
    void einMesswertFuehrtNurEineMessstelleUndVergleichsquellenUeberlappen() {
        Werk w = ahrenberg("Vergleich");
        String ms06 = anlegen(w.admin(), wieReferenz("MS-06", referenzMessstelle("MS-06"))).get("id").asText();
        String ms07 = anlegen(w.admin(), wieReferenz("MS-07", referenzMessstelle("MS-07"))).get("id").asText();
        uhr("2026-10-01T09:14:00+02:00");
        erfolgreich(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms06 + "/quellen", w.admin(),
                binden(w.k("K-5"), ENERGIE_BEZUG, "fuehrend", null, "2024-03-12T00:00:00+01:00")));

        // Vektor ms-07-kanal-speist-schon-ms-06: führend nie, als Vergleich schon.
        long vorher = eintraege(w.tenant());
        ResponseEntity<JsonNode> schonFuehrend = rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms07 + "/quellen",
                w.admin(), binden(w.k("K-5"), ENERGIE_BEZUG, "fuehrend", null, "2026-10-01T09:14:00+02:00"));
        abgelehnt(schonFuehrend, 409, "kanal_bereits_fuehrend");
        assertThat(schonFuehrend.getBody().get("bestehende_messstelle").asText())
                .isEqualTo(fall("bindung", "ms-07-kanal-speist-schon-ms-06").at("/expected/messstelle").asText());
        assertThat(eintraege(w.tenant())).isEqualTo(vorher);

        erfolgreich(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms07 + "/quellen", w.admin(),
                binden(w.k("K-6"), ENERGIE_BEZUG, "fuehrend", null, "2024-03-12T00:00:00+01:00")));
        JsonNode plausi = erfolgreich(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms07 + "/quellen", w.admin(),
                binden(w.k("K-5"), ENERGIE_BEZUG, "vergleich", "Plausibilität", "2026-10-01T09:14:00+02:00")));
        assertThat(plausi.at("/quelle/zweck").asText()).isEqualTo("Plausibilität");
        assertThat(plausi.get("rueckwirkung").get("art").asText()).isEqualTo("ab_jetzt");
        assertThat(plausi.get("rueckwirkung").get("abzeichen").isNull()).isTrue();
        // Eine zweite Vergleichsquelle zur selben Zeit, anderer Messwert: nebeneinander erlaubt.
        erfolgreich(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms07 + "/quellen", w.admin(),
                binden(w.k("K-4"), ENERGIE_BEZUG, "vergleich", "Abrechnungszähler", "2024-03-12T00:00:00+01:00")));
        // Derselbe Messwert zweimal zugleich: nie (Vektor ms-01-vergleich-derselbe-messwert-doppelt).
        abgelehnt(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms07 + "/quellen", w.admin(),
                binden(w.k("K-5"), ENERGIE_BEZUG, "vergleich", "Ersatz bei Ausfall", "2026-10-02T00:00:00+02:00")),
                409, "bindung_ueberlappt");

        JsonNode haupt = ok(rufe(HttpMethod.GET, "/api/v1/messstellen/" + ms07 + "/quellen", w.admin(), null))
                .at("/groessen/0");
        assertThat(haupt.at("/fuehrend/komponente").asText()).isEqualTo(w.k("K-6").toString());
        assertThat(haupt.get("vergleich")).hasSize(2);
        // Das Messkanal-Read-Model: K-5 speist MS-06 führend UND MS-07 zum Vergleich.
        JsonNode speist = kanal(ok(rufe(HttpMethod.GET, "/api/v1/sites/" + w.an1() + "/komponenten/" + w.k("K-5")
                + "/messkanaele?stichtag=2026-10-01T09:14:00%2B02:00", w.admin(), null)).get("messkanaele"),
                ENERGIE_BEZUG).get("speist");
        assertThat(speist).extracting(s -> s.get("messstelle").asText() + "·" + s.get("rolle").asText()
                + (s.get("zweck").isNull() ? "" : "·" + s.get("zweck").asText()))
                .containsExactly("MS-06·fuehrend", "MS-07·vergleich·Plausibilität");

        // Je Erfolg genau ein Eintrag „quelle_gebunden“.
        assertThat(protokoll(ms07).stream().filter(e -> "quelle_gebunden".equals(e.get("art")))).hasSize(3);
    }

    // ---- 400: Vergleich ohne Zweck und die Form der Anfrage ---------------------------------------

    @Test
    void vergleichOhneZweckIst400UndDieAnfrageWirdStrengGelesen() {
        Werk w = ahrenberg("Form");
        String ms01 = anlegen(w.admin(), wieReferenz("MS-01", referenzMessstelle("MS-01"))).get("id").asText();
        String pfad = "/api/v1/messstellen/" + ms01 + "/quellen";
        Map<String, Object> ohneZweck = binden(w.k("K-3"), ENERGIE_BEZUG, "vergleich", null, null);
        abgelehnt(rufe(HttpMethod.POST, pfad, w.admin(), ohneZweck), 400,
                fall("bindung", "ms-01-vergleich-ohne-zweck").at("/expected/fehler").asText());
        abgelehnt(rufe(HttpMethod.POST, pfad, w.admin(),
                binden(w.k("K-3"), ENERGIE_BEZUG, "vergleich", "Bauchgefühl", null)), 400, "vergleich_ohne_zweck");

        // Die Form: je ein Feld, das es nicht gibt, fehlt oder die falsche Gestalt hat.
        anfrage(rufe(HttpMethod.POST, pfad, w.admin(), binden(w.k("K-3"), ENERGIE_BEZUG, "fuehrend",
                "Plausibilität", null)), "zweck");
        anfrage(rufe(HttpMethod.POST, pfad, w.admin(), binden(w.k("K-3"), ENERGIE_BEZUG, "haupt", null, null)), "rolle");
        Map<String, Object> ohneKomponente = binden(w.k("K-3"), ENERGIE_BEZUG, "fuehrend", null, null);
        ohneKomponente.remove("komponente");
        anfrage(rufe(HttpMethod.POST, pfad, w.admin(), ohneKomponente), "komponente");
        anfrage(rufe(HttpMethod.POST, pfad, w.admin(), binden(w.k("K-3"), "sunspec.model_203.gibtsnicht", "fuehrend",
                null, null)), "kanal");
        anfrage(rufe(HttpMethod.POST, pfad, w.admin(), binden(w.k("K-3"), ENERGIE_BEZUG, "fuehrend", null,
                "2026-10-20T10:15:30+02:00")), "gueltig_ab");
        Map<String, Object> fremdeGroesse = binden(w.k("K-3"), ENERGIE_BEZUG, "fuehrend", null, null);
        fremdeGroesse.put("groesse", Map.of("groesse", "Blindenergie", "richtung", "Bezug"));
        anfrage(rufe(HttpMethod.POST, pfad, w.admin(), fremdeGroesse), "groesse");
        Map<String, Object> mitKadenz = binden(w.k("K-3"), ENERGIE_BEZUG, "fuehrend", null, null);
        mitKadenz.put("kadenz_s", 60);
        anfrage(rufe(HttpMethod.POST, pfad, w.admin(), mitKadenz), "kadenz_s");
        Map<String, Object> endstandOhneVorgaenger = binden(w.k("K-3"), ENERGIE_BEZUG, "fuehrend", null, null);
        endstandOhneVorgaenger.put("endstand_vorgaenger", stand(1.0, "kWh"));
        anfrage(rufe(HttpMethod.POST, pfad, w.admin(), endstandOhneVorgaenger), "endstand_vorgaenger");
        anfrage(rufe(HttpMethod.GET, pfad + "?stichtag=gestern", w.admin(), null), "stichtag");
        assertThat(quellenDer(ms01)).isZero();
        assertThat(protokoll(ms01)).extracting(e -> e.get("art")).containsExactly("angelegt");

        // Ohne „gültig ab“ gilt jetzt — auf die Minute, nicht rückwirkend.
        uhr("2026-10-20T10:15:40+02:00");
        JsonNode jetzt = erfolgreich(rufe(HttpMethod.POST, pfad, w.admin(),
                binden(w.k("K-3"), ENERGIE_BEZUG, "fuehrend", null, null)));
        assertThat(zeitpunkt(jetzt.at("/quelle/gueltig_ab"))).isEqualTo(zeitpunkt("2026-10-20T10:15:00+02:00"));
        assertThat(jetzt.at("/quelle/rueckwirkend").asBoolean()).isFalse();
        assertThat(jetzt.at("/rueckwirkung/art").asText()).isEqualTo("ab_jetzt");
    }

    // ---- 422: die Passung je Grund, und der Vorzeichen-Wert ohne Anteil -------------------------------

    @Test
    void diePassungLehntJeGrundAbUndDerVorzeichenWertBindetNurMitAnteil() {
        Werk w = ahrenberg("Passung");
        String ms06 = anlegen(w.admin(), wieReferenz("MS-06", referenzMessstelle("MS-06"))).get("id").asText();
        String ms01 = anlegen(w.admin(), wieReferenz("MS-01", referenzMessstelle("MS-01"))).get("id").asText();
        String ms03 = anlegen(w.admin(), wieReferenz("MS-03", referenzMessstelle("MS-03"))).get("id").asText();
        String ms21 = anlegen(w.admin(), wieReferenz("MS-21", referenzMessstelle("MS-21"))).get("id").asText();
        long vorher = eintraege(w.tenant());

        // wertart: ein Zählerstand nie aus einer Leistung (Vektor ms-06-zaehlerstand-nie-aus-leistung).
        passtNicht(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms06 + "/quellen", w.admin(),
                binden(w.k("K-5"), LEISTUNG_VORZEICHEN, "fuehrend", null, null)), "wertart");
        // groesse: eine Spannung speist keine Wirkleistung.
        Map<String, Object> spannung = binden(w.k("K-5"), SPANNUNG, "fuehrend", null, null);
        spannung.put("groesse", Map.of("groesse", "Wirkleistung", "richtung", "Bezug"));
        passtNicht(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms06 + "/quellen", w.admin(), spannung), "groesse");
        // einheit: „0,1 kWh“ ist keine umrechenbare Einheit.
        passtNicht(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms03 + "/quellen", w.admin(),
                binden(w.k("K-1"), ERZEUGUNG_ZEHNTEL, "fuehrend", null, null)), "einheit");
        // richtung: Bezug ist nicht Abgabe (Vektor ms-01-bezug-nie-aus-abgabe).
        passtNicht(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms01 + "/quellen", w.admin(),
                binden(w.k("K-3"), ENERGIE_ABGABE, "fuehrend", null, null)), "richtung");
        // Medium Gas bindet keinen Katalog-Messwert (Vektor ms-21-gas-bindet-keine-katalogquelle).
        abgelehnt(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms21 + "/quellen", w.admin(),
                binden(w.k("K-3"), ENERGIE_BEZUG, "fuehrend", null, null)), 422, "medium_ohne_quelle");

        // Der Vorzeichen-Wert OHNE Anteil (Vektor ms-01-nebengroesse-vorzeichen-ohne-anteil, bis AP-08 IP-7
        // „…-wartet-auf-ap08“): die Referenz speist „Wirkleistung · Bezug“ von MS-01 aus der Wirkleistung
        // von K-3 — ohne Anteil passt er nicht (W8), der Satz sagt, wie er passt.
        JsonNode vorzeichen = fall("bindung", "ms-01-nebengroesse-vorzeichen-ohne-anteil");
        Map<String, Object> nebengroesse = binden(w.k("K-3"), LEISTUNG_VORZEICHEN, "fuehrend", null,
                vorzeichen.at("/input/neu/gueltig_ab").asText());
        nebengroesse.put("groesse", Map.of("groesse", vorzeichen.at("/input/ziel/groesse").asText(),
                "richtung", vorzeichen.at("/input/ziel/richtung").asText()));
        ResponseEntity<JsonNode> r = rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms01 + "/quellen", w.admin(),
                nebengroesse);
        passtNicht(r, vorzeichen.at("/expected/grund").asText());
        assertThat(r.getBody().at("/kanal/direction").asText()).isEqualTo("import_export");
        assertThat(r.getBody().at("/kanal/richtung").asText()).isEqualTo("richtungslos");
        assertThat(r.getBody().get("message").asText()).contains("Vorzeichen").contains("positiven Anteil")
                .doesNotContain("noch nicht");
        // Ein Anteil an einem Zählerstand (Vektor anteil-nie-aus-zaehlerstand): Grund `anteil`.
        Map<String, Object> zaehlerAnteil = binden(w.k("K-3"), ENERGIE_BEZUG, "fuehrend", null, null);
        zaehlerAnteil.put("anteil", "positiv");
        passtNicht(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms01 + "/quellen", w.admin(), zaehlerAnteil),
                "anteil");
        // Ein Wort außerhalb des Vokabulars ist die Form der Anfrage — nie „der ganze Wert“ geraten.
        nebengroesse.put("anteil", "gesamt");
        anfrage(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms01 + "/quellen", w.admin(), nebengroesse), "anteil");

        assertThat(eintraege(w.tenant())).as("abgelehnt schreibt nichts").isEqualTo(vorher);
        for (String ms : List.of(ms06, ms01, ms03, ms21)) {
            assertThat(quellenDer(ms)).isZero();
        }
    }

    /**
     * AP-08 IP-7 (E15 = A): EIN Vorzeichen-Wert speist Bezug UND Abgabe — MS-01 mit dem positiven, MS-02
     * mit dem negativen Anteil der Wirkleistung von K-3 (Vektoren ms-01-nebengroesse-positiver-anteil,
     * ms-02-nebengroesse-negativer-anteil-neben-ms-01). Der Anteil ist ein Fakt der Bindung: gespeichert,
     * in Antwort und Protokoll; denselben Anteil führt nur EINE Messstelle (409).
     */
    @Test
    void einVorzeichenWertSpeistBezugUndAbgabeMitAnteil() {
        Werk w = ahrenberg("Anteil");
        uhr("2026-10-01T09:14:00+02:00");
        String ms01 = anlegen(w.admin(), wieReferenz("MS-01", referenzMessstelle("MS-01"))).get("id").asText();
        Map<String, Object> ms02Body = wieReferenz("MS-02", referenzMessstelle("MS-02"));
        ObjectNode abgabe = MAPPER.createObjectNode().put("groesse", "Wirkleistung").put("richtung", "Abgabe")
                .put("einheit", "kW").put("wertart", "Momentanwert");
        ms02Body.put("nebengroessen", List.of(abgabe));
        String ms02 = anlegen(w.admin(), ms02Body).get("id").asText();
        String ms06 = anlegen(w.admin(), wieReferenz("MS-06", referenzMessstelle("MS-06"))).get("id").asText();

        JsonNode positiv = fall("bindung", "ms-01-nebengroesse-positiver-anteil");
        Map<String, Object> bezug = binden(w.k("K-3"), LEISTUNG_VORZEICHEN, "fuehrend", null,
                positiv.at("/input/neu/gueltig_ab").asText());
        bezug.put("groesse", Map.of("groesse", "Wirkleistung", "richtung", "Bezug"));
        bezug.put("anteil", positiv.at("/input/neu/anteil").asText());
        JsonNode b = erfolgreich(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms01 + "/quellen", w.admin(), bezug));
        assertThat(b.at("/quelle/anteil").asText()).isEqualTo("positiv");
        assertThat(b.at("/quelle/herleitung").asText()).isEqualTo(positiv.at("/expected/herleitung").asText());
        assertThat(b.at("/quelle/status").asText()).isEqualTo(positiv.at("/expected/status").asText());

        Map<String, Object> abgabeBindung = binden(w.k("K-3"), LEISTUNG_VORZEICHEN, "fuehrend", null,
                positiv.at("/input/neu/gueltig_ab").asText());
        abgabeBindung.put("groesse", Map.of("groesse", "Wirkleistung", "richtung", "Abgabe"));
        abgabeBindung.put("anteil", "negativ");
        JsonNode a = erfolgreich(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms02 + "/quellen", w.admin(),
                abgabeBindung));
        assertThat(a.at("/quelle/anteil").asText()).as("zwei Anteile sind zwei Messwerte").isEqualTo("negativ");

        // Denselben (positiven) Anteil führt nur EINE Messstelle — die Antwort nennt MS-01.
        Map<String, Object> doppelt = binden(w.k("K-3"), LEISTUNG_VORZEICHEN, "fuehrend", null,
                positiv.at("/input/neu/gueltig_ab").asText());
        doppelt.put("groesse", Map.of("groesse", "Wirkleistung", "richtung", "Bezug"));
        doppelt.put("anteil", "positiv");
        ResponseEntity<JsonNode> d = rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms06 + "/quellen", w.admin(), doppelt);
        abgelehnt(d, 409, "kanal_bereits_fuehrend");
        assertThat(d.getBody().get("bestehende_messstelle").asText()).isEqualTo("MS-01");

        // Gespeichert als Fakt, in der Messstelle sichtbar, im Protokoll genannt — die Hauptgrößen nie.
        assertThat(root.queryForList("SELECT anteil FROM messstelle_quelle WHERE tenant_id = ? ORDER BY anteil",
                String.class, w.tenant())).containsExactly("negativ", "positiv");
        JsonNode m01 = ok(rufe(HttpMethod.GET, "/api/v1/messstellen/" + ms01, w.admin(), null));
        assertThat(m01.at("/nebengroessen/0/fuehrende_quelle/0/anteil").asText()).isEqualTo("positiv");
        assertThat(protokoll(ms01)).last().satisfies(e -> assertThat(json(e.get("neu")).get("anteil").asText())
                .isEqualTo("positiv"));
        assertThat(quellenDer(ms06)).isZero();
    }

    /**
     * AP-04 IP-14 (E3, Abnahmefall A8): Die Quelle-Karte stellt die führende und die Vergleichsquelle
     * NEBENEINANDER — also muss {@code GET …/quellen} je Bindung ihren eigenen letzten Wert nennen.
     * MS-01 liest die Wirkleistung führend aus dem Netzzähler K-3 (312,4 kW) und vergleicht sie mit der
     * Netzmessung des Wechselrichters K-1 (309,8 kW, Zweck Plausibilität).
     *
     * <p>Geprüft wird genau das, was die Fläche braucht: der Wert je Bindung in der Einheit ihres
     * Messkanals, der Anteil-Schnitt (AP-08 IP-7) und der Anzeigename. Eine BEENDETE oder geplante
     * Bindung trägt keinen Wert — ein alter Wert neben einem laufenden sähe aus wie ein zweiter Zustand.
     * Bewertet wird nichts: die Antwort nennt keine Abweichung und keinen Prozentwert.
     */
    @Test
    void jedeLaufendeQuelleNenntIhrenEigenenLetztenWertUndIhrenAnzeigenamen() {
        Werk w = ahrenberg("A8");
        // K-1 misst am Wechselrichter ebenfalls einen Vorzeichen-Wert (Referenzdatei: „Einspeise-/
        // Bezugsleistung am Wechselrichter“) — im Katalog ein eigener Punkt, damit die Reihen sich
        // nicht überlagern: beide Komponenten hängen an derselben Box.
        String wechselrichterLeistung = "sunspec.model_211.w";
        messkanalAuswahl(w, "K-1", wechselrichterLeistung);
        uhr("2026-10-20T10:15:00+02:00");
        String ms01 = anlegen(w.admin(), wieReferenz("MS-01", referenzMessstelle("MS-01"))).get("id").asText();

        Map<String, Object> fuehrend = binden(w.k("K-3"), LEISTUNG_VORZEICHEN, "fuehrend", null,
                "2024-03-12T00:00:00+01:00");
        fuehrend.put("groesse", Map.of("groesse", "Wirkleistung", "richtung", "Bezug"));
        fuehrend.put("anteil", "positiv");
        erfolgreich(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms01 + "/quellen", w.admin(), fuehrend));

        Map<String, Object> vergleich = binden(w.k("K-1"), wechselrichterLeistung, "vergleich", "Plausibilität",
                "2026-10-15T09:00:00+02:00");
        vergleich.put("groesse", Map.of("groesse", "Wirkleistung", "richtung", "Bezug"));
        vergleich.put("anteil", "positiv");
        erfolgreich(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms01 + "/quellen", w.admin(), vergleich));

        // Die Werte, wie der Writer sie ablegt: je Box und Kanal, nie je Messstelle.
        wert(w, LEISTUNG_VORZEICHEN, "2026-10-20T08:14:00Z", 312.4);
        wert(w, wechselrichterLeistung, "2026-10-20T08:14:00Z", 309.8);

        JsonNode liste = ok(rufe(HttpMethod.GET, "/api/v1/messstellen/" + ms01 + "/quellen", w.admin(), null));
        JsonNode leistung = element(liste.get("groessen"), null, g -> "Wirkleistung".equals(g.get("groesse").asText()));
        assertThat(leistung.at("/fuehrend/letzter_wert/wert").asDouble()).isEqualTo(312.4);
        assertThat(leistung.at("/fuehrend/letzter_wert/einheit").asText()).isEqualTo("W");
        assertThat(leistung.at("/fuehrend/kanal_name").asText()).isNotBlank();
        assertThat(leistung.at("/vergleich/0/letzter_wert/wert").asDouble()).isEqualTo(309.8);
        assertThat(leistung.at("/vergleich/0/zweck").asText()).isEqualTo("Plausibilität");
        assertThat(leistung.at("/vergleich/0/anteil").asText()).isEqualTo("positiv");

        // Die Hauptgröße hat keine Quelle — dann gibt es keinen Wert, nie eine 0.
        JsonNode haupt = element(liste.get("groessen"), null, g -> g.get("hauptgroesse").asBoolean());
        assertThat(haupt.get("fuehrend").isNull()).isTrue();

        // E3: nichts bewertet — die Antwort kennt weder Abweichung noch Prozent.
        assertThat(liste.toString()).doesNotContain("abweichung").doesNotContain("prozent");

        // Eine BEENDETE Bindung trägt keinen Wert mehr.
        String quelleId = leistung.at("/vergleich/0/id").asText();
        ok(rufe(HttpMethod.PUT, "/api/v1/messstellen/" + ms01 + "/quellen/" + quelleId + "/beenden", w.admin(),
                Map.of("gueltig_bis", "2026-10-20T10:00:00+02:00")));
        JsonNode danach = ok(rufe(HttpMethod.GET, "/api/v1/messstellen/" + ms01 + "/quellen", w.admin(), null));
        JsonNode beendet = element(danach.get("quellen"), null, q -> quelleId.equals(q.get("id").asText()));
        assertThat(beendet.get("status").asText()).isEqualTo("beendet");
        assertThat(beendet.get("letzter_wert").isNull()).as("ein alter Wert steht nie neben einem laufenden").isTrue();
        assertThat(beendet.get("kanal_name").isNull()).as("der Name bleibt — er gehört dem Messwert").isFalse();
    }

    /** EIN Messwert, wie ihn der Writer ablegt — je Box und Kanal (AP-04 IP-14). */
    private void wert(Werk w, String kanal, String zeit, double zahl) {
        root.update("INSERT INTO device_measurement_sample (time, tenant_id, site_id, device_id, point_key, "
                + "raw_numeric, decoded_numeric, quality, catalog_version, edge_sequence, aggregation_kind) "
                + "VALUES (?,?,?,?,?,?,?,'good','2026.08.26.3',?,'gauge')",
                Timestamp.from(Instant.parse(zeit)), w.tenant(), w.an1(), w.box(), kanal, zahl, zahl,
                Math.abs((kanal + zeit).hashCode()) % 100000);
    }

    /** Das erste Element, das die Bedingung erfüllt — mit dem Namen im Fehlerfall. */
    private static JsonNode element(JsonNode liste, String was, java.util.function.Predicate<JsonNode> passt) {
        for (JsonNode n : liste) {
            if (passt.test(n)) {
                return n;
            }
        }
        throw new AssertionError("kein Element " + (was == null ? "" : was) + " in " + liste);
    }

    // ---- Lücke erlaubt; Beenden ---------------------------------------------------------------

    /**
     * MS-07 (Vektoren {@code ms-07-zur-pruefung-abgeklemmt}, {@code ms-07-luecke-bleibt-sichtbar}):
     * der Unterzähler Druckluft wird am 03.05.2027 um 07:00 zur Prüfung abgeklemmt und um 15:30
     * wieder gebunden. Die 8,5 Stunden sind ein eigener Abschnitt OHNE Quelle — nie aufgefüllt.
     */
    @Test
    void eineLueckeIstErlaubtUndSichtbarUndBeendenGehtGenauEinmal() {
        Werk w = ahrenberg("Lücke MS-07");
        String ms07 = anlegen(w.admin(), wieReferenz("MS-07", referenzMessstelle("MS-07"))).get("id").asText();
        String pfad = "/api/v1/messstellen/" + ms07 + "/quellen";
        uhr("2026-10-01T09:14:00+02:00");
        String q1 = erfolgreich(rufe(HttpMethod.POST, pfad, w.admin(),
                binden(w.k("K-6"), ENERGIE_BEZUG, "fuehrend", null, "2024-03-12T00:00:00+01:00"))).at("/quelle/id").asText();

        // Beenden vor dem Beginn: 400; mit Sekunden: 400.
        JsonNode vorBeginn = fall("beenden", "ms-07-beenden-vor-beginn").get("input");
        abgelehnt(rufe(HttpMethod.PUT, pfad + "/" + q1 + "/beenden", w.admin(),
                Map.of("gueltig_bis", vorBeginn.get("gueltig_bis").asText())), 400, "zeitraum_ungueltig");
        anfrage(rufe(HttpMethod.PUT, pfad + "/" + q1 + "/beenden", w.admin(),
                Map.of("gueltig_bis", "2027-05-03T07:00:30+02:00")), "gueltig_bis");

        // Abgeklemmt um 07:00, eingetragen 07:05 — mit einem Endstand ohne Einheit: Hinweis, kein Verbot.
        JsonNode abgeklemmt = fall("beenden", "ms-07-zur-pruefung-abgeklemmt");
        uhr(abgeklemmt.at("/input/jetzt").asText());
        long vorher = eintraege(w.tenant());
        JsonNode beendet = ok(rufe(HttpMethod.PUT, pfad + "/" + q1 + "/beenden", w.admin(),
                Map.of("gueltig_bis", abgeklemmt.at("/input/gueltig_bis").asText(),
                        "endstand", stand(482113.0, null), "grund", "Prüfung Druckluftzähler")));
        assertThat(beendet.at("/quelle/status").asText()).isEqualTo(abgeklemmt.at("/expected/status").asText());
        assertThat(zeitpunkt(beendet.at("/quelle/gueltig_bis"))).isEqualTo(zeitpunkt(abgeklemmt.at("/input/gueltig_bis")));
        assertThat(beendet.at("/quelle/endstand/wert").asDouble()).isEqualTo(482113.0);
        assertThat(beendet.at("/quelle/endstand/einheit").isNull()).isTrue();
        assertThat(beendet.get("hinweise")).extracting(JsonNode::asText).containsExactly("ablesestand_pruefen");
        assertThat(beendet.at("/rueckwirkung/abzeichen").asText()).isEqualTo("rückwirkend (5 min)");
        assertThat(eintraege(w.tenant())).isEqualTo(vorher + 1);
        Map<String, Object> e = protokoll(ms07).get(protokoll(ms07).size() - 1);
        assertThat(e.get("art")).isEqualTo("quelle_beendet");
        assertThat(e.get("grund")).isEqualTo("Prüfung Druckluftzähler");
        assertThat(json(e.get("neu")).get("quelle_id").asText()).isEqualTo(q1);

        // Eine beendete Quelle wird nie erneut beendet (Vektor ms-06-beendete-quelle-nie-erneut).
        abgelehnt(rufe(HttpMethod.PUT, pfad + "/" + q1 + "/beenden", w.admin(),
                Map.of("gueltig_bis", "2027-05-03T08:00:00+02:00")), 409, "bindung_bereits_beendet");
        assertThat(eintraege(w.tenant())).isEqualTo(vorher + 1);

        // Wieder gebunden ab 15:30, eingetragen 15:45 (Vektor ms-07-luecke-bleibt-sichtbar).
        JsonNode luecke = fall("bindung", "ms-07-luecke-bleibt-sichtbar");
        uhr(luecke.at("/input/jetzt").asText());
        JsonNode wieder = erfolgreich(rufe(HttpMethod.POST, pfad, w.admin(), binden(w.k("K-6"), ENERGIE_BEZUG,
                "fuehrend", null, luecke.at("/input/neu/gueltig_ab").asText())));
        assertThat(wieder.get("beendet").isNull()).as("eine beendete Quelle wird nie verschoben").isTrue();
        assertThat(wieder.get("rueckwirkung")).isEqualTo(fall("rueckwirkung", "ms-07-wieder-gebunden").get("expected"));
        JsonNode strahl = ok(rufe(HttpMethod.GET, pfad, w.admin(), null)).at("/groessen/0/zeitstrahl");
        JsonNode soll = luecke.at("/expected/zeitstrahl");
        assertThat(strahl).hasSize(soll.size());
        for (int i = 0; i < soll.size(); i++) {
            assertThat(zeitpunkt(strahl.get(i).get("von"))).isEqualTo(zeitpunkt(soll.get(i).get("von")));
            assertThat(strahl.get(i).get("quelle").isNull()).as("Abschnitt " + i).isEqualTo(soll.get(i).get("quelle").isNull());
        }
        assertThat(ok(rufe(HttpMethod.GET, pfad + "?stichtag=2027-05-03T12:00:00%2B02:00", w.admin(), null))
                .at("/groessen/0/fuehrend").isNull()).as("in der Lücke: keine Quelle, nie 0").isTrue();

        // Ohne Inhalt endet eine Quelle jetzt — hier eine angekündigte: das Ende liegt nach ihr.
        uhr("2027-05-03T16:00:00+02:00");
        JsonNode jetzt = ok(rufe(HttpMethod.PUT, pfad + "/" + wieder.at("/quelle/id").asText() + "/beenden",
                w.admin(), null));
        assertThat(zeitpunkt(jetzt.at("/quelle/gueltig_bis"))).isEqualTo(zeitpunkt("2027-05-03T16:00:00+02:00"));
        assertThat(jetzt.at("/rueckwirkung/art").asText()).isEqualTo("ab_jetzt");
    }

    // ---- Archivieren beendet die Quellen ----------------------------------------------------------

    @Test
    void archivierenBeendetDieOffenenQuellenZumArchivzeitpunkt() {
        Werk w = ahrenberg("Archiv");
        String ms07 = anlegen(w.admin(), wieReferenz("MS-07", referenzMessstelle("MS-07"))).get("id").asText();
        String ms05 = anlegen(w.admin(), wieReferenz("MS-05", referenzMessstelle("MS-05"))).get("id").asText();
        String q = erfolgreich(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms07 + "/quellen", w.admin(),
                binden(w.k("K-6"), ENERGIE_BEZUG, "fuehrend", null, "2024-03-12T00:00:00+01:00"))).at("/quelle/id").asText();
        // Eine angekündigte Quelle lässt sich nicht vor ihrem Beginn beenden — dann kein Archiv.
        erfolgreich(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms05 + "/quellen", w.admin(),
                binden(w.k("K-4"), ENERGIE_BEZUG, "fuehrend", null,
                        OffsetDateTime.now(BERLIN).plusDays(30).withSecond(0).withNano(0).toString())));
        abgelehnt(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms05 + "/archivieren", w.admin(), null), 409,
                "zustand_passt_nicht");

        ResponseEntity<JsonNode> archiv = rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms07 + "/archivieren",
                w.admin(), null);
        assertThat(archiv.getStatusCode().value()).as(String.valueOf(archiv.getBody())).isEqualTo(200);
        Instant am = zeitpunkt(archiv.getBody().get("archiviert_am"));
        JsonNode quelle = ok(rufe(HttpMethod.GET, "/api/v1/messstellen/" + ms07 + "/quellen/" + q, w.admin(), null));
        assertThat(zeitpunkt(quelle.get("gueltig_bis"))).isEqualTo(am);
        assertThat(quelle.get("status").asText()).isEqualTo("beendet");
        List<Map<String, Object>> eintraege = protokoll(ms07);
        Map<String, Object> archiviert = eintraege.get(eintraege.size() - 1);
        assertThat(archiviert.get("art")).isEqualTo("archiviert");
        assertThat(json(archiviert.get("neu")).get("quellen_beendet")).extracting(JsonNode::asText).containsExactly(q);
        // Archiviert bekommt sie keine neue Quelle.
        abgelehnt(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms07 + "/quellen", w.admin(),
                binden(w.k("K-6"), ENERGIE_BEZUG, "fuehrend", null, null)), 409, "zustand_passt_nicht");
    }

    // ---- Der Zaun ---------------------------------------------------------------------------------

    @Test
    void eineFremdeMessstelleQuelleOderKomponenteIst404NieEine403() {
        Werk w = ahrenberg("Zaun");
        String ms06 = anlegen(w.admin(), wieReferenz("MS-06", referenzMessstelle("MS-06"))).get("id").asText();
        String ms07 = anlegen(w.admin(), wieReferenz("MS-07", referenzMessstelle("MS-07"))).get("id").asText();
        String q = erfolgreich(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms06 + "/quellen", w.admin(),
                binden(w.k("K-5"), ENERGIE_BEZUG, "fuehrend", null, "2024-03-12T00:00:00+01:00"))).at("/quelle/id").asText();

        // Der Kunde „demo“ sieht Ahrenberg nicht — weder Messstelle noch Quelle.
        assertThat(status(rufe(HttpMethod.GET, "/api/v1/messstellen/" + ms06 + "/quellen", DEMO, null))).isEqualTo(404);
        assertThat(status(rufe(HttpMethod.GET, "/api/v1/messstellen/" + ms06 + "/quellen/" + q, DEMO, null))).isEqualTo(404);
        assertThat(status(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms06 + "/quellen", DEMO,
                binden(w.k("K-5"), ENERGIE_BEZUG, "vergleich", "Plausibilität", null)))).isEqualTo(404);
        assertThat(status(rufe(HttpMethod.PUT, "/api/v1/messstellen/" + ms06 + "/quellen/" + q + "/beenden", DEMO,
                null))).isEqualTo(404);
        // Eine Quelle gehört zu IHRER Messstelle; eine unbekannte ist nicht da.
        assertThat(status(rufe(HttpMethod.GET, "/api/v1/messstellen/" + ms07 + "/quellen/" + q, w.admin(), null)))
                .isEqualTo(404);
        assertThat(status(rufe(HttpMethod.PUT, "/api/v1/messstellen/" + ms07 + "/quellen/" + q + "/beenden",
                w.admin(), null))).isEqualTo(404);
        assertThat(status(rufe(HttpMethod.GET, "/api/v1/messstellen/" + UUID.randomUUID() + "/quellen", w.admin(),
                null))).isEqualTo(404);

        // Eine Komponente des Kundenbereichs „demo“ bindet Ahrenberg nicht: 404.
        UUID demoAnlage = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Quellen-Zaun') "
                + "RETURNING id", UUID.class, DEMO_KUNDENBEREICH);
        UUID demoK = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, entity_type, "
                + "connection_json) VALUES (?, ?, 'modbus-generic', 'modbus-generic', '{\"unit_id\":9}'::jsonb) "
                + "RETURNING id", UUID.class, DEMO_KUNDENBEREICH, demoAnlage);
        ResponseEntity<JsonNode> fremd = rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms07 + "/quellen", w.admin(),
                binden(demoK, ENERGIE_BEZUG, "fuehrend", null, null));
        assertThat(status(fremd)).isEqualTo(404);
        assertThat(fremd.getBody().get("message").asText()).isEqualTo("Komponente nicht gefunden.");
        assertThat(quellenDer(ms07)).isZero();
        assertThat(anzahl("SELECT count(*) FROM messstelle_quelle WHERE tenant_id = ?", w.tenant())).isOne();
    }

    // ---- Die OpenAPI ------------------------------------------------------------------------------

    @Test
    void dieAntwortenTragenGenauDieFelderDerOpenApi() {
        Werk w = ahrenberg("OpenAPI");
        String ms06 = anlegen(w.admin(), wieReferenz("MS-06", referenzMessstelle("MS-06"))).get("id").asText();
        JsonNode v = erfolgreich(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms06 + "/quellen", w.admin(),
                binden(w.k("K-5"), ENERGIE_BEZUG, "fuehrend", null, "2024-03-12T00:00:00+01:00")));
        assertThat(felder(v)).containsExactlyInAnyOrderElementsOf(eigenschaften("MessstelleQuelleVorgang"));
        assertThat(felder(v.get("quelle"))).containsExactlyInAnyOrderElementsOf(eigenschaften("MessstelleQuelle"));
        assertThat(felder(v.at("/quelle/geraet"))).containsExactlyInAnyOrderElementsOf(eigenschaften("MessstelleQuelleGeraet"));
        assertThat(felder(v.get("rueckwirkung"))).containsExactlyInAnyOrderElementsOf(
                eigenschaften("MessstelleQuelleRueckwirkung"));
        JsonNode liste = ok(rufe(HttpMethod.GET, "/api/v1/messstellen/" + ms06 + "/quellen", w.admin(), null));
        assertThat(felder(liste)).containsExactlyInAnyOrderElementsOf(eigenschaften("MessstelleQuellenListe"));
        assertThat(felder(liste.at("/groessen/0"))).containsExactlyInAnyOrderElementsOf(
                eigenschaften("MessstelleQuelleGroesse"));
        assertThat(felder(liste.at("/groessen/0/zeitstrahl/0"))).containsExactlyInAnyOrderElementsOf(
                eigenschaften("MessstelleQuelleAbschnitt"));
        JsonNode kanal = kanal(ok(rufe(HttpMethod.GET, "/api/v1/sites/" + w.an1() + "/komponenten/" + w.k("K-5")
                + "/messkanaele", w.admin(), null)).get("messkanaele"), ENERGIE_BEZUG);
        assertThat(felder(kanal.at("/speist/0"))).containsExactlyInAnyOrderElementsOf(eigenschaften("MesskanalSpeist"));
    }

    // ---- Gerüst: das Referenzunternehmen -------------------------------------------------------------

    /**
     * AN-1 mit Box E-1 und den Bestands-Komponenten K-1, K-3 … K-7 (Verbindung aus DQ-1 … DQ-3); ihre
     * Geräte GR-1 … GR-6 legt der Anlege-Weg an (V20260911240000). GR-4 trägt als Einbau Z-5a (erfasst
     * mit Seriennummer), wie die Referenzdatei. Dazu die Mess-Selektion der Kanäle, die die Tests binden.
     */
    private Werk ahrenberg(String zusatz) {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                referenz.at("/unternehmen/name").asText() + " · " + zusatz);
        JsonNode anlage = element(referenz.get("anlagen"), "AN-1");
        UUID an1 = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, anlage.get("name").asText(), ts(anlage.get("seit")));
        JsonNode e1 = element(referenz.get("boxen"), "E-1");
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, created_at) "
                + "VALUES (?, ?, ?, ?) RETURNING id", UUID.class, t, an1, e1.get("seriennummer").asText() + "-" + t,
                ts(e1.get("in_betrieb_ab")));
        Map<String, UUID> komponenten = new LinkedHashMap<>();
        for (String k : List.of("K-1", "K-3", "K-4", "K-5", "K-6", "K-7")) {
            JsonNode komponente = element(referenz.get("komponenten"), k);
            JsonNode geraet = element(referenz.get("geraete"), komponente.get("geraet").asText());
            JsonNode quelle = element(referenz.get("datenquellen"), geraet.get("datenquelle").asText());
            ObjectNode verbindung = MAPPER.createObjectNode().put("ip", quelle.get("adresse").asText())
                    .put("port", quelle.get("port").asInt()).put("unit_id", geraet.get("modbus_geraete_id").asInt());
            String art = "K-1".equals(k) ? "battery-hybrid" : "K-3".equals(k) ? "grid-meter" : "modbus-generic";
            komponenten.put(k, root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                    + "entity_type, device_id, control, communication, connection_json, created_at) "
                    + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?) RETURNING id", UUID.class, t, an1, art,
                    komponente.get("name").asText(), art, box, "battery-hybrid".equals(art),
                    "K-1".equals(k) ? "sunspec_tcp" : "modbus_tcp", verbindung.toString(),
                    ts(komponente.get("in_betrieb_ab"))));
        }
        assertThat(root.queryForList("SELECT kennzeichen FROM geraet WHERE tenant_id = ? ORDER BY length(kennzeichen), "
                + "kennzeichen", String.class, t)).containsExactly("GR-1", "GR-2", "GR-3", "GR-4", "GR-5", "GR-6");
        JsonNode z5a = element(element(referenz.get("geraete"), "GR-4").get("einbauten"), "Z-5a");
        root.update("UPDATE geraet SET einbau_kennzeichen = ?, seriennummer = ? WHERE tenant_id = ? AND kennzeichen = 'GR-4'",
                z5a.get("kennzeichen").asText(), z5a.get("seriennummer").asText(), t);
        Werk w = new Werk(t, new Anrufer("admin", t), an1, box, komponenten);
        messkanalAuswahl(w, "K-1", ERZEUGUNG_ZEHNTEL);
        messkanalAuswahl(w, "K-3", ENERGIE_BEZUG, ENERGIE_ABGABE, LEISTUNG_VORZEICHEN);
        messkanalAuswahl(w, "K-4", ENERGIE_BEZUG);
        messkanalAuswahl(w, "K-5", ENERGIE_BEZUG, LEISTUNG_VORZEICHEN, SPANNUNG);
        messkanalAuswahl(w, "K-6", ENERGIE_BEZUG);
        return w;
    }

    /** Der Zählerwechsel an K-5 (GR-4): Z-5a endet, Z-5b beginnt — genau zum selben Zeitpunkt. */
    private static void zaehlerwechsel(Werk w) {
        JsonNode gr4 = element(referenz.get("geraete"), "GR-4");
        JsonNode z5a = element(gr4.get("einbauten"), "Z-5a");
        JsonNode z5b = element(gr4.get("einbauten"), "Z-5b");
        Timestamp wechsel = ts(z5a.get("gueltig_bis"));
        UUID alt = root.queryForObject("SELECT id FROM geraet WHERE tenant_id = ? AND einbau_kennzeichen = ?",
                UUID.class, w.tenant(), z5a.get("kennzeichen").asText());
        root.update("UPDATE geraet SET ausgebaut_am = ? WHERE id = ?", wechsel, alt);
        root.update("UPDATE geraet_komponente SET gueltig_bis = ? WHERE geraet_id = ?", wechsel, alt);
        UUID neu = root.queryForObject("INSERT INTO geraet (tenant_id, site_id, kennzeichen, einbau_kennzeichen, "
                + "geraeteart, seriennummer, geraete_id, eingebaut_am) VALUES (?, ?, 'GR-4', ?, 'zaehler', ?, ?, ?) "
                + "RETURNING id", UUID.class, w.tenant(), w.an1(), z5b.get("kennzeichen").asText(),
                z5b.get("seriennummer").asText(), gr4.get("modbus_geraete_id").asInt(), ts(z5b.get("gueltig_ab")));
        root.update("INSERT INTO geraet_komponente (tenant_id, geraet_id, entity_id, gueltig_ab) VALUES (?, ?, ?, ?)",
                w.tenant(), neu, w.k("K-5"), ts(z5b.get("gueltig_ab")));
    }

    private static void messkanalAuswahl(Werk w, String komponente, String... kanaele) {
        for (String kanal : kanaele) {
            root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, "
                    + "point_key, enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, "
                    + "apply_status, retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, now(), "
                    + "'2026.08.26.3', 'test', 'pending_edge', 'energy_counter', 'fifteen_minute') ON CONFLICT DO NOTHING",
                    w.tenant(), w.an1(), w.box(), w.k(komponente), kanal);
        }
    }

    // ---- Gerüst: Anfragen ---------------------------------------------------------------------------

    private static Map<String, Object> binden(UUID komponente, String kanal, String rolle, String zweck, String ab) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("komponente", komponente.toString());
        body.put("kanal", kanal);
        body.put("rolle", rolle);
        if (zweck != null) {
            body.put("zweck", zweck);
        }
        if (ab != null) {
            body.put("gueltig_ab", ab);
        }
        return body;
    }

    private static Map<String, Object> stand(double wert, String einheit) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("wert", wert);
        s.put("einheit", einheit);
        return s;
    }

    /** Eine Messstelle mit den Werten der Referenz. */
    private static Map<String, Object> wieReferenz(String kennzeichen, JsonNode ms) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("kennzeichen", kennzeichen);
        body.put("name", ms.get("name").asText());
        body.put("art", ms.get("art").asText());
        body.put("medium", ms.get("medium").asText());
        body.put("hauptgroesse", groesseAus(ms.get("hauptgroesse")));
        List<JsonNode> neben = new ArrayList<>();
        ms.get("nebengroessen").forEach(n -> neben.add(groesseAus(n)));
        body.put("nebengroessen", neben);
        return body;
    }

    private static JsonNode groesseAus(JsonNode g) {
        ObjectNode n = MAPPER.createObjectNode();
        for (String f : List.of("groesse", "richtung", "einheit", "wertart")) {
            n.put(f, g.get(f).asText());
        }
        return n;
    }

    private JsonNode anlegen(Anrufer wer, Map<String, Object> body) {
        ResponseEntity<JsonNode> r = rufe(HttpMethod.POST, "/api/v1/messstellen", wer, body);
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(201);
        return r.getBody();
    }

    private void uhr(String zeitpunkt) {
        quellen.uhrStellen(Clock.fixed(OffsetDateTime.parse(zeitpunkt).toInstant(), BERLIN));
    }

    private ResponseEntity<JsonNode> rufe(HttpMethod methode, String pfad, Anrufer wer, Object body) {
        HttpHeaders headers = new HttpHeaders();
        if (wer != null) {
            headers.setBearerAuth(token(wer.benutzer()));
            if (wer.kundenbereich() != null) {
                headers.set("X-Tenant-Id", wer.kundenbereich().toString());
            }
        }
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<?> entity = body == null ? new HttpEntity<>(headers) : new HttpEntity<>(body, headers);
        return rest.exchange(java.net.URI.create("http://localhost:" + port + pfad), methode, entity, JsonNode.class);
    }

    private static JsonNode ok(ResponseEntity<JsonNode> r) {
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(200);
        return r.getBody();
    }

    private static JsonNode erfolgreich(ResponseEntity<JsonNode> r) {
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(201);
        return r.getBody();
    }

    private static int status(ResponseEntity<JsonNode> r) {
        return r.getStatusCode().value();
    }

    /** Die Ablehnung mit Status und Code — und ein Satz, nie leer. */
    private static void abgelehnt(ResponseEntity<JsonNode> r, int status, String code) {
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(status);
        assertThat(r.getBody().get("code").asText()).isEqualTo(code);
        assertThat(r.getBody().get("message").asText()).isNotBlank();
        assertThat(MessstelleAbgelehnt.CODES).contains(code);
    }

    private static void anfrage(ResponseEntity<JsonNode> r, String feld) {
        abgelehnt(r, 400, "anfrage_ungueltig");
        assertThat(r.getBody().get("feld").asText()).isEqualTo(feld);
    }

    private static void passtNicht(ResponseEntity<JsonNode> r, String grund) {
        abgelehnt(r, 422, "quelle_passt_nicht");
        assertThat(r.getBody().get("grund").asText()).isEqualTo(grund);
        assertThat(MessstelleRegeln.PASSUNG_GRUENDE).contains(grund);
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

    // ---- Gerüst: Datenbank und Vertrag ----------------------------------------------------------------

    private static long eintraege(UUID tenant) {
        return anzahl("SELECT count(*) FROM messstelle_aenderung WHERE tenant_id = ?", tenant);
    }

    private static long quellenDer(String messstelle) {
        return anzahl("SELECT count(*) FROM messstelle_quelle WHERE messstelle_id = ?", UUID.fromString(messstelle));
    }

    private static long anzahl(String sql, Object... args) {
        return root.queryForObject(sql, Long.class, args);
    }

    private static List<Map<String, Object>> protokoll(String messstelle) {
        return root.queryForList("SELECT art, alt::text AS alt, neu::text AS neu, gilt_ab, rueckwirkend, grund, "
                + "actor_sub, actor_name, actor_rolle, actor_art, created_at FROM messstelle_aenderung "
                + "WHERE messstelle_id = ? ORDER BY id", UUID.fromString(messstelle));
    }

    private static JsonNode quelleMitId(JsonNode liste, String id) {
        for (JsonNode q : liste.get("quellen")) {
            if (q.get("id").asText().equals(id)) {
                return q;
            }
        }
        throw new AssertionError("keine Quelle " + id);
    }

    private static JsonNode kanal(JsonNode kanaele, String kanal) {
        for (JsonNode k : kanaele) {
            if (k.get("kanal").asText().equals(kanal)) {
                return k;
            }
        }
        throw new AssertionError("kein Kanal " + kanal);
    }

    private static JsonNode referenzMessstelle(String kennzeichen) {
        return element(referenz.get("messstellen"), kennzeichen);
    }

    private static JsonNode element(JsonNode liste, String kennzeichen) {
        for (JsonNode e : liste) {
            if (kennzeichen.equals(e.get("kennzeichen").asText())) {
                return e;
            }
        }
        throw new AssertionError("nicht in der Referenzdatei: " + kennzeichen);
    }

    private static JsonNode fall(String familie, String name) {
        try {
            for (JsonNode c : MAPPER.readTree(V2.resolve("messstelle-vectors.json").toFile()).at("/cases/" + familie)) {
                if (c.get("name").asText().equals(name)) {
                    return c;
                }
            }
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        throw new AssertionError("kein Fall " + familie + "/" + name);
    }

    private static Timestamp ts(JsonNode n) {
        return Timestamp.from(OffsetDateTime.parse(n.asText()).toInstant());
    }

    private static Instant zeitpunkt(JsonNode n) {
        return zeitpunkt(n.asText());
    }

    private static Instant zeitpunkt(String s) {
        return OffsetDateTime.parse(s).toInstant();
    }

    private static JsonNode json(Object text) {
        try {
            return text == null ? MAPPER.nullNode() : MAPPER.readTree(text.toString());
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    @SuppressWarnings("unchecked")
    private static List<String> eigenschaften(String name) {
        Map<String, Object> s = (Map<String, Object>) schemas.get(name);
        assertThat(s).as(name).isNotNull();
        return new ArrayList<>(((Map<String, Object>) s.get("properties")).keySet());
    }

    private static List<String> felder(JsonNode n) {
        List<String> out = new ArrayList<>();
        n.fieldNames().forEachRemaining(out::add);
        return out;
    }
}
