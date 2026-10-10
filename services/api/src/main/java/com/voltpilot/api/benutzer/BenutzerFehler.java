package com.voltpilot.api.benutzer;

/** Ausschließlich feste Kundentexte; niemals einen Keycloak-Fehlerkörper übernehmen. */
public class BenutzerFehler extends RuntimeException {
    public final int status;
    public final String code;
    public BenutzerFehler(int status, String code, String text) {
        super(text);
        this.status = status;
        this.code = code;
    }
}
