package com.voltpilot.api.zugriff;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.web.client.ResourceAccessException;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Befund B2 der Produktionsprüfung (09.10.2026): war Keycloak beim Start der api nicht erreichbar, endete der
 * Rechte-Startlauf, und jeder Bestandskunde sah bis zum nächsten Neustart nur „Kein Standort zugewiesen" - obwohl
 * jede Route ihn nach der Bestandsregel E12 bediente. Die ganze Kette mit echter Datenbank und echter Route:
 *
 * <ol>
 *   <li>Keycloak weg: der Lauf scheitert, setzt keinen Stichtag und vergibt nichts - {@code /me} zeigt dem
 *       Bestandskonto trotzdem seine Standorte (dasselbe Bestands-Recht, das jede Route prüft).</li>
 *   <li>Keycloak zurück: der Läufer versucht es nach seiner Pause wieder, OHNE Neustart der api - danach trägt das
 *       Konto eine echte Kundenadministrator-Zuweisung, der Kundenbereich seinen Stichtag, und {@code /me} zeigt
 *       dieselben Standorte.</li>
 * </ol>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class ZugriffBestandWiederholungApiTest {

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
    @Autowired ZugriffBestandLaeufer laeufer;
    @MockBean KeycloakAdminClient keycloak;

    @Test
    void keycloakBeimStartWegNachDerWiederkehrSiehtDasBestandskontoSeineStandorteOhneNeustart() throws Exception {
        JdbcTemplate root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
        UUID tenant = root.queryForObject("INSERT INTO tenant (name) VALUES ('Bestand B2 GmbH') RETURNING id",
                UUID.class);
        UUID unternehmen = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) "
                + "VALUES (?, 'Bestand B2 GmbH', 'Europe/Berlin') RETURNING id", UUID.class, tenant);
        for (String kz : List.of("ST-1", "ST-2")) {
            root.update("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                    + "VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv')", tenant, unternehmen, "Werk " + kz, kz);
        }
        String sub = "kc-bestand-b2";
        KeycloakUser konto = new KeycloakUser(sub, "anna", "anna@example.de", "Anna", "Alt", true,
                tenant.toString());

        AtomicBoolean erreichbar = new AtomicBoolean(false);
        when(keycloak.listUsersForTenant(any())).thenAnswer(inv -> {
            if (!erreichbar.get()) {
                throw new ResourceAccessException("I/O error on GET request: Connection refused");
            }
            return tenant.equals(inv.getArgument(0)) ? List.of(konto) : List.of();
        });
        BlockingQueue<Duration> pausen = new LinkedBlockingQueue<>();
        Semaphore weiter = new Semaphore(0);
        laeufer.pauseStellen(dauer -> {
            pausen.add(dauer);
            weiter.acquire();
        });

        Thread lauf = laeufer.starten();
        try {
            assertThat(pausen.poll(30, TimeUnit.SECONDS)).as("der Läufer wartet auf einen weiteren Versuch")
                    .isEqualTo(ZugriffBestandLaeufer.ERSTE_PAUSE);
            assertThat(stichtage(root, tenant)).as("ohne Keycloak kein Stichtag").isZero();
            assertThat(zuweisungen(root, tenant, sub)).as("ohne Keycloak keine Zuweisung").isEmpty();
            JsonNode waehrend = me(tenant, sub);
            assertThat(waehrend.path("unternehmensweit").asBoolean()).isTrue();
            assertThat(kennzeichen(waehrend)).containsExactly("ST-1", "ST-2");
            assertThat(waehrend.path("rollen").toString()).isEqualTo("[\"kundenadministrator\"]");

            erreichbar.set(true);
            weiter.release();
            lauf.join(Duration.ofSeconds(30));
            assertThat(lauf.isAlive()).as("nach dem gelungenen Versuch ist Schluss").isFalse();
        } finally {
            weiter.release(10);
            lauf.join(Duration.ofSeconds(5));
        }
        assertThat(pausen).as("ein weiterer Versuch genügte").isEmpty();
        assertThat(stichtage(root, tenant)).isOne();
        assertThat(zuweisungen(root, tenant, sub)).containsExactly("kundenadministrator|unternehmensweit");
        JsonNode danach = me(tenant, sub);
        assertThat(danach.path("unternehmensweit").asBoolean()).isTrue();
        assertThat(kennzeichen(danach)).containsExactly("ST-1", "ST-2");
        assertThat(danach.path("rollen").toString()).isEqualTo("[\"kundenadministrator\"]");
    }

    private static int stichtage(JdbcTemplate root, UUID tenant) {
        return root.queryForObject("SELECT count(*) FROM zugriff_bestand WHERE tenant_id = ?", Integer.class,
                tenant);
    }

    private static List<String> zuweisungen(JdbcTemplate root, UUID tenant, String sub) {
        return root.queryForList("SELECT rolle || '|' || CASE WHEN standort_id IS NULL THEN 'unternehmensweit' "
                + "ELSE standort_id::text END FROM zugriff WHERE tenant_id = ? AND benutzer_sub = ?", String.class,
                tenant, sub);
    }

    private JsonNode me(UUID tenant, String sub) throws Exception {
        Jwt jwt = new Jwt("token", Instant.now(), Instant.now().plusSeconds(300), Map.of("alg", "none"),
                Map.of("sub", sub, "name", "Anna Alt", "tenant_id", tenant.toString(),
                        "realm_access", Map.of("roles", List.of("operator"))));
        MvcResult res = mvc.perform(get("/api/v1/me")
                .with(authentication(new KeycloakRealmRoleConverter().convert(jwt)))).andReturn();
        assertThat(res.getResponse().getStatus()).isEqualTo(200);
        return JSON.readTree(res.getResponse().getContentAsString(StandardCharsets.UTF_8));
    }

    private static List<String> kennzeichen(JsonNode me) {
        List<String> aus = new ArrayList<>();
        me.path("standorte").forEach(s -> aus.add(s.path("kennzeichen").asText()));
        return aus.stream().sorted().toList();
    }
}
