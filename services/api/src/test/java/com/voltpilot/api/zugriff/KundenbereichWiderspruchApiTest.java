package com.voltpilot.api.zugriff;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der Widerspruch zweier Kundenbereiche in EINER Anfrage (Befund vp-kundenakte-fremde-personen):
 * die Kundenakte von Kunde B las bei offenem Mandanten-Umschalter („Wie der Kunde es sieht" auf
 * Kunde A) die Personen von Kunde A, weil {@link ZugriffKontextLader} den Kopf
 * {@code X-Kundenbereich} still vor dem ausdrücklichen {@code X-Tenant-Id} nahm.
 *
 * <p>Die Regel seitdem: nennen {@code X-Tenant-Id} und {@code X-Kundenbereich} ZWEI verschiedene
 * Kundenbereiche, nimmt die API keinen von beiden - 400 {@code kundenbereich_widerspruch} statt
 * der Daten des falschen Kunden. Gleiche Werte, nur einer von beiden, Partner (für die der
 * TenantFilter {@code X-Tenant-Id} ohnehin ignoriert) und Kundenkonten bleiben unverändert.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class KundenbereichWiderspruchApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TENANT = "X-Tenant-Id";
    private static final String KUNDENBEREICH = ZugriffKontextLader.KUNDENBEREICH_HEADER;

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
    private JdbcTemplate root;
    private UUID kundeA;
    private UUID kundeB;

    @BeforeEach void seed() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        kundeA = kunde("ASP Automation GmbH", "person-a");
        kundeB = kunde("Wüstholz Karl-Friedrich", "person-b");
    }

    private UUID kunde(String name, String personSub) {
        UUID tenant = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
        root.update("INSERT INTO unternehmen (tenant_id, name) VALUES (?, ?)", tenant, name);
        String sub = personSub + "-" + tenant;
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) "
                + "VALUES (?, ?, 'benutzer', ?, 'aktiv')", tenant, sub, personSub);
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, 'kundenadministrator', NULL, '2024-01-01T00:00:00Z', 'Europe/Berlin')", tenant, sub);
        return tenant;
    }

    @Test void zweiVerschiedeneKundenbereicheSindEine400MitCodeUndSatz() throws Exception {
        MvcResult r = ruf(get("/api/v1/benutzer").header(TENANT, kundeB.toString())
                .header(KUNDENBEREICH, kundeA.toString()), plattform());
        assertThat(r.getResponse().getStatus()).isEqualTo(400);
        JsonNode body = JSON.readTree(r.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8));
        assertThat(body.path("code").asText()).isEqualTo(ZugriffFilter.WIDERSPRUCH_CODE);
        assertThat(body.path("message").asText()).contains("zwei verschiedene Kundenbereiche");
    }

    @Test void auchDieSelbstauskunftNimmtKeinenDerBeiden() throws Exception {
        MvcResult r = ruf(get("/api/v1/me").header(TENANT, kundeB.toString())
                .header(KUNDENBEREICH, kundeA.toString()), plattform());
        assertThat(r.getResponse().getStatus()).isEqualTo(400);
        assertThat(JSON.readTree(r.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8))
                .path("code").asText()).isEqualTo(ZugriffFilter.WIDERSPRUCH_CODE);
    }

    @Test void gleicheWerteUndJeEinzelnerKopfLesenDenGenanntenKunden() throws Exception {
        assertThat(personen(get("/api/v1/benutzer").header(TENANT, kundeB.toString())
                .header(KUNDENBEREICH, kundeB.toString()))).containsExactly("person-b");
        assertThat(personen(get("/api/v1/benutzer").header(TENANT, kundeB.toString())))
                .containsExactly("person-b");
        assertThat(personen(get("/api/v1/benutzer").header(KUNDENBEREICH, kundeA.toString())))
                .containsExactly("person-a");
    }

    /** Für einen Partner ignoriert der TenantFilter {@code X-Tenant-Id}: kein Widerspruch, dieselbe 404 wie bisher. */
    @Test void partnerOhneUnterstuetzungBleibtBeiDerStummen404() throws Exception {
        MvcResult r = ruf(get("/api/v1/benutzer").header(TENANT, kundeB.toString())
                .header(KUNDENBEREICH, kundeA.toString()), partner());
        assertThat(r.getResponse().getStatus()).isEqualTo(404);
    }

    /** Ein Kundenkonto bleibt bei seinem Token-Kundenbereich - ein fremder Kopf ändert nichts (wie bisher). */
    @Test void kundenkontoBleibtBeimEigenenKundenbereich() throws Exception {
        String sub = "person-b-" + kundeB;
        MvcResult r = ruf(get("/api/v1/benutzer").header(KUNDENBEREICH, kundeA.toString()),
                kunde(sub, kundeB));
        assertThat(r.getResponse().getStatus()).isEqualTo(200);
        assertThat(namen(r)).containsExactly("person-b");
    }

    private List<String> personen(MockHttpServletRequestBuilder anfrage) throws Exception {
        MvcResult r = ruf(anfrage, plattform());
        assertThat(r.getResponse().getStatus()).isEqualTo(200);
        return namen(r);
    }

    private static List<String> namen(MvcResult r) throws Exception {
        List<String> namen = new ArrayList<>();
        for (JsonNode e : JSON.readTree(r.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8))) {
            namen.add(e.path("anzeigename").asText());
        }
        return namen;
    }

    private MvcResult ruf(MockHttpServletRequestBuilder anfrage, Authentication auth) throws Exception {
        return mvc.perform(anfrage.with(authentication(auth))).andReturn();
    }

    private static Authentication plattform() {
        return auth("plattform-admin-probe", null, List.of("platform-admin"));
    }

    private static Authentication partner() {
        return auth("partner-probe", null, List.of("partner"));
    }

    private static Authentication kunde(String sub, UUID tenant) {
        return auth(sub, tenant, List.of());
    }

    private static Authentication auth(String sub, UUID tenant, List<String> rollen) {
        Map<String, Object> claims = new HashMap<>();
        claims.put("sub", sub);
        claims.put("preferred_username", sub);
        claims.put("realm_access", Map.of("roles", rollen));
        if (tenant != null) claims.put("tenant_id", tenant.toString());
        return new KeycloakRealmRoleConverter().convert(new Jwt("token", Instant.now(),
                Instant.now().plusSeconds(3600), Map.of("alg", "none"), claims));
    }
}
