package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.JdkClientHttpRequestFactory;
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

/**
 * Fernwartung über das Portal (Entscheid E5, O3) gegen echtes TimescaleDB und
 * Keycloak: Schlüssel hinterlegen, Techniker-Zugang, Fenster öffnen und
 * schließen, der Soll-Stand für den Tunnel-Dienst, das Protokoll - und die
 * Rollen-Grenzen auf jeder Route.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
            "voltpilot.fernwartung.server-public-key=LnLMuBG+dDEeaEKlQrdTlPifX2fk0hOaB/NFc/BudjE=",
            "voltpilot.fernwartung.max-fenster-dauer=PT24H"
        })
@ActiveProfiles("local")
class FernwartungApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    /** Gültige Referenzen mit Prüfzeichen (Anhang B des Konzepts). */
    private static final String PILOT = "edge-zay5sdd";
    private static final String ZWEITE = "edge-k7m2xq3";

    private static final String KEY_A = "jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM=";
    private static final String KEY_B = "SBsk0U9z6BgB/U8nb+L9PdK/46p7mBvWRQe8I0Vg3C0=";
    private static final String KEY_C = "FY4LLXFaOvh8LPZu/gA4AeS2WJjXkuOUPB4hlxBI8/Y=";
    private static final String KEY_D = "Pgf4aS+67rz4HdSHuy8KKgm5e/UP3xnrMWJskXaZB9c=";

    private static final String BASE = "/api/v1/admin/fernwartung";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Container
    static final KeycloakContainer KEYCLOAK = new KeycloakContainer("quay.io/keycloak/keycloak:26.0.5")
            .withRealmImportFile("keycloak/voltpilot-realm.json");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", () -> APP_USER);
        registry.add("spring.datasource.password", () -> APP_PW);
        registry.add("voltpilot.admin-datasource.url", POSTGRES::getJdbcUrl);
        registry.add("voltpilot.admin-datasource.username", () -> ADMIN_USER);
        registry.add("voltpilot.admin-datasource.password", () -> ADMIN_PW);
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
        registry.add("spring.flyway.placeholders.appDbUser", () -> APP_USER);
        registry.add("spring.flyway.placeholders.appDbPassword", () -> APP_PW);
        registry.add("spring.flyway.placeholders.adminDbUser", () -> ADMIN_USER);
        registry.add("spring.flyway.placeholders.adminDbPassword", () -> ADMIN_PW);

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
    @Qualifier("adminJdbcTemplate")
    JdbcTemplate adminJdbc;

    private final ObjectMapper json = new ObjectMapper();

    @Test
    void derGanzeWegVomSchluesselBisZumGeschlossenenFenster() throws Exception {
        String admin = token("admin", "admin");
        String dienst = serviceToken("voltpilot-tunnel-dienst", "voltpilot-tunnel-dienst-dev-secret");

        // ── Box-Schlüssel hinterlegen (Übergang bis D2) ───────────────────
        ResponseEntity<String> neu = send(HttpMethod.PUT, BASE + "/boxen/" + PILOT.toUpperCase() + "/schluessel",
                admin, Map.of("publicKey", KEY_A, "notiz", "Pilot Dirolf"));
        assertThat(neu.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        JsonNode antwort = json.readTree(neu.getBody());
        assertThat(antwort.get("ergebnis").asText()).isEqualTo("angelegt");
        assertThat(antwort.at("/box/edgeRef").asText()).as("Referenz kanonisch klein").isEqualTo(PILOT);
        assertThat(antwort.at("/box/adresse").asText()).isEqualTo("10.10.16.2");
        assertThat(antwort.at("/box/status").asText()).isEqualTo("aktiv");
        // Alles, was service-tunnel.sh für die Box braucht, steht in der Antwort.
        assertThat(antwort.at("/server/endpunkt").asText()).isEqualTo("wartung.voltpilot.de");
        assertThat(antwort.at("/server/port").asInt()).isEqualTo(51820);
        assertThat(antwort.at("/server/eingerichtet").asBoolean()).isTrue();
        assertThat(antwort.at("/server/technikerNetz").asText()).isEqualTo("10.10.32.0/24");

        // Ein wiederholter Werkstatt-Lauf ist kein Fehler und ändert nichts.
        ResponseEntity<String> nochmal = send(HttpMethod.PUT, BASE + "/boxen/" + PILOT + "/schluessel", admin,
                Map.of("publicKey", KEY_A));
        assertThat(nochmal.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(json.readTree(nochmal.getBody()).get("ergebnis").asText()).isEqualTo("unveraendert");

        // Ein ANDERER Schlüssel nur mit ausdrücklicher Markierung.
        ResponseEntity<String> ohneMarke = send(HttpMethod.PUT, BASE + "/boxen/" + PILOT + "/schluessel", admin,
                Map.of("publicKey", KEY_B));
        assertThat(ohneMarke.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(ohneMarke)).contains("Schlüsseltausch");
        ResponseEntity<String> getauscht = send(HttpMethod.PUT, BASE + "/boxen/" + PILOT + "/schluessel", admin,
                Map.of("publicKey", KEY_B, "schluesselTausch", true));
        assertThat(getauscht.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode nachTausch = json.readTree(getauscht.getBody());
        assertThat(nachTausch.get("ergebnis").asText()).isEqualTo("getauscht");
        assertThat(nachTausch.at("/box/adresse").asText()).as("die Adresse bleibt der Box").isEqualTo("10.10.16.2");

        // Zweite Box: nächste Adresse; ein schon vergebener Schlüssel nie doppelt.
        ResponseEntity<String> doppelt = send(HttpMethod.PUT, BASE + "/boxen/" + ZWEITE + "/schluessel", admin,
                Map.of("publicKey", KEY_B));
        assertThat(doppelt.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(doppelt)).contains(PILOT);
        ResponseEntity<String> zweite = send(HttpMethod.PUT, BASE + "/boxen/" + ZWEITE + "/schluessel", admin,
                Map.of("publicKey", KEY_A));
        assertThat(zweite.getStatusCode()).as("der alte Pilot-Schlüssel ist wieder frei").isEqualTo(HttpStatus.CREATED);
        assertThat(json.readTree(zweite.getBody()).at("/box/adresse").asText()).isEqualTo("10.10.16.3");

        // Tippfehler und Unsinn fallen vor jeder Zeile auf.
        assertThat(send(HttpMethod.PUT, BASE + "/boxen/edge-zay5sdp/schluessel", admin,
                Map.of("publicKey", KEY_C)).getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(send(HttpMethod.PUT, BASE + "/boxen/irgendwas/schluessel", admin,
                Map.of("publicKey", KEY_C)).getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(send(HttpMethod.PUT, BASE + "/boxen/edge-q2w3e4u/schluessel", admin,
                Map.of("publicKey", "kein-schluessel")).getStatusCode()).isIn(HttpStatus.BAD_REQUEST,
                HttpStatus.UNPROCESSABLE_ENTITY);

        // ── Techniker-Zugang ──────────────────────────────────────────────
        ResponseEntity<String> technikerNeu = send(HttpMethod.POST, BASE + "/techniker", admin,
                Map.of("name", "Max (Laptop)", "publicKey", KEY_C));
        assertThat(technikerNeu.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        JsonNode techniker = json.readTree(technikerNeu.getBody());
        String technikerId = techniker.at("/techniker/id").asText();
        assertThat(techniker.at("/techniker/adresse").asText()).isEqualTo("10.10.32.2");
        assertThat(techniker.at("/server/boxNetz").asText()).isEqualTo("10.10.16.0/20");
        // Ein Box-Schlüssel kann kein Techniker-Zugang werden.
        assertThat(send(HttpMethod.POST, BASE + "/techniker", admin,
                Map.of("name", "Doppelt", "publicKey", KEY_B)).getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

        // ── Ohne Fenster: Peers ja, Weg nein ──────────────────────────────
        JsonNode soll = getJson("/api/v1/fernwartung/soll", dienst);
        assertThat(soll.get("version").asInt()).isEqualTo(1);
        assertThat(soll.get("boxNetz").asText()).isEqualTo("10.10.16.0/20");
        assertThat(soll.get("peers")).hasSize(3);
        assertThat(soll.get("fenster")).isEmpty();

        // ── Fenster öffnen ────────────────────────────────────────────────
        ResponseEntity<String> ohneGrund = send(HttpMethod.POST, BASE + "/fenster", admin,
                Map.of("edgeRef", PILOT, "technikerId", technikerId, "grund", " ", "dauerMinuten", 60));
        assertThat(ohneGrund.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        ResponseEntity<String> zuLang = send(HttpMethod.POST, BASE + "/fenster", admin,
                Map.of("edgeRef", PILOT, "technikerId", technikerId, "grund", "Update", "dauerMinuten", 25 * 60));
        assertThat(zuLang.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(message(zuLang)).contains("24 Stunden");

        ResponseEntity<String> offen = send(HttpMethod.POST, BASE + "/fenster", admin,
                Map.of("edgeRef", PILOT, "technikerId", technikerId, "grund", "Update auf Stufe 2",
                        "dauerMinuten", 60));
        assertThat(offen.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        JsonNode fenster = json.readTree(offen.getBody());
        String fensterId = fenster.get("id").asText();
        assertThat(fenster.get("zustand").asText()).isEqualTo("offen");
        assertThat(fenster.get("geoeffnetVon").asText()).isEqualTo("admin");
        assertThat(Duration.between(Instant.parse(fenster.get("beginn").asText()),
                Instant.parse(fenster.get("ende").asText()))).isEqualTo(Duration.ofHours(1));

        ResponseEntity<String> ueberlappt = send(HttpMethod.POST, BASE + "/fenster", admin,
                Map.of("edgeRef", PILOT, "technikerId", technikerId, "grund", "Noch eins", "dauerMinuten", 30));
        assertThat(ueberlappt.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

        // Ein geplantes Fenster steht NICHT im Soll-Stand.
        ResponseEntity<String> geplant = send(HttpMethod.POST, BASE + "/fenster", admin,
                Map.of("edgeRef", ZWEITE, "technikerId", technikerId, "grund", "Termin morgen",
                        "dauerMinuten", 120, "beginn", Instant.now().plus(Duration.ofHours(20)).toString()));
        assertThat(geplant.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(json.readTree(geplant.getBody()).get("zustand").asText()).isEqualTo("geplant");

        soll = getJson("/api/v1/fernwartung/soll", dienst);
        assertThat(soll.get("fenster")).hasSize(1);
        JsonNode sollFenster = soll.get("fenster").get(0);
        assertThat(sollFenster.get("id").asText()).isEqualTo(fensterId);
        String pilotId = peer(soll, PILOT).get("id").asText();
        assertThat(sollFenster.get("boxId").asText()).isEqualTo(pilotId);
        assertThat(sollFenster.get("technikerId").asText()).isEqualTo(technikerId);
        assertThat(peer(soll, PILOT).get("publicKey").asText()).isEqualTo(KEY_B);
        assertThat(peer(soll, PILOT).get("adresse").asText()).isEqualTo("10.10.16.2");

        // Die Übersicht weiß, DASS abgeholt wurde - nicht, ob es wirkt.
        JsonNode uebersicht = getJson(BASE, admin);
        assertThat(uebersicht.get("abrufe")).hasSize(1);
        assertThat(uebersicht.at("/abrufe/0/dienst").asText()).isEqualTo("voltpilot-tunnel-dienst");
        assertThat(uebersicht.at("/abrufe/0/fenster").asInt()).isEqualTo(1);
        assertThat(uebersicht.get("fensterOffen").asLong()).isEqualTo(1);
        assertThat(uebersicht.get("fensterGeplant").asLong()).isEqualTo(1);
        assertThat(uebersicht.get("maxFensterMinuten").asLong()).isEqualTo(24 * 60);

        JsonNode boxen = getJson(BASE + "/boxen", admin);
        assertThat(boxen).hasSize(2);
        assertThat(boxen.get(0).get("laufendeFenster")).hasSize(1);

        // ── Vorzeitig schließen ───────────────────────────────────────────
        ResponseEntity<String> zu = send(HttpMethod.POST, BASE + "/fenster/" + fensterId + "/schliessen", admin, null);
        assertThat(zu.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(json.readTree(zu.getBody()).get("zustand").asText()).isEqualTo("geschlossen");
        assertThat(getJson("/api/v1/fernwartung/soll", dienst).get("fenster")).isEmpty();
        assertThat(send(HttpMethod.POST, BASE + "/fenster/" + fensterId + "/schliessen", admin, null)
                .getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

        // ── Sperren: Peer raus, geplantes Fenster abgesagt ────────────────
        ResponseEntity<String> gesperrt = send(HttpMethod.POST, BASE + "/techniker/" + technikerId + "/sperren",
                admin, Map.of("grund", "Laptop verloren"));
        assertThat(gesperrt.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(json.readTree(gesperrt.getBody()).get("status").asText()).isEqualTo("gesperrt");
        soll = getJson("/api/v1/fernwartung/soll", dienst);
        assertThat(soll.get("peers")).hasSize(2);
        JsonNode liste = getJson(BASE + "/fenster?box=" + ZWEITE, admin);
        assertThat(liste.get(0).get("zustand").asText()).isEqualTo("abgesagt");
        assertThat(send(HttpMethod.POST, BASE + "/fenster", admin,
                Map.of("edgeRef", PILOT, "technikerId", technikerId, "grund", "Gesperrt?", "dauerMinuten", 10))
                .getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(send(HttpMethod.POST, BASE + "/techniker/" + technikerId + "/entsperren", admin, null)
                .getStatusCode()).isEqualTo(HttpStatus.OK);

        ResponseEntity<String> boxGesperrt = send(HttpMethod.POST, BASE + "/boxen/" + ZWEITE + "/sperren", admin,
                null);
        assertThat(json.readTree(boxGesperrt.getBody()).get("status").asText()).isEqualTo("gesperrt");
        assertThat(getJson("/api/v1/fernwartung/soll", dienst).get("peers")).hasSize(2);

        // ── Das Protokoll ─────────────────────────────────────────────────
        JsonNode protokoll = getJson(BASE + "/protokoll?box=" + PILOT, admin);
        List<String> aktionen = new ArrayList<>();
        protokoll.forEach(e -> aktionen.add(e.get("aktion").asText()));
        assertThat(aktionen).containsExactly("fenster_geschlossen", "fenster_geoeffnet",
                "box_schluessel_getauscht", "box_schluessel_hinterlegt");
        JsonNode geoeffnet = protokoll.get(1);
        assertThat(geoeffnet.get("akteur").asText()).isEqualTo("admin");
        assertThat(geoeffnet.at("/details/grund").asText()).isEqualTo("Update auf Stufe 2");
        assertThat(geoeffnet.at("/details/techniker").asText()).isEqualTo("Max (Laptop)");
        assertThat(geoeffnet.get("technikerName").asText()).isEqualTo("Max (Laptop)");
        assertThat(protokoll.get(0).at("/details/anlass").asText()).isEqualTo("vorzeitig");

        JsonNode alles = getJson(BASE + "/protokoll", admin);
        List<String> alleAktionen = new ArrayList<>();
        alles.forEach(e -> alleAktionen.add(e.get("aktion").asText()));
        assertThat(alleAktionen).contains("techniker_angelegt", "techniker_gesperrt", "techniker_entsperrt",
                "box_gesperrt");

        // Append-only an der Datenbankgrenze, auch für die Admin-Rolle.
        assertThatThrownBy(() -> adminJdbc.update("DELETE FROM fernwartung_protokoll"))
                .rootCause().hasMessageContaining("permission denied");
        assertThatThrownBy(() -> adminJdbc.update("DELETE FROM fernwartung_zugang"))
                .rootCause().hasMessageContaining("permission denied");
    }

    /**
     * O3 und die Rollen-Grenze: der Kunde sieht nichts, das Dienstkonto liest
     * nur seinen Soll-Stand, der Release-Publisher erreicht hier nichts.
     */
    @Test
    void nurAdminsVerwaltenUndDerDienstLiestNur() {
        String admin = token("admin", "admin");
        String kunde = token("demo", "demo");
        String dienst = serviceToken("voltpilot-tunnel-dienst", "voltpilot-tunnel-dienst-dev-secret");
        String publisher = serviceToken("voltpilot-release-publisher", "voltpilot-release-publisher-dev-secret");

        List<Object[]> adminRouten = List.of(
                new Object[] {HttpMethod.GET, BASE, null},
                new Object[] {HttpMethod.GET, BASE + "/boxen", null},
                new Object[] {HttpMethod.GET, BASE + "/boxen/" + PILOT, null},
                new Object[] {HttpMethod.PUT, BASE + "/boxen/" + PILOT + "/schluessel", Map.of("publicKey", KEY_D)},
                new Object[] {HttpMethod.POST, BASE + "/boxen/" + PILOT + "/sperren", null},
                new Object[] {HttpMethod.POST, BASE + "/boxen/" + PILOT + "/entsperren", null},
                new Object[] {HttpMethod.GET, BASE + "/techniker", null},
                new Object[] {HttpMethod.POST, BASE + "/techniker", Map.of("name", "x", "publicKey", KEY_D)},
                new Object[] {HttpMethod.GET, BASE + "/fenster", null},
                new Object[] {HttpMethod.POST, BASE + "/fenster", Map.of("edgeRef", PILOT,
                        "technikerId", "00000000-0000-0000-0000-000000000000", "grund", "x", "dauerMinuten", 5)},
                new Object[] {HttpMethod.POST, BASE + "/fenster/00000000-0000-0000-0000-000000000000/schliessen",
                        null},
                new Object[] {HttpMethod.GET, BASE + "/protokoll", null});
        for (Object[] r : adminRouten) {
            HttpMethod m = (HttpMethod) r[0];
            String pfad = (String) r[1];
            for (String fremd : List.of(kunde, dienst, publisher)) {
                assertThat(send(m, pfad, fremd, r[2]).getStatusCode()).as(m + " " + pfad)
                        .isEqualTo(HttpStatus.FORBIDDEN);
            }
            assertThat(send(m, pfad, null, r[2]).getStatusCode()).as("anonym " + m + " " + pfad)
                    .isEqualTo(HttpStatus.UNAUTHORIZED);
        }

        // Die Leseroute: nur das Dienstkonto, auch kein Admin.
        for (String fremd : List.of(admin, kunde, publisher)) {
            assertThat(send(HttpMethod.GET, "/api/v1/fernwartung/soll", fremd, null).getStatusCode())
                    .isEqualTo(HttpStatus.FORBIDDEN);
        }
        assertThat(send(HttpMethod.GET, "/api/v1/fernwartung/soll", null, null).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        ResponseEntity<String> soll = send(HttpMethod.GET, "/api/v1/fernwartung/soll", dienst, null);
        assertThat(soll.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(soll.getHeaders().getCacheControl()).contains("no-store");
        // Nur Leserecht: es gibt keine schreibende Methode auf dem Pfad.
        assertThat(send(HttpMethod.POST, "/api/v1/fernwartung/soll", dienst, Map.of()).getStatusCode())
                .isIn(HttpStatus.METHOD_NOT_ALLOWED, HttpStatus.FORBIDDEN);

        // O3 an der Datenbankgrenze: die App-Rolle (der Kunden-Datenpfad)
        // liest keine einzige Fernwartungs-Tabelle.
        JdbcTemplate app = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), APP_USER, APP_PW));
        for (String tabelle : List.of("fernwartung_zugang", "fernwartung_fenster", "fernwartung_protokoll",
                "fernwartung_dienst_abruf")) {
            assertThatThrownBy(() -> app.queryForObject("SELECT count(*) FROM " + tabelle, Long.class))
                    .as(tabelle).rootCause().hasMessageContaining("permission denied");
        }
    }

    // ── Hilfen ────────────────────────────────────────────────────────────

    private JsonNode peer(JsonNode soll, String kennung) {
        for (JsonNode p : soll.get("peers")) {
            if (kennung.equals(p.get("kennung").asText())) {
                return p;
            }
        }
        throw new AssertionError("kein Peer " + kennung + " in " + soll);
    }

    private String message(ResponseEntity<String> res) throws Exception {
        return json.readTree(res.getBody()).get("message").asText();
    }

    private JsonNode getJson(String pfad, String token) {
        ResponseEntity<String> res = send(HttpMethod.GET, pfad, token, null);
        assertThat(res.getStatusCode()).as("GET " + pfad).isEqualTo(HttpStatus.OK);
        try {
            return json.readTree(res.getBody());
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    private ResponseEntity<String> send(HttpMethod method, String pfad, String token, Object body) {
        HttpHeaders h = new HttpHeaders();
        if (token != null) {
            h.setBearerAuth(token);
        }
        h.setContentType(MediaType.APPLICATION_JSON);
        return rest.exchange("http://localhost:" + port + pfad, method, new HttpEntity<>(body, h), String.class);
    }

    private String token(String username, String password) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", "voltpilot-api");
        form.add("client_secret", "voltpilot-api-dev-secret");
        form.add("username", username);
        form.add("password", password);
        form.add("scope", "openid");
        return tokenAnfrage(form);
    }

    private String serviceToken(String clientId, String clientSecret) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "client_credentials");
        form.add("client_id", clientId);
        form.add("client_secret", clientSecret);
        return tokenAnfrage(form);
    }

    @SuppressWarnings("unchecked")
    private String tokenAnfrage(MultiValueMap<String, String> form) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        TestRestTemplate keycloak = new TestRestTemplate();
        keycloak.getRestTemplate().setRequestFactory(new JdkClientHttpRequestFactory());
        Map<String, Object> body = keycloak.postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).containsKey("access_token");
        return (String) body.get("access_token");
    }
}
