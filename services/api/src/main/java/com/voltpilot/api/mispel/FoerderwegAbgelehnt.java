package com.voltpilot.api.mispel;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Ein abgelehnter Förderweg (MiSpeL MP-5): Code und Status wie der Vertrag
 * {@code docs/contracts/v2/mispel-foerderweg.md} § 4 sie nennt, dazu die Fakten mit Fundstelle.
 */
public final class FoerderwegAbgelehnt extends RuntimeException {

    private final String code;
    private final int status;
    private final Map<String, Object> fakten;

    public FoerderwegAbgelehnt(String code, int status, String satz, Map<String, Object> fakten) {
        super(satz);
        this.code = code;
        this.status = status;
        this.fakten = Collections.unmodifiableMap(new LinkedHashMap<>(fakten));
    }

    static FoerderwegAbgelehnt aus(FoerderwegRegeln.Ablehnung a) {
        return new FoerderwegAbgelehnt(a.code(), a.status(), a.satz(), a.fakten());
    }

    public static FoerderwegAbgelehnt anfrage(String feld, String satz) {
        return new FoerderwegAbgelehnt("anfrage_ungueltig", 400, satz, Map.of("feld", feld));
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
