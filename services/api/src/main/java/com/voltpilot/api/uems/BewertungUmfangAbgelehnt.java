package com.voltpilot.api.uems;

/** Stabile Ablehnungen des Betrachtungsumfangs. */
public final class BewertungUmfangAbgelehnt extends RuntimeException {
    private final int status;
    private final String code;
    public BewertungUmfangAbgelehnt(int status, String code, String satz) {
        super(satz); this.status = status; this.code = code;
    }
    public int status() { return status; }
    public String code() { return code; }
    public static BewertungUmfangAbgelehnt fehlt() {
        return new BewertungUmfangAbgelehnt(404, "nicht_gefunden", "Der Betrachtungsumfang wurde nicht gefunden.");
    }
    public static BewertungUmfangAbgelehnt anfrage() {
        return new BewertungUmfangAbgelehnt(400, "anfrage_ungueltig", "Bitte prüfen Sie die Angaben Ihrer Anfrage.");
    }
}
