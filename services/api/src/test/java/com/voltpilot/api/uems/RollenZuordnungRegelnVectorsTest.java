package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.RollenZuordnungRegeln.Quelle;
import com.voltpilot.api.uems.RollenZuordnungRegeln.Stand;
import com.voltpilot.api.uems.RollenZuordnungRegeln.Zuordnung;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/** Kein Spring, keine Datenbank, keine echte Uhr; dieselben Fälle wie uemsRollen.test.ts. */
class RollenZuordnungRegelnVectorsTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path V2 = Path.of("../../docs/contracts/v2");
    private static JsonNode vectors() throws Exception {
        return JSON.readTree(Files.readString(V2.resolve("rollen-zuordnung-vectors.json")));
    }
    private static String text(JsonNode n) { return n.isNull() ? null : n.asText(); }
    private static List<Zuordnung> zuordnungen(JsonNode n) {
        return JSON.convertValue(n, JSON.getTypeFactory().constructCollectionType(List.class, Zuordnung.class));
    }
    private static Object auswerten(String familie, JsonNode i) {
        return switch (familie) {
            case "rolle" -> RollenZuordnungRegeln.rolle(text(i.get("rolle")));
            case "wert" -> RollenZuordnungRegeln.wertGueltig(JSON.convertValue(i.get("quelle"), Quelle.class));
            case "frische" -> RollenZuordnungRegeln.frische(i.get("jetzt").asText(), JSON.convertValue(i.get("zustand"), Stand.class));
            case "netz" -> RollenZuordnungRegeln.netz(i.get("anlage").asText(), zuordnungen(i.get("zuordnungen")));
            case "zaehlung" -> RollenZuordnungRegeln.zaehlung(i.get("anlage").asText(), i.get("rolle").asText(),
                    i.get("jetzt").asText(), zuordnungen(i.get("zuordnungen")));
            case "aenderung" -> RollenZuordnungRegeln.aenderung(JSON.convertValue(i.get("alt"), Quelle.class), JSON.convertValue(i.get("neu"), Quelle.class));
            default -> throw new AssertionError("Ungeprüfte Familie: " + familie);
        };
    }
    @Test
    void vokabulareUndFamilienSindGeschlossen() throws Exception {
        JsonNode v = vectors();
        assertThat(v.get("rollen")).isEqualTo(JSON.valueToTree(RollenZuordnungRegeln.ROLLEN));
        assertThat(v.get("gruende")).isEqualTo(JSON.valueToTree(RollenZuordnungRegeln.GRUENDE));
        assertThat(v.get("protokoll")).isEqualTo(JSON.valueToTree(RollenZuordnungRegeln.PROTOKOLL));
        assertThat(v.get("frische_sekunden").asInt()).isEqualTo(RollenZuordnungRegeln.FRISCHE_SEKUNDEN);
        assertThat(v.get("familien")).isEqualTo(JSON.valueToTree(List.of("rolle", "wert", "zaehlung", "netz", "frische", "aenderung")));
        List<String> familien = new ArrayList<>();
        v.get("cases").fieldNames().forEachRemaining(familien::add);
        assertThat((JsonNode) JSON.valueToTree(familien)).isEqualTo(v.get("familien"));
    }
    @Test
    void vektorenHaltenDasSchema() throws Exception {
        JsonNode schema = JSON.readTree(Files.readString(V2.resolve("rollen-zuordnung.schema.json")));
        JsonNode v = vectors();
        assertThat(UemsSchemaLaeufer.verstoesse(v, schema)).isEmpty();
        ((com.fasterxml.jackson.databind.node.ObjectNode) v).put("unbemerkt", true);
        assertThat(UemsSchemaLaeufer.verstoesse(v, schema)).isNotEmpty();
    }
    @TestFactory
    List<DynamicTest> alleVektoren() throws Exception {
        JsonNode v = vectors();
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode f : v.get("familien")) {
            String familie = f.asText();
            assertThat(v.get("cases").get(familie).size()).isPositive();
            for (JsonNode c : v.get("cases").get(familie)) {
                tests.add(DynamicTest.dynamicTest(familie + ": " + c.get("name").asText(), () -> {
                    if (c.has("expected_error")) {
                        assertThatThrownBy(() -> auswerten(familie, c.get("input")))
                                .isInstanceOf(IllegalArgumentException.class).hasMessage(c.get("expected_error").asText());
                        return;
                    }
                    JsonNode ist = JSON.valueToTree(auswerten(familie, c.get("input")));
                    assertThat(ist.equals((a, b) -> a.isNumber() && b.isNumber()
                            ? a.decimalValue().compareTo(b.decimalValue()) : a.equals(b) ? 0 : 1, c.get("expected")))
                            .as("Ergebnis %s, erwartet %s", ist, c.get("expected")).isTrue();
                }));
            }
        }
        return tests;
    }
}
