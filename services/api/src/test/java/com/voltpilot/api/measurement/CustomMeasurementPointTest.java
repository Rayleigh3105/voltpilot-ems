package com.voltpilot.api.measurement;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.CustomMeasurementPoint.Canonical;
import com.voltpilot.api.measurement.CustomMeasurementPoint.Definition;
import com.voltpilot.api.measurement.CustomMeasurementPoint.Measures;
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

    @Test
    void ohneAngabeBleibtDieGespeicherteFormZeichenFuerZeichenDieAlte() throws Exception {
        String json = new ObjectMapper().writeValueAsString(CustomMeasurementPoint.validate(valid()));
        assertThat(json).doesNotContain("measures").endsWith("\"requestCostMs\":"
                + MeasurementBudget.CUSTOM_REGISTER_REQUEST_COST_MS + "}");
        // Eine gespeicherte Zeile von vor Schnitt 2 liest sich weiter (auch mit einem strengen Mapper).
        assertThat(new ObjectMapper().readValue(json, Canonical.class).measures()).isNull();
    }

    @Test
    void einEnergieZaehlerstandTraegtDieKatalogwoerter() throws Exception {
        var point = CustomMeasurementPoint.validate(mitAngabe("kWh", "energy_counter",
                new Measures("Active_Energy", "import", "counter")));
        assertThat(point.measures()).isEqualTo(new Measures("active_energy", "import", "counter"));
        String json = new ObjectMapper().writeValueAsString(point);
        assertThat(new ObjectMapper().readValue(json, Canonical.class)).isEqualTo(point);
        var leistung = CustomMeasurementPoint.validate(mitAngabe("W", "live_power",
                new Measures("active_power", "generation", "gauge")));
        assertThat(leistung.measures().direction()).isEqualTo("generation");
    }

    @Test
    void nurTragendeKombinationenPassendeEinheitUndAufbewahrung() {
        // Keine Größe, die heute keine Messstelle trägt; keine Wertart, die nicht zur Größe passt.
        assertThatThrownBy(() -> CustomMeasurementPoint.validate(mitAngabe("kWh", "energy_counter",
                new Measures("reactive_energy", "import", "counter")))).hasMessageContaining("kennt VoltPilot nicht");
        assertThatThrownBy(() -> CustomMeasurementPoint.validate(mitAngabe("kWh", "energy_counter",
                new Measures("active_energy", "import", "gauge")))).hasMessageContaining("kennt VoltPilot nicht");
        assertThatThrownBy(() -> CustomMeasurementPoint.validate(mitAngabe("kWh", "energy_counter",
                new Measures("active_energy", "import_export", "counter")))).hasMessageContaining("kennt VoltPilot nicht");
        assertThatThrownBy(() -> CustomMeasurementPoint.validate(mitAngabe("kWh", "energy_counter",
                new Measures("active_energy", null, "counter")))).hasMessageContaining("kennt VoltPilot nicht");
        assertThatThrownBy(() -> CustomMeasurementPoint.validate(mitAngabe("kW", "energy_counter",
                new Measures("active_energy", "export", "counter"))))
                .hasMessage("Ein Energie-Zählerstand braucht die Einheit Wh, kWh oder MWh.");
        assertThatThrownBy(() -> CustomMeasurementPoint.validate(mitAngabe("kWh", "live_power",
                new Measures("active_power", "export", "gauge"))))
                .hasMessage("Eine Leistung braucht die Einheit W, kW oder MW.");
        assertThatThrownBy(() -> CustomMeasurementPoint.validate(mitAngabe("kWh", "live_power",
                new Measures("active_energy", "import", "counter")))).hasMessageContaining("energy_counter");
        assertThatThrownBy(() -> CustomMeasurementPoint.validate(mitAngabe("kW", "energy_counter",
                new Measures("active_power", "import", "gauge")))).hasMessageContaining("Momentanwert");
    }

    @Test
    void dieAngabeNimmtKeinUnbekanntesFeldAn() {
        assertThatThrownBy(() -> new ObjectMapper().readValue("""
                {"label":"Eigen","sourceKind":"modbus_holding","address":231,
                 "selector":"holding:0x00e7","valueType":"uint16","widthBits":16,
                 "signed":false,"endian":"big","scale":1,"unit":"kWh","cadenceS":60,
                 "retentionClass":"energy_counter","readOnly":true,
                 "measures":{"quantity":"active_energy","direction":"import","aggregationKind":"counter",
                             "sign":"invert"}}
                """, Definition.class)).hasMessageContaining("sign");
    }

    private static Definition mitAngabe(String unit, String retention, Measures m) {
        Definition d = valid();
        return new Definition(d.label(), d.sourceKind(), d.address(), d.selector(), d.valueType(),
                d.widthBits(), d.signed(), d.endian(), d.scale(), unit, d.cadenceS(), retention,
                d.readOnly(), m);
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
