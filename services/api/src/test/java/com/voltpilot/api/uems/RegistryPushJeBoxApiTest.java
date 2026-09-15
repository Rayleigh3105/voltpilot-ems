package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.components.ComponentAdoptionRunner;
import com.voltpilot.api.components.ComponentApplyRepository;
import com.voltpilot.api.entities.EntityObservedRepository;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.entities.EntityRegistryService.PushOutcome;
import com.voltpilot.api.entities.EntityRegistryService.PushOutcome.BoxZustellung;
import com.voltpilot.api.entities.EntityStatusListener;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.eclipse.paho.client.mqttv3.MqttClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der Registry-Push je Box (UEMS AP-06 IP-6, W7) gegen die echte Datenbank und einen echten Broker:
 * TimescaleDB mit RLS und EMQX als MQTT-Fake. Gezählt wird, was auf dem Broker liegt — der retained
 * Push je Box-Topic —, nicht, was der Dienst zu senden meinte. Der Publisher ist der echte, als Spion,
 * damit die Teilzustellung (W7) genau EINE Box verfehlen kann.
 *
 * <p>Die Welt ist das Referenzunternehmen ({@code uems-referenzunternehmen.json}): AN-1 mit Box Halle 1
 * und dem Speicher, K-1 (mit K-2 als EINE Zeile) samt PV-Geschwister hinter DQ-1, der Netzzähler K-3
 * hinter DQ-2, die Unterzähler K-4 … K-7 hinter DQ-3; AN-2 mit Box Halle 2 und den Energiekarten
 * K-8.1 … K-8.4 hinter DQ-4. Erfunden und benannt: die Haus-Summe {@code HS} (komponiert, ohne eigene
 * Quelle), die Lese-Box in AN-1 mit dem Kantinen-Zähler K-96 hinter DQ-96 (A9), und die Zeitpunkte,
 * die die Referenz nach der Uhr des Tests setzt (DQ-4 ab 01.10.2026) — sie beginnen hier vor 30 Tagen.
 * Das Ende von DQ-3 am 10.04.2027 (A3) prüft {@code PushJeBoxTest}.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@ActiveProfiles("local")
@Import(RegistryPushJeBoxApiTest.BrokerPublisher.class)
class RegistryPushJeBoxApiTest {

    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String VOR_30_TAGEN = "date_trunc('minute', now()) - interval '30 days'";
    private static final Instant BASIS = Instant.parse("2024-03-12T00:00:00Z");
    private static final List<String> UNTERZAEHLER = List.of("K-4", "K-5", "K-6", "K-7");
    private static final List<String> ENERGIEKARTEN = List.of("K-8.1", "K-8.2", "K-8.3", "K-8.4");

    /** Der Einrichtungs-Stand, den eine Box meldet (das {@code ComponentAdoptionApiTest}-Muster). */
    private static final String VOLLER_BERICHT = """
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

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Container
    static final GenericContainer<?> EMQX = new GenericContainer<>(DockerImageName.parse("emqx/emqx:5.8.3"))
            .withExposedPorts(1883);

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
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot");
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot/protocol/openid-connect/certs");
    }

    /** Der echte Publisher gegen EMQX — als Spion, damit ein Test genau eine Box verfehlen lassen kann. */
    @TestConfiguration
    static class BrokerPublisher {

        @Bean
        EntityRegistryPublisher entityRegistryPublisher() {
            return Mockito.spy(new EntityRegistryPublisher(brokerUrl(), "", ""));
        }
    }

    @Autowired
    EntityRegistryService registry;

    @Autowired
    EntityRegistryPublisher publisher;

    @Autowired
    ComponentAdoptionRunner runner;

    @Autowired
    DeviceRepository devices;

    @Autowired
    EntityObservedRepository observed;

    @Autowired
    ComponentApplyRepository applyRepo;

    private static JsonNode referenz;
    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    @BeforeAll
    static void ladeReferenz() throws IOException {
        referenz = MAPPER.readTree(V2.resolve("uems-referenzunternehmen.json").toFile());
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
        reset(publisher);
    }

    // ================================================================ A1 + A9: zwei Boxen, zwei Pushes

    /**
     * A1 (mit A9): Box Halle 1 bekommt genau DQ-1 … DQ-3 samt Anlagen-Rollen, die Lese-Box genau DQ-96,
     * Box Halle 2 genau DQ-4 — gezählt am Broker, die Schnittmengen leer, die Vereinigung ist die Welt,
     * und keine Entität liegt bei einer Box, die ihre Quelle nicht JETZT liest.
     */
    @Test
    void a1JedeBoxBekommtGenauIhreQuellenUndDieSchnittmengeIstLeer() throws Exception {
        Welt w = ahrenberg("A1", "Lese");
        UUID e1 = w.boxen.get("E-1");
        UUID lese = w.boxen.get("Lese");
        UUID e2 = w.boxen.get("E-2");

        PushOutcome an1 = push(w, "AN-1");
        PushOutcome an2 = push(w, "AN-2");
        assertThat(an1.published()).isTrue();
        assertThat(an1.boxen()).extracting(BoxZustellung::deviceId).containsExactly(e1, lese);
        assertThat(an2.published()).isTrue();
        assertThat(an2.boxen()).extracting(BoxZustellung::deviceId).containsExactly(e2);

        Map<UUID, JsonNode> halle1 = amBroker(w, "AN-1", 2);
        Map<UUID, JsonNode> halle2 = amBroker(w, "AN-2", 1);
        assertThat(halle1.keySet()).containsExactlyInAnyOrder(e1, lese);
        assertThat(halle2.keySet()).containsExactly(e2);
        verify(publisher, times(3)).publishRegistry(eq(w.mandant), any(), any(), any());

        Set<UUID> anE1 = entitaeten(halle1.get(e1));
        Set<UUID> anLese = entitaeten(halle1.get(lese));
        Set<UUID> anE2 = entitaeten(halle2.get(e2));
        assertThat(anE1).hasSize(8).containsExactlyInAnyOrderElementsOf(
                w.ids("K-1", "K-1/PV", "K-3", "HS", "K-4", "K-5", "K-6", "K-7"));
        assertThat(anLese).hasSize(1).containsExactly(w.komponenten.get("K-96"));
        assertThat(anE2).hasSize(4).containsExactlyInAnyOrderElementsOf(w.ids(ENERGIEKARTEN.toArray(String[]::new)));

        assertThat(schnitt(anE1, anLese)).isEmpty();
        assertThat(schnitt(anE1, anE2)).isEmpty();
        assertThat(schnitt(anLese, anE2)).isEmpty();
        Set<UUID> alle = new HashSet<>(anE1);
        alle.addAll(anLese);
        alle.addAll(anE2);
        assertThat(alle).hasSize(13).containsExactlyInAnyOrderElementsOf(w.komponenten.values());

        int geprueft = 0;
        for (Map.Entry<UUID, Set<UUID>> box : Map.of(e1, anE1, lese, anLese, e2, anE2).entrySet()) {
            for (UUID komponente : box.getValue()) {
                UUID liest = liestJetzt(komponente);
                if (liest != null) {
                    assertThat(liest).as("keine fremde Quelle: " + komponente).isEqualTo(box.getKey());
                    geprueft++;
                }
            }
        }
        assertThat(geprueft).as("jede Komponente mit Quelle, also alle außer der Haus-Summe").isEqualTo(12);

        assertThat(soll(w.anlagen.get("AN-1"))).containsOnlyKeys(e1, lese)
                .containsEntry(e1, halle1.get(e1).get("revision").asText())
                .containsEntry(lese, halle1.get(lese).get("revision").asText());
        assertThat(soll(w.anlagen.get("AN-2"))).containsOnlyKeys(e2);
    }

    // ================================================================ Führende Box

    /**
     * Die Anlagen-Rollen stehen im Push der führenden Box und in keinem anderen. Wählt der Kunde die
     * Lese-Box als führende Box, wandert die Haus-Summe mit; K-1 und K-3 liest weiter Box Halle 1 —
     * sie stehen dann in keinem Push, nie bei der falschen Box.
     */
    @Test
    void anlagenRollenStehenNurImPushDerFuehrendenBox() throws Exception {
        Welt w = ahrenberg("Rollen", "Lese");
        UUID an1 = w.anlagen.get("AN-1");
        UUID e1 = w.boxen.get("E-1");
        UUID lese = w.boxen.get("Lese");

        push(w, "AN-1");
        Map<UUID, JsonNode> vorher = amBroker(w, "AN-1", 2);
        assertThat(rollen(vorher.get(e1))).containsExactlyInAnyOrder("battery-hybrid", "grid-meter", "house-load");
        assertThat(rollen(vorher.get(lese))).isEmpty();

        root.update("UPDATE site SET lead_device_id = ? WHERE id = ?", lese, an1);
        push(w, "AN-1");
        Map<UUID, JsonNode> nachher = amBroker(w, "AN-1", 2);
        assertThat(nachher.keySet()).containsExactlyInAnyOrder(e1, lese);
        assertThat(rollen(nachher.get(lese))).containsExactly("house-load");
        assertThat(rollen(nachher.get(e1))).isEmpty();
        assertThat(entitaeten(nachher.get(lese))).containsExactlyInAnyOrderElementsOf(w.ids("HS", "K-96"));
        assertThat(entitaeten(nachher.get(e1)))
                .containsExactlyInAnyOrderElementsOf(w.ids("K-1/PV", "K-4", "K-5", "K-6", "K-7"));
        Set<UUID> ueberall = new HashSet<>(entitaeten(nachher.get(e1)));
        ueberall.addAll(entitaeten(nachher.get(lese)));
        assertThat(ueberall).doesNotContainAnyElementsOf(w.ids("K-1", "K-3"));
    }

    // ================================================================ Zum Zeitpunkt

    /**
     * Die Zuständigkeit gilt ZUM ZEITPUNKT des Pushs: DQ-96 wechselt vor einer Minute von Box Halle 1 zur
     * Lese-Box — Box Halle 1 vergisst K-96 sicher (ihr neuer Push hat ihn nicht mehr), die Lese-Box
     * bekommt ihn. DQ-3 wechselt erst morgen: bis dahin liest weiter Box Halle 1.
     */
    @Test
    void wechselZumZeitpunktDieAlteBoxVergisstDieQuelle() throws Exception {
        Welt w = ahrenberg("Wechsel", "E-1");
        UUID e1 = w.boxen.get("E-1");
        UUID lese = w.boxen.get("Lese");

        push(w, "AN-1");
        Map<UUID, JsonNode> vorher = amBroker(w, "AN-1", 1);
        assertThat(vorher.keySet()).as("die Lese-Box liest nichts und hat kein Soll").containsExactly(e1);
        assertThat(entitaeten(vorher.get(e1))).hasSize(9).contains(w.komponenten.get("K-96"));

        String vorEinerMinute = "date_trunc('minute', now()) - interval '1 minute'";
        w.beendet("DQ-96", vorEinerMinute);
        w.liest("DQ-96", "Lese", vorEinerMinute);
        String morgen = "date_trunc('minute', now()) + interval '1 day'";
        w.beendet("DQ-3", morgen);
        w.liest("DQ-3", "Lese", morgen);

        push(w, "AN-1");
        Map<UUID, JsonNode> nachher = amBroker(w, "AN-1", 2);
        assertThat(entitaeten(nachher.get(e1))).hasSize(8).doesNotContain(w.komponenten.get("K-96"))
                .containsAll(w.ids(UNTERZAEHLER.toArray(String[]::new)));
        assertThat(entitaeten(nachher.get(lese))).containsExactly(w.komponenten.get("K-96"));
    }

    // ================================================================ Bestandsschutz

    /**
     * A12: eine Anlage mit genau einer Box sendet nach der Zuordnung ihrer Datenquellen denselben Push wie
     * vorher — Zeichen für Zeichen bis auf die beiden Zeitstempel, an dieselbe und nur diese Box.
     * (Byte-gleich mit fester Uhr: {@code RegistryPushJeBoxBestandTest}.)
     */
    @Test
    void eineAnlageMitEinerBoxSendetDenselbenPushWieVorher() throws Exception {
        Welt w = new Welt("A12");
        w.box("E-1", "AN-1");
        w.speicherAn("AN-1", "E-1");
        halle1Komponenten(w);
        UUID an1 = w.anlagen.get("AN-1");
        UUID e1 = w.boxen.get("E-1");

        push(w, "AN-1");
        JsonNode vorher = amBroker(w, "AN-1", 1).get(e1);
        halle1Quellen(w);
        PushOutcome outcome = push(w, "AN-1");
        Map<UUID, JsonNode> nachher = amBroker(w, "AN-1", 1);

        assertThat(outcome.boxen()).containsExactly(new BoxZustellung(e1, true));
        assertThat(nachher.keySet()).containsExactly(e1);
        assertThat(ohneZeit(nachher.get(e1))).isEqualTo(ohneZeit(vorher));
        assertThat(entitaeten(vorher)).hasSize(8);
        verify(publisher, times(2)).publishRegistry(eq(w.mandant), eq(an1), eq(e1), any());
        verify(publisher, times(2)).publishRegistry(eq(w.mandant), any(), any(), any());
        assertThat(soll(an1)).containsOnlyKeys(e1);
    }

    // ================================================================ W7: alles oder nichts je Box

    /**
     * W7: die Bestands-Übernahme einer Anlage mit zwei Boxen gilt erst, wenn BEIDE Pushes angekommen
     * sind. Verfehlt der Push die Lese-Box, rollt die Übernahme zurück — keine Zeile übernommen, die
     * Anlage bleibt box-verwaltet —, und Box Halle 1, die den Übernahme-Push schon HATTE, bekommt den
     * Stand von vorher zurück. Am Broker liegt danach an beiden Boxen der Inhalt von vorher.
     */
    @Test
    void uebernahmeGiltErstMitBeidenPushesSonstStehtAnBeidenBoxenDerStandVonVorher() throws Exception {
        Welt w = new Welt("W7");
        UUID an = w.anlage("AN-1");
        root.update("UPDATE site SET component_authority = 'box' WHERE id = ?", an);
        UUID e1 = w.box("E-1", "AN-1");
        UUID lese = w.boxErfunden("Lese", "Lese-Box Halle 1", "AN-1", "2026-08-03T10:15:30+02:00");
        w.speicherAn("AN-1", "E-1");
        w.komponente("K-1", "AN-1", "battery-hybrid", "E-1", null, 0);
        w.komponente("K-96", "AN-1", "modbus-generic", "Lese", "192.168.10.50:502", 1);
        w.quelleErfunden("DQ-96", "AN-1", "192.168.10.50:502", 60);
        w.liest("DQ-96", "Lese", VOR_30_TAGEN);
        w.gehoertZu("K-96", "DQ-96");

        push(w, "AN-1");
        Map<UUID, JsonNode> vorher = amBroker(w, "AN-1", 2);
        assertThat(entitaeten(vorher.get(e1))).containsExactly(w.komponenten.get("K-1"));
        assertThat(entitaeten(vorher.get(lese))).containsExactly(w.komponenten.get("K-96"));

        herzschlag(w, an, e1, VOLLER_BERICHT);
        String zeilenVorher = zeilen(w);
        reset(publisher);
        doReturn(false).when(publisher).publishRegistry(any(), any(), eq(lese), any());

        ComponentAdoptionRunner.RunSummary lauf = runner.run();
        assertThat(lauf.failed()).as(lauf.toString()).isGreaterThanOrEqualTo(1);

        assertThat(root.queryForObject("SELECT component_authority FROM site WHERE id = ?", String.class, an))
                .isEqualTo("box");
        assertThat(zeilen(w)).as("keine Zeile übernommen").isEqualTo(zeilenVorher);

        ArgumentCaptor<byte[]> anE1 = ArgumentCaptor.forClass(byte[].class);
        verify(publisher, times(2)).publishRegistry(eq(w.mandant), eq(an), eq(e1), anE1.capture());
        assertThat(MAPPER.readTree(anE1.getAllValues().get(0)).path("component_authority").asText())
                .as("Box Halle 1 hatte den Übernahme-Push schon").isEqualTo("portal");
        assertThat(MAPPER.readTree(anE1.getAllValues().get(1)).has("component_authority"))
                .as("und bekommt den Stand von vorher zurück").isFalse();
        verify(publisher, times(2)).publishRegistry(eq(w.mandant), eq(an), eq(lese), any());

        Map<UUID, JsonNode> nachher = amBroker(w, "AN-1", 2);
        assertThat(ohneZeit(nachher.get(e1))).isEqualTo(ohneZeit(vorher.get(e1)));
        assertThat(nachher.get(lese)).as("nie überschrieben, auch die Revision nicht").isEqualTo(vorher.get(lese));
        assertThat(soll(an)).containsOnlyKeys(e1, lese)
                .containsEntry(e1, nachher.get(e1).get("revision").asText());
    }

    // ================================================================ Gerüst

    private PushOutcome push(Welt w, String anlage) {
        TenantContext.set(w.mandant);
        try {
            return registry.pushRegistryBestEffort(w.anlagen.get(anlage));
        } finally {
            TenantContext.clear();
        }
    }

    /** Schickt einen Herzschlag durch den ECHTEN Zuhörer — die Form, die auf dem Draht liegt. */
    private void herzschlag(Welt w, UUID anlage, UUID box, String localSetup) {
        EntityStatusListener listener = new EntityStatusListener("tcp://unused", "", "", devices, observed, applyRepo);
        String payload = """
                {"schema_version":"1.0","tenant_id":"%s","site_id":"%s","device_id":"%s",
                 "entities":{"revision":"r-ist","count":0,"ids":[],"local_setup":%s}}"""
                .formatted(w.mandant, anlage, box, localSetup);
        listener.handle("ems/%s/%s/%s/status".formatted(w.mandant, anlage, box),
                payload.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * Was am Broker liegt: je Box der retained Registry-Push dieser Anlage. Wartet auf {@code erwartet}
     * Topics und danach eine halbe Sekunde auf ein Topic zu viel.
     */
    private static Map<UUID, JsonNode> amBroker(Welt w, String anlage, int erwartet) throws Exception {
        String filter = "ems/" + w.mandant + "/" + w.anlagen.get(anlage) + "/+/v2/entities";
        MqttClient abonnent = new MqttClient(brokerUrl(), "test-sub-" + UUID.randomUUID(), new MemoryPersistence());
        Map<UUID, JsonNode> out = new ConcurrentHashMap<>();
        try {
            MqttConnectOptions options = new MqttConnectOptions();
            options.setCleanSession(true);
            abonnent.connect(options);
            CountDownLatch latch = new CountDownLatch(erwartet);
            abonnent.subscribe(filter, 1, (topic, message) -> {
                if (message.getPayload().length > 0) {
                    out.put(UUID.fromString(topic.split("/")[3]), MAPPER.readTree(message.getPayload()));
                    latch.countDown();
                }
            });
            assertThat(latch.await(10, TimeUnit.SECONDS)).as("retained Pushes unter " + filter).isTrue();
            Thread.sleep(500);
            return new LinkedHashMap<>(out);
        } finally {
            try {
                abonnent.disconnect();
                abonnent.close();
            } catch (Exception e) {
                // best-effort cleanup
            }
        }
    }

    private static String brokerUrl() {
        return "tcp://" + EMQX.getHost() + ":" + EMQX.getMappedPort(1883);
    }

    /** Welche Box die Quelle dieser Komponente JETZT liest — gefragt an der Datenbank, nicht am Dienst. */
    private static UUID liestJetzt(UUID komponente) {
        List<UUID> boxen = root.queryForList("SELECT a.device_id FROM measurement_point mp "
                + "JOIN data_source_assignment a ON a.data_source_id = mp.data_source_id WHERE mp.id = ? "
                + "AND a.effective_from <= now() AND (a.effective_to IS NULL OR a.effective_to > now())",
                UUID.class, komponente);
        assertThat(boxen).hasSizeLessThanOrEqualTo(1);
        return boxen.isEmpty() ? null : boxen.get(0);
    }

    /** Das aufgezeichnete Soll dieser Anlage je Box. */
    private static Map<UUID, String> soll(UUID anlage) {
        Map<UUID, String> out = new LinkedHashMap<>();
        root.query("SELECT device_id, revision FROM entity_registry_state WHERE site_id = ? AND device_id IS NOT NULL",
                rs -> {
                    out.put(rs.getObject("device_id", UUID.class), rs.getString("revision"));
                }, anlage);
        return out;
    }

    /** Was eine Übernahme schreiben könnte: Komponenten, ihre Definitionen, die Anlage. */
    private static String zeilen(Welt w) {
        return root.queryForObject("""
                SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) FROM (
                    SELECT 'mp:' || to_jsonb(mp)::text FROM measurement_point mp WHERE mp.tenant_id = ?
                    UNION ALL SELECT 'cd:' || to_jsonb(cd)::text FROM component_definition cd WHERE cd.tenant_id = ?
                    UNION ALL SELECT 'site:' || to_jsonb(s)::text FROM site s WHERE s.tenant_id = ?
                ) z(x)""", String.class, w.mandant, w.mandant, w.mandant);
    }

    private static Set<UUID> entitaeten(JsonNode push) {
        Set<UUID> out = new HashSet<>();
        push.get("entities").forEach(e -> out.add(UUID.fromString(e.get("entity_id").asText())));
        return out;
    }

    private static List<String> rollen(JsonNode push) {
        List<String> out = new ArrayList<>();
        push.get("entities").forEach(e -> {
            if (PushJeBox.ANLAGEN_ROLLEN.contains(e.get("entity_type").asText())) {
                out.add(e.get("entity_type").asText());
            }
        });
        return out;
    }

    private static String ohneZeit(JsonNode push) {
        ObjectNode n = push.deepCopy();
        assertThat(n.has("revision") && n.has("published_at")).isTrue();
        n.remove("revision");
        n.remove("published_at");
        return n.toString();
    }

    private static Set<UUID> schnitt(Set<UUID> a, Set<UUID> b) {
        Set<UUID> s = new HashSet<>(a);
        s.retainAll(b);
        return s;
    }

    /** Werk Ahrenberg, AN-1 mit Lese-Box (A9) und AN-2; {@code leserDq96} liest den Kantinen-Zähler. */
    private static Welt ahrenberg(String name, String leserDq96) {
        Welt w = new Welt(name);
        w.box("E-1", "AN-1");
        w.boxErfunden("Lese", "Lese-Box Halle 1", "AN-1", "2026-08-03T10:15:30+02:00");
        w.box("E-2", "AN-2");
        w.speicherAn("AN-1", "E-1");
        halle1Komponenten(w);
        w.komponente("K-96", "AN-1", "modbus-generic", "Lese", "192.168.10.50:502", 1);
        for (String k : ENERGIEKARTEN) {
            w.komponente(k, "AN-2", "modbus-generic", null, adresse("DQ-4"), 1);
        }
        halle1Quellen(w);
        w.quelleErfunden("DQ-96", "AN-1", "192.168.10.50:502", 60);
        w.liest("DQ-96", leserDq96, VOR_30_TAGEN);
        w.gehoertZu("K-96", "DQ-96");
        w.quelle("DQ-4");
        w.liest("DQ-4", "E-2", VOR_30_TAGEN);
        for (String k : ENERGIEKARTEN) {
            w.gehoertZu(k, "DQ-4");
        }
        return w;
    }

    /** AN-1: K-1 (mit Speicher) samt PV-Geschwister an Box Halle 1, K-3, die Haus-Summe, K-4 … K-7. */
    private static void halle1Komponenten(Welt w) {
        w.komponente("K-1", "AN-1", "battery-hybrid", "E-1", adresse("DQ-1"), 1);
        w.komponente("K-1/PV", "AN-1", "producer", "E-1", null, 0);
        w.komponente("K-3", "AN-1", "grid-meter", null, adresse("DQ-2"), 1);
        w.komponente("HS", "AN-1", "house-load", "E-1", null, 0);
        int geraeteId = 1;
        for (String k : UNTERZAEHLER) {
            w.komponente(k, "AN-1", "modbus-generic", null, adresse("DQ-3"), geraeteId++);
        }
    }

    /** DQ-1 … DQ-3 an Box Halle 1 ab ihrem Reihenbeginn in der Referenz; die Haus-Summe bleibt ohne Quelle. */
    private static void halle1Quellen(Welt w) {
        for (String dq : List.of("DQ-1", "DQ-2", "DQ-3")) {
            w.quelle(dq);
            w.liest(dq, "E-1", "'" + referenzAb(dq) + "'::timestamptz");
        }
        w.gehoertZu("K-1", "DQ-1");
        w.gehoertZu("K-1/PV", "DQ-1");
        w.gehoertZu("K-3", "DQ-2");
        for (String k : UNTERZAEHLER) {
            w.gehoertZu(k, "DQ-3");
        }
    }

    private static String adresse(String dq) {
        JsonNode q = eines(referenz.get("datenquellen"), dq);
        return q.get("adresse").asText() + ":" + q.get("port").asInt();
    }

    private static String referenzAb(String dq) {
        for (JsonNode z : referenz.get("zuordnungen")) {
            if ("datenquelle_box".equals(z.get("art").asText()) && dq.equals(z.get("von").asText())) {
                return z.get("gueltig_ab").asText();
            }
        }
        throw new IllegalArgumentException("keine Zuständigkeit in der Referenz: " + dq);
    }

    private static JsonNode eines(JsonNode liste, String kennzeichen) {
        for (JsonNode n : liste) {
            if (kennzeichen.equals(n.get("kennzeichen").asText())) {
                return n;
            }
        }
        throw new IllegalArgumentException("nicht in der Referenz: " + kennzeichen);
    }

    /** Ein Kundenbereich mit Anlagen, Boxen, Komponenten und Datenquellen — gesät am Schreibweg vorbei. */
    private static final class Welt {
        final UUID mandant;
        final Map<String, UUID> anlagen = new LinkedHashMap<>();
        final Map<String, UUID> boxen = new LinkedHashMap<>();
        final Map<String, UUID> komponenten = new LinkedHashMap<>();
        final Map<String, UUID> quellen = new LinkedHashMap<>();

        Welt(String name) {
            mandant = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                    "Push je Box · " + name + " #" + NR.incrementAndGet());
        }

        UUID anlage(String kz) {
            return anlagen.computeIfAbsent(kz, k -> root.queryForObject(
                    "INSERT INTO site (tenant_id, name) VALUES (?, ?) RETURNING id", UUID.class, mandant,
                    eines(referenz.get("anlagen"), k).get("name").asText()));
        }

        UUID box(String kz, String anlageKz) {
            JsonNode b = eines(referenz.get("boxen"), kz);
            return boxErfunden(kz, b.get("name").asText(), anlageKz, b.get("in_betrieb_ab").asText());
        }

        UUID boxErfunden(String kz, String name, String anlageKz, String seit) {
            UUID id = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, name, status, "
                    + "created_at) VALUES (?, ?, ?, ?, 'claimed', ?::timestamptz) RETURNING id", UUID.class, mandant,
                    anlage(anlageKz), "VP-PUSH-" + NR.incrementAndGet(), name, seit);
            boxen.put(kz, id);
            return id;
        }

        void speicherAn(String anlageKz, String boxKz) {
            root.update("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, max_discharge_kw, "
                    + "device_id) VALUES (?, ?, 'battery', 200, 100, 100, ?)", mandant, anlage(anlageKz),
                    boxen.get(boxKz));
        }

        UUID komponente(String kz, String anlageKz, String art, String boxKz, String adresse, int geraeteId) {
            String verbindung = adresse == null ? null : MAPPER.createObjectNode()
                    .put("ip", adresse.split(":")[0]).put("port", Integer.parseInt(adresse.split(":")[1]))
                    .put("unit_id", geraeteId).toString();
            UUID id = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, entity_type, "
                    + "device_id, control, communication, connection_json, created_at) "
                    + "VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::timestamptz) RETURNING id", UUID.class,
                    mandant, anlage(anlageKz), art, art, boxKz == null ? null : boxen.get(boxKz),
                    "battery-hybrid".equals(art), adresse == null ? null : "modbus_tcp", verbindung,
                    BASIS.plusSeconds(komponenten.size()).toString());
            komponenten.put(kz, id);
            return id;
        }

        void quelle(String kz) {
            JsonNode q = eines(referenz.get("datenquellen"), kz);
            UUID id = root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, "
                    + "adresse, kadenz_s, steuerquelle) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id", UUID.class,
                    mandant, anlage(q.get("anlage").asText()), kz, q.get("protokoll").asText(), adresse(kz),
                    q.get("kadenz_s").asInt(), q.get("steuerquelle").asBoolean());
            quellen.put(kz, id);
        }

        void quelleErfunden(String kz, String anlageKz, String adresse, int kadenz) {
            quellen.put(kz, root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, "
                    + "protokoll, adresse, kadenz_s) VALUES (?, ?, ?, 'modbus_tcp', ?, ?) RETURNING id", UUID.class,
                    mandant, anlage(anlageKz), kz, adresse, kadenz));
        }

        /** Die Box liest die Quelle ab {@code abSql} (ein fester SQL-Ausdruck des Tests), offen. */
        void liest(String quelleKz, String boxKz, String abSql) {
            root.update("INSERT INTO data_source_assignment (tenant_id, data_source_id, device_id, protokoll, adresse, "
                    + "effective_from) SELECT d.tenant_id, d.id, ?, d.protokoll, d.adresse, " + abSql
                    + " FROM data_source d WHERE d.id = ?", boxen.get(boxKz), quellen.get(quelleKz));
        }

        /** Der laufende Zeitraum der Quelle endet bei {@code bisSql} (ein fester SQL-Ausdruck des Tests). */
        void beendet(String quelleKz, String bisSql) {
            assertThat(root.update("UPDATE data_source_assignment SET effective_to = " + bisSql
                    + " WHERE data_source_id = ? AND effective_to IS NULL", quellen.get(quelleKz))).isEqualTo(1);
        }

        void gehoertZu(String komponenteKz, String quelleKz) {
            root.update("UPDATE measurement_point SET data_source_id = ? WHERE id = ?", quellen.get(quelleKz),
                    komponenten.get(komponenteKz));
        }

        List<UUID> ids(String... kz) {
            return java.util.Arrays.stream(kz).map(komponenten::get).toList();
        }
    }
}
