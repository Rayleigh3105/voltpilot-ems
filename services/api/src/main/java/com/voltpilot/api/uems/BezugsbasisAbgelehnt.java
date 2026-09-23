package com.voltpilot.api.uems;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Eine abgelehnte Anfrage an eine Bezugsbasis (UEMS AP-17 IP-7): Status, Code aus dem geschlossenen Satz des Vertrags
 * ({@code bezugsbasis.md} „Routen“), ein Satz und die Fakten, die der Kunde zum Verstehen braucht.
 */
public class BezugsbasisAbgelehnt extends RuntimeException {

    private final int status;
    private final String code;
    private final Map<String, Object> fakten;

    public BezugsbasisAbgelehnt(int status, String code, String satz, Map<String, Object> fakten) {
        super(satz);
        this.status = status;
        this.code = code;
        this.fakten = fakten == null ? Map.of() : new LinkedHashMap<>(fakten);
    }

    static BezugsbasisAbgelehnt nichtGefunden() {
        return new BezugsbasisAbgelehnt(404, "nicht_gefunden", "Diese Bezugsbasis gibt es nicht.", null);
    }

    static BezugsbasisAbgelehnt anfrage(String feld) {
        return new BezugsbasisAbgelehnt(400, "anfrage_ungueltig", "Die Anfrage ist so nicht lesbar.",
                Map.of("feld", feld));
    }

    static BezugsbasisAbgelehnt fachlich(String code, String satz, Map<String, Object> fakten) {
        return new BezugsbasisAbgelehnt(422, code, satz, fakten);
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
