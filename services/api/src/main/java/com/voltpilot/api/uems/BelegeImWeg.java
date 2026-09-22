package com.voltpilot.api.uems;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Die Ablehnung eines Löschwegs, weil etwas, das er wegnähme, ein Beleg ist: Messwerte von Messstellen (UEMS
 * AP-07 E8, IP-11) oder Messstellen, die freigegebene Berichtsstände zitieren (AP-12 E13 S2, IP-12). Sie wird
 * geworfen, BEVOR der Weg etwas schreibt, und trägt die Listen, die dem Kunden sagen, was im Weg steht:
 * {@code 409 {code, codes, message, messstellen: [{id, kennzeichen, name}], berichtsstaende: [{kennung, nr}]}}.
 *
 * <ul>
 *   <li><b>Anlage, Box</b>: {@code messstellen} = die Messstellen, deren Messwerte dort hängen
 *       ({@code messstellen_belege}); {@code berichtsstaende} = die freigegebenen Stände, die diese Messstellen
 *       zitieren ({@code berichts_belege}) — beide Listen in DERSELBEN Antwort. {@code code} bleibt
 *       {@code messstellen_belege}: ein Stand zitiert nur Messstellen, an diesen Wegen gibt es also keinen
 *       Berichts-Beleg ohne Messstellen-Beleg.</li>
 *   <li><b>Komponente</b>: {@code code = berichts_belege}; {@code messstellen} = die zitierten Messstellen, deren
 *       Quelle sie war — die Stellen, an denen der Kunde die Bindung beendet.</li>
 * </ul>
 *
 * <p>{@code codes} nennt jeden Grund in fester Reihenfolge ({@code messstellen_belege}, {@code berichts_belege});
 * {@code code} ist der erste.
 */
public final class BelegeImWeg extends RuntimeException {

    public static final String CODE = "messstellen_belege";
    public static final String CODE_BERICHTE = BerichtRegeln.BERICHTS_BELEGE;

    /** Worum es geht — das Subjekt des Kundensatzes. */
    public enum Gegenstand {
        ANLAGE("Die Messwerte dieser Anlage"),
        BOX("Die Aufzeichnungen dieser Box"),
        /** Der Satz kommt aus dem Berichts-Vertrag ({@link BerichtRegeln#berichtsBelege}). */
        KOMPONENTE("Diese Komponente"),
        ENERGIEEINSATZ("Dieser Energieeinsatz"),
        MESSBEDARF("Dieser Messbedarf"),
        MESSMITTEL("Diese Messmittel-Angabe");

        private final String subjekt;

        Gegenstand(String subjekt) {
            this.subjekt = subjekt;
        }
    }

    private final transient Gegenstand gegenstand;
    private final transient List<MessreihenBelege.Beleg> belege;
    private final transient List<BerichtRegeln.StandBezeichnung> staende;

    /** Nur Messstellen-Belege (AP-07 IP-11). */
    public BelegeImWeg(Gegenstand gegenstand, List<MessreihenBelege.Beleg> belege) {
        this(gegenstand, belege, List.of());
    }

    public BelegeImWeg(Gegenstand gegenstand, List<MessreihenBelege.Beleg> belege,
            List<BerichtRegeln.StandBezeichnung> staende) {
        super(satz(gegenstand, belege, staende));
        if (codes(gegenstand, belege, staende).isEmpty()) {
            throw new IllegalArgumentException("eine Ablehnung ohne Liste ist eine Sackgasse");
        }
        this.gegenstand = gegenstand;
        this.belege = List.copyOf(belege);
        this.staende = List.copyOf(staende);
    }

    public List<MessreihenBelege.Beleg> belege() {
        return belege;
    }

    public List<BerichtRegeln.StandBezeichnung> staende() {
        return staende;
    }

    public List<String> codes() {
        return codes(gegenstand, belege, staende);
    }

    /** Der Körper der Antwort. */
    public Map<String, Object> koerper() {
        List<String> codes = codes();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", codes.get(0));
        body.put("codes", codes);
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
        List<Map<String, Object>> zitiert = new ArrayList<>();
        for (BerichtRegeln.StandBezeichnung s : staende) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("kennung", s.kennung());
            m.put("nr", s.nr());
            zitiert.add(m);
        }
        body.put("berichtsstaende", zitiert);
        return body;
    }

    static List<String> codes(Gegenstand gegenstand, List<MessreihenBelege.Beleg> belege,
            List<BerichtRegeln.StandBezeichnung> staende) {
        List<String> codes = new ArrayList<>(2);
        if ((gegenstand == Gegenstand.ANLAGE || gegenstand == Gegenstand.BOX) && !belege.isEmpty()) {
            codes.add(CODE);
        }
        if (!staende.isEmpty()) {
            codes.add(CODE_BERICHTE);
        }
        return List.copyOf(codes);
    }

    /**
     * Anlage und Box: „… sind Belege von 5 Messstellen und werden nicht gelöscht: MS-01 Netzbezug Halle 1, …“,
     * zitieren freigegebene Stände diese Messstellen, dahinter „Freigegebene Berichtsstände, die sie zitieren:
     * BR-2026-0001 Nr. 1, …“. Die Komponente spricht den Satz des Berichts-Vertrags.
     */
    static String satz(Gegenstand gegenstand, List<MessreihenBelege.Beleg> belege,
            List<BerichtRegeln.StandBezeichnung> staende) {
        if (gegenstand != Gegenstand.ANLAGE && gegenstand != Gegenstand.BOX) {
            String satz = BerichtRegeln.berichtsBelege(staende);
            return gegenstand == Gegenstand.KOMPONENTE ? satz
                    : satz.replaceFirst("Diese Komponente", gegenstand.subjekt);
        }
        StringBuilder s = new StringBuilder();
        if (!belege.isEmpty()) {
            s.append(gegenstand.subjekt).append(" sind Belege von ")
                    .append(belege.size()).append(belege.size() == 1 ? " Messstelle" : " Messstellen")
                    .append(" und werden nicht gelöscht: ");
            for (int i = 0; i < belege.size(); i++) {
                MessreihenBelege.Beleg b = belege.get(i);
                s.append(i == 0 ? "" : ", ").append(b.kennzeichen()).append(' ').append(b.name());
            }
            s.append('.');
        }
        if (!staende.isEmpty()) {
            if (s.isEmpty()) {
                s.append(gegenstand.subjekt).append(" sind Belege freigegebener Berichtsstände und werden nicht gelöscht: ");
            } else {
                s.append(staende.size() == 1 ? " Freigegebener Berichtsstand, der sie zitiert: "
                        : " Freigegebene Berichtsstände, die sie zitieren: ");
            }
            s.append(BerichtRegeln.standBezeichnungen(staende)).append('.');
        }
        return s.toString();
    }
}
