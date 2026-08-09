package com.voltpilot.api.consumers;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.web.dto.DeviceDto;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * The listener half of the D8 trigger, pure (no broker, no Docker): identity
 * spoof protection (the sibling-listener rule) and the observe→due→replan
 * wiring with a zero debounce.
 */
class ConsumerReplanTriggerListenerTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final UUID ENTITY = UUID.fromString("6f1d2c3b-4a59-4687-9abc-def012345678");

    private DeviceRepository devices;
    private ReplanClient replans;
    private ConsumerReplanTriggerListener listener;

    @BeforeEach
    void setUp() {
        devices = mock(DeviceRepository.class);
        replans = mock(ReplanClient.class);
        listener = new ConsumerReplanTriggerListener("tcp://unused:1883", "", "",
                0, 0, devices, replans);
        DeviceDto device = mock(DeviceDto.class);
        when(device.siteId()).thenReturn(SITE);
        when(devices.findById(DEVICE)).thenReturn(Optional.of(device));
    }

    private static String topic() {
        return "ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/status";
    }

    private static byte[] heartbeat(UUID tenant, UUID site, UUID device, String state) {
        return ("""
                {"schema_version":"1.0","tenant_id":"%s","site_id":"%s","device_id":"%s",
                 "consumers":{"%s":{"state":"%s","confirmed":true}}}
                """.formatted(tenant, site, device, ENTITY, state))
                .getBytes(StandardCharsets.UTF_8);
    }

    @Test
    void aParagraph134TransitionFiresOneReplanForTheSite() {
        Instant t0 = Instant.parse("2026-08-01T10:00:00Z");
        listener.handle(topic(), heartbeat(TENANT, SITE, DEVICE, "ready"), t0);
        listener.handle(topic(), heartbeat(TENANT, SITE, DEVICE, "running_forced"),
                t0.plusSeconds(1));
        listener.fireDue();
        verify(replans).replan(SITE);
    }

    @Test
    void aSpoofedPayloadIdentityFeedsNothing() {
        UUID foreignDevice = UUID.randomUUID();
        Instant t0 = Instant.parse("2026-08-01T10:00:00Z");
        // The payload claims ANOTHER device than the topic carries.
        listener.handle(topic(), heartbeat(TENANT, SITE, foreignDevice, "ready"), t0);
        listener.handle(topic(), heartbeat(TENANT, SITE, foreignDevice, "running_forced"),
                t0.plusSeconds(1));
        listener.fireDue();
        verify(replans, never()).replan(any());
    }

    @Test
    void anUnknownDeviceUnderTheTopicTenantFeedsNothing() {
        when(devices.findById(DEVICE)).thenReturn(Optional.empty());
        Instant t0 = Instant.parse("2026-08-01T10:00:00Z");
        listener.handle(topic(), heartbeat(TENANT, SITE, DEVICE, "ready"), t0);
        listener.handle(topic(), heartbeat(TENANT, SITE, DEVICE, "running_forced"),
                t0.plusSeconds(1));
        listener.fireDue();
        verify(replans, never()).replan(any());
    }

    @Test
    void aHeartbeatWithoutAConsumersBlockIsIgnored() {
        listener.handle(topic(), "{\"tenant_id\":\"x\"}".getBytes(StandardCharsets.UTF_8),
                Instant.now());
        listener.fireDue();
        verify(replans, never()).replan(any());
    }
}
