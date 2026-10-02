package com.voltpilot.api.mispel;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Eine abgelehnte Angabe am bidirektionalen Ladepunkt (MiSpeL MP-31): Code und Status wie der Vertrag
 * {@code docs/contracts/v2/mispel-ladepunkt-bidirektional.md} § 4 sie nennt, dazu die Fakten mit Fundstelle.
 */
public final class LadepunktAbgelehnt extends RuntimeException {

    private final String code;
    private final int status;
    private final Map<String, Object> fakten;

    public LadepunktAbgelehnt(String code, int status, String satz, Map<String, Object> fakten) {
        super(satz);
        this.code = code;
        this.status = status;
        this.fakten = Collections.unmodifiableMap(new LinkedHashMap<>(fakten));
    }

    static LadepunktAbgelehnt aus(LadepunktRegeln.Ablehnung a) {
        return new LadepunktAbgelehnt(a.code(), a.status(), a.satz(), a.fakten());
    }

    public static LadepunktAbgelehnt anfrage(String feld, String satz) {
        return new LadepunktAbgelehnt("anfrage_ungueltig", 400, satz, Map.of("feld", feld));
    }

    public String code() {
        return code;
    }

    public int status() {
        return status;
    }

    public Map<String, Object> fakten() {
        return fakten;
    }
}
