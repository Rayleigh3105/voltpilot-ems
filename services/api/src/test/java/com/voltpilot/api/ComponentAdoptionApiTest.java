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
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.ResultSet;
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
    com.voltpilot.api.components.ComponentConnectionReceipts receipts;

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
    /**
     * DIE HEILUNG (Anlage Pilsting/Herzogau, Update edge-2026.08.5 -&gt; .10):
     * dieselben Wechselrichter melden sich unter neuen Quellen-Kennungen, beide
     * Komponenten sind „nicht mehr mit einem gemeldeten Gerät verbunden" - und
     * der nächste Takt verbindet sie wieder, ohne einen Klick und ohne dass
     * jemand raten muss, welcher Fronius welcher ist.
     */
    @Test
    void aBrokenBindingHealsItselfOnTheNextHeartbeatWithoutGuessing() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Herzogau-Anlage");
        try {
            UUID device = claim(customer, site, "edge-herzogau-1");
            saveBattery(customer, site);
            setAuthority(site, ComponentAuthority.BOX);
            heartbeat(site, device, fullReport());
            assertThat(adoptAsTenant(site).adopted()).isTrue();

            String wr1 = componentIdOfSource(site, customer, "src-fronius-1");
            String wr2 = componentIdOfSource(site, customer, "src-fronius-2");

            // Das Update: dieselben Geräte, neue Kennungen.
            heartbeat(site, device, reportWithRenamedSourceIds());

            // Der Riss ist echt: beide Pins zeigen ins Leere.
            assertThat(orphanedSourceIds(site, customer))
                    .as("beide Komponenten haben ihre Bindung verloren")
                    .containsExactlyInAnyOrder("src-fronius-1", "src-fronius-2");

            // Der getaktete Abgleich heilt sie.
            ComponentAdoptionRunner.RebindSummary healed = runner.heal();
            assertThat(healed.rebound()).isEqualTo(2);
            assertThat(healed.failed()).isZero();

            // Und zwar JEDE an IHR eigenes Gerät: die zwei Einheiten hinter
            // derselben IP werden über die Unit-Id auseinandergehalten.
            assertThat(componentIdOfSource(site, customer, "src-tdaejmjs")).isEqualTo(wr1);
            assertThat(componentIdOfSource(site, customer, "src-67w4nbhh")).isEqualTo(wr2);
            assertThat(orphanedSourceIds(site, customer))
                    .as("keine verwaiste Bindung mehr").isEmpty();

            // Kein zweiter Lauf tut noch etwas - eine lebende Bindung wird nie
            // angefasst.
            assertThat(runner.heal().rebound()).isZero();

            // Und der Pin reist im Push mit, damit auch die Box wieder richtig
            // zuordnet.
            JsonNode push = pushJson(site);
            assertThat(edgeSourceIdsOfPush(push))
                    .contains("src-tdaejmjs", "src-67w4nbhh");
        } finally {
            deleteSite(site);
        }
    }

    /**
     * Was NICHT entschieden werden kann, wird nicht entschieden: melden sich
     * zwei ununterscheidbare Geräte unter neuen Kennungen, bleibt die Zuordnung
     * verwaist und sichtbar - lieber der manuelle Weg als ein Geister-Erzeuger.
     */
    @Test
    void anAmbiguousRenameIsLeftToTheOperator() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Mehrdeutig-Anlage");
        try {
            UUID device = claim(customer, site, "edge-herzogau-2");
            saveBattery(customer, site);
            setAuthority(site, ComponentAuthority.BOX);
            heartbeat(site, device, fullReport());
            assertThat(adoptAsTenant(site).adopted()).isTrue();

            // Beide Fronius melden sich neu - und beide auf DERSELBEN Unit-Id.
            heartbeat(site, device, reportWithRenamedSourceIds()
                    .replace("\"unit_id\":2", "\"unit_id\":1"));

            assertThat(runner.heal().rebound())
                    .as("eine unentscheidbare Zuordnung wird nie geraten").isZero();
            assertThat(orphanedSourceIds(site, customer))
                    .containsExactlyInAnyOrder("src-fronius-1", "src-fronius-2");
        } finally {
            deleteSite(site);
        }
    }

    /**
     * ALIAS-KONTINUITÄT über ALLE DREI Reparatur-/Anlege-Strecken (Live-Fall
     * Anlage Pilsting/Herzogau, 20.08.2026 - Captain: „beim neu hinzufügen sind
     * die Aliase jetzt weg").
     *
     * <p>Der Kunde nennt seine beiden Wechselrichter „Fronius Anlage WR1" und
     * „Dach Nord". Danach reißt die Identität - und der Name muss JEDEN Weg
     * überleben, auf dem die Bindung repariert oder das Gerät neu angelegt wird:
     *
     * <ol>
     *   <li><b>Auto-Rebind</b> (PR 425, der getaktete Abgleich),</li>
     *   <li><b>„Wieder verbinden"</b> (der manuelle Re-Pin des Kunden),</li>
     *   <li><b>die Bestands-Übernahme</b> - der Weg, der ihn wirklich verloren
     *       hat: sie fand unter der NEUEN Kennung keine Zeile, die komponierte
     *       war an eine andere gepinnt, und legte eine ZWEITE Komponente mit dem
     *       vom Gerät gemeldeten Namen an. Jetzt übernimmt sie die verwaiste.</li>
     * </ol>
     */
    @Test
    void theCustomerNameSurvivesEveryRepairPathAndTheTakeoverNeverDuplicates() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Alias-Anlage");
        try {
            UUID device = claim(customer, site, "edge-alias-1");
            saveBattery(customer, site);
            setAuthority(site, ComponentAuthority.BOX);
            heartbeat(site, device, fullReport());
            assertThat(adoptAsTenant(site).adopted()).isTrue();

            String wr1 = componentIdOfSource(site, customer, "src-fronius-1");
            String wr2 = componentIdOfSource(site, customer, "src-fronius-2");
            BigDecimal kwpNachUebernahme = plantKwp(site);

            // --- Der Kunde gibt seinen Komponenten EIGENE Namen -------------
            rename(site, customer, wr1, "Fronius Anlage WR1");
            rename(site, customer, wr2, "Dach Nord");
            assertThat(labelOf(site, customer, wr1)).isEqualTo("Fronius Anlage WR1");

            // --- (b) AUTO-REBIND: der Riss heilt sich, der Name bleibt ------
            heartbeat(site, device, reportWithRenamedSourceIds());
            assertThat(runner.heal().rebound()).isEqualTo(2);
            assertThat(labelOf(site, customer, wr1))
                    .as("der Auto-Rebind fasst den Namen nicht an")
                    .isEqualTo("Fronius Anlage WR1");
            assertThat(labelOf(site, customer, wr2)).isEqualTo("Dach Nord");

            // --- (a) „WIEDER VERBINDEN": der manuelle Re-Pin ----------------
            // Ein Riss, den die Regel NICHT entscheiden kann (beide Fronius auf
            // derselben Unit-Id) - genau dann bleibt nur der Klick des Kunden.
            heartbeat(site, device, reportWithRenamedSourceIds()
                    .replace("src-tdaejmjs", "src-hand-1")
                    .replace("src-67w4nbhh", "src-hand-2")
                    .replace("\"unit_id\":2", "\"unit_id\":1"));
            assertThat(runner.heal().rebound())
                    .as("mehrdeutig - die Automatik entscheidet nichts").isZero();

            ResponseEntity<String> repinned = post(
                    "/api/v1/sites/" + site + "/v2-entities/" + wr1 + "/edge-source", customer,
                    Map.of("sourceId", "src-hand-1"));
            assertThat(repinned.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(json.readTree(repinned.getBody()).get("label").asText())
                    .as("Wieder verbinden gibt den Namen unverändert zurück")
                    .isEqualTo("Fronius Anlage WR1");
            assertThat(labelOf(site, customer, wr1)).isEqualTo("Fronius Anlage WR1");

            // --- (c) DIE BESTANDS-ÜBERNAHME --------------------------------
            // Dieselbe Anlage, wieder box-verwaltet, und die Box meldet erneut
            // NEUE Kennungen. Vor dem Fix entstanden hier zwei namenlose
            // Parallel-Komponenten; jetzt wird die verwaiste übernommen.
            setAuthority(site, ComponentAuthority.BOX);
            heartbeat(site, device, fullReport()
                    .replace("src-fronius-1", "src-uebernahme-1")
                    .replace("src-fronius-2", "src-uebernahme-2"));
            assertThat(adoptAsTenant(site).adopted()).isTrue();

            assertThat(producerIds(site, customer))
                    .as("KEINE Parallel-Komponente - es bleiben genau die zwei")
                    .containsExactlyInAnyOrder(wr1, wr2);
            assertThat(labelOf(site, customer, wr1))
                    .as("die Übernahme meldet Fronius 1 - der KUNDENNAME gewinnt")
                    .isEqualTo("Fronius Anlage WR1");
            assertThat(labelOf(site, customer, wr2)).isEqualTo("Dach Nord");
            assertThat(componentIdOfSource(site, customer, "src-uebernahme-1")).isEqualTo(wr1);
            assertThat(componentIdOfSource(site, customer, "src-uebernahme-2")).isEqualTo(wr2);
            assertThat(plantKwp(site))
                    .as("und die kWp der Anlage zählen nicht doppelt")
                    .isEqualByComparingTo(kwpNachUebernahme);
        } finally {
            deleteSite(site);
        }
    }

    /**
     * Der DRITTE Weg desselben Lochs: „Komponente hinzufügen" im Anlege-Weg.
     *
     * <p>Er legte bisher IMMER eine neue Erzeuger-Zeile an - auch wenn genau
     * dieses Gerät daneben verwaist lag. Jetzt übernimmt er sie, und der
     * VORSCHLAG dafür ist vor dem Klick abrufbar ({@code /component-match}), so
     * dass der Assistent sagen kann, was gleich passiert.
     */
    @Test
    void theAssistantTakesOverTheOrphanedComponentInsteadOfMintingAParallelOne() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Assistent-Alias-Anlage");
        try {
            UUID device = claim(customer, site, "edge-alias-2");
            saveBattery(customer, site);
            setAuthority(site, ComponentAuthority.BOX);
            heartbeat(site, device, singleFroniusReport());
            assertThat(adoptAsTenant(site).adopted()).isTrue();

            String wr = componentIdOfSource(site, customer, "src-fronius-1");
            rename(site, customer, wr, "Dach Süd");
            BigDecimal kwpVorher = plantKwp(site);

            // Der Riss: die Box meldet dasselbe Gerät unter neuer Kennung, und
            // die Anlage ist portal-verwaltet (der Assistent ist der Weg).
            heartbeat(site, device, singleFroniusReport()
                    .replace("src-fronius-1", "src-neu-1"));
            assertThat(orphanedSourceIds(site, customer)).containsExactly("src-fronius-1");

            Map<String, Object> conn = froniusConnection();

            // Der VORSCHLAG vor dem Klick nennt die vorhandene Komponente.
            ResponseEntity<String> match = post("/api/v1/sites/" + site + "/component-match",
                    customer, Map.of("templateRef", FRONIUS_TEMPLATE, "role", "pv-generation",
                            "connection", conn));
            assertThat(match.getStatusCode()).isEqualTo(HttpStatus.OK);
            JsonNode hit = json.readTree(match.getBody());
            assertThat(hit.get("entityId").asText()).isEqualTo(wr);
            assertThat(hit.get("label").asText()).isEqualTo("Dach Süd");
            assertThat(hit.get("orphaned").asBoolean()).isTrue();

            // Und das Speichern tut genau das - OHNE Namensfeld, wie der
            // Assistent es seit dem Fix schickt.
            receipts.record(site, FRONIUS_TEMPLATE, 1, conn);
            ResponseEntity<String> created = post("/api/v1/sites/" + site + "/components",
                    customer, saveBody(FRONIUS_TEMPLATE, "pv-generation", conn, null));
            assertThat(created.getStatusCode()).isEqualTo(HttpStatus.OK);

            assertThat(producerIds(site, customer))
                    .as("keine zweite Zeile - die verwaiste wurde übernommen")
                    .containsExactly(wr);
            assertThat(labelOf(site, customer, wr))
                    .as("und sie behält ihren Namen")
                    .isEqualTo("Dach Süd");
            assertThat(plantKwp(site)).isEqualByComparingTo(kwpVorher);

            // Ein AUSDRÜCKLICH getippter Name gewinnt weiterhin.
            receipts.record(site, FRONIUS_TEMPLATE, 1, conn);
            assertThat(post("/api/v1/sites/" + site + "/components", customer,
                    saveBody(FRONIUS_TEMPLATE, "pv-generation", conn, "Dach Süd-West"))
                    .getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(labelOf(site, customer, wr)).isEqualTo("Dach Süd-West");
        } finally {
            deleteSite(site);
        }
    }

    /**
     * DIE HEILUNG des schon eingetretenen Schadens (Anlage Pilsting/Herzogau,
     * 20.08.2026): der Kunde hat nach dem Riss eine PARALLELE Komponente
     * angelegt, sein Name steht seither auf der verwaisten daneben.
     *
     * <p>Der Befund, den der PR-Rumpf trägt: <b>der Name ist NICHT verloren</b> -
     * er liegt auf der alten Zeile. Dieser Test fährt beide Reparatur-Wege und
     * beweist, dass sie ihn zurückholen, ohne dass jemand etwas abtippt:
     *
     * <ol>
     *   <li>Doppelte LÖSCHEN → der getaktete Abgleich verbindet die verwaiste
     *       Komponente von selbst wieder (kein Klick).</li>
     *   <li>TAUSCHEN („Zuordnung ändern") → der Name steht sofort wieder am
     *       richtigen Gerät.</li>
     * </ol>
     *
     * <p><b>⚠ Die REIHENFOLGE war früher nicht frei, jetzt ist sie es</b>
     * (Captain-Entscheid E2, vp-komp-loeschen): nach einem Tausch trägt die
     * freigegebene Doppelte KEINEN Pin mehr. Der Grundausstattungs-Zaun des
     * Kunden-Löschens (`SiteEntityAdoptController.delete`) verweigerte deshalb
     * jede pinlose Zeile - zu grob, denn ein vom Kunden angelegter Erzeuger ist
     * keine Grundausstattung. Der Zaun ist auf die plattform-SYNTHETISIERTEN
     * Zeilen verengt ({@code source_kind = 'composed'}), also lässt sich die
     * Doppelte jetzt auch nach dem Tausch entfernen.
     */
    @Test
    void theStrandedCustomerNameComesBackOnBothRepairPathsWithoutRetyping() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Herzogau-Heilung");
        try {
            UUID device = claim(customer, site, "edge-alias-3");
            saveBattery(customer, site);
            setAuthority(site, ComponentAuthority.BOX);
            heartbeat(site, device, fullReport());
            assertThat(adoptAsTenant(site).adopted()).isTrue();

            String wr1 = componentIdOfSource(site, customer, "src-fronius-1");
            String wr2 = componentIdOfSource(site, customer, "src-fronius-2");
            rename(site, customer, wr1, "Fronius Anlage WR1");
            rename(site, customer, wr2, "Dach Nord");

            // Der Riss - und der Schaden, wie er entstanden IST: der Kunde legt
            // die gemeldeten Geräte als NEUE Komponenten an.
            heartbeat(site, device, reportWithRenamedSourceIds());
            String dup1 = adoptAsNew(site, customer, "src-tdaejmjs", "Fronius 1");
            String dup2 = adoptAsNew(site, customer, "src-67w4nbhh", "Fronius 2");
            assertThat(producerIds(site, customer))
                    .as("der Schaden: vier Erzeuger statt zwei")
                    .containsExactlyInAnyOrder(wr1, wr2, dup1, dup2);
            assertThat(labelOf(site, customer, wr1))
                    .as("der Kundenname ist NICHT verloren - er steht auf der verwaisten Zeile")
                    .isEqualTo("Fronius Anlage WR1");

            // --- Weg 1: Doppelte löschen, der Takt heilt den Rest ------------
            assertThat(deleteComponent(site, customer, dup1).getStatusCode())
                    .isEqualTo(HttpStatus.NO_CONTENT);
            assertThat(runner.heal().rebound())
                    .as("die freigewordene Kennung findet ihre Komponente von selbst")
                    .isEqualTo(1);
            assertThat(componentIdOfSource(site, customer, "src-tdaejmjs")).isEqualTo(wr1);
            assertThat(labelOf(site, customer, wr1)).isEqualTo("Fronius Anlage WR1");

            // --- Weg 2: TAUSCHEN - der Name steht sofort wieder am Gerät ------
            ResponseEntity<String> swapped = post(
                    "/api/v1/sites/" + site + "/v2-entities/" + wr2 + "/edge-source", customer,
                    Map.of("sourceId", "src-67w4nbhh", "swap", true));
            assertThat(swapped.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(componentIdOfSource(site, customer, "src-67w4nbhh")).isEqualTo(wr2);
            assertThat(labelOf(site, customer, wr2)).isEqualTo("Dach Nord");

            // ⚠ Und die frühere Grenze, jetzt aufgehoben (E2): die freigegebene,
            // pinlose Doppelte lässt sich DANACH ebenfalls entfernen - sie ist
            // kein synthetisierter Grundausstattungs-Zähler.
            assertThat(deleteComponent(site, customer, dup2).getStatusCode())
                    .as("ein pinloser Kunden-Erzeuger ist löschbar (E2)")
                    .isEqualTo(HttpStatus.NO_CONTENT);
            assertThat(labelOf(site, customer, wr1))
                    .as("beide Kundennamen sind zurück")
                    .isEqualTo("Fronius Anlage WR1");
        } finally {
            deleteSite(site);
        }
    }

    // ---- Löschen: die vier Captain-Entscheide (vp-komp-loeschen) -----------

    /**
     * E2: ein vom Kunden angelegter, NIE verbundener Erzeuger ist löschbar.
     * Früher wies der Grundausstattungs-Zaun jede pinlose Zeile mit 422 ab; jetzt
     * greift er nur noch für die plattform-synthetisierten Zeilen
     * ({@code source_kind = 'composed'}). Ein Erzeuger trägt diesen Stempel nie.
     */
    @Test
    void aCustomerProducerWithoutADevicePinIsNowDeletable() {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "E2-Erzeuger-ohne-Pin");
        try {
            UUID pid = UUID.randomUUID();
            exec("INSERT INTO measurement_point (id, tenant_id, site_id, role, label, control, "
                    + "entity_type, capabilities, guard_config) VALUES ('" + pid + "','" + TENANT_A
                    + "','" + site + "','pv-generation','PV Scheune', FALSE, 'producer', "
                    + "'{\"measure\":[{\"channel\":\"pv_power_kw\"}]}'::jsonb, '{}'::jsonb)");
            assertThat(count("SELECT count(*) FROM measurement_point WHERE id = '" + pid + "'"))
                    .isEqualTo(1);
            assertThat(deleteComponent(site, customer, pid.toString()).getStatusCode())
                    .as("nie verbundener Kunden-Erzeuger ist löschbar (E2)")
                    .isEqualTo(HttpStatus.NO_CONTENT);
            assertThat(count("SELECT count(*) FROM measurement_point WHERE id = '" + pid + "'"))
                    .isZero();
        } finally {
            deleteSite(site);
        }
    }

    /**
     * E1 + E3: „Batterie am Standort abmelden" entfernt die drei Dinge zusammen -
     * den {@code asset}-Nennwert (den der Optimierer liest), die {@code
     * flow_claim}-Waise und die Entität -, lässt die aufgezeichneten Messwerte
     * aber STEHEN. Ohne den asset-Rückbau plante der Optimierer eine
     * Phantom-Batterie weiter (Report §4c); ohne die Messwerte verlöre die Anlage
     * ihre Historie (E3, „Ehrlichkeit der Zahlen").
     */
    @Test
    void unregisteringTheBatteryDropsAssetAndClaimButKeepsTheRecordedTelemetry() {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "E1-Batterie-abmelden");
        try {
            UUID device = claim(customer, site, "edge-e1-1");
            saveBattery(customer, site); // komponiert die battery-hybrid-Zeile
            String hybrid = entityIdByRole(site, "battery-hybrid");
            assertThat(hybrid).as("die Batterie ist komponiert").isNotNull();

            // Eine Regel hält den Speicher, und es liegen Messwerte vor.
            exec("INSERT INTO flow_claim (entity_id, command, tenant_id, site_id, flow_id, "
                    + "flow_version, flow_name) VALUES ('" + hybrid + "','setpoint_kw','" + TENANT_A
                    + "','" + site + "','" + UUID.randomUUID() + "', 1, 'Speicherregel')");
            exec("INSERT INTO telemetry_v2 (time, tenant_id, site_id, device_id, entity_id, "
                    + "channel, value) VALUES (now(), '" + TENANT_A + "','" + site + "','" + device
                    + "','" + hybrid + "','soc_pct', 55.0)");
            assertThat(count("SELECT count(*) FROM asset WHERE site_id = '" + site
                    + "' AND type = 'battery'")).isEqualTo(1);

            assertThat(rest.exchange(url("/api/v1/sites/" + site + "/battery"), HttpMethod.DELETE,
                    new HttpEntity<>(bearer(customer)), String.class).getStatusCode())
                    .isEqualTo(HttpStatus.OK);

            assertThat(count("SELECT count(*) FROM asset WHERE site_id = '" + site
                    + "' AND type = 'battery'"))
                    .as("Nennwerte weg - keine Phantom-Batterie im Optimierer").isZero();
            assertThat(count("SELECT count(*) FROM measurement_point WHERE id = '" + hybrid + "'"))
                    .as("Entität entfernt").isZero();
            assertThat(count("SELECT count(*) FROM flow_claim WHERE entity_id = '" + hybrid + "'"))
                    .as("Regel-Beanspruchung aufgeräumt").isZero();
            assertThat(count("SELECT count(*) FROM telemetry_v2 WHERE entity_id = '" + hybrid + "'"))
                    .as("aufgezeichnete Messwerte bleiben (E3)").isEqualTo(1);
        } finally {
            deleteSite(site);
        }
    }

    /**
     * E1-Grenze: nur {@code battery-hybrid} bekommt den neuen Weg. Der
     * Hausverbrauch bleibt für den Kunden geschützt (er ist aus den Stammdaten
     * synthetisiert), der Entitäts-Löschweg weist ihn weiter mit 422 ab.
     */
    @Test
    void theHouseLoadStaysProtectedFromCustomerDelete() {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "E1-Hausverbrauch-geschuetzt");
        try {
            UUID pid = UUID.randomUUID();
            exec("INSERT INTO measurement_point (id, tenant_id, site_id, role, label, control, "
                    + "entity_type, source_kind, capabilities, guard_config) VALUES ('" + pid
                    + "','" + TENANT_A + "','" + site + "','house-load','Hausverbrauch', FALSE, "
                    + "'house-load','composed', '{\"measure\":[{\"channel\":\"power_kw\"}]}'::jsonb, "
                    + "'{}'::jsonb)");
            assertThat(deleteComponent(site, customer, pid.toString()).getStatusCode())
                    .as("house-load bleibt geschützt").isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
            assertThat(count("SELECT count(*) FROM measurement_point WHERE id = '" + pid + "'"))
                    .isEqualTo(1);
        } finally {
            deleteSite(site);
        }
    }

    /** Ein Zähler über den Superuser (RLS-frei) für Aufbau und Prüfung. */
    private void exec(String sql) {
        try (Connection c = superuser(); Statement st = c.createStatement()) {
            st.execute(sql);
        } catch (SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    private long count(String sql) {
        try (Connection c = superuser(); Statement st = c.createStatement();
                ResultSet rs = st.executeQuery(sql)) {
            rs.next();
            return rs.getLong(1);
        } catch (SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    private String entityIdByRole(UUID site, String role) {
        try (Connection c = superuser(); Statement st = c.createStatement();
                ResultSet rs = st.executeQuery("SELECT id FROM measurement_point WHERE site_id = '"
                        + site + "' AND role = '" + role + "'")) {
            return rs.next() ? rs.getString(1) : null;
        } catch (SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Legt eine gemeldete Quelle als NEUE Komponente an (der Schadens-Weg). */
    private String adoptAsNew(UUID site, String token, String sourceId, String label)
            throws Exception {
        ResponseEntity<String> res = post("/api/v1/sites/" + site + "/v2-entities/adopt", token,
                Map.of("sourceId", sourceId, "entityType", "producer", "label", label));
        assertThat(res.getStatusCode()).as("übernehmen").isEqualTo(HttpStatus.OK);
        return json.readTree(res.getBody()).get("id").asText();
    }

    private ResponseEntity<String> deleteComponent(UUID site, String token, String entityId) {
        return rest.exchange(url("/api/v1/sites/" + site + "/v2-entities/" + entityId),
                HttpMethod.DELETE, new HttpEntity<>(bearer(token)), String.class);
    }

    /** Der Kunde benennt eine Komponente um (die Alias-Route). */
    private void rename(UUID site, String token, String entityId, String label) {
        ResponseEntity<String> res = rest.exchange(
                url("/api/v1/sites/" + site + "/v2-entities/" + entityId + "/label"),
                HttpMethod.PUT, new HttpEntity<>(Map.of("label", label), bearer(token)),
                String.class);
        assertThat(res.getStatusCode()).as("umbenennen").isEqualTo(HttpStatus.OK);
    }

    /** Der Name, den eine Komponente GERADE trägt. */
    private String labelOf(UUID site, String token, String entityId) throws Exception {
        for (JsonNode row : getJson("/api/v1/sites/" + site + "/components", token)
                .get("components")) {
            if (entityId.equals(row.get("id").asText())) {
                return row.path("label").asText(null);
            }
        }
        return null;
    }

    /** Die Erzeuger-Komponenten der Anlage. */
    private List<String> producerIds(UUID site, String token) throws Exception {
        List<String> out = new java.util.ArrayList<>();
        for (JsonNode row : getJson("/api/v1/sites/" + site + "/components", token)
                .get("components")) {
            if ("pv-generation".equals(row.path("role").asText(null))) {
                out.add(row.get("id").asText());
            }
        }
        return out;
    }

    /** Die Gesamt-kWp der Anlage (das Aggregat, das der Optimierer liest). */
    private BigDecimal plantKwp(UUID site) throws SQLException {
        try (Connection c = superuser(); Statement st = c.createStatement()) {
            var rs = st.executeQuery("SELECT pv_capacity_kwp FROM asset WHERE site_id = '" + site
                    + "' AND type = 'pv' AND is_primary");
            return rs.next() ? rs.getBigDecimal(1) : null;
        }
    }

    private ResponseEntity<String> post(String path, String token, Object body) {
        return rest.exchange(url(path), HttpMethod.POST,
                new HttpEntity<>(body, bearer(token)), String.class);
    }

    /** Die Vorlage, die der {@link #fullReport()} meldet. */
    private static final String FRONIUS_TEMPLATE =
            "builtin:fronius_sunspec:fronius-eco-27-3-s";

    /** Die Verbindung des einen Fronius aus {@link #singleFroniusReport()}. */
    private static Map<String, Object> froniusConnection() {
        Map<String, Object> conn = new java.util.LinkedHashMap<>();
        conn.put("ip", "192.168.210.40");
        conn.put("port", 502);
        conn.put("unit_id", 1);
        return conn;
    }

    private static Map<String, Object> saveBody(String templateRef, String role,
            Map<String, Object> connection, String label) {
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("templateRef", templateRef);
        body.put("role", role);
        body.put("connection", connection);
        if (label != null) {
            body.put("label", label);
        }
        return body;
    }

    /** Wie {@link #fullReport()}, aber mit genau EINEM Fronius. */
    private static String singleFroniusReport() {
        return """
                [{"id":"inverter","kind":"inverter","brand":"deye","model":"sun-30k-sg01hp3",
                  "label":"Deye SUN-30K","family":"hybrid_3p","communication":"solarman_v5",
                  "connection":{"ip":"192.168.0.28","port":8899,"serial":"2985159064",
                                "mb_slave_id":1,"power_scale":10,"invert_batt_sign":true}},
                 {"id":"src-fronius-1","kind":"source","role":"pv-generation",
                  "brand":"fronius_sunspec","model":"fronius-eco-27-3-s","label":"Fronius 1",
                  "family":"sunspec_live","communication":"fronius_sunspec",
                  "connection":{"ip":"192.168.210.40","port":502,"unit_id":1},
                  "interval_s":30,"capacity_kwp":27,"registry_unit_id":"SEE966831669441"}]""";
    }

    /** Die Komponente, die an diese Quellen-Kennung gepinnt ist. */
    private String componentIdOfSource(UUID site, String token, String edgeSourceId)
            throws Exception {
        for (JsonNode row : getJson("/api/v1/sites/" + site + "/components", token)
                .get("components")) {
            if (edgeSourceId.equals(row.path("edgeSourceId").asText(null))) {
                return row.get("id").asText();
            }
        }
        return null;
    }

    /** Die Pins, zu denen die Box KEIN Gerät (mehr) meldet. */
    private List<String> orphanedSourceIds(UUID site, String token) throws Exception {
        java.util.Set<String> reported = new java.util.LinkedHashSet<>();
        TenantContext.set(UUID.fromString(TENANT_A));
        try {
            for (var row : observed.forSite(site)) {
                if ("local".equals(row.source()) && row.entityId() != null) {
                    reported.add(row.entityId().replaceFirst("^local:", ""));
                }
            }
        } finally {
            TenantContext.clear();
        }
        List<String> orphans = new java.util.ArrayList<>();
        for (JsonNode row : getJson("/api/v1/sites/" + site + "/components", token)
                .get("components")) {
            String pin = row.path("edgeSourceId").asText(null);
            if (pin != null && !pin.isBlank() && !reported.contains(pin)) {
                orphans.add(pin);
            }
        }
        return orphans;
    }

    private static List<String> edgeSourceIdsOfPush(JsonNode push) {
        List<String> out = new java.util.ArrayList<>();
        for (JsonNode e : push.get("entities")) {
            if (e.hasNonNull("edge_source_id")) {
                out.add(e.get("edge_source_id").asText());
            }
        }
        return out;
    }

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
     * DERSELBE Bericht, aber die beiden Fronius melden sich unter NEUEN
     * Quellen-Kennungen - der Live-Fall Pilsting/Herzogau nach dem Update
     * edge-2026.08.5 -&gt; .10: dieselben Wechselrichter, dieselbe IP, dieselben
     * Unit-Ids, nur die Kennung wurde neu vergeben.
     */
    private static String reportWithRenamedSourceIds() {
        return fullReport()
                .replace("src-fronius-1", "src-tdaejmjs")
                .replace("src-fronius-2", "src-67w4nbhh");
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
