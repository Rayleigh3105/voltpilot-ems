package com.voltpilot.api.entities;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

/**
 * Steuerlogik-Konzept Stufe 1 ("Fühler lesen"): the catalog type a pure Shelly add-on
 * sensor gets - like {@code modbus-generic}, never controllable, never composed, and
 * without a fixed {@code default_measure}: its actual channels come from the measurement
 * point catalog (family {@code shelly.gen1}/{@code shelly.gen2plus}, read by the Go core
 * in {@code edge-app/core/internal/shelly}), chosen per device, not from master data.
 *
 * <p>Pure: it only loads the shipped resource, so it runs without Docker.
 */
class FuehlerCatalogTypeTest {

    private final EntityTypeCatalog catalog = new EntityTypeCatalog(new ObjectMapper());

    @Test
    void itIsAMeasureOnlyMeterTypeWithNoFixedChannels() {
        EntityTypeCatalog.EntityType t = catalog.find("fuehler");
        assertThat(t).as("the fuehler type must exist").isNotNull();
        assertThat(t.label()).isEqualTo("Fühler");
        assertThat(t.category()).isEqualTo("meter");
        assertThat(t.controllable()).isFalse();
        assertThat(t.composed())
                .as("a real, admin-creatable device, never derived from master data")
                .isFalse();
        assertThat(t.defaultFailsafe()).isEqualTo("measure-only");

        // No fixed measure/actuate channels: the number of add-on sensors varies
        // by Shelly model, so the EntityDrawer must not ask for a creator-typed
        // channel name here (TechnischeKarten.tsx) - it is empty, like modbus-generic.
        assertThat(t.defaultMeasure().isEmpty()).isTrue();
        assertThat(t.defaultActuate().isEmpty()).isTrue();
    }

    @Test
    void itIsADDITIVE_modbusGenericAndEveryOtherTypeAreUntouched() {
        EntityTypeCatalog.EntityType modbusGeneric = catalog.find("modbus-generic");
        assertThat(modbusGeneric).isNotNull();
        assertThat(modbusGeneric.category()).isEqualTo("meter");
        assertThat(modbusGeneric.controllable()).isFalse();

        assertThat(catalog.find("heating-rod")).isNotNull();
        assertThat(catalog.find("house-load").composed()).isTrue();
        assertThat(catalog.all()).extracting(EntityTypeCatalog.EntityType::type)
                .contains("fuehler", "modbus-generic", "heating-rod", "grid-meter");
    }
}
