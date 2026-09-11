package com.voltpilot.api.uems;

import com.voltpilot.api.uems.MessstelleRegeln.Fehler;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Eine Ablehnung der Messstellen-Schnittstelle: Code, HTTP-Status, deutscher Satz und die
 * Fakten des Urteils. Nichts ist geschrieben, wenn sie fliegt.
 *
 * <p>Zwei Quellen für den Code, sauber getrennt:
 * <ul>
 *   <li>{@link #regel}: ein Code des Messstellen-Vertrags ({@link MessstelleRegeln.Fehler}) —
 *       der Status kommt von dort, nie von hier.</li>
 *   <li>{@link Schnittstelle}: was der Regel-Vertrag nicht regelt, weil es die Form der Anfrage
 *       oder den gespeicherten Zustand betrifft (Vertrag §10: „Endpunkte … (IP-3)“) — dazu die
 *       Tages-Mechanik der Zuordnungen, deren Gründe der Ortsbaum-Vertrag nennt (IP-7).</li>
 * </ul>
 */
public final class MessstelleAbgelehnt extends RuntimeException {

    /** Die Codes der Schnittstelle neben denen des Regel-Vertrags. Geschlossen. */
    public enum Schnittstelle {
        /** Ein Feld fehlt, hat die falsche Form oder gibt es an dieser Route nicht. */
        ANFRAGE_UNGUELTIG("anfrage_ungueltig", 400),
        /** Der Übergang passt nicht zum gespeicherten Zustand (archiviert, schon/nicht angehalten). */
        ZUSTAND_PASST_NICHT("zustand_passt_nicht", 409),
        /** Anhalten, Fortsetzen und Archivieren gelten ab jetzt oder rückwirkend. */
        ZEITPUNKT_IN_ZUKUNFT("zeitpunkt_in_zukunft", 422),
        /**
         * Eine Zuordnung (Ort, Stellung) belegt den Tag schon — an ihm beginnt bereits eine
         * (Ortsbaum-Grund {@code gleicher_tag}); der Weg ist die Korrektur, nie eine zweite.
         */
        ZUORDNUNG_UEBERLAPPT("zuordnung_ueberlappt", 409),
        /**
         * Das „gültig ab“ passt nicht zu den Intervallen der Messstelle — vor dem ersten, kein
         * Beginn an dem Tag (Korrektur); {@code grund} ist das Wort des Ortsbaum-Vertrags
         * ({@code OrtsbaumAbleitung.EintragGrund}).
         */
        ZUORDNUNG_UNGUELTIG("zuordnung_ungueltig", 422),
        /**
         * Die Messstelle ist an dem Tag schon genau so zugeordnet — es gäbe nichts zu ändern
         * (Grund {@code ziel_ist_bisheriger_eltern}; AP-02 §5.10: 400 wie „dieselbe Fläche“).
         */
        ZUORDNUNG_UNVERAENDERT("zuordnung_unveraendert", 400);

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

    /** Alle Codes, die die Schnittstelle je antwortet: die des Regel-Vertrags, dann ihre eigenen. */
    public static final List<String> CODES = codes();

    private final String code;
    private final int status;
    private final Map<String, Object> fakten;

    private MessstelleAbgelehnt(String code, int status, String satz, Map<String, Object> fakten) {
        super(satz);
        this.code = code;
        this.status = status;
        this.fakten = Collections.unmodifiableMap(new LinkedHashMap<>(fakten));
    }

    /** Ein Urteil von {@link MessstelleRegeln}: Code und Status sind die des Vertrags. */
    public static MessstelleAbgelehnt regel(Fehler fehler, String satz, Map<String, Object> fakten) {
        return new MessstelleAbgelehnt(fehler.code(), fehler.status(), satz, fakten);
    }

    public static MessstelleAbgelehnt schnittstelle(Schnittstelle s, String satz, Map<String, Object> fakten) {
        return new MessstelleAbgelehnt(s.code(), s.status(), satz, fakten);
    }

    public static MessstelleAbgelehnt anfrage(String feld, String satz) {
        return schnittstelle(Schnittstelle.ANFRAGE_UNGUELTIG, satz, Map.of("feld", feld));
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
