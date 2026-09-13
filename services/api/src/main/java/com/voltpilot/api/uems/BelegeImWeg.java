package com.voltpilot.api.uems;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Die Ablehnung eines Löschwegs, weil Messwerte Belege von Messstellen sind (UEMS AP-07 E8, IP-11).
 * Sie wird geworfen, BEVOR der Weg etwas schreibt, und trägt die Liste, die dem Kunden sagt, was im
 * Weg steht: {@code 409 {code: "messstellen_belege", message, messstellen: [{id, kennzeichen, name}]}}.
 */
public final class BelegeImWeg extends RuntimeException {

    public static final String CODE = "messstellen_belege";

    /** Worum es geht — das Subjekt des Kundensatzes. */
    public enum Gegenstand {
        ANLAGE("Die Messwerte dieser Anlage"),
        BOX("Die Aufzeichnungen dieser Box");

        private final String subjekt;

        Gegenstand(String subjekt) {
            this.subjekt = subjekt;
        }
    }

    private final transient List<MessreihenBelege.Beleg> belege;

    public BelegeImWeg(Gegenstand gegenstand, List<MessreihenBelege.Beleg> belege) {
        super(satz(gegenstand, belege));
        if (belege.isEmpty()) {
            throw new IllegalArgumentException("eine Ablehnung ohne Liste ist eine Sackgasse");
        }
        this.belege = List.copyOf(belege);
    }

    public List<MessreihenBelege.Beleg> belege() {
        return belege;
    }

    /** Der Körper der Antwort. */
    public Map<String, Object> koerper() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", CODE);
        body.put("message", getMessage());
        List<Map<String, Object>> liste = new ArrayList<>();
        for (MessreihenBelege.Beleg b : belege) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", b.id().toString());
            m.put("kennzeichen", b.kennzeichen());
            m.put("name", b.name());
            liste.add(m);
        }
        body.put("messstellen", liste);
        return body;
    }

    /** „… sind Belege von 5 Messstellen und werden nicht gelöscht: MS-01 Netzbezug Halle 1, …" */
    static String satz(Gegenstand gegenstand, List<MessreihenBelege.Beleg> belege) {
        StringBuilder s = new StringBuilder(gegenstand.subjekt).append(" sind Belege von ")
                .append(belege.size()).append(belege.size() == 1 ? " Messstelle" : " Messstellen")
                .append(" und werden nicht gelöscht: ");
        for (int i = 0; i < belege.size(); i++) {
            MessreihenBelege.Beleg b = belege.get(i);
            s.append(i == 0 ? "" : ", ").append(b.kennzeichen()).append(' ').append(b.name());
        }
        return s.append('.').toString();
    }
}
