package com.voltpilot.api.uems;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Eine abgelehnte Zählerrolle (MiSpeL MP-6): Code und Status wie der Vertrag
 * {@code docs/contracts/v2/mispel-zaehlerrolle.md} §4 sie nennt, dazu die Fakten des Urteils.
 */
public final class ZaehlerrolleAbgelehnt extends RuntimeException {

    private final String code;
    private final int status;
    private final Map<String, Object> fakten;

    public ZaehlerrolleAbgelehnt(String code, int status, String satz, Map<String, Object> fakten) {
        super(satz);
        this.code = code;
        this.status = status;
        this.fakten = Collections.unmodifiableMap(new LinkedHashMap<>(fakten));
    }

    static ZaehlerrolleAbgelehnt aus(ZaehlerrolleRegeln.Ablehnung a) {
        return new ZaehlerrolleAbgelehnt(a.code(), a.status(), a.satz(), Map.of("grund", a.grund()));
    }

    public static ZaehlerrolleAbgelehnt anfrage(String feld, String satz) {
        return new ZaehlerrolleAbgelehnt("anfrage_ungueltig", 400, satz, Map.of("feld", feld));
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
