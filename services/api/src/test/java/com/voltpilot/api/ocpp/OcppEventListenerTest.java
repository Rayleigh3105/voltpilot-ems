package com.voltpilot.api.ocpp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class OcppEventListenerTest {
    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final String TOPIC = "ems/" + TENANT + "/" + SITE + "/" + DEVICE
            + "/v2/ocpp-events";

    private DeviceRepository devices;
    private OcppRepository repository;
    private OcppEventListener listener;

    @BeforeEach
    void setUp() {
        devices = mock(DeviceRepository.class);
        repository = mock(OcppRepository.class);
        when(devices.findById(DEVICE)).thenReturn(Optional.of(new DeviceDto(DEVICE, SITE,
                "edge-test", "inverter", null, "active", Instant.now(), Instant.now())));
        when(repository.ingest(eq(TENANT), eq(SITE), eq(DEVICE), any())).thenAnswer(invocation -> {
            assertThat(TenantContext.get()).isEqualTo(TENANT);
            return true;
        });
        listener = new OcppEventListener("tcp://localhost:1883", "", "", "test-ocpp-listener", devices,
                repository, new ObjectMapper());
    }

    @Test
    void topicIdentitySelectsTheRlsTenantAndIsAlwaysCleared() {
        assertThat(listener.handle(TOPIC, event(DEVICE).getBytes(StandardCharsets.UTF_8))).isTrue();
        verify(repository).ingest(eq(TENANT), eq(SITE), eq(DEVICE), any());
        assertThat(TenantContext.get()).isNull();
    }

    @Test
    void spoofedPayloadUnknownDeviceAndWrongTopicNeverReachPersistence() {
        UUID other = UUID.fromString("00000000-0000-0000-0000-0000000000ff");
        assertThat(listener.handle(TOPIC, event(other).getBytes(StandardCharsets.UTF_8))).isFalse();
        assertThat(listener.handle("ems/not-a-uuid/x/y/v2/ocpp-events",
                event(DEVICE).getBytes(StandardCharsets.UTF_8))).isFalse();

        when(devices.findById(DEVICE)).thenReturn(Optional.empty());
        assertThat(listener.handle(TOPIC, event(DEVICE).getBytes(StandardCharsets.UTF_8))).isFalse();
        verify(repository, never()).ingest(any(), any(), any(), any());
        assertThat(TenantContext.get()).isNull();
    }

    private static String event(UUID payloadDevice) {
        return "{\"schema_version\":\"1.0\",\"event_id\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\","
                + "\"occurred_at\":\"2026-08-25T06:30:00Z\",\"tenant_id\":\"" + TENANT
                + "\",\"site_id\":\"" + SITE + "\",\"device_id\":\"" + payloadDevice
                + "\",\"charge_point_id\":\"CP-1\",\"direction\":\"station_to_csms\","
                + "\"message_type\":\"Call\",\"correlation_id\":\"1\","
                + "\"action\":\"BootNotification\",\"payload\":{}}";
    }
}
