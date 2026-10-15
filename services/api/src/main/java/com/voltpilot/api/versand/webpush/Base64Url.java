package com.voltpilot.api.versand.webpush;

import java.util.Base64;

/**
 * URL-sicheres Base64 ohne Füllzeichen - die Form, in der der Browser (PushSubscription.toJSON) und
 * VAPID-Schlüssel (RFC 8292) Bytes als Text tragen. Der JDK-Dekoder verlangt eine durch 4 teilbare
 * Länge; fehlende Füllzeichen werden vor dem Dekodieren ergänzt.
 */
final class Base64Url {

    private Base64Url() {
    }

    static byte[] decode(String text) {
        String ohneLeerraum = text.strip();
        int rest = ohneLeerraum.length() % 4;
        String gepolstert = rest == 0 ? ohneLeerraum : ohneLeerraum + "====".substring(rest);
        return Base64.getUrlDecoder().decode(gepolstert);
    }

    static String encode(byte[] bytes) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }
}
