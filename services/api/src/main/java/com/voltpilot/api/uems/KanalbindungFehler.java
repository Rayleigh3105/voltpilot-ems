package com.voltpilot.api.uems;

/** Benannte Ablehnung der Kanalbindung (AP-09 K1–K6). */
public class KanalbindungFehler extends RuntimeException {
    private final String code;
    private final int status;
    public KanalbindungFehler(int status, String code, String satz) {
        super(satz); this.status = status; this.code = code;
    }
    public String code() { return code; }
    public int status() { return status; }
}
