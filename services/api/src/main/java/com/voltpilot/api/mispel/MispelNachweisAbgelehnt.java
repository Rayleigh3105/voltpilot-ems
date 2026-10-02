package com.voltpilot.api.mispel;

/**
 * Ein Nachweis, der nicht hinausgeht (MiSpeL MP-16): Code, HTTP-Status und ein Satz. Codes: {@code empfaenger_unbekannt}
 * (400), {@code zeitraum_ungueltig} (400), {@code kein_lauf} (404), {@code pruefsumme_abweichend} (409 — der gespeicherte
 * Nachweis-Text passt nicht mehr zu seiner Prüfsumme; dann geht keine Datei hinaus).
 */
public final class MispelNachweisAbgelehnt extends RuntimeException {

    private final String code;
    private final int status;

    public MispelNachweisAbgelehnt(String code, int status, String satz) {
        super(satz);
        this.code = code;
        this.status = status;
    }

    public String code() {
        return code;
    }

    public int status() {
        return status;
    }
}
