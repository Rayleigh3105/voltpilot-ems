package com.voltpilot.api.uems;

/** Stabile Ablehnungen von Kriterien-Fassungen. */
public final class BewertungKriterienAbgelehnt extends RuntimeException {
    private final int status;
    private final String code;
    public BewertungKriterienAbgelehnt(int status, String code, String text) {
        super(text); this.status = status; this.code = code;
    }
    public int status() { return status; }
    public String code() { return code; }
    public static BewertungKriterienAbgelehnt fehlt() {
        return new BewertungKriterienAbgelehnt(404,"nicht_gefunden","Die Kriterien-Fassung wurde nicht gefunden.");
    }
    public static BewertungKriterienAbgelehnt anfrage() {
        return new BewertungKriterienAbgelehnt(400,"anfrage_ungueltig","Bitte prüfen Sie die Angaben Ihrer Anfrage.");
    }
}
