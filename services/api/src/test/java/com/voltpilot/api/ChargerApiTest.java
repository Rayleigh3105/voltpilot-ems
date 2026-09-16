package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.chargers.ChargerComponentComposer;
import com.voltpilot.api.chargers.ChargerStatusListener;
import com.voltpilot.api.chargers.ChargingConfigPublisher;
import com.voltpilot.api.repo.DeviceChargerStatusRepository;
import com.voltpilot.api.repo.DeviceRepository;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.Collections;
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
import org.springframework.boot.test.mock.mockito.MockBean;
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

    @Autowired
    com.voltpilot.api.fahrzeuge.SiteVehicleRepository vehicles;

    @MockBean
    ChargingConfigPublisher chargingConfigPublisher;

    private final ObjectMapper json = new ObjectMapper();

    @Test
    void ocppControlIsRevisionedTenantFencedAndSeparatesDesiredFromObserved() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "OCPP-Einrichtung");
        String path = "/api/v1/sites/" + site + "/ocpp/control";
        try {
            assertThat(getJson(path, customer).path("desired").isNull()).isTrue();
            assertThat(getJson(path, customer).path("observed")).isEmpty();
            var policy = json.readTree("""
                {"revision":0,"enabled":true,"authorization":{"mode":"allowlist","allowed_tags":[]},
                 "electrical":[],"phase_limits_a":[],"limits":[]}
                """);
            // AP-03 IP-7 (E12/E13): die Realm-Rolle entscheidet hier nichts mehr - das Bestandskonto IST
            // Kundenadministrator und gibt die Regelung selbst frei. Wer das Recht NICHT hat (Energiemanager,
            // Bedienberechtigt, Leser, Unterstuetzer), bekommt 403 recht_fehlt - siehe RechtMatrixApiTest.
            HttpHeaders admin = bearer(token("admin", "admin"));
            admin.set("X-Tenant-Id", TENANT_A);
            var saved = rest.exchange(url(path), HttpMethod.PUT, new HttpEntity<>(policy, bearer(customer)),
                    String.class);
            assertThat(saved.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(json.readTree(saved.getBody()).path("desired").path("revision").asLong()).isEqualTo(1);
            assertThat(json.readTree(saved.getBody()).path("observed")).isEmpty();
            assertThat(getJson(path, customer).path("desired").path("authorization").path("mode").asText()).isEqualTo("allowlist");
            UUID device = claim(customer, site, "edge-control-proof");
            var block = (com.fasterxml.jackson.databind.node.ObjectNode)json.readTree(twoStations());
            block.set("control_status", json.readTree("""
                {"revision":1,"enabled":true,"authorization_mode":"allowlist","seen_tags":[],"stations":[]}
                """));
            heartbeat(site, device, block.toString());
            var observed = getJson(path, customer).path("observed");
            assertThat(observed).hasSize(1);
            assertThat(observed.get(0).path("state").path("revision").asLong()).isEqualTo(1);
            assertThat(observed.get(0).path("reportedAt").asText()).isEqualTo("2026-08-20T11:24:00Z");
            // A subsequent legacy heartbeat cannot refresh that old proof.
            heartbeat(site, device, twoStations());
            assertThat(getJson(path, customer).path("observed")).isEmpty();

            assertThat(rest.exchange(url(path), HttpMethod.PUT, new HttpEntity<>(policy, admin), String.class)
                    .getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
            ((com.fasterxml.jackson.databind.node.ObjectNode)policy).put("revision",1);
            ((com.fasterxml.jackson.databind.node.ObjectNode)policy.path("authorization")).put("mode","guess");
            assertThat(rest.exchange(url(path), HttpMethod.PUT, new HttpEntity<>(policy, admin), String.class)
                    .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(getJson(path, customer).path("desired").path("revision").asLong()).isEqualTo(1);
            assertThat(rest.exchange(url(path), HttpMethod.GET, new HttpEntity<>(bearer(token("demo2","demo2"))),String.class)
                    .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
            admin.set("X-Tenant-Id","10000000-0000-0000-0000-000000000001");
            assertThat(rest.exchange(url(path), HttpMethod.PUT, new HttpEntity<>(policy, admin),String.class)
                    .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        } finally { deleteSite(site); }
    }

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
            String firstEntityId = view.get("chargers").get(0).get("entityId").asText();

            // Der Anzeigename ist nach der Komposition der universelle
            // Komponenten-Alias. Der Edge-Name bleibt ein technischer
            // Eingangsbeleg, darf einen späteren Kundennamen aber nie schlagen.
            putJson("/api/v1/sites/" + site + "/v2-entities/" + firstEntityId + "/label",
                    customer, Map.of("label", "Schnelllader Carport"));
            JsonNode renamed = getJson("/api/v1/sites/" + site + "/chargers", customer);
            assertThat(renamed.get("chargers").get(0).get("label").asText())
                    .isEqualTo("Schnelllader Carport");

            // 3 · Der zweite Herzschlag legt KEINE zweite an.
            heartbeat(site, device, twoStations());
            assertThat(chargerEntities(getJson("/api/v1/sites/" + site + "/entities", customer)))
                    .as("genau EINMAL je Säule").isEqualTo(2);
            // ... und die Bindung überlebt das Ersetzen des Satzes.
            JsonNode again = getJson("/api/v1/sites/" + site + "/chargers", customer);
            assertThat(again.get("chargers").get(0).get("entityId").asText())
                    .isEqualTo(view.get("chargers").get(0).get("entityId").asText());
            assertThat(again.get("chargers").get(0).get("label").asText())
                    .as("ein neuer Edge-Status überschreibt den Kunden-Alias nie")
                    .isEqualTo("Schnelllader Carport");

            // Zurücksetzen löscht den Alias. Die API liefert dann null, und
            // jede Portalfläche fällt auf die eindeutige ChargePointId zurück.
            putJson("/api/v1/sites/" + site + "/v2-entities/" + firstEntityId + "/label",
                    customer, Map.of("label", "   "));
            assertThat(getJson("/api/v1/sites/" + site + "/chargers", customer)
                    .get("chargers").get(0).get("label").isNull()).isTrue();

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

    /**
     * Stufe 4: die QUELLEN-Wahl ist eine Kunden-Entscheidung, die Übersteuerung
     * eine Kunden-Aktion - und beide fassen KEINE Grenze an.
     */
    @Test
    void theSourceChoiceIsSavedAndJetztVollLadenOverridesExactlyOneSession() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Ladepark-Ueberschuss");
        try {
            UUID device = claim(customer, site, "edge-ladepark-4");
            heartbeat(site, device, surplusStations());

            // 0 · Ohne Wahl behauptet das Portal NICHTS - die Box behält ihre
            //     eigene Einstellung (abwesend ist NICHT „schnell").
            JsonNode empty = getJson("/api/v1/sites/" + site + "/charging-config", customer);
            assertThat(empty.get("surplusPolicy").isNull()).isTrue();
            assertThat(empty.get("storagePriority").isNull()).isTrue();

            // 1 · Der Kunde wählt - und die Anschlussgrenze bleibt unangetastet
            //     (PATCH, dieselbe Regel wie überall auf diesem Pfad).
            putJson("/api/v1/sites/" + site + "/charging-config", customer,
                    Map.of("gridLimitKw", 277));
            JsonNode chosen = putJson("/api/v1/sites/" + site + "/charging-config", customer,
                    Map.of("surplusPolicy", "nur_sonne", "storagePriority", "auto_vor_speicher"));
            assertThat(chosen.get("surplusPolicy").asText()).isEqualTo("nur_sonne");
            assertThat(chosen.get("storagePriority").asText()).isEqualTo("auto_vor_speicher");
            assertThat(chosen.get("gridLimitKw").asDouble())
                    .as("eine Quellen-Wahl ändert keine Grenze").isEqualTo(277.0);

            // 2 · Ein unbekanntes Wort wird BENANNT abgelehnt und ändert nichts.
            ResponseEntity<String> garbage = rest.exchange(
                    url("/api/v1/sites/" + site + "/charging-config"), HttpMethod.PUT,
                    new HttpEntity<>(Map.of("surplusPolicy", "hoffentlich"), bearer(customer)),
                    String.class);
            assertThat(garbage.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(garbage.getBody()).contains("Nur Sonnenstrom");
            assertThat(getJson("/api/v1/sites/" + site + "/charging-config", customer)
                    .get("surplusPolicy").asText()).isEqualTo("nur_sonne");

            // 3 · Die Box meldet, was sie WIRKLICH fährt - samt der laufenden
            //     Übersteuerung an genau einem Stecker.
            JsonNode charging = getJson("/api/v1/sites/" + site + "/chargers", customer);
            JsonNode budget = charging.get("budget");
            assertThat(budget.get("surplusPolicy").asText()).isEqualTo("nur_sonne");
            assertThat(budget.get("surplusActive").asBoolean()).isTrue();
            assertThat(budget.get("surplusKw").asDouble()).isEqualTo(65.0);
            // ⚠ Der deutsche Satz kommt aus der BOX und wird nur durchgereicht.
            assertThat(budget.get("surplusNote").asText()).contains("Nur Sonnenstrom");
            JsonNode connectors = charging.get("chargers").get(0).get("connectors");
            assertThat(connectors.get(0).get("boost").asBoolean()).isTrue();
            assertThat(connectors.get(1).get("boost").asBoolean()).isFalse();

            // 4 · „Jetzt voll laden" für einen Stecker OHNE Ladevorgang ist 409 -
            //     eine Zusage über ein Fahrzeug, das nicht da ist, wäre erfunden.
            ResponseEntity<String> idle = rest.exchange(
                    url("/api/v1/sites/" + site + "/charging-boost"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("chargePointId", "saeule-1", "connectorId", 2),
                            bearer(customer)),
                    String.class);
            assertThat(idle.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
            assertThat(idle.getBody()).contains("kein Ladevorgang");

            // 5 · Eine unbekannte Säule und ein unbekannter Stecker sind 404.
            ResponseEntity<String> unknown = rest.exchange(
                    url("/api/v1/sites/" + site + "/charging-boost"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("chargePointId", "gibt-es-nicht", "connectorId", 1),
                            bearer(customer)),
                    String.class);
            assertThat(unknown.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

            // 6 · Ohne Broker gibt es KEINE Freigabe - und die Antwort sagt das,
            //     statt eine zu behaupten, die nie hinausging (die Nachricht IST
            //     die Freigabe).
            ResponseEntity<String> noBroker = rest.exchange(
                    url("/api/v1/sites/" + site + "/charging-boost"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("chargePointId", "saeule-1", "connectorId", 1),
                            bearer(customer)),
                    String.class);
            assertThat(noBroker.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
            assertThat(noBroker.getBody()).contains("nicht erreichen");

            // 6b · P3b: die ZWEITE Richtung geht denselben Weg - ohne Broker also
            //      ebenfalls 503 und OHNE Beleg. Ein unbekanntes Wort ist dagegen
            //      eine BENANNTE Ablehnung, nie ein stiller Rückfall auf „voll"
            //      (das schaltete einen Ladevorgang ein, den jemand stoppen wollte).
            ResponseEntity<String> pause = rest.exchange(
                    url("/api/v1/sites/" + site + "/charging-boost"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("chargePointId", "saeule-1", "connectorId", 1,
                            "action", "pause"), bearer(customer)),
                    String.class);
            assertThat(pause.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);

            ResponseEntity<String> badAction = rest.exchange(
                    url("/api/v1/sites/" + site + "/charging-boost"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("chargePointId", "saeule-1", "connectorId", 1,
                            "action", "stop"), bearer(customer)),
                    String.class);
            assertThat(badAction.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(badAction.getBody()).contains("Unbekannte Art des Eingriffs");

            // 7 · Der Mandanten-Zaun gilt auch hier.
            ResponseEntity<String> foreign = rest.exchange(
                    url("/api/v1/sites/" + site + "/charging-boost"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("chargePointId", "saeule-1", "connectorId", 1),
                            bearer(token("demo2", "demo2"))),
                    String.class);
            assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        } finally {
            deleteSite(site);
        }
    }

    /**
     * Der ANBINDE-ASSISTENT: eine Säule wird im Portal eingetragen, und die
     * Fläche bekommt den ECHTEN Endpunkt, unter dem die Säule anwählt.
     *
     * <p><b>⚠ Diese Route fügt nur HINZU.</b> Eine Kennung zurückzunehmen ist
     * eine eigene, ausdrückliche Handlung (DELETE) - siehe den Test darunter.
     */
    @Test
    void aChargePointIsAdmittedFromThePortalAndTheEndpointComesFromTheBox() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Ladepark-Anbinden");
        try {
            UUID device = claim(customer, site, "edge-ladepark-5");

            // 0 · Ohne Eintrag ist die Liste ehrlich leer - und das heisst hier
            //     „das Portal hat noch keine eingetragen", nicht „keine Säule".
            JsonNode empty = getJson("/api/v1/sites/" + site + "/charging-config", customer);
            assertThat(empty.get("chargePoints")).isEmpty();

            // 1 · Der Assistent trägt eine Kennung ein - nur sie ist Pflicht.
            JsonNode saved = postJson("/api/v1/sites/" + site + "/charging-config/charge-points",
                    customer, Map.of("chargePointId", "saeule-hof-nord", "label", "Hof Nord",
                            "ratedKw", 22, "connectors", 2));
            assertThat(saved.get("chargePoints")).hasSize(1);
            JsonNode first = saved.get("chargePoints").get(0);
            assertThat(first.get("chargePointId").asText()).isEqualTo("saeule-hof-nord");
            assertThat(first.get("label").asText()).isEqualTo("Hof Nord");
            assertThat(first.get("ratedKw").asDouble()).isEqualTo(22.0);
            assertThat(first.hasNonNull("addedBy")).as("die Papier-Spur steht").isTrue();

            // 2 · Eine zweite nennt NUR ihre Kennung - was der Betreiber nicht
            //     weiss, bleibt „unbekannt", nie 0.
            JsonNode two = postJson("/api/v1/sites/" + site + "/charging-config/charge-points",
                    customer, Map.of("chargePointId", "saeule-halle"));
            assertThat(two.get("chargePoints")).hasSize(2);
            JsonNode bare = two.get("chargePoints").get(1);
            assertThat(bare.get("label").isNull()).isTrue();
            assertThat(bare.get("ratedKw").isNull()).isTrue();
            assertThat(bare.get("connectors").isNull()).isTrue();

            // 3 · Dieselbe Kennung erneut ist ein No-op, das nur auffrischt -
            //     nie eine zweite Zeile, und die Anschlussgrenze bleibt (PATCH).
            putJson("/api/v1/sites/" + site + "/charging-config", customer,
                    Map.of("gridLimitKw", 277));
            JsonNode again = postJson("/api/v1/sites/" + site + "/charging-config/charge-points",
                    customer, Map.of("chargePointId", "saeule-halle", "label", "Halle"));
            assertThat(again.get("chargePoints")).hasSize(2);
            assertThat(again.get("chargePoints").get(1).get("label").asText()).isEqualTo("Halle");
            assertThat(again.get("gridLimitKw").asDouble()).isEqualTo(277.0);

            // 4 · Eine Kennung, die kein Topic-Segment sein kann, wird BENANNT
            //     abgelehnt - sie erreichte die Säule nie, und die Ablehnung
            //     nennt den erlaubten Zeichensatz.
            ResponseEntity<String> bad = rest.exchange(
                    url("/api/v1/sites/" + site + "/charging-config/charge-points"),
                    HttpMethod.POST,
                    new HttpEntity<>(Map.of("chargePointId", "sae ule/1"), bearer(customer)),
                    String.class);
            assertThat(bad.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(bad.getBody()).contains("Bindestrich");
            // ... und sie hat NICHTS verändert.
            assertThat(getJson("/api/v1/sites/" + site + "/charging-config", customer)
                    .get("chargePoints")).hasSize(2);

            // 5 · Die Box meldet den Endpunkt - ohne ihn könnte die Fläche
            //     nur eine Vorgabe hinschreiben statt der echten Adresse.
            heartbeat(site, device, endpointStations());
            JsonNode budget = getJson("/api/v1/sites/" + site + "/chargers", customer).get("budget");
            assertThat(budget.get("ocppPort").asInt()).isEqualTo(8887);
            assertThat(budget.get("ocppUrlPath").asText()).isEqualTo("/ocpp");

            // 6 · Der Mandanten-Zaun gilt auch auf dieser Route.
            ResponseEntity<String> foreign = rest.exchange(
                    url("/api/v1/sites/" + site + "/charging-config/charge-points"),
                    HttpMethod.POST,
                    new HttpEntity<>(Map.of("chargePointId", "saeule-fremd"),
                            bearer(token("demo2", "demo2"))),
                    String.class);
            assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        } finally {
            deleteSite(site);
        }
    }

    /**
     * A14: Ladepunkte einer Anlage haengen an genau einer Box. Rahmen und
     * Rangliste erreichen nur diese Box; der Wechsel auf eine zweite Box wird
     * als fachliche 422-Ablehnung benannt.
     */
    @Test
    void a14ChargingParkConfigurationReachesExactlyTheStationBox() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "A14 Ladepark");
        try {
            UUID halle2 = claim(customer, site, "edge-a14-halle-2");
            UUID lesebox = claim(customer, site, "edge-a14-lesebox");
            heartbeat(site, halle2, endpointStations());
            heartbeat(site, lesebox, noStationsEndpoint());

            JsonNode sicht = getJson("/api/v1/sites/" + site + "/chargers", customer);
            assertThat(sicht.get("budgets")).hasSize(2);
            UUID ladepunkt = UUID.fromString(
                    sicht.get("chargers").get(0).get("entityId").asText());

            org.mockito.Mockito.clearInvocations(chargingConfigPublisher);
            HttpHeaders admin = bearer(token("admin", "admin"));
            admin.set("X-Tenant-Id", TENANT_A);
            ResponseEntity<String> rahmen = rest.exchange(
                    url("/api/v1/admin/sites/" + site + "/charging-frame"), HttpMethod.PUT,
                    new HttpEntity<>(Map.of("houseReserveKw", 10, "maxHouseLoadKw", 120), admin),
                    String.class);
            assertThat(rahmen.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(publishedChargingDevices()).containsExactly(halle2);

            org.mockito.Mockito.clearInvocations(chargingConfigPublisher);
            ResponseEntity<String> rangliste = rest.exchange(
                    url("/api/v1/sites/" + site + "/rangliste"), HttpMethod.PUT,
                    new HttpEntity<>(Map.of("eintraege", List.of(Map.of(
                            "art", "ladepunkt", "entityId", ladepunkt.toString()))),
                            bearer(customer)), String.class);
            assertThat(rangliste.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(publishedChargingDevices()).containsExactly(halle2);

            org.mockito.Mockito.clearInvocations(chargingConfigPublisher);
            ResponseEntity<String> zweiteBox = rest.exchange(
                    url("/api/v1/sites/" + site + "/charging-config/charge-points"),
                    HttpMethod.POST,
                    new HttpEntity<>(Map.of("chargePointId", "ahr-lp-02",
                            "deviceId", lesebox.toString()), bearer(customer)), String.class);
            assertThat(zweiteBox.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
            assertThat(zweiteBox.getBody()).contains("bereits an eine andere Box angebunden")
                    .contains("gemeinsamen Steuerung");
            assertThat(publishedChargingDevices()).isEmpty();
        } finally {
            deleteSite(site);
        }
    }

    /**
     * Cockpit Phase 1 / C1: WO eine Ladesäule hängt - vom Anbinde-Dialog bis in
     * die Antwort, und getrennt vom IST, das die Box meldet.
     *
     * <p><b>⚠ SOLL und IST sind zwei Aussagen.</b> Was der Kunde gewählt hat
     * steht in der Allowlist (er kann es setzen, bevor die Säule je verbunden
     * war); was die BOX meldet, belegt, dass die Unterscheidung dort auch
     * angekommen ist - eine Portal-Angabe allein sagt nichts darüber, wonach
     * die Box rechnet. Deshalb zwei Felder in zwei Tabellen, nie eines.
     */
    @Test
    void theOwnConnectionIsChosenInThePortalAndTheBoxReportsItsOwnTruth() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Ladepark-Anschluss");
        try {
            UUID device = claim(customer, site, "edge-ladepark-6");

            // 1 · Der Kunde trägt eine Säule auf EIGENEM Anschluss ein.
            JsonNode saved = postJson("/api/v1/sites/" + site + "/charging-config/charge-points",
                    customer, Map.of("chargePointId", "saeule-strasse", "label", "Strasse",
                            "connection", "eigen"));
            assertThat(saved.get("chargePoints").get(0).get("connection").asText())
                    .isEqualTo("eigen");

            // 2 · Und eine, zu der er nichts sagt - das bleibt null, NIE "haus".
            //     Ein eingesetztes "haus" wäre eine Aussage über die Bilanz der
            //     Anlage, die niemand getroffen hat.
            JsonNode two = postJson("/api/v1/sites/" + site + "/charging-config/charge-points",
                    customer, Map.of("chargePointId", "saeule-halle"));
            assertThat(two.get("chargePoints").get(1).get("connection").isNull()).isTrue();

            // 3 · Ein späterer Wechsel gilt - der Anschluss ist die eine Angabe,
            //     die auch eine schon eingetragene Säule erreicht.
            JsonNode moved = postJson("/api/v1/sites/" + site + "/charging-config/charge-points",
                    customer, Map.of("chargePointId", "saeule-strasse", "connection", "haus"));
            assertThat(moved.get("chargePoints").get(0).get("connection").asText())
                    .isEqualTo("haus");
            assertThat(moved.get("chargePoints").get(0).get("label").asText())
                    .as("und sonst wird nichts zurückgesetzt").isEqualTo("Strasse");

            // 4 · Ein unbekanntes Wort ist eine BENANNTE Ablehnung, nie ein
            //     stiller Rückfall - und sie verändert NICHTS.
            ResponseEntity<String> bad = rest.exchange(
                    url("/api/v1/sites/" + site + "/charging-config/charge-points"),
                    HttpMethod.POST,
                    new HttpEntity<>(Map.of("chargePointId", "saeule-strasse",
                            "connection", "garage"), bearer(customer)),
                    String.class);
            assertThat(bad.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(bad.getBody()).contains("eigen");
            JsonNode after = getJson("/api/v1/sites/" + site + "/charging-config", customer);
            assertThat(after.get("chargePoints")).hasSize(2);
            assertThat(after.get("chargePoints").get(0).get("connection").asText())
                    .isEqualTo("haus");

            // 5 · Das IST kommt aus dem Herzschlag - und eine Säule, deren Box
            //     nichts meldet, bleibt ehrlich null (weder haus noch eigen).
            heartbeat(site, device, connectionStations());
            JsonNode chargers = getJson("/api/v1/sites/" + site + "/chargers", customer);
            assertThat(chargers.get("chargers")).hasSize(2);
            // Nach Kennung nachschlagen, nie nach Position: der Lesepfad
            // sortiert, und ein Test auf einer Reihenfolge prüfte einen Zufall.
            Map<String, JsonNode> byId = new java.util.HashMap<>();
            chargers.get("chargers").forEach(c -> byId.put(c.get("chargePointId").asText(), c));
            assertThat(byId.get("saeule-strasse").get("connection").asText()).isEqualTo("eigen");
            assertThat(byId.get("saeule-halle").get("connection").isNull()).isTrue();
        } finally {
            deleteSite(site);
        }
    }

    /** Eine Box, die den Anschluss meldet - und eine ältere Zeile daneben. */
    private static String connectionStations() {
        return """
                {"reported_at":"2026-08-28T09:15:00Z","enabled":true,"control_enabled":true,
                 "grid_limit_kw":277,"budget_kw":197,"connector_count":2,
                 "chargers":[
                   {"id":"saeule-strasse","connected":true,"ready":true,"connection":"eigen",
                    "connectors":[{"id":1,"status":"Available","charging":false}]},
                   {"id":"saeule-halle","connected":true,"ready":true,
                    "connectors":[{"id":1,"status":"Available","charging":false}]}]}""";
    }

    /**
     * Das ZURÜCKNEHMEN einer eingetragenen Kennung (Captain-Order 24.08.2026:
     * „Ebenso will ich die möglichkeit haben eingebene kennungen zu löschen").
     *
     * <p><b>⚠ Es ist ein GRABSTEIN, kein Löschen.</b> Das retained Dokument wird
     * als Ganzes ersetzt, also würde eine Kennung nur wegzulassen von einer Box,
     * die gerade offline war, nie gesehen ({@code charge_points} fügt nur
     * hinzu). Die Rücknahme muss deshalb dauerhaft geführt und in JEDEM
     * folgenden Dokument genannt werden - genau das prüft dieser Test an der
     * gelesenen Konfiguration.
     */
    @Test
    void anAdmittedChargePointIsWithdrawnAsATombstoneAndReAdmittingRevivesIt() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Ladepark-Loeschen");
        try {
            claim(customer, site, "edge-ladepark-6");
            postJson("/api/v1/sites/" + site + "/charging-config/charge-points", customer,
                    Map.of("chargePointId", "saeule-1", "label", "Hof Nord"));
            postJson("/api/v1/sites/" + site + "/charging-config/charge-points", customer,
                    Map.of("chargePointId", "saeule-2"));

            // 1 · Die Rücknahme nimmt GENAU EINE Kennung - und nennt sie ab
            //     jetzt als Grabstein, damit jede spätere Zustellung sie trägt.
            JsonNode after = deleteJson(
                    "/api/v1/sites/" + site + "/charging-config/charge-points/saeule-2", customer);
            assertThat(after.get("chargePoints")).hasSize(1);
            assertThat(after.get("chargePoints").get(0).get("chargePointId").asText())
                    .isEqualTo("saeule-1");
            assertThat(ids(after.get("removedChargePointIds"))).containsExactly("saeule-2");

            // 2 · Und sie ist DAUERHAFT: ein späteres Speichern der Grenze trägt
            //     sie unverändert mit - eine Box, die gerade offline war, sähe
            //     sie sonst nie.
            JsonNode later = putJson("/api/v1/sites/" + site + "/charging-config", customer,
                    Map.of("gridLimitKw", 277));
            assertThat(ids(later.get("removedChargePointIds"))).containsExactly("saeule-2");
            assertThat(later.get("chargePoints")).hasSize(1);

            // 3 · Erneutes Eintragen BELEBT die Kennung wieder - sie verschwindet
            //     aus der Grabstein-Liste und steht wieder in der Allowlist.
            //     Eine Kennung steht nie in beiden.
            JsonNode revived = postJson(
                    "/api/v1/sites/" + site + "/charging-config/charge-points", customer,
                    Map.of("chargePointId", "saeule-2", "label", "Halle"));
            assertThat(revived.get("removedChargePointIds")).isEmpty();
            assertThat(ids(revived.get("chargePoints").findValues("chargePointId")))
                    .containsExactlyInAnyOrder("saeule-1", "saeule-2");

            // 4 · Eine Kennung, die diese Anlage nicht führt, ist ein 404 - nie
            //     ein stiller Erfolg über etwas, das es nicht gab. Und sie hat
            //     NICHTS verändert.
            ResponseEntity<String> unknown = rest.exchange(
                    url("/api/v1/sites/" + site + "/charging-config/charge-points/gibt-es-nicht"),
                    HttpMethod.DELETE, new HttpEntity<>(bearer(customer)), String.class);
            assertThat(unknown.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
            assertThat(getJson("/api/v1/sites/" + site + "/charging-config", customer)
                    .get("chargePoints")).hasSize(2);

            // 5 · Der Mandanten-Zaun gilt auch hier.
            ResponseEntity<String> foreign = rest.exchange(
                    url("/api/v1/sites/" + site + "/charging-config/charge-points/saeule-1"),
                    HttpMethod.DELETE, new HttpEntity<>(bearer(token("demo2", "demo2"))),
                    String.class);
            assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
            assertThat(getJson("/api/v1/sites/" + site + "/charging-config", customer)
                    .get("chargePoints")).hasSize(2);
        } finally {
            deleteSite(site);
        }
    }

    /**
     * P7 — die FAHRZEUG-PROFILE: dieselbe Säule, zwei Karten, zwei Steuerarten.
     *
     * <p>⚠ Der Schlüssel ist der Pseudonym, den die BOX meldet - der Test fährt
     * ihn deshalb durch den ECHTEN Herzschlag-Zuhörer, statt eine Zeile zu
     * erfinden. Eine Karte, die diese Anlage nie gesehen hat, lässt sich nicht
     * benennen; genau das ist die Regel, die verhindert, dass ein Profil auf
     * einen Bezug entsteht, den kein Fahrzeug je trägt.
     */
    @Test
    void twoCardsAtOneStationCarryTheirOwnSteuerartAndAnUnseenCardCannotBeNamed()
            throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Ladepark-Fahrzeuge");
        try {
            UUID device = claim(customer, site, "edge-ladepark-p7");
            heartbeat(site, device, twoCards());

            // 1 · Beide Karten sind da - GESEHEN, aber noch nicht benannt.
            JsonNode gesehen = getJson("/api/v1/sites/" + site + "/fahrzeuge", customer);
            assertThat(gesehen.get("fahrzeuge")).hasSize(2);
            for (JsonNode f : gesehen.get("fahrzeuge")) {
                assertThat(f.get("name").isNull())
                        .as("eine Sichtung ist noch kein Profil").isTrue();
                assertThat(f.get("steuerart").isNull()).isTrue();
                assertThat(f.get("laedt").asBoolean())
                        .as("beide laden gerade - das sagt der Herzschlag, nicht die Uhr")
                        .isTrue();
                assertThat(f.get("letzterLadepunkt").asText()).isEqualTo("saeule-1");
                assertThat(f.get("ersteSichtungAm").asText()).isNotBlank();
            }

            // 2 · Benennen ALLEIN gibt noch keine Steuerart - „benannt" und
            //     „gesteuert" sind zwei Schritte.
            JsonNode benannt = putJson("/api/v1/sites/" + site + "/fahrzeuge/" + CARD_A, customer,
                    Map.of("name", "  Dienstwagen "));
            JsonNode a = fahrzeug(benannt, CARD_A);
            assertThat(a.get("name").asText()).isEqualTo("Dienstwagen");
            assertThat(a.get("steuerart").isNull()).isTrue();

            // 3 · Die Steuerart: eine Karte sofort, die andere auf Sonne.
            putJson("/api/v1/sites/" + site + "/fahrzeuge/" + CARD_A, customer,
                    Map.of("quelle", "sofort"));
            JsonNode nachB = putJson("/api/v1/sites/" + site + "/fahrzeuge/" + CARD_B, customer,
                    Map.of("name", "Privatwagen", "quelle", "ueberschuss",
                            "ueberschussModus", "mindestleistung", "mindestleistungKw", 4.2));
            assertThat(fahrzeug(nachB, CARD_A).get("steuerart").get("quelle").asText())
                    .isEqualTo("sofort");
            JsonNode b = fahrzeug(nachB, CARD_B);
            assertThat(b.get("name").asText()).isEqualTo("Privatwagen");
            assertThat(b.get("steuerart").get("quelle").asText()).isEqualTo("ueberschuss");
            assertThat(b.get("steuerart").get("ueberschussModus").asText())
                    .isEqualTo("mindestleistung");
            assertThat(b.get("steuerart").get("mindestleistungKw").asDouble()).isEqualTo(4.2);
            // Der NAME des ersten Fahrzeugs hat den zweiten Schreibvorgang
            // überlebt: ein Feld, das der Wunsch nicht nennt, wird nicht
            // angefasst (die PATCH-Regel dieses Pfads).
            assertThat(fahrzeug(nachB, CARD_A).get("name").asText()).isEqualTo("Dienstwagen");

            // 3b · Der WEG ZURÜCK ohne den Namen zu verlieren: „Lädt wie der
            //      Ladepunkt" ist eine ausdrückliche Wahl (leere Quelle), und
            //      sie muss die gespeicherte Bahn wirklich räumen - sonst
            //      verspräche der Dialog etwas, das der Server nicht tut.
            JsonNode zurueckZurSaeule = putJson(
                    "/api/v1/sites/" + site + "/fahrzeuge/" + CARD_A, customer,
                    Collections.singletonMap("quelle", ""));
            JsonNode aOhne = fahrzeug(zurueckZurSaeule, CARD_A);
            assertThat(aOhne.get("steuerart").isNull()).isTrue();
            assertThat(aOhne.get("name").asText())
                    .as("der Weg zurück kostet nie den Namen").isEqualTo("Dienstwagen");
            // Und wieder hin - der Rückweg ist keine Sackgasse.
            putJson("/api/v1/sites/" + site + "/fahrzeuge/" + CARD_A, customer,
                    Map.of("quelle", "sofort"));

            // 4 · Die Rücknahme nimmt das PROFIL, nicht die Sichtung.
            JsonNode zurueck = deleteJson("/api/v1/sites/" + site + "/fahrzeuge/" + CARD_A,
                    customer);
            JsonNode aZurueck = fahrzeug(zurueck, CARD_A);
            assertThat(aZurueck.get("steuerart").isNull()).isTrue();
            assertThat(aZurueck.get("name").isNull()).isTrue();
            assertThat(aZurueck.get("letzteSichtungAm").asText())
                    .as("eine Rücknahme ist keine Beweisvernichtung").isNotBlank();
            assertThat(zurueck.get("fahrzeuge")).hasSize(2);

            // 5 · Eine Karte, die diese Anlage nie gesehen hat, lässt sich nicht
            //     benennen - ein Profil darauf träfe nie ein Auto.
            ResponseEntity<String> fremd = rest.exchange(
                    url("/api/v1/sites/" + site + "/fahrzeuge/tagref_999999999999999999999999"),
                    HttpMethod.PUT, new HttpEntity<>(Map.of("name", "Geist"), bearer(customer)),
                    String.class);
            assertThat(fremd.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

            // 6 · Und was kein Pseudonym DIESER Box sein kann, ist ein 400 mit
            //     Grund - ein Klartext-IdTag darf hier gar nicht erst ankommen.
            ResponseEntity<String> klartext = rest.exchange(
                    url("/api/v1/sites/" + site + "/fahrzeuge/RIG-TAG"), HttpMethod.PUT,
                    new HttpEntity<>(Map.of("name", "Geist"), bearer(customer)), String.class);
            assertThat(klartext.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(klartext.getBody()).contains("Kennung");

            // 7 · „Günstige Stunden" wird BEIM NAMEN abgelehnt: ein Preisfenster
            //     gehört zum Ladepunkt, nicht zur Karte.
            ResponseEntity<String> ziel = rest.exchange(
                    url("/api/v1/sites/" + site + "/fahrzeuge/" + CARD_B), HttpMethod.PUT,
                    new HttpEntity<>(Map.of("quelle", "guenstig"), bearer(customer)), String.class);
            assertThat(ziel.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(ziel.getBody()).contains("Ladepunkt");
            // Und der Wunsch hat NICHTS geändert.
            assertThat(fahrzeug(getJson("/api/v1/sites/" + site + "/fahrzeuge", customer), CARD_B)
                    .get("steuerart").get("quelle").asText()).isEqualTo("ueberschuss");

            // 8 · Der Mandanten-Zaun: eine fremde Anlage ist 404, nie 403.
            ResponseEntity<String> foreign = rest.exchange(
                    url("/api/v1/sites/" + site + "/fahrzeuge"), HttpMethod.GET,
                    new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class);
            assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        } finally {
            deleteSite(site);
        }
    }

    private static final String CARD_A = "tagref_1f2e3d4c5b6a798877665544";
    private static final String CARD_B = "tagref_00112233445566778899aabb";

    private static JsonNode fahrzeug(JsonNode doc, String tagRef) {
        for (JsonNode f : doc.get("fahrzeuge")) {
            if (tagRef.equals(f.get("tagRef").asText())) {
                return f;
            }
        }
        throw new AssertionError("kein Fahrzeug " + tagRef + " in " + doc);
    }

    /** Eine Saeule, an der zwei verschiedene Karten laden. */
    private static String twoCards() {
        return """
                {"reported_at":"2026-08-31T09:00:00Z","enabled":true,"control_enabled":true,
                 "grid_limit_kw":32,"budget_kw":28,"connector_count":2,
                 "chargers":[
                   {"id":"saeule-1","label":"Hof Nord","connected":true,"ready":true,
                    "connectors":[
                      {"id":1,"status":"Charging","charging":true,"power_kw":11,
                       "session_since":"2026-08-31T08:41:00Z",
                       "tag_ref":"tagref_1f2e3d4c5b6a798877665544"},
                      {"id":2,"status":"Charging","charging":true,"power_kw":4.2,
                       "session_since":"2026-08-31T08:50:00Z",
                       "tag_ref":"tagref_00112233445566778899aabb"}]}]}""";
    }

    private static java.util.List<String> ids(JsonNode array) {
        java.util.List<String> out = new java.util.ArrayList<>();
        array.forEach(n -> out.add(n.asText()));
        return out;
    }

    private static java.util.List<String> ids(java.util.List<JsonNode> nodes) {
        java.util.List<String> out = new java.util.ArrayList<>();
        nodes.forEach(n -> out.add(n.asText()));
        return out;
    }

    /** Eine Box, die ihren OCPP-Endpunkt meldet. */
    private static String endpointStations() {
        return """
                {"reported_at":"2026-08-21T09:15:00Z","enabled":true,"control_enabled":true,
                 "ocpp_port":8887,"url_path":"/ocpp",
                 "grid_limit_kw":277,"budget_kw":197,"connector_count":1,
                 "chargers":[
                   {"id":"saeule-hof-nord","label":"Hof Nord","connected":true,"ready":true,
                    "connectors":[{"id":1,"status":"Available","charging":false}]}]}""";
    }

    /** Eine zweite Box meldet ihren OCPP-Anschluss, aber keinen Ladepunkt. */
    private static String noStationsEndpoint() {
        return """
                {"reported_at":"2026-08-21T09:16:00Z","enabled":true,"control_enabled":true,
                 "ocpp_port":8890,"url_path":"/ocpp","grid_limit_kw":277,
                 "budget_kw":197,"connector_count":0,"chargers":[]}""";
    }

    /** Eine Anlage mit laufender Quellen-Bahn und EINER Übersteuerung. */
    private static String surplusStations() {
        return """
                {"reported_at":"2026-08-20T13:24:00Z","enabled":true,"control_enabled":true,
                 "grid_limit_kw":277,"margin_pct":10,"min_power_kw":30,"budget_kw":197,
                 "allocated_kw":110,"measured_kw":110,"connector_count":2,
                 "surplus_policy":"nur_sonne","storage_priority":"auto_vor_speicher",
                 "surplus_active":true,"surplus_kw":65,"surplus_mode":"gemessen",
                 "surplus_note":"Ihre Priorität: Nur Sonnenstrom. Für die Fahrzeuge stehen gerade 65,0 kW Sonnenüberschuss zur Verfügung.",
                 "surplus_total_kw":85,"surplus_battery_kw":20,"source_allocated_kw":65,
                 "chargers":[
                   {"id":"saeule-1","label":"Hof Nord","connected":true,"ready":true,
                    "last_seen":"2026-08-20T13:23:55Z",
                    "connectors":[
                      {"id":1,"status":"Charging","charging":true,"allocated_kw":45,
                       "reason":"laedt","reason_text":"lädt","power_kw":45,"boost":true,
                       "session_since":"2026-08-20T12:41:00Z"},
                      {"id":2,"status":"Available","charging":false}]}]}""";
    }

    /**
     * Die „lastmanagement"-Karte.
     *
     * <p>⚠ Sie wohnt seit dem Verbrauchsmanagement v1 in {@code weitere}, nicht
     * mehr im Regal: der Ladepark ist SCHUTZ und laeuft immer, seinen Platz in
     * der Betriebsmodell-Zone nimmt der Ladepark-Rahmen der Verbraucher-Zone
     * ein. Ihr ZUSTAND wird weiter beantwortet - ausgeblendet ist nicht
     * geloescht.
     */
    private JsonNode profileCard(String token, UUID site) throws Exception {
        JsonNode shelf = getJson("/api/v1/sites/" + site + "/profiles", token);
        for (String feld : List.of("profiles", "weitere")) {
            for (JsonNode p : shelf.get(feld)) {
                if ("lastmanagement".equals(p.get("id").asText())) {
                    return p;
                }
            }
        }
        throw new AssertionError("keine Lastmanagement-Karte: " + shelf);
    }

    private JsonNode postJson(String path, String token, Map<String, Object> body)
            throws Exception {
        ResponseEntity<String> res = rest.exchange(url(path), HttpMethod.POST,
                new HttpEntity<>(body, bearer(token)), String.class);
        assertThat(res.getStatusCode()).as("POST %s -> %s", path, res.getBody())
                .isEqualTo(HttpStatus.OK);
        return json.readTree(res.getBody());
    }

    private List<UUID> publishedChargingDevices() {
        return org.mockito.Mockito.mockingDetails(chargingConfigPublisher).getInvocations().stream()
                .filter(invocation -> invocation.getMethod().getName().equals("publish"))
                .map(invocation -> invocation.<UUID>getArgument(2))
                .toList();
    }

    private JsonNode putJson(String path, String token, Map<String, Object> body) throws Exception {
        ResponseEntity<String> res = rest.exchange(url(path), HttpMethod.PUT,
                new HttpEntity<>(body, bearer(token)), String.class);
        assertThat(res.getStatusCode()).as("PUT %s -> %s", path, res.getBody())
                .isEqualTo(HttpStatus.OK);
        return json.readTree(res.getBody());
    }

    private JsonNode deleteJson(String path, String token) throws Exception {
        ResponseEntity<String> res = rest.exchange(url(path), HttpMethod.DELETE,
                new HttpEntity<>(bearer(token)), String.class);
        assertThat(res.getStatusCode()).as("DELETE %s -> %s", path, res.getBody())
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
        // ⚠ Die Ladekarten-Sichtungen (P7) laufen ueber die ECHTE Repository:
        // ohne sie gaebe es im Portal keine Zeile, der ein Name gegeben werden
        // koennte - der Test soll genau diesen Weg fahren, nicht eine Attrappe.
        @SuppressWarnings("unchecked")
        ObjectProvider<com.voltpilot.api.fahrzeuge.SiteVehicleRepository> vehicleProvider =
                org.mockito.Mockito.mock(ObjectProvider.class);
        org.mockito.Mockito.when(vehicleProvider.getIfAvailable()).thenReturn(vehicles);
        ChargerStatusListener listener = new ChargerStatusListener("tcp://unused", "", "", devices,
                chargerStatus, provider, logProvider, vehicleProvider);
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
