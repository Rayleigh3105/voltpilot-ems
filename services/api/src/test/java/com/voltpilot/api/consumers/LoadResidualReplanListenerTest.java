package com.voltpilot.api.consumers;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.ScheduleRepository;
import com.voltpilot.api.web.dto.DeviceDto;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class LoadResidualReplanListenerTest {
    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final Instant T0 = Instant.parse("2026-08-25T10:00:00Z");
    private DeviceRepository devices;
    private ScheduleRepository schedules;
    private ReplanClient replans;
    private LoadResidualReplanListener listener;

    @BeforeEach void setUp() {
        devices = mock(DeviceRepository.class);
        schedules = mock(ScheduleRepository.class);
        replans = mock(ReplanClient.class);
        DeviceDto device = mock(DeviceDto.class);
        when(device.siteId()).thenReturn(SITE);
        when(devices.findById(DEVICE)).thenReturn(Optional.of(device));
        when(schedules.activePlannedLoadKw(any(), any())).thenReturn(16.8);
        when(replans.replan(SITE)).thenReturn(true);
        listener = new LoadResidualReplanListener("tcp://unused:1883", "", "",
                3, .2, 20, 120, 5, 30, devices, schedules, replans);
    }

    private static String topic() { return "ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/telemetry"; }
    private static byte[] sample(UUID device, Instant ts, long sequence, double load) {
        return ("""
                {"schema_version":"1.0","tenant_id":"%s","site_id":"%s","device_id":"%s",
                 "ts":"%s","seq":%s,"measurements":{"load_kw":%s}}
                """.formatted(TENANT, SITE, device, ts, sequence, load)).getBytes(StandardCharsets.UTF_8);
    }

    @Test void sustainedFreshResidualReplansTheRlsResolvedSite() {
        // All three arrive together: only their OBSERVATION timestamps may
        // establish the sustained interval.
        listener.handle(topic(), sample(DEVICE, T0, 1, 36.8), T0.plusSeconds(20));
        listener.handle(topic(), sample(DEVICE, T0.plusSeconds(10), 2, 36.8), T0.plusSeconds(20));
        listener.handle(topic(), sample(DEVICE, T0.plusSeconds(20), 3, 36.8), T0.plusSeconds(20));
        listener.fireDue();
        verify(devices, atLeastOnce()).findById(DEVICE);
        verify(schedules).activePlannedLoadKw(SITE, T0);
        verify(replans).replan(SITE);
    }

    @Test void spoofedOrStaleTelemetryNeverFeedsTheDetector() {
        listener.handle(topic(), sample(UUID.randomUUID(), T0, 1, 36.8), T0);
        listener.handle(topic(), sample(DEVICE, T0.minusSeconds(31), 2, 36.8), T0);
        listener.fireDue();
        verify(replans, never()).replan(any());
    }

    @Test void duplicateQos1PayloadDoesNotTriggerAReplanAtLaterArrivalTimes() {
        byte[] replayed = sample(DEVICE, T0, 42, 36.8);
        listener.handle(topic(), replayed, T0);
        listener.handle(topic(), replayed, T0.plusSeconds(10));
        listener.handle(topic(), replayed, T0.plusSeconds(20));
        listener.fireDue();
        verify(replans, never()).replan(any());
    }
}
