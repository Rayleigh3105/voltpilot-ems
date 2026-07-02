package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.mastr.MastrHttp;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
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
 * "Anlage verknüpfen" end to end against a REAL TimescaleDB + Keycloak: the
 * lookup returns the mapped preview (catalog values decoded to degrees), apply
 * persists the confirmed values onto the site's asset rows incl. provenance,
 * and both endpoints are RLS-scoped (a foreign site is a 404 for the other
 * tenant). The registry itself is the only fake: a {@link MastrHttp} bean
 * serving the RECORDED public-backend fixtures, so the REAL
 * {@code MastrJsonClient} (the keyless default source, exactly what runs
 * without captain credentials) executes its full parse/guard path - and no
 * live registry call ever happens in CI.
 *
 * <p>Auto-skips where Docker is unavailable.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class MastrApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";

    private static final String PV_UNIT = "SEE966831669444";
    private static final String STORAGE_UNIT = "SEE972142227037";

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

    /** Serve the recorded fixtures instead of the live registry. */
    @TestConfiguration
    static class FixtureRegistry {
        @Bean
        MastrHttp mastrHttp() {
            return new MastrHttp() {
                @Override
                public Response post(URI uri, Map<String, String> headers, String body) {
                    throw new UnsupportedOperationException("SOAP source not configured in test");
                }

                @Override
                public Response get(URI uri) {
                    String q = uri.toString();
                    if (q.contains(PV_UNIT)) {
                        return new Response(200, fixture("json_pv_" + PV_UNIT + ".json"));
                    }
                    if (q.contains(STORAGE_UNIT)) {
                        return new Response(200, fixture("json_storage_" + STORAGE_UNIT + ".json"));
                    }
                    return new Response(200, "{\"Data\":[],\"Total\":0}");
                }
            };
        }

        private static String fixture(String name) {
            try (var in = MastrApiTest.class.getResourceAsStream("/mastr/" + name)) {
                return new String(in.readAllBytes(), StandardCharsets.UTF_8);
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
        }
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Test
    void lookupReturnsTheMappedPvPreview() {
        ResponseEntity<Map<String, Object>> res = post(
                "/api/v1/sites/" + BERLIN_SITE + "/mastr-lookup",
                Map.of("einheitNummer", "see9668 3166 9444"), // normalization incl.
                token("demo", "demo"));

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> p = res.getBody();
        assertThat(p).containsEntry("kind", "pv")
                .containsEntry("mastrNummer", PV_UNIT)
                .containsEntry("moduleCount", 13)
                .containsEntry("azimuthLabel", "Süd")
                .containsEntry("tiltLabel", "21 - 40 Grad")
                .containsEntry("commissionedOn", "2026-07-01")
                .containsEntry("plz", "89150")
                .containsEntry("ort", "Laichingen");
        assertThat(((Number) p.get("powerKw")).doubleValue()).isEqualTo(6.05);
        assertThat(((Number) p.get("azimuthDeg")).doubleValue()).isEqualTo(180.0);
        assertThat(((Number) p.get("tiltDeg")).doubleValue()).isEqualTo(30.0);
    }

    @Test
    void lookupOfAnUnknownNumberIs404WithAGermanMessage() {
        ResponseEntity<Map<String, Object>> res = post(
                "/api/v1/sites/" + BERLIN_SITE + "/mastr-lookup",
                Map.of("einheitNummer", "SEE000000000000"), token("demo", "demo"));
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat((String) res.getBody().get("message")).contains("keine Einheit");
    }

    @Test
    void lookupOfAWrongPrefixIs400WithTheSpecificHint() {
        ResponseEntity<Map<String, Object>> res = post(
                "/api/v1/sites/" + BERLIN_SITE + "/mastr-lookup",
                Map.of("einheitNummer", "SSE933136239009"), token("demo", "demo"));
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat((String) res.getBody().get("message")).contains("Speicher-EINHEIT");
    }

    @Test
    void applyPersistsAssetsWithProvenanceAndFeedsTheOptimizerColumns() {
        String tokenA = token("demo", "demo");

        // Storage preview first - its charge power comes from the symmetric
        // fallback (keyless source has none).
        ResponseEntity<Map<String, Object>> storage = post(
                "/api/v1/sites/" + BERLIN_SITE + "/mastr-lookup",
                Map.of("einheitNummer", STORAGE_UNIT), tokenA);
        assertThat(storage.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(storage.getBody()).containsEntry("kind", "storage");
        assertThat(((Number) storage.getBody().get("storageCapacityKwh")).doubleValue())
                .isEqualTo(12.8);
        assertThat((List<?>) storage.getBody().get("warnings")).isNotEmpty();

        // Apply the confirmed values for both units.
        ResponseEntity<List<Map<String, Object>>> applied = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/mastr-apply"), HttpMethod.POST,
                new HttpEntity<>(Map.of(
                        "pv", Map.of(
                                "mastrNummer", PV_UNIT,
                                "capacityKwp", 6.05,
                                "moduleCount", 13,
                                "azimuthDeg", 180,
                                "tiltDeg", 30,
                                "commissionedOn", "2026-07-01"),
                        "storage", Map.of(
                                "mastrNummer", STORAGE_UNIT,
                                "capacityKwh", 12.8,
                                "maxChargeKw", 8.76,
                                "maxDischargeKw", 8.76,
                                "commissionedOn", "2026-07-01")),
                        bearer(tokenA)),
                new ParameterizedTypeReference<>() {});
        assertThat(applied.getStatusCode()).isEqualTo(HttpStatus.OK);

        List<Map<String, Object>> assets = applied.getBody();
        Map<String, Object> battery = assets.stream()
                .filter(a -> "battery".equals(a.get("type"))).findFirst().orElseThrow();
        Map<String, Object> pv = assets.stream()
                .filter(a -> "pv".equals(a.get("type"))).findFirst().orElseThrow();

        // Battery values land in the EXISTING optimizer columns of the seeded
        // battery asset (update-in-place - the device link survives).
        assertThat(((Number) battery.get("capacityKwh")).doubleValue()).isEqualTo(12.8);
        assertThat(((Number) battery.get("maxChargeKw")).doubleValue()).isEqualTo(8.76);
        assertThat(battery).containsEntry("registry", "mastr")
                .containsEntry("registryUnitId", STORAGE_UNIT);
        assertThat(battery.get("registryFetchedAt")).isNotNull();

        // The PV asset is created with the forecast's PlantSpec inputs.
        assertThat(((Number) pv.get("pvCapacityKwp")).doubleValue()).isEqualTo(6.05);
        assertThat(((Number) pv.get("azimuthDeg")).doubleValue()).isEqualTo(180.0);
        assertThat(((Number) pv.get("tiltDeg")).doubleValue()).isEqualTo(30.0);
        assertThat(pv).containsEntry("registryUnitId", PV_UNIT)
                .containsEntry("moduleCount", 13);

        // GET /assets reads the same rows back (drawer display).
        ResponseEntity<List<Map<String, Object>>> read = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/assets"), HttpMethod.GET,
                new HttpEntity<>(bearer(tokenA)), new ParameterizedTypeReference<>() {});
        assertThat(read.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(read.getBody()).hasSameSizeAs(assets);
    }

    @Test
    void everyEndpointIsRlsScopedForeignSiteIs404() {
        String tokenB = token("demo2", "demo2");

        ResponseEntity<Map<String, Object>> lookup = post(
                "/api/v1/sites/" + BERLIN_SITE + "/mastr-lookup",
                Map.of("einheitNummer", PV_UNIT), tokenB);
        assertThat(lookup.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        ResponseEntity<Map<String, Object>> apply = post(
                "/api/v1/sites/" + BERLIN_SITE + "/mastr-apply",
                Map.of("pv", Map.of("mastrNummer", PV_UNIT, "capacityKwp", 99)), tokenB);
        assertThat(apply.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        ResponseEntity<String> assets = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/assets"), HttpMethod.GET,
                new HttpEntity<>(bearer(tokenB)), String.class);
        assertThat(assets.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    void applyWithoutAnyUnitIs400() {
        ResponseEntity<Map<String, Object>> res = post(
                "/api/v1/sites/" + BERLIN_SITE + "/mastr-apply", Map.of(), token("demo", "demo"));
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    // ---- helpers ---------------------------------------------------------------

    private ResponseEntity<Map<String, Object>> post(String path, Map<String, ?> body, String token) {
        return rest.exchange(url(path), HttpMethod.POST, new HttpEntity<>(body, bearer(token)),
                new ParameterizedTypeReference<>() {});
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
