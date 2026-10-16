package com.voltpilot.api.versand;

import java.security.SecureRandom;
import java.util.Base64;

/**
 * Ein einmaliger, URL-sicherer Token (256 Bit) - ursprünglich nur für den E-Mail-Zustellweg
 * (§6.6/§6.7), seit Alerting Scheibe 6 auch für den Telegram-Start-Link, das Webhook-Geheimnis und
 * den Bestätigungs-/Abbestellen-Token externer E-Mail-Empfänger (§7 Scheibe 6, Entscheid 11B) - EIN
 * Erzeuger für jeden Token/Geheimnis dieser Art statt vier eigener {@code SecureRandom}-Kopien.
 */
public final class BestaetigungsToken {

    private static final SecureRandom ZUFALL = new SecureRandom();

    private BestaetigungsToken() {
    }

    public static String erzeugen() {
        byte[] bytes = new byte[32];
        ZUFALL.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }
}
