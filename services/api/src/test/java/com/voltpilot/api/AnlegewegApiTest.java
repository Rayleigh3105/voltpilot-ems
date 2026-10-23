package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
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
 * Der Anlege-Weg einer Anlage (Konzept a1, {@code vp-anlage-flow-konzept}) gegen echtes Keycloak und
 * echte TimescaleDB: jede Regel, die der Scout mit einem Befund belegt hat, hier als Regressionstest.
 *
 * <p>Auto-skips where Docker is unavailable ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class AnlegewegApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";

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
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
        registry.add("spring.flyway.placeholders.appDbUser", () -> APP_USER);
        registry.add("spring.flyway.placeholders.appDbPassword", () -> APP_PW);
        registry.add("voltpilot.admin-datasource.url", POSTGRES::getJdbcUrl);
        registry.add("voltpilot.admin-datasource.username", () -> ADMIN_USER);
        registry.add("voltpilot.admin-datasource.password", () -> ADMIN_PW);
        registry.add("spring.flyway.placeholders.adminDbUser", () -> ADMIN_USER);
        registry.add("spring.flyway.placeholders.adminDbPassword", () -> ADMIN_PW);
        registry.add("voltpilot.keycloak.admin.base-url", KEYCLOAK::getAuthServerUrl);
        registry.add("voltpilot.keycloak.admin.realm", () -> "voltpilot");
        registry.add("voltpilot.keycloak.admin.client-id", () -> "voltpilot-api");
        registry.add("voltpilot.keycloak.admin.client-secret", () -> "voltpilot-api-dev-secret");
        registry.add("voltpilot.registration.rate-limit.per-client-max", () -> "100");
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

    // ---- B4: eine vertippte Kennung wird kein Gerät ---------------------------------------------

    /**
     * Die Fälle aus {@code belege/kennung-api.txt}: ohne Aufkleber zählt die Kennung aus der App der
     * Box, und genau ihre häufigsten Tippfehler antworteten 201 und legten ein Gerät an, das sich nie
     * meldete. Ein Kundenkonto verbindet jetzt nur Kennungen einer Box (oder des Herstellregisters).
     */
    @Test
    void kundenkontoVerbindetNurKennungenEinerBox() {
        String demo = token("demo", "demo");
        for (String tippfehler : new String[] {"k7m2xq3", "edgek7m2xq3", "edge-k7m2xq1", "edge-k7m2xqz",
                "demo-wechselrichter-07"}) {
            ResponseEntity<String> r = claim(bearer(demo), tippfehler);
            assertThat(r.getStatusCode()).as("Kennung %s", tippfehler).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
            assertThat(anzahl("SELECT count(*) FROM device WHERE external_ref = ?", tippfehler))
                    .as("kein Geister-Gerät %s", tippfehler).isZero();
        }
        ResponseEntity<String> richtig = claim(bearer(demo), "EDGE-K7M2XQ3");
        assertThat(richtig.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(richtig.getBody()).contains("\"externalRef\":\"edge-k7m2xq3\"");
    }

    /** Die Plattform behält freie Kennungen (Entwicklung, Integrationen). */
    @Test
    void plattformVerbindetWeiterFreieKennungen() {
        HttpHeaders admin = bearer(token("admin", "admin"));
        admin.set("X-Tenant-Id", TENANT_A);
        ResponseEntity<String> r = claim(admin, "integration-wr-01");
        assertThat(r.getStatusCode()).isEqualTo(HttpStatus.CREATED);
    }

    // ---- B3: dieselbe Anfrage-Kennung legt nie doppelt an -----------------------------------

    /**
     * Die Nachstellung aus {@code belege/fehler-1440}: der Server legt an, die Antwort geht verloren,
     * das Portal wiederholt - mit derselben Kennung ist es dieselbe Anlage.
     */
    @Test
    void gleicherSchluesselEineAnlage() {
        String t = registrieren("Garagen Meier", "zuhause");
        ResponseEntity<Map<String, Object>> erste = post(t, "/api/v1/sites", Map.of("name", "Garage"), "anlage-7f3c-0001");
        ResponseEntity<Map<String, Object>> zweite = post(t, "/api/v1/sites", Map.of("name", "Garage"), "anlage-7f3c-0001");
        assertThat(erste.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(zweite.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(zweite.getHeaders().getFirst("Idempotent-Replayed")).isEqualTo("true");
        assertThat(zweite.getBody().get("id")).isEqualTo(erste.getBody().get("id"));
        assertThat(anlagen(t)).isEqualTo(1);

        // Andere Angaben unter derselben Kennung: ein Fehler, nie eine fremde Antwort.
        ResponseEntity<String> anders = rest.exchange(url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Garage 2"), kopf(t, "anlage-7f3c-0001")), String.class);
        assertThat(anders.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(anders.getBody()).contains("\"code\":\"anfrage_kennung_anders\"");
        // Ohne Kennung wie bisher: ein zweites Anlegen ist ein zweites Anlegen.
        post(t, "/api/v1/sites", Map.of("name", "Garage"), null);
        assertThat(anlagen(t)).isEqualTo(2);
        // Eine andere Kundin mit derselben Kennung: ihre eigene Anlage (je Kundenbereich).
        String andere = registrieren("Garagen Schulz", "zuhause");
        assertThat(post(andere, "/api/v1/sites", Map.of("name", "Garage"), "anlage-7f3c-0001").getBody().get("id"))
                .isNotEqualTo(erste.getBody().get("id"));
        assertThat(anlagen(andere)).isEqualTo(1);
    }

    /** Zwei Anfragen mit derselben Kennung gleichzeitig: eine Anlage (Sperre bis zum Ende der Transaktion). */
    @Test
    void gleichzeitigMitDemselbenSchluesselEineAnlage() throws Exception {
        String t = registrieren("Paralleler Weg", "zuhause");
        var pool = java.util.concurrent.Executors.newFixedThreadPool(4);
        try {
            var antworten = new java.util.ArrayList<java.util.concurrent.Future<ResponseEntity<Map<String, Object>>>>();
            for (int i = 0; i < 4; i++) {
                antworten.add(pool.submit(() -> post(t, "/api/v1/sites", Map.of("name", "Dach"), "gleichzeitig-0001")));
            }
            java.util.Set<Object> ids = new java.util.HashSet<>();
            for (var a : antworten) {
                ResponseEntity<Map<String, Object>> r = a.get();
                assertThat(r.getStatusCode()).isEqualTo(HttpStatus.CREATED);
                ids.add(r.getBody().get("id"));
            }
            assertThat(ids).hasSize(1);
        } finally {
            pool.shutdownNow();
        }
        assertThat(anlagen(t)).isEqualTo(1);
    }

    /** Der Standort aus demselben Formular: dieselbe Kennung, derselbe Standort statt 409. */
    @Test
    void gleicherSchluesselEinStandort() {
        String t = registrieren("Hof Lindner", "zuhause");
        Map<String, Object> body = Map.of("name", "Zuhause",
                "adresse", Map.of("strasse", "Dorfstraße 1", "ort", "Treuchtlingen", "land", "DE"));
        ResponseEntity<Map<String, Object>> erste = post(t, "/api/v1/standorte", body, "formular-1:standort");
        ResponseEntity<Map<String, Object>> zweite = post(t, "/api/v1/standorte", body, "formular-1:standort");
        assertThat(erste.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(zweite.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(zweite.getBody().get("id")).isEqualTo(erste.getBody().get("id"));
        ResponseEntity<String> kaputt = rest.exchange(url("/api/v1/standorte"), HttpMethod.POST,
                new HttpEntity<>(body, kopf(t, "x")), String.class);
        assertThat(kaputt.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(kaputt.getBody()).contains("anfrage_kennung_ungueltig");
    }

    // ---- F4: Fehler am Feld -------------------------------------------------------------------

    /** „29,995“ kW hieß „Bitte prüfen Sie den Namen“ - jetzt nennt die Antwort das Feld. */
    @Test
    void ablehnungNenntDasFeld() {
        String t = registrieren("Carport Ost", "zuhause");
        ResponseEntity<Map<String, Object>> r = post(t, "/api/v1/sites",
                Map.of("name", "Carport Ost", "maxFeedInKw", 29.995), null);
        assertThat(r.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(r.getBody()).containsEntry("code", "anfrage_ungueltig").containsEntry("feld", "maxFeedInKw")
                .containsEntry("message", "Höchstens zwei Nachkommastellen und unter 1.000.000 kW, z. B. 29,99.");
        ResponseEntity<Map<String, Object>> preis = post(t, "/api/v1/sites",
                Map.of("name", "Carport Ost", "tarifArt", "fest", "tarifParamCtKwh", 32.1234), null);
        assertThat(preis.getBody()).containsEntry("feld", "tarifParamCtKwh");
        ResponseEntity<Map<String, Object>> name = post(t, "/api/v1/sites", Map.of("name", " "), null);
        assertThat(name.getBody()).containsEntry("feld", "name")
                .containsEntry("message", "Bitte geben Sie einen Namen für Ihre Anlage ein.");
        assertThat(anlagen(t)).isZero();
    }

    // ---- Rahmen --------------------------------------------------------------------------------

    private static final ParameterizedTypeReference<Map<String, Object>> MAP = new ParameterizedTypeReference<>() {};

    /** Ein neuer Kundenbereich über die Selbstregistrierung - das Token seiner Kundin. */
    private String registrieren(String name, String zweck) {
        String email = "kundin-" + System.nanoTime() + "@beispiel.test";
        Map<String, Object> body = new java.util.HashMap<>(Map.of("name", name, "email", email,
                "password", "ein-langes-passwort"));
        if (zweck != null) {
            body.put("zweck", zweck);
        }
        ResponseEntity<String> r = rest.exchange(url("/api/v1/registration"), HttpMethod.POST,
                new HttpEntity<>(body, json()), String.class);
        assertThat(r.getStatusCode()).as(r.getBody()).isEqualTo(HttpStatus.CREATED);
        return grant(email, "ein-langes-passwort", "voltpilot-frontend", null);
    }

    private Map<String, Object> kontext(String token) {
        return rest.exchange(url("/api/v1/tenant-context"), HttpMethod.GET, new HttpEntity<>(bearer(token)), MAP)
                .getBody();
    }

    private ResponseEntity<Map<String, Object>> post(String token, String pfad, Object body, String kennung) {
        return rest.exchange(url(pfad), HttpMethod.POST, new HttpEntity<>(body, kopf(token, kennung)), MAP);
    }

    private static HttpHeaders kopf(String token, String kennung) {
        HttpHeaders h = bearer(token);
        if (kennung != null) {
            h.set("Idempotency-Key", kennung);
        }
        return h;
    }

    private long anlagen(String token) {
        return com.voltpilot.api.SichtbareListenTestLeser.lesen(rest, url("/api/v1/sites"), HttpMethod.GET,
                new HttpEntity<>(bearer(token)), new ParameterizedTypeReference<java.util.List<Map<String, Object>>>() {})
                .getBody().size();
    }

    private static HttpHeaders json() {
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.APPLICATION_JSON);
        return h;
    }

    private static void exec(String sql) {
        try (Connection c = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                java.sql.Statement st = c.createStatement()) {
            st.execute(sql);
        } catch (Exception e) {
            throw new IllegalStateException(sql, e);
        }
    }

    private ResponseEntity<String> claim(HttpHeaders headers, String kennung) {
        return rest.exchange(url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", kennung), headers), String.class);
    }

    private String url(String path) {
        return "http://localhost:" + port + path;
    }

    private static HttpHeaders bearer(String token) {
        HttpHeaders h = new HttpHeaders();
        h.setBearerAuth(token);
        h.setContentType(MediaType.APPLICATION_JSON);
        return h;
    }

    private static long anzahl(String sql, Object... args) {
        try (Connection c = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                PreparedStatement ps = c.prepareStatement(sql)) {
            for (int i = 0; i < args.length; i++) {
                ps.setObject(i + 1, args[i]);
            }
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getLong(1);
            }
        } catch (Exception e) {
            throw new IllegalStateException(sql, e);
        }
    }

    private String token(String username, String password) {
        return grant(username, password, "voltpilot-api", "voltpilot-api-dev-secret");
    }

    private String grant(String username, String password, String clientId, String secret) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", clientId);
        if (secret != null) {
            form.add("client_secret", secret);
        }
        form.add("username", username);
        form.add("password", password);
        form.add("scope", "openid");
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        Map<String, Object> body = new TestRestTemplate().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).as("token response").containsKey("access_token");
        return (String) body.get("access_token");
    }
}
