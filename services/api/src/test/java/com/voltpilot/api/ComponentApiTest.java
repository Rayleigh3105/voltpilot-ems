package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.components.ComponentApplyRepository;
import com.voltpilot.api.components.ComponentAuthority;
import com.voltpilot.api.components.ComponentConnectionReceipts;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.tenant.TenantContext;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.util.HashMap;
import java.util.LinkedHashMap;
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
 * Einheitsmodell Stufe 1 „Ein Anlege-Weg im Portal" gegen echtes TimescaleDB +
 * Keycloak.
 *
 * <p>Was hier bewiesen wird:
 * <ol>
 *   <li><b>Der Bestand bleibt unangetastet.</b> Die Demo-Anlagen sind
 *       box-verwaltet, ihr Push trägt KEINE Autorität, und die Schreibwege
 *       lehnen dort ehrlich ab - genau die Betriebs-Auflage dieses PRs.</li>
 *   <li><b>Eine NEUE Anlage ist portal-verwaltet</b> und ihr Push sagt es.</li>
 *   <li><b>Verbindungstest-PFLICHT:</b> ohne Beleg kein Speichern (422), und
 *       ein Beleg gilt nur für GENAU diese Anlage + Vorlage + Verbindung.</li>
 *   <li><b>Fassungen + Rollback:</b> jede Änderung ist eine neue Fassung, der
 *       Rollback SCHREIBT die alte zurück und löscht keine Historie.</li>
 *   <li><b>0-1 Netz-Zähler serverseitig</b> - bis hierher prüfte das nur das
 *       Frontend der Box.</li>
 *   <li><b>RLS:</b> eine fremde Anlage ist 404, bevor irgendetwas geschrieben
 *       wird.</li>
 * </ol>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
@org.springframework.context.annotation.Import(ComponentApiTest.RecordingPublisherConfig.class)
class ComponentApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";
    private static final String DEYE = "builtin:deye:sun-30k-sg01hp3";
    private static final String FRONIUS = "builtin:fronius_sunspec:fronius-eco-27-3-s";
    private static final String GENERIC = "builtin:generic_modbus:sunspec";

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
    ComponentConnectionReceipts receipts;

    @Autowired
    ComponentApplyRepository applyRepo;

    @Autowired
    EntityRegistryService entityRegistry;

    @Autowired
    EntityRegistryRepository entityRepo;

    private final ObjectMapper json = new ObjectMapper();

    /**
     * Zeichnet jeden Registry-Push auf, damit der Test die BYTES prüfen kann,
     * die wirklich auf den Draht gingen (das {@code ConsumerApiTest}-Muster).
     * Ohne diese Bohne ist der Provider leer und die Nutzlast wird ungeprüft
     * verworfen.
     */
    @org.springframework.boot.test.context.TestConfiguration
    static class RecordingPublisherConfig {
        static final java.util.List<byte[]> PUSHES =
                new java.util.concurrent.CopyOnWriteArrayList<>();

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

    private static Map<String, Object> deyeConnection() {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("ip", "192.168.0.28");
        c.put("port", 8899);
        c.put("serial", "2985159064");
        c.put("mb_slave_id", 1);
        return c;
    }

    /**
     * Die BETRIEBS-AUFLAGE: eine heute laufende Anlage ändert ihr Verhalten
     * durch diesen PR nicht.
     */
    @Test
    void anExistingPlantStaysBoxManagedAndItsPushCarriesNoAuthority() throws Exception {
        String customer = token("demo", "demo");
        UUID berlin = UUID.fromString(BERLIN_SITE);

        JsonNode list = getJson("/api/v1/sites/" + BERLIN_SITE + "/components", customer);
        assertThat(list.get("componentAuthority").asText())
                .as("die Migration setzt jede beim Deploy existierende Anlage auf box")
                .isEqualTo(ComponentAuthority.BOX);

        // Und der Schreibweg lehnt dort mit dem ehrlichen Grund ab, statt ein
        // Soll zu speichern, das die Box nie anwenden würde.
        receipts.record(berlin, DEYE, deyeConnection());
        ResponseEntity<String> refused = post("/api/v1/sites/" + BERLIN_SITE + "/components",
                customer, saveBody(DEYE, "inverter", deyeConnection()));
        assertThat(refused.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(refused.getBody()).contains("direkt am Gerät");

        // Der Push der box-verwalteten Anlage trägt das Feld GAR NICHT - ein
        // älterer Cloud-Stand und diese Anlage sind auf dem Draht identisch.
        assertThat(pushJson(berlin).has("component_authority"))
                .as("abwesend heißt box; ein gesetztes Feld wäre eine Übernahme")
                .isFalse();
    }

    /**
     * Der ganze Weg auf einer NEUEN Anlage: portal-verwaltet, Verbindungstest,
     * Anlegen, Fassungen, Rollback - und der Push trägt die Autorität.
     */
    @Test
    void aNewPlantIsPortalManagedAndTheAssistantWritesVersionedDefinitions() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Stufe-1-Anlage");
        try {
            // Ohne beanspruchtes Gerät gibt es kein Gateway - und damit keinen
            // Push. Genau so entsteht eine Anlage auch beim Kunden.
            claim(customer, site, "edge-stufe1-01");

            JsonNode before = getJson("/api/v1/sites/" + site + "/components", customer);
            assertThat(before.get("componentAuthority").asText())
                    .as("eine NEUE Anlage bekommt den Spalten-Default")
                    .isEqualTo(ComponentAuthority.PORTAL);

            // --- Verbindungstest-PFLICHT ---------------------------------
            Map<String, Object> conn = deyeConnection();
            ResponseEntity<String> blind = post("/api/v1/sites/" + site + "/components",
                    customer, saveBody(FRONIUS, "pv-generation", conn));
            assertThat(blind.getStatusCode())
                    .as("ohne Beleg wird kein Blind-Soll gespeichert")
                    .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
            assertThat(blind.getBody()).contains("Verbindung");

            // Ein Beleg für eine ANDERE Verbindung zählt nicht.
            Map<String, Object> andere = new LinkedHashMap<>(conn);
            andere.put("ip", "192.168.0.99");
            receipts.record(site, FRONIUS, andere);
            assertThat(post("/api/v1/sites/" + site + "/components", customer,
                    saveBody(FRONIUS, "pv-generation", conn)).getStatusCode())
                    .as("der Beleg hängt an GENAU dieser Verbindung")
                    .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

            // --- Anlegen --------------------------------------------------
            receipts.record(site, FRONIUS, conn);
            ResponseEntity<String> created = post("/api/v1/sites/" + site + "/components",
                    customer, saveBody(FRONIUS, "pv-generation", conn));
            assertThat(created.getStatusCode()).isEqualTo(HttpStatus.OK);

            JsonNode after = json.readTree(created.getBody());
            JsonNode erzeuger = byRole(after, "pv-generation");
            assertThat(erzeuger.get("brand").asText())
                    .as("Marke/Modell kommen aus der VORLAGE, nie aus dem Rumpf")
                    .isEqualTo("fronius_sunspec");
            assertThat(erzeuger.get("communication").asText()).isEqualTo("fronius_sunspec");
            assertThat(erzeuger.get("templateRef").asText()).isEqualTo(FRONIUS);
            assertThat(erzeuger.get("sourceKind").asText()).isEqualTo("builtin");
            assertThat(erzeuger.get("definitionVersion").asInt()).isEqualTo(2);
            assertThat(erzeuger.get("connection").get("ip").asText()).isEqualTo("192.168.0.28");
            assertThat(erzeuger.get("syncStatus").asText())
                    .as("die Box hat sich nicht geäußert: unbekannt, nie „nicht angekommen\"")
                    .isEqualTo("unreported");

            UUID entityId = UUID.fromString(erzeuger.get("id").asText());

            // --- Der Push trägt jetzt Autorität UND Verbindung -------------
            JsonNode push = pushJson(site);
            assertThat(push.get("component_authority").asText())
                    .isEqualTo(ComponentAuthority.PORTAL);
            JsonNode driver = driverOf(push, entityId);
            assertThat(driver).as("der Registry-Push trägt den Lesepfad").isNotNull();
            assertThat(driver.get("communication").asText()).isEqualTo("fronius_sunspec");
            assertThat(driver.get("connection").get("ip").asText()).isEqualTo("192.168.0.28");

            // --- Ändern = eine neue Fassung, die alte bleibt ----------------
            Map<String, Object> neu = new LinkedHashMap<>(conn);
            neu.put("ip", "192.168.0.55");
            receipts.record(site, FRONIUS, neu);
            ResponseEntity<String> updated = put(
                    "/api/v1/sites/" + site + "/components/" + entityId, customer,
                    saveBody(FRONIUS, "pv-generation", neu));
            assertThat(updated.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(byRole(json.readTree(updated.getBody()), "pv-generation")
                    .get("definitionVersion").asInt()).isEqualTo(3);

            JsonNode versions = getJson(
                    "/api/v1/sites/" + site + "/components/" + entityId + "/versions", customer);
            assertThat(versions.size()).as("neueste zuerst").isEqualTo(2);
            assertThat(versions.get(0).get("version").asInt()).isEqualTo(3);
            assertThat(versions.get(1).get("connection").get("ip").asText())
                    .isEqualTo("192.168.0.28");

            // --- Rollback SCHREIBT zurück, es löscht nichts -----------------
            ResponseEntity<String> back = post(
                    "/api/v1/sites/" + site + "/components/" + entityId + "/versions/2/rollback",
                    customer, null);
            assertThat(back.getStatusCode()).isEqualTo(HttpStatus.OK);
            JsonNode rolled = byRole(json.readTree(back.getBody()), "pv-generation");
            assertThat(rolled.get("connection").get("ip").asText()).isEqualTo("192.168.0.28");
            assertThat(rolled.get("definitionVersion").asInt())
                    .as("der Weg zurück ist derselbe Weg wie jede Änderung")
                    .isEqualTo(4);
            JsonNode after4 = getJson(
                    "/api/v1/sites/" + site + "/components/" + entityId + "/versions", customer);
            assertThat(after4.size()).as("Historie ist append-only").isEqualTo(3);
            assertThat(after4.get(0).get("note").asText()).contains("Zurück auf Fassung 2");

            // Eine Fassung, die es nicht gibt, ist 404 - nie ein Zufallstreffer.
            assertThat(post("/api/v1/sites/" + site + "/components/" + entityId
                    + "/versions/99/rollback", customer, null).getStatusCode())
                    .isEqualTo(HttpStatus.NOT_FOUND);
        } finally {
            deleteSite(customer, site);
        }
    }

    /** Höchstens EIN Netz-Zähler je Anlage - serverseitig, nicht nur im Frontend. */
    @Test
    void atMostOneGridMeterPerPlantIsEnforcedByTheServer() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Netz-Regel-Anlage");
        try {
            Map<String, Object> c1 = Map.of("ip", "192.168.0.60", "port", 502, "unit_id", 3);
            receipts.record(site, GENERIC, c1);
            assertThat(post("/api/v1/sites/" + site + "/components", customer,
                    saveBody(GENERIC, "grid-meter", c1)).getStatusCode())
                    .isEqualTo(HttpStatus.OK);

            Map<String, Object> c2 = Map.of("ip", "192.168.0.61", "port", 502, "unit_id", 4);
            receipts.record(site, GENERIC, c2);
            ResponseEntity<String> second = post("/api/v1/sites/" + site + "/components",
                    customer, saveBody(GENERIC, "grid-meter", c2));
            assertThat(second.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
            assertThat(second.getBody()).contains("nur einer");

            // Die erste hat GENAU EINE Netz-Zeile erzeugt, keine zweite.
            JsonNode list = getJson("/api/v1/sites/" + site + "/components", customer);
            long meters = 0;
            for (JsonNode row : list.get("components")) {
                if ("grid-meter".equals(row.path("role").asText())) {
                    meters++;
                }
            }
            assertThat(meters).isEqualTo(1);
        } finally {
            deleteSite(customer, site);
        }
    }

    /** Eine unbekannte Vorlage / Rolle wird abgelehnt, bevor irgendetwas entsteht. */
    @Test
    void anUnknownTemplateOrRoleIsRefusedBeforeAnythingIsWritten() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Ablehnungs-Anlage");
        try {
            Map<String, Object> conn = Map.of("ip", "192.168.0.70");
            receipts.record(site, "builtin:gibt:esnicht", conn);
            assertThat(post("/api/v1/sites/" + site + "/components", customer,
                    saveBody("builtin:gibt:esnicht", "pv-generation", conn)).getStatusCode())
                    .isEqualTo(HttpStatus.BAD_REQUEST);

            receipts.record(site, GENERIC, conn);
            assertThat(post("/api/v1/sites/" + site + "/components", customer,
                    saveBody(GENERIC, "wallbox", conn)).getStatusCode())
                    .isEqualTo(HttpStatus.BAD_REQUEST);

            assertThat(getJson("/api/v1/sites/" + site + "/components", customer)
                    .get("components").size())
                    .as("keine der Ablehnungen hat eine Zeile hinterlassen")
                    .isZero();
        } finally {
            deleteSite(customer, site);
        }
    }

    /** RLS ist der Zaun: eine fremde Anlage ist 404, bevor etwas geschrieben wird. */
    @Test
    void aForeignPlantIs404OnEveryRoute() throws Exception {
        String other = token("demo2", "demo2");
        Map<String, Object> conn = deyeConnection();
        String base = "/api/v1/sites/" + BERLIN_SITE;

        assertThat(rest.exchange(url(base + "/components"), HttpMethod.GET,
                new HttpEntity<>(bearer(other)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        // Auch MIT gültigem Beleg des fremden Mandanten - der Zaun ist die DB.
        receipts.record(UUID.fromString(BERLIN_SITE), DEYE, conn);
        assertThat(post(base + "/components", other, saveBody(DEYE, "inverter", conn))
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(post(base + "/component-test", other,
                Map.of("templateRef", DEYE, "connection", conn)).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        // Anonym erreicht die Fläche gar nicht.
        assertThat(rest.getForEntity(url(base + "/components"), String.class).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    /**
     * Der gemeldete Anwende-Stand der Box erreicht die Kunden-Route - und eine
     * Ablehnung steht NEBEN der laufenden Fassung, nie an ihrer Stelle.
     */
    @Test
    void theBoxReportedApplyStateReachesTheCustomerRouteWithoutOverwritingIt() throws Exception {
        String customer = token("demo", "demo");
        UUID berlin = UUID.fromString(BERLIN_SITE);
        UUID device = anyDeviceOf(berlin);

        TenantContext.set(UUID.fromString(TENANT_A));
        try {
            applyRepo.upsert(device, UUID.fromString(TENANT_A), berlin,
                    ComponentAuthority.PORTAL, "r5", Instant.parse("2026-08-16T10:00:00Z"),
                    "r6", "Wechselrichter \"x\": Unbekannte Marke.",
                    Instant.parse("2026-08-16T10:05:00Z"));
        } finally {
            TenantContext.clear();
        }

        JsonNode list = getJson("/api/v1/sites/" + BERLIN_SITE + "/components", customer);
        assertThat(list.get("appliedRevision").asText()).isEqualTo("r5");
        assertThat(list.get("refusedRevision").asText()).isEqualTo("r6");
        assertThat(list.get("refusedReason").asText()).contains("Unbekannte Marke");
    }

    /**
     * Der AUSWEG aus der Sackgasse (Live-Fall Muehlfeldweg 2, 21.08.2026): eine
     * Deye-Anlage mit Eigenbau-Batterie, deren BMS nicht gekoppelt ist, meldet
     * dauerhaft SoC 0. Der Verbindungstest lehnt richtig ab - aber das Geraet
     * hat GEANTWORTET, und alles ausser dem Ladestand ist messbar.
     *
     * <p>Der Test faehrt die ganze Strecke serverseitig: ohne Zustimmung 422,
     * mit einer Zustimmung zum FALSCHEN Kanal 422, mit der richtigen gespeichert
     * - samt dem Opt-in, das die Box braucht, und dem Beleg, der dauerhaft an
     * der Komponente steht. Und die Steuerung dieser Anlage bleibt aus.
     */
    @Test
    void aPlantWhoseBmsReportsNoSocIsSavedOnlyWithAnExplicitAcceptanceAndStaysUncontrollable()
            throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Muehlfeldweg 2");
        try {
            claim(customer, site, "edge-muehlfeld-01");
            // Der Speicher-Stammsatz ist PFLICHT: aus ihm komponiert die
            // Plattform die battery-hybrid-Zeile, in die der Assistent die
            // Anbindung des Wechselrichters schreibt.
            saveBattery(customer, site);
            Map<String, Object> conn = deyeConnection();

            // Der HALBE Beleg entsteht serverseitig aus dem Testergebnis der Box
            // (hier direkt hinterlegt - der Probe-Kanal selbst hat seine eigenen
            // Tests); der Client kann ihn nicht behaupten.
            receipts.recordOverridable(site, DEYE, conn, "soc_pct");

            // 1 · Ohne ausdrueckliche Zustimmung wird NICHTS gespeichert.
            ResponseEntity<String> ohne = post("/api/v1/sites/" + site + "/components",
                    customer, saveBody(DEYE, "inverter", conn));
            assertThat(ohne.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
            assertThat(ohne.getBody()).contains("Ladestand");

            // 2 · Eine Zustimmung zu einem ANDEREN Kanal gilt nicht - sonst waere
            // sie ein Freibrief statt einer benannten Ausnahme.
            Map<String, Object> falsch = saveBody(DEYE, "inverter", conn);
            falsch.put("acceptMissingChannel", "pv_power_kw");
            assertThat(post("/api/v1/sites/" + site + "/components", customer, falsch)
                    .getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

            // 3 · Mit der richtigen Zustimmung wird gespeichert.
            Map<String, Object> ok = saveBody(DEYE, "inverter", conn);
            ok.put("acceptMissingChannel", "soc_pct");
            assertThat(post("/api/v1/sites/" + site + "/components", customer, ok)
                    .getStatusCode()).isEqualTo(HttpStatus.OK);

            // Die komponierte Zeile behaelt ihre Rolle `battery-hybrid` - der
            // Assistent FUELLT sie, er legt keine zweite an.
            JsonNode row = byRole(getJson("/api/v1/sites/" + site + "/components", customer),
                    "battery-hybrid");
            JsonNode stored = row.get("connection");
            // Das Opt-in, das die Box WIRKLICH braucht - ohne es verwirft ihr
            // Decoder jede Lesung und die Anlage bliebe fuer immer stumm.
            assertThat(stored.path("allow_missing_soc").asBoolean()).isTrue();
            // ... und der BELEG daneben: wer, wann, welcher Kanal.
            assertThat(stored.path("reading_override").path("channel").asText())
                    .isEqualTo("soc_pct");
            assertThat(stored.path("reading_override").path("origin").asText())
                    .as("die Herkunft kommt aus den Realm-Rollen, nie aus dem Rumpf")
                    .isEqualTo("kunde");
            assertThat(stored.path("reading_override").path("accepted_at").asText()).isNotBlank();
            assertThat(stored.path("reading_override").path("accepted_by").asText()).isNotBlank();

            // Er reist mit zur Box: der Registry-Push traegt das Opt-in.
            JsonNode push = pushJson(site);
            boolean gefunden = false;
            for (JsonNode e : push.path("entities")) {
                JsonNode c = e.path("driver").path("connection");
                if (c.path("allow_missing_soc").asBoolean()) {
                    gefunden = true;
                }
            }
            assertThat(gefunden).as("die Box muss das Opt-in bekommen").isTrue();

            // 4 · Die STEUERUNG dieser Anlage bleibt aus - und sagt warum.
            String admin = token("admin", "admin");
            UUID device = anyDeviceOf(site);
            ResponseEntity<String> arm = post(
                    "/api/v1/admin/devices/" + device + "/control-activation", admin,
                    Map.of("note", "Versuch"));
            assertThat(arm.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
            assertThat(arm.getBody()).contains("Steuerung nicht möglich");
            assertThat(arm.getBody()).contains("Ladestand");
            assertThat(arm.getBody()).contains("Sobald das BMS gekoppelt ist");

            // 5 · Der WEG ZURUECK: ein vollstaendiger Test loescht die Ausnahme -
            // niemand muss ein Flag zuruecksetzen.
            receipts.record(site, DEYE, conn);
            assertThat(put("/api/v1/sites/" + site + "/components/" + row.get("id").asText(),
                    customer, saveBody(DEYE, "inverter", conn))
                    .getStatusCode()).isEqualTo(HttpStatus.OK);
            JsonNode danach = byRole(getJson("/api/v1/sites/" + site + "/components", customer),
                    "battery-hybrid");
            assertThat(danach.get("connection").has("reading_override")).isFalse();
            assertThat(danach.get("connection").has("allow_missing_soc")).isFalse();
            assertThat(post("/api/v1/admin/devices/" + device + "/control-activation", admin,
                    Map.of()).getStatusCode())
                    .as("ohne die Ausnahme ist die Anlage wieder scharfschaltbar")
                    .isIn(HttpStatus.OK, HttpStatus.NO_CONTENT);
        } finally {
            deleteSite(customer, site);
        }
    }

    // ---- Helfer ------------------------------------------------------------

    private static Map<String, Object> saveBody(String templateRef, String role,
            Map<String, Object> connection) {
        Map<String, Object> body = new HashMap<>();
        body.put("templateRef", templateRef);
        body.put("role", role);
        body.put("connection", connection);
        return body;
    }

    private static JsonNode byRole(JsonNode response, String role) {
        for (JsonNode row : response.get("components")) {
            if (role.equals(row.path("role").asText())) {
                return row;
            }
        }
        throw new AssertionError("keine Komponente mit Rolle " + role);
    }

    /**
     * Die BYTES des zuletzt wirklich veröffentlichten Registry-Pushes dieser
     * Anlage - erzeugt über den echten Pfad, nicht über einen Test-Nachbau.
     */
    private JsonNode pushJson(UUID siteId) throws Exception {
        RecordingPublisherConfig.PUSHES.clear();
        TenantContext.set(UUID.fromString(TENANT_A));
        try {
            entityRegistry.pushRegistryBestEffort(siteId);
        } finally {
            TenantContext.clear();
        }
        assertThat(RecordingPublisherConfig.PUSHES).as("ein Push wurde veröffentlicht")
                .isNotEmpty();
        return json.readTree(
                RecordingPublisherConfig.PUSHES.get(RecordingPublisherConfig.PUSHES.size() - 1));
    }

    private static JsonNode driverOf(JsonNode push, UUID entityId) {
        for (JsonNode e : push.get("entities")) {
            if (entityId.toString().equals(e.path("entity_id").asText())) {
                return e.get("driver");
            }
        }
        return null;
    }

    /** Irgendein Gerät dieser Anlage - der Push braucht ein Gateway. */
    private UUID anyDeviceOf(UUID siteId) {
        TenantContext.set(UUID.fromString(TENANT_A));
        try {
            List<UUID> ids = entityRepo.siteDeviceIds(siteId);
            assertThat(ids).as("die Demo-Anlage hat ein Gerät").isNotEmpty();
            return ids.get(0);
        } finally {
            TenantContext.clear();
        }
    }

    /** Die Eckdaten des Speichers - ohne sie gibt es keine battery-hybrid-Zeile. */
    private void saveBattery(String customerToken, UUID siteId) {
        ResponseEntity<String> res = rest.exchange(url("/api/v1/sites/" + siteId + "/battery"),
                HttpMethod.PUT,
                new HttpEntity<>(Map.of("capacityKwh", 30, "maxChargeKw", 15,
                        "maxDischargeKw", 15), bearer(customerToken)), String.class);
        assertThat(res.getStatusCode()).as("Speicher speichern").isEqualTo(HttpStatus.OK);
    }

    private void claim(String customerToken, UUID siteId, String ref) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(url("/api/v1/devices/claim"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("externalRef", ref, "siteId", siteId.toString(),
                        "kind", "inverter"), bearer(customerToken)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isIn(HttpStatus.OK, HttpStatus.CREATED);
    }

    private UUID createSite(String customerToken, String name) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(url("/api/v1/sites"),
                HttpMethod.POST, new HttpEntity<>(Map.of("name", name), bearer(customerToken)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return UUID.fromString((String) res.getBody().get("id"));
    }

    /** Aufräumen per Superuser - die Testanlagen dürfen die Demo-Flotte nicht verschieben. */
    private void deleteSite(String customerToken, UUID siteId) {
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

    private ResponseEntity<String> post(String path, String token, Object body) {
        return rest.exchange(url(path), HttpMethod.POST,
                new HttpEntity<>(body, bearer(token)), String.class);
    }

    private ResponseEntity<String> put(String path, String token, Object body) {
        return rest.exchange(url(path), HttpMethod.PUT,
                new HttpEntity<>(body, bearer(token)), String.class);
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

    private static HttpHeaders bearer(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return headers;
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
}
