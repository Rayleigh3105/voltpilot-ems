package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import com.voltpilot.api.verbraucher.SteuerartService;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.beans.factory.annotation.Autowired;
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
 * Der SCHREIBPFAD der Steuerart gegen echtes TimescaleDB + Keycloak (Konzept
 * {@code vp-verbrauchsmgmt-konzept-v1} §3/§4.4, Paket P2).
 *
 * <p>Die REGELN liegen rein ({@code SteuerartSatzTest},
 * {@code SteuerartRundlaufTest}); hier faehrt die REISE:
 *
 * <ol>
 *   <li>ein Heizstab bekommt eine Steuerart, die es vorher nicht gab - das
 *       Profil entsteht dabei, die Policy wird eine neue AKTIVE Fassung, und
 *       die Zone liest sie sofort zurueck;</li>
 *   <li>eine zweite Wahl loest die erste ab (neue Fassung, die alte
 *       stillgelegt) - der Kunde stellt um, nichts geht verloren;</li>
 *   <li>„Sofort" NIMMT die Policy zurueck, statt eine leere zu schreiben;</li>
 *   <li>eine GESPERRTE Wahl wird mit GENAU ihrem Grund abgelehnt, und es wird
 *       dabei NICHTS geschrieben;</li>
 *   <li>eine OCPP-Saeule sagt ehrlich, dass ihr Weg noch nicht hier liegt -
 *       auf der Route UND in ihren Optionen;</li>
 *   <li>der Mandanten-Zaun: fremde Anlage 404.</li>
 * </ol>
 *
 * <p><b>⚠ Die Aktivierungs-Flags stehen hier AN und der Compiler-Transport ist
 * gefaked</b> (das {@code FlowPeakShavingApiTest}-Muster): eine JVM hat kein
 * Node, und der Broker ist in einem Testlauf nicht erreichbar. Genau deshalb
 * beweist dieser Test den WEG - dass die Steuerart durch dieselbe
 * Aktivierungs-Maschinerie geht wie eine Regel aus dem Baukasten -, nicht die
 * Maschinerie selbst (die hat ihre eigenen Beweise).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        classes = {ApiApplication.class, SteuerartApiTest.Fakes.class})
@ActiveProfiles("local")
class SteuerartApiTest {

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
        // Die Steuerart geht durch den ECHTEN Aktivierungspfad - also stehen
        // seine zwei Tore hier an, wie auf einer scharfgeschalteten Anlage.
        registry.add("voltpilot.consumer-control.enabled", () -> "true");
        registry.add("voltpilot.consumer-control.policy-compiler-enabled", () -> "true");

        String realm = KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot";
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> realm);
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> realm + "/protocol/openid-connect/certs");
    }

    /**
     * Die zwei Stand-ins, ohne die eine reaktive Steuerart in einem Testlauf
     * nicht aktivierbar waere: der flowc-Transport (kein Node in der JVM) und
     * der Verteil-Weg (kein Broker). Beide geben genau das zurueck, was der
     * echte Weg zurueckgibt - der Rest der Kette ist unveraendert echt.
     */
    @TestConfiguration
    static class Fakes {

        @Bean
        com.voltpilot.api.flows.FlowCompilerHttp flowCompilerHttp() throws Exception {
            String artifact = java.nio.file.Files.readString(java.nio.file.Path.of("..", "..",
                    "docs", "contracts", "v2", "examples", "flow-artifact.valid.artifact.json"));
            return (uri, body) -> new com.voltpilot.api.flows.FlowCompilerHttp.Response(200,
                    artifact);
        }

        @Bean
        FlowDeploymentPublisher flowDeploymentPublisher() {
            return new FlowDeploymentPublisher("tcp://localhost:1", "", "") {
                @Override
                public synchronized boolean publishDeployment(UUID tenantId, UUID siteId,
                        UUID deviceId, byte[] payload) {
                    return true;
                }
            };
        }
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    private final ObjectMapper json = new ObjectMapper();

    @Test
    void derKundeSetztDieSteuerartUndDieZoneLiestSieZurueck() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Steuerart P2");
        try {
            // Eine Anlage MIT Erzeugung und dynamischem Tarif - sonst waeren
            // „Überschuss" und „Günstige Stunden" zu Recht gesperrt.
            erzeugerAnlegen(site);
            tarifDynamisch(customer, site);
            // ⚠ Ein Geraet ist PFLICHT, sobald eine Steuerart ein Edge-Artefakt
            // erzeugt (die Ueberschuss-Quelle tut das): ohne eindeutiges
            // Gateway kann der Aktivierungspfad nichts verteilen und antwortet
            // - zu Recht - mit 503 statt eine Zusage zu speichern, die kein
            // Geraet ausfuehrt.
            claim(customer, site, "p2-steuerart-01");
            UUID heizstab = createConsumer(customer, site, "heating-rod", "Heizstab Keller", 3.0);

            // --- 1 · die erste Steuerart -------------------------------------
            JsonNode gesetzt = put(pfad(site, heizstab), customer, Map.of(
                    "quelle", "feste_zeiten",
                    "fenster", Map.of("tage", "daily", "von", "22:00", "bis", "06:00")));
            assertThat(gesetzt.path("aktiv").asBoolean()).as("aktiviert: %s", gesetzt).isTrue();
            assertThat(gesetzt.path("steuerart").path("quelle").asText())
                    .isEqualTo("feste_zeiten");

            JsonNode zeile = eintrag(getJson(zone(site), customer), "Heizstab Keller");
            assertThat(zeile.path("steuerart").path("quelle").asText()).isEqualTo("feste_zeiten");
            assertThat(zeile.path("steuerart").path("herkunft").asText()).isEqualTo("policy");
            assertThat(zeile.path("steuerart").path("fenster").path("von").asText())
                    .isEqualTo("22:00");
            // Das Profil ist dabei ENTSTANDEN - vorher gab es keines.
            assertThat(zeile.path("aktiv").asBoolean()).isTrue();
            assertThat(policyFassungen(site, heizstab)).isEqualTo(1);

            // --- 2 · umstellen ------------------------------------------------
            // Der Kern-Fall des Browser-Beweises: von einer Zeitregel auf
            // „Überschuss ab 2,5 kW" - eine NEUE Fassung, die alte stillgelegt.
            JsonNode um = put(pfad(site, heizstab), customer, Map.of(
                    "quelle", "ueberschuss", "schwelleKw", 2.5, "mindestlaufzeitMinuten", 15));
            assertThat(um.path("aktiv").asBoolean()).as("umgestellt: %s", um).isTrue();
            JsonNode nachher = eintrag(getJson(zone(site), customer), "Heizstab Keller");
            assertThat(nachher.path("steuerart").path("quelle").asText()).isEqualTo("ueberschuss");
            assertThat(nachher.path("steuerart").path("schwelleKw").asDouble()).isEqualTo(2.5);
            assertThat(policyFassungen(site, heizstab)).as("append-only: die alte Fassung bleibt")
                    .isEqualTo(2);
            assertThat(aktiveFassungen(site, heizstab)).as("es gilt immer genau EINE").isEqualTo(1);
            // Die Folgefrage „Mindestlaufzeit" wohnt im PROFIL, nicht im Dokument.
            assertThat(minOnSeconds(site, heizstab)).isEqualTo(900);

            // --- 3 · „Sofort" nimmt zurueck -----------------------------------
            JsonNode sofort = put(pfad(site, heizstab), customer, Map.of("quelle", "sofort"));
            assertThat(sofort.path("steuerart").path("quelle").asText()).isEqualTo("sofort");
            assertThat(aktiveFassungen(site, heizstab))
                    .as("„Sofort\" schreibt keine leere Policy - es nimmt die aktive zurueck")
                    .isZero();
            assertThat(policyFassungen(site, heizstab)).as("nichts geloescht").isEqualTo(2);
            assertThat(eintrag(getJson(zone(site), customer), "Heizstab Keller")
                    .path("steuerart").path("quelle").asText()).isEqualTo("sofort");
        } finally {
            deleteSite(site);
        }
    }

    @Test
    void dieSteuerartZaehltSichSelbstNichtAlsRegel() throws Exception {
        // ⚠ Eine Steuerart mit LOKALEM Signal erzeugt einen generierten
        // Verbraucher-Flow, der die Komponente beansprucht. Er IST die
        // Steuerart, keine Regel daneben - zählte die Zeile ihn mit, behauptete
        // jede frisch gesetzte Überschuss-Steuerart „1 Regel" über sich selbst
        // (im Browser aufgefallen, nicht im Unit-Test).
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Steuerart Regelzahl");
        try {
            erzeugerAnlegen(site);
            claim(customer, site, "p2-regelzahl-01");
            UUID heizstab = createConsumer(customer, site, "heating-rod", "Heizstab", 3.0);
            JsonNode gesetzt = put(pfad(site, heizstab), customer,
                    Map.of("quelle", "ueberschuss", "schwelleKw", 2.5));
            assertThat(gesetzt.path("aktiv").asBoolean()).as("aktiviert: %s", gesetzt).isTrue();

            JsonNode zeile = eintrag(getJson(zone(site), customer), "Heizstab");
            assertThat(zeile.path("steuerart").path("quelle").asText()).isEqualTo("ueberschuss");
            assertThat(zeile.path("regeln").asInt())
                    .as("die Steuerart ist keine Regel daneben").isZero();
        } finally {
            deleteSite(site);
        }
    }

    @Test
    void eineGesperrteWahlWirdMitIhremGrundAbgelehntUndSchreibtNichts() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Steuerart Sperren");
        try {
            UUID last = createConsumer(customer, site, "generic-load", "Schaltlast", 2.0);

            // Ohne hinterlegten Tarif ist „Günstige Stunden" gesperrt - und der
            // Satz nennt den WEG, statt einen Vertrag zu behaupten.
            ResponseEntity<String> preis = putRaw(pfad(site, last), customer,
                    Map.of("quelle", "guenstig", "preisgrenzeCtKwh", 9));
            assertThat(preis.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(nachricht(preis)).contains("Stromtarif ist noch nicht hinterlegt");

            // Ohne PV ist „Überschuss" gesperrt.
            ResponseEntity<String> pv = putRaw(pfad(site, last), customer,
                    Map.of("quelle", "ueberschuss"));
            assertThat(pv.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(nachricht(pv)).contains("keine PV");

            // Eine Quelle, die dieser Typ gar nicht kennt.
            ResponseEntity<String> fremd = putRaw(pfad(site, last), customer,
                    Map.of("quelle", "nachts_wenn_der_mond"));
            assertThat(fremd.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

            // Und ein Ziel, das dieser Typ nicht kennt.
            ResponseEntity<String> ziel = putRaw(pfad(site, last), customer, Map.of(
                    "quelle", "feste_zeiten",
                    "fenster", Map.of("tage", "daily", "von", "13:00", "bis", "15:00"),
                    "ziel", "bis_uhrzeit"));
            assertThat(ziel.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

            assertThat(policyFassungen(site, last))
                    .as("keine abgelehnte Wahl hinterlaesst eine Fassung").isZero();
        } finally {
            deleteSite(site);
        }
    }

    @Test
    void eineOcppSaeuleSagtEhrlichDassIhrWegNochNichtHierLiegt() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Steuerart OCPP");
        try {
            UUID saeule = ocppKomponente(site, "Stellplatz 1");

            ResponseEntity<String> res = putRaw(pfad(site, saeule), customer,
                    Map.of("quelle", "sofort"));
            assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
            assertThat(nachricht(res)).isEqualTo(SteuerartService.OCPP_NOCH_NICHT);

            // Und die Zeile bietet ihn gar nicht erst an - mit demselben Satz.
            JsonNode zeile = eintrag(getJson(zone(site), customer), "Stellplatz 1");
            assertThat(zeile.path("optionen").path("schreibbar").asBoolean()).isFalse();
            assertThat(zeile.path("optionen").path("nichtSchreibbarGrund").asText())
                    .isEqualTo(SteuerartService.OCPP_NOCH_NICHT);
        } finally {
            deleteSite(site);
        }
    }

    @Test
    void dieZeileTraegtIhreWaehlbarenSteuerartenUndJedeSperreIhrenGrund() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Steuerart Optionen");
        try {
            createConsumer(customer, site, "heating-rod", "Heizstab", 3.0);
            JsonNode zeile = eintrag(getJson(zone(site), customer), "Heizstab");
            JsonNode optionen = zeile.path("optionen");
            assertThat(optionen.path("schreibbar").asBoolean()).isTrue();
            assertThat(ids(optionen.path("quellen")))
                    .containsExactly("ueberschuss", "feste_zeiten", "guenstig", "sofort");
            assertThat(ids(optionen.path("ziele"))).containsExactly("laufzeit_bis");

            // Ohne PV und ohne Tarif sind zwei der drei gesperrt - und JEDE
            // gesperrte Karte traegt ihren Grund (nie eine leere Sperre).
            for (JsonNode q : optionen.path("quellen")) {
                if (q.path("gesperrt").asBoolean()) {
                    assertThat(q.path("grund").asText()).isNotBlank();
                }
            }
            assertThat(wahl(optionen.path("quellen"), "ueberschuss").path("gesperrt").asBoolean())
                    .isTrue();
            assertThat(wahl(optionen.path("quellen"), "feste_zeiten").path("gesperrt").asBoolean())
                    .as("Feste Zeiten braucht weder PV noch Tarif").isFalse();

            // Die Vorgaben der Folgefragen sind BELEGT oder null - nie erfunden.
            JsonNode v = optionen.path("vorgaben");
            assertThat(v.path("schwelleKw").asDouble()).as("Vorgabe = Nennleistung").isEqualTo(3.0);
            assertThat(v.path("zielEnergieKwh").asDouble()).isEqualTo(20.0);
            assertThat(v.path("zielUhrzeit").asText()).isEqualTo("06:00");
            // ⚠ Die Preis-Vorgabe ist BELEGT oder null - nie erfunden. Der
            // Dev-Seed traegt DE-LU-Preise, also gibt es hier eine; sie ist
            // auf 0,5 ct gerundet, damit sie wie eine gewaehlte Zahl aussieht.
            if (!v.path("preisgrenzeCtKwh").isNull()) {
                double ct = v.path("preisgrenzeCtKwh").asDouble();
                assertThat(ct).isGreaterThanOrEqualTo(0);
                assertThat(Math.round(ct * 2) / 2.0).as("auf 0,5 ct gerundet").isEqualTo(ct);
            }
        } finally {
            deleteSite(site);
        }
    }

    @Test
    void derMandantenZaunGiltAufDerSchreibRoute() throws Exception {
        String customer = token("demo", "demo");
        String anderer = token("demo2", "demo2");
        UUID site = createSite(customer, "Steuerart RLS");
        try {
            UUID last = createConsumer(customer, site, "generic-load", "Schaltlast", 2.0);
            ResponseEntity<String> fremd = putRaw(pfad(site, last), anderer,
                    Map.of("quelle", "feste_zeiten",
                            "fenster", Map.of("tage", "daily", "von", "13:00", "bis", "15:00")));
            assertThat(fremd.getStatusCode()).as("fremde Anlage ist 404, nie 403")
                    .isEqualTo(HttpStatus.NOT_FOUND);

            // Eine Komponente, die es nicht gibt, ebenso.
            ResponseEntity<String> unbekannt = putRaw(pfad(site, UUID.randomUUID()), customer,
                    Map.of("quelle", "sofort"));
            assertThat(unbekannt.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        } finally {
            deleteSite(site);
        }
    }

    // --- Hilfen -------------------------------------------------------------

    private static String zone(UUID site) {
        return "/api/v1/sites/" + site + "/verbraucher";
    }

    private static String pfad(UUID site, UUID entity) {
        return zone(site) + "/" + entity + "/steuerart";
    }

    private static JsonNode eintrag(JsonNode view, String name) {
        for (JsonNode e : view.get("verbraucher")) {
            if (name.equals(e.path("name").asText())) {
                return e;
            }
        }
        throw new AssertionError("kein Verbraucher " + name + " in " + view.get("verbraucher"));
    }

    private static java.util.List<String> ids(JsonNode array) {
        java.util.List<String> out = new java.util.ArrayList<>();
        array.forEach(n -> out.add(n.path("id").asText()));
        return out;
    }

    private static JsonNode wahl(JsonNode array, String id) {
        for (JsonNode n : array) {
            if (id.equals(n.path("id").asText())) {
                return n;
            }
        }
        throw new AssertionError("keine Wahl " + id + " in " + array);
    }

    private String nachricht(ResponseEntity<String> res) throws Exception {
        return json.readTree(res.getBody()).path("message").asText();
    }

    /**
     * Ein Erzeuger per Superuser - {@code hatPv} ist capability-basiert
     * (MIG §4), also braucht die Anlage eine Komponente, die {@code pv_power_kw}
     * misst.
     */
    private void erzeugerAnlegen(UUID site) {
        try (Connection c = superuser(); Statement st = c.createStatement()) {
            st.execute("INSERT INTO measurement_point (id, tenant_id, site_id, role, label, "
                    + "entity_type, capabilities) VALUES ('" + UUID.randomUUID() + "', '" + TENANT_A
                    + "', '" + site + "', 'pv-generation', 'Dach', 'producer', "
                    + "'{\"measure\":[{\"channel\":\"pv_power_kw\"}]}'::jsonb)");
        } catch (SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Eine komponierte OCPP-Saeule per Superuser (sie entsteht sonst aus einem Herzschlag). */
    private UUID ocppKomponente(UUID site, String label) {
        UUID id = UUID.randomUUID();
        try (Connection c = superuser(); Statement st = c.createStatement()) {
            st.execute("INSERT INTO measurement_point (id, tenant_id, site_id, role, label, "
                    + "entity_type, control, capabilities) VALUES ('" + id + "', '" + TENANT_A
                    + "', '" + site + "', 'consumer', '" + label + "', 'ev-charger', true, "
                    + "'{\"measure\":[{\"channel\":\"power_kw\"}],"
                    + "\"actuate\":[{\"command\":\"limit_kw\"}]}'::jsonb)");
        } catch (SQLException e) {
            throw new IllegalStateException(e);
        }
        return id;
    }

    private void tarifDynamisch(String token, UUID site) {
        Map<String, Object> body = new HashMap<>();
        body.put("name", "Steuerart P2");
        body.put("tarifArt", "dynamisch");
        body.put("tarifParamCtKwh", 18);
        ResponseEntity<String> res = rest.exchange(url("/api/v1/sites/" + site), HttpMethod.PUT,
                new HttpEntity<>(body, bearer(token)), String.class);
        assertThat(res.getStatusCode()).as("PUT site -> %s", res.getBody())
                .isEqualTo(HttpStatus.OK);
    }

    private int policyFassungen(UUID site, UUID entity) {
        return zahl("SELECT count(*) FROM consumer_policy WHERE site_id = '" + site
                + "' AND entity_id = '" + entity + "'");
    }

    private int aktiveFassungen(UUID site, UUID entity) {
        return zahl("SELECT count(*) FROM consumer_policy WHERE site_id = '" + site
                + "' AND entity_id = '" + entity + "' AND lifecycle = 'active'");
    }

    private int minOnSeconds(UUID site, UUID entity) {
        return zahl("SELECT coalesce(min_on_seconds, -1) FROM consumer_profile WHERE site_id = '"
                + site + "' AND entity_id = '" + entity + "'");
    }

    private int zahl(String sql) {
        try (Connection c = superuser(); Statement st = c.createStatement()) {
            var rs = st.executeQuery(sql);
            return rs.next() ? rs.getInt(1) : -1;
        } catch (SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    private UUID createConsumer(String token, UUID site, String type, String name, double ratedKw) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/sites/" + site + "/consumers"), HttpMethod.POST,
                new HttpEntity<>(Map.of("type", type, "name", name, "ratedPowerKw", ratedKw,
                        "controlKind", "on_off", "edgeSourceId", "src-" + name.hashCode()),
                        bearer(token)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).as("POST consumers -> %s", res.getBody())
                .isEqualTo(HttpStatus.CREATED);
        return UUID.fromString((String) res.getBody().get("id"));
    }

    private UUID claim(String customerToken, UUID siteId, String ref) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(url("/api/v1/devices/claim"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("externalRef", ref, "siteId", siteId.toString(),
                        "kind", "inverter"), bearer(customerToken)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).as("claim -> %s", res.getBody())
                .isIn(HttpStatus.OK, HttpStatus.CREATED);
        return UUID.fromString((String) res.getBody().get("id"));
    }

    private UUID createSite(String customerToken, String name) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(url("/api/v1/sites"),
                HttpMethod.POST, new HttpEntity<>(Map.of("name", name), bearer(customerToken)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return UUID.fromString((String) res.getBody().get("id"));
    }

    private void deleteSite(UUID siteId) {
        try (Connection c = superuser(); Statement st = c.createStatement()) {
            st.execute("DELETE FROM consumer_audit_event WHERE site_id = '" + siteId + "'");
            st.execute("DELETE FROM consumer_policy WHERE site_id = '" + siteId + "'");
            st.execute("DELETE FROM consumer_profile WHERE site_id = '" + siteId + "'");
            st.execute("DELETE FROM flow_claim WHERE site_id = '" + siteId + "'");
            st.execute("DELETE FROM flow_definition WHERE site_id = '" + siteId + "'");
            st.execute("DELETE FROM measurement_point WHERE site_id = '" + siteId + "'");
            st.execute("DELETE FROM telemetry WHERE site_id = '" + siteId + "'");
            st.execute("DELETE FROM device WHERE site_id = '" + siteId + "'");
            st.execute("DELETE FROM site_charging_config WHERE site_id = '" + siteId + "'");
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
        assertThat(res.getStatusCode()).as("GET %s -> %s", path, res.getBody())
                .isEqualTo(HttpStatus.OK);
        return json.readTree(res.getBody());
    }

    private JsonNode put(String path, String token, Map<String, Object> body) throws Exception {
        ResponseEntity<String> res = putRaw(path, token, body);
        assertThat(res.getStatusCode()).as("PUT %s -> %s", path, res.getBody())
                .isEqualTo(HttpStatus.OK);
        return json.readTree(res.getBody());
    }

    private ResponseEntity<String> putRaw(String path, String token, Map<String, Object> body) {
        return rest.exchange(url(path), HttpMethod.PUT,
                new HttpEntity<>(body, bearer(token)), String.class);
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
