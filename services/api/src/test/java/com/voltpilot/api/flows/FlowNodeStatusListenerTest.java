package com.voltpilot.api.flows;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.FlowStatusRepository;
import com.voltpilot.api.web.dto.DeviceDto;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/**
 * The FOURTH status-heartbeat listener (Portal v3 M5). It is a pure parser +
 * an RLS-scoped replace, so it is unit-testable without a broker - the parts
 * that need real infrastructure (broker ACL, mTLS CN) are the SAME posture the
 * control/entity/source siblings already prove.
 *
 * <p>What must hold: the deployment acks and the feature-flagged per-node
 * states are ingested verbatim, a SPOOFED identity is skipped (the topic
 * identity must equal the payload identity), an unknown device is skipped, and
 * a heartbeat carrying NEITHER block touches nothing at all.
 */
class FlowNodeStatusListenerTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final UUID FLOW = UUID.fromString("9a71c04e-2b3d-4f51-9c62-0a1b2c3d4e5f");
    private static final String TOPIC = "ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/status";

    private DeviceRepository devices;
    private FlowStatusRepository flowStatus;
    private FlowNodeStatusListener listener;

    @BeforeEach
    void setUp() {
        devices = mock(DeviceRepository.class);
        flowStatus = mock(FlowStatusRepository.class);
        listener = new FlowNodeStatusListener("tcp://localhost:1883", "", "", devices, flowStatus);
        when(devices.findById(DEVICE)).thenReturn(Optional.of(device()));
    }

    private static DeviceDto device() {
        return new DeviceDto(DEVICE, SITE, "demo-inverter-01", "inverter", null, "online",
                Instant.now(), Instant.now());
    }

    private void handle(String payload) {
        listener.handle(TOPIC, payload.getBytes(StandardCharsets.UTF_8));
    }

    private String heartbeat(String extra) {
        return "{\"schema_version\":\"1.0\",\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE
                + "\",\"device_id\":\"" + DEVICE + "\",\"ts\":\"2026-07-22T14:02:00Z\"" + extra + "}";
    }

    @Test
    void ingestsTheDeploymentAcksSoTheEditorKnowsWhatReallyRuns() {
        handle(heartbeat(",\"flows\":{\"palette_version\":\"0.3.0\",\"applied\":["
                + "{\"flow_id\":\"" + FLOW + "\",\"flow_version\":4,"
                + "\"content_hash\":\"sha256:abc\",\"state\":\"active\"},"
                + "{\"flow_id\":\"nicht-uuid\",\"flow_version\":1,\"state\":\"active\"},"
                + "{\"flow_id\":\"" + FLOW + "\",\"flow_version\":0,\"state\":\"active\"}]}"));

        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<FlowStatusRepository.Ack>> acks =
                ArgumentCaptor.forClass(List.class);
        verify(flowStatus).replaceAcks(eq(DEVICE), eq(SITE), acks.capture(), any());
        assertThat(acks.getValue()).hasSize(1);
        assertThat(acks.getValue().get(0).flowId()).isEqualTo(FLOW);
        assertThat(acks.getValue().get(0).flowVersion()).isEqualTo(4);
        assertThat(acks.getValue().get(0).state()).isEqualTo("active");
        // A heartbeat without the node block leaves the node states untouched.
        verify(flowStatus, never()).replaceNodeStatuses(any(), any(), anyList(), any());
    }

    @Test
    void ingestsTheFeatureFlaggedPerNodeStatesVerbatim() {
        handle(heartbeat(",\"flow_node_status\":{\"reported_at\":\"2026-07-22T14:02:00Z\","
                + "\"nodes\":[{\"flow_id\":\"" + FLOW + "\",\"node_id\":\"schwelle1\","
                + "\"state\":\"active\",\"text\":\"erfüllt\",\"since\":\"2026-07-22T14:02:00Z\"},"
                + "{\"flow_id\":\"" + FLOW + "\",\"node_id\":\"\",\"state\":\"active\"}]}"));

        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<FlowStatusRepository.NodeStatus>> nodes =
                ArgumentCaptor.forClass(List.class);
        verify(flowStatus).replaceNodeStatuses(eq(DEVICE), eq(SITE), nodes.capture(), any());
        assertThat(nodes.getValue()).hasSize(1);
        assertThat(nodes.getValue().get(0).nodeId()).isEqualTo("schwelle1");
        assertThat(nodes.getValue().get(0).text()).isEqualTo("erfüllt");
        assertThat(nodes.getValue().get(0).since()).isEqualTo(Instant.parse("2026-07-22T14:02:00Z"));
    }

    @Test
    void skipsASpoofedIdentityAndAnUnknownDevice() {
        // The payload claims ANOTHER device than the topic it was published on -
        // exactly what the broker ACL + mTLS CN make impossible for an honest
        // device, and what this listener re-validates in depth.
        String spoofed = "{\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE
                + "\",\"device_id\":\"10000000-0000-0000-0000-000000000009\","
                + "\"flows\":{\"applied\":[{\"flow_id\":\"" + FLOW
                + "\",\"flow_version\":1,\"state\":\"active\"}]}}";
        listener.handle(TOPIC, spoofed.getBytes(StandardCharsets.UTF_8));
        verifyNoInteractions(flowStatus);

        when(devices.findById(DEVICE)).thenReturn(Optional.empty());
        handle(heartbeat(",\"flows\":{\"applied\":[]}"));
        verifyNoInteractions(flowStatus);
    }

    @Test
    void ignoresAHeartbeatWithoutEitherBlock() {
        handle(heartbeat(",\"control\":{\"all_match\":true}"));
        listener.handle(TOPIC, "kein json".getBytes(StandardCharsets.UTF_8));
        listener.handle("ems/kaputt/status", heartbeat(",\"flows\":{\"applied\":[]}")
                .getBytes(StandardCharsets.UTF_8));
        verifyNoInteractions(flowStatus);
    }
}
