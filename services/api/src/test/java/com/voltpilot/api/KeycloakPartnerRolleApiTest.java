package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakAdminException;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.stream.Collectors;
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
import org.springframework.http.client.JdkClientHttpRequestFactory;
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
 * UEMS AP-03 IP-3 against the REAL realm import ({@code infra/local/keycloak/voltpilot-realm.json},
 * copied onto the test classpath by the pom) and the real OIDC + RLS spine:
 *
 * <ol>
 *   <li>the import carries the new realm role {@code partner} and every role of today;</li>
 *   <li><b>Bestand:</b> {@code demo}, {@code demo2}, {@code admin} and holders of the legacy roles
 *       {@code site-admin}/{@code admin} log in with the same token content and see the same
 *       sites and the same OCPP levels as before;</li>
 *   <li>a customer account created through the admin API gets NO realm role and still exactly the
 *       rights an {@code operator} account has;</li>
 *   <li>a partner account ({@code partner}, no {@code tenant_id}) gets no customer context - not
 *       from its token, not through {@code X-Tenant-Id};</li>
 *   <li>one email is one account across customer and partner accounts (E7).</li>
 * </ol>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class KeycloakPartnerRolleApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final String DEMO_TENANT = "00000000-0000-0000-0000-000000000001";
    private static final String NORDWIND_TENANT = "10000000-0000-0000-0000-000000000001";
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";

    /**
     * OCPP levels (D4) - pinned action by action in OcppActionPolicyTest. Since AP-03 IP-7 (E13) the level comes
     * from the ZUWEISUNG - but the CONTROL axis only follows a REAL one (firstmate 16.09.2026): a Bestandskonto
     * (E12) keeps the realm-role level it had before IP-7, so operator stays at KUNDE. A Kundenadministrator
     * reaches ANLAGE by assigning a role - see RechtMatrixApiTest, where the assigned people do reach it.
     */
    private static final Set<String> KUNDE = new TreeSet<>(Set.of("RemoteStartTransaction",
            "RemoteStopTransaction", "UnlockConnector"));
    private static final Set<String> ANLAGE = new TreeSet<>(Set.of("RemoteStartTransaction",
            "RemoteStopTransaction", "UnlockConnector", "ReserveNow", "CancelReservation",
            "GetCompositeSchedule", "ChangeAvailability", "SoftReset", "GetConfiguration",
            "ChangeConfiguration", "ClearCache", "GetLocalListVersion", "SendLocalList", "TriggerMessage"));

    private static final ObjectMapper JSON = new ObjectMapper();

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
    KeycloakAdminClient keycloak;

    // ---- (1) der Realm-Import -----------------------------------------------------------

    @Test
    void realmImportTraegtPartnerUndLaesstJedeHeutigeRolleStehen() {
        String master = masterAdminToken();
        ResponseEntity<List<Map<String, Object>>> roles = keycloakRest().exchange(
                KEYCLOAK.getAuthServerUrl() + "/admin/realms/voltpilot/roles", HttpMethod.GET,
                new HttpEntity<>(bearer(master)), new ParameterizedTypeReference<>() {});
        assertThat(roles.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(roles.getBody()).extracting(r -> r.get("name"))
                .contains("operator", "admin", "site-admin", "platform-admin", "edge-release-publisher", "partner");

        assertThat(realmRollen(master, "demo")).contains("operator").doesNotContain("partner");
        assertThat(realmRollen(master, "demo2")).contains("operator").doesNotContain("partner");
        assertThat(realmRollen(master, "admin")).contains("platform-admin").doesNotContain("partner");
    }

    // ---- (2) Bestand: heutige Konten unverändert ------------------------------------------

    @Test
    void demoUndDemo2MeldenSichUnveraendertAnUndSehenDasselbe() throws Exception {
        String demo = token("demo", "demo");
        Map<String, Object> demoClaims = claims(demo);
        assertThat(demoClaims).containsEntry("tenant_id", DEMO_TENANT);
        assertThat(realmRollen(demoClaims)).contains("operator").doesNotContain("partner", "platform-admin");

        assertThat(siteNamen(bearer(demo))).contains("Demo Site Berlin").doesNotContain("Nordwind Hamburg");
        assertThat(siteNamen(withTenant(bearer(demo), NORDWIND_TENANT)))
                .as("X-Tenant-Id bleibt für Kunden wirkungslos")
                .contains("Demo Site Berlin").doesNotContain("Nordwind Hamburg");
        assertThat(freigaben(bearer(demo), BERLIN_SITE))
                .as("E12/E13: der Bestandsbenutzer bleibt ohne echte Zuweisung auf seiner Realm-Rollen-Stufe")
                .isEqualTo(KUNDE);
        assertThat(get("/api/v1/sites/" + BERLIN_SITE + "/ocpp/stations", bearer(demo)).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(get("/api/v1/admin/tenants", bearer(demo)).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);

        String demo2 = token("demo2", "demo2");
        assertThat(claims(demo2)).containsEntry("tenant_id", NORDWIND_TENANT);
        assertThat(siteNamen(bearer(demo2))).contains("Nordwind Hamburg").doesNotContain("Demo Site Berlin");
        assertThat(get("/api/v1/sites/" + BERLIN_SITE + "/ocpp/action-permissions", bearer(demo2))
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    void plattformAdminBehaeltKonsoleUndKundenbereichsWechsel() throws Exception {
        String admin = token("admin", "admin");
        Map<String, Object> adminClaims = claims(admin);
        assertThat(adminClaims).doesNotContainKey("tenant_id");
        assertThat(realmRollen(adminClaims)).contains("platform-admin").doesNotContain("partner");

        assertThat(get("/api/v1/admin/tenants", bearer(admin)).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(siteNamen(withTenant(bearer(admin), DEMO_TENANT)))
                .contains("Demo Site Berlin").doesNotContain("Nordwind Hamburg");
        assertThat(freigaben(withTenant(bearer(admin), DEMO_TENANT), BERLIN_SITE))
                .containsAll(ANLAGE).contains("HardReset", "UpdateFirmware")
                .doesNotContain("SetChargingProfile", "ClearChargingProfile");
    }

    @Test
    void traegerDerAltRollenSiteAdminUndAdminBehaltenIhreStufe() throws Exception {
        for (String altRolle : List.of("site-admin", "admin")) {
            String name = "ip3-bestand-" + altRolle;
            KeycloakUser alt = keycloak.createCustomerUser(UUID.fromString(DEMO_TENANT), name,
                    name + "@ip3.example", null, null, name + "-pw", false);
            // So wie ein Konto aus der Zeit vor IP-3: operator + die Alt-Rolle.
            keycloak.assignRealmRole(alt.id(), "operator");
            keycloak.assignRealmRole(alt.id(), altRolle);

            String t = token(name, name + "-pw");
            assertThat(claims(t)).containsEntry("tenant_id", DEMO_TENANT);
            assertThat(realmRollen(claims(t))).contains("operator", altRolle);
            assertThat(siteNamen(bearer(t))).as(altRolle)
                    .contains("Demo Site Berlin").doesNotContain("Nordwind Hamburg");
            assertThat(freigaben(bearer(t), BERLIN_SITE)).as(altRolle).isEqualTo(ANLAGE);
        }
    }

    // ---- (3) neues Kundenkonto: keine Realm-Rolle, dieselben Cloud-Rechte ------------------
    // Auf der OCPP-Achse geht es seit IP-7 darueber hinaus, weil IP-2 ihm eine echte Zuweisung gibt.

    @Test
    void neuesKundenkontoHatKeineRealmRolleUndDieselbenRechteWieOperator() throws Exception {
        String admin = token("admin", "admin");
        String tenantId = createTenant(admin, "IP-3 Probekunde GmbH");
        createUser(admin, tenantId, "ip3-kunde", "kunde@ip3.example", "ip3-kunde-pw");

        assertThat(realmRollen(masterAdminToken(), "ip3-kunde"))
                .as("nur die Keycloak-Vorgabe, keine VoltPilot-Rolle").containsExactly("default-roles-voltpilot");

        String kunde = token("ip3-kunde", "ip3-kunde-pw");
        Map<String, Object> c = claims(kunde);
        assertThat(c).containsEntry("tenant_id", tenantId);
        assertThat(realmRollen(c)).doesNotContain("operator", "admin", "site-admin", "platform-admin", "partner");

        ResponseEntity<Map<String, Object>> anlage = rest.exchange(url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "IP-3 Probeanlage", "biddingZone", "DE-LU"), bearer(kunde)),
                new ParameterizedTypeReference<>() {});
        assertThat(anlage.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String siteId = (String) anlage.getBody().get("id");

        assertThat(siteNamen(bearer(kunde))).containsExactly("IP-3 Probeanlage");
        // Auf der OCPP-Achse geht dieses Konto seit IP-7 ueber demo hinaus - und zwar zu Recht: IP-2 gibt dem
        // Anleger eines neuen Kundenbereichs eine ECHTE Zuweisung (Kundenadministrator, ZugriffBestand.beiAnlage),
        // also greift E13. demo ist dagegen ein Bestandskonto ohne jede Zuweisung und bleibt auf seiner
        // Realm-Rollen-Stufe. Niemand verliert dabei etwas: der Kundensatz bleibt Teilmenge.
        assertThat(freigaben(bearer(kunde), siteId))
                .as("echte Zuweisung aus IP-2 = Anlagen-Stufe, anders als beim Bestandskonto demo")
                .isEqualTo(ANLAGE)
                .containsAll(freigaben(bearer(token("demo", "demo")), BERLIN_SITE));
        assertThat(get("/api/v1/sites/" + siteId + "/ocpp/stations", bearer(kunde)).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(get("/api/v1/sites/" + BERLIN_SITE + "/ocpp/action-permissions", bearer(kunde))
                .getStatusCode()).as("fremde Anlage bleibt 404").isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(get("/api/v1/admin/tenants", bearer(kunde)).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
    }

    // ---- (4) Partner-Konto: kein Kundenkontext ---------------------------------------------

    @Test
    void partnerKontoOhneTenantIdBekommtKeinenKundenkontext() throws Exception {
        KeycloakUser partner = keycloak.createPartnerUser("ip3-partner-brunner",
                "brunner@partner-ip3.example", "Frank", "Brunner", "ip3-partner-pw", false);
        assertThat(partner.tenantId()).isNull();
        assertThat(realmRollen(masterAdminToken(), "ip3-partner-brunner"))
                .contains("partner").doesNotContain("operator", "platform-admin");

        String t = token("ip3-partner-brunner", "ip3-partner-pw");
        Map<String, Object> c = claims(t);
        assertThat(c).doesNotContainKey("tenant_id");
        assertThat(realmRollen(c)).contains("partner")
                .doesNotContain("operator", "admin", "site-admin", "platform-admin");

        // Seit AP-03 IP-4 ist ein Partner ohne wirksame Unterstützung auf JEDER Kundenroute 404 — keine leere Liste,
        // kein 403 (ZugriffFilter; alle Routen: ZugriffZaunApiTest). Der Plattform-Betrieb bleibt 403.
        assertThat(get("/api/v1/sites", bearer(t)).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(get("/api/v1/sites", withTenant(bearer(t), DEMO_TENANT)).getStatusCode())
                .as("X-Tenant-Id nur für die Plattform").isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(get("/api/v1/sites/" + BERLIN_SITE, withTenant(bearer(t), DEMO_TENANT)).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(get("/api/v1/sites/" + BERLIN_SITE + "/ocpp/action-permissions", withTenant(bearer(t), DEMO_TENANT))
                .getStatusCode()).as("404 vor dem Recht, nie 403").isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(get("/api/v1/admin/tenants", bearer(t)).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);

        ResponseEntity<String> me = get("/api/v1/me", withTenant(bearer(t), DEMO_TENANT));
        assertThat(me.getStatusCode()).as("die Selbstauskunft antwortet ohne Kundenbereich").isEqualTo(HttpStatus.OK);
        assertThat(JSON.readTree(me.getBody()).path("konto").asText()).isEqualTo("partner");
        assertThat(JSON.readTree(me.getBody()).path("kundenbereich").isNull()).isTrue();

        ResponseEntity<String> anlegen = rest.exchange(url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Partner-Anlage"), withTenant(bearer(t), DEMO_TENANT)), String.class);
        assertThat(anlegen.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(siteNamen(bearer(token("demo", "demo")))).doesNotContain("Partner-Anlage");
    }

    // ---- (5) E7: eine E-Mail, ein Konto -----------------------------------------------------

    @Test
    void kundenkontoUndPartnerKontoMitDerselbenEmailKollidieren() {
        String admin = token("admin", "admin");
        String tenantId = createTenant(admin, "IP-3 E7 Probe GmbH");
        createUser(admin, tenantId, "ip3-e7-kunde", "doppelt@ip3.example", "ip3-e7-pw");

        assertThatThrownBy(() -> keycloak.createPartnerUser("ip3-e7-partner", "doppelt@ip3.example",
                null, null, "ip3-e7-pw-2", false))
                .isInstanceOf(KeycloakAdminException.class)
                .satisfies(ex -> assertThat(((KeycloakAdminException) ex).status()).isEqualTo(409));
        assertThat(nutzerIds(masterAdminToken(), "ip3-e7-partner")).isEmpty();
    }

    // ---- helpers ---------------------------------------------------------------------------

    private Set<String> freigaben(HttpHeaders headers, String siteId) {
        ResponseEntity<Map<String, Map<String, Boolean>>> res = rest.exchange(
                url("/api/v1/sites/" + siteId + "/ocpp/action-permissions"), HttpMethod.GET,
                new HttpEntity<>(headers), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody().get("actions").entrySet().stream()
                .filter(e -> Boolean.TRUE.equals(e.getValue()))
                .map(Map.Entry::getKey)
                .collect(Collectors.toCollection(TreeSet::new));
    }

    private List<Object> siteNamen(HttpHeaders headers) {
        ResponseEntity<List<Map<String, Object>>> res = com.voltpilot.api.SichtbareListenTestLeser.lesen(rest, url("/api/v1/sites"), HttpMethod.GET,
                new HttpEntity<>(headers), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody().stream().map(s -> s.get("name")).toList();
    }

    private ResponseEntity<String> get(String path, HttpHeaders headers) {
        return rest.exchange(url(path), HttpMethod.GET, new HttpEntity<>(headers), String.class);
    }

    private String createTenant(String adminToken, String name) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(url("/api/v1/admin/tenants"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", name, "segment", "CI"), bearer(adminToken)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return (String) res.getBody().get("id");
    }

    private void createUser(String adminToken, String tenantId, String username, String email, String password) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/users"), HttpMethod.POST,
                new HttpEntity<>(Map.of("username", username, "email", email), bearer(adminToken)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        @SuppressWarnings("unchecked")
        Map<String, Object> konto = (Map<String, Object>) res.getBody().get("benutzer");
        // IP-14: dieser Bestandsnachweis beginnt nach abgeschlossenem Pflichtwechsel.
        keycloak.resetPassword((String) konto.get("sub"), password, false);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> claims(String jwt) throws Exception {
        byte[] payload = Base64.getUrlDecoder().decode(jwt.split("\\.")[1]);
        return JSON.readValue(payload, Map.class);
    }

    @SuppressWarnings("unchecked")
    private static List<String> realmRollen(Map<String, Object> claims) {
        Object realmAccess = claims.get("realm_access");
        return realmAccess instanceof Map<?, ?> m && m.get("roles") instanceof List<?> roles
                ? (List<String>) roles : List.of();
    }

    /** Direct realm-role mappings of a voltpilot-realm user (Keycloak admin API). */
    private static List<Object> realmRollen(String masterToken, String username) {
        List<String> ids = nutzerIds(masterToken, username);
        assertThat(ids).as("Konto " + username).hasSize(1);
        ResponseEntity<List<Map<String, Object>>> res = keycloakRest().exchange(
                KEYCLOAK.getAuthServerUrl() + "/admin/realms/voltpilot/users/" + ids.get(0) + "/role-mappings/realm",
                HttpMethod.GET, new HttpEntity<>(bearer(masterToken)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody().stream().map(r -> r.get("name")).toList();
    }

    private static List<String> nutzerIds(String masterToken, String username) {
        ResponseEntity<List<Map<String, Object>>> users = keycloakRest().exchange(
                KEYCLOAK.getAuthServerUrl() + "/admin/realms/voltpilot/users?exact=true&username=" + username,
                HttpMethod.GET, new HttpEntity<>(bearer(masterToken)), new ParameterizedTypeReference<>() {});
        assertThat(users.getStatusCode()).isEqualTo(HttpStatus.OK);
        return users.getBody().stream().map(u -> (String) u.get("id")).toList();
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

    private static HttpHeaders withTenant(HttpHeaders h, String tenantId) {
        h.set("X-Tenant-Id", tenantId);
        return h;
    }

    /** Direct-access-grant token for a realm user via the confidential api client. */
    @SuppressWarnings("unchecked")
    private static String token(String username, String password) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", "voltpilot-api");
        form.add("client_secret", "voltpilot-api-dev-secret");
        form.add("username", username);
        form.add("password", password);
        form.add("scope", "openid");
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        Map<String, Object> body = keycloakRest().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).as("token response for " + username).containsKey("access_token");
        return (String) body.get("access_token");
    }

    /** Master-realm admin-cli token for Keycloak's own admin API. */
    @SuppressWarnings("unchecked")
    private static String masterAdminToken() {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", "admin-cli");
        form.add("username", KEYCLOAK.getAdminUsername());
        form.add("password", KEYCLOAK.getAdminPassword());
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        Map<String, Object> body = keycloakRest().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/master/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).as("master admin token").containsKey("access_token");
        return (String) body.get("access_token");
    }

    /** JDK client: the default HttpURLConnection cannot read a 401 body on a streamed POST. */
    private static TestRestTemplate keycloakRest() {
        TestRestTemplate t = new TestRestTemplate();
        t.getRestTemplate().setRequestFactory(new JdkClientHttpRequestFactory());
        return t;
    }
}
