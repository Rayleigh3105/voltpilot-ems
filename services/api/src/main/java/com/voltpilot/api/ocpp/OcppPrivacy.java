package com.voltpilot.api.ocpp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Defense-in-depth redaction at the cloud boundary. A conforming edge already
 * sends {@code tagref_*}; a compromised/old edge is still never allowed to put
 * a clear idTag, AuthorizationKey or diagnostics URL into Postgres or an API.
 */
@Component
public class OcppPrivacy {
    private final byte[] pepper;

    public OcppPrivacy(@Value("${voltpilot.ocpp.privacy-pepper:local-dev-only-change-me}")
            String pepper) {
        this.pepper = pepper.getBytes(StandardCharsets.UTF_8);
    }

    public JsonNode redact(JsonNode input, String action) {
        JsonNode copy = input == null ? com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.objectNode()
                : input.deepCopy();
        redactNode(copy, action == null ? "" : action);
        return copy;
    }

    private void redactNode(JsonNode node, String action) {
        if (node instanceof ObjectNode object) {
            boolean configurationSecret = isSecretConfigurationKey(object.path("key").asText());
            boolean redacted = false;
            Iterator<Map.Entry<String, JsonNode>> fields = object.fields();
            while (fields.hasNext()) {
                Map.Entry<String, JsonNode> entry = fields.next();
                String key = entry.getKey();
                String lower = key.toLowerCase(Locale.ROOT);
                JsonNode value = entry.getValue();
                if ((lower.equals("idtag") || lower.equals("parentidtag")) && value.isTextual()) {
                    // Never trust a prefix as proof that an old/compromised
                    // edge already redacted. HMACing an edge tagref again is
                    // deterministic and prevents a real idTag that merely
                    // looks like "tagref_<hex>" from bypassing this boundary.
                    object.put(key, reference(value.asText()));
                } else if (isSecretField(lower) || (configurationSecret && lower.equals("value"))) {
                    object.putNull(key);
                    redacted = true;
                } else if (lower.equals("location") && value.isTextual()
                        && ("GetDiagnostics".equals(action) || "UpdateFirmware".equals(action))) {
                    object.put(key, "[redacted-url]");
                } else if ("DataTransfer".equals(action) && lower.equals("data")) {
                    object.put(key, "[redacted-untyped-vendor-data]");
                } else {
                    redactNode(value, action);
                }
            }
            if (redacted) {
                object.put("redacted", true);
            }
        } else if (node instanceof ArrayNode array) {
            array.forEach(value -> redactNode(value, action));
        }
    }

    static boolean isSecretConfigurationKey(String key) {
        if (key == null) return false;
        String normalized = key.toLowerCase(Locale.ROOT).replace("_", "").replace("-", "");
        return normalized.equals("authorizationkey") || normalized.contains("password")
                || normalized.contains("passwd") || normalized.contains("secret")
                || normalized.contains("accesstoken") || normalized.contains("refreshtoken")
                || normalized.contains("credential") || normalized.contains("privatekey")
                || normalized.contains("clientkey") || normalized.contains("apikey");
    }

    private static boolean isSecretField(String lower) {
        return isSecretConfigurationKey(lower);
    }

    private String reference(String value) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(pepper, "HmacSHA256"));
            byte[] out = mac.doFinal(value.getBytes(StandardCharsets.UTF_8));
            return "tagref_" + HexFormat.of().formatHex(out, 0, 12);
        } catch (Exception e) {
            throw new IllegalStateException("HmacSHA256 unavailable", e);
        }
    }
}
