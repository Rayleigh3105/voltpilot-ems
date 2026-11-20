package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doReturn;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.components.ComponentConnectionReceipts;
import com.voltpilot.api.components.SelfBuildComponentService;
import com.voltpilot.api.components.SelfBuildDefinition;
import com.voltpilot.api.components.SelfBuildFlowCompiler;
import com.voltpilot.api.flows.FlowCompilerHttp;
import com.voltpilot.api.ota.BoxArt;
import com.voltpilot.api.probe.ProbeResult;
import com.voltpilot.api.probe.ProbeService;
import com.voltpilot.api.repo.UpdateStatusRepository;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.TestRestTemplate;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureTestRestTemplate;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
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
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * Das eigene Modbus-Gerät mit Schreibwerten (Steuerlogik K3) gegen echtes
 * TimescaleDB + Keycloak: anlegen nur an einer Box mit {@code modbus_geraet},
 * vor der Freigabe ein Sensor ohne Node-RED-Flow, Test je Schreibwert,
 * Freigabe nur mit allen Tests UND bestätigter Wirkung, danach Fähigkeiten mit
 * Band, Schritt, Liste und Ruhewert; eine geänderte Zusage entwertet die
 * Freigabe; die alte Selbstbau-Tür ändert ein solches Gerät nicht. Die Box
 * selbst ist gefälscht (Fähigkeit und Probe-Antwort); was sie tut, belegt
 * {@code edge-app/core/internal/agent/modbusgeraet_test.go}.
 */
@Testcontainers(disabledWithoutDocker = true)
@AutoConfigureTestRestTemplate
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class ModbusGeraetApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String HOST = "192.168.1.70";

    @Container
    static final TestDatenbank POSTGRES = new TestDatenbank();

    @Container
    static final TestKeycloak KEYCLOAK =
            new TestKeycloak();

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

    @TestConfiguration
    static class Fakes {
        @Bean
        FlowCompilerHttp flowCompilerHttp() throws IOException {
            String artifact = Files.readString(Path.of("..", "..", "docs", "contracts", "v2", "examples",
                    "flow-artifact.valid.artifact.json"));
            return (uri, body) -> new FlowCompilerHttp.Response(200, artifact);
        }
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Autowired
    ComponentConnectionReceipts receipts;

    @MockitoSpyBean
    BoxFaehigkeiten faehigkeiten;

    @MockitoSpyBean
    ProbeService probes;

    @MockitoSpyBean
    UpdateStatusRepository updateStatus;

    private final ObjectMapper json = new ObjectMapper();

    /** Das Klimagerät der Vektoren, an der Adresse dieses Tests. */
    private ObjectNode klima() throws IOException {
        ObjectNode def = (ObjectNode) json.readTree(Path.of("..", "..", "docs", "contracts", "v2",
                "modbus-geraet-vectors.json").toFile()).path("geraete").path("klima").deepCopy();
        ((ObjectNode) def.path("transport")).put("host", HOST);
        ((ObjectNode) def.path("controls")).remove("freigabe");
        return def;
    }

    @Test
    void einKlimageraetWirdJeSchreibwertGetestetUndErstDannFreigegeben() throws Exception {
        String customer = token("demo", "demo");
        String stranger = token("demo2", "demo2");
        UUID site = createSiteWithDevice(customer, "Klima K3", "k3-klima-01");
        try {
            String base = "/api/v1/sites/" + site + "/components/custom";
            recordReceipt(site);

            // Eine Box, die solche Geräte nicht selbst liest und schreibt, bekommt keins.
            doReturn(false).when(faehigkeiten).kann(any(), eq("modbus_geraet"));
            ResponseEntity<String> alt = post(base + "/geraet", customer, Map.of("label", "Klima", "definition", klima()));
            assertThat(alt.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
            assertThat(message(alt)).contains("modbus_geraet");
            doReturn(true).when(faehigkeiten).kann(any(), eq("modbus_geraet"));

            // Eine Definition, die die Regeln verletzt: deutscher Grund, nichts angelegt.
            ObjectNode kaputt = klima();
            ((ObjectNode) kaputt.path("controls").path("values").get(1)).put("rest", 40);
            ResponseEntity<String> bad = post(base + "/geraet", customer, Map.of("label", "Klima", "definition", kaputt));
            assertThat(bad.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(message(bad)).contains("Ruhewert");

            // Anlegen: ein Sensor, der seine Schreibwerte kennt, aber nichts schreiben darf.
            ResponseEntity<String> neu = post(base + "/geraet", customer, Map.of("label", "Klima", "definition", klima()));
            assertThat(neu.getStatusCode()).as(neu.getBody()).isEqualTo(HttpStatus.OK);
            JsonNode zeile = componentNamed(neu.getBody(), "Klima");
            UUID entity = UUID.fromString(zeile.path("id").asText());
            assertThat(zeile.path("entityType").asText()).isEqualTo("modbus-generic");
            assertThat(caps(entity).has("actuate")).isFalse();
            assertThat(guards(entity).path("failsafe").path("behavior").asText()).isEqualTo("measure-only");
            JsonNode gespeichert = definition(entity);
            assertThat(gespeichert.path("controls").path("values")).hasSize(3);
            assertThat(gespeichert.path("controls").has("freigabe")).isFalse();
            assertThat(gespeichert.path("channels").get(0).path("signal").asText()).isEqualTo("room_temperature");
            // Kein Node-RED-Leseplan: die Box liest dieses Gerät selbst.
            assertThat(scalar("SELECT count(*) FROM flow_definition WHERE flow_id = '"
                    + SelfBuildFlowCompiler.generatedFlowId(entity) + "' AND lifecycle = 'active'")).isEqualTo("0");

            String path = base + "/" + entity + "/geraet";
            // Freigabe ohne Tests: abgelehnt.
            ResponseEntity<String> ohne = post(path + "/freigabe", customer, Map.of("physicallyConfirmed", true));
            assertThat(ohne.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_CONTENT);
            assertThat(message(ohne)).contains("jeden Schreibwert");

            // Ein Testwert außerhalb des Bands wird abgelehnt, nicht geklemmt; ein fremder Schreibwert ist 404.
            assertThat(post(path + "/test", customer, Map.of("slug", "soll", "wert", 35)).getStatusCode())
                    .isEqualTo(HttpStatus.UNPROCESSABLE_CONTENT);
            assertThat(post(path + "/test", customer, Map.of("slug", "luefter", "wert", true)).getStatusCode())
                    .isEqualTo(HttpStatus.NOT_FOUND);

            // Die Box bestätigt jeden Testwert (gefälscht); getestet wird jeder Schreibwert.
            doReturn(new ProbeResult("r", null, null, List.of(new ProbeResult.OpResult("x", true, null, null, null,
                    null, null, null, new ProbeResult.Switched(1, 30, null, null), null, null))))
                    .when(probes).switchOp(any(), any(), any(), any(), any());
            for (Object[] t : new Object[][] {{"ein", true}, {"soll", 21.5}}) {
                ResponseEntity<String> r = post(path + "/test", customer, Map.of("slug", t[0], "wert", t[1]));
                assertThat(json.readTree(r.getBody()).path("passed").asBoolean()).as(r.getBody()).isTrue();
            }
            // Zwei von drei reichen nicht.
            assertThat(post(path + "/freigabe", customer, Map.of("physicallyConfirmed", true)).getStatusCode())
                    .isEqualTo(HttpStatus.UNPROCESSABLE_CONTENT);
            post(path + "/test", customer, Map.of("slug", "betrieb", "wert", "heat"));
            // Alle getestet, aber die Wirkung nicht bestätigt: abgelehnt.
            ResponseEntity<String> unbestaetigt = post(path + "/freigabe", customer, Map.of("physicallyConfirmed", false));
            assertThat(message(unbestaetigt)).contains("Wirkung am Gerät");

            ResponseEntity<String> frei = post(path + "/freigabe", customer, Map.of("physicallyConfirmed", true));
            assertThat(frei.getStatusCode()).as(frei.getBody()).isEqualTo(HttpStatus.OK);
            assertThat(componentNamed(frei.getBody(), "Klima").path("entityType").asText()).isEqualTo("modbus-device");
            JsonNode actuate = caps(entity).path("actuate");
            assertThat(actuate).hasSize(3);
            assertThat(actuate.get(1).path("command").asText()).isEqualTo("setpoint_c");
            assertThat(actuate.get(1).path("min").asDouble()).isEqualTo(16);
            assertThat(actuate.get(1).path("step").asDouble()).isEqualTo(0.5);
            assertThat(actuate.get(1).path("rest").asDouble()).isEqualTo(24);
            assertThat(actuate.get(2).path("modes").toString()).isEqualTo("[\"cool\",\"heat\",\"fan_only\"]");
            JsonNode schutz = guards(entity);
            assertThat(schutz.path("failsafe").path("behavior").asText()).isEqualTo("rest");
            assertThat(schutz.path("limits").path("min_change_interval_s").asInt()).isEqualTo(120);
            assertThat(definition(entity).path("controls").path("freigabe").path("evidence").asText())
                    .contains("ein: Wert 1").contains("soll: Wert 215").contains("betrieb: Wert 2");

            // Dieselbe Definition noch einmal gespeichert: die Freigabe bleibt.
            assertThat(put(path, customer, Map.of("label", "Klima", "definition", klima())).getStatusCode())
                    .isEqualTo(HttpStatus.OK);
            assertThat(guards(entity).path("failsafe").path("behavior").asText()).isEqualTo("rest");
            // Ein anderes Band ist eine andere Zusage: die Freigabe entfällt.
            ObjectNode breiter = klima();
            ((ObjectNode) breiter.path("controls").path("values").get(1)).put("max", 32);
            assertThat(put(path, customer, Map.of("label", "Klima", "definition", breiter)).getStatusCode())
                    .isEqualTo(HttpStatus.OK);
            assertThat(caps(entity).has("actuate")).isFalse();
            assertThat(definition(entity).path("controls").has("freigabe")).isFalse();

            // Die alte Selbstbau-Tür ändert dieses Gerät nicht (sie verlöre Schreibwerte und Signale).
            ResponseEntity<String> tuer = put(base + "/" + entity, customer, Map.of("label", "Klima",
                    "connection", Map.of("host", HOST, "port", 502, "unitId", 1), "channels", List.of()));
            assertThat(tuer.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

            // Rücknahme und Spur.
            assertThat(delete(path + "/freigabe", customer).getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(auditTypes(site, entity)).contains("switch_tested", "switch_released", "switch_revoked");

            // RLS: ein fremder Mandant erreicht nichts.
            assertThat(post(path + "/freigabe", stranger, Map.of("physicallyConfirmed", true)).getStatusCode())
                    .isEqualTo(HttpStatus.NOT_FOUND);
            assertThat(post(path + "/test", stranger, Map.of("slug", "soll", "wert", 20)).getStatusCode())
                    .isEqualTo(HttpStatus.NOT_FOUND);
        } finally {
            deleteSite(site);
        }
    }

    /**
     * E8 (Pi-Ablösung-Konzept): ein reines Selbstbau-Messgerät ohne jeden
     * Schreibwert nimmt dieser Weg nur für eine Anlage an, deren führende Box
     * Edge Light ist - denn nur dort gibt es sonst keinen Lese-Weg (kein
     * Node-RED für den Flow der Selbstbau-Tür). Für jede andere Box-Art (und
     * eine, deren Art noch unbekannt ist) bleibt die alte Ablehnung.
     */
    @Test
    void einMessgeraetOhneSchreibwerteNimmtNurEineEdgeLightAn() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSiteWithDevice(customer, "Messgerät E8", "k3-messgeraet-01");
        try {
            String base = "/api/v1/sites/" + site + "/components/custom";
            recordReceipt(site);
            doReturn(true).when(faehigkeiten).kann(any(), eq("modbus_geraet"));

            ObjectNode ohneControls = klima();
            ohneControls.remove("controls");

            // Die Box-Art ist hier (noch) unbekannt: wie eine Docker-Box bleibt es bei der alten Ablehnung.
            ResponseEntity<String> unbekannt = post(base + "/geraet", customer,
                    Map.of("label", "Messgerät", "definition", ohneControls));
            assertThat(unbekannt.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(message(unbekannt)).contains("Eigenes Gerät");

            // Edge Light liest ein solches Gerät selbst - hier wird es angenommen.
            doReturn(BoxArt.LIGHT).when(updateStatus).boxArt(any());
            ResponseEntity<String> neu = post(base + "/geraet", customer,
                    Map.of("label", "Messgerät", "definition", ohneControls));
            assertThat(neu.getStatusCode()).as(neu.getBody()).isEqualTo(HttpStatus.OK);
            JsonNode zeile = componentNamed(neu.getBody(), "Messgerät");
            UUID entity = UUID.fromString(zeile.path("id").asText());
            assertThat(zeile.path("entityType").asText()).isEqualTo("modbus-generic");
            assertThat(caps(entity).has("actuate")).isFalse();
            assertThat(guards(entity).path("failsafe").path("behavior").asText()).isEqualTo("measure-only");
            // Normalisiert: ein (leerer) controls-Block bleibt, damit die alte
            // Selbstbau-Tür dieses Gerät nicht für ein eigenes hält (siehe unten).
            assertThat(definition(entity).path("controls").path("values")).isEmpty();
            assertThat(definition(entity).path("channels").get(0).path("signal").asText())
                    .isEqualTo("room_temperature");
            // Kein Node-RED-Leseplan: Edge Light braucht keinen, sie liest das Gerät selbst.
            assertThat(scalar("SELECT count(*) FROM flow_definition WHERE flow_id = '"
                    + SelfBuildFlowCompiler.generatedFlowId(entity) + "' AND lifecycle = 'active'")).isEqualTo("0");

            // Test und Freigabe sind für ein Gerät ohne Schreibwerte sinnlos.
            assertThat(post(base + "/" + entity + "/geraet/test", customer, Map.of("slug", "x", "wert", true))
                    .getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
            assertThat(post(base + "/" + entity + "/geraet/freigabe", customer, Map.of("physicallyConfirmed", true))
                    .getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

            // Die alte Selbstbau-Tür ändert dieses Gerät trotzdem nicht - sie kennt seine
            // Signale nicht und würde sie beim Speichern verwerfen (cross-door E8-Lücke).
            ResponseEntity<String> tuer = put(base + "/" + entity, customer, Map.of("label", "Messgerät",
                    "connection", Map.of("host", HOST, "port", 502, "unitId", 1), "channels", List.of()));
            assertThat(tuer.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        } finally {
            deleteSite(site);
        }
    }

    // -- Hilfen -------------------------------------------------------------

    private void recordReceipt(UUID site) {
        receipts.record(site, SelfBuildComponentService.RECEIPT_REF,
                SelfBuildComponentService.receiptFields(new SelfBuildDefinition.Transport(HOST, 502, 1)));
    }

    private JsonNode caps(UUID entity) throws Exception {
        return json.readTree(scalar("SELECT capabilities FROM measurement_point WHERE id = '" + entity + "'"));
    }

    private JsonNode guards(UUID entity) throws Exception {
        return json.readTree(scalar("SELECT guard_config FROM measurement_point WHERE id = '" + entity + "'"));
    }

    private JsonNode definition(UUID entity) throws Exception {
        return json.readTree(scalar("SELECT connection_json FROM measurement_point WHERE id = '" + entity + "'"));
    }

    private String message(ResponseEntity<String> res) throws Exception {
        return json.readTree(res.getBody()).path("message").asText();
    }

    private JsonNode componentNamed(String body, String label) throws Exception {
        for (JsonNode row : json.readTree(body).path("components")) {
            if (label.equals(row.path("label").asText())) {
                return row;
            }
        }
        throw new AssertionError("keine Komponente namens " + label + " in " + body);
    }

    private List<String> auditTypes(UUID siteId, UUID entityId) {
        List<String> out = new ArrayList<>();
        try (Connection c = superuser(); Statement st = c.createStatement();
                ResultSet rs = st.executeQuery("SELECT event_type FROM consumer_audit_event WHERE site_id = '"
                        + siteId + "' AND entity_id = '" + entityId + "' ORDER BY id")) {
            while (rs.next()) {
                out.add(rs.getString(1));
            }
        } catch (SQLException e) {
            throw new IllegalStateException(e);
        }
        return out;
    }

    private String scalar(String sql) {
        try (Connection c = superuser(); Statement st = c.createStatement(); ResultSet rs = st.executeQuery(sql)) {
            return rs.next() ? rs.getString(1) : null;
        } catch (SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    private UUID createSiteWithDevice(String customerToken, String name, String ref) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", name), bearer(customerToken)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        UUID site = UUID.fromString((String) res.getBody().get("id"));
        ResponseEntity<String> claim = post("/api/v1/devices/claim", customerToken,
                Map.of("externalRef", TestKennung.box(ref), "siteId", site.toString(), "kind", "inverter"));
        assertThat(claim.getStatusCode()).isIn(HttpStatus.OK, HttpStatus.CREATED);
        return site;
    }

    private void deleteSite(UUID siteId) {
        try (Connection c = superuser(); Statement st = c.createStatement()) {
            st.execute("DELETE FROM site WHERE id = '" + siteId + "'");
        } catch (SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    private Connection superuser() throws SQLException {
        return java.sql.DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword());
    }

    private ResponseEntity<String> post(String path, String token, Object body) {
        return rest.exchange(url(path), HttpMethod.POST, new HttpEntity<>(body, bearer(token)), String.class);
    }

    private ResponseEntity<String> put(String path, String token, Object body) {
        return rest.exchange(url(path), HttpMethod.PUT, new HttpEntity<>(body, bearer(token)), String.class);
    }

    private ResponseEntity<String> delete(String path, String token) {
        return rest.exchange(url(path), HttpMethod.DELETE, new HttpEntity<>(bearer(token)), String.class);
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

    private String token(String user, String password) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", "voltpilot-frontend");
        form.add("username", user);
        form.add("password", password);
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token", HttpMethod.POST,
                new HttpEntity<>(form, headers), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (String) res.getBody().get("access_token");
    }
}
