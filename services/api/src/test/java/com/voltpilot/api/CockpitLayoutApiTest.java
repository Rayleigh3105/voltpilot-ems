package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.util.ArrayList;
import java.util.List;
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
 * Der LAYOUT-Speicher des Cockpits (Anwendungs-Programm Stufe 3) end to end
 * gegen echtes Keycloak + TimescaleDB.
 *
 * <p>Die Beweis-Matrix (Captain-Entscheide E1/E2):
 * <ul>
 *   <li><b>Bestand:</b> eine Anlage ohne Zeile antwortet mit lauter leeren
 *       Schichten — die Fläche fällt damit auf den Katalog-Standard, also auf
 *       das Verhalten vor dieser Stufe;</li>
 *   <li><b>Eigen &gt; Vorgabe:</b> der Kunde schreibt seine Schicht, der Admin
 *       die Vorgabe, und beide stehen NEBENEINANDER in der Antwort — nur so
 *       kann die Fläche sagen, worauf ein „Zurücksetzen" fällt;</li>
 *   <li><b>Reset ist ein DELETE:</b> die eigene Schicht verschwindet, die
 *       Vorgabe bleibt;</li>
 *   <li><b>der Kunde kann keine Vorgabe schreiben</b> (403), und ein Admin
 *       erreicht sie nur über den Mandanten-Umschalter;</li>
 *   <li><b>die Form-Prüfung:</b> unbekannter Baustein, Pflicht-Baustein in
 *       {@code hidden}, ein erfundener Lead und eine unbekannte Schicht sind je
 *       ein 400 mit deutschem Grund — und schreiben NICHTS;</li>
 *   <li><b>ein Baustein, den die Anlage gerade nicht hat, wird ausdrücklich
 *       NICHT abgelehnt</b> (die Präferenz muss ein Ab- und Wiedereinschalten
 *       einer Anwendung überleben);</li>
 *   <li><b>RLS:</b> eine fremde Anlage ist 404, nie 403.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class CockpitLayoutApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";
    private static final String HAMBURG_SITE = "10000000-0000-0000-0000-000000000002";

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

    @Test
    void theCustomerArrangesTheirCockpitAndTheAdminsVorgabeStaysBesideIt() {
        String demo = token("demo", "demo");
        String admin = token("admin", "admin");

        // -- 1. Bestand: keine Zeile, keine Aussage --------------------------
        JsonNode leer = customer(path(BERLIN_SITE), HttpMethod.GET, demo, null).getBody();
        assertThat(leer.path("surface").asText()).isEqualTo("cockpit");
        assertThat(leer.path("eigen").isNull()).as("keine Zeile = kein Wille").isTrue();
        assertThat(leer.path("siteVorgabe").isNull()).isTrue();
        assertThat(leer.path("tenantVorgabe").isNull()).isTrue();
        assertThat(leer.path("darfVorgabe").asBoolean()).as("ein Kunde ist kein Betreiber")
                .isFalse();
        // Der Baustein-Katalog reist mit — die Fläche braucht Labels und die
        // Pflicht-Regel, ohne sie ein zweites Mal aufzuschreiben.
        assertThat(bausteinIds(leer)).contains("status", "energiefluss", "geld", "kacheln",
                "komponenten", "zustand");
        assertThat(baustein(leer, "zustand").path("pflicht").asBoolean()).isTrue();
        assertThat(baustein(leer, "kacheln").path("pflicht").asBoolean()).isFalse();
        assertThat(baustein(leer, "energiefluss").path("beweglich").asBoolean())
                .as("die Bühne bleibt die Bühne").isFalse();
        assertThat(baustein(leer, "geld").path("leadBlock").asText())
                .isEqualTo("erloes-komposition");
        // „Beigesteuert von" ist ABGELEITET, nie eine zweite Liste.
        assertThat(strings(baustein(leer, "kacheln").path("beigesteuertVon")))
                .contains("marktvermarktung", "lastspitzenkappung");
        assertThat(strings(baustein(leer, "komponenten").path("beigesteuertVon")))
                .as("Grundausstattung hat keinen Beisteuerer").isEmpty();

        // -- 2. Der Kunde ordnet an ------------------------------------------
        JsonNode gespeichert = customer(path(BERLIN_SITE), HttpMethod.PUT, demo,
                Map.of("order", List.of("status", "energiefluss", "geld", "steuerung", "fahrplan",
                        "kacheln", "strompreis", "komponenten", "zustand"),
                        "hidden", List.of("strompreis"), "shown", List.of(), "lead",
                        "energiefluss"))
                .getBody();
        assertThat(gespeichert.path("eigen").path("document").path("hidden").get(0).asText())
                .isEqualTo("strompreis");
        assertThat(gespeichert.path("eigen").path("document").path("lead").asText())
                .isEqualTo("energiefluss");
        // Die Papier-Spur: WER hat das gemacht (das JWT-Subject).
        assertThat(gespeichert.path("eigen").path("updatedBy").asText()).isNotBlank();
        // Der Wille überlebt einen frischen Abruf.
        assertThat(customer(path(BERLIN_SITE), HttpMethod.GET, demo, null).getBody()
                .path("eigen").path("document").path("order").size()).isEqualTo(9);

        // -- 3. Der Kunde kann KEINE Vorgabe schreiben (E2) --------------------
        ResponseEntity<JsonNode> verboten = customer(path(BERLIN_SITE) + "?layer=vorgabe",
                HttpMethod.PUT, demo, Map.of("hidden", List.of("kacheln")));
        assertThat(verboten.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(verboten.getBody().path("message").asText()).contains("VoltPilot");

        // -- 4. Der Admin gestaltet die Vorgabe über den Umschalter ------------
        JsonNode mitVorgabe = exchange(path(BERLIN_SITE) + "?layer=vorgabe", HttpMethod.PUT, admin,
                TENANT_A, Map.of("hidden", List.of("kacheln"), "lead", "erloes-komposition"))
                .getBody();
        assertThat(mitVorgabe.path("darfVorgabe").asBoolean()).isTrue();
        assertThat(mitVorgabe.path("siteVorgabe").path("document").path("hidden").get(0).asText())
                .isEqualTo("kacheln");
        // BEIDE Schichten stehen nebeneinander — der Kunde gewinnt erst in der
        // Auflösung, und die Fläche braucht die Vorgabe für ihre Ansage.
        assertThat(mitVorgabe.path("eigen").path("document").path("hidden").get(0).asText())
                .isEqualTo("strompreis");

        // -- 5. Die kunden-weite Vorgabe (E1) ---------------------------------
        exchange("/api/v1/tenant/cockpit-layout?layer=vorgabe", HttpMethod.PUT, admin, TENANT_A,
                Map.of("hidden", List.of("fahrplan")));
        JsonNode mitBeiden = customer(path(BERLIN_SITE), HttpMethod.GET, demo, null).getBody();
        assertThat(mitBeiden.path("tenantVorgabe").path("document").path("hidden").get(0).asText())
                .isEqualTo("fahrplan");
        // Sie gilt für JEDE Anlage des Kunden — auch für eine, die selbst keine
        // Anlagen-Vorgabe hat.
        assertThat(customer("/api/v1/tenant/cockpit-layout", HttpMethod.GET, demo, null).getBody()
                .path("tenantVorgabe").path("document").path("hidden").get(0).asText())
                .isEqualTo("fahrplan");

        // -- 6. Reset = DELETE genau EINER Schicht ----------------------------
        JsonNode nachReset = customer(path(BERLIN_SITE), HttpMethod.DELETE, demo, null).getBody();
        assertThat(nachReset.path("eigen").isNull()).as("der eigene Wille ist weg").isTrue();
        assertThat(nachReset.path("siteVorgabe").isNull())
                .as("die Vorgabe bleibt — genau darauf fällt der Reset").isFalse();
        // Ein zweiter Reset ist ein harmloses No-op, kein 404.
        assertThat(customer(path(BERLIN_SITE), HttpMethod.DELETE, demo, null).getStatusCode())
                .isEqualTo(HttpStatus.OK);
    }

    @Test
    void everyRefusalNamesItsReasonInGermanAndWritesNothing() {
        String demo = token("demo", "demo");
        String pfad = path(BERLIN_SITE);

        // (a) ein Baustein, den VoltPilot nicht kennt
        ResponseEntity<JsonNode> unbekannt = customer(pfad, HttpMethod.PUT, demo,
                Map.of("order", List.of("gibtsnicht")));
        assertThat(unbekannt.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(unbekannt.getBody().path("message").asText()).contains("kein Baustein");

        // (b) ein Pflicht-Baustein lässt sich nicht ausblenden (E2)
        ResponseEntity<JsonNode> pflicht = customer(pfad, HttpMethod.PUT, demo,
                Map.of("hidden", List.of("zustand")));
        assertThat(pflicht.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(pflicht.getBody().path("message").asText()).contains("Grundausstattung");

        // (c) ein erfundener Lead
        ResponseEntity<JsonNode> lead = customer(pfad, HttpMethod.PUT, demo,
                Map.of("lead", "gibtsnicht"));
        assertThat(lead.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(lead.getBody().path("message").asText()).contains("hervorheben");

        // (d) eine unbekannte Schicht — nie ein stiller Rückfall auf „eigen"
        ResponseEntity<JsonNode> schicht = customer(pfad + "?layer=irgendwas", HttpMethod.PUT,
                demo, Map.of());
        assertThat(schicht.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(schicht.getBody().path("message").asText()).contains("Schicht");

        // Nach VIER Ablehnungen steht immer noch keine Zeile.
        assertThat(customer(pfad, HttpMethod.GET, demo, null).getBody().path("eigen").isNull())
                .as("eine Ablehnung schreibt nichts").isTrue();

        // (e) ein Baustein, den DIESE Anlage gerade nicht hat, ist AUSDRÜCKLICH
        // keine Ablehnung: die Präferenz muss ein Ab- und Wiedereinschalten
        // einer Anwendung überleben (§3.2 E) — der Server kann und darf nicht
        // wissen, was die Fläche gerade rendert.
        assertThat(customer(pfad, HttpMethod.PUT, demo,
                Map.of("hidden", List.of("kacheln", "geld"))).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        customer(pfad, HttpMethod.DELETE, demo, null);
    }

    @Test
    void aForeignSiteIs404NotForbiddenAndAnAnonymousCallerGetsNothing() {
        String demo = token("demo", "demo");
        // Hamburg gehört Mandant B — RLS macht sie unsichtbar, also 404.
        assertThat(customer(path(HAMBURG_SITE), HttpMethod.GET, demo, null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(customer(path(HAMBURG_SITE), HttpMethod.PUT, demo, Map.of()).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(customer(path(HAMBURG_SITE), HttpMethod.DELETE, demo, null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        HttpEntity<Void> anon = new HttpEntity<>(new HttpHeaders());
        assertThat(rest.exchange("http://localhost:" + port + path(BERLIN_SITE), HttpMethod.GET,
                anon, new ParameterizedTypeReference<JsonNode>() {}).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    // -- Helfer --------------------------------------------------------------

    private static String path(String siteId) {
        return "/api/v1/sites/" + siteId + "/cockpit-layout";
    }

    private static List<String> bausteinIds(JsonNode dto) {
        List<String> out = new ArrayList<>();
        for (JsonNode b : dto.path("bausteine")) {
            out.add(b.path("id").asText());
        }
        return out;
    }

    private static JsonNode baustein(JsonNode dto, String id) {
        for (JsonNode b : dto.path("bausteine")) {
            if (id.equals(b.path("id").asText())) {
                return b;
            }
        }
        throw new AssertionError("Baustein fehlt: " + id);
    }

    private static List<String> strings(JsonNode array) {
        List<String> out = new ArrayList<>();
        for (JsonNode n : array) {
            out.add(n.asText());
        }
        return out;
    }

    private ResponseEntity<JsonNode> customer(String path, HttpMethod method, String token,
            Object body) {
        return exchange(path, method, token, null, body);
    }

    private ResponseEntity<JsonNode> exchange(String path, HttpMethod method, String token,
            String tenantHeader, Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        if (tenantHeader != null) {
            headers.add("X-Tenant-Id", tenantHeader);
        }
        HttpEntity<?> entity = body != null ? new HttpEntity<>(body, headers)
                : new HttpEntity<>(headers);
        return rest.exchange("http://localhost:" + port + path, method, entity,
                new ParameterizedTypeReference<JsonNode>() {
                });
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
