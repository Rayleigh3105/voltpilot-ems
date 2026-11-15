package com.voltpilot.api.steuerlogik;

import com.fasterxml.jackson.databind.JsonNode;

/** Ein ehrlicher Halt des Dienstes: Grund als Code, Satz auf Deutsch, bei einer Sperre der Prüfbericht. */
public class SteuerlogikDienstException extends RuntimeException {

    /** Der Dienst ist nicht erreichbar oder antwortet unerwartet. */
    public static final String NICHT_ERREICHBAR = "dienst_nicht_erreichbar";
    /** Die Leser lehnen den Text ab (Schreibform, Schema, Ausdrücke). */
    public static final String UNLESBAR = "logik_unlesbar";
    /** Lesbar, aber die Prüfung sperrt (Befunde oder eine Probe, die nicht besteht; E5 = C). */
    public static final String GESPERRT = "pruefung_sperrt";
    /** Gestellte Werte passen nicht (Art, Bereich, Schritt, Auswahl oder die Bedingungen zwischen ihnen). */
    public static final String STELLWERTE = "stellwerte_passen_nicht";
    /** Ein Baustein lässt sich nicht lesen, oder ein Satz nennt eine Lücke, die die Logik nicht hat (Stufe 5). */
    public static final String BAUSTEIN = "baustein_unlesbar";

    private final String grund;
    private final transient JsonNode bericht;
    private final transient JsonNode meldungen;

    public SteuerlogikDienstException(String grund, String message, JsonNode bericht) {
        this(grund, message, bericht, null);
    }

    public SteuerlogikDienstException(String grund, String message, JsonNode bericht, JsonNode meldungen) {
        super(message);
        this.grund = grund;
        this.bericht = bericht;
        this.meldungen = meldungen;
    }

    /** Bei einem unlesbaren Text die Meldung des Lesers an ihrer Zeile ({@code [{art, text, zeile}]}), sonst null. */
    public JsonNode meldungen() {
        return meldungen;
    }

    public String grund() {
        return grund;
    }

    /** Der Prüfbericht einer gesperrten Logik, sonst {@code null}. */
    public JsonNode bericht() {
        return bericht;
    }

    static SteuerlogikDienstException nichtErreichbar() {
        return new SteuerlogikDienstException(NICHT_ERREICHBAR,
                "Der Logik-Dienst ist gerade nicht erreichbar. Bitte später erneut versuchen.", null);
    }
}
