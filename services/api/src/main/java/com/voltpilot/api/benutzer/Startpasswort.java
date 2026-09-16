package com.voltpilot.api.benutzer;

import com.fasterxml.jackson.annotation.JsonValue;
import java.security.SecureRandom;

/** Nur für die einmalige Antwort und die Übergabe an Keycloak, niemals speichern. */
public record Startpasswort(@JsonValue String wert) {
    private static final SecureRandom ZUFALL = new SecureRandom();
    private static final String ZEICHEN = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!+-_";

    public static Startpasswort erzeugen() {
        // Jede Zeichengruppe ist vertreten; Keycloak prüft zusätzlich die tatsächliche Realm-Policy.
        char[] zeichen = new char[24];
        String[] gruppen = {"ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!+-_"};
        for (int i = 0; i < zeichen.length; i++) {
            String gruppe = i < gruppen.length ? gruppen[i] : ZEICHEN;
            zeichen[i] = gruppe.charAt(ZUFALL.nextInt(gruppe.length()));
        }
        for (int i = zeichen.length - 1; i > 0; i--) {
            int j = ZUFALL.nextInt(i + 1);
            char c = zeichen[i]; zeichen[i] = zeichen[j]; zeichen[j] = c;
        }
        return new Startpasswort(new String(zeichen));
    }

    @Override public String toString() { return "[geschützt]"; }
}
