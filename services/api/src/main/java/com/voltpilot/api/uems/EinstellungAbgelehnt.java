package com.voltpilot.api.uems;

import com.voltpilot.api.uems.QuelleEinstellungRegeln.Fehler;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Eine Ablehnung der Einstellungs-Schnittstelle ({@code POST /api/v1/geraete/{id}/einstellungen}):
 * Code, HTTP-Status, deutscher Satz und die Fakten des Urteils. Nichts ist geschrieben, wenn sie
 * fliegt — auch kein Protokolleintrag.
 *
 * <p>Zwei Quellen für den Code, sauber getrennt: {@link #regel} — ein Code des Vertrags
 * ({@link QuelleEinstellungRegeln.Fehler}, der Status kommt von dort) — und {@link Schnittstelle}:
 * was die Form der Anfrage oder den gespeicherten Zustand betrifft.
 */
public final class EinstellungAbgelehnt extends RuntimeException {

    /** Die Codes der Schnittstelle neben denen des Vertrags. Geschlossen. */
    public enum Schnittstelle {
        /** Ein Feld fehlt, hat die falsche Form oder gibt es an dieser Route nicht. */
        ANFRAGE_UNGUELTIG("anfrage_ungueltig", 400),
        /** Die Komponente wird von diesem Einbau nie gespeist — sie ist keine Quelle an ihm. */
        KEINE_SPEISUNG("keine_speisung", 422);

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

    /** Alle Codes, die die Schnittstelle je antwortet: die des Vertrags, dann ihre eigenen. */
    public static final List<String> CODES = codes();

    private final String code;
    private final int status;
    private final Map<String, Object> fakten;

    private EinstellungAbgelehnt(String code, int status, String satz, Map<String, Object> fakten) {
        super(satz);
        this.code = code;
        this.status = status;
        this.fakten = Collections.unmodifiableMap(new LinkedHashMap<>(fakten));
    }

    /** Ein Urteil von {@link QuelleEinstellungRegeln}: Code und Status sind die des Vertrags. */
    public static EinstellungAbgelehnt regel(Fehler fehler, String satz, Map<String, Object> fakten) {
        return new EinstellungAbgelehnt(fehler.code(), fehler.status(), satz, fakten);
    }

    public static EinstellungAbgelehnt schnittstelle(Schnittstelle s, String satz, Map<String, Object> fakten) {
        return new EinstellungAbgelehnt(s.code(), s.status(), satz, fakten);
    }

    /** {@code anfrage_ungueltig} mit dem Weg zum Feld. */
    public static EinstellungAbgelehnt anfrage(String feld, String satz) {
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("feld", feld);
        return schnittstelle(Schnittstelle.ANFRAGE_UNGUELTIG, satz, f);
    }

    public String code() {
        return code;
    }

    public int status() {
        return status;
    }

    /** Die Fakten des Urteils (snake_case), ohne Code und Satz. */
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
