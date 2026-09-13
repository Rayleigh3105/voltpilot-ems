package com.voltpilot.api.uems;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Eine Ablehnung der Bilanz-Routen (AP-10 IP-9) mit Code, Status und Kundensatz. Die Codes sind
 * {@code anfrage_ungueltig} (400) und {@link BilanzAbleitung#REST_OHNE_HAUPTZAEHLER} (422, aus
 * {@code fehler_neu} des Bilanz-Vertrags). Eine Ablehnung schreibt nichts.
 */
public final class BilanzAbgelehnt extends RuntimeException {

    public static final String ANFRAGE_UNGUELTIG = "anfrage_ungueltig";

    /** Die Codes in der Reihenfolge der OpenAPI ({@code BilanzFehler.code}). */
    public static final java.util.List<String> CODES =
            java.util.List.of(ANFRAGE_UNGUELTIG, BilanzAbleitung.REST_OHNE_HAUPTZAEHLER);

    private final String code;
    private final int status;
    private final transient Map<String, Object> fakten;

    private BilanzAbgelehnt(String code, int status, String satz, Map<String, Object> fakten) {
        super(satz);
        this.code = code;
        this.status = status;
        this.fakten = Collections.unmodifiableMap(new LinkedHashMap<>(fakten));
    }

    /** Ein Feld fehlt oder hat die falsche Form (400). */
    public static BilanzAbgelehnt anfrage(String feld, String satz) {
        return new BilanzAbgelehnt(ANFRAGE_UNGUELTIG, 400, satz, Map.of("feld", feld));
    }

    /** Der genannte Hauptzähler ist heute kein Hauptzähler Bezug dieser Anlage (422). */
    public static BilanzAbgelehnt ohneHauptzaehler(String kennzeichen) {
        return new BilanzAbgelehnt(BilanzAbleitung.REST_OHNE_HAUPTZAEHLER, 422, kennzeichen
                + " ist heute kein Hauptzähler Bezug dieser Anlage — ein Rest gehört zu einem Hauptzähler.",
                Map.of("hauptzaehler", kennzeichen));
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
