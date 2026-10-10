package com.voltpilot.api.uems;

/** Stabile Ablehnungen der Messmittel-Angaben (AP-16 IP-15): Status, Code, Feld und Kundensatz. */
public final class MessmittelAbgelehnt extends RuntimeException {
    private final int status;
    private final String code;
    private final String feld;

    public MessmittelAbgelehnt(int status, String code, String feld, String text) {
        super(text);
        this.status = status;
        this.code = code;
        this.feld = feld;
    }

    public int status() { return status; }
    public String code() { return code; }
    public String feld() { return feld; }

    public static MessmittelAbgelehnt fehlt() {
        return new MessmittelAbgelehnt(404, "nicht_gefunden", "", "Gerät nicht gefunden.");
    }

    public static MessmittelAbgelehnt anfrage(String feld, String text) {
        return new MessmittelAbgelehnt(400, "anfrage_ungueltig", feld, text);
    }

    public static MessmittelAbgelehnt angabe(String code, String feld, String text) {
        return new MessmittelAbgelehnt(422, code, feld, text);
    }
}
