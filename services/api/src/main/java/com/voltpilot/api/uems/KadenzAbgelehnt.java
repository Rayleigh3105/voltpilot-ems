package com.voltpilot.api.uems;

import com.voltpilot.api.uems.KadenzRegeln.Fehler;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Eine Ablehnung der Kadenz-Schnittstelle
 * ({@code POST /api/v1/messstellen/{id}/quellen/{qid}/kadenz}): Code, HTTP-Status, deutscher Satz
 * und die Fakten des Urteils. Nichts ist geschrieben, wenn sie fliegt — auch kein Protokolleintrag.
 *
 * <p>Zwei Quellen für den Code, sauber getrennt: {@link #regel} — ein Code der Regeln
 * ({@link KadenzRegeln.Fehler}, der Status kommt von dort) — und {@link Schnittstelle}: was die
 * Form der Anfrage betrifft.
 */
public final class KadenzAbgelehnt extends RuntimeException {

    /** Die Codes der Schnittstelle neben denen der Regeln. Geschlossen. */
    public enum Schnittstelle {
        /** Ein Feld fehlt, hat die falsche Form oder gibt es an dieser Route nicht. */
        ANFRAGE_UNGUELTIG("anfrage_ungueltig", 400);

        private final String code;
        private final int status;

        Schnittstelle(String code, int status) {
            this.code = code;
            this.status = status;
        }

        public String code() {
            return code;
        }

        public int status() {
            return status;
        }
    }

    /** Alle Codes, die die Schnittstelle je antwortet: die der Regeln, dann ihre eigenen. */
    public static final List<String> CODES = codes();

    private final String code;
    private final int status;
    private final Map<String, Object> fakten;

    private KadenzAbgelehnt(String code, int status, String satz, Map<String, Object> fakten) {
        super(satz);
        this.code = code;
        this.status = status;
        this.fakten = Collections.unmodifiableMap(new LinkedHashMap<>(fakten));
    }

    public static KadenzAbgelehnt regel(Fehler fehler, String satz, Map<String, Object> fakten) {
        return new KadenzAbgelehnt(fehler.code(), fehler.status(), satz, fakten);
    }

    public static KadenzAbgelehnt anfrage(String feld, String satz) {
        return new KadenzAbgelehnt(Schnittstelle.ANFRAGE_UNGUELTIG.code(),
                Schnittstelle.ANFRAGE_UNGUELTIG.status(), satz, Map.of("feld", feld));
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

    private static List<String> codes() {
        List<String> alle = new ArrayList<>();
        for (Fehler f : Fehler.values()) {
            alle.add(f.code());
        }
        for (Schnittstelle s : Schnittstelle.values()) {
            alle.add(s.code());
        }
        return List.copyOf(alle);
    }
}
