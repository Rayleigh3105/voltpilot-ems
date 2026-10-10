package com.voltpilot.api.control;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.command.CommandLogWriter;
import com.voltpilot.api.repo.BatteryControlRepository;
import com.voltpilot.api.repo.ControlStatusRepository;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.web.dto.DeviceDto;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Der Steuerstand des Speichers im Herzschlag ({@code battery_control},
 * Vertrag {@code docs/contracts/speicher-steuerstand.md}) - ein reiner
 * Unit-Test ohne Docker.
 *
 * <p>Was er schützt: der Optimierer plant einen als {@code beobachtet}
 * gespeicherten Speicher als Eigenverbrauch. Ein Wort, das die Box nicht so
 * gemeint hat, darf deshalb nie in der Tabelle landen - und der Block muss
 * auch ohne {@code control}-Block ankommen, denn den gibt es nur mit
 * Rücklesung, und Edge Light liest nicht zurück.
 */
class BatteryControlBlockTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final String TOPIC = "ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/status";
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private DeviceRepository devices;
    private ControlStatusRepository controlStore;
    private BatteryControlRepository batteryStore;
    private ControlStatusListener listener;

    @BeforeEach
    void setUp() {
        devices = mock(DeviceRepository.class);
        controlStore = mock(ControlStatusRepository.class);
        batteryStore = mock(BatteryControlRepository.class);
        when(devices.findById(DEVICE)).thenReturn(Optional.of(new DeviceDto(
                DEVICE, SITE, "demo-inverter-01", "inverter", null, "active", Instant.now(), Instant.now())));
        listener = new ControlStatusListener("tcp://localhost:1883", "", "", devices, controlStore,
                mock(CommandLogWriter.class), batteryStore);
    }

    private static JsonNode vectors() throws Exception {
        return MAPPER.readTree(Files.readString(
                Path.of("..", "..", "docs", "contracts", "speicher-steuerstand-vectors.json")));
    }

    private void heartbeat(String blocks) {
        String payload = "{\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE + "\","
                + "\"device_id\":\"" + DEVICE + "\",\"control_source\":\"default\"" + blocks + "}";
        listener.handle(TOPIC, payload.getBytes(StandardCharsets.UTF_8));
    }

    @Test
    void theWordsAreTheSharedVocabulary() throws Exception {
        JsonNode states = vectors().get("states");
        assertThat(states).hasSize(3);
        assertThat(states.get(0).asText()).isEqualTo(BatteryControlRepository.State.GESTEUERT);
        assertThat(states.get(1).asText()).isEqualTo(BatteryControlRepository.State.BEOBACHTET);
        assertThat(states.get(2).asText()).isEqualTo(BatteryControlRepository.State.NOT_AUS);
    }

    /** Jeder Fall des Abschnitts {@code api}: gespeichert genau so, oder verworfen. */
    @Test
    void everyApiVectorIsStoredOrDroppedExactlyAsTheContractSays() throws Exception {
        JsonNode cases = vectors().get("api");
        assertThat(cases).isNotEmpty();
        for (JsonNode c : cases) {
            Optional<BatteryControlRepository.State> got =
                    ControlStatusListener.batteryControlState(c.get("block"));
            JsonNode want = c.get("gespeichert");
            if (want.isNull()) {
                assertThat(got).as(c.get("name").asText()).isEmpty();
            } else {
                assertThat(got).as(c.get("name").asText()).contains(new BatteryControlRepository.State(
                        want.get("state").asText(), want.get("control_enabled").asBoolean(),
                        want.get("certified").asBoolean()));
            }
        }
    }

    /** Der Kern des Auftrags: Edge Light schickt keinen control-Block, nur den Steuerstand. */
    @Test
    void theBlockLandsWithoutAnyControlBlock() {
        heartbeat(",\"battery_control\":{\"state\":\"beobachtet\",\"control_enabled\":false,\"certified\":false}");
        verify(batteryStore).upsert(DEVICE, SITE,
                new BatteryControlRepository.State("beobachtet", false, false));
        verify(controlStore, never()).upsert(any(), any(), any(), any(), anyBoolean(), anyBoolean(),
                anyBoolean(), any(), any(), any(), any(), any());
    }

    @Test
    void bothBlocksOfOneHeartbeatLandSideBySide() {
        heartbeat(",\"battery_control\":{\"state\":\"gesteuert\",\"control_enabled\":true,\"certified\":true}"
                + ",\"control\":{\"commanded_kw\":-1.0,\"confirmed_kw\":-1.0,\"all_match\":true,"
                + "\"control_enabled\":true,\"certified\":true,\"checked_at\":\"2026-10-07T10:00:00Z\"}");
        verify(batteryStore).upsert(DEVICE, SITE,
                new BatteryControlRepository.State("gesteuert", true, true));
        verify(controlStore).upsert(eq(DEVICE), eq(SITE), any(), any(), anyBoolean(), anyBoolean(),
                anyBoolean(), any(), any(), any(), any(), any());
    }

    /** Additiv und nie werfend: ein fehlgeschlagener Steuerstand kostet nicht die control-Zeile. */
    @Test
    void aFailingSteuerstandWriteNeverCostsTheControlRow() {
        org.mockito.Mockito.doThrow(new IllegalStateException("db blip"))
                .when(batteryStore).upsert(any(), any(), any());
        heartbeat(",\"battery_control\":{\"state\":\"gesteuert\",\"control_enabled\":true,\"certified\":true}"
                + ",\"control\":{\"commanded_kw\":-1.0,\"confirmed_kw\":-1.0,\"all_match\":true,"
                + "\"control_enabled\":true,\"certified\":true,\"checked_at\":\"2026-10-07T10:00:00Z\"}");
        verify(controlStore).upsert(eq(DEVICE), eq(SITE), any(), any(), anyBoolean(), anyBoolean(),
                anyBoolean(), any(), any(), any(), any(), any());
    }

    @Test
    void aContradictingBlockIsNeverStored() {
        heartbeat(",\"battery_control\":{\"state\":\"beobachtet\",\"control_enabled\":false,\"certified\":true}");
        verify(batteryStore, never()).upsert(any(), any(), any());
    }

    /** Eine Box darf nicht den Steuerstand einer anderen Box melden. */
    @Test
    void aForeignIdentityIsSkipped() {
        String payload = "{\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE + "\","
                + "\"device_id\":\"" + UUID.randomUUID() + "\","
                + "\"battery_control\":{\"state\":\"beobachtet\",\"control_enabled\":false,\"certified\":false}}";
        listener.handle(TOPIC, payload.getBytes(StandardCharsets.UTF_8));
        verify(batteryStore, never()).upsert(any(), any(), any());
    }

    @Test
    void aHeartbeatWithoutTheBlockLeavesTheRowAlone() {
        heartbeat("");
        verify(batteryStore, never()).upsert(any(), any(), any());
    }
}
