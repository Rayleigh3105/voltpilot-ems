package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.voltpilot.api.web.dto.ComponentTemplateDto;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Typgrenze zwischen Portal-Formular und Box (Scout vp-kundenanlage-drei-geraete,
 * 04.11.2026): {@code "unit_id": "01"} wurde gespeichert und die Box lehnte den ganzen Push ab.
 */
class ComponentConnectionSchemaTest {

    private static final String SCHEMA = "["
            + "{\"key\":\"ip\",\"label\":\"IP-Adresse\",\"type\":\"text\",\"required\":true},"
            + "{\"key\":\"port\",\"label\":\"Port\",\"type\":\"number\",\"default\":502},"
            + "{\"key\":\"unit_id\",\"label\":\"Modbus-Unit-ID\",\"type\":\"number\",\"default\":0},"
            + "{\"key\":\"invert_grid_sign\",\"label\":\"Netz-Vorzeichen invertieren\","
            + "\"type\":\"checkbox\"},"
            + "{\"key\":\"control_write_fc\",\"label\":\"Schreib-Funktionscode\",\"type\":\"select\","
            + "\"options\":[{\"value\":0,\"label\":\"Automatisch\"},{\"value\":16,\"label\":\"FC16\"}]},"
            + "{\"key\":\"byte_order\",\"label\":\"Byte-Reihenfolge\",\"type\":\"select\","
            + "\"options\":[{\"value\":\"auto\",\"label\":\"Automatisch\"},"
            + "{\"value\":\"little\",\"label\":\"Little\"}]},"
            + "{\"key\":\"untyped\",\"label\":\"Ohne Typ\"}]";

    private static ComponentTemplateDto template() {
        return new ComponentTemplateDto("builtin:huawei:sun2000-m1", "builtin", 1, "huawei",
                "Huawei", "sun2000-m1", "SUN2000-M1", null, "inverter", null,
                "huawei_sun2000_luna", "SUN2000 + LUNA2000", "huawei_modbus", "Modbus TCP",
                SCHEMA, null, null, null, 0, "builtin", null, null, null, null);
    }

    private static Map<String, Object> conn(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
        return m;
    }

    @Test
    void acceptsAConnectionWhoseFieldsHaveTheTypesTheSchemaDeclares() {
        assertThat(ComponentConnectionSchema.violations(template(), conn(
                "ip", "192.168.178.60", "port", 502, "unit_id", 1, "invert_grid_sign", true,
                "control_write_fc", 16, "byte_order", "little", "untyped", 7,
                "interval_s", 10, "allow_missing_soc", true))).isEmpty();
    }

    @Test
    void absentAndNullValuesAreNotATypeError() {
        assertThat(ComponentConnectionSchema.violations(template(),
                conn("ip", "10.0.0.2", "unit_id", null))).isEmpty();
        assertThat(ComponentConnectionSchema.violations(template(), Map.of())).isEmpty();
    }

    @Test
    void refusesANumberFieldThatArrivedAsText() {
        // Das echte Fehlerbild: die Eingabe "1" wurde an die Vorgabe "0" gehängt -> "01".
        assertThat(ComponentConnectionSchema.violations(template(),
                conn("ip", "10.0.0.2", "unit_id", "01")))
                .containsExactly("Das Feld „Modbus-Unit-ID“ muss eine Zahl sein.");
        assertThat(ComponentConnectionSchema.violations(template(), conn("port", "4196")))
                .containsExactly("Das Feld „Port“ muss eine Zahl sein.");
        assertThat(ComponentConnectionSchema.violations(template(), conn("port", ""))).hasSize(1);
        assertThat(ComponentConnectionSchema.violations(template(), conn("port", true))).hasSize(1);
    }

    @Test
    void refusesWrongTypesForCheckboxTextAndSelect() {
        assertThat(ComponentConnectionSchema.violations(template(),
                conn("invert_grid_sign", "true")))
                .containsExactly("Das Feld „Netz-Vorzeichen invertieren“ muss ein Haken (an oder aus) sein.");
        assertThat(ComponentConnectionSchema.violations(template(), conn("ip", 12345)))
                .containsExactly("Das Feld „IP-Adresse“ muss ein Text sein.");
        // Auswahl mit Zahlenwerten: "16" als Text ist NICHT 16 (Go: string -> int scheitert).
        assertThat(ComponentConnectionSchema.violations(template(), conn("control_write_fc", "16")))
                .containsExactly("Das Feld „Schreib-Funktionscode“ hat einen Wert, der nicht zur Auswahl gehört.");
        assertThat(ComponentConnectionSchema.violations(template(), conn("control_write_fc", 7))).hasSize(1);
        assertThat(ComponentConnectionSchema.violations(template(), conn("byte_order", "big"))).hasSize(1);
    }

    @Test
    void requireAnswersBadRequestWithTheFieldName() {
        assertThatThrownBy(() -> ComponentConnectionSchema.require(template(), conn("unit_id", "01")))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> {
                    assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
                    assertThat(e.getReason()).contains("Modbus-Unit-ID").contains("Zahl");
                });
    }

    @Test
    void aTemplateWithoutAReadableSchemaLeavesTheConnectionAlone() {
        ComponentTemplateDto none = new ComponentTemplateDto("t", "builtin", 1, "b", "B", "m", "M",
                null, "inverter", null, "f", "F", "c", "C", null, null, null, null, 0, "builtin",
                null, null, null, null);
        assertThat(ComponentConnectionSchema.violations(none, conn("unit_id", "01"))).isEmpty();
        assertThat(ComponentConnectionSchema.violations(null, conn("unit_id", "01"))).isEmpty();
    }
}
