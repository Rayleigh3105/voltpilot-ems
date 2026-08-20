package com.voltpilot.api.entities;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.stream.StreamSupport;
import org.junit.jupiter.api.Test;

/**
 * The OCPP charge point as a CATALOG TYPE (Konzept `vp-ocpp-lastmgmt-konzept-w4`
 * E5): a 240-kW DC station is not a "Wallbox", and adding it is catalog DATA -
 * no schema release, no DB migration.
 *
 * <p>Pure: it only loads the shipped resource, so it runs without Docker.
 */
class EvChargerCatalogTypeTest {

    private final EntityTypeCatalog catalog = new EntityTypeCatalog(new ObjectMapper());

    @Test
    void theChargePointIsAConsumerThatIsOnlyEverLIMITED() {
        EntityTypeCatalog.EntityType t = catalog.find("ev-charger");
        assertThat(t).as("the ev-charger type must exist").isNotNull();
        assertThat(t.label()).isEqualTo("Ladepunkt");
        assertThat(t.category()).isEqualTo("consumer");
        assertThat(t.controllable()).isTrue();
        assertThat(t.composed())
                .as("a charge point is a real device, never composed from master data")
                .isFalse();

        // ⚠ The ONLY actuate command is limit_kw. A charge point is never
        // switched on or off by the platform and never given a setpoint: OCPP
        // load management sets a CEILING, and what actually flows is between
        // the vehicle and the station. Offering on_off here would promise a
        // control this product does not have.
        assertThat(actuateCommands(t)).containsExactly("limit_kw");

        // Measured: power + energy always, the vehicle's state of charge when
        // the station reports it (DC stations usually do, AC ones never).
        assertThat(measureChannels(t)).containsExactly("power_kw", "energy_kwh", "soc_pct");
    }

    @Test
    void itIsHonestlySimulatorOnlyUntilABenchSessionSaysOtherwise() {
        EntityTypeCatalog.EntityType t = catalog.find("ev-charger");
        // The Deye/go-e discipline: the word "certified" belongs to a bench
        // session, and no charge point has stood on a table yet.
        assertThat(t.certificationStatus()).isEqualTo("simulator_only");
        assertThat(t.certifiedAt()).isNull();
        assertThat(t.certificationNotes())
                .as("the note must name what the flip needs")
                .contains("Bench");
    }

    @Test
    void itIsADDITIVE_theWallboxAndEveryOtherTypeAreUntouched() {
        // A 240-kW DC station is not a "Wallbox" - and the wallbox type keeps
        // its own shape, including the on_off command the charge point
        // deliberately lacks.
        EntityTypeCatalog.EntityType wallbox = catalog.find("wallbox");
        assertThat(wallbox).isNotNull();
        assertThat(actuateCommands(wallbox)).contains("on_off", "setpoint_kw", "limit_kw");

        // The pilot types still exist and still compose.
        assertThat(catalog.find("battery-hybrid")).isNotNull();
        assertThat(catalog.find("house-load").composed()).isTrue();
        assertThat(catalog.all()).extracting(EntityTypeCatalog.EntityType::type)
                .contains("ev-charger", "wallbox", "heating-rod", "generic-load", "grid-meter");
    }

    private static java.util.List<String> actuateCommands(EntityTypeCatalog.EntityType t) {
        return names(t.defaultActuate(), "command");
    }

    private static java.util.List<String> measureChannels(EntityTypeCatalog.EntityType t) {
        return names(t.defaultMeasure(), "channel");
    }

    private static java.util.List<String> names(JsonNode arr, String field) {
        return StreamSupport.stream(arr.spliterator(), false)
                .map(n -> n.path(field).asText())
                .toList();
    }
}
