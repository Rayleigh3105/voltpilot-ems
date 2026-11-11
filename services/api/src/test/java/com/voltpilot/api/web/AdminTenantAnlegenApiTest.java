package com.voltpilot.api.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * „Neuer Kunde" mit Anfrage-Kennung (Befund vp-kundenakte-fremde-personen, Punkt 5): die Live-Liste
 * zeigte denselben Kunden ZWEIMAL - {@code tenant.name} ist bewusst nicht eindeutig (zwei
 * Privatkunden dürfen gleich heißen), also schützt nicht eine UNIQUE-Grenze, sondern die
 * Anfrage-Kennung je Betreiber-Konto ({@code admin_anfrage_kennung}, dieselbe B3-Mechanik wie beim
 * Anlegen einer Anlage): ein Doppelklick oder das Wiederholen nach einem Netzfehler legt nie
 * zweimal an.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class AdminTenantAnlegenApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();

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
        registry.add("voltpilot.admin-datasource.url", POSTGRES::getJdbcUrl);
        registry.add("voltpilot.admin-datasource.username", () -> "voltpilot_admin");
        registry.add("voltpilot.admin-datasource.password", () -> "voltpilot_admin_test_pw");
        registry.add("spring.flyway.placeholders.adminDbUser", () -> "voltpilot_admin");
        registry.add("spring.flyway.placeholders.adminDbPassword", () -> "voltpilot_admin_test_pw");
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

    @Autowired MockMvc mvc;

    private JdbcTemplate root() {
        return new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @Test void dieselbeKennungLegtNieZweimalAnUndGibtDieselbeAntwort() throws Exception {
        String kennung = "portal-doppelklick-0001";
        MvcResult erste = anlegen("Wüstholz Karl-Friedrich", kennung, plattform("betreiber-1"));
        assertThat(erste.getResponse().getStatus()).isEqualTo(201);
        String id = JSON.readTree(erste.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8))
                .path("id").asText();

        MvcResult zweite = anlegen("Wüstholz Karl-Friedrich", kennung, plattform("betreiber-1"));
        assertThat(zweite.getResponse().getStatus()).isEqualTo(201);
        assertThat(zweite.getResponse().getHeader("Idempotent-Replayed")).isEqualTo("true");
        assertThat(JSON.readTree(zweite.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8))
                .path("id").asText()).isEqualTo(id);
        assertThat(anzahl("Wüstholz Karl-Friedrich")).isEqualTo(1);
    }

    @Test void dieselbeKennungMitAndererAnfrageIstEine422() throws Exception {
        String kennung = "portal-andere-anfrage-0001";
        assertThat(anlegen("Erster Name GmbH", kennung, plattform("betreiber-2")).getResponse().getStatus())
                .isEqualTo(201);
        MvcResult r = anlegen("Anderer Name GmbH", kennung, plattform("betreiber-2"));
        assertThat(r.getResponse().getStatus()).isEqualTo(422);
        assertThat(JSON.readTree(r.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8))
                .path("code").asText()).isEqualTo("anfrage_kennung_anders");
        assertThat(anzahl("Anderer Name GmbH")).isZero();
    }

    /** Die Kennung ist je BETREIBER-KONTO: ein anderes Konto mit derselben Kennung legt seinen eigenen Kunden an. */
    @Test void dieKennungGiltJeBetreiberKonto() throws Exception {
        String kennung = "portal-zwei-betreiber-0001";
        assertThat(anlegen("Zwei Betreiber GmbH", kennung, plattform("betreiber-3")).getResponse().getStatus())
                .isEqualTo(201);
        assertThat(anlegen("Zwei Betreiber GmbH", kennung, plattform("betreiber-4")).getResponse().getStatus())
                .isEqualTo(201);
        assertThat(anzahl("Zwei Betreiber GmbH")).isEqualTo(2);
    }

    @Test void eineKaputteKennungIstEine400() throws Exception {
        MvcResult r = anlegen("Kaputte Kennung GmbH", "kurz", plattform("betreiber-5"));
        assertThat(r.getResponse().getStatus()).isEqualTo(400);
        assertThat(JSON.readTree(r.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8))
                .path("code").asText()).isEqualTo("anfrage_kennung_ungueltig");
        assertThat(anzahl("Kaputte Kennung GmbH")).isZero();
    }

    /** Der Doppelklick selbst: zwei GLEICHZEITIGE Anfragen mit derselben Kennung ergeben EINEN Kunden. */
    @Test void gleichzeitigeAnfragenMitDerselbenKennungErgebenEinenKunden() throws Exception {
        String kennung = "portal-gleichzeitig-0001";
        CountDownLatch start = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var a = pool.submit(() -> { start.await();
                return anlegen("Gleichzeitig GmbH", kennung, plattform("betreiber-6")); });
            var b = pool.submit(() -> { start.await();
                return anlegen("Gleichzeitig GmbH", kennung, plattform("betreiber-6")); });
            start.countDown();
            MvcResult ra = a.get(30, TimeUnit.SECONDS);
            MvcResult rb = b.get(30, TimeUnit.SECONDS);
            assertThat(List.of(ra.getResponse().getStatus(), rb.getResponse().getStatus()))
                    .containsExactly(201, 201);
            assertThat(JSON.readTree(ra.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8)).path("id").asText())
                    .isEqualTo(JSON.readTree(rb.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8)).path("id").asText());
        }
        assertThat(anzahl("Gleichzeitig GmbH")).isEqualTo(1);
    }

    /** Ohne Kennung bleibt alles, wie es war - der Schutz ist der Kopf, den das Portal jetzt sendet. */
    @Test void ohneKennungLegtJedeAnfrageAn() throws Exception {
        assertThat(anlegen("Ohne Kennung GmbH", null, plattform("betreiber-7")).getResponse().getStatus())
                .isEqualTo(201);
        assertThat(anlegen("Ohne Kennung GmbH", null, plattform("betreiber-7")).getResponse().getStatus())
                .isEqualTo(201);
        assertThat(anzahl("Ohne Kennung GmbH")).isEqualTo(2);
    }

    private int anzahl(String name) {
        return root().queryForObject("SELECT count(*) FROM tenant WHERE name = ?", Integer.class, name);
    }

    private MvcResult anlegen(String name, String kennung, Authentication auth) {
        try {
            var anfrage = post("/api/v1/admin/tenants")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(JSON.writeValueAsString(Map.of("name", name, "segment", "B2C")));
            if (kennung != null) {
                anfrage.header(AnfrageKennungen.KOPF, kennung);
            }
            return mvc.perform(anfrage.with(authentication(auth))).andReturn();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static Authentication plattform(String sub) {
        Map<String, Object> claims = new HashMap<>();
        claims.put("sub", sub);
        claims.put("preferred_username", sub);
        claims.put("realm_access", Map.of("roles", List.of("platform-admin")));
        return new KeycloakRealmRoleConverter().convert(new Jwt("token", Instant.now(),
                Instant.now().plusSeconds(3600), Map.of("alg", "none"), claims));
    }
}
