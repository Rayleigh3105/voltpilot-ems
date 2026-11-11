package com.voltpilot.api.versand.webhook;

import java.nio.charset.StandardCharsets;
import java.security.InvalidKeyException;
import java.security.NoSuchAlgorithmException;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** HMAC-SHA256 über den rohen JSON-Körper, mit dem Geheimnis GENAU dieses Webhooks (§7 Scheibe 6). */
final class WebhookSignatur {

    private static final String ALGORITHMUS = "HmacSHA256";

    private WebhookSignatur() {
    }

    static String signieren(String geheimnis, String koerper) {
        try {
            Mac mac = Mac.getInstance(ALGORITHMUS);
            mac.init(new SecretKeySpec(geheimnis.getBytes(StandardCharsets.UTF_8), ALGORITHMUS));
            byte[] rohe = mac.doFinal(koerper.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(rohe.length * 2);
            for (byte b : rohe) {
                hex.append(Character.forDigit((b >> 4) & 0xf, 16)).append(Character.forDigit(b & 0xf, 16));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException | InvalidKeyException e) {
            throw new IllegalStateException("HMAC-SHA256 nicht verfügbar", e);
        }
    }
}
