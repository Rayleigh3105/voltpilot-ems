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

    // ---- Rahmen --------------------------------------------------------------------------------

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
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", "voltpilot-api");
        form.add("client_secret", "voltpilot-api-dev-secret");
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

    @SuppressWarnings("unused")
    private static final ParameterizedTypeReference<Map<String, Object>> MAP = new ParameterizedTypeReference<>() {};
}
