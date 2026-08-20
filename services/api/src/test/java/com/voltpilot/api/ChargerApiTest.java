package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.chargers.ChargerComponentComposer;
import com.voltpilot.api.chargers.ChargerStatusListener;
import com.voltpilot.api.repo.DeviceChargerStatusRepository;
import com.voltpilot.api.repo.DeviceRepository;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
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
 * Die Ladepunkte werden cloud-sichtbar (Lastmanagement Stufe 3) - gegen echtes
 * TimescaleDB + Keycloak. Geprüft wird die REISE (die Parser-Regeln liegen rein
 * in {@code ChargerStatusListenerTest}):
 *
 * <ol>
 *   <li>ein Herzschlag durch den ECHTEN Zuhörer → Budget, Säulen und Stecker
 *       stehen in der Lesefläche, mit den Worten der Box;</li>
 *   <li>aus der gemeldeten Säule wird OHNE einen Klick eine Komponente - und
 *       beim zweiten Herzschlag GENAU EINE, keine zweite;</li>
 *   <li>der Satz wird je Herzschlag GANZ ersetzt: eine entfernte Säule
 *       verschwindet, ein Geist bleibt nicht stehen;</li>
 *   <li>eine Anlage ohne Ladesäulen bekommt eine ehrliche leere Antwort, nie
 *       ein Budget von 0;</li>
 *   <li>der Mandanten-Zaun: eine fremde Anlage ist 404, anonym ist 401.</li>
 * </ol>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class ChargerApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Container
    static final KeycloakContainer KEYCLOAK =
            new KeycloakContainer("quay.io/keycloak/keycloak:26.0.5")
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

    @Autowired
    DeviceRepository devices;

    @Autowired
    DeviceChargerStatusRepository chargerStatus;

    @Autowired
    ChargerComponentComposer composer;

    @Autowired
    com.voltpilot.api.command.CommandLogWriter commandLog;

    private final ObjectMapper json = new ObjectMapper();

    @Test
    void theChargePointsReachTheCloudAndBecomeComponentsWithoutASingleClick() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Ladepark-Anlage");
        try {
            UUID device = claim(customer, site, "edge-ladepark-1");

            // 0 · Vorher ist die Antwort ehrlich LEER - kein Budget von 0.
            JsonNode empty = getJson("/api/v1/sites/" + site + "/chargers", customer);
            assertThat(empty.get("budget").isNull()).isTrue();
            assertThat(empty.get("chargers")).isEmpty();

            // 1 · Ein Herzschlag durch den ECHTEN Zuhörer.
            heartbeat(site, device, twoStations());

            JsonNode view = getJson("/api/v1/sites/" + site + "/chargers", customer);
            JsonNode budget = view.get("budget");
            assertThat(budget.get("gridLimitKw").asDouble()).isEqualTo(277.0);
            assertThat(budget.get("budgetKw").asDouble()).isEqualTo(82.3);
            assertThat(budget.get("connectorCount").asInt()).isEqualTo(4);
            assertThat(budget.get("safeDefaultHolds").asBoolean()).isTrue();
            // Der deutsche Satz der Box, unverändert weitergereicht.
            assertThat(budget.get("budgetNote").asText())
                    .isEqualTo("Das Budget folgt der Messung am Netzanschluss.");

            assertThat(view.get("chargers")).hasSize(2);
            JsonNode first = view.get("chargers").get(0);
            assertThat(first.get("chargePointId").asText()).isEqualTo("saeule-1");
            assertThat(first.get("label").asText()).isEqualTo("Hof Nord");
            assertThat(first.get("connectors")).hasSize(2);
            JsonNode charging = first.get("connectors").get(0);
            assertThat(charging.get("charging").asBoolean()).isTrue();
            assertThat(charging.get("allocatedKw").asDouble()).isEqualTo(41.0);
            assertThat(charging.get("powerKw").asDouble()).isEqualTo(40.0);
            assertThat(charging.get("socPct").asDouble()).isEqualTo(62.0);
            JsonNode waiting = first.get("connectors").get(1);
            assertThat(waiting.get("reasonText").asText())
                    .isEqualTo("wartet - Budget vergeben");
            // Ein Stecker ohne Messung trägt KEINE erfundene 0.
            assertThat(waiting.get("powerKw").isNull()).isTrue();

            // 2 · Beide Säulen sind KOMPONENTEN - ohne einen Klick.
            JsonNode entities = getJson("/api/v1/sites/" + site + "/entities", customer);
            assertThat(chargerEntities(entities)).as("je Säule eine Komponente").isEqualTo(2);
            assertThat(view.get("chargers").get(0).hasNonNull("entityId")).isTrue();

            // 3 · Der zweite Herzschlag legt KEINE zweite an.
            heartbeat(site, device, twoStations());
            assertThat(chargerEntities(getJson("/api/v1/sites/" + site + "/entities", customer)))
                    .as("genau EINMAL je Säule").isEqualTo(2);
            // ... und die Bindung überlebt das Ersetzen des Satzes.
            JsonNode again = getJson("/api/v1/sites/" + site + "/chargers", customer);
            assertThat(again.get("chargers").get(0).get("entityId").asText())
                    .isEqualTo(view.get("chargers").get(0).get("entityId").asText());

            // 4 · Der Satz wird GANZ ersetzt: die zweite Säule ist entfernt.
            heartbeat(site, device, oneStation());
            JsonNode shrunk = getJson("/api/v1/sites/" + site + "/chargers", customer);
            assertThat(shrunk.get("chargers")).as("kein Geist bleibt stehen").hasSize(1);

            // 5 · Der Mandanten-Zaun.
            ResponseEntity<String> foreign = rest.exchange(
                    url("/api/v1/sites/" + site + "/chargers"), HttpMethod.GET,
                    new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class);
            assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
            ResponseEntity<String> anonymous = rest.exchange(
                    url("/api/v1/sites/" + site + "/chargers"), HttpMethod.GET, null, String.class);
            assertThat(anonymous.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        } finally {
            deleteSite(site);
        }
    }


    /**
     * Die Anschlussgrenze wird im PORTAL gepflegt (Stufe 3, PR 12) - und der
     * Modus „Ladepark-Lastmanagement" steht als viertes Regal-Profil da,
     * abgeleitet aus dem, was die Anlage WIRKLICH hat.
     */
    @Test
    void theConnectionLimitIsMaintainedInThePortalAndTheShelfProfileFollowsThePlant()
            throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Ladepark-Konfiguration");
        try {
            UUID device = claim(customer, site, "edge-ladepark-2");

            // 0 · Ohne gepflegte Grenze ist die Antwort ehrlich leer - nie eine 0.
            JsonNode empty = getJson("/api/v1/sites/" + site + "/charging-config", customer);
            assertThat(empty.get("gridLimitKw").isNull()).isTrue();
            assertThat(empty.get("priorityChargePointIds")).isEmpty();

            // ... und das Regal-Profil ist da, aber NICHT aktiv: es hat sich
            // keine Säule gemeldet, und die Karte sagt genau das.
            JsonNode card = profileCard(customer, site);
            assertThat(card.get("label").asText()).isEqualTo("Ladepark-Lastmanagement");
            assertThat(card.get("active").asBoolean()).isFalse();
            assertThat(card.get("gatedNodeTypes"))
                    .as("Lastmanagement ist SCHUTZ, keine Marktteilnahme - nichts freizuschalten")
                    .isEmpty();
            assertThat(card.get("requirements").get(0).get("met").asBoolean()).isFalse();

            // 1 · Eine Säule meldet sich -> der Modus ist ABGELEITET aktiv (eine
            //     Anlage, die Autos lädt, deren Karte aber "aus" sagt, wäre eine
            //     Falschaussage), und die fehlende Grenze wird BENANNT.
            heartbeat(site, device, twoStations());
            card = profileCard(customer, site);
            assertThat(card.get("derivedActive").asBoolean()).isTrue();
            assertThat(card.get("active").asBoolean()).isTrue();
            assertThat(card.get("blockedReason").asText()).contains("Anschlussgrenze");

            // 2 · Der Aktivieren-Dialog speichert die Anschlussgrenze.
            JsonNode saved = putJson("/api/v1/sites/" + site + "/charging-config", customer,
                    Map.of("gridLimitKw", 277));
            assertThat(saved.get("gridLimitKw").asDouble()).isEqualTo(277.0);
            assertThat(saved.hasNonNull("updatedBy")).as("die Papier-Spur steht").isTrue();
            assertThat(profileCard(customer, site).get("blockedReason").isNull())
                    .as("mit Grenze und Säule ist nichts mehr im Weg").isTrue();

            // 3 · Die Vorrang-Wahl - und die PATCH-Semantik: sie fasst die
            //     Anschlussgrenze nicht an.
            JsonNode withPriority = putJson("/api/v1/sites/" + site + "/charging-config", customer,
                    Map.of("priorityChargePointIds", List.of("saeule-2")));
            assertThat(withPriority.get("gridLimitKw").asDouble()).isEqualTo(277.0);
            assertThat(withPriority.get("priorityChargePointIds")).hasSize(1);

            // 4 · Eine Säule, die es nicht gibt, wird ABGELEHNT statt still
            //     gespeichert - sonst fände den Tippfehler nie wieder jemand.
            ResponseEntity<String> unknown = rest.exchange(
                    url("/api/v1/sites/" + site + "/charging-config"), HttpMethod.PUT,
                    new HttpEntity<>(Map.of("priorityChargePointIds", List.of("gibt-es-nicht")),
                            bearer(customer)),
                    String.class);
            assertThat(unknown.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(unknown.getBody()).contains("kennt keine Ladesäule");
            // Und eine Grenze von 0 ebenso: ohne Grenze lädt gar nichts.
            ResponseEntity<String> zero = rest.exchange(
                    url("/api/v1/sites/" + site + "/charging-config"), HttpMethod.PUT,
                    new HttpEntity<>(Map.of("gridLimitKw", 0), bearer(customer)), String.class);
            assertThat(zero.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            // ... beide Ablehnungen haben NICHTS verändert.
            assertThat(getJson("/api/v1/sites/" + site + "/charging-config", customer)
                    .get("gridLimitKw").asDouble()).isEqualTo(277.0);

            // 5 · Der Mandanten-Zaun gilt auf beiden Verben.
            ResponseEntity<String> foreignRead = rest.exchange(
                    url("/api/v1/sites/" + site + "/charging-config"), HttpMethod.GET,
                    new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class);
            assertThat(foreignRead.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
            ResponseEntity<String> foreignWrite = rest.exchange(
                    url("/api/v1/sites/" + site + "/charging-config"), HttpMethod.PUT,
                    new HttpEntity<>(Map.of("gridLimitKw", 1), bearer(token("demo2", "demo2"))),
                    String.class);
            assertThat(foreignWrite.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        } finally {
            deleteSite(site);
        }
    }

    /** Die „lastmanagement"-Karte des Regals. */
    private JsonNode profileCard(String token, UUID site) throws Exception {
        JsonNode shelf = getJson("/api/v1/sites/" + site + "/profiles", token);
        for (JsonNode p : shelf.get("profiles")) {
            if ("lastmanagement".equals(p.get("id").asText())) {
                return p;
            }
        }
        throw new AssertionError("das Regal kennt kein Lastmanagement-Profil: " + shelf);
    }

    private JsonNode putJson(String path, String token, Map<String, Object> body) throws Exception {
        ResponseEntity<String> res = rest.exchange(url(path), HttpMethod.PUT,
                new HttpEntity<>(body, bearer(token)), String.class);
        assertThat(res.getStatusCode()).as("PUT %s -> %s", path, res.getBody())
                .isEqualTo(HttpStatus.OK);
        return json.readTree(res.getBody());
    }

    /** Wie viele Komponenten vom Typ Ladepunkt die Anlage trägt. */
    private static int chargerEntities(JsonNode entities) {
        int n = 0;
        for (JsonNode e : entities.get("entities")) {
            if ("ev-charger".equals(e.path("entityType").asText())) {
                n++;
            }
        }
        return n;
    }

    // ---- der echte Weg: ein Herzschlag durch den echten Zuhörer -------------

    private void heartbeat(UUID site, UUID device, String chargersBlock) {
        @SuppressWarnings("unchecked")
        ObjectProvider<ChargerComponentComposer> provider =
                org.mockito.Mockito.mock(ObjectProvider.class);
        org.mockito.Mockito.when(provider.getIfAvailable()).thenReturn(composer);
        @SuppressWarnings("unchecked")
        ObjectProvider<com.voltpilot.api.command.CommandLogWriter> logProvider =
                org.mockito.Mockito.mock(ObjectProvider.class);
        org.mockito.Mockito.when(logProvider.getIfAvailable()).thenReturn(commandLog);
        ChargerStatusListener listener = new ChargerStatusListener("tcp://unused", "", "", devices,
                chargerStatus, provider, logProvider);
        String payload = """
                {"schema_version":"1.0","tenant_id":"%s","site_id":"%s","device_id":"%s",
                 "online":true,"chargers":%s}"""
                .formatted(TENANT_A, site, device, chargersBlock);
        listener.handle("ems/%s/%s/%s/status".formatted(TENANT_A, site, device),
                payload.getBytes(StandardCharsets.UTF_8));
    }

    /** Das Beispiel-Szenario der abgenommenen Mockups: 277 kW, 167 kW Gebäude. */
    private static String twoStations() {
        return """
                {"reported_at":"2026-08-20T11:24:00Z","enabled":true,"control_enabled":true,
                 "grid_limit_kw":277,"margin_pct":10,"min_power_kw":30,"budget_kw":82.3,
                 "allocated_kw":82,"measured_kw":79,"site_load_kw":167,"site_grid_kw":246,
                 "budget_mode":"gemessen",
                 "budget_note":"Das Budget folgt der Messung am Netzanschluss.",
                 "eff_limit_kw":277,"safe_default_kw":15,"safe_default_holds":true,
                 "safe_worst_case_kw":270,"max_house_load_kw":180,"connector_count":4,
                 "chargers":[
                   {"id":"saeule-1","label":"Hof Nord","connected":true,"ready":true,
                    "vendor":"Midapower","model":"DC-240","last_seen":"2026-08-20T11:23:55Z",
                    "connectors":[
                      {"id":1,"status":"Charging","charging":true,"allocated_kw":41,
                       "reason":"laedt","reason_text":"lädt","power_kw":40,"soc_pct":62,
                       "command_status":"Accepted","readback":"ok",
                       "session_since":"2026-08-20T10:41:00Z"},
                      {"id":2,"status":"Preparing","charging":false,"allocated_kw":0,
                       "reason":"wartet_budget","reason_text":"wartet - Budget vergeben",
                       "next_turn":"2026-08-20T11:26:00Z"}]},
                   {"id":"saeule-2","label":"Hof Süd","connected":true,"ready":true,
                    "last_seen":"2026-08-20T11:23:50Z",
                    "connectors":[{"id":1,"status":"Available","charging":false},
                                  {"id":2,"status":"Available","charging":false}]}]}""";
    }

    private static String oneStation() {
        return """
                {"reported_at":"2026-08-20T11:39:00Z","enabled":true,"control_enabled":true,
                 "grid_limit_kw":277,"budget_kw":82.3,"connector_count":2,
                 "chargers":[{"id":"saeule-1","label":"Hof Nord","connected":true,"ready":true,
                   "connectors":[{"id":1,"status":"Available","charging":false}]}]}""";
    }

    // ---- Rahmen ------------------------------------------------------------

    private UUID claim(String customerToken, UUID siteId, String ref) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(url("/api/v1/devices/claim"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("externalRef", ref, "siteId", siteId.toString(),
                        "kind", "inverter"), bearer(customerToken)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isIn(HttpStatus.OK, HttpStatus.CREATED);
        return UUID.fromString((String) res.getBody().get("id"));
    }

    private UUID createSite(String customerToken, String name) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(url("/api/v1/sites"),
                HttpMethod.POST, new HttpEntity<>(Map.of("name", name), bearer(customerToken)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return UUID.fromString((String) res.getBody().get("id"));
    }

    /** Aufräumen per Superuser - die Testanlage darf die Demo-Flotte nicht verschieben. */
    private void deleteSite(UUID siteId) {
        try (Connection c = superuser(); Statement st = c.createStatement()) {
            st.execute("DELETE FROM device_charge_connector WHERE site_id = '" + siteId + "'");
            st.execute("DELETE FROM device_charge_point WHERE site_id = '" + siteId + "'");
            st.execute("DELETE FROM device_charging_budget WHERE site_id = '" + siteId + "'");
            st.execute("DELETE FROM site WHERE id = '" + siteId + "'");
        } catch (SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    private Connection superuser() throws SQLException {
        return java.sql.DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword());
    }

    private JsonNode getJson(String path, String token) throws Exception {
        ResponseEntity<String> res = rest.exchange(url(path), HttpMethod.GET,
                new HttpEntity<>(bearer(token)), String.class);
        assertThat(res.getStatusCode()).as("GET %s", path).isEqualTo(HttpStatus.OK);
        return json.readTree(res.getBody());
    }

    private String url(String path) {
        return "http://localhost:" + port + path;
    }

    private HttpHeaders bearer(String token) {
        HttpHeaders h = new HttpHeaders();
        h.setBearerAuth(token);
        return h;
    }

    private String token(String username, String password) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", "voltpilot-api");
        form.add("client_secret", "voltpilot-api-dev-secret");
        form.add("username", username);
        form.add("password", password);
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(org.springframework.http.MediaType.APPLICATION_FORM_URLENCODED);
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                HttpMethod.POST, new HttpEntity<>(form, headers),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (String) res.getBody().get("access_token");
    }
}
