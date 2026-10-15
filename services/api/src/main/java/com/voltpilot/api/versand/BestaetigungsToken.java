package com.voltpilot.api.versand;

import java.security.SecureRandom;
import java.util.Base64;

/** Ein einmaliger, URL-sicherer Bestätigungs-Token (256 Bit) für den E-Mail-Zustellweg (§6.6/§6.7). */
final class BestaetigungsToken {

    private static final SecureRandom ZUFALL = new SecureRandom();

    private BestaetigungsToken() {
    }

    static String erzeugen() {
        byte[] bytes = new byte[32];
        ZUFALL.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }
}
