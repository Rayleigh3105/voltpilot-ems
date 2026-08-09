package com.voltpilot.api.consumers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.repo.ConsumerRuntimeStatusRepository;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.web.dto.DeviceDto;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/**
 * The consumers listener's parse of the additive {@code consumers} heartbeat
 * block (Verbrauchssteuerung Inkrement 3, D9/§15.1) - a PURE unit test, so it
 * runs without Docker (the end-to-end DB journey lives in {@code ConsumerApiTest}).
 *
 * <p>What it protects (D9's honesty rules): unknown STATE words drop the whole
 * entry, unknown REASON words are discarded alone, a spoofed identity or a
 * foreign entity id never mints a row, the tri-state {@code confirmed} stays
 * tri-state, and the device's set is REPLACED wholesale per heartbeat.
 */
class ConsumerRuntimeStatusListenerTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final UUID ROD = UUID.fromString("11111111-0000-0000-0000-000000000001");
    private static final UUID WALLBOX = UUID.fromString("11111111-0000-0000-0000-000000000002");
    private static final String TOPIC = "ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/status";

    private DeviceRepository devices;
    private ConsumerRuntimeStatusRepository store;
    private ConsumerRuntimeStatusListener listener;

    @BeforeEach
    void setUp() {
        devices = mock(DeviceRepository.class);
        store = mock(ConsumerRuntimeStatusRepository.class);
        when(devices.findById(DEVICE)).thenReturn(Optional.of(new DeviceDto(
                DEVICE, SITE, "demo-inverter-01", "inverter", null, "active", Instant.now(),
                Instant.now())));
        when(store.consumerEntityIds(SITE)).thenReturn(Set.of(ROD, WALLBOX));
        listener = new ConsumerRuntimeStatusListener("tcp://localhost:1883", "", "", devices, store);
    }

    @SuppressWarnings("unchecked")
    private List<ConsumerRuntimeStatusRepository.Row> ingest(String consumersBlock) {
        String payload = "{\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE + "\","
                + "\"device_id\":\"" + DEVICE + "\",\"ts\":\"2026-08-10T12:00:00Z\","
                + "\"consumers\":" + consumersBlock + "}";
        listener.handle(TOPIC, payload.getBytes(StandardCharsets.UTF_8));
        ArgumentCaptor<List<ConsumerRuntimeStatusRepository.Row>> rows =
                ArgumentCaptor.forClass(List.class);
        ArgumentCaptor<Instant> reportedAt = ArgumentCaptor.forClass(Instant.class);
        verify(store).replaceForDevice(eq(DEVICE), eq(SITE), reportedAt.capture(), rows.capture());
        assertThat(reportedAt.getValue()).isEqualTo(Instant.parse("2026-08-10T12:00:00Z"));
        return rows.getValue();
    }

    private void assertNothingStored() {
        verify(store, never()).replaceForDevice(any(), any(), any(), any());
    }

    @Test
    void ingestsTheFullBlockShape() {
        List<ConsumerRuntimeStatusRepository.Row> rows = ingest("{\"" + ROD + "\":{"
                + "\"state\":\"running_optimized\",\"actual_kw\":5.9,\"confirmed\":true,"
                + "\"requirement_progress\":{\"runtime_seconds_today\":600,\"starts_today\":2}},"
                + "\"" + WALLBOX + "\":{\"state\":\"waiting\",\"reason_code\":\"guard_min_off\"}}");
        assertThat(rows).hasSize(2);
        ConsumerRuntimeStatusRepository.Row rod = rows.stream()
                .filter(r -> r.entityId().equals(ROD)).findFirst().orElseThrow();
        assertThat(rod.state()).isEqualTo("running_optimized");
        assertThat(rod.actualKw()).isEqualTo(5.9);
        assertThat(rod.confirmed()).isTrue();
        assertThat(rod.runtimeSecondsToday()).isEqualTo(600);
        assertThat(rod.startsToday()).isEqualTo(2);
        ConsumerRuntimeStatusRepository.Row wb = rows.stream()
                .filter(r -> r.entityId().equals(WALLBOX)).findFirst().orElseThrow();
        assertThat(wb.state()).isEqualTo("waiting");
        assertThat(wb.reasonCode()).isEqualTo("guard_min_off");
        assertThat(wb.confirmed()).isNull(); // tri-state: no evidence, no claim
        assertThat(wb.actualKw()).isNull();
    }

    @Test
    void anUnknownStateWordDropsTheEntryNeverStoresIt() {
        List<ConsumerRuntimeStatusRepository.Row> rows = ingest("{\"" + ROD + "\":{"
                + "\"state\":\"turbo_mode\"},"
                + "\"" + WALLBOX + "\":{\"state\":\"waiting\"}}");
        assertThat(rows).hasSize(1);
        assertThat(rows.get(0).entityId()).isEqualTo(WALLBOX);
    }

    @Test
    void anUnknownReasonWordIsDiscardedAloneTheStateSurvives() {
        List<ConsumerRuntimeStatusRepository.Row> rows = ingest("{\"" + ROD + "\":{"
                + "\"state\":\"waiting\",\"reason_code\":\"weil_halt\"}}");
        assertThat(rows).hasSize(1);
        assertThat(rows.get(0).state()).isEqualTo("waiting");
        assertThat(rows.get(0).reasonCode()).isNull();
    }

    @Test
    void aForeignEntityIdNeverMintsARow() {
        List<ConsumerRuntimeStatusRepository.Row> rows = ingest("{"
                + "\"99999999-0000-0000-0000-000000000009\":{\"state\":\"waiting\"},"
                + "\"not-a-uuid\":{\"state\":\"waiting\"},"
                + "\"" + ROD + "\":{\"state\":\"waiting\"}}");
        assertThat(rows).hasSize(1);
        assertThat(rows.get(0).entityId()).isEqualTo(ROD);
    }

    @Test
    void aSpoofedPayloadIdentityIsSkipped() {
        String payload = "{\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE + "\","
                + "\"device_id\":\"99999999-0000-0000-0000-000000000009\","
                + "\"consumers\":{\"" + ROD + "\":{\"state\":\"waiting\"}}}";
        listener.handle(TOPIC, payload.getBytes(StandardCharsets.UTF_8));
        assertNothingStored();
    }

    @Test
    void aHeartbeatWithoutTheBlockIsIgnored() {
        listener.handle(TOPIC, ("{\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE
                + "\",\"device_id\":\"" + DEVICE + "\"}").getBytes(StandardCharsets.UTF_8));
        assertNothingStored();
    }

    @Test
    void anUnknownDeviceIsSkipped() {
        when(devices.findById(DEVICE)).thenReturn(Optional.empty());
        String payload = "{\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE + "\","
                + "\"device_id\":\"" + DEVICE + "\",\"consumers\":{\"" + ROD
                + "\":{\"state\":\"waiting\"}}}";
        listener.handle(TOPIC, payload.getBytes(StandardCharsets.UTF_8));
        assertNothingStored();
    }

    @Test
    void replaceSemanticsAnEmptyResultStillReplaces() {
        // Every entry discarded: the device DID report, and what it reported
        // was not storable - keeping stale rows would claim an older truth.
        List<ConsumerRuntimeStatusRepository.Row> rows =
                ingest("{\"" + ROD + "\":{\"state\":\"turbo_mode\"}}");
        assertThat(rows).isEmpty();
    }

    @Test
    void countersAreBoundedAndNegativeValuesDropped() {
        List<ConsumerRuntimeStatusRepository.Row> rows = ingest("{\"" + ROD + "\":{"
                + "\"state\":\"waiting\",\"requirement_progress\":{"
                + "\"runtime_seconds_today\":99999999,\"starts_today\":-3}}}");
        assertThat(rows.get(0).runtimeSecondsToday()).isEqualTo(2 * 86400);
        assertThat(rows.get(0).startsToday()).isNull();
    }
}
