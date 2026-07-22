package com.voltpilot.writer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.tuple;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.writer.ComposedEntityFanout.ComposedEntity;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * The MIG-B1 CHANNEL MAP (report §3) - the pure half of the v1 -> v2 value
 * bridge. These are the exact mappings that reproduced the v1 tiles to the
 * digit on the captain's real plants.
 */
class ComposedEntityFanoutTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final UUID GATEWAY = UUID.randomUUID();

    private static final ComposedEntity BATTERY =
            new ComposedEntity(UUID.randomUUID(), "battery-hybrid", GATEWAY);
    private static final ComposedEntity GRID =
            new ComposedEntity(UUID.randomUUID(), "grid-meter", GATEWAY);
    private static final ComposedEntity HOUSE =
            new ComposedEntity(UUID.randomUUID(), "house-load", GATEWAY);

    private static JsonNode measurements(String json) {
        try {
            return MAPPER.readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static List<TelemetryV2WriteRepository.ChannelRow> rows(String measurementsJson) {
        return ComposedEntityFanout.channelRows(List.of(BATTERY, GRID, HOUSE), GATEWAY,
                measurements(measurementsJson));
    }

    @Test
    void mapsOneV1SampleOntoTheComposedEntitiesChannels() {
        // Pilsting-shaped sample: PV 59,0 · Haus 14,4 · Netz 44,6.
        List<TelemetryV2WriteRepository.ChannelRow> rows = rows(
                "{\"power_kw\":44.6,\"load_kw\":14.4,\"pv_power_kw\":59.0,\"soc_pct\":10.0}");

        assertThat(rows).extracting(r -> r.entityId() + "/" + r.channel(), r -> r.value())
                .containsExactly(
                        tuple(BATTERY.id() + "/soc_pct", 10.0),
                        tuple(BATTERY.id() + "/pv_power_kw", 59.0),
                        // battery = power - load + pv (the documented v1 balance)
                        tuple(BATTERY.id() + "/battery_power_kw", 44.6 - 14.4 + 59.0),
                        tuple(GRID.id() + "/power_kw", 44.6),
                        tuple(HOUSE.id() + "/power_kw", 14.4));
    }

    @Test
    void keepsTheGridSignSoExportStaysExport() {
        List<TelemetryV2WriteRepository.ChannelRow> rows =
                rows("{\"power_kw\":-49.7,\"load_kw\":2.0,\"pv_power_kw\":52.0}");
        assertThat(rows).filteredOn(r -> r.entityId().equals(GRID.id().toString()))
                .singleElement().extracting(r -> r.value()).isEqualTo(-49.7);
    }

    @Test
    void aNullV1ChannelWritesNoRow_neverAFabricatedZero() {
        // A generation-only inverter: no load, no grid, no SoC.
        List<TelemetryV2WriteRepository.ChannelRow> rows = rows("{\"pv_power_kw\":5.85}");
        assertThat(rows).extracting(r -> r.channel()).containsExactly("pv_power_kw");
    }

    @Test
    void derivedBatteryPowerNeedsAllThreeInputs() {
        List<TelemetryV2WriteRepository.ChannelRow> rows =
                rows("{\"power_kw\":2.0,\"pv_power_kw\":3.0,\"soc_pct\":80}");
        assertThat(rows).extracting(r -> r.channel())
                .as("load_kw missing -> battery power is UNKNOWN, not 0")
                .doesNotContain("battery_power_kw");
    }

    @Test
    void ignoresEntitiesBoundToAnotherDevice() {
        ComposedEntity otherDevice =
                new ComposedEntity(UUID.randomUUID(), "grid-meter", UUID.randomUUID());
        List<TelemetryV2WriteRepository.ChannelRow> rows = ComposedEntityFanout.channelRows(
                List.of(otherDevice), GATEWAY, measurements("{\"power_kw\":7.0}"));
        assertThat(rows).isEmpty();
    }

    @Test
    void neverSynthesizesAProducerOrAnyV2NativeEntity() {
        // A producer is fed by its OWN source; synthesizing it from the site
        // sample would double-count the hybrid's PV (report §2.2).
        ComposedEntity producer = new ComposedEntity(UUID.randomUUID(), "producer", GATEWAY);
        ComposedEntity wallbox = new ComposedEntity(UUID.randomUUID(), "wallbox", GATEWAY);
        assertThat(ComposedEntityFanout.channelRows(List.of(producer, wallbox), GATEWAY,
                measurements("{\"power_kw\":1.0,\"load_kw\":1.0,\"pv_power_kw\":1.0}"))).isEmpty();
    }
}
