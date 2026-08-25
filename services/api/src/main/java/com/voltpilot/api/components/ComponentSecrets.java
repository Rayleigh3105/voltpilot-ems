package com.voltpilot.api.components;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.ComponentTemplateDto;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/**
 * Die eine Secret-Grenze des Geräte-Assistenten.
 *
 * <p>Ein Geheimnis verlässt den Server nie wieder. Das Portal bekommt nur die
 * feste Maske und schickt bei „unverändert" gar keinen Wert zurück. Beim
 * Bearbeiten wird der alte Wert serverseitig in den neuen, zu testenden
 * Verbindungsblock eingesetzt; nur ein wirklich neu eingegebener Wert ersetzt
 * ihn. Damit ist auch der Verbindungstest exakt, ohne ein Kennwort an den
 * Browser zurückzugeben.
 */
public final class ComponentSecrets {

    public static final String MASK = "••••••••";
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final TypeReference<LinkedHashMap<String, Object>> MAP =
            new TypeReference<>() {};

    private ComponentSecrets() {}

    public static Set<String> keys(ComponentTemplateDto template) {
        Set<String> out = new LinkedHashSet<>();
        if (template == null || template.transportSchema() == null) return out;
        try {
            JsonNode fields = MAPPER.readTree(template.transportSchema());
            if (!fields.isArray()) return out;
            for (JsonNode field : fields) {
                String key = field.path("key").asText("");
                String type = field.path("type").asText("");
                if (!key.isBlank() && (field.path("secret").asBoolean(false)
                        || "password".equals(type)
                        || looksSecret(key))) {
                    out.add(key);
                }
            }
        } catch (Exception ignored) {
            // Eine kaputte Vorlage wird an ihrer Validierungsgrenze abgelehnt.
            // Hier darf daraus niemals versehentlich ein Secret-Leak entstehen:
            // die Schlüssel-Heuristik unten bleibt die zweite Schutzschicht.
        }
        return out;
    }

    public static Map<String, Object> parse(String json) {
        if (json == null || json.isBlank()) return new LinkedHashMap<>();
        try {
            return MAPPER.readValue(json, MAP);
        } catch (Exception e) {
            return new LinkedHashMap<>();
        }
    }

    /** Server-seitiger Merge: absent/leer/Maske heißt „behalten". */
    public static Map<String, Object> merge(Map<String, Object> incoming,
            String existingJson, Set<String> secretKeys) {
        Map<String, Object> old = parse(existingJson);
        Map<String, Object> out = new LinkedHashMap<>();
        if (incoming != null) out.putAll(incoming);
        for (String key : secretKeys) {
            Object next = out.get(key);
            boolean unchanged = next == null || MASK.equals(next)
                    || (next instanceof String s && s.isBlank());
            if (unchanged) {
                if (old.containsKey(key)) out.put(key, old.get(key));
                else out.remove(key);
            }
        }
        return out;
    }

    public static String maskedJson(String json, Set<String> secretKeys) {
        Map<String, Object> out = parse(json);
        for (String key : new LinkedHashSet<>(out.keySet())) {
            // Die Heuristik bleibt absichtlich aktiv, wenn eine alte/entzogene
            // Vorlage nicht mehr auflösbar ist. Gerade dann darf ein Listing
            // nicht plötzlich das frühere Kennwort ausgeben.
            if (secretKeys.contains(key) || looksSecret(key)) out.put(key, MASK);
        }
        try {
            return MAPPER.writeValueAsString(out);
        } catch (Exception e) {
            return "{}";
        }
    }

    private static boolean looksSecret(String key) {
        String lower = key.toLowerCase(java.util.Locale.ROOT);
        return lower.contains("password") || lower.contains("secret")
                || lower.endsWith("token") || lower.endsWith("api_key");
    }
}
