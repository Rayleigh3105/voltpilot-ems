package com.voltpilot.api.fernwartung;

import java.util.Base64;
import java.util.regex.Pattern;

/**
 * Prüfung öffentlicher WireGuard-Schlüssel. Hier kommen nur ÖFFENTLICHE
 * Schlüssel an: der private Teil entsteht auf der Box bzw. auf dem Gerät des
 * Technikers und verlässt es nie (Entscheid E5, Plan 1.5).
 *
 * <p>Dieselbe Regel steht als CHECK in der Migration V20261007163700 und im
 * Tunnel-Dienst ({@code services/tunnel-dienst/internal/soll}).
 */
public final class WireguardSchluessel {

    /** 32 Byte Base64: 42 freie Zeichen, eines mit nur 4 Nutzbits, dann {@code =}. */
    private static final Pattern FORM = Pattern.compile("^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$");

    private WireguardSchluessel() {
    }

    public static boolean gueltig(String schluessel) {
        if (schluessel == null || !FORM.matcher(schluessel).matches()) {
            return false;
        }
        return Base64.getDecoder().decode(schluessel).length == 32;
    }

    /** Kurzform für Listen und das Protokoll, z. B. {@code LnLMuBG+…BudjE=}. */
    public static String kurz(String schluessel) {
        if (schluessel == null || schluessel.length() < 14) {
            return schluessel;
        }
        return schluessel.substring(0, 8) + "…" + schluessel.substring(schluessel.length() - 6);
    }
}
