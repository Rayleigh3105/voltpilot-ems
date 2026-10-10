package com.voltpilot.api.uems;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Eine abgelehnte Anfrage an das Energiemanagement (UEMS AP-19): Status, Code, ein Satz und die Fakten, die der Kunde
 * zum Verstehen braucht — Muster {@link VerbesserungAbgelehnt}.
 */
public class EnergiemanagementAbgelehnt extends RuntimeException {

    private final int status;
    private final String code;
    private final Map<String, Object> fakten;

    public EnergiemanagementAbgelehnt(int status, String code, String satz, Map<String, Object> fakten) {
        super(satz);
        this.status = status;
        this.code = code;
        this.fakten = fakten == null ? Map.of() : new LinkedHashMap<>(fakten);
    }

    public static EnergiemanagementAbgelehnt anfrage(String feld) {
        return new EnergiemanagementAbgelehnt(400, "anfrage_ungueltig", "Die Anfrage ist so nicht lesbar.",
                Map.of("feld", feld));
    }

    public static EnergiemanagementAbgelehnt personFehlt() {
        return new EnergiemanagementAbgelehnt(404, "nicht_gefunden", "Diese Person gibt es nicht.", null);
    }

    public static EnergiemanagementAbgelehnt zuordnungFehlt() {
        return new EnergiemanagementAbgelehnt(404, "nicht_gefunden", "Diese Zuordnung gibt es nicht.", null);
    }

    public static EnergiemanagementAbgelehnt dokumentFehlt() {
        return new EnergiemanagementAbgelehnt(404, "nicht_gefunden", "Dieses Dokument gibt es nicht.", null);
    }

    public static EnergiemanagementAbgelehnt fassungFehlt() {
        return new EnergiemanagementAbgelehnt(404, "nicht_gefunden", "Diese Fassung gibt es nicht.", null);
    }

    static EnergiemanagementAbgelehnt fachlich(String code, String satz, Map<String, Object> fakten) {
        return new EnergiemanagementAbgelehnt(422, code, satz, fakten);
    }

    static EnergiemanagementAbgelehnt konflikt(String code, String satz, Map<String, Object> fakten) {
        return new EnergiemanagementAbgelehnt(409, code, satz, fakten);
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
