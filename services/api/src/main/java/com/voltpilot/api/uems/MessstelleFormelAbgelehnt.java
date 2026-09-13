package com.voltpilot.api.uems;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Eine Ablehnung der Formel-Schnittstelle (UEMS AP-10): Code, HTTP-Status, deutscher Satz und die
 * Fakten des Urteils. Getrennt von {@link MessstelleAbgelehnt}, damit der Messstellen-Vertrag und
 * seine Fehlertabelle unberührt bleiben (die Formel ist ein additiver Vertrag).
 */
public final class MessstelleFormelAbgelehnt extends RuntimeException {

    private final String code;
    private final int status;
    private final transient Map<String, Object> fakten;

    private MessstelleFormelAbgelehnt(String code, int status, String satz, Map<String, Object> fakten) {
        super(satz);
        this.code = code;
        this.status = status;
        this.fakten = Collections.unmodifiableMap(new LinkedHashMap<>(fakten));
    }

    /** Ein Urteil von {@link MessstelleFormelRegeln}: Code und Status sind die des Vertrags. */
    public static MessstelleFormelAbgelehnt regel(MessstelleFormelRegeln.Fehler fehler, String satz,
            Map<String, Object> fakten) {
        return new MessstelleFormelAbgelehnt(fehler.code(), fehler.status(), satz, fakten);
    }

    /** Ein Urteil über die Tage einer Fassung (AP-10 IP-3): Code und Status aus {@link MessstelleFormelRegeln.FassungFehler}. */
    public static MessstelleFormelAbgelehnt fassung(MessstelleFormelRegeln.FassungFehler fehler, String satz,
            Map<String, Object> fakten) {
        return new MessstelleFormelAbgelehnt(fehler.code(), fehler.status(), satz, fakten);
    }

    /**
     * Ein Term, dessen Anteil nicht gelesen werden kann (AP-10 IP-5): Code, Status und Kundensatz aus
     * {@link AnteilLeseweg.Ablehnung} — dem Block {@code leseweg} des Verteilungs-Vertrags. Die Fakten
     * nennen das Feld des Terms und, wenn die Ablehnung auf ein Paket wartet, dieses Paket.
     */
    public static MessstelleFormelAbgelehnt leseweg(AnteilLeseweg.Ablehnung ablehnung, String termFeld) {
        Map<String, Object> fakten = new LinkedHashMap<>();
        fakten.put("feld", termFeld + "." + ablehnung.feld());
        if (ablehnung.wartetAuf() != null) {
            fakten.put("wartet_auf", ablehnung.wartetAuf());
        }
        return new MessstelleFormelAbgelehnt(ablehnung.code(), ablehnung.status(), ablehnung.satz(), fakten);
    }

    /** Ein Feld fehlt, hat die falsche Form oder ist nicht auflösbar (400). */
    public static MessstelleFormelAbgelehnt anfrage(String feld, String satz) {
        return new MessstelleFormelAbgelehnt("anfrage_ungueltig", 400, satz, Map.of("feld", feld));
    }

    public String code() {
        return code;
    }

    public int status() {
        return status;
    }

    /** Die Fakten des Urteils (snake_case wie der Vertrag), ohne Code und Satz. */
    public Map<String, Object> fakten() {
        return fakten;
    }
}
