package com.voltpilot.api.components;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.ComponentTemplateDto;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/**
 * Prüft die Verbindung einer Komponente gegen das {@code transport_schema} ihrer Vorlage.
 *
 * <p>Warum es das braucht (Scout vp-kundenanlage-drei-geraete, 04.11.2026): ein Zahlenfeld
 * kam als Text an ({@code "unit_id": "01"}), die API speicherte es ungeprüft, und die Box
 * lehnte danach die GANZE Geräte-Konfiguration ab ({@code cannot unmarshal string into Go
 * struct field Connection.unit_id of type int}). Die Grenze steht deshalb VOR dem Test-Beleg
 * und dem Speichern: ein Feld hat genau den JSON-Typ, den die Vorlage ihm gibt.
 *
 * <p>Geprüft wird nur der Typ der Felder, die das Schema kennt ({@code number} = JSON-Zahl,
 * {@code checkbox} = Boolean, {@code select} = einer der Optionswerte in genau deren Typ,
 * {@code text} = String). Wertebereiche (Port, Unit-ID) bleiben bei der Box
 * ({@code inverter.Catalog.Normalize}), die den einen gültigen Bereich je Weg kennt.
 * Schlüssel außerhalb des Schemas (Server-Stempel, {@code interval_s}) und fehlende oder
 * {@code null}-Werte lässt die Prüfung unberührt: "nicht gesetzt" ist kein Typfehler.
 */
public final class ComponentConnectionSchema {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private ComponentConnectionSchema() {}

    /** Alle Typverstöße in Kundensprache; leer = die Verbindung passt zum Schema. */
    public static List<String> violations(ComponentTemplateDto template,
            Map<String, Object> connection) {
        List<String> out = new ArrayList<>();
        if (template == null || template.transportSchema() == null || connection == null) {
            return out;
        }
        JsonNode fields;
        try {
            fields = MAPPER.readTree(template.transportSchema());
        } catch (Exception e) {
            // Eine kaputte Vorlage wird an ihrer Validierungsgrenze abgelehnt, nicht hier.
            return out;
        }
        if (fields == null || !fields.isArray()) return out;
        for (JsonNode field : fields) {
            String key = field.path("key").asText("");
            if (key.isBlank() || !connection.containsKey(key)) continue;
            Object value = connection.get(key);
            if (value == null) continue;
            String problem = problem(field, value);
            if (problem != null) {
                out.add("Das Feld „" + field.path("label").asText(key) + "“ " + problem);
            }
        }
        return out;
    }

    /** Wirft 400 mit dem ersten Verstoß, wenn die Verbindung nicht zum Schema passt. */
    public static void require(ComponentTemplateDto template, Map<String, Object> connection) {
        List<String> violations = violations(template, connection);
        if (!violations.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, violations.get(0));
        }
    }

    private static String problem(JsonNode field, Object value) {
        switch (field.path("type").asText("")) {
            case "number":
                return value instanceof Number ? null : "muss eine Zahl sein.";
            case "checkbox":
                return value instanceof Boolean ? null : "muss ein Haken (an oder aus) sein.";
            case "text":
                return value instanceof String ? null : "muss ein Text sein.";
            case "select":
                return optionProblem(field.path("options"), value);
            default:
                return null;
        }
    }

    private static String optionProblem(JsonNode options, Object value) {
        if (!options.isArray() || options.isEmpty()) return null;
        for (JsonNode option : options) {
            JsonNode candidate = option.path("value");
            if (candidate.isNumber() && value instanceof Number n
                    && candidate.decimalValue().compareTo(new BigDecimal(n.toString())) == 0) {
                return null;
            }
            if (candidate.isTextual() && value instanceof String s
                    && candidate.asText().equals(s)) {
                return null;
            }
        }
        return "hat einen Wert, der nicht zur Auswahl gehört.";
    }
}
