package com.voltpilot.api.flows;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.repo.FlowRepository;
import com.voltpilot.api.repo.FlowRepository.FlowVersionRow;
import com.voltpilot.api.tenant.TenantContext;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

/**
 * Activation honesty + the D-11 publisher wiring, against the HAND-BUILT
 * contract fixture artifact: no compiler → "Compiler folgt", nothing changes;
 * flag off → refused; flag on + compiler → previous version retired, artifact
 * stored, the COMPLETE deployment set published retained to the gateway.
 */
class FlowActivationServiceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final UUID FLOW = UUID.fromString("4e1c2b3a-5d6e-4f70-8123-456789abcdef");

    /** Captures instead of connecting to a broker. */
    static class CapturingPublisher extends FlowDeploymentPublisher {
        UUID tenant;
        UUID site;
        UUID device;
        byte[] payload;

        CapturingPublisher() {
            super("tcp://unused:1883", "", "");
        }

        @Override
        public synchronized boolean publishDeployment(UUID tenantId, UUID siteId, UUID deviceId,
                byte[] bytes) {
            this.tenant = tenantId;
            this.site = siteId;
            this.device = deviceId;
            this.payload = bytes;
            return true;
        }
    }

    private FlowRepository flows;
    private EntityRegistryRepository entities;
    private CapturingPublisher publisher;
    private JsonNode fixtureArtifact;

    @BeforeEach
    void setUp() throws IOException {
        flows = mock(FlowRepository.class);
        entities = mock(EntityRegistryRepository.class);
        publisher = new CapturingPublisher();
        fixtureArtifact = MAPPER.readTree(Files.readString(Path.of("..", "..", "docs",
                "contracts", "v2", "examples", "flow-artifact.valid.artifact.json")));
        TenantContext.set(TENANT);
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    @SuppressWarnings("unchecked")
    private static <T> ObjectProvider<T> provider(T value) {
        ObjectProvider<T> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(value);
        return provider;
    }

    private FlowActivationService service(FlowCompiler compiler, boolean enabled) {
        return new FlowActivationService(flows, entities,
                mock(com.voltpilot.api.repo.FlowClaimRepository.class), new FlowCatalog(MAPPER),
                provider((com.voltpilot.api.entities.EntityRegistryService) null),
                provider(compiler), provider(publisher), MAPPER, enabled,
                Clock.fixed(Instant.parse("2026-07-18T12:00:00Z"), ZoneOffset.UTC));
    }

    private FlowVersionRow row(int version, String lifecycle, String artifactJson) {
        return new FlowVersionRow(FLOW, version, SITE, "Marktoptimierung", "edge", lifecycle,
                "{}", null, artifactJson, Instant.now(), Instant.now(), null, null);
    }

    @Test
    void withoutCompilerActivationReportsCompilerFolgtAndChangesNothing() {
        FlowActivationService service = service(null, true);
        FlowActivationService.ActivationOutcome outcome = service.activate(SITE,
                row(2, "simulated", null), MAPPER.createObjectNode());
        assertThat(outcome.activated()).isFalse();
        assertThat(outcome.reason()).isEqualTo("compiler_missing");
        assertThat(outcome.message()).contains("Compiler folgt");
        assertThat(outcome.published()).isFalse();
        verify(flows, never()).markActive(any(), org.mockito.ArgumentMatchers.anyInt(),
                anyString());
        assertThat(publisher.payload).isNull();
    }

    @Test
    void withCompilerButFlagOffActivationIsRefused() {
        FlowCompiler compiler = doc -> fixtureArtifact;
        FlowActivationService service = service(compiler, false);
        FlowActivationService.ActivationOutcome outcome = service.activate(SITE,
                row(2, "simulated", null), MAPPER.createObjectNode());
        assertThat(outcome.activated()).isFalse();
        assertThat(outcome.reason()).isEqualTo("activation_disabled");
        assertThat(publisher.payload).isNull();
    }

    @Test
    void withCompilerAndFlagTheCompleteDeploymentSetIsPublishedToTheGateway()
            throws IOException {
        when(entities.batteryAsset(SITE)).thenReturn(
                new EntityRegistryRepository.BatteryAsset(DEVICE, null, null, null, null));
        // After activation the site has TWO active flows with stored artifacts:
        // the freshly activated one plus another flow - the set carries BOTH.
        FlowVersionRow other = new FlowVersionRow(UUID.randomUUID(), 1, SITE, "Anderer", "edge",
                "active", "{}", null, fixtureArtifact.toString(), Instant.now(), Instant.now(),
                null, null);
        when(flows.versionsForSite(SITE)).thenReturn(List.of(
                row(2, "active", fixtureArtifact.toString()), other));

        FlowActivationService service = service(doc -> fixtureArtifact, true);
        FlowActivationService.ActivationOutcome outcome = service.activate(SITE,
                row(2, "simulated", null), MAPPER.createObjectNode());

        assertThat(outcome.activated()).isTrue();
        assertThat(outcome.published()).isTrue();
        assertThat(outcome.deviceId()).isEqualTo(DEVICE);
        verify(flows).retireActive(FLOW);
        verify(flows).markActive(eq(FLOW), eq(2), anyString());

        JsonNode deployment = MAPPER.readTree(
                new String(publisher.payload, StandardCharsets.UTF_8));
        assertThat(deployment.path("kind").asText()).isEqualTo("deployment");
        assertThat(deployment.path("device_id").asText()).isEqualTo(DEVICE.toString());
        assertThat(deployment.path("deployed_at").asText()).isEqualTo("2026-07-18T12:00:00Z");
        assertThat(deployment.path("artifacts")).hasSize(2);
        assertThat(publisher.tenant).isEqualTo(TENANT);
    }

    @Test
    void whenTheCompilerIsUnavailableActivationRefusesAndChangesNothing() {
        when(entities.batteryAsset(SITE)).thenReturn(
                new EntityRegistryRepository.BatteryAsset(DEVICE, null, null, null, null));
        FlowCompiler downSidecar = doc -> {
            throw FlowCompilerException.unavailable();
        };
        FlowActivationService service = service(downSidecar, true);
        FlowActivationService.ActivationOutcome outcome = service.activate(SITE,
                row(2, "simulated", null), MAPPER.createObjectNode());
        assertThat(outcome.activated()).isFalse();
        assertThat(outcome.reason()).isEqualTo("compiler_unavailable");
        assertThat(outcome.message()).contains("nicht erreichbar");
        // Nothing mutated, nothing published - the flow stays "simuliert".
        verify(flows, never()).retireActive(any());
        verify(flows, never()).markActive(any(), org.mockito.ArgumentMatchers.anyInt(),
                anyString());
        assertThat(publisher.payload).isNull();
    }

    @Test
    void whenTheCompilerRejectsTheFlowActivationRefusesWithItsReason() {
        when(entities.batteryAsset(SITE)).thenReturn(
                new EntityRegistryRepository.BatteryAsset(DEVICE, null, null, null, null));
        FlowCompiler rejecting = doc -> {
            throw FlowCompilerException.rejected("Der Flow konnte nicht kompiliert werden: V-4 …");
        };
        FlowActivationService service = service(rejecting, true);
        FlowActivationService.ActivationOutcome outcome = service.activate(SITE,
                row(2, "simulated", null), MAPPER.createObjectNode());
        assertThat(outcome.activated()).isFalse();
        assertThat(outcome.reason()).isEqualTo("compiler_rejected");
        verify(flows, never()).markActive(any(), org.mockito.ArgumentMatchers.anyInt(),
                anyString());
        assertThat(publisher.payload).isNull();
    }

    @Test
    void ambiguousGatewayRefusesInsteadOfGuessing() {
        when(entities.batteryAsset(SITE)).thenReturn(null);
        when(entities.siteDeviceIds(SITE)).thenReturn(List.of(UUID.randomUUID(),
                UUID.randomUUID()));
        FlowActivationService service = service(doc -> fixtureArtifact, true);
        FlowActivationService.ActivationOutcome outcome = service.activate(SITE,
                row(2, "simulated", null), MAPPER.createObjectNode());
        assertThat(outcome.activated()).isFalse();
        assertThat(outcome.reason()).isEqualTo("no_gateway_device");
    }
}
