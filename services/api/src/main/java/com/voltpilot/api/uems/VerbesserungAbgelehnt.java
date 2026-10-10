package com.voltpilot.api.uems;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Eine abgelehnte Anfrage an einen Vorgang der Verbesserung (UEMS AP-18: Energieziel, später Maßnahme und Abweichung):
 * Status, Code, ein Satz und die Fakten, die der Kunde zum Verstehen braucht — Muster {@link BezugsbasisAbgelehnt}.
 */
public class VerbesserungAbgelehnt extends RuntimeException {

    private final int status;
    private final String code;
    private final Map<String, Object> fakten;

    public VerbesserungAbgelehnt(int status, String code, String satz, Map<String, Object> fakten) {
        super(satz);
        this.status = status;
        this.code = code;
        this.fakten = fakten == null ? Map.of() : new LinkedHashMap<>(fakten);
    }

    static VerbesserungAbgelehnt nichtGefunden() {
        return new VerbesserungAbgelehnt(404, "nicht_gefunden", "Dieses Energieziel gibt es nicht.", null);
    }

    public static VerbesserungAbgelehnt anfrage(String feld) {
        return new VerbesserungAbgelehnt(400, "anfrage_ungueltig", "Die Anfrage ist so nicht lesbar.",
                Map.of("feld", feld));
    }

    static VerbesserungAbgelehnt fachlich(String code, String satz, Map<String, Object> fakten) {
        return new VerbesserungAbgelehnt(422, code, satz, fakten);
    }

    public int status() {
        return status;
    }

    public String code() {
        return code;
    }

    public Map<String, Object> fakten() {
        return fakten;
    }
}
