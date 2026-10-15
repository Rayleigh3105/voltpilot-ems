package com.voltpilot.api.ueberwachung;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

/**
 * Der Werte-Katalog der Überwachung (Alerting Scheibe 1, Konzept vp-alerting-konzept-m1 §6.3): die
 * EINE Stelle, an der eine Wertart ihre Adresse, ihr Recht und ihren Leser nennt - "ONE truth" wie
 * {@code ConsumerSignalCatalog} und der Flow-Katalog (§2.6). Eine neue Wertart derselben Leserart
 * ist ein weiterer Eintrag in {@code wertekatalog/katalog.json}, kein neuer Code; eine neue
 * Leserart ist die einzige Stelle, die Code braucht (§6.3 Nr. 3) - und muss hier als bekannt
 * eingetragen sein ({@link #LESERARTEN}), sonst startet die API nicht (dasselbe Muster wie der
 * Flow-Katalog, der jede {@code leser.art} beim Start prüft).
 *
 * <p>Scheibe 1 kannte nur die Leserarten {@code zustand} und {@code ereignis}; Scheibe 2 fügt
 * {@code anlagenfluss} und {@code messreihe} hinzu. Die übrigen vier (menge, kennzahl, geld,
 * zaehlung, §6.3) kommen mit ihrer eigenen Scheibe und erweitern {@link #LESERARTEN} additiv.
 */
@Component
public class WerteKatalog {

    /** Die Leserarten, die der Code heute kennt (Scheibe 1: zustand, ereignis; Scheibe 2: anlagenfluss, messreihe). */
    static final List<String> LESERARTEN = List.of("zustand", "ereignis", "anlagenfluss", "messreihe");

    /** Wie ein Eintrag seinen Wert liest (§6.3): Scheibe 1 nutzt {@code feld} ODER {@code arten}+{@code bezugsfeld}. */
    public record LeserVerweis(String art, String feld, List<String> arten, String bezugsfeld) {}

    /** Die Vorgabe eines Vorschlags ab Werk (§6.4 Nr. 2/3, §9) - nur bei einem seedbaren Eintrag gesetzt. */
    public record Vorschlag(int dauerS, int erholenS, String schwere, List<String> ziel) {}

    /** Ein Eintrag des Katalogs: Wertart + Bezug + wie er gelesen wird (§6.3). */
    public record Eintrag(String wertart, String name, String satzname, String bezug, String form,
            LeserVerweis leser, String recht, List<String> zustaende, List<String> bedingungen,
            Vorschlag vorschlag) {}

    private final Map<String, Eintrag> eintraege;

    public WerteKatalog() {
        this("wertekatalog/katalog.json");
    }

    WerteKatalog(String resource) {
        this.eintraege = laden(resource);
    }

    private static Map<String, Eintrag> laden(String resource) {
        ObjectMapper json = new ObjectMapper();
        JsonNode wurzel;
        try (InputStream in = new ClassPathResource(resource).getInputStream()) {
            wurzel = json.readTree(in);
        } catch (IOException e) {
            throw new IllegalStateException("Werte-Katalog " + resource + " nicht lesbar", e);
        }
        Map<String, Eintrag> ergebnis = new LinkedHashMap<>();
        for (JsonNode n : wurzel.path("eintraege")) {
            Eintrag e = eintrag(n);
            if (!LESERARTEN.contains(e.leser().art())) {
                throw new IllegalStateException("Werte-Katalog: unbekannte Leserart '" + e.leser().art()
                        + "' bei Wertart '" + e.wertart() + "' - LESERARTEN erweitern, wenn ihre Scheibe kommt");
            }
            if (ergebnis.put(e.wertart(), e) != null) {
                throw new IllegalStateException("Werte-Katalog: Wertart '" + e.wertart() + "' doppelt");
            }
        }
        return Map.copyOf(ergebnis);
    }

    private static Eintrag eintrag(JsonNode n) {
        JsonNode l = n.path("leser");
        LeserVerweis leser = new LeserVerweis(
                text(l, "art"), text(l, "feld"), textListe(l, "arten"), text(l, "bezugsfeld"));
        JsonNode v = n.path("vorschlag");
        Vorschlag vorschlag = v.isMissingNode() ? null
                : new Vorschlag(v.path("dauer_s").asInt(), v.path("erholen_s").asInt(300),
                        text(v, "schwere"), textListe(v, "ziel"));
        return new Eintrag(text(n, "wertart"), text(n, "name"), text(n, "satzname"), text(n, "bezug"),
                text(n, "form"), leser, text(n, "recht"), textListe(n, "zustaende"),
                textListe(n, "bedingungen"), vorschlag);
    }

    private static String text(JsonNode n, String feld) {
        JsonNode v = n.path(feld);
        return v.isMissingNode() || v.isNull() ? null : v.asText();
    }

    private static List<String> textListe(JsonNode n, String feld) {
        JsonNode v = n.path(feld);
        if (!v.isArray()) {
            return List.of();
        }
        List<String> out = new ArrayList<>();
        v.forEach(x -> out.add(x.asText()));
        return List.copyOf(out);
    }

    /** Der Eintrag einer Wertart, oder {@code null}, wenn der Katalog sie nicht kennt. */
    public Eintrag eintrag(String wertart) {
        return eintraege.get(wertart);
    }

    /** Alle Einträge, in der Reihenfolge des Katalogs. */
    public List<Eintrag> alle() {
        return List.copyOf(eintraege.values());
    }

    /** Die Einträge mit einem Vorschlag ab Werk (§6.4 Nr. 2) - die Aussaat-Grundlage des Läufers. */
    public List<Eintrag> mitVorschlagAbWerk() {
        return alle().stream().filter(e -> e.vorschlag() != null).toList();
    }
}
