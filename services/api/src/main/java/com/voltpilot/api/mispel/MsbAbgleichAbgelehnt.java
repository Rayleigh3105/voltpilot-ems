package com.voltpilot.api.mispel;

import java.util.LinkedHashMap;
import java.util.Map;

/** Eine Ablehnung beim Einlesen der Werte des Messstellenbetreibers (MP-15): {@code {code, message, …Fakten}}. */
public class MsbAbgleichAbgelehnt extends RuntimeException {

    private final String code;
    private final int status;
    private final Map<String, Object> fakten = new LinkedHashMap<>();

    public MsbAbgleichAbgelehnt(String code, int status, String message) {
        super(message);
        this.code = code;
        this.status = status;
    }

    MsbAbgleichAbgelehnt mit(String feld, Object wert) {
        fakten.put(feld, wert);
        return this;
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
