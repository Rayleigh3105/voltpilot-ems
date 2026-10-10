package com.voltpilot.api.zugriff;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakAdminException;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
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

/** Plattform-Sperren/-Löschen: echte RLS, derselbe alte JWT und beide Protokolle; Keycloak als Außengrenze. */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class AdminBenutzerEntzugApiTest {
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String ADMIN = "plattform-pruefpunkt";
    enum Weg { SPERREN, ENTFERNEN }
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
    @MockBean KeycloakAdminClient keycloak;
    private JdbcTemplate root;
    private UUID tenant;
    private UUID unternehmen;
    private UUID standort;
    private String sub;
    private String letzter;

    @BeforeEach void seed() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        tenant = root.queryForObject("INSERT INTO tenant (name) VALUES ('Kunststoffwerk Ahrenberg') RETURNING id", UUID.class);
        unternehmen = root.queryForObject("INSERT INTO unternehmen (tenant_id, name) VALUES (?, 'Ahrenberg') RETURNING id",
                UUID.class, tenant);
        standort = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, tenant, unternehmen);
        sub = "betroffener-" + tenant;
        letzter = "kundenadmin-" + tenant;
        spiegel(sub);
        spiegel(letzter);
        zuweisung(letzter, "kundenadministrator", null);
        zuweisung(sub, "leser", standort);
        when(keycloak.getUser(anyString())).thenAnswer(call -> konto(call.getArgument(0), tenant, true));
        when(keycloak.setEnabled(anyString(), eq(false))).thenAnswer(call -> konto(call.getArgument(0), tenant, false));
        when(keycloak.setEnabled(anyString(), eq(true))).thenAnswer(call -> konto(call.getArgument(0), tenant, true));
    }

    @ParameterizedTest @EnumSource(Weg.class)
    void naechsteAnfrageMitAltemTokenIstBeendetUndBeideProtokolleTragenPlattform(Weg weg) throws Exception {
        Authentication alt = auth(sub, tenant, false);
        assertThat(ruf(get("/api/v1/sites"), alt).getResponse().getStatus()).isEqualTo(200);
        assertThat(ruf(aendern(weg, tenant, sub).header("X-Tenant-Id", UUID.randomUUID().toString()), plattform())
                .getResponse().getStatus()).isEqualTo(weg == Weg.SPERREN ? 200 : 204);
        MvcResult danach = ruf(get("/api/v1/sites"), alt);
        assertThat(danach.getResponse().getStatus()).isEqualTo(404);
        assertThat(JSON.readTree(danach.getResponse().getContentAsString()).path("code").asText()).isEqualTo("zugriff_beendet");
        MvcResult me = ruf(get("/api/v1/me"), alt);
        assertThat(me.getResponse().getStatus()).isEqualTo(200);
        assertThat(JSON.readTree(me.getResponse().getContentAsString()).path("zustand").asText())
                .isEqualTo(weg == Weg.SPERREN ? "gesperrt" : "entfernt");
        assertThat(root.queryForObject("SELECT zustand FROM benutzer WHERE tenant_id = ? AND sub = ?",
                String.class, tenant, sub)).isEqualTo(weg == Weg.SPERREN ? "gesperrt" : "entfernt");
        assertThat(root.queryForObject("SELECT count(*) FROM zugriff WHERE tenant_id = ? AND benutzer_sub = ? "
                + "AND beendet_am IS NULL", Integer.class, tenant, sub)).isEqualTo(weg == Weg.SPERREN ? 1 : 0);
        assertThat(root.queryForObject("SELECT count(*) FROM zugriff_protokoll WHERE tenant_id = ? AND betroffener_sub = ? "
                + "AND actor_sub = ? AND actor_art = 'voltpilot' AND actor_rolle = 'voltpilot_betrieb'",
                Integer.class, tenant, sub, ADMIN)).isPositive();
        assertThat(root.queryForObject("SELECT count(*) FROM ort_aenderung WHERE tenant_id = ? AND objekt_id = ? "
                + "AND art = 'zugriff_entzogen' AND actor_sub = ? AND actor_art = 'voltpilot'",
                Integer.class, tenant, standort, ADMIN)).isEqualTo(1);
        if (weg == Weg.SPERREN) verify(keycloak).setEnabled(sub, false);
        else verify(keycloak).deleteUser(sub);
    }

    @ParameterizedTest @EnumSource(Weg.class)
    void letzterKundenadministratorBleibtMit409UndGrundUnveraendert(Weg weg) throws Exception {
        MvcResult r = ruf(aendern(weg, tenant, letzter), plattform());
        assertThat(r.getResponse().getStatus()).isEqualTo(409);
        assertThat(JSON.readTree(r.getResponse().getContentAsString()).path("code").asText())
                .isEqualTo("letzter_kundenadministrator");
        assertThat(JSON.readTree(r.getResponse().getContentAsString()).path("message").asText())
                .contains("mindestens einen Kundenadministrator", "weitere Person");
        assertUnveraendert(letzter);
        verify(keycloak, never()).setEnabled(anyString(), eq(false));
        verify(keycloak, never()).deleteUser(anyString());
    }

    @ParameterizedTest @EnumSource(Weg.class)
    void zweiterKundenadministratorErlaubtEntzugUndProtokollAmUnternehmen(Weg weg) throws Exception {
        zuweisung(sub, "kundenadministrator", null);
        assertThat(ruf(aendern(weg, tenant, letzter), plattform()).getResponse().getStatus())
                .isEqualTo(weg == Weg.SPERREN ? 200 : 204);
        assertThat(root.queryForObject("SELECT count(*) FROM ort_aenderung WHERE tenant_id = ? AND objekt_id = ? "
                + "AND art = 'zugriff_entzogen'", Integer.class, tenant, unternehmen)).isEqualTo(1);
    }

    @ParameterizedTest @EnumSource(Weg.class)
    void falscherKundenbereichUndKundenrolleKoennenNichtEntziehen(Weg weg) throws Exception {
        UUID falsch = root.queryForObject("INSERT INTO tenant (name) VALUES ('Anderer Kunde') RETURNING id", UUID.class);
        assertThat(ruf(aendern(weg, falsch, sub), plattform()).getResponse().getStatus()).isEqualTo(404);
        assertThat(ruf(aendern(weg, tenant, sub), auth(letzter, tenant, false)).getResponse().getStatus()).isEqualTo(403);
        assertUnveraendert(sub);
        verify(keycloak, never()).setEnabled(anyString(), eq(false));
        verify(keycloak, never()).deleteUser(anyString());
    }

    @ParameterizedTest @EnumSource(Weg.class)
    void fehlerBeiKeycloakHinterlaesstKeinenHalbenEntzug(Weg weg) throws Exception {
        KeycloakAdminException fehler = new KeycloakAdminException(503, "Keycloak nicht erreichbar");
        if (weg == Weg.SPERREN) when(keycloak.setEnabled(sub, false)).thenThrow(fehler);
        else doThrow(fehler).when(keycloak).deleteUser(sub);
        assertThat(ruf(aendern(weg, tenant, sub), plattform()).getResponse().getStatus()).isEqualTo(503);
        assertUnveraendert(sub);
    }

    @ParameterizedTest @EnumSource(Weg.class)
    void ungespiegeltesBestandskontoKannDasAlteTokenNichtWeiterVerwenden(Weg weg) throws Exception {
        String bestand = "alt-" + tenant;
        Authentication alt = auth(bestand, tenant, false);
        assertThat(ruf(get("/api/v1/sites"), alt).getResponse().getStatus()).isEqualTo(200);
        assertThat(ruf(aendern(weg, tenant, bestand), plattform()).getResponse().getStatus())
                .isEqualTo(weg == Weg.SPERREN ? 200 : 204);
        MvcResult danach = ruf(get("/api/v1/sites"), alt);
        assertThat(danach.getResponse().getStatus()).isEqualTo(404);
        assertThat(JSON.readTree(danach.getResponse().getContentAsString()).path("code").asText()).isEqualTo("zugriff_beendet");
        assertThat(root.queryForObject("SELECT count(*) FROM zugriff_protokoll WHERE tenant_id = ? AND betroffener_sub = ?",
                Integer.class, tenant, bestand)).isEqualTo(1);
        assertThat(root.queryForObject("SELECT count(*) FROM ort_aenderung WHERE tenant_id = ? AND objekt_id = ? "
                + "AND art = 'zugriff_entzogen'", Integer.class, tenant, unternehmen)).isEqualTo(1);
    }

    @ParameterizedTest @EnumSource(Weg.class)
    void gesperrterAdministratorZaehltNichtAlsErsatz(Weg weg) throws Exception {
        zuweisung(sub, "kundenadministrator", null);
        root.update("UPDATE benutzer SET zustand = 'gesperrt' WHERE tenant_id = ? AND sub = ?", tenant, sub);
        MvcResult r = ruf(aendern(weg, tenant, letzter), plattform());
        assertThat(r.getResponse().getStatus()).isEqualTo(409);
        assertThat(JSON.readTree(r.getResponse().getContentAsString()).path("code").asText())
                .isEqualTo("letzter_kundenadministrator");
        assertUnveraendert(letzter);
    }

    @ParameterizedTest @EnumSource(Weg.class)
    void paralleleEntzuegeLassenEinenKundenadministratorUebrig(Weg weg) throws Exception {
        zuweisung(sub, "kundenadministrator", null);
        CountDownLatch start = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var a = pool.submit(() -> { start.await(); return ruf(aendern(weg, tenant, sub), plattform()).getResponse().getStatus(); });
            var b = pool.submit(() -> { start.await(); return ruf(aendern(weg, tenant, letzter), plattform()).getResponse().getStatus(); });
            start.countDown();
            assertThat(List.of(a.get(20, TimeUnit.SECONDS), b.get(20, TimeUnit.SECONDS)))
                    .containsExactlyInAnyOrder(409, weg == Weg.SPERREN ? 200 : 204);
        }
    }

    @ParameterizedTest @EnumSource(Weg.class)
    void plattformUndKundenwegTeilenAuchBeiParallelenEntzuegenDenPruefpunkt(Weg weg) throws Exception {
        zuweisung(sub, "kundenadministrator", null);
        CountDownLatch start = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var a = pool.submit(() -> { start.await(); return ruf(aendern(weg, tenant, sub), plattform()).getResponse().getStatus(); });
            var b = pool.submit(() -> {
                start.await();
                String pfad = "/api/v1/benutzer/" + letzter;
                return ruf(weg == Weg.SPERREN ? post(pfad + "/sperren") : delete(pfad),
                        auth("bestand-" + tenant, tenant, false)).getResponse().getStatus();
            });
            start.countDown();
            var ergebnisse = List.of(a.get(20, TimeUnit.SECONDS), b.get(20, TimeUnit.SECONDS));
            assertThat(ergebnisse).contains(409);
            assertThat(ergebnisse.stream().filter(status -> status == 200 || status == 204).count()).isEqualTo(1);
        }
    }

    @Test void entsperrenErhaeltZuweisungenUndBelebtKeinenFrueherenEntzug() throws Exception {
        zuweisung(sub, "bearbeiter", standort);
        root.update("UPDATE zugriff SET beendet_am = now(), beendet_von = ? WHERE tenant_id = ? AND benutzer_sub = ? "
                + "AND rolle = 'bearbeiter'", ADMIN, tenant, sub);
        List<String> vorher = root.queryForList("SELECT row_to_json(z)::text FROM zugriff z WHERE tenant_id = ? "
                + "AND benutzer_sub = ? ORDER BY id", String.class, tenant, sub);
        Authentication alt = auth(sub, tenant, false);
        assertThat(ruf(aendern(Weg.SPERREN, tenant, sub), plattform()).getResponse().getStatus()).isEqualTo(200);
        assertThat(ruf(get("/api/v1/sites"), alt).getResponse().getStatus()).isEqualTo(404);
        assertThat(ruf(post("/api/v1/admin/tenants/" + tenant + "/users/" + sub + "/enable"), plattform())
                .getResponse().getStatus()).isEqualTo(200);
        assertThat(ruf(get("/api/v1/sites"), alt).getResponse().getStatus()).isEqualTo(200);
        assertThat(root.queryForList("SELECT row_to_json(z)::text FROM zugriff z WHERE tenant_id = ? "
                + "AND benutzer_sub = ? ORDER BY id", String.class, tenant, sub)).isEqualTo(vorher);
    }

    private void assertUnveraendert(String betroffen) {
        assertThat(root.queryForObject("SELECT zustand FROM benutzer WHERE tenant_id = ? AND sub = ?",
                String.class, tenant, betroffen)).isEqualTo("aktiv");
        assertThat(root.queryForObject("SELECT count(*) FROM zugriff WHERE tenant_id = ? AND benutzer_sub = ? "
                + "AND beendet_am IS NOT NULL", Integer.class, tenant, betroffen)).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM zugriff_protokoll WHERE tenant_id = ? AND betroffener_sub = ?",
                Integer.class, tenant, betroffen)).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM ort_aenderung WHERE tenant_id = ?",
                Integer.class, tenant)).isZero();
    }

    private void spiegel(String wer) {
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', ?, 'aktiv')",
                tenant, wer, wer);
    }
    private void zuweisung(String wer, String rolle, UUID ort) {
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, ?, ?, '2024-01-01T00:00:00Z', 'Europe/Berlin')", tenant, wer, rolle, ort);
    }
    private static KeycloakUser konto(String wer, UUID kunde, boolean enabled) {
        return new KeycloakUser(wer, wer, wer + "@example.test", "Test", "Person", enabled, kunde.toString());
    }
    private static MockHttpServletRequestBuilder aendern(Weg weg, UUID kunde, String wer) {
        String pfad = "/api/v1/admin/tenants/" + kunde + "/users/" + wer;
        return weg == Weg.SPERREN ? post(pfad + "/disable") : delete(pfad);
    }
    private MvcResult ruf(MockHttpServletRequestBuilder anfrage, Authentication auth) throws Exception {
        return mvc.perform(anfrage.with(authentication(auth))).andReturn();
    }
    private static Authentication plattform() { return auth(ADMIN, null, true); }
    private static Authentication auth(String wer, UUID kunde, boolean plattform) {
        Map<String, Object> claims = new HashMap<>();
        claims.put("sub", wer);
        claims.put("preferred_username", wer);
        claims.put("realm_access", Map.of("roles", plattform ? List.of("platform-admin") : List.of()));
        if (kunde != null) claims.put("tenant_id", kunde.toString());
        return new KeycloakRealmRoleConverter().convert(new Jwt("altes-token", Instant.now(), Instant.now().plusSeconds(3600),
                Map.of("alg", "none"), claims));
    }
}
