package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
 * Die Zone „Verbraucher" gegen echtes TimescaleDB + Keycloak (Konzept
 * {@code vp-verbrauchsmgmt-konzept-v1} §6, Paket P1). Die Projektions-REGELN
 * liegen rein in {@code SteuerartProjektionTest}/{@code RanglisteProjektionTest};
 * hier faehrt die REISE:
 *
 * <ol>
 *   <li>eine gemeldete OCPP-Saeule wird ein Verbraucher und folgt dem
 *       ANLAGEN-STANDARD, den die Quellen-Wahl der Box vorgibt (§7.2);</li>
 *   <li>ein Heizstab mit eigener aktiver Policy traegt seine eigene Steuerart
 *       samt Werten (§7.1 Regel 6);</li>
 *   <li>eine Saeule mit eigener Policy weicht ab - der Standard-Zaehler faellt;</li>
 *   <li>eine mehrdeutige Policy wird „Eigene Regel" und verliert nichts;</li>
 *   <li>die Rangliste stellt den Speicher nach oben (§7.3);</li>
 *   <li>eine Anlage ohne steuerbares Geraet antwortet ehrlich LEER;</li>
 *   <li>der Mandanten-Zaun: fremde Anlage 404, anonym 401.</li>
 * </ol>
 *
 * <p><b>⚠ Die aktiven Policies entstehen per Superuser-INSERT, nicht ueber die
 * Aktivierungs-Route.</b> Diese Runde prueft den LESEPFAD; die Aktivierung hat
 * ihre eigenen Beweise ({@code ConsumerApiTest},
 * {@code ConsumerPolicyActivationBrokerTest}) und braeuchte hier Flag, Compiler
 * und Broker - drei Dinge, die ueber die Projektion nichts aussagen.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class VerbraucherApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";

    /** Eine beliebige gueltige Anforderung - nur der Fremdschluessel zaehlt. */
    private static final String EINFACHE_ANFORDERUNG = """
            [{"id":"r1","kind":"reactive","enforcement":"opportunistic",
              "target":{"kind":"on_off","value":true},
              "condition":{"signal":"site.pv_surplus_kw","operator":"gt","value":2}}]""";

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
    void dieZoneProjiziertDenBestandUndErfindetNichts() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Verbraucher-Zone");
        try {
            UUID device = claim(customer, site, "edge-verbraucher-1");

            // 0 · Eine Anlage ohne steuerbares Gerät antwortet ehrlich LEER.
            JsonNode leer = getJson(pfad(site), customer);
            assertThat(leer.get("verbraucher")).isEmpty();
            assertThat(leer.get("rangliste")).isEmpty();
            assertThat(leer.get("ladepunkte").get("gesamt").asInt()).isZero();
            assertThat(leer.get("ladepunkte").get("standard").isNull())
                    .as("ohne Ladepunkt gibt es keinen Anlagen-Standard").isTrue();
            assertThat(leer.get("ladepunkte").get("rahmen").isNull())
                    .as("ohne Meldung und ohne gepflegte Grenze kein Rahmen").isTrue();

            // 1 · Zwei OCPP-Säulen melden sich → zwei Komponenten, ohne Klick.
            heartbeat(site, device, zweiSaeulen());
            putJson("/api/v1/sites/" + site + "/charging-config", customer,
                    Map.of("gridLimitKw", 277.0, "surplusPolicy", "sonne_zuerst"));

            JsonNode view = getJson(pfad(site), customer);
            JsonNode lp = view.get("ladepunkte");
            assertThat(lp.get("gesamt").asInt()).isEqualTo(2);
            assertThat(lp.get("standardFolger").asInt())
                    .as("ohne eigene Policy folgt jede Säule dem Standard").isEqualTo(2);
            // §7.2: `sonne_zuerst` ⇒ Überschuss mit gehaltener Mindestleistung,
            // und die Zahl ist die der BOX (min_power_kw), keine erfundene.
            assertThat(lp.get("standard").get("quelle").asText()).isEqualTo("ueberschuss");
            assertThat(lp.get("standard").get("ueberschussModus").asText())
                    .isEqualTo("mindestleistung");
            assertThat(lp.get("standard").get("mindestleistungKw").asDouble()).isEqualTo(30.0);
            assertThat(lp.get("standard").get("herkunft").asText()).isEqualTo("standard");

            // Der Rahmen ist eine AUSWAHL aus dem Budget-Block der Box.
            JsonNode rahmen = lp.get("rahmen");
            assertThat(rahmen.get("netzanschlussKw").asDouble()).isEqualTo(277.0);
            assertThat(rahmen.get("gepflegteGrenzeKw").asDouble()).isEqualTo(277.0);
            assertThat(rahmen.get("verteiltKw").asDouble()).isEqualTo(82.0);
            assertThat(rahmen.get("hoechsteHausLastKw").asDouble()).isEqualTo(190.0);
            assertThat(rahmen.get("steckerAnzahl").asInt()).isEqualTo(2);
            assertThat(rahmen.get("hinweis").asText())
                    .as("der Satz der Box, wörtlich")
                    .isEqualTo("Das Budget folgt der Messung am Netzanschluss.");

            assertThat(view.get("verbraucher")).hasSize(2);
            JsonNode nord = eintrag(view, "Hof Nord");
            assertThat(nord.get("ladepunkt").asBoolean()).isTrue();
            assertThat(nord.get("typ").asText()).isEqualTo("ev-charger");
            assertThat(nord.get("typLabel").asText()).isEqualTo("Ladepunkt");
            assertThat(nord.get("chargePointId").asText()).isEqualTo("saeule-1");
            assertThat(nord.get("steuerart").get("herkunft").asText()).isEqualTo("standard");
            assertThat(nord.get("regeln").asInt()).isZero();
            assertThat(nord.get("fortschritt").isNull())
                    .as("ohne Frist gibt es keinen Fortschritt - nie eine erfundene 0").isTrue();
            assertThat(nord.get("aktiv").isNull())
                    .as("eine komponierte Säule hat kein consumer_profile").isTrue();
            // Eine Säule OHNE eigenen Namen zeigt ihre Kennung, nie „null".
            assertThat(eintrag(view, "saeule-2").get("name").asText()).isEqualTo("saeule-2");

            // 2 · Ein Heizstab mit EIGENER aktiver Policy (§7.1 Regel 6).
            UUID heizstab = createConsumer(customer, site, "heating-rod", "Heizstab", 3.0);
            aktivePolicy(site, heizstab, """
                    [{"id":"r1","kind":"fixed_window","enforcement":"must_run",
                      "target":{"kind":"on_off","value":true},
                      "recurrence":{"days":"weekdays","from":"13:00","to":"15:00"}}]""");
            JsonNode mitHeizstab = getJson(pfad(site), customer);
            JsonNode hz = eintrag(mitHeizstab, "Heizstab");
            assertThat(hz.get("ladepunkt").asBoolean()).isFalse();
            assertThat(hz.get("chargePointId").isNull()).isTrue();
            assertThat(hz.get("steuerart").get("quelle").asText()).isEqualTo("feste_zeiten");
            assertThat(hz.get("steuerart").get("herkunft").asText()).isEqualTo("policy");
            assertThat(hz.get("steuerart").get("fenster").get("tage").asText())
                    .isEqualTo("weekdays");
            assertThat(hz.get("steuerart").get("fenster").get("von").asText()).isEqualTo("13:00");
            assertThat(hz.get("steuerart").get("fenster").get("bis").asText()).isEqualTo("15:00");
            assertThat(hz.get("aktiv").isNull()).isFalse();

            // 3 · Ein Ladepunkt mit EIGENER Steuerart weicht vom Standard ab -
            //     Quelle UND Ziel (§7.1 Regel 8).
            //
            // ⚠ Er ist hier eine go-e/Modbus-WALLBOX, nicht die OCPP-Säule, und
            // das ist eine echte Grenze des Bestands: `consumer_policy.entity_id`
            // hat einen Fremdschlüssel auf `consumer_profile`, und der
            // `ChargerComponentComposer` legt fuer eine gemeldete Säule KEIN
            // Profil an (Konzept §1.2 S3). Eine OCPP-Säule kann heute also gar
            // keine eigene Policy tragen - Regel 1 (Anlagen-Standard) ist ihr
            // einziger Zustand, bis Paket P5 das Profil nachzieht. Fuer den
            // Kunden ist beides derselbe „Ladepunkt", also faehrt der Beweis den
            // Weg, den es HEUTE gibt.
            //
            // Der STRUKTUR-WÄCHTER dazu: der Versuch scheitert am Fremdschlüssel.
            // Faellt er weg, hat jemand der Saeule ein Profil gegeben - dann
            // gehoert dieser Beweis auf den OCPP-Weg umgestellt (P5).
            UUID saeule1 = UUID.fromString(nord.get("entityId").asText());
            assertThatThrownBy(() -> aktivePolicy(site, saeule1, EINFACHE_ANFORDERUNG))
                    .as("eine komponierte OCPP-Saeule hat heute kein consumer_profile")
                    .hasMessageContaining("consumer_policy_entity_id_fkey");


            UUID wallbox = createConsumer(customer, site, "wallbox", "Wallbox Garage", 11.0);
            aktivePolicy(site, wallbox, """
                    [{"id":"r1","kind":"reactive","enforcement":"opportunistic",
                      "target":{"kind":"kw","value":11},
                      "condition":{"signal":"site.pv_surplus_kw","operator":"gt","value":2.5}},
                     {"id":"r2","kind":"flexible_task","enforcement":"required_by_deadline",
                      "target":{"kind":"on_off","value":true},
                      "recurrence":{"days":"daily","from":"00:00","to":"06:00"},
                      "demand":{"energy_kwh":20}}]""");
            JsonNode abweichend = getJson(pfad(site), customer);
            assertThat(abweichend.get("ladepunkte").get("gesamt").asInt())
                    .as("eine go-e-Wallbox IST ein Ladepunkt").isEqualTo(3);
            assertThat(abweichend.get("ladepunkte").get("standardFolger").asInt())
                    .as("eine eigene Policy ist eine Abweichung").isEqualTo(2);
            JsonNode garage = eintrag(abweichend, "Wallbox Garage");
            assertThat(garage.get("ladepunkt").asBoolean()).isTrue();
            assertThat(garage.get("chargePointId").isNull())
                    .as("eine go-e hat keine OCPP-Kennung").isTrue();
            assertThat(garage.get("steuerart").get("herkunft").asText()).isEqualTo("policy");
            assertThat(garage.get("steuerart").get("quelle").asText()).isEqualTo("ueberschuss");
            assertThat(garage.get("steuerart").get("schwelleKw").asDouble()).isEqualTo(2.5);
            assertThat(garage.get("steuerart").get("ziel").asText()).isEqualTo("bis_uhrzeit");
            assertThat(garage.get("steuerart").get("zielEnergieKwh").asDouble()).isEqualTo(20.0);
            // Die OCPP-Säule folgt weiterhin dem Standard.
            assertThat(eintrag(abweichend, "Hof Nord").get("steuerart").get("herkunft").asText())
                    .isEqualTo("standard");

            // 4 · Eine mehrdeutige Policy wird „Eigene Regel" - und verliert nichts.
            UUID pumpe = createConsumer(customer, site, "pump", "Pumpe Keller", 1.2);
            aktivePolicy(site, pumpe, """
                    [{"id":"r1","kind":"reactive","enforcement":"opportunistic",
                      "target":{"kind":"on_off","value":true},
                      "condition":{"any":[
                        {"signal":"site.pv_surplus_kw","operator":"gt","value":2},
                        {"signal":"storage.soc_pct","operator":"gt","value":80}]}}]""");
            JsonNode pk = eintrag(getJson(pfad(site), customer), "Pumpe Keller");
            assertThat(pk.get("steuerart").get("quelle").asText()).isEqualTo("eigene_regel");
            assertThat(pk.get("steuerart").get("ziel").isNull()).isTrue();

            // 5 · Die Rangliste: ohne Speicher gibt es keinen Speicher-Eintrag.
            JsonNode ohneSpeicher = getJson(pfad(site), customer);
            assertThat(arten(ohneSpeicher)).doesNotContain("speicher");
            assertThat(ohneSpeicher.get("rangliste")).hasSize(5);

            // ... und mit Speicher steht er oben (Vorgabe „Speicher vor Auto").
            putJson("/api/v1/sites/" + site + "/battery", customer,
                    Map.of("capacityKwh", 10.0, "maxChargeKw", 5.0, "maxDischargeKw", 5.0));
            JsonNode mitSpeicher = getJson(pfad(site), customer);
            JsonNode ersteZeile = mitSpeicher.get("rangliste").get(0);
            // Die zwei nicht-Ladepunkte (consumer_first per Vorgabe) stehen über
            // ihm, der Speicher davor - also: Heizstab, Pumpe, Speicher, Säulen.
            assertThat(arten(mitSpeicher)).containsExactly("verbraucher", "verbraucher",
                    "speicher", "ladepunkt", "ladepunkt", "ladepunkt");
            assertThat(ersteZeile.get("position").asInt()).isEqualTo(1);
            JsonNode speicherZeile = mitSpeicher.get("rangliste").get(2);
            assertThat(speicherZeile.get("entityId").isNull()).isTrue();
            assertThat(speicherZeile.get("name").asText()).isEqualTo("Speicher");

            // 6 · Der Mandanten-Zaun.
            ResponseEntity<String> fremd = rest.exchange(url(pfad(site)), HttpMethod.GET,
                    new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class);
            assertThat(fremd.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
            ResponseEntity<String> anonym =
                    rest.exchange(url(pfad(site)), HttpMethod.GET, null, String.class);
            assertThat(anonym.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        } finally {
            deleteSite(site);
        }
    }

    // --- Hilfen -------------------------------------------------------------

    private static String pfad(UUID site) {
        return "/api/v1/sites/" + site + "/verbraucher";
    }

    private static JsonNode eintrag(JsonNode view, String name) {
        for (JsonNode e : view.get("verbraucher")) {
            if (name.equals(e.path("name").asText())) {
                return e;
            }
        }
        throw new AssertionError("kein Verbraucher " + name + " in " + view.get("verbraucher"));
    }

    private static java.util.List<String> arten(JsonNode view) {
        java.util.List<String> out = new java.util.ArrayList<>();
        for (JsonNode e : view.get("rangliste")) {
            out.add(e.path("art").asText());
        }
        return out;
    }

    /**
     * Eine AKTIVE Policy per Superuser - der Lesepfad braucht sie, die
     * Aktivierungs-Maschinerie hat ihre eigenen Beweise (siehe Klassen-Doku).
     */
    private void aktivePolicy(UUID site, UUID entity, String requirements) {
        String doc = ("{\"schema_version\":\"1.0\",\"entity_id\":\"" + entity
                + "\",\"requirements\":" + requirements + "}").replace("'", "''");
        try (Connection c = superuser(); Statement st = c.createStatement()) {
            st.execute("INSERT INTO consumer_policy (entity_id, tenant_id, site_id, version, "
                    + "lifecycle, document, content_hash, created_by) VALUES ('" + entity + "', '"
                    + TENANT_A + "', '" + site + "', 1, 'active', '" + doc
                    + "'::jsonb, 'sha256:test', 'test')");
        } catch (SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    private UUID createConsumer(String token, UUID site, String type, String name, double ratedKw) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/sites/" + site + "/consumers"), HttpMethod.POST,
                new HttpEntity<>(Map.of("type", type, "name", name, "ratedPowerKw", ratedKw,
                        "controlKind", "on_off"), bearer(token)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).as("POST consumers -> %s", res.getBody())
                .isEqualTo(HttpStatus.CREATED);
        return UUID.fromString((String) res.getBody().get("id"));
    }

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

    private static String zweiSaeulen() {
        return """
                {"reported_at":"2026-08-31T11:24:00Z","enabled":true,"control_enabled":true,
                 "grid_limit_kw":277,"margin_pct":10,"min_power_kw":30,"budget_kw":82.3,
                 "allocated_kw":82,"measured_kw":79,"site_load_kw":167,"max_house_load_kw":190,
                 "budget_mode":"gemessen","connector_count":2,
                 "budget_note":"Das Budget folgt der Messung am Netzanschluss.",
                 "chargers":[
                   {"id":"saeule-1","label":"Hof Nord","connected":true,"ready":true,
                    "connectors":[{"id":1,"status":"Charging","charging":true,"power_kw":40}]},
                   {"id":"saeule-2","connected":true,"ready":true,
                    "connectors":[{"id":1,"status":"Available","charging":false}]}]}""";
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

    /** Aufräumen per Superuser - die Testanlage darf die Demo-Flotte nicht verschieben. */
    private void deleteSite(UUID siteId) {
        try (Connection c = superuser(); Statement st = c.createStatement()) {
            st.execute("DELETE FROM consumer_policy WHERE site_id = '" + siteId + "'");
            st.execute("DELETE FROM consumer_profile WHERE site_id = '" + siteId + "'");
            st.execute("DELETE FROM device_charge_connector WHERE site_id = '" + siteId + "'");
            st.execute("DELETE FROM device_charge_point WHERE site_id = '" + siteId + "'");
            st.execute("DELETE FROM device_charging_budget WHERE site_id = '" + siteId + "'");
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

    private JsonNode putJson(String path, String token, Map<String, Object> body) throws Exception {
        ResponseEntity<String> res = rest.exchange(url(path), HttpMethod.PUT,
                new HttpEntity<>(body, bearer(token)), String.class);
        assertThat(res.getStatusCode()).as("PUT %s -> %s", path, res.getBody())
                .isEqualTo(HttpStatus.OK);
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
