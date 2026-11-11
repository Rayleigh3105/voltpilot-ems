package com.voltpilot.api.ueberwachung;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
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
 * {@code anlagenfluss} und {@code messreihe} hinzu; Scheibe 4 fügt {@code menge} und {@code geld}
 * hinzu (periodisch ausgewertet, §6.3/§6.7 - nie im Minutentakt). Scheibe 5 fügt {@code kennzahl}
 * (Kennzahl gegen ihre Bezugsbasis, Energieziel-Kurs) und {@code zaehlung} (Messstelle: Menge je
 * Monat, Beobachtung, "Monat unvollständig") additiv hinzu - beide eigene, isolierte Leser, damit
 * keine bestehende, ab Werk gesäte Wertart (Entscheid 9A) berührt wird.
 *
 * <p>UEMS EZ-11 (Konzept vp-erzeuger-wago-konzept §4.8, EW-9 A) fügt die Leserart {@code erzeuger} hinzu: die
 * Messpunkte der Familie {@code voltpilot.erzeuger_registerbild_v1} einer Anlagensteuerung, ausgewertet zu fünf
 * Zuständen ({@link ErzeugerWerteLeser}). Ihre Einträge tragen statt eines Vorschlags ab Werk eine
 * {@link Vorlage}: nie gesät, je Anlage wählbar, die Wertart ist die stabile Kennung der Vorlage.
 *
 * <p>„Ein Ort fürs Laden" Scheibe 4 (E6 = A) fügt die Leserart {@code ladepunkt} hinzu
 * ({@link LadepunktWerteLeser}): Verbindung, Stecker- und Ladeziel-Zustand der Ladepunkte einer Anlage - zwei
 * Einträge mit {@link Vorschlag} ab Werk, zwei mit {@link Vorlage} wählbar.
 */
@Component
public class WerteKatalog {

    /** Die Leserarten, die der Code heute kennt (Scheibe 1: zustand, ereignis; Scheibe 2: anlagenfluss,
     * messreihe; Scheibe 4: menge, geld; Scheibe 5: kennzahl, zaehlung; EZ-11: erzeuger; Ein Ort fürs Laden
     * Scheibe 4: ladepunkt). */
    static final List<String> LESERARTEN = List.of("zustand", "ereignis", "anlagenfluss", "messreihe", "menge", "geld",
            "kennzahl", "zaehlung", "erzeuger", "ladepunkt");

    /** Wie ein Eintrag seinen Wert liest (§6.3): Scheibe 1 nutzt {@code feld} ODER {@code arten}+{@code bezugsfeld}. */
    public record LeserVerweis(String art, String feld, List<String> arten, String bezugsfeld) {}

    /** Die Vorgabe eines Vorschlags ab Werk (§6.4 Nr. 2/3, §9) - nur bei einem seedbaren Eintrag gesetzt. */
    public record Vorschlag(int dauerS, int erholenS, String schwere, List<String> ziel) {}

    /**
     * Eine Alarm-Vorlage (EZ-11): die Vorbelegung, mit der das Blatt „Überwachen“ und der Anlege-Schritt (EZ-15)
     * eine Überwachung dieser Wertart anbieten - Dauer, Erholdauer, Schwere, Ziel-Zustand und die eigenen
     * Schwellen der Vorlage ({@code schwellen}, Name → Vorgabe). Anders als ein {@link Vorschlag} wird sie NIE
     * gesät; {@code nurMitAnlagensteuerung} heißt: nur an einer Anlage mit Anlagensteuerung wählbar.
     */
    public record Vorlage(int dauerS, int erholenS, String schwere, List<String> ziel, Map<String, Double> schwellen,
            boolean nurMitAnlagensteuerung) {}

    /** Ein Eintrag des Katalogs: Wertart + Bezug + wie er gelesen wird (§6.3). */
    public record Eintrag(String wertart, String name, String satzname, String bezug, String form,
            LeserVerweis leser, String recht, List<String> zustaende, List<String> bedingungen,
            Vorschlag vorschlag, Vorlage vorlage) {}

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
        return Collections.unmodifiableMap(ergebnis); // Reihenfolge des Katalogs (Map.copyOf verlöre sie)
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
                textListe(n, "bedingungen"), vorschlag, vorlage(n.path("vorlage")));
    }

    private static Vorlage vorlage(JsonNode v) {
        if (v.isMissingNode()) {
            return null;
        }
        Map<String, Double> schwellen = new LinkedHashMap<>();
        v.path("schwellen").fields().forEachRemaining(f -> schwellen.put(f.getKey(), f.getValue().asDouble()));
        return new Vorlage(v.path("dauer_s").asInt(), v.path("erholen_s").asInt(300), text(v, "schwere"),
                textListe(v, "ziel"), Collections.unmodifiableMap(schwellen),
                v.path("nur_mit_anlagensteuerung").asBoolean(false));
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

    /** Der Eintrag einer Wertart, oder {@code null}, wenn der Katalog sie nicht kennt oder sie fehlt. */
    public Eintrag eintrag(String wertart) {
        return wertart == null ? null : eintraege.get(wertart);
    }

    /** Alle Einträge, in der Reihenfolge des Katalogs. */
    public List<Eintrag> alle() {
        return List.copyOf(eintraege.values());
    }

    /** Die Alarm-Vorlagen (EZ-11), in der Reihenfolge des Katalogs - die Wertart ist ihre stabile Kennung. */
    public List<Eintrag> vorlagen() {
        return alle().stream().filter(e -> e.vorlage() != null).toList();
    }

    /** Die Einträge mit einem Vorschlag ab Werk (§6.4 Nr. 2) - die Aussaat-Grundlage des Läufers. */
    public List<Eintrag> mitVorschlagAbWerk() {
        return alle().stream().filter(e -> e.vorschlag() != null).toList();
    }
}
