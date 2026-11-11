package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureTestRestTemplate;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.resttestclient.TestRestTemplate;
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
 * „Braucht dich" einzeln auf gelesen/erledigt setzen (Plattform-Übersicht,
 * Scheibe S4): {@code POST /api/v1/admin/plattform/braucht-dich/erledigen},
 * {@code GET …/erledigt}, {@code DELETE …/{schluessel}}. Platform-admin
 * geschützt wie jedes andere S6-Lesemodell (403 für den Kunden-Operator
 * {@code demo}).
 */
@Testcontainers(disabledWithoutDocker = true)
@AutoConfigureTestRestTemplate
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class AdminBrauchtDichApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

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
        registry.add("voltpilot.keycloak.admin.base-url", KEYCLOAK::getAuthServerUrl);
        registry.add("voltpilot.keycloak.admin.realm", () -> "voltpilot");
        registry.add("voltpilot.keycloak.admin.client-id", () -> "voltpilot-api");
        registry.add("voltpilot.keycloak.admin.client-secret", () -> "voltpilot-api-dev-secret");
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Test
    void erledigenIstIdempotentUndVerlangtPlatformAdmin() {
        String admin = token("admin", "admin");
        String schluessel = "fehler-s6-braucht-" + System.currentTimeMillis();

        // Erledigen, zweimal mit demselben Stand - bleibt ein Eintrag (Upsert).
        erledigen(admin, schluessel, "Update braucht dich");
        erledigen(admin, schluessel, "Update braucht dich");

        ResponseEntity<Map<String, Object>> liste = get("/api/v1/admin/plattform/braucht-dich/erledigt", admin);
        assertThat(liste.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> erledigt = cast(liste.getBody().get("erledigt"));
        List<Map<String, Object>> treffer = erledigt.stream()
                .filter(e -> schluessel.equals(e.get("schluessel"))).toList();
        assertThat(treffer).hasSize(1);
        assertThat(treffer.get(0).get("stand")).isEqualTo("Update braucht dich");
        assertThat(treffer.get(0).get("erledigtVon")).isNotNull();

        // Ein neuerer Grund für denselben Schlüssel ersetzt den Stand.
        erledigen(admin, schluessel, "Update braucht dich erneut");
        ResponseEntity<Map<String, Object>> liste2 = get("/api/v1/admin/plattform/braucht-dich/erledigt", admin);
        List<Map<String, Object>> erledigt2 = cast(liste2.getBody().get("erledigt"));
        Map<String, Object> aktualisiert = erledigt2.stream()
                .filter(e -> schluessel.equals(e.get("schluessel"))).findFirst().orElseThrow();
        assertThat(aktualisiert.get("stand")).isEqualTo("Update braucht dich erneut");

        // Zurückholen entfernt den Eintrag wieder.
        ResponseEntity<Void> del = rest.exchange(
                url("/api/v1/admin/plattform/braucht-dich/" + schluessel), HttpMethod.DELETE,
                new HttpEntity<>(bearer(admin)), Void.class);
        assertThat(del.getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        ResponseEntity<Map<String, Object>> liste3 = get("/api/v1/admin/plattform/braucht-dich/erledigt", admin);
        List<Map<String, Object>> erledigt3 = cast(liste3.getBody().get("erledigt"));
        assertThat(erledigt3.stream().noneMatch(e -> schluessel.equals(e.get("schluessel")))).isTrue();

        // Der Kunden-Operator demo ist kein platform-admin.
        String demo = token("demo", "demo");
        assertThat(get("/api/v1/admin/plattform/braucht-dich/erledigt", demo).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(rest.exchange(url("/api/v1/admin/plattform/braucht-dich/erledigen"), HttpMethod.POST,
                new HttpEntity<>(Map.of("eintraege", List.of(Map.of("schluessel", schluessel, "stand", "x"))),
                        bearer(demo)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
    }

    @Test
    void erledigenMehrererZeilenInEinemAufrufFuerAlleDieserArt() {
        String admin = token("admin", "admin");
        String k1 = "fehler-s6-art-a-" + System.currentTimeMillis();
        String k2 = "fehler-s6-art-b-" + System.currentTimeMillis();

        ResponseEntity<Void> res = rest.exchange(url("/api/v1/admin/plattform/braucht-dich/erledigen"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("eintraege", List.of(
                        Map.of("schluessel", k1, "stand", "Fehler A"),
                        Map.of("schluessel", k2, "stand", "Fehler B"))), bearer(admin)),
                Void.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);

        ResponseEntity<Map<String, Object>> liste = get("/api/v1/admin/plattform/braucht-dich/erledigt", admin);
        List<Map<String, Object>> erledigt = cast(liste.getBody().get("erledigt"));
        assertThat(erledigt.stream().map(e -> e.get("schluessel")))
                .contains(k1, k2);
    }

    private void erledigen(String token, String schluessel, String stand) {
        ResponseEntity<Void> res = rest.exchange(url("/api/v1/admin/plattform/braucht-dich/erledigen"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("eintraege", List.of(Map.of("schluessel", schluessel, "stand", stand))),
                        bearer(token)),
                Void.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
    }

    @SuppressWarnings("unchecked")
    private static <T> T cast(Object o) {
        return (T) o;
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

    private ResponseEntity<Map<String, Object>> get(String path, String token) {
        return rest.exchange(url(path), HttpMethod.GET, new HttpEntity<>(bearer(token)),
                new ParameterizedTypeReference<Map<String, Object>>() {});
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
}
