package com.voltpilot.api.measurement;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.CustomMeasurementPoint.Definition;
import java.math.BigDecimal;
import org.junit.jupiter.api.Test;

class CustomMeasurementPointTest {

    @Test
    void aReadOnlyRegisterIsCanonicalizedCompletely() {
        var point = CustomMeasurementPoint.validate(valid());

        assertThat(point.selector()).isEqualTo("holding:0x00e7");
        assertThat(point.valueType()).isEqualTo("uint16");
        assertThat(point.widthBits()).isEqualTo(16);
        assertThat(point.signed()).isFalse();
        assertThat(point.scale()).isEqualByComparingTo("0.1");
        assertThat(point.readOnly()).isTrue();
        assertThat(point.requestCostMs()).isEqualTo(MeasurementBudget.CUSTOM_REGISTER_REQUEST_COST_MS);
    }

    @Test
    void writeCapabilityAndAddressSelectorMismatchAreRejected() {
        assertThatThrownBy(() -> CustomMeasurementPoint.validate(copy(valid(), false,
                "holding:0x00e7", 231, "uint16", 16, false)))
                .hasMessageContaining("ausschließlich lesbar");
        assertThatThrownBy(() -> CustomMeasurementPoint.validate(copy(valid(), true,
                "holding:0x00e8", 231, "uint16", 16, false)))
                .hasMessageContaining("widersprechen");
    }

    @Test
    void typeWidthSignScaleUnitCadenceAndReadSafetyAreValidated() {
        assertThatThrownBy(() -> CustomMeasurementPoint.validate(new Definition("Eigen", "modbus_holding",
                -1, "holding:0xffff", "uint16", 16, false, "big", BigDecimal.ONE,
                "kW", 60, "live_power", true))).hasMessageContaining("Registeradresse");
        assertThatThrownBy(() -> CustomMeasurementPoint.validate(copy(valid(), true,
                "holding:0x00e7", 231, "uint32", 16, false)))
                .hasMessageContaining("Datentyp");
        assertThatThrownBy(() -> CustomMeasurementPoint.validate(copy(valid(), true,
                "holding:0x00e7", 231, "uint16", 16, true)))
                .hasMessageContaining("Vorzeichen");
        assertThatThrownBy(() -> CustomMeasurementPoint.validate(new Definition("Eigen", "modbus_holding",
                231, "holding:0x00e7", "uint16", 16, false, "little", BigDecimal.ONE,
                "kW", 60, "live_power", true))).hasMessageContaining("Wortreihenfolge");
        assertThatThrownBy(() -> CustomMeasurementPoint.validate(new Definition("Eigen", "modbus_holding",
                231, "holding:0x00e7", "uint16", 16, false, "big", BigDecimal.ZERO,
                "kW", 60, "live_power", true))).hasMessageContaining("Skala");
        assertThatThrownBy(() -> CustomMeasurementPoint.validate(new Definition("Eigen", "modbus_holding",
                231, "holding:0x00e7", "uint16", 16, false, "big", BigDecimal.ONE,
                "\n", 60, "live_power", true))).hasMessageContaining("Einheit");
        assertThatThrownBy(() -> CustomMeasurementPoint.validate(new Definition("Eigen", "modbus_holding",
                231, "holding:0x00e7", "uint16", 16, false, "big", BigDecimal.ONE,
                "kW", 0, "live_power", true))).hasMessageContaining("Kadenz");
        assertThatThrownBy(() -> CustomMeasurementPoint.validate(new Definition("Eigen", "modbus_holding",
                231, "holding:0x00e7", "uint16", 16, false, "big", BigDecimal.ONE,
                "kW", 60, "irgendwas", true))).hasMessageContaining("Aufbewahrungsklasse");
    }

    @Test
    void unknownJsonCannotSmuggleAWriteParameterEvenWhenBootIgnoresUnknowns() {
        ObjectMapper mapper = new ObjectMapper()
                .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);

        assertThatThrownBy(() -> mapper.readValue("""
                {"label":"Eigen","sourceKind":"modbus_holding","address":231,
                 "selector":"holding:0x00e7","valueType":"uint16","widthBits":16,
                 "signed":false,"endian":"big","scale":1,"unit":"kW","cadenceS":60,
                 "retentionClass":"live_power","readOnly":true,"writeFunction":"fc6"}
                """, Definition.class)).hasMessageContaining("writeFunction");
    }

    private static Definition valid() {
        return new Definition("Freie Einspeiseleistung", "modbus_holding", 231,
                "holding:0x00e7", "uint16", 16, false, "big", new BigDecimal("0.1"),
                "kW", 60, "live_power", true);
    }

    private static Definition copy(Definition d, boolean readOnly, String selector, int address,
            String type, int width, boolean signed) {
        return new Definition(d.label(), d.sourceKind(), address, selector, type, width, signed,
                d.endian(), d.scale(), d.unit(), d.cadenceS(), d.retentionClass(), readOnly);
    }
}
