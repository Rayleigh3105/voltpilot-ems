package com.voltpilot.api.consumers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.consumers.ConsumerRepository.ConsumerRow;
import com.voltpilot.api.consumers.ConsumerRepository.PolicyRow;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.flows.FlowActivationService;
import com.voltpilot.api.flows.FlowCatalog;
import com.voltpilot.api.flows.FlowCompiler;
import com.voltpilot.api.flows.FlowCompilerException;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import com.voltpilot.api.repo.FlowRepository;
import com.voltpilot.api.repo.FlowRepository.FlowVersionRow;
import com.voltpilot.api.tenant.TenantContext;
import java.io.IOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.eclipse.paho.client.mqttv3.MqttClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.web.server.ResponseStatusException;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * The Inkrement-4 activation path against a REAL broker (§11/§16/§21):
 * activation compiles BEFORE any state change and rolls the generated artifact
 * out retained; a compiler failure is a 503 that leaves the previously active
 * version untouched; the honest flag refusals; the V-5 conflict names the
 * foreign automation; and - THE §16 proof - the stop paths (deactivate/pause)
 * run with BOTH feature flags OFF and retract the retained artifact ("Flag aus
 * ≠ gestoppt", the OTA/flow lesson).
 */
@Testcontainers(disabledWithoutDocker = true)
class ConsumerPolicyActivationBrokerTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final UUID ENTITY = UUID.fromString("6f1d2c3b-4a59-4687-9abc-def012345678");
    private static final UUID POLICY = UUID.fromString("b58a3c21-7e90-4d12-a345-6789abcdef02");
    private static final UUID GENERATED_FLOW = ConsumerPolicyCompiler.generatedFlowId(ENTITY);

    @Container
    static final GenericContainer<?> EMQX = new GenericContainer<>(
            DockerImageName.parse("emqx/emqx:5.8.3")).withExposedPorts(1883);

    private static String brokerUrl() {
        return "tcp://" + EMQX.getHost() + ":" + EMQX.getMappedPort(1883);
    }

    private ConsumerRepository repo;
    private FlowRepository flows;
    private EntityRegistryRepository entities;
    private ConsumerAuditRepository audit;
    private String artifactJson;

    @BeforeEach
    void setUp() throws IOException {
        repo = mock(ConsumerRepository.class);
        flows = mock(FlowRepository.class);
        entities = mock(EntityRegistryRepository.class);
        audit = mock(ConsumerAuditRepository.class);
        artifactJson = Files.readString(Path.of("..", "..", "edge-app", "nodered", "flowc",
                "testdata", "consumer-reactive.artifact.json"));
        TenantContext.set(TENANT);
        when(entities.batteryAsset(SITE)).thenReturn(
                new EntityRegistryRepository.BatteryAsset(DEVICE, null, null, null, null));
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    @SuppressWarnings("unchecked")
    private static <T> ObjectProvider<T> provider(T value) {
        ObjectProvider<T> p = mock(ObjectProvider.class);
        when(p.getIfAvailable()).thenReturn(value);
        return p;
    }

    private static ConsumerRow wallbox(String edgeSourceId) {
        return new ConsumerRow(ENTITY, "wallbox", "Wallbox Garage", null, edgeSourceId,
                "continuous", new BigDecimal("11.0"), new BigDecimal("1.4"), null,
                new BigDecimal("0.1"), null, "consumer_first", "allow", false, null,
                null, null, null, null, null, "off", true, 1);
    }

    private static PolicyRow policyRow(String lifecycle) {
        String doc = """
                {
                  "schema_version": "1.0",
                  "entity_id": "%s",
                  "timezone": "Europe/Berlin",
                  "requirements": [
                    { "id": "charge-when-connected", "kind": "reactive",
                      "enforcement": "must_run",
                      "condition": { "signal": "consumer.vehicle_connected",
                        "operator": "eq", "value": true, "max_age_s": 20 },
                      "target": { "kind": "percent", "value": 100 } }
                  ]
                }
                """.formatted(ENTITY);
        return new PolicyRow(POLICY, ENTITY, 3, lifecycle, doc, "sha256:x", "tester",
                Instant.parse("2026-08-09T12:00:00Z"));
    }

    private ConsumerPolicyActivationService service(boolean controlOn, boolean compilerOn,
            FlowCompiler flowc, FlowDeploymentPublisher publisher) {
        ConsumerPolicyCompiler compiler =
                new ConsumerPolicyCompiler(new ConsumerSignalCatalog(), MAPPER);
        ConsumerPolicyCompiler.WindowSource windows =
                (siteId, signal, op, value, from, to) -> List.of();
        FlowActivationService deployments = new FlowActivationService(flows, entities,
                provider((FlowCompiler) null), provider(publisher), MAPPER, true);
        return new ConsumerPolicyActivationService(repo,
                new ConsumerPolicyValidator(new ConsumerSignalCatalog()), compiler,
                windows, provider(flowc), flows, new FlowCatalog(MAPPER), deployments, audit,
                MAPPER, controlOn, compilerOn,
                Clock.fixed(Instant.parse("2026-08-10T09:00:00Z"), ZoneOffset.UTC));
    }

    private FlowVersionRow generatedRow(String lifecycle, String artifact) {
        return new FlowVersionRow(GENERATED_FLOW, 3, SITE, "Verbraucherregel: Wallbox Garage",
                "edge", lifecycle, "{}", null, artifact, Instant.now(), Instant.now(), null, null);
    }

    // -- activation ----------------------------------------------------------

    @Test
    void activationCompilesRollsOutRetainedAndAudits() throws Exception {
        when(repo.findForSite(SITE, ENTITY)).thenReturn(wallbox("edge-src-1"));
        when(repo.latestPolicy(SITE, ENTITY)).thenReturn(policyRow("draft"));
        when(flows.activeVersionsForSiteExcept(SITE, "edge", GENERATED_FLOW))
                .thenReturn(List.of());
        when(flows.versionsForSite(SITE)).thenReturn(List.of(generatedRow("active", artifactJson)));

        FlowCompiler flowc = doc -> {
            try {
                return MAPPER.readTree(artifactJson);
            } catch (IOException e) {
                throw new IllegalStateException(e);
            }
        };
        FlowDeploymentPublisher publisher = new FlowDeploymentPublisher(brokerUrl(), "", "");
        var outcome = service(true, true, flowc, publisher).activate(SITE, ENTITY, "tester");

        assertThat(outcome.activated()).isTrue();
        assertThat(outcome.published()).isTrue();
        verify(repo).retireActivePolicy(SITE, ENTITY);
        verify(repo).markPolicyActive(SITE, ENTITY, 3);
        verify(repo).setEnabled(SITE, ENTITY, true);
        verify(flows).upsertGenerated(eq(TENANT), eq(SITE), eq(GENERATED_FLOW), eq(3),
                anyString(), eq("edge"), anyString());
        verify(flows).markActive(eq(GENERATED_FLOW), eq(3), anyString());
        verify(audit).append(eq(SITE), eq(ENTITY), eq("policy_activated"), eq(POLICY), eq(3),
                eq("tester"), anyString());

        // The retained deployment set carries the generated artifact.
        JsonNode deployment = MAPPER.readTree(awaitRetained(
                FlowDeploymentPublisher.flowsTopic(TENANT, SITE, DEVICE)));
        assertThat(deployment.path("artifacts")).hasSize(1);
        assertThat(deployment.path("artifacts").get(0).path("content_hash").asText())
                .isEqualTo(MAPPER.readTree(artifactJson).path("content_hash").asText());
    }

    @Test
    void aCompilerFailureIs503AndLeavesTheActiveVersionUntouched() {
        when(repo.findForSite(SITE, ENTITY)).thenReturn(wallbox("edge-src-1"));
        when(repo.latestPolicy(SITE, ENTITY)).thenReturn(policyRow("draft"));
        when(flows.activeVersionsForSiteExcept(SITE, "edge", GENERATED_FLOW))
                .thenReturn(List.of());

        FlowCompiler broken = doc -> {
            throw new FlowCompilerException("compiler_unavailable", "Sidecar nicht erreichbar.");
        };
        assertThatThrownBy(() -> service(true, true, broken, null)
                .activate(SITE, ENTITY, "tester"))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("503");
        // Nothing changed: the previously active version stays in force.
        verify(repo, never()).retireActivePolicy(any(), any());
        verify(repo, never()).markPolicyActive(any(), any(), anyInt());
        verify(repo, never()).setEnabled(any(), any(), anyBoolean());
        verify(flows, never()).markActive(any(), anyInt(), any());
    }

    @Test
    void theHonestFlagRefusalsChangeNothing() {
        when(repo.findForSite(SITE, ENTITY)).thenReturn(wallbox("edge-src-1"));
        when(repo.latestPolicy(SITE, ENTITY)).thenReturn(policyRow("draft"));
        when(flows.activeVersionsForSiteExcept(SITE, "edge", GENERATED_FLOW))
                .thenReturn(List.of());

        var offOutcome = service(false, false, null, null).activate(SITE, ENTITY, "t");
        assertThat(offOutcome.activated()).isFalse();
        assertThat(offOutcome.reason()).isEqualTo("activation_disabled");

        // Control on, compiler off, artifact needed -> compiler_disabled.
        var halfOutcome = service(true, false, null, null).activate(SITE, ENTITY, "t");
        assertThat(halfOutcome.activated()).isFalse();
        assertThat(halfOutcome.reason()).isEqualTo("compiler_disabled");

        verify(repo, never()).markPolicyActive(any(), any(), anyInt());
        verify(audit, never()).append(any(), any(), anyString(), any(), any(), any(), any());
    }

    @Test
    void aForeignActiveFlowClaimingTheEntityRefusesWithItsName() throws Exception {
        when(repo.findForSite(SITE, ENTITY)).thenReturn(wallbox("edge-src-1"));
        when(repo.latestPolicy(SITE, ENTITY)).thenReturn(policyRow("draft"));

        // Another ACTIVE flow claims the wallbox entity (a guided automation).
        String foreignDoc = """
                {
                  "schema_version": "1.0", "flow_id": "aaaaaaaa-1111-4222-8333-444444444444",
                  "flow_version": 1, "name": "Wallbox nur bei PV-Überschuss", "runtime": "edge",
                  "site_id": "%s",
                  "nodes": [ { "id": "c1", "type": "vp.entity.control", "type_version": "1.0.0",
                    "parameters": { "entity_id": "%s", "command": "on_off", "ttl_s": 300 },
                    "claims": [ { "entity_id": "%s", "commands": ["on_off"] } ] } ],
                  "edges": [], "triggers": [ { "id": "t1", "kind": "slot-boundary" } ]
                }
                """.formatted(SITE, ENTITY, ENTITY);
        FlowVersionRow foreign = new FlowVersionRow(
                UUID.fromString("aaaaaaaa-1111-4222-8333-444444444444"), 1, SITE,
                "Wallbox nur bei PV-Überschuss", "edge", "active", foreignDoc, null, null,
                Instant.now(), Instant.now(), null, null);
        when(flows.activeVersionsForSiteExcept(SITE, "edge", GENERATED_FLOW))
                .thenReturn(List.of(foreign));

        assertThatThrownBy(() -> service(true, true, doc -> MAPPER.createObjectNode(), null)
                .activate(SITE, ENTITY, "t"))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("Wallbox nur bei PV-Überschuss");
        verify(repo, never()).markPolicyActive(any(), any(), anyInt());
    }

    @Test
    void anUnconnectedConsumerCannotActivate() {
        when(repo.findForSite(SITE, ENTITY)).thenReturn(wallbox(null));
        when(repo.latestPolicy(SITE, ENTITY)).thenReturn(policyRow("draft"));
        assertThatThrownBy(() -> service(true, true, null, null).activate(SITE, ENTITY, "t"))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("422");
    }

    // -- the §16 stop paths: flags OFF, retained artifact retracted ----------

    @Test
    void deactivateWorksWithBothFlagsOffAndRetractsTheRetainedArtifact() throws Exception {
        FlowDeploymentPublisher publisher = new FlowDeploymentPublisher(brokerUrl(), "", "");

        // Seed the broker with a deployment carrying the artifact (the state a
        // flag-flip-off would otherwise leave running forever).
        var seeded = service(true, true, doc -> {
            try {
                return MAPPER.readTree(artifactJson);
            } catch (IOException e) {
                throw new IllegalStateException(e);
            }
        }, publisher);
        when(repo.findForSite(SITE, ENTITY)).thenReturn(wallbox("edge-src-1"));
        when(repo.latestPolicy(SITE, ENTITY)).thenReturn(policyRow("draft"));
        when(flows.activeVersionsForSiteExcept(SITE, "edge", GENERATED_FLOW))
                .thenReturn(List.of());
        when(flows.versionsForSite(SITE)).thenReturn(List.of(generatedRow("active", artifactJson)));
        assertThat(seeded.activate(SITE, ENTITY, "t").published()).isTrue();
        assertThat(MAPPER.readTree(awaitRetained(
                FlowDeploymentPublisher.flowsTopic(TENANT, SITE, DEVICE)))
                .path("artifacts")).hasSize(1);

        // NOW both flags are OFF - the echte Stopppfad must still stop it.
        when(repo.activePolicy(SITE, ENTITY)).thenReturn(policyRow("active"));
        when(flows.versionsForSite(SITE)).thenReturn(List.of(generatedRow("retired",
                artifactJson)));
        var stopped = service(false, false, null, publisher).deactivate(SITE, ENTITY, "t");
        assertThat(stopped.published()).isTrue();
        // Once from the seeding activation, once from the stop path itself.
        verify(repo, org.mockito.Mockito.times(2)).retireActivePolicy(SITE, ENTITY);
        verify(flows, org.mockito.Mockito.atLeastOnce()).retireActive(GENERATED_FLOW);
        verify(audit).append(eq(SITE), eq(ENTITY), eq("policy_deactivated"), eq(POLICY), eq(3),
                eq("t"), any());

        // The retained set no longer carries the artifact.
        JsonNode afterStop = MAPPER.readTree(awaitRetained(
                FlowDeploymentPublisher.flowsTopic(TENANT, SITE, DEVICE)));
        assertThat(afterStop.path("artifacts")).isEmpty();
    }

    @Test
    void pauseWorksWithBothFlagsOffFlipsTheSwitchAndRetracts() throws Exception {
        FlowDeploymentPublisher publisher = new FlowDeploymentPublisher(brokerUrl(), "", "");
        when(repo.findForSite(SITE, ENTITY)).thenReturn(wallbox("edge-src-1"));
        when(flows.versionsForSite(SITE)).thenReturn(List.of());

        var outcome = service(false, false, null, publisher).pause(SITE, ENTITY, "t");
        assertThat(outcome.published()).isTrue();
        verify(repo).setEnabled(SITE, ENTITY, false);
        verify(flows).retireActive(GENERATED_FLOW);
        verify(audit).append(eq(SITE), eq(ENTITY), eq("paused"), any(), any(), eq("t"), any());
        assertThat(MAPPER.readTree(awaitRetained(
                FlowDeploymentPublisher.flowsTopic(TENANT, SITE, DEVICE)))
                .path("artifacts")).isEmpty();
    }

    private String awaitRetained(String topic) throws Exception {
        MqttClient subscriber = new MqttClient(brokerUrl(),
                "test-sub-" + UUID.randomUUID(), new MemoryPersistence());
        try {
            MqttConnectOptions options = new MqttConnectOptions();
            options.setCleanSession(true);
            subscriber.connect(options);
            CountDownLatch latch = new CountDownLatch(1);
            AtomicReference<String> received = new AtomicReference<>();
            subscriber.subscribe(topic, 1, (t, message) -> {
                if (message.getPayload().length > 0) {
                    received.set(new String(message.getPayload(), StandardCharsets.UTF_8));
                    latch.countDown();
                }
            });
            latch.await(10000, TimeUnit.MILLISECONDS);
            assertThat(received.get()).as("retained deployment on " + topic).isNotNull();
            return received.get();
        } finally {
            try {
                subscriber.disconnect();
                subscriber.close();
            } catch (Exception e) {
                // best-effort cleanup
            }
        }
    }
}
