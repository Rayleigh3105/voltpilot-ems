package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.components.ComponentAdoption;
import com.voltpilot.api.components.ComponentAdoptionRunner;
import com.voltpilot.api.components.ComponentAdoptionService;
import com.voltpilot.api.components.ComponentApplyRepository;
import com.voltpilot.api.components.ComponentAuthority;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.entities.EntityStatusListener;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.Map;
import java.util.UUID;
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
 * Einheitsmodell Stufe 2 „Bestands-Übernahme" gegen echtes TimescaleDB +
 * Keycloak - die REISE, nicht die Regel (die liegt rein in
 * {@code ComponentAdoptionTest}).
 *
 * <p>Gefahren wird der echte Weg: ein Herzschlag geht durch den ECHTEN
 * {@link EntityStatusListener}, die Übernahme läuft über den getakteten Lauf,
 * und geprüft werden die BYTES des Pushes, der danach hinausgeht.
 *
 * <ol>
 *   <li><b>Vollständiges Ist → Übernahme.</b> Autorität dreht auf portal, jede
 *       gemeldete Komponente hat ihre Anbindung als Fassung 1, und der Push
 *       trägt Verbindung + Kadenz + kWp + MaStR-Referenz - also alles, was die
 *       Box braucht, um zeichengleich dasselbe abzuleiten.</li>
 *   <li><b>Unvollständiges Ist bleibt box.</b> Ein Bericht ohne
 *       Verbindungsfelder (der ältere Box-Stand) übernimmt NICHTS und sagt
 *       warum.</li>
 *   <li><b>Der Rückweg.</b> Ein Admin dreht zurück; der Push trägt danach keine
 *       Autorität mehr, die Definitionen bleiben stehen.</li>
 *   <li><b>Alles oder nichts.</b> Ein halb gemeldetes Ist lässt die Anlage
 *       vollständig unverändert.</li>
 * </ol>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
@org.springframework.context.annotation.Import(ComponentAdoptionApiTest.RecordingPublisherConfig.class)
class ComponentAdoptionApiTest {

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
    ComponentAdoptionService adoption;

    @Autowired
    ComponentAdoptionRunner runner;

    @Autowired
    EntityRegistryService entityRegistry;

    @Autowired
    EntityRegistryRepository entityRepo;

    @Autowired
    com.voltpilot.api.entities.EntityObservedRepository observed;

    @Autowired
    ComponentApplyRepository applyRepo;

    @Autowired
    DeviceRepository devices;

    private final ObjectMapper json = new ObjectMapper();

    /** Zeichnet die Push-BYTES auf (das {@code ComponentApiTest}-Muster). */
    @org.springframework.boot.test.context.TestConfiguration
    static class RecordingPublisherConfig {
        static final List<byte[]> PUSHES = new java.util.concurrent.CopyOnWriteArrayList<>();

        @org.springframework.context.annotation.Bean
        com.voltpilot.api.entities.EntityRegistryPublisher entityRegistryPublisher() {
            var pub = org.mockito.Mockito.mock(
                    com.voltpilot.api.entities.EntityRegistryPublisher.class);
            org.mockito.Mockito.when(pub.publishRegistry(org.mockito.Mockito.any(),
                    org.mockito.Mockito.any(), org.mockito.Mockito.any(),
                    org.mockito.Mockito.any())).thenAnswer(inv -> {
                        PUSHES.add(inv.getArgument(3));
                        return true;
                    });
            return pub;
        }
    }

    // ---- Die Reise ---------------------------------------------------------

    @Test
    void aCompleteReportIsAdoptedAndThePushCarriesEveryFieldTheBoxNeeds() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Übernahme-Anlage");
        try {
            UUID device = claim(customer, site, "edge-uebernahme-1");
            saveBattery(customer, site);
            // Der Bestandsfall: die Migration setzt jede beim Deploy existierende
            // Anlage auf box. Eine im Test frisch angelegte ist portal, also wird
            // sie hier auf den Bestandszustand gesetzt.
            setAuthority(site, ComponentAuthority.BOX);

            // 1 · Die Box meldet ihren Einrichtungs-Stand - durch den ECHTEN
            //     Zuhörer, also mit genau der Form, die auf dem Draht liegt.
            heartbeat(site, device, fullReport());

            // 2 · Der getaktete Abgleich übernimmt sie. Kein Klick.
            ComponentAdoptionRunner.RunSummary summary = runner.run();
            assertThat(summary.adopted()).as("die Anlage wurde übernommen").isGreaterThanOrEqualTo(1);

            // 3 · Die Autorität ist gedreht - und der Beleg steht.
            JsonNode list = getJson("/api/v1/sites/" + site + "/components", customer);
            assertThat(list.get("componentAuthority").asText())
                    .isEqualTo(ComponentAuthority.PORTAL);
            assertThat(list.hasNonNull("adoptedAt"))
                    .as("die Übernahme hinterlässt ihren Beleg").isTrue();

            // 4 · Jede gemeldete Komponente hat ihre Anbindung - der
            //     Wechselrichter füllt die komponierte battery-hybrid-Zeile,
            //     die Erzeuger sind an ihre Quellen-Kennung gepinnt.
            // Die Anbindung landet in der von der Plattform KOMPONIERTEN Zeile
            // (Rolle im v1-Vokabular `battery-hybrid`), nicht in einer zweiten -
            // die Topologie summiert je Rolle, zwei Zeilen wären Doppelzählung.
            JsonNode inverter = byRole(list, "battery-hybrid");
            assertThat(inverter.get("communication").asText()).isEqualTo("solarman_v5");
            assertThat(inverter.get("connection").get("serial").asText())
                    .isEqualTo("2985159064");
            assertThat(inverter.get("templateRef").asText())
                    .as("die Herkunft wird GESUCHT, nie zusammengebaut")
                    .isEqualTo("builtin:deye:sun-30k-sg01hp3");

            List<JsonNode> erzeuger = allByRole(list, "pv-generation");
            assertThat(erzeuger).as("beide Fronius hinter EINER IP").hasSize(2);
            assertThat(erzeuger.stream().map(e -> e.get("edgeSourceId").asText()))
                    .containsExactlyInAnyOrder("src-fronius-1", "src-fronius-2");

            // 5 · DIE Prüfung: der Push trägt ALLES, was die Box braucht, um
            //     zeichengleich dasselbe abzuleiten. Fehlte eines davon, wäre
            //     die Übernahme eine stille Verschlechterung.
            JsonNode push = pushJson(site);
            assertThat(push.get("component_authority").asText())
                    .isEqualTo(ComponentAuthority.PORTAL);
            JsonNode driver = driverOfSource(push, list, "src-fronius-1");
            assertThat(driver.get("communication").asText()).isEqualTo("fronius_sunspec");
            assertThat(driver.get("connection").get("unit_id").asInt()).isEqualTo(1);
            assertThat(driver.get("capacity_kwp").asDouble())
                    .as("die Nennleistung weitet die physikalische Hülle der Box")
                    .isEqualTo(27.0);
            assertThat(driver.get("interval_s").asInt())
                    .as("die gepflegte Lese-Kadenz, nicht die Vorgabe der Box")
                    .isEqualTo(30);
            assertThat(driver.get("registry_unit_id").asText()).isEqualTo("SEE966831669441");

            // 6 · Und die Übernahme ist idempotent: ein zweiter Lauf sieht die
            //     Anlage bereits portal-verwaltet und fasst nichts an.
            int versionVorher = byRole(getJson("/api/v1/sites/" + site + "/components", customer),
                    "battery-hybrid").get("definitionVersion").asInt();
            runner.run();
            assertThat(byRole(getJson("/api/v1/sites/" + site + "/components", customer),
                    "battery-hybrid").get("definitionVersion").asInt())
                    .as("ein zweiter Lauf schreibt keine weitere Fassung")
                    .isEqualTo(versionVorher);
        } finally {
            deleteSite(site);
        }
    }

    @Test
    void anOlderBoxStaysBoxManagedAndSaysWhy() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Alte-Box-Anlage");
        try {
            UUID device = claim(customer, site, "edge-uebernahme-2");
            saveBattery(customer, site);
            setAuthority(site, ComponentAuthority.BOX);

            // Genau die Form eines Stands VOR dieser Stufe: Marke und Modell,
            // aber keine Verbindungsfelder.
            heartbeat(site, device, """
                    [{"id":"inverter","kind":"inverter","brand":"deye",
                      "model":"sun-30k-sg01hp3","label":"Deye"}]""");

            ComponentAdoptionService.Outcome outcome = adoptAsTenant(site);
            assertThat(outcome.adopted()).isFalse();
            assertThat(outcome.verdict())
                    .isEqualTo(ComponentAdoption.Verdict.INCOMPLETE_REPORT);
            assertThat(outcome.reason())
                    .as("der Satz nennt den Weg, nicht nur die Ablehnung")
                    .contains("aktualisiert");

            // Und die Anlage ist unverändert box-verwaltet - ihr Push trägt das
            // Autoritäts-Feld GAR NICHT, ist auf dem Draht also identisch mit
            // dem eines älteren Cloud-Stands.
            assertThat(getJson("/api/v1/sites/" + site + "/components", customer)
                    .get("componentAuthority").asText()).isEqualTo(ComponentAuthority.BOX);
            assertThat(pushJson(site).has("component_authority")).isFalse();
        } finally {
            deleteSite(site);
        }
    }

    @Test
    void oneIncompleteEntryLeavesTheWholePlantUntouched() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Halb-gemeldete-Anlage");
        try {
            UUID device = claim(customer, site, "edge-uebernahme-3");
            saveBattery(customer, site);
            setAuthority(site, ComponentAuthority.BOX);

            // Wechselrichter vollständig, ein Erzeuger ohne Verbindung.
            heartbeat(site, device, """
                    [{"id":"inverter","kind":"inverter","brand":"deye",
                      "model":"sun-30k-sg01hp3","label":"Deye","family":"hybrid_3p",
                      "communication":"solarman_v5",
                      "connection":{"ip":"192.168.0.28","port":8899,"serial":"2985159064",
                                    "mb_slave_id":1}},
                     {"id":"src-fronius-1","kind":"source","role":"pv-generation",
                      "brand":"fronius_sunspec","model":"fronius-eco-27-3-s",
                      "label":"Fronius 1"}]""");

            assertThat(adoptAsTenant(site).adopted()).isFalse();

            // ALLES ODER NICHTS: auch der vollständig gemeldete Wechselrichter
            // bekommt keine Anbindung. Ein halbes Soll würde dem Applier die
            // Quellenliste kürzen - also ein laufendes Messgerät ENTFERNEN.
            JsonNode list = getJson("/api/v1/sites/" + site + "/components", customer);
            assertThat(list.get("componentAuthority").asText()).isEqualTo(ComponentAuthority.BOX);
            for (JsonNode row : list.get("components")) {
                assertThat(row.has("connection"))
                        .as("keine Komponente darf halb übernommen worden sein")
                        .isFalse();
            }
        } finally {
            deleteSite(site);
        }
    }

    @Test
    void anAdminCanRevertAnAdoptionAndTheDefinitionsSurvive() throws Exception {
        String customer = token("demo", "demo");
        String admin = token("admin", "admin");
        UUID site = createSite(customer, "Rückweg-Anlage");
        try {
            UUID device = claim(customer, site, "edge-uebernahme-4");
            saveBattery(customer, site);
            setAuthority(site, ComponentAuthority.BOX);
            heartbeat(site, device, fullReport());
            assertThat(adoptAsTenant(site).adopted()).isTrue();

            // Der Rückweg - über die Admin-Route, mit dem Mandanten-Umschalter.
            ResponseEntity<String> reverted = rest.exchange(
                    url("/api/v1/admin/sites/" + site + "/v2-entities/revert-to-device"),
                    HttpMethod.POST, new HttpEntity<>(null, adminHeaders(admin)), String.class);
            assertThat(reverted.getStatusCode()).isEqualTo(HttpStatus.OK);

            JsonNode list = getJson("/api/v1/sites/" + site + "/components", customer);
            assertThat(list.get("componentAuthority").asText())
                    .as("die Anlage wird wieder am Gerät verwaltet")
                    .isEqualTo(ComponentAuthority.BOX);
            assertThat(list.hasNonNull("adoptedAt"))
                    .as("der Beleg wird gelöscht, damit der Takt die Anlage wieder betrachtet")
                    .isFalse();

            // Die Definitionen bleiben stehen - sie sind der Beleg, WAS
            // übernommen wurde, und der Weg zurück nach vorn.
            assertThat(byRole(list, "battery-hybrid").get("connection").get("serial").asText())
                    .isEqualTo("2985159064");

            // Und der Push trägt das Autoritäts-Feld nicht mehr: der Applier auf
            // der Box wendet damit strukturell nichts mehr an.
            assertThat(pushJson(site).has("component_authority")).isFalse();

            // Ein Kunde kommt an den Rückweg nicht heran.
            assertThat(rest.exchange(
                    url("/api/v1/admin/sites/" + site + "/v2-entities/revert-to-device"),
                    HttpMethod.POST, new HttpEntity<>(null, bearer(customer)), String.class)
                    .getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        } finally {
            deleteSite(site);
        }
    }

    /**
     * Ohne Speicher-Stammsatz gibt es keine komponierte {@code battery-hybrid}-
     * Zeile, in die die Anbindung des Wechselrichters gehört.
     *
     * <p>Die Übernahme ERFINDET dann keine - sie lehnt ab und nennt den Weg,
     * wörtlich wie der Anlege-Weg der Stufe 1. Eine selbst gebaute Zeile wäre
     * eine zweite Wahrheit neben der, die der Rest des Systems aus dem
     * Speicher-Asset komponiert (und die Steuer-Zeile der Anlage ist).
     */
    @Test
    void aPlantWithoutBatteryMasterDataIsRefusedInsteadOfInventingARow() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Anlage-ohne-Speicher");
        try {
            UUID device = claim(customer, site, "edge-uebernahme-5");
            // ABSICHTLICH KEIN saveBattery.
            setAuthority(site, ComponentAuthority.BOX);
            heartbeat(site, device, fullReport());

            ComponentAdoptionRunner.RunSummary summary = runner.run();
            assertThat(summary.failed())
                    .as("ein fehlender Stammsatz ist ein WARTEN, kein Fehlschlag")
                    .isZero();

            JsonNode list = getJson("/api/v1/sites/" + site + "/components", customer);
            assertThat(list.get("componentAuthority").asText()).isEqualTo(ComponentAuthority.BOX);
            for (JsonNode row : list.get("components")) {
                assertThat(row.path("role").asText())
                        .as("es wurde keine Wechselrichter-Zeile erfunden")
                        .isNotEqualTo("inverter");
                assertThat(row.has("connection"))
                        .as("alles oder nichts - auch die Erzeuger bleiben unberührt")
                        .isFalse();
            }
        } finally {
            deleteSite(site);
        }
    }

    // ---- Fixture + Helfer --------------------------------------------------

    /**
     * Der Pilsting-artige Bericht: ein Deye als führender Wechselrichter, ZWEI
     * Fronius hinter EINER IP (Unit 1 und 2), Netzmessung über den CT des Deye
     * (also KEIN eigener Netz-Zähler).
     */
    private static String fullReport() {
        return """
                [{"id":"inverter","kind":"inverter","brand":"deye","model":"sun-30k-sg01hp3",
                  "label":"Deye SUN-30K","family":"hybrid_3p","communication":"solarman_v5",
                  "connection":{"ip":"192.168.0.28","port":8899,"serial":"2985159064",
                                "mb_slave_id":1,"power_scale":10,"invert_batt_sign":true}},
                 {"id":"src-fronius-1","kind":"source","role":"pv-generation",
                  "brand":"fronius_sunspec","model":"fronius-eco-27-3-s","label":"Fronius 1",
                  "family":"sunspec_live","communication":"fronius_sunspec",
                  "connection":{"ip":"192.168.210.40","port":502,"unit_id":1},
                  "interval_s":30,"capacity_kwp":27,"registry_unit_id":"SEE966831669441"},
                 {"id":"src-fronius-2","kind":"source","role":"pv-generation",
                  "brand":"fronius_sunspec","model":"fronius-eco-27-3-s","label":"Fronius 2",
                  "family":"sunspec_live","communication":"fronius_sunspec",
                  "connection":{"ip":"192.168.210.40","port":502,"unit_id":2},
                  "interval_s":30,"capacity_kwp":27,"registry_unit_id":"SEE966831669442"}]""";
    }

    /**
     * Schickt einen Herzschlag durch den ECHTEN Zuhörer - also über genau die
     * Form, die auf dem Draht liegt, nicht über einen Test-Nachbau des Ingests.
     */
    private void heartbeat(UUID site, UUID device, String localSetup) {
        EntityStatusListener listener = new EntityStatusListener("tcp://unused", "", "",
                devices, observed, applyRepo);
        String payload = """
                {"schema_version":"1.0","tenant_id":"%s","site_id":"%s","device_id":"%s",
                 "entities":{"revision":"r-ist","count":0,"ids":[],"local_setup":%s}}"""
                .formatted(TENANT_A, site, device, localSetup);
        listener.handle("ems/%s/%s/%s/status".formatted(TENANT_A, site, device),
                payload.getBytes(StandardCharsets.UTF_8));
    }

    private ComponentAdoptionService.Outcome adoptAsTenant(UUID site) {
        TenantContext.set(UUID.fromString(TENANT_A));
        try {
            return adoption.adoptIfComplete(site);
        } finally {
            TenantContext.clear();
        }
    }

    /** Der Bestandszustand: die Migration setzt jede existierende Anlage auf box. */
    private void setAuthority(UUID site, String authority) {
        try (Connection c = superuser(); Statement st = c.createStatement()) {
            st.execute("UPDATE site SET component_authority = '" + authority
                    + "' WHERE id = '" + site + "'");
        } catch (SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    private JsonNode pushJson(UUID siteId) throws Exception {
        RecordingPublisherConfig.PUSHES.clear();
        TenantContext.set(UUID.fromString(TENANT_A));
        try {
            entityRegistry.pushRegistryBestEffort(siteId);
        } finally {
            TenantContext.clear();
        }
        assertThat(RecordingPublisherConfig.PUSHES).isNotEmpty();
        return json.readTree(
                RecordingPublisherConfig.PUSHES.get(RecordingPublisherConfig.PUSHES.size() - 1));
    }

    /** Der Treiberblock der Komponente, die an DIESE Quellen-Kennung gepinnt ist. */
    private static JsonNode driverOfSource(JsonNode push, JsonNode list, String edgeSourceId) {
        String entityId = null;
        for (JsonNode row : list.get("components")) {
            if (edgeSourceId.equals(row.path("edgeSourceId").asText(null))) {
                entityId = row.get("id").asText();
            }
        }
        assertThat(entityId).as("Komponente zur Quelle %s", edgeSourceId).isNotNull();
        for (JsonNode e : push.get("entities")) {
            if (entityId.equals(e.path("entity_id").asText())) {
                return e.get("driver");
            }
        }
        throw new AssertionError("keine Push-Entität für " + edgeSourceId);
    }

    private static JsonNode byRole(JsonNode list, String role) {
        List<JsonNode> hits = allByRole(list, role);
        assertThat(hits).as("Komponente mit Rolle %s", role).isNotEmpty();
        return hits.get(0);
    }

    private static List<JsonNode> allByRole(JsonNode list, String role) {
        List<JsonNode> out = new java.util.ArrayList<>();
        for (JsonNode row : list.get("components")) {
            if (role.equals(row.path("role").asText())) {
                out.add(row);
            }
        }
        return out;
    }

    /**
     * Die Eckdaten des Speichers - wie sie eine echte Batterie-Anlage hat.
     *
     * <p>Sie sind hier PFLICHT, nicht Beiwerk: aus dem Speicher-Stammsatz
     * komponiert die Plattform die {@code battery-hybrid}-Zeile, in die die
     * Übernahme die Anbindung des Wechselrichters schreibt. Ohne sie lehnt die
     * Übernahme ab - genau wie der Anlege-Weg der Stufe 1 (siehe
     * {@code aPlantWithoutBatteryMasterDataIsRefusedInsteadOfInventingARow}).
     * Der Aufruf löst zugleich die Auto-Komposition aus (#385).
     */
    private void saveBattery(String customerToken, UUID siteId) {
        ResponseEntity<String> res = rest.exchange(url("/api/v1/sites/" + siteId + "/battery"),
                HttpMethod.PUT,
                new HttpEntity<>(Map.of("capacityKwh", 30, "maxChargeKw", 15,
                        "maxDischargeKw", 15), bearer(customerToken)), String.class);
        assertThat(res.getStatusCode()).as("Speicher speichern").isEqualTo(HttpStatus.OK);
    }

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

    /** Aufräumen per Superuser - die Testanlagen dürfen die Demo-Flotte nicht verschieben. */
    private void deleteSite(UUID siteId) {
        try (Connection c = superuser(); Statement st = c.createStatement()) {
            st.execute("DELETE FROM site WHERE id = '" + siteId + "'");
        } catch (SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    private Connection superuser() throws SQLException {
        return java.sql.DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword());
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

    /** Ein Admin erreicht eine Kunden-Anlage über den Mandanten-Umschalter. */
    private HttpHeaders adminHeaders(String token) {
        HttpHeaders h = bearer(token);
        h.set("X-Tenant-Id", TENANT_A);
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
