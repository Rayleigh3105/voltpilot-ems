package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Ein kleiner Läufer über die Teilmenge von JSON-Schema draft 2020-12, die die
 * UEMS-Vektor-Schemas benutzen ({@code uems-referenzunternehmen.schema.json},
 * {@code messwert-herkunft.schema.json}): {@code type}, {@code required},
 * {@code properties}, {@code additionalProperties:false}, {@code items},
 * {@code enum}, {@code const}, {@code pattern}, {@code minItems},
 * {@code minLength}, {@code maxLength}, {@code minimum}, {@code maximum} und
 * {@code $ref} auf {@code #/$defs/…}. Das Projekt hat keine Schema-Bibliothek
 * (siehe {@code services/api/pom.xml}); der Läufer ersetzt keine — er hält eine
 * Datei an genau den Regeln fest, die ihr Schema aufschreibt, und sagt bei jedem
 * Verstoß den Pfad. Ein Schlüsselwort außerhalb dieser Teilmenge (etwa
 * {@code maxItems}) prüft er NICHT; wer sich darauf verlässt, prüft es im Test
 * selbst.
 *
 * <p>Der TS-Zwilling des Referenzunternehmens
 * ({@code frontend/portal/src/uemsReferenzunternehmen.test.ts}) trägt denselben
 * Läufer.
 */
final class UemsSchemaLaeufer {
    private final JsonNode wurzel;
    private final List<String> fehler;
    private final Map<String, Pattern> muster = new HashMap<>();

    UemsSchemaLaeufer(JsonNode wurzel, List<String> fehler) {
        this.wurzel = wurzel;
        this.fehler = fehler;
    }

    /** Alle Verstöße von {@code daten} gegen {@code schema}, je mit Pfad; leer heißt: hält. */
    static List<String> verstoesse(JsonNode daten, JsonNode schema) {
        List<String> fehler = new ArrayList<>();
        new UemsSchemaLaeufer(schema, fehler).pruefe(daten, schema, "$");
        return fehler;
    }

    void pruefe(JsonNode wert, JsonNode schema, String pfad) {
        if (schema.has("$ref")) {
            String ref = schema.get("$ref").asText();
            JsonNode ziel = wurzel.at(ref.substring(1));
            if (ziel.isMissingNode()) {
                fehler.add(pfad + ": unbekannter Schema-Verweis " + ref);
                return;
            }
            pruefe(wert, ziel, pfad);
            return;
        }
        if (schema.has("type") && !typPasst(wert, schema.get("type"))) {
            fehler.add(pfad + ": Typ " + typVon(wert) + " passt nicht zu " + schema.get("type"));
            return;
        }
        if (schema.has("const") && !wert.equals(schema.get("const"))) {
            fehler.add(pfad + ": " + wert + " ist nicht " + schema.get("const"));
        }
        if (schema.has("enum") && !wert.isNull()) {
            boolean drin = false;
            for (JsonNode e : schema.get("enum")) {
                drin |= e.equals(wert);
            }
            if (!drin) {
                fehler.add(pfad + ": " + wert + " steht nicht im Vokabular " + schema.get("enum"));
            }
        }
        if (wert.isTextual()) {
            pruefeText(wert.asText(), schema, pfad);
        }
        if (wert.isNumber()) {
            if (schema.has("minimum") && wert.asDouble() < schema.get("minimum").asDouble()) {
                fehler.add(pfad + ": " + wert + " unter dem Mindestwert");
            }
            if (schema.has("maximum") && wert.asDouble() > schema.get("maximum").asDouble()) {
                fehler.add(pfad + ": " + wert + " über dem Höchstwert");
            }
        }
        if (wert.isArray()) {
            if (schema.has("minItems") && wert.size() < schema.get("minItems").asInt()) {
                fehler.add(pfad + ": zu wenige Einträge");
            }
            if (schema.has("items")) {
                for (int i = 0; i < wert.size(); i++) {
                    pruefe(wert.get(i), schema.get("items"), pfad + "[" + i + "]");
                }
            }
        }
        if (wert.isObject()) {
            pruefeObjekt(wert, schema, pfad);
        }
    }

    private void pruefeText(String s, JsonNode schema, String pfad) {
        if (schema.has("pattern")
                && !muster.computeIfAbsent(schema.get("pattern").asText(), Pattern::compile)
                        .matcher(s).find()) {
            fehler.add(pfad + ": „" + s + "“ passt nicht zum Muster "
                    + schema.get("pattern").asText());
        }
        if (schema.has("minLength") && s.length() < schema.get("minLength").asInt()) {
            fehler.add(pfad + ": zu kurz");
        }
        if (schema.has("maxLength") && s.length() > schema.get("maxLength").asInt()) {
            fehler.add(pfad + ": zu lang");
        }
    }

    private void pruefeObjekt(JsonNode wert, JsonNode schema, String pfad) {
        for (JsonNode p : schema.path("required")) {
            if (!wert.has(p.asText())) {
                fehler.add(pfad + ": Pflichtfeld " + p.asText() + " fehlt");
            }
        }
        JsonNode props = schema.path("properties");
        JsonNode zusatz = schema.path("additionalProperties");
        Set<String> bekannt = new HashSet<>();
        props.fieldNames().forEachRemaining(bekannt::add);
        wert.fields().forEachRemaining(e -> {
            if (bekannt.contains(e.getKey())) {
                pruefe(e.getValue(), props.get(e.getKey()), pfad + "." + e.getKey());
            } else if (zusatz.isObject()) {
                pruefe(e.getValue(), zusatz, pfad + "." + e.getKey());
            } else if (zusatz.isBoolean() && !zusatz.asBoolean()) {
                fehler.add(pfad + ": unbekanntes Feld " + e.getKey());
            }
        });
    }

    private static boolean typPasst(JsonNode wert, JsonNode typ) {
        if (typ.isArray()) {
            for (JsonNode t : typ) {
                if (einTypPasst(wert, t.asText())) {
                    return true;
                }
            }
            return false;
        }
        return einTypPasst(wert, typ.asText());
    }

    private static boolean einTypPasst(JsonNode wert, String typ) {
        return switch (typ) {
            case "object" -> wert.isObject();
            case "array" -> wert.isArray();
            case "string" -> wert.isTextual();
            case "integer" -> wert.isIntegralNumber();
            case "number" -> wert.isNumber();
            case "boolean" -> wert.isBoolean();
            case "null" -> wert.isNull();
            default -> false;
        };
    }

    private static String typVon(JsonNode wert) {
        if (wert.isObject()) {
            return "object";
        }
        if (wert.isArray()) {
            return "array";
        }
        if (wert.isTextual()) {
            return "string";
        }
        if (wert.isIntegralNumber()) {
            return "integer";
        }
        if (wert.isNumber()) {
            return "number";
        }
        if (wert.isBoolean()) {
            return "boolean";
        }
        return "null";
    }
}
