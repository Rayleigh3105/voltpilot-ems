package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.flows.FlowCompilerHttp;
import com.voltpilot.api.simulation.SimulationHttp;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.client.TestRestTemplate;
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
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Portal v3 M3 - the Modus-Profile shelf end to end against real Keycloak +
 * TimescaleDB (fake simulation + fake flowc transports, the
 * FlowPeakShavingApiTest seams; the activation flag is ON so a real activation
 * can be proven and then undone by a profile toggle).
 *
 * <p>The proof matrix (M3-profile.md acceptance):
 * <ul>
 *   <li>a plant with no {@code site_profile_state} rows behaves exactly like
 *       before: every card reads {@code state: null} and only the DERIVED
 *       activation shows;</li>
 *   <li>a CONTRACT-NEAR profile (Marktoptimierung) without market access still
 *       flips - but its gated node stays closed, no starter is seeded and the
 *       card names the missing prerequisite: NOTHING trades (OPEN(O1));</li>
 *   <li>with market access the SAME toggle opens the gated node, and a customer
 *       can then activate the market flow;</li>
 *   <li>switching it OFF deactivates that flow, disables the node type again and
 *       persists {@code aus} - which SUPPRESSES the still-derived mode;</li>
 *   <li>Gewerbe without a Leistungspreis flips and reports the honest reason;</li>
 *   <li>a customer still gets 403 on the admin governance PUT, a foreign site is
 *       404 through RLS, and there is no "angefragt" state anywhere.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class SiteProfileApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";
    private static final String MARKET = "vp.strategy.market";
    private static final String PEAKSHAVING = "vp.strategy.peakshaving";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Container
    static final KeycloakContainer KEYCLOAK = new KeycloakContainer(
            "quay.io/keycloak/keycloak:26.0.5")
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

        // The rig-only activation flag ON: a profile toggle-off must be able to
        // deactivate a REALLY active flow, not just a draft.
        registry.add("voltpilot.flows.activation.enabled", () -> "true");

        String realm = KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot";
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> realm);
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> realm + "/protocol/openid-connect/certs");
    }

    /** In-memory stand-in for the Python simulation service. */
    static class FakeSimulationService implements SimulationHttp {

        final ConcurrentHashMap<String, String> statusBodies = new ConcurrentHashMap<>();
        final AtomicInteger counter = new AtomicInteger();
        private final ObjectMapper json = new ObjectMapper();

        @Override
        public Response post(URI uri, String jsonBody) throws IOException {
            json.readTree(jsonBody);
            String id = String.format("%032d", counter.incrementAndGet());
            statusBodies.put(id, "{\"status\":\"done\",\"progress\":1.0,\"result\":{"
                    + "\"headline\":{\"gesamtVorteilNettoEur\":180.0},"
                    + "\"annahmen\":{\"preisjahr\":\"2025\"}}}");
            return new Response(202, "{\"simulationId\":\"" + id + "\"}");
        }

        @Override
        public Response get(URI uri) {
            String path = uri.getPath();
            String body = statusBodies.get(path.substring(path.lastIndexOf('/') + 1));
            return body != null ? new Response(200, body)
                    : new Response(404, "{\"message\":\"Simulation nicht gefunden.\"}");
        }
    }

    @TestConfiguration
    static class Fakes {

        @Bean
        FakeSimulationService simulationHttp() {
            return new FakeSimulationService();
        }

        /** Fake flowc transport (the JVM has no Node runtime) - contract fixture. */
        @Bean
        FlowCompilerHttp flowCompilerHttp() throws IOException {
            String artifact = Files.readString(Path.of("..", "..", "docs", "contracts", "v2",
                    "examples", "flow-artifact.valid.artifact.json"));
            return (uri, body) -> new FlowCompilerHttp.Response(200, artifact);
        }
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Test
    void customerTogglesProfilesWhichOpenTheirOwnGatedNodesAndSeedTheirStarterFlow() {
        String admin = token("admin", "admin");
        String demo = token("demo", "demo");

        // VoltPilot bootstraps the site's v2 entities (a customer cannot) so the
        // starter flows have a battery-hybrid to claim.
        exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/v2-entities/bootstrap", HttpMethod.POST,
                admin, TENANT_A, Map.of());

        // -- 1. A plant with NO stored intent: every card is `state: null` -------
        JsonNode shelf = customer(profilesPath(), HttpMethod.GET, demo, null).getBody();
        // Eigenverbrauch is no longer a shelf profile (report vp-nacht-bezug-e7
        // §3.3) - it is base behaviour, not a selectable card.
        // "lastmanagement" ist seit Lastmanagement Stufe 3 ein Regal-Profil
        // (Konzept §5.2). Es hat KEINEN Strategie-Knoten - Lastmanagement ist
        // Schutz, keine Marktteilnahme - und schaltet deshalb nichts frei.
        //
        // Seit dem EINEN Anwendungs-Katalog (Zielbild-Stufe 1) fuehrt das Regal
        // zusaetzlich die zwei BASIS-Anwendungen ("immer an", nicht schaltbar)
        // und die zwei REGEL-Anwendungen (Schalter = reine Absicht). Die zwei
        // RESERVIERTEN Eintraege (eigene-auswertung, berichte) stehen bewusst
        // NICHT darin - ein Schalter, der nichts bewirken kann, waere eine
        // Zusage, die niemand einloest.
        assertThat(ids(shelf)).containsExactly("monitoring", "speicher-fahrplan", "ueberschuss",
                "verbraucher", "marktvermarktung", "lastspitzenkappung", "atypische-netznutzung",
                "lastmanagement");
        // Monitoring laeuft immer - jede Anlage wird beobachtet; der
        // Voraussetzungs-Chip sagt, ob schon Werte ankommen.
        assertThat(card(shelf, "monitoring").path("derivedActive").asBoolean()).isTrue();
        assertThat(card(shelf, "monitoring").path("active").asBoolean()).isTrue();
        // Der Speicher-Fahrplan folgt dem Speicher (der Bootstrap oben hat eine
        // battery-hybrid Entitaet komponiert).
        assertThat(card(shelf, "speicher-fahrplan").path("derivedActive").asBoolean()).isTrue();
        // Eine Regel-Anwendung wird NIE erfunden: ohne Verbraucher-Regel bleibt
        // sie aus, und "ueberschuss" wird ueberhaupt nie abgeleitet.
        assertThat(card(shelf, "verbraucher").path("derivedActive").asBoolean()).isFalse();
        assertThat(card(shelf, "ueberschuss").path("derivedActive").asBoolean()).isFalse();
        for (JsonNode card : shelf.path("profiles")) {
            assertThat(card.path("state").isNull())
                    .as("no row => derived default, the pre-M3 behaviour").isTrue();
        }
        // The shelf is honest about prerequisites even before anything is toggled.
        assertThat(card(shelf, "marktvermarktung").path("requirements").get(0).path("met")
                .asBoolean()).as("Berlin has neither a dynamic tariff nor DV").isFalse();
        assertThat(card(shelf, "lastspitzenkappung").path("requirements").get(0).path("met")
                .asBoolean()).as("no Leistungspreis configured").isFalse();
        // There is no "angefragt" anywhere in the API.
        assertThat(shelf.toString().toLowerCase()).doesNotContain("angefragt");

        // -- 2. Nothing is toggled yet: no gated node is open, no flow exists ----
        assertThat(gatedEnabled(demo, MARKET)).isFalse();
        assertThat(gatedEnabled(demo, PEAKSHAVING)).isFalse();
        assertThat(flows(demo)).as("no flow before any toggle").isEmpty();

        // -- 3. Marktoptimierung WITHOUT market access: flips, but nothing trades
        JsonNode blocked = toggle(demo, "marktvermarktung", "an");
        JsonNode marktCard = card(blocked, "marktvermarktung");
        assertThat(marktCard.path("state").asText()).isEqualTo("an");
        assertThat(marktCard.path("active").asBoolean()).isTrue();
        assertThat(marktCard.path("blockedReason").asText())
                .as("the honest, specific reason - never a request prompt")
                .contains("Marktzugang");
        assertThat(marktCard.path("gatedNodesEnabled").asBoolean()).isFalse();
        assertThat(gatedEnabled(demo, MARKET))
                .as("OPEN(O1): a bare toggle must not open uncontracted market trading")
                .isFalse();

        // -- 4. Real market access on the site -> the SAME toggle opens the node -
        giveMarketAccess(demo);
        JsonNode opened = toggle(demo, "marktvermarktung", "an");
        assertThat(card(opened, "marktvermarktung").path("blockedReason").isNull()).isTrue();
        assertThat(card(opened, "marktvermarktung").path("gatedNodesEnabled").asBoolean()).isTrue();
        assertThat(gatedEnabled(demo, MARKET)).isTrue();

        // The customer can now build + activate a market flow (the gate is OPEN,
        // not faked: the server wrote the per-site enablement).
        String flowId = seedMarketFlow(demo);
        String base = "/api/v1/sites/" + BERLIN_SITE + "/flows/" + flowId;
        JsonNode validation = customer(base + "/versions/1/validate", HttpMethod.POST, demo,
                Map.of()).getBody();
        assertThat(validation.path("valid").asBoolean()).as("%s", validation).isTrue();
        String simId = customer(base + "/versions/1/simulate", HttpMethod.POST, demo, Map.of())
                .getBody().path("simulationId").asText();
        assertThat(customer(base + "/versions/1/simulation/" + simId, HttpMethod.GET, demo, null)
                .getBody().path("status").asText()).isEqualTo("done");
        assertThat(customer(base + "/versions/1/activate", HttpMethod.POST, demo, Map.of())
                .getBody().path("activated").asBoolean())
                .as("a customer-opened gated node really activates").isTrue();

        // -- 5. Switching it OFF stops the flow and closes the node again --------
        JsonNode off = toggle(demo, "marktvermarktung", "aus");
        JsonNode offCard = card(off, "marktvermarktung");
        assertThat(offCard.path("state").asText()).isEqualTo("aus");
        assertThat(offCard.path("derivedActive").asBoolean())
                .as("the DV master data still derives the mode").isTrue();
        assertThat(offCard.path("active").asBoolean())
                .as("`aus` suppresses it - a re-derived signal must not re-enable it").isFalse();
        assertThat(gatedEnabled(demo, MARKET)).isFalse();
        assertThat(lifecycleOf(demo, flowId))
                .as("the profile's flow was deactivated").isEqualTo("retired");

        // -- 6. Gewerbe without a Leistungspreis: honest, no fake success --------
        JsonNode gewerbe = card(toggle(demo, "lastspitzenkappung", "an"), "lastspitzenkappung");
        assertThat(gewerbe.path("state").asText()).isEqualTo("an");
        assertThat(gewerbe.path("blockedReason").asText()).contains("Leistungspreis");
        assertThat(gatedEnabled(demo, PEAKSHAVING))
                .as("the part that CAN run runs; the peak-shaving config gate still refuses later")
                .isTrue();
        assertThat(gatedEnabled(demo, MARKET))
                .as("exactly the toggled profile's node types - nothing else").isFalse();

        // -- 7. The customer still cannot write governance directly -------------
        assertThat(customer("/api/v1/admin/sites/" + BERLIN_SITE + "/flow-node-governance",
                HttpMethod.PUT, demo,
                Map.of("enablements", List.of(Map.of("nodeType", MARKET, "enabled", true))))
                .getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);

        toggle(demo, "lastspitzenkappung", "aus");
        assertThat(gatedEnabled(demo, PEAKSHAVING)).isFalse();
    }

    @Test
    void profileShelfIsTenantScopedAndValidated() {
        String demo = token("demo", "demo");
        String demo2 = token("demo2", "demo2");

        // RLS: tenant B cannot see (or write) tenant A's site => 404, never 403.
        assertThat(customer(profilesPath(), HttpMethod.GET, demo2, null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(customer(profilesPath(), HttpMethod.PUT, demo2,
                Map.of("profile", "marktvermarktung", "state", "an")).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        // Unknown profile / unknown state are honest 400s with German copy.
        ResponseEntity<JsonNode> unknown = customer(profilesPath(), HttpMethod.PUT, demo,
                Map.of("profile", "vollmond", "state", "an"));
        assertThat(unknown.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(unknown.getBody().path("message").asText()).contains("Unbekanntes Profil");
        ResponseEntity<JsonNode> badState = customer(profilesPath(), HttpMethod.PUT, demo,
                Map.of("profile", "marktvermarktung", "state", "angefragt"));
        assertThat(badState.getStatusCode()).as("there is no third state").isEqualTo(
                HttpStatus.BAD_REQUEST);

        // Eine BASIS-Anwendung hat keinen Schalter - der Versuch ist ein
        // ehrlicher 400, kein stiller Erfolg.
        ResponseEntity<JsonNode> basis = customer(profilesPath(), HttpMethod.PUT, demo,
                Map.of("profile", "monitoring", "state", "aus"));
        assertThat(basis.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(basis.getBody().path("message").asText()).contains("immer an");

        // Eine RESERVIERTE Anwendung wird gar nicht angeboten und ist von einer
        // unbekannten nicht zu unterscheiden - es gibt sie noch nicht.
        ResponseEntity<JsonNode> reserviert = customer(profilesPath(), HttpMethod.PUT, demo,
                Map.of("profile", "berichte", "state", "an"));
        assertThat(reserviert.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(reserviert.getBody().path("message").asText()).contains("Unbekanntes Profil");

        // An admin reaches the same shelf through the X-Tenant-Id switcher.
        assertThat(exchange(profilesPath(), HttpMethod.GET, token("admin", "admin"), TENANT_A, null)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    /**
     * Anwendungs-Programm Stufe 2: das PRESET der Anlage.
     *
     * <p>Die Zusagen, die hier hängen: es ist NULL auf jeder Bestandsanlage, es
     * wird über eine SCHMALE Route geschrieben, ein unbekanntes Wort ist eine
     * benannte Ablehnung statt eines stillen Rückfalls — und vor allem: <b>es
     * schaltet keine einzige Anwendung</b> (Captain-Entscheid E3), damit ein
     * späteres „Profil ändern" nie die Schalter des Kunden überschreibt.
     */
    @Test
    void theApplicationPresetIsStoredWithoutTouchingASingleSwitch() {
        String demo = token("demo", "demo");
        String pfad = "/api/v1/sites/" + BERLIN_SITE + "/anwendungs-preset";

        // 1) Der Zustand JEDER Bestandsanlage: kein Profil.
        assertThat(site(demo).path("profil").isNull()).as("Bestand ist NULL").isTrue();

        // Der Zustand des Regals VOR der Wahl - er darf sich nicht ändern.
        Map<String, String> vorher = states(customer(profilesPath(), HttpMethod.GET, demo, null)
                .getBody());

        // 2) Das Preset wird gespeichert und auf der Anlage zurückgemeldet.
        ResponseEntity<JsonNode> gesetzt = customer(pfad, HttpMethod.PUT, demo,
                Map.of("profil", "gewerbe"));
        assertThat(gesetzt.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(gesetzt.getBody().path("profil").asText()).isEqualTo("gewerbe");
        assertThat(site(demo).path("profil").asText()).isEqualTo("gewerbe");

        // 3) ... und es hat KEINEN Schalter angefasst.
        assertThat(states(customer(profilesPath(), HttpMethod.GET, demo, null).getBody()))
                .as("das Profil schaltet nichts").isEqualTo(vorher);

        // 4) Umschalten und wieder löschen sind derselbe Weg.
        assertThat(customer(pfad, HttpMethod.PUT, demo, Map.of("profil", "privat")).getBody()
                .path("profil").asText()).isEqualTo("privat");
        Map<String, Object> leer = new HashMap<>();
        leer.put("profil", null);
        assertThat(customer(pfad, HttpMethod.PUT, demo, leer).getBody().path("profil").isNull())
                .as("null löscht es wieder").isTrue();

        // 5) Ein unbekanntes Wort wird BENANNT abgelehnt, nie still auf eines
        //    der zwei zurückgefallen - das behauptete eine Wahl, die niemand traf.
        ResponseEntity<JsonNode> quatsch = customer(pfad, HttpMethod.PUT, demo,
                Map.of("profil", "betreiber"));
        assertThat(quatsch.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(quatsch.getBody().path("message").asText()).contains("Unbekanntes Profil");
        assertThat(site(demo).path("profil").isNull()).as("nichts geschrieben").isTrue();

        // 6) RLS ist der Zaun - eine fremde Anlage ist 404, nie 403.
        assertThat(customer(pfad, HttpMethod.PUT, token("demo2", "demo2"),
                Map.of("profil", "privat")).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // 7) Ein Admin erreicht dieselbe Route über den Mandanten-Umschalter.
        assertThat(exchange(pfad, HttpMethod.PUT, token("admin", "admin"), TENANT_A,
                Map.of("profil", "gewerbe")).getStatusCode()).isEqualTo(HttpStatus.OK);
        customer(pfad, HttpMethod.PUT, demo, leer);
    }

    // ---- helpers -------------------------------------------------------------

    private static String profilesPath() {
        return "/api/v1/sites/" + BERLIN_SITE + "/profiles";
    }

    /** Die Demo-Anlage, wie der Kunde sie sieht. */
    private JsonNode site(String token) {
        for (JsonNode candidate : customer("/api/v1/sites", HttpMethod.GET, token, null)
                .getBody()) {
            if (BERLIN_SITE.equals(candidate.path("id").asText())) {
                return candidate;
            }
        }
        throw new AssertionError("die Demo-Anlage fehlt");
    }

    /** Anwendung -> gespeicherter Wille (`an`/`aus`/`-`) - der Regal-Zustand. */
    private static Map<String, String> states(JsonNode shelf) {
        Map<String, String> out = new java.util.LinkedHashMap<>();
        for (JsonNode card : shelf.path("profiles")) {
            out.put(card.path("id").asText(),
                    card.path("state").isNull() ? "-" : card.path("state").asText());
        }
        return out;
    }

    private JsonNode toggle(String token, String profile, String state) {
        ResponseEntity<JsonNode> response = customer(profilesPath(), HttpMethod.PUT, token,
                Map.of("profile", profile, "state", state));
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        return response.getBody();
    }

    private static List<String> ids(JsonNode shelf) {
        return java.util.stream.StreamSupport
                .stream(shelf.path("profiles").spliterator(), false)
                .map(n -> n.path("id").asText()).toList();
    }

    private static JsonNode card(JsonNode shelf, String id) {
        for (JsonNode node : shelf.path("profiles")) {
            if (id.equals(node.path("id").asText())) {
                return node;
            }
        }
        throw new AssertionError("no profile card " + id);
    }

    private boolean gatedEnabled(String token, String nodeType) {
        JsonNode governance = customer("/api/v1/sites/" + BERLIN_SITE + "/flow-node-governance",
                HttpMethod.GET, token, null).getBody();
        for (JsonNode node : governance.path("gatedNodes")) {
            if (nodeType.equals(node.path("type").asText())) {
                return node.path("enabled").asBoolean();
            }
        }
        return false;
    }

    private JsonNode flows(String token) {
        return customer("/api/v1/sites/" + BERLIN_SITE + "/flows", HttpMethod.GET, token, null)
                .getBody();
    }

    private String lifecycleOf(String token, String flowId) {
        for (JsonNode flow : flows(token)) {
            if (flowId.equals(flow.path("flowId").asText())) {
                return flow.path("latestLifecycle").asText();
            }
        }
        throw new AssertionError("flow gone: " + flowId);
    }

    /**
     * The market prerequisite is REAL master data, entered on the Vergütung form
     * - a profile toggle never writes it (M3-profile.md). The site PUT is full
     * representation, so the current values are carried through.
     */
    private void giveMarketAccess(String token) {
        JsonNode all = customer("/api/v1/sites", HttpMethod.GET, token, null).getBody();
        JsonNode site = null;
        for (JsonNode candidate : all) {
            if (BERLIN_SITE.equals(candidate.path("id").asText())) {
                site = candidate;
            }
        }
        assertThat(site).as("the demo site").isNotNull();
        Map<String, Object> body = new HashMap<>();
        body.put("name", site.path("name").asText());
        body.put("biddingZone", site.path("biddingZone").asText());
        body.put("latitude", site.path("latitude").asDouble());
        body.put("longitude", site.path("longitude").asDouble());
        body.put("plantKind", "direktvermarktung");
        body.put("tarifArt", "dynamisch");
        body.put("tarifParamCtKwh", 18.0);
        assertThat(customer("/api/v1/sites/" + BERLIN_SITE, HttpMethod.PUT, token, body)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    /**
     * The seeded starter flow of the market profile - the toggle already ran
     * auto-start, so this only resolves the flow the customer now edits.
     */
    private String seedMarketFlow(String token) {
        JsonNode created = customer(profilesPath(), HttpMethod.PUT, token,
                Map.of("profile", "marktvermarktung", "state", "an")).getBody();
        assertThat(created).isNotNull();
        // The Eigenverbrauch starter already exists, so auto-start reports
        // `already_has_flow` - the customer builds the market flow explicitly.
        String flowId = customer("/api/v1/sites/" + BERLIN_SITE + "/flows", HttpMethod.POST, token,
                Map.of("name", "Marktoptimierung")).getBody().path("flowId").asText();
        // Reuse the auto-start template shape via the admin-free path: the
        // starter document of the arbitrage profile lives in FlowTemplates, so
        // build the same delegated chain here.
        JsonNode entities = customer("/api/v1/sites/" + BERLIN_SITE + "/entities", HttpMethod.GET,
                token, null).getBody();
        String battery = null;
        for (JsonNode entity : entities.path("entities")) {
            if ("battery-hybrid".equals(entity.path("entityType").asText())) {
                battery = entity.path("id").asText();
            }
        }
        assertThat(battery).as("bootstrapped battery-hybrid").isNotNull();
        customer("/api/v1/sites/" + BERLIN_SITE + "/flows/" + flowId + "/versions/1",
                HttpMethod.PUT, token,
                Map.of("name", "Marktoptimierung", "document", marketDocument(battery)));
        return flowId;
    }

    /**
     * The market pilot chain (price + PV + SoC -> market -> control) with its
     * derived delegated claim - the shape the flow catalog requires.
     */
    private static Map<String, Object> marketDocument(String battery) {
        Map<String, Object> price = node("price1", "vp.price.dayahead", Map.of());
        Map<String, Object> pv = node("pv1", "vp.forecast.pv", Map.of());
        Map<String, Object> soc = node("soc1", "vp.entity.read",
                Map.of("entity_id", battery, "channel", "soc_pct"));
        Map<String, Object> strategy = new HashMap<>(node("strat1", MARKET,
                Map.of("entity_id", battery, "speicherschonung", "ausgewogen")));
        strategy.put("claims", List.of(Map.of("entity_id", battery, "commands",
                List.of("setpoint_kw"), "delegated", true)));
        Map<String, Object> control = node("ctl1", "vp.entity.control",
                Map.of("entity_id", battery, "command", "setpoint_kw", "ttl_s", 180));
        Map<String, Object> doc = new HashMap<>();
        doc.put("schema_version", "1.0");
        doc.put("name", "Marktoptimierung");
        doc.put("runtime", "edge");
        doc.put("nodes", List.of(price, pv, soc, strategy, control));
        doc.put("edges", List.of(
                edge("e1", "price1", "prices", "strat1", "price_in"),
                edge("e2", "pv1", "forecast", "strat1", "pv_forecast"),
                edge("e3", "soc1", "value", "strat1", "soc"),
                edge("e4", "strat1", "wunsch", "ctl1", "plan")));
        doc.put("triggers", List.of(Map.of("id", "t1", "kind", "slot-boundary")));
        return doc;
    }

    private static Map<String, Object> node(String id, String type, Map<String, Object> params) {
        return Map.of("id", id, "type", type, "type_version", "1.0.0", "parameters", params);
    }

    private static Map<String, Object> edge(String id, String fromNode, String fromPort,
            String toNode, String toPort) {
        return Map.of("id", id, "from", Map.of("node", fromNode, "port", fromPort), "to",
                Map.of("node", toNode, "port", toPort));
    }

    private ResponseEntity<JsonNode> customer(String path, HttpMethod method, String token,
            Object body) {
        return exchange(path, method, token, null, body);
    }

    private ResponseEntity<JsonNode> exchange(String path, HttpMethod method, String token,
            String tenantHeader, Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        if (tenantHeader != null) {
            headers.add("X-Tenant-Id", tenantHeader);
        }
        HttpEntity<?> entity = body != null ? new HttpEntity<>(body, headers)
                : new HttpEntity<>(headers);
        return rest.exchange("http://localhost:" + port + path, method, entity,
                new ParameterizedTypeReference<JsonNode>() {
                });
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
