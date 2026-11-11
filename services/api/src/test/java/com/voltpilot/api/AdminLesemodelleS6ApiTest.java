package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.sql.Connection;
import java.sql.DriverManager;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
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
 * End-to-end proof of the S6 Lesemodelle (Adminview-Konzept Abschnitt 3.4,
 * Scheibe S6): L1 Plattform-Dienste, L2 Herzschlag/Messwert getrennt, L3
 * Geräteakte in einer Antwort, L4 Zertifikat gültig bis (Schreibpfad), L5
 * Meldungen plattformweit (mit RLS-Beleg), L6 Personensuche über alle Kunden,
 * L7 Geräte-Liste über alle Lebensabschnitte.
 *
 * <p>Jeder neue Endpunkt verlangt ein gültiges {@code platform-admin}-Token
 * (403 für den Kunden-Operator {@code demo}); die RLS-Umgehung bleibt auf die
 * admin-geschützten Repositories beschränkt - der mandantenbezogene Pfad
 * (hier {@code /api/v1/meldungen}) wird NIE angefasst und bleibt in L5 bewusst
 * mitgeprüft.
 */
@Testcontainers(disabledWithoutDocker = true)
@AutoConfigureTestRestTemplate
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class AdminLesemodelleS6ApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";
    private static final String TENANT_B = "10000000-0000-0000-0000-000000000001";
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

    @Autowired
    com.voltpilot.api.enrollment.EnrollmentRepository enrollments;

    // ---- L1 Plattform-Dienste -------------------------------------------------

    @Test
    void plattformDiensteListsAllFiveServicesAndRequiresPlatformAdmin() {
        String admin = token("admin", "admin");
        ResponseEntity<Map<String, Object>> res = get("/api/v1/admin/plattform/dienste", admin, null);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> dienste = cast(res.getBody().get("dienste"));
        assertThat(dienste).extracting(d -> d.get("name")).containsExactly(
                "optimierer", "preise", "messwerte", "tunnel-dienst", "werkstatt-dienst");

        String demo = token("demo", "demo");
        assertThat(get("/api/v1/admin/plattform/dienste", demo, null).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
    }

    // ---- L2 (additiv in /admin/fleet) + L3 Geräteakte in einer Antwort -------

    @Test
    void geraeteAkteComposesHeartbeatTelemetryAndLifecycleInOneResponse() {
        String ref = "s6-akte-" + UUID.randomUUID().toString().substring(0, 8);
        UUID deviceId = UUID.randomUUID();
        Instant herzschlag = Instant.parse("2026-11-06T10:00:00Z");
        Instant messwert = Instant.parse("2026-11-06T09:50:00Z");
        exec("INSERT INTO device (id, tenant_id, site_id, external_ref, kind, device_status_seen_at) "
                + "VALUES ('" + deviceId + "', '" + TENANT_A + "', '" + BERLIN_SITE + "', '"
                + ref + "', 'gateway', '" + herzschlag + "')");
        exec("INSERT INTO telemetry (time, tenant_id, site_id, device_id, received_at, pv_power_kw) "
                + "VALUES (now(), '" + TENANT_A + "', '" + BERLIN_SITE + "', '" + deviceId + "', '"
                + messwert + "', 1.0)");

        String admin = token("admin", "admin");

        // L2: Herzschlag und Messwert bleiben getrennt im Flotten-Lesemodell.
        ResponseEntity<Map<String, Object>> fleet = get("/api/v1/admin/fleet", admin, null);
        assertThat(fleet.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> sites = cast(fleet.getBody().get("sites"));
        Map<String, Object> site = sites.stream()
                .filter(s -> BERLIN_SITE.equals(s.get("siteId")))
                .findFirst().orElseThrow();
        List<Map<String, Object>> boxes = cast(site.get("boxes"));
        Map<String, Object> box = boxes.stream()
                .filter(b -> ref.equals(b.get("externalRef")))
                .findFirst().orElseThrow();
        assertThat(box.get("herzschlagAm")).isEqualTo("2026-11-06T10:00:00Z");
        assertThat(box.get("messwertAm")).isEqualTo("2026-11-06T09:50:00Z");
        // Additiv, kein Bruch: der verschmolzene Wert bleibt bestehen.
        assertThat(box.get("lastSeenAt")).isNotNull();

        // L3: dieselbe Box in EINER Antwort der Geräteakte.
        ResponseEntity<Map<String, Object>> akte = get("/api/v1/admin/geraete/" + ref, admin, null);
        assertThat(akte.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(akte.getBody().get("lebensabschnitt")).isEqualTo("kunde");
        Map<String, Object> kopf = cast(akte.getBody().get("kopf"));
        assertThat(kopf.get("deviceId")).isEqualTo(deviceId.toString());
        assertThat(kopf.get("tenantId")).isEqualTo(TENANT_A);
        assertThat(kopf.get("herzschlagAm")).isEqualTo("2026-11-06T10:00:00Z");
        assertThat(kopf.get("messwertAm")).isEqualTo("2026-11-06T09:50:00Z");

        assertThat(get("/api/v1/admin/geraete/unbekannte-referenz-xyz", admin, null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ---- L4 Zertifikat gültig bis (Schreibpfad) -------------------------------

    @Test
    void storeCertificatePersistsNotAfterAlongsideTheCertificate() {
        String ref = "s6-cert-" + UUID.randomUUID().toString().substring(0, 8);
        UUID deviceId = UUID.randomUUID();
        exec("INSERT INTO device_enrollment (external_ref, csr_pem) VALUES ('" + ref
                + "', 'placeholder-csr')");

        Instant notAfter = Instant.parse("2028-02-10T00:00:00Z");
        boolean stored = enrollments.storeCertificate(ref, deviceId, "placeholder-cert-pem",
                "AB12", notAfter);
        assertThat(stored).isTrue();

        var found = enrollments.find(ref).orElseThrow();
        assertThat(found.notAfter()).isEqualTo(notAfter);
        assertThat(found.certPem()).isEqualTo("placeholder-cert-pem");
    }

    // ---- L5 Meldungen plattformweit, mit RLS-Beleg ----------------------------

    @Test
    void adminMeldungenSeesAllTenantsWhileTheCustomerPathStaysFencedByRls() {
        UUID regelA = seedUeberwachung(TENANT_A, BERLIN_SITE);
        UUID regelB = seedUeberwachung(TENANT_B, HAMBURG_SITE);
        String kennzeichenA = "AL-TEST-" + UUID.randomUUID().toString().substring(0, 8);
        String kennzeichenB = "AL-TEST-" + UUID.randomUUID().toString().substring(0, 8);
        seedAlarm(TENANT_A, regelA, kennzeichenA, "anlage:" + BERLIN_SITE);
        seedAlarm(TENANT_B, regelB, kennzeichenB, "anlage:" + HAMBURG_SITE);

        // Der admin-geschützte Pfad sieht BEIDE Mandanten.
        String admin = token("admin", "admin");
        ResponseEntity<Map<String, Object>> adminListe = get("/api/v1/admin/meldungen", admin, null);
        assertThat(adminListe.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> adminMeldungen = cast(adminListe.getBody().get("meldungen"));
        List<String> adminKennzeichen = adminMeldungen.stream()
                .map(m -> (String) m.get("kennzeichen")).toList();
        assertThat(adminKennzeichen).contains(kennzeichenA, kennzeichenB);
        assertThat(get("/api/v1/admin/meldungen", token("demo", "demo"), null).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);

        // Der UNVERÄNDERTE Kunden-Pfad bleibt auf SEINEN Mandanten gezäunt - die
        // Kunden-RLS-Politik auf `alarm` wurde durch L5 nicht gelockert.
        String demo = token("demo", "demo"); // Operator von TENANT_A
        ResponseEntity<Map<String, Object>> kundenListe = get("/api/v1/meldungen", demo, null);
        assertThat(kundenListe.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> kundenMeldungen = cast(kundenListe.getBody().get("meldungen"));
        List<String> kundenKennzeichen = kundenMeldungen.stream()
                .map(m -> (String) m.get("kennzeichen")).toList();
        assertThat(kundenKennzeichen).contains(kennzeichenA);
        assertThat(kundenKennzeichen).doesNotContain(kennzeichenB);
    }

    // ---- L6 Personensuche über alle Kunden ------------------------------------

    @Test
    void personensucheFindsAccountsAcrossTenantsAndRequiresPlatformAdmin() {
        String admin = token("admin", "admin");
        ResponseEntity<List<Map<String, Object>>> res = rest.exchange(
                url("/api/v1/admin/personen?suche=demo"), HttpMethod.GET,
                new HttpEntity<>(bearer(admin)),
                new ParameterizedTypeReference<List<Map<String, Object>>>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(res.getBody()).anySatisfy(u -> {
            assertThat(u.get("username")).isEqualTo("demo");
            assertThat(u.get("tenantId")).isEqualTo(TENANT_A);
        });

        assertThat(rest.exchange(url("/api/v1/admin/personen?suche=demo"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))), String.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);

        // Leere Suche liefert eine leere Liste, nie den ganzen Realm.
        ResponseEntity<List<Map<String, Object>>> leer = rest.exchange(
                url("/api/v1/admin/personen"), HttpMethod.GET, new HttpEntity<>(bearer(admin)),
                new ParameterizedTypeReference<List<Map<String, Object>>>() {});
        assertThat(leer.getBody()).isEmpty();
    }

    // ---- L7 Geräte-Liste über alle Lebensabschnitte ---------------------------

    @Test
    void geraeteListeCoversPrintedAndClaimedLifeStages() {
        String gedruckt = "s6-gedruckt-" + UUID.randomUUID().toString().substring(0, 8);
        exec("INSERT INTO provisioned_device (external_ref, kind) VALUES ('" + gedruckt + "', 'edge-light')");

        String kunde = "s6-kunde-" + UUID.randomUUID().toString().substring(0, 8);
        exec("INSERT INTO device (id, tenant_id, site_id, external_ref, kind) VALUES ('"
                + UUID.randomUUID() + "', '" + TENANT_A + "', '" + BERLIN_SITE + "', '" + kunde + "', 'gateway')");

        String admin = token("admin", "admin");
        ResponseEntity<Map<String, Object>> res = get("/api/v1/admin/geraeteliste", admin, null);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> geraete = cast(res.getBody().get("geraete"));

        assertThat(geraete).anySatisfy(g -> {
            if (gedruckt.equals(g.get("externalRef"))) {
                assertThat(g.get("lebensabschnitt")).isEqualTo("gedruckt");
            }
        });
        assertThat(geraete.stream().anyMatch(g -> gedruckt.equals(g.get("externalRef"))
                && "gedruckt".equals(g.get("lebensabschnitt")))).isTrue();
        assertThat(geraete.stream().anyMatch(g -> kunde.equals(g.get("externalRef"))
                && "kunde".equals(g.get("lebensabschnitt")))).isTrue();

        assertThat(get("/api/v1/admin/geraeteliste", token("demo", "demo"), null).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
    }

    // ---- Helfer ----------------------------------------------------------------

    @SuppressWarnings("unchecked")
    private static <T> T cast(Object o) {
        return (T) o;
    }

    private UUID seedUeberwachung(String tenantId, String siteId) {
        UUID id = UUID.randomUUID();
        exec("INSERT INTO ueberwachung (id, tenant_id, standort_id, wertart, bezug, bedingung, "
                + "schwere, empfaenger, herkunft, angelegt_von) VALUES ('" + id + "', '" + tenantId
                + "', NULL, 's6-test', '{\"anlage\":\"" + siteId + "\"}', "
                + "'{\"art\":\"zustand\",\"ziel\":[\"nicht_erreichbar\"]}', 'warnung', '[]', "
                + "'vorschlag', 's6-test')");
        return id;
    }

    private void seedAlarm(String tenantId, UUID ueberwachungId, String kennzeichen, String bezugKennung) {
        exec("INSERT INTO alarm (tenant_id, kennzeichen, ueberwachung_id, fassung, bezug_kennung, "
                + "wertart, schwere, ausgeloest_am) VALUES ('" + tenantId + "', '" + kennzeichen + "', '"
                + ueberwachungId + "', 1, '" + bezugKennung + "', 's6-test', 'warnung', now())");
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

    private ResponseEntity<Map<String, Object>> get(String path, String token, String tenantId) {
        HttpHeaders h = bearer(token);
        if (tenantId != null) {
            h.add("X-Tenant-Id", tenantId);
        }
        return rest.exchange(url(path), HttpMethod.GET, new HttpEntity<>(h),
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

    private static void exec(String sql) {
        try (Connection c = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                java.sql.Statement st = c.createStatement()) {
            st.execute(sql);
        } catch (Exception e) {
            throw new IllegalStateException("seed failed: " + sql, e);
        }
    }
}
