package com.voltpilot.api.uems;

import java.util.Map;

/** Stabile Ablehnungen der Energieeinsatz-Routen und ihres Bezugsgrößen-Verweises. */
public final class EnergieeinsatzAbgelehnt extends RuntimeException {
    private final int status;
    private final String code;
    private final Map<String, Object> fakten;

    public EnergieeinsatzAbgelehnt(int status, String code, String satz) {
        this(status, code, satz, Map.of());
    }
    public EnergieeinsatzAbgelehnt(int status, String code, String satz, Map<String, Object> fakten) {
        super(satz);
        this.status = status;
        this.code = code;
        this.fakten = Map.copyOf(fakten);
    }
    public int status() { return status; }
    public String code() { return code; }
    public Map<String, Object> fakten() { return fakten; }
    public static EnergieeinsatzAbgelehnt fehlt() {
        return new EnergieeinsatzAbgelehnt(404, "nicht_gefunden", "Der Energieeinsatz wurde nicht gefunden.");
    }
}
