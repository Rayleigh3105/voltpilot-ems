package com.voltpilot.api.tenant;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Duration;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureTestRestTemplate;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.resttestclient.TestRestTemplate;
import org.springframework.context.annotation.Bean;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Wartung Datenbank-Zeitgrenze (vp-db-zeitgrenze): belegt am echten HTTP-Pfad (echter eingebetteter
 * Tomcat, nicht MockMvc - nur so greift Boots eigene Fehlerseite), dass eine absichtlich zu lange
 * Abfrage ({@code pg_sleep}) nach der konfigurierten Statement-Zeitgrenze mit einer sauberen
 * Fehlerantwort abbricht - und dieselbe Abfrage OHNE {@link AnfrageZeitgrenze} (wie ein
 * Hintergrundjob sie stellt) ungebremst durchläuft. Die Zeitgrenze ist auf 300 ms heruntergesetzt
 * (statt der echten 30 s aus {@code application.yml}), damit der Test nicht selbst 30 s wartet; der
 * Mechanismus ist identisch - nur der konfigurierte Wert ändert sich ({@code DataSourceConfig},
 * {@code spring.datasource.hikari.connection-init-sql}).
 *
 * <p>Authentifizierung ohne echtes Keycloak: ein Test-{@link JwtDecoder} akzeptiert das feste
 * Bearer-Wort {@code TEST} und liefert direkt ein {@link Jwt} mit {@code tenant_id} - derselbe Haken,
 * den der echte {@code NimbusJwtDecoder} sonst gegen die JWKS prüft, nur ohne Netzwerk/Realm.
 */
@Testcontainers(disabledWithoutDocker = true)
@AutoConfigureTestRestTemplate
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class AnfragePfadZeitgrenzeApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String TENANT = "00000000-0000-0000-0000-000000000001";

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
        // Werte unbenutzt (der Test-JwtDecoder unten ersetzt den echten), aber die
        // Resource-Server-Autokonfiguration will eine gesetzte Eigenschaft sehen.
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot");
        // 300 ms statt der echten 30 s (application.yml) - derselbe Mechanismus, nur schnell zu testen.
        registry.add("spring.datasource.hikari.connection-init-sql", () -> "SET statement_timeout = 300");
        registry.add("spring.datasource.hikari.data-source-properties.socketTimeout", () -> "5");
    }

    @Autowired
    TestRestTemplate http;

    @Autowired
    @Qualifier("jdbcTemplate")
    JdbcTemplate anfragePfad;

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Test
    void anfragePfadBrichtNachDerZeitgrenzeMitSaubererFehlerantwortAb() throws Exception {
        Instant start = Instant.now();
        HttpHeaders headers = new HttpHeaders();
        headers.add("Authorization", "Bearer TEST");
        ResponseEntity<String> r = http.exchange("/test/schlaf?sekunden=2", org.springframework.http.HttpMethod.GET,
                new HttpEntity<>(headers), String.class);
        Duration dauer = Duration.between(start, Instant.now());

        // Abgebrochen lange vor den vollen 2 s, die pg_sleep angefordert hat.
        assertThat(dauer).isLessThan(Duration.ofMillis(1500));
        assertThat(r.getStatusCode().value()).isGreaterThanOrEqualTo(500);

        String body = r.getBody();
        JsonNode json = MAPPER.readTree(body);
        assertThat(json.has("status")).isTrue();
        // Eine saubere Fehlerantwort: keine rohe PSQLException/Stacktrace im Textkörper.
        assertThat(body).doesNotContain("PSQLException", "canceling statement", "at com.voltpilot",
                "org.postgresql");
    }

    @Test
    void derselbeSchlafOhneAnfrageZeitgrenzeLaeuftUngebremstDurch() {
        Instant start = Instant.now();
        anfragePfad.execute("SELECT pg_sleep(1)");
        Duration dauer = Duration.between(start, Instant.now());

        // Kein Abbruch nach 300 ms - die volle Sekunde ist tatsächlich verstrichen.
        assertThat(dauer).isGreaterThanOrEqualTo(Duration.ofMillis(950));
    }

    @TestConfiguration
    static class SchlafTestConfig {
        @Bean
        SchlafController schlafController(@Qualifier("jdbcTemplate") JdbcTemplate jdbc) {
            return new SchlafController(jdbc);
        }

        /** Ersetzt den echten {@code NimbusJwtDecoder} - kein Keycloak-Container nötig, um die
         * Fehlerantwort-Form auf einem echten, authentifizierten HTTP-Pfad zu belegen. */
        @Bean
        JwtDecoder jwtDecoder() {
            return token -> {
                if (!"TEST".equals(token)) {
                    throw new org.springframework.security.oauth2.jwt.BadJwtException("unbekanntes Test-Token");
                }
                Instant jetzt = Instant.now();
                return Jwt.withTokenValue(token)
                        .header("alg", "none")
                        .claim("sub", "test-sub")
                        .claim("tenant_id", TENANT)
                        .issuedAt(jetzt)
                        .expiresAt(jetzt.plusSeconds(3600))
                        .build();
            };
        }
    }

    /** Test-only: eine absichtlich lange Abfrage auf einem echten HTTP-Pfad, wie Abnahme-Schritt 3 der
     * Aufgabe sie fordert. Lebt nur unter {@code src/test/java}, nie im ausgelieferten Jar. */
    @RestController
    static class SchlafController {
        private final JdbcTemplate jdbc;

        SchlafController(JdbcTemplate jdbc) {
            this.jdbc = jdbc;
        }

        @GetMapping("/test/schlaf")
        String schlafen(@RequestParam int sekunden) {
            jdbc.execute("SELECT pg_sleep(" + sekunden + ")");
            return "wach";
        }
    }
}
