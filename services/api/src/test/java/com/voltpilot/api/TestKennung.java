package com.voltpilot.api;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * Eine gültige Kennung einer VoltPilot-Box für Tests (Anlage-Flow a1, B4): Kundenkonten dürfen nur
 * noch Kennungen der Box ({@code edge-} + sechs Zeichen + Prüfzeichen) oder des Herstellregisters
 * ({@code VP-…}) verbinden. Die Tests behalten ihre sprechenden Namen ({@code "edge-ladepark-1"}) und
 * machen daraus deterministisch eine gültige Kennung - derselbe Name ergibt überall dieselbe Kennung.
 * Algorithmus: {@code docs/contracts/edge-ref-vectors.json}.
 */
public final class TestKennung {

    private static final String ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

    private TestKennung() {
    }

    /** Die gültige Box-Kennung zum Namen {@code saat}. */
    public static String box(String saat) {
        byte[] h;
        try {
            h = MessageDigest.getInstance("SHA-256").digest(saat.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
        StringBuilder body = new StringBuilder();
        int sum = 0;
        for (int i = 0; i < 6; i++) {
            int v = (h[i] & 0xff) % ALPHABET.length();
            body.append(ALPHABET.charAt(v));
            sum += (i + 1) * v;
        }
        return "edge-" + body + ALPHABET.charAt(sum % ALPHABET.length());
    }
}
