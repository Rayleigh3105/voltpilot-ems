package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.chargers.*;
import com.voltpilot.api.consumers.ConsumerOverridePublisher;
import com.voltpilot.api.control.ControlCertificationPublisher;
import com.voltpilot.api.control.ControlCertificationService;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import com.voltpilot.api.measurement.MeasurementConfigPublisher;
import com.voltpilot.api.ota.OtaTargetPublisher;
import com.voltpilot.api.probe.ProbePublisher;
import com.voltpilot.api.provisioning.ProvisioningPublisher;
import com.voltpilot.api.registerwrite.*;
import com.voltpilot.api.tenant.TenantContext;
import io.micrometer.core.instrument.MeterRegistry;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.math.BigDecimal;
import java.time.*;
import java.util.*;
import org.eclipse.paho.client.mqttv3.*;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.junit.jupiter.api.*;
import org.mockito.MockedStatic;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.config.BeanFactoryPostProcessor;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.datasource.init.ScriptUtils;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * AP-14 IP-5 / NW-2 / U1. The SAME harness records main's real application and
 * compares uems against those frozen bytes, not against a second call to uems.
 * See resources/uems/nw2/README.md for commit, capture command and boundaries.
 * Reflection ONLY bridges classes absent on main; all exercised services and
 * repositories are real, using voltpilot_app and the production migrations.
 *
 * Bewusste Differenzen main → uems (Entscheid 18.09.2026):
 * | Wo | Seit | Prüfung / Box-Wirkung |
 * |---|---|---|
 * | Vier Override-HTTP-Antworten: pushReason:null | 439daaf4, 16.09.2026 | Nur dieses Feld entnehmen, null UND pushed:true; MQTT unverändert. |
 * | Registry driver.data_source_id nach bestätigter Übernahme | 1309008e, 18.09.2026 | Optional, alte Box überliest; hier KEINE Bestätigung, KEINE Ausnahme. |
 * See README.md for the source and rationale; additional differences must fail.
 */
@Testcontainers
@SpringBootTest
@AutoConfigureMockMvc
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class UemsBestandSteuerungAusEinemStueckTest {
    static final String MAIN = "4aa1e7fb39b25388f71f20d1d0fc2470a940e4a3";
    static final boolean CAPTURE = System.getProperty("nw2.capture") != null;
    static final UUID TENANT = id(1), SITE = id(2), BOX = id(3), BATTERY = id(4), CONSUMER = id(5);
    static final UUID U2_TENANT = id(21), U2_HALLE_1 = id(22), U2_HALLE_2 = id(23), U2_LINDACH = id(24);
    static final Instant NOW = Instant.parse("2090-09-18T10:00:00Z");
    static final String ACTOR = "jonas";
    static final ObjectMapper JSON = new ObjectMapper().findAndRegisterModules();
    static JdbcTemplate root;
    static Map<String, String> before;
    // Explicitly authorised UEMS state and processing cursors; no steering table is exempted.
    // component_template is the global built-in catalogue, populated by both main and UEMS startup,
    // not a customer control row. The seeded plant has no template_ref; its actual registry bytes
    // and the complete measurement_point table remain in the comparison.
    static final List<String> UEMS_STATE = List.of("funktion", "funktion_teilnahme", "benutzer", "zugriff",
            "zugriff_bestand", "zugriff_protokoll", "messreihe_viertelstunde_lauf", "messreihe_tag_lauf",
            "messreihe_luecke_lauf", "component_template");

    @Container static final PostgreSQLContainer<?> POSTGRES = postgres();

    private static PostgreSQLContainer<?> postgres() {
        var container = new PostgreSQLContainer<>(
                DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
                .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw")
                .withCommand("postgres", "-c", "timescaledb.max_background_workers=0");
        String prefix = System.getProperty("buehne.container-prefix");
        if (prefix != null && !prefix.isBlank()) {
            container.withCreateContainerCmdModifier(cmd -> cmd.withName(prefix + "-db"));
        }
        return container;
    }

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry r) throws Exception {
        POSTGRES.start();
        var ds = new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
        root = new JdbcTemplate(ds);
        var migrations = Files.createTempDirectory("nw2-main-migrations-");
        if (!CAPTURE) {
            List<String> main = new String(UemsBestandSteuerungAusEinemStueckTest.class
                    .getResourceAsStream("/migration/main-migrations.txt").readAllBytes(), StandardCharsets.UTF_8)
                    .lines().filter(s -> !s.isBlank() && !s.startsWith("#")).toList();
            for (String name : main) {
                try (var in = UemsBestandSteuerungAusEinemStueckTest.class.getResourceAsStream("/db/migration/" + name)) {
                    Files.copy(Objects.requireNonNull(in), migrations.resolve(name));
                }
            }
            var initial = flyway().locations("filesystem:" + migrations).load();
            initial.migrate();
            assertThat(Arrays.stream(initial.info().applied()).map(MigrationInfo::getScript).toList())
                    .as("Referenz main-migrations.txt @ %s: exakt der Satz, keine Versionsobergrenze", MAIN)
                    .containsExactlyInAnyOrderElementsOf(main);
        } else {
            Process git = new ProcessBuilder("git", "rev-parse", "HEAD").start();
            String commit = new String(git.getInputStream().readAllBytes(), StandardCharsets.UTF_8).strip();
            assertThat(git.waitFor()).isZero();
            assertThat(commit).as("Aufnahme nur auf dem belegten Main-Commit").isEqualTo(MAIN);
            assertThat(Files.readString(Path.of("src/main/java/com/voltpilot/api/consumers/ConsumerOverrideService.java")))
                    .as("Capture must run on main, never overwrite the oracle with uems").doesNotContain("EinmalAuftragZiel");
            flyway().load().migrate();
        }
        try (var connection = ds.getConnection()) {
            ScriptUtils.executeSqlScript(connection, new ClassPathResource("uems/nw2/main-seed.sql"));
        }
        seedContracts();
        if (!CAPTURE) {
            before = fingerprint();
            var rest = flyway().outOfOrder(true).load();
            assertThat(rest.info().pending()).as("UEMS migrations really remain after main").isNotEmpty();
            rest.migrate();
            assertThat(rest.info().pending()).isEmpty();
        }
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "voltpilot_app_test_pw");
        r.add("spring.flyway.enabled", () -> "false");
        r.add("voltpilot.admin-datasource.username", () -> "voltpilot_admin");
        r.add("voltpilot.admin-datasource.password", () -> "voltpilot_admin_test_pw");
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("voltpilot.consumer-control.enabled", () -> "true");
        r.add("voltpilot.consumer-control.policy-compiler-enabled", () -> "true");
        // Startup runners are invoked synchronously once, in production order, below.
        for (String flag : List.of("bestandsuebernahme", "funktion-bestand", "zugriff-bestand"))
            r.add("voltpilot.uems." + flag + ".enabled", () -> "false");
        for (String flag : List.of("viertelstunde", "endgueltigkeit", "luecken", "ersatzwert", "kaskade",
                "berichte", "berichte.struktur", "zeilentexte", "plan-zustellung", "ladepark-grenze", "uebergabe",
                "unterstuetzung", "kennzahlen"))
            r.add("voltpilot.uems." + flag + ".enabled", () -> Boolean.toString(!CAPTURE));
    }

    private static void seedContracts() throws Exception {
        // Existing valid contract vectors, not invented capabilities or an invalid toy policy.
        JsonNode battery = contract("edge-entity.valid.registry-push.json").path("entities").get(0);
        JsonNode heater = contract("edge-entity.valid.registry-push-consumers.json").path("entities").get(1);
        for (var entry : Map.of(BATTERY, battery, CONSUMER, heater).entrySet()) {
            JsonNode entity = entry.getValue();
            root.update("UPDATE measurement_point SET entity_type=?,capabilities=?::jsonb,guard_config=?::jsonb WHERE id=?",
                    entity.path("entity_type").asText(), entity.path("capabilities").toString(), entity.path("guards").toString(), entry.getKey());
        }
        root.update("UPDATE measurement_point SET brand='deye',model='sun-30k-sg01hp3',family='hybrid_3p' WHERE id=?", BATTERY);
        root.update("UPDATE asset SET max_charge_kw=30,max_discharge_kw=30 WHERE site_id=?", SITE);
        var policy = (com.fasterxml.jackson.databind.node.ObjectNode) contract("consumer-policy.valid.heater.json");
        policy.put("entity_id", CONSUMER.toString());
        String hash = ReflectionTestUtils.invokeMethod(com.voltpilot.api.consumers.ConsumerService.class, "contentHash", policy);
        root.update("UPDATE consumer_policy SET document=?::jsonb,content_hash=? WHERE entity_id=?", policy.toString(), hash, CONSUMER);
    }

    private static JsonNode contract(String name) throws Exception {
        return JSON.readTree(Files.readString(Path.of("../../docs/contracts/v2/examples", name)));
    }

    private static org.flywaydb.core.api.configuration.FluentConfiguration flyway() {
        return Flyway.configure().dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration").placeholders(Map.of("appDbUser", "voltpilot_app",
                        "appDbPassword", "voltpilot_app_test_pw", "adminDbUser", "voltpilot_admin",
                        "adminDbPassword", "voltpilot_admin_test_pw"));
    }

    @TestConfiguration
    static class NoWallClockTimers {
        @Bean static BeanFactoryPostProcessor deterministicScheduling() {
            // Keep all conditional runner beans, but never race the manual test ticks.
            return factory -> {
                String name = "org.springframework.context.annotation.internalScheduledAnnotationProcessor";
                if (factory.containsBeanDefinition(name)) ((DefaultListableBeanFactory) factory).removeBeanDefinition(name);
            };
        }
    }

    @MockBean(reset = org.springframework.boot.test.mock.mockito.MockReset.NONE) JwtDecoder decoder;
    @MockBean(reset = org.springframework.boot.test.mock.mockito.MockReset.NONE) KeycloakAdminClient keycloak;
    @MockBean(reset = org.springframework.boot.test.mock.mockito.MockReset.NONE) EntityRegistryPublisher registryPublisher;
    @MockBean(reset = org.springframework.boot.test.mock.mockito.MockReset.NONE) ProbePublisher probePublisher;
    @MockBean(reset = org.springframework.boot.test.mock.mockito.MockReset.NONE) ChargingConfigPublisher chargingPublisher;
    @MockBean(reset = org.springframework.boot.test.mock.mockito.MockReset.NONE) ChargingBoostPublisher boostPublisher;
    @MockBean(reset = org.springframework.boot.test.mock.mockito.MockReset.NONE) RegisterWritePublisher registerPublisher;
    @MockBean(reset = org.springframework.boot.test.mock.mockito.MockReset.NONE) FlowDeploymentPublisher flowPublisher;
    @MockBean(reset = org.springframework.boot.test.mock.mockito.MockReset.NONE) ControlCertificationPublisher certificationPublisher;
    @MockBean(reset = org.springframework.boot.test.mock.mockito.MockReset.NONE) OtaTargetPublisher otaPublisher;
    @MockBean(reset = org.springframework.boot.test.mock.mockito.MockReset.NONE) ProvisioningPublisher provisioningPublisher;
    @MockBean(reset = org.springframework.boot.test.mock.mockito.MockReset.NONE) MeasurementConfigPublisher measurementPublisher;
    @MockBean(reset = org.springframework.boot.test.mock.mockito.MockReset.NONE) ConsumerOverridePublisher consumerPublisher;
    @Autowired ApplicationContext context;
    @Autowired MockMvc mvc;
    @Autowired EntityRegistryService registry;
    @Autowired ChargingConfigService charging;
    @Autowired ControlCertificationService certifications;
    @Autowired RegisterWriteRegistry registerReplies;
    @Autowired MeterRegistry meters;
    private final Map<String, String> captured = new TreeMap<>();
    private final List<String> wire = new ArrayList<>();
    private JsonNode reference;
    private String startup;
    private String lastRegisterCorrelation;
    private MockedStatic<Instant> time;

    @BeforeAll
    void start() throws Exception {
        if (!CAPTURE) reference = JSON.readTree(getClass().getResourceAsStream("/uems/nw2/main-reference.json"));
        Map<String, Integer> boot = new TreeMap<>();
        senders().forEach((name, sender) -> boot.put(name, mockingDetails(sender).getInvocations().size()));
        startup = JSON.writeValueAsString(boot);
        clearInvocations(senders().values().toArray());
        // Die Testdatenbank enthält neben den beiden Bühnenkunden weitere Dev-Seed-Mandanten. Der echte
        // Startläufer geht sie chronologisch durch; eine nicht gestubbte Mockito-Antwort wäre null und würde
        // den Lauf vor unseren Kunden abbrechen. Für alle fremden Mandanten ist die echte, vollständige Sicht
        // deshalb eine leere Kontenliste.
        when(keycloak.listUsersForTenant(any())).thenReturn(List.of());
        when(keycloak.listUsersForTenant(TENANT)).thenReturn(List.of(new KeycloakAdminClient.KeycloakUser(
                ACTOR, ACTOR, "jonas@example.invalid", "Jonas", "Wendlinger", true, TENANT.toString())));
        when(keycloak.listUsersForTenant(U2_TENANT)).thenReturn(List.of(new KeycloakAdminClient.KeycloakUser(
                ACTOR, ACTOR, "jonas@example.invalid", "Jonas", "Wendlinger", true, U2_TENANT.toString())));
        when(registryPublisher.publishRegistry(any(), any(), any(), any())).thenReturn(true);
        // Real serializers and MQTT publication code; only the network connection is replaced.
        connect(chargingPublisher);
        connect(registerPublisher);
        connect(consumerPublisher);
        connect(certificationPublisher);
        doCallRealMethod().when(certificationPublisher).publish(any(), any(), any(), anyBoolean(), anyList(), any());
        ReflectionTestUtils.setField(consumerPublisher, "mapper", new ObjectMapper());
        ReflectionTestUtils.setField(consumerPublisher, "lock", new Object());
        doCallRealMethod().when(consumerPublisher).publishOverride(any(), any(), any(), any(), nullable(Boolean.class),
                nullable(BigDecimal.class), anyInt(), any());
        doCallRealMethod().when(consumerPublisher).publishWithdraw(any(), any(), any(), any());
        doCallRealMethod().when(chargingPublisher).publish(any(), any(), any(), nullable(Double.class), any(),
                nullable(String.class), nullable(String.class), any(), any(), any(), nullable(Integer.class), any(), any(),
                nullable(String.class), any());
        doCallRealMethod().when(chargingPublisher).publish(any(), any(), any(), nullable(Double.class), any(),
                nullable(String.class), nullable(String.class), any(), any(), any(), nullable(Integer.class), any(), any(), any());
        doCallRealMethod().when(registerPublisher).publish(any(), any(), any(), anyString(), any(), any(), any());
        ReflectionTestUtils.setField(registry, "clock", Clock.fixed(NOW, ZoneOffset.UTC));
    }

    @BeforeEach
    void freeze(TestInfo test) {
        TenantContext.set(TENANT);
        if (!test.getTestMethod().orElseThrow().getName().startsWith("migrationen")) {
            time = mockStatic(Instant.class, CALLS_REAL_METHODS);
            time.when(Instant::now).thenReturn(NOW);
        }
    }

    @AfterEach
    void thaw() {
        if (time != null) { time.close(); time = null; }
        TenantContext.clear();
    }

    private void connect(Object publisher) throws Exception {
        MqttClient client = mock(MqttClient.class);
        when(client.isConnected()).thenReturn(true);
        ReflectionTestUtils.setField(publisher, "client", client);
        doAnswer(call -> {
            wire.add(call.getArgument(0, String.class) + " qos=" + call.getArgument(2) + " retained="
                    + call.getArgument(3) + "\n" + new String(call.getArgument(1, byte[].class), StandardCharsets.UTF_8));
            return null;
        }).when(client).publish(anyString(), any(byte[].class), anyInt(), anyBoolean());
        doAnswer(call -> {
            String topic = call.getArgument(0);
            MqttMessage message = call.getArgument(1);
            String payload = new String(message.getPayload(), StandardCharsets.UTF_8);
            if (topic.endsWith("/register-write")) {
                JsonNode request = JSON.readTree(payload);
                String correlation = request.path("request_id").asText();
                lastRegisterCorrelation = correlation;
                assertThat(correlation).matches("[0-9a-f]{16,64}");
                assertThat(registerReplies.complete(BOX, correlation, new RegisterWriteResult(correlation, "schreiben", true,
                        3300, 7000, true, true, "Freies Register", null, "Übernommen.", NOW)))
                        .isEqualTo(RegisterWriteRegistry.Delivery.DELIVERED);
                // Random transport correlation is validated above; every other byte is compared.
                payload = payload.replace("\"request_id\":\"" + correlation + "\"", "\"request_id\":\"0000000000000000\"");
            }
            wire.add(topic + " qos=" + message.getQos() + " retained=" + message.isRetained() + "\n" + payload);
            return null;
        }).when(client).publish(anyString(), any(MqttMessage.class));
    }

    private void runAllRunners() throws Exception {
        assertPublishersSilent("Migrationen + Spring-Start");
        Set<String> called = new TreeSet<>();
        try (var files = Files.walk(Path.of("src/main/java"))) {
            List<String> actualSenders = files.filter(p -> p.toString().endsWith(".java")).filter(p -> {
                try { String source = Files.readString(p); return source.contains("import org.eclipse.paho") && source.contains(".publish("); }
                catch (java.io.IOException e) { throw new java.io.UncheckedIOException(e); }
            }).map(p -> p.getFileName().toString().replace(".java", "")).toList();
            assertThat(senders().keySet()).as("AnlageUmzugApiTest: kein neuer MQTT-Sender bleibt ungezaehlt")
                    .containsExactlyInAnyOrderElementsOf(actualSenders);
        }
        for (String name : List.of("uems.BestandsuebernahmeLaeufer", "uems.FunktionBestandLaeufer",
                "zugriff.ZugriffBestandLaeufer")) {
            Object runner = context.getBean(Class.forName("com.voltpilot.api." + name));
            Object result = ReflectionTestUtils.invokeMethod(runner, "lauf");
            assertThat((Integer) ReflectionTestUtils.invokeMethod(result, "fehler")).as(name).isZero();
            assertThat((Integer) ReflectionTestUtils.invokeMethod(result, "kundenbereiche")).as(name).isEqualTo(1);
            called.add(name.substring(name.lastIndexOf('.') + 1));
        }
        for (String name : List.of("ViertelstundeLaeufer", "EndgueltigkeitLaeufer", "LueckenLaeufer",
                "ErsatzwertLaeufer", "KorrekturKaskadeLaeufer", "StrukturAenderungLaeufer",
                "ZeilentextAufbewahrungLaeufer", "PlanZustellungAufbewahrungLaeufer", "LadeparkGrenzeLaeufer",
                "UebergabeLaeufer", "BoxTauschZustellung", "AblaufLaeufer")) {
            String pkg = name.equals("AblaufLaeufer") ? "unterstuetzung"
                    : name.equals("LadeparkGrenzeLaeufer") ? "chargers" : "uems";
            Object runner = context.getBean(Class.forName("com.voltpilot.api." + pkg + "." + name));
            ReflectionTestUtils.invokeMethod(runner, name.equals("BoxTauschZustellung") ? "retryPending" : "takt");
            called.add(name);
        }
        Class<?> catalog = Class.forName("com.voltpilot.api.metrics.UemsLaeuferMelder");
        List<?> entries = (List<?>) ReflectionTestUtils.getField(catalog, "KATALOG");
        assertThat(called).as("Alle 15 Läufer aus docs/agents/root/uems-betriebsueberwachung.md")
                .containsExactlyInAnyOrderElementsOf(entries.stream()
                        .map(e -> (String) ReflectionTestUtils.invokeMethod(e, "klasse")).toList());
        Object reporter = context.getBean(catalog);
        for (Object entry : entries) {
            String label = (String) ReflectionTestUtils.invokeMethod(entry, "label");
            if (!label.startsWith("bestand_")) assertThat((Optional<?>) ReflectionTestUtils.invokeMethod(reporter,
                    "letzterLauf", label)).as("%s: Takt lief wirklich, kein ausgeschalteter Fruehruecksprung", label).isPresent();
        }
        assertThat(meters.find("voltpilot_uems_laeufer_fehler").counters()).hasSize(15);
        meters.find("voltpilot_uems_laeufer_fehler").counters().forEach(c ->
                assertThat(c.count()).as("Läufer darf seinen Fehler nicht nur loggen: %s", c.getId()).isZero());
        assertPublishersSilent("alle 15 Läufer");
    }

    @Test @Order(1)
    void migrationenUndAlleLaeuferSchaltenNichtsUndBewahrenDenBestand() throws Exception {
        if (CAPTURE) {
            same("startup publisher counts; main ApplicationReadyEvent (including control certification)", startup);
            return;
        }
        runAllRunners();
        same("startup publisher counts; main ApplicationReadyEvent (including control certification)", startup);
        assertPublishersSilent("NW-2 nichts wird geschaltet; alle 11 MQTT-Publisher");
        assertThat((List<?>) ReflectionTestUtils.invokeMethod(Class.forName("com.voltpilot.api.uems.Bestandsschutz"),
                "abweichungen", before, fingerprint())).as("main → UEMS: alle Bestandstabellen; Bestandsschutz").isEmpty();
        assertThat(root.queryForObject("SELECT count(*) FROM funktion_teilnahme WHERE site_id=? AND zustand='aktiv' AND uebernommen", Integer.class, SITE)).isEqualTo(1);
        assertThat(root.queryForObject("SELECT count(*) FROM funktion WHERE funktion='messen'", Integer.class)).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM data_source", Integer.class)).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM zugriff WHERE tenant_id=? AND benutzer_sub=? AND rolle='kundenadministrator'",
                Integer.class, TENANT, ACTOR)).isEqualTo(1);
        assertThat(root.queryForObject("SELECT herkunft FROM zugriff_bestand WHERE tenant_id=?", String.class, TENANT))
                .isEqualTo("bestandslauf");
    }

    @Test @Order(2)
    void plan_ReferenzGetSitesSchedule_MainUndMqttScheduleVertrag() throws Exception {
        String plan = http("/schedule", "operator");
        assertThat(JSON.readTree(plan).path("slots")).hasSize(1);
        assertThat(JSON.readTree(plan).path("deviceId").asText()).isEqualTo(BOX.toString());
        same("plan GET /api/v1/sites/{id}/schedule; docs/contracts/mqtt-schedule.schema.json", plan);
    }

    @Test @Order(3)
    void registry_ReferenzEntityRegistryPublisher_V2EntityConfig_BytegleichOhneBestaetigung() throws Exception {
        clearInvocations(registryPublisher);
        TenantContext.set(TENANT);
        var result = registry.pushRegistryBestEffort(SITE);
        assertThat(result.published()).isTrue();
        var call = mockingDetails(registryPublisher).getInvocations().iterator().next();
        assertThat(call.getArgument(0, UUID.class)).isEqualTo(TENANT);
        assertThat(call.getArgument(1, UUID.class)).isEqualTo(SITE);
        assertThat(call.getArgument(2, UUID.class)).isEqualTo(BOX);
        byte[] bytes = call.getArgument(3);
        assertThat(new String(bytes, StandardCharsets.UTF_8)).doesNotContain("data_source_id");
        same("registry EntityRegistryPublisher; docs/contracts/v2/edge-entity-config.md", new String(bytes, StandardCharsets.UTF_8));
    }

    @Test @Order(4)
    void handeingriff_ReferenzBatteryOverrideSetzenUndAufheben_V2Desired() throws Exception {
        wire.clear(); TenantContext.set(TENANT);
        String start = request("POST", "/battery-override", "operator", "{\"kind\":\"speicher_laden\",\"durationMinutes\":30,\"setpointKw\":12}");
        start = mainOverrideBody("POST battery-override", start);
        String clear = request("DELETE", "/battery-override", "operator", null);
        clear = mainOverrideBody("DELETE battery-override", clear);
        assertThat(wire).hasSize(2);
        same("handeingriff POST+DELETE battery-override; docs/contracts/v2/edge-desired.schema.json", JSON.writeValueAsString(List.of(start, clear, wire)));
    }

    @Test @Order(5)
    void register_ReferenzRegisterWritePublisher_MqttRegisterWrite() throws Exception {
        wire.clear(); TenantContext.set(TENANT);
        String response = request("POST", "/register-write", "operator", JSON.writeValueAsString(Map.ofEntries(
                Map.entry("deviceId", BOX), Map.entry("lane", "lan"), Map.entry("host", "192.168.10.22"),
                Map.entry("port", 502), Map.entry("unitId", 1), Map.entry("registerKind", "holding"),
                Map.entry("address", "231"), Map.entry("value", "7000"), Map.entry("expectedBefore", 3300),
                Map.entry("writeFc", 6), Map.entry("note", "NW-2 Bestandsregister"))));
        JsonNode result = JSON.readTree(response);
        assertThat(result.path("ok").asBoolean()).as(response).isTrue();
        assertThat(result.path("outcome").asText()).isEqualTo("uebernommen");
        String correlation = result.path("requestId").asText();
        assertThat(correlation).matches("[0-9a-f]{16,64}").isEqualTo(lastRegisterCorrelation);
        assertThat(wire).hasSize(1);
        same("register POST register-write; docs/contracts/mqtt-register-write.schema.json", wire.getFirst());
        same("register HTTP result; docs/contracts/mqtt-register-write.schema.json",
                response.replace("\"requestId\":\"" + correlation + "\"", "\"requestId\":\"0000000000000000\""));
    }

    @Test @Order(6)
    void verbraucher_ReferenzConsumerOverrideSetzenUndAufheben_V2Desired() throws Exception {
        wire.clear(); TenantContext.set(TENANT);
        String start = request("POST", "/consumers/" + CONSUMER + "/override", "operator", "{\"action\":\"start\",\"durationMinutes\":30}");
        start = mainOverrideBody("POST consumers/{id}/override", start);
        String clear = request("DELETE", "/consumers/" + CONSUMER + "/override", "operator", null);
        clear = mainOverrideBody("DELETE consumers/{id}/override", clear);
        assertThat(wire).hasSize(2);
        same("verbraucher POST+DELETE override; docs/contracts/v2/edge-desired.schema.json", JSON.writeValueAsString(List.of(start, clear, wire)));
    }

    @Test @Order(7)
    void ladegrenze_ReferenzChargingConfigPublisher_OhneNetzanschlussGilt277Kw() throws Exception {
        wire.clear(); TenantContext.set(TENANT);
        charging.pushFor(TENANT, SITE);
        assertThat(wire).hasSize(1);
        assertThat(JSON.readTree(wire.getFirst().split("\n", 2)[1]).path("grid_limit_kw").asDouble()).isEqualTo(277);
        same("laden ChargingConfigPublisher /v2/charging-config; docs/contracts/mqtt-charging-config.schema.json", wire.getFirst());
    }

    @Test @Order(8)
    void freigaben_ReferenzMainBetriebsmodellUndDeviceControlActivation() throws Exception {
        wire.clear();
        certifications.republishFleet("NW-2");
        assertThat(wire).hasSize(1);
        assertThat(JSON.readTree(wire.getFirst().split("\n", 2)[1]).path("activated").asBoolean()).isTrue();
        same("freigaben ControlCertificationPublisher /v2/control-certification; docs/contracts/mqtt-control-certification.schema.json", wire.getFirst());
        same("freigaben site_profile_state + device_control_activation; docs/edge-runtime.md",
                JSON.writeValueAsString(root.queryForList("SELECT profile,state,activated_by,note FROM site_profile_state p "
                        + "JOIN device d ON d.site_id=p.site_id JOIN device_control_activation a ON a.device_id=d.id WHERE p.site_id=?", SITE)));
    }

    @Test @Order(9)
    void ocpp_ReferenzActionPermissions_BestandskontoLeerRealmRolleVonVorher() throws Exception {
        for (String role : List.of("operator", "site-admin", "admin"))
            same("ocpp GET /ocpp/action-permissions realm=" + role + "; docs/contracts/mqtt-ocpp-command.schema.json", http("/ocpp/action-permissions", role));
    }

    @Test @Order(10)
    void ladegrenze_GebundenerNetzanschlussPrueftVereinbartStattDialogwert() throws Exception {
        org.junit.jupiter.api.Assumptions.assumeFalse(CAPTURE, "Netzanschluss-Schreibweg existiert erst auf UEMS");
        root.update("INSERT INTO netzanschluss(id,tenant_id,standort_id,kennzeichen,name,vereinbart_kw,messung) "
                + "VALUES (?,?,?,'NA-1','Werkanschluss',200,'RLM')", id(20), TENANT, id(11));
        root.update("INSERT INTO anlage_netzanschluss(tenant_id,site_id,netzanschluss_id,gueltig_ab) VALUES (?,?,?,DATE '2024-03-12')",
                TENANT, SITE, id(20));
        wire.clear(); TenantContext.set(TENANT);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> ReflectionTestUtils.invokeMethod(charging,
                "saveCustomerFrame", SITE, 250.0, 999.0, ACTOR))
                .as("PUT charging-frame: 200 kW aus NA-1 schlägt 999 kW aus dem Dialog")
                .isInstanceOf(org.springframework.web.server.ResponseStatusException.class).hasMessageContaining("200");
        assertThat(wire).as("abgelehnte Grenze sendet nichts").isEmpty();
        ReflectionTestUtils.invokeMethod(charging, "saveCustomerFrame", SITE, 150.0, 999.0, ACTOR);
        assertThat(wire).hasSize(1);
        assertThat(JSON.readTree(wire.getFirst().split("\n", 2)[1]).path("grid_limit_kw").asDouble()).isEqualTo(150);
    }

    /**
     * AP-14 IP-20: records the real HTTP answers used by the before/after stage.
     * The method is dormant in normal test runs and is copied unchanged into the
     * documented main archive for the before recording.
     */
    @Test @Order(11)
    void buehneVorherNachherAntwortenAufzeichnen() throws Exception {
        String output = System.getProperty("buehne.antworten");
        org.junit.jupiter.api.Assumptions.assumeTrue(output != null, "nur der IP-20-Werkzeuglauf zeichnet Portalantworten auf");

        var ds = new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
        try (var connection = ds.getConnection()) {
            ScriptUtils.executeSqlScript(connection, new ClassPathResource("uems/nw2/u2-main-seed.sql"));
        }
        if (!CAPTURE) {
            // Der globale Startläufer lief für U1 bereits und hält seinen einmaligen Cursor. U2 wird danach
            // absichtlich als zweiter Bühnenfall gesät, deshalb derselbe mandantenbezogene Produktionsdienst,
            // den BestandsuebernahmeApiTest für den Drei-Anlagen-Fall verwendet.
            try {
                TenantContext.set(U2_TENANT);
                Object service = context.getBean(Class.forName("com.voltpilot.api.uems.BestandsuebernahmeService"));
                Object result = ReflectionTestUtils.invokeMethod(service, "uebernehmen");
                assertThat((Integer) ReflectionTestUtils.invokeMethod(result, "vorschlaege")).isEqualTo(3);
            } finally {
                TenantContext.clear();
            }
            Object rechte = context.getBean(Class.forName("com.voltpilot.api.zugriff.ZugriffBestandLaeufer"));
            Object rechteLauf = ReflectionTestUtils.invokeMethod(rechte, "lauf");
            assertThat((Integer) ReflectionTestUtils.invokeMethod(rechteLauf, "fehler")).isZero();
        }

        var dokument = JSON.createObjectNode();
        dokument.put("schema", 1);
        dokument.put("stand", CAPTURE ? "main-vorher" : "uems-nachher");
        dokument.put("anmeldung", "ersetzt; Antworten stammen aus MockMvc mit Kunden-JWT");
        dokument.put("liveTelemetrie", "nicht erzeugt; leere/fehlende Messwerte bleiben ehrlich leer");
        var faelle = dokument.putObject("faelle");
        faelle.set("u1", portalStand(TENANT, List.of(SITE)));

        var u2 = faelle.putObject("u2");
        u2.set("vorBestaetigung", portalStand(U2_TENANT, List.of(U2_HALLE_1, U2_HALLE_2, U2_LINDACH)));
        if (!CAPTURE) {
            JsonNode vorschlag = JSON.readTree(apiAntwort("GET", "/api/v1/standorte/vorschlag", U2_TENANT, null)
                    .path("body").asText());
            // Die Aufzeichnung faehrt denselben Weg wie die Buehne: der "Gehoert zu"-Waehler aus
            // PR 985 legt Halle 2 zu Halle 1, die geleerte Gruppe faellt weg. Aus drei
            // vorgeschlagenen Anlagen werden ZWEI Standorte - der Stand nach der Bestaetigung
            // muss zu den Bildern passen, sonst zeigt das Portal drei.
            // Zugeordnet wird ueber den NAMEN, nicht ueber die Position: die Reihenfolge der
            // Vorschlaege ist keine Zusage, und ein Index-Griff paart sonst die falschen zwei.
            var gruppen = JSON.createArrayNode();
            com.fasterxml.jackson.databind.node.ArrayNode halle1Ids = null;
            var nachHalle1 = new java.util.ArrayList<JsonNode>();
            for (JsonNode vorgeschlagen : vorschlag.path("gruppen")) {
                String name = vorgeschlagen.path("name").asText();
                if (name.contains("Halle 2")) {
                    nachHalle1.add(vorgeschlagen);
                    continue;
                }
                boolean lindach = name.contains("Lindach");
                var gruppe = JSON.createObjectNode();
                gruppe.put("name", name);
                gruppe.put("zeitzone", vorgeschlagen.path("zeitzone").asText("Europe/Berlin"));
                var adresse = gruppe.putObject("adresse");
                adresse.put("strasse", lindach ? "Werkstrasse 8" : "Industriestrasse 4");
                adresse.put("plz", lindach ? "84123" : "84347");
                adresse.put("ort", lindach ? "Lindach" : "Ahrenberg");
                adresse.put("land", "DE");
                var ids = gruppe.putArray("vorschlagIds");
                vorgeschlagen.path("anlagen").forEach(a -> ids.add(a.path("vorschlagId").asText()));
                if (name.contains("Halle 1")) halle1Ids = ids;
                gruppen.add(gruppe);
            }
            assertThat(halle1Ids).as("die Gruppe Halle 1 traegt die Zusammenlegung").isNotNull();
            for (JsonNode spaet : nachHalle1) {
                final var ziel = halle1Ids;
                spaet.path("anlagen").forEach(a -> ziel.add(a.path("vorschlagId").asText()));
            }
            var anfrage = JSON.createObjectNode();
            anfrage.set("gruppen", gruppen);
            var post = apiAntwort("POST", "/api/v1/standorte/vorschlag/bestaetigen", U2_TENANT,
                    JSON.writeValueAsString(anfrage));
            assertThat(post.path("status").asInt()).as(post.toPrettyString()).isEqualTo(200);
            assertThat(JSON.readTree(post.path("body").asText()).path("standortIds")).hasSize(2);
            ((com.fasterxml.jackson.databind.node.ObjectNode) u2.path("vorBestaetigung").path("antworten"))
                    .set("POST /api/v1/standorte/vorschlag/bestaetigen", post);
            u2.set("nachBestaetigung", portalStand(U2_TENANT, List.of(U2_HALLE_1, U2_HALLE_2, U2_LINDACH)));
        }
        Files.writeString(Path.of(output), JSON.writerWithDefaultPrettyPrinter().writeValueAsString(dokument));
    }

    private com.fasterxml.jackson.databind.node.ObjectNode portalStand(UUID tenant, List<UUID> sites) throws Exception {
        var stand = JSON.createObjectNode();
        var antworten = stand.putObject("antworten");
        List<String> gemeinsam = List.of(
                "/api/v1/me", "/api/v1/tenant-context", "/api/v1/sites", "/api/v1/devices",
                "/api/v1/overview", "/api/v1/earnings?range=day", "/api/v1/standorte",
                "/api/v1/unternehmen", "/api/v1/funktionen", "/api/v1/kennzahlen",
                "/api/v1/standorte/vorschlag", "/api/v1/tenant/cockpit-layout?surface=portfolio");
        for (String path : gemeinsam) antworten.set("GET " + path, apiAntwort("GET", path, tenant, null));
        JsonNode standorte = JSON.readTree(antworten.path("GET /api/v1/standorte").path("body").asText());
        for (JsonNode standort : standorte.path("standorte")) {
            String path = "/api/v1/standorte/" + standort.path("id").asText() + "/ausfall";
            antworten.set("GET " + path, apiAntwort("GET", path, tenant, null));
        }
        for (UUID site : sites) {
            String basis = "/api/v1/sites/" + site;
            for (String suffix : List.of("", "/earnings?range=day", "/control-status", "/curtailment-status",
                    "/chargers", "/sources", "/weather", "/schedule",
                    "/bilanz?periode=tag",
                    "/history?range=day&at=2026-10-20", "/cockpit-layout", "/eigene-auswertung",
                    "/rollen/pv", "/rollen/verbrauch", "/rollen/netz", "/rollen/consumer", "/rollen/grid",
                    "/topology", "/profile", "/entities", "/flows", "/profiles", "/interventions",
                    "/entity-strategies", "/consumers", "/consumer-status")) {
                String path = basis + suffix;
                antworten.set("GET " + path, apiAntwort("GET", path, tenant, null));
            }
            String telemetryKey = basis
                    + "/telemetry?from=2026-10-20T05%3A15%3A30.000Z&to=2026-10-20T08%3A15%3A30.000Z";
            String telemetryRequest = basis
                    + "/telemetry?from=2026-10-20T05:15:30.000Z&to=2026-10-20T08:15:30.000Z";
            antworten.set("GET " + telemetryKey, apiAntwort("GET", telemetryRequest, tenant, null));
        }
        return stand;
    }

    private com.fasterxml.jackson.databind.node.ObjectNode apiAntwort(String method, String path, UUID tenant,
            String body) throws Exception {
        var req = org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                .request(org.springframework.http.HttpMethod.valueOf(method), path)
                .with(jwt().jwt(j -> j.subject(ACTOR).claim("tenant_id", tenant.toString())
                        .claim("preferred_username", ACTOR))
                        .authorities(new SimpleGrantedAuthority("ROLE_admin"),
                                new SimpleGrantedAuthority("KONTO_benutzer")));
        if (body != null) req.contentType("application/json").content(body);
        var response = mvc.perform(req).andReturn().getResponse();
        var result = JSON.createObjectNode();
        result.put("status", response.getStatus());
        result.put("contentType", Optional.ofNullable(response.getContentType()).orElse("application/json"));
        result.put("body", response.getContentAsString(StandardCharsets.UTF_8));
        return result;
    }

    @AfterAll
    void finish() throws Exception {
        if (time != null) time.close();
        TenantContext.clear();
        if (System.getProperty("nw2.observed") != null)
            Files.writeString(Path.of(System.getProperty("nw2.observed")), JSON.writerWithDefaultPrettyPrinter().writeValueAsString(captured));
        if (CAPTURE) {
            assertThat(captured).as("Vollstaendige Aufnahme, kein Teil-Orakel nach einem Fehler").hasSize(13);
            Files.writeString(Path.of(System.getProperty("nw2.capture")), JSON.writerWithDefaultPrettyPrinter().writeValueAsString(captured));
        }
    }

    private String http(String path, String role) throws Exception {
        return request("GET", path, role, null);
    }

    private String request(String method, String path, String role, String body) throws Exception {
        var req = org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                .request(org.springframework.http.HttpMethod.valueOf(method), "/api/v1/sites/" + SITE + path)
                .with(jwt().jwt(j -> j.subject(ACTOR).claim("tenant_id", TENANT.toString()).claim("preferred_username", ACTOR))
                .authorities(new SimpleGrantedAuthority("ROLE_" + role)));
        if (body != null) req.contentType("application/json").content(body);
        var response = mvc.perform(req).andReturn().getResponse();
        assertThat(response.getStatus()).as(path + " " + response.getContentAsString()).isEqualTo(200);
        return response.getContentAsString(StandardCharsets.UTF_8);
    }

    private String mainOverrideBody(String route, String body) throws Exception {
        JsonNode value = JSON.readTree(body);
        assertThat(value.path("pushed")).as(route + ": Bestandsbox erreicht")
                .isEqualTo(com.fasterxml.jackson.databind.node.BooleanNode.TRUE);
        if (CAPTURE) {
            assertThat(value.has("pushReason")).as(route + ": main kennt pushReason noch nicht").isFalse();
            return body;
        }
        assertThat(value.has("pushReason")).as(route + ": additive Erweiterung seit 439daaf4 vorhanden").isTrue();
        assertThat(value.get("pushReason").isNull()).as(route + ": kein verlorenes Steuerziel; " + body).isTrue();
        // Remove ONLY the approved literal suffix. No reserialization: order, decimal scale,
        // whitespace and every other byte (including any new field) stay in the comparison.
        String suffix = ",\"pushReason\":null}";
        assertThat(body).as(route + ": genau eine benannte HTTP-Erweiterung").endsWith(suffix);
        assertThat(body.indexOf("\"pushReason\"")).isEqualTo(body.lastIndexOf("\"pushReason\""));
        return body.substring(0, body.length() - suffix.length()) + "}";
    }

    private void same(String referenceName, String actual) {
        captured.put(referenceName, actual);
        if (!CAPTURE) {
            assertThat(reference.has(referenceName)).as("Referenz vorhanden: %s", referenceName).isTrue();
            String expected = reference.path(referenceName).asText();
            assertThat(actual.getBytes(StandardCharsets.UTF_8))
                    .withFailMessage("Referenz main %s: %s%nVORHER: %s%nNACHHER: %s", MAIN, referenceName, expected, actual)
                    .isEqualTo(expected.getBytes(StandardCharsets.UTF_8));
        }
    }

    private Map<String, Object> senders() {
        var result = new LinkedHashMap<String, Object>();
        for (Object sender : List.of(registryPublisher, probePublisher, chargingPublisher, boostPublisher,
                registerPublisher, flowPublisher, certificationPublisher, otaPublisher, provisioningPublisher,
                measurementPublisher, consumerPublisher))
            result.put(mockingDetails(sender).getMockCreationSettings().getTypeToMock().getSimpleName(), sender);
        return result;
    }

    private void assertPublishersSilent(String phase) {
        senders().forEach((name, sender) -> assertThat(mockingDetails(sender).getInvocations()).as(phase + ": " + name).isEmpty());
    }

    @SuppressWarnings("unchecked")
    private static Map<String, String> fingerprint() throws Exception {
        return (Map<String, String>) ReflectionTestUtils.invokeMethod(Class.forName("com.voltpilot.api.uems.Bestandsschutz"),
                "fingerabdruck", root, UEMS_STATE);
    }
    private static UUID id(int n) { return UUID.fromString("14000000-0000-0000-0000-" + "%012d".formatted(n)); }
}
