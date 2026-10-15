package com.voltpilot.api.ueberwachung;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.List;

/**
 * Wertet eine Bedingung gegen eine {@link WerteLeser.Lesung} aus (Alerting Scheibe 2, Konzept
 * §6.4): rein, ohne Datenbankzugriff, dieselbe Form für jede Leserart. Scheibe 1 kannte nur die
 * Bedingungsart {@code zustand} (Ziel-Übereinstimmung, direkt in {@code UeberwachungsService}
 * verdrahtet); diese Klasse fasst sie zusammen und fügt die freien Schwellen für Zahlenwerte
 * hinzu: {@code ueber}, {@code unter}, {@code ausserhalb}, {@code keine_daten}.
 *
 * <p><b>Zwei Stufen gegen Flattern (§6.4 Nr. 2-4, §9):</b> {@link Erfuellung#ausgeloest} ist die
 * STRENGE Bedingung (die Schwelle selbst) - sie entscheidet, ob eine Regel aus {@code normal} in
 * {@code ausstehend} wechselt und ob die Dauer weiterläuft. {@link Erfuellung#nochAktiv} ist die
 * LOCKERE Bedingung (die Rückkehrschwelle, Hysterese) - sie entscheidet, ob eine bereits
 * ausgelöste Regel {@code aktiv} bleibt bzw. während der Erholdauer wieder zurückfällt. Ohne
 * eigene Rückkehrschwelle (Bedingungsart {@code zustand}, {@code keine_daten}) sind beide
 * Stufen identisch - keine Änderung des Verhaltens von Scheibe 1.
 */
final class BedingungsPruefung {

    record Erfuellung(boolean ausgeloest, boolean nochAktiv) {
        static final Erfuellung NICHTS = new Erfuellung(false, false);

        static Erfuellung beide(boolean wert) {
            return new Erfuellung(wert, wert);
        }
    }

    private BedingungsPruefung() {
    }

    static Erfuellung pruefen(JsonNode bedingung, WerteLeser.Lesung lesung) {
        String art = bedingung.path("art").asText("");
        return switch (art) {
            case "zustand" -> zustand(bedingung, lesung);
            case "keine_daten" -> Erfuellung.beide(!lesung.bekannt());
            case "ueber" -> schwelle(bedingung, lesung, true);
            case "unter" -> schwelle(bedingung, lesung, false);
            case "ausserhalb" -> ausserhalb(bedingung, lesung);
            default -> Erfuellung.NICHTS; // unbekannte Bedingungsart (spätere Scheibe) - überspringen
        };
    }

    private static Erfuellung zustand(JsonNode bedingung, WerteLeser.Lesung lesung) {
        if (!lesung.bekannt()) {
            return Erfuellung.NICHTS; // unbekannt ist keine Null (§6.1 Nr. 4)
        }
        List<String> ziel = textListe(bedingung.path("ziel"));
        return Erfuellung.beide(ziel.contains(lesung.zustandswort()));
    }

    private static Erfuellung schwelle(JsonNode b, WerteLeser.Lesung lesung, boolean ueber) {
        if (!lesung.bekannt() || lesung.zahlenwert() == null) {
            return Erfuellung.NICHTS;
        }
        double wert = lesung.zahlenwert();
        double schwelle = b.path("schwelle").asDouble();
        double rueckkehr = b.has("rueckkehr") ? b.path("rueckkehr").asDouble() : schwelle;
        boolean ausgeloest = ueber ? wert > schwelle : wert < schwelle;
        boolean nochAktiv = ueber ? wert > rueckkehr : wert < rueckkehr;
        return new Erfuellung(ausgeloest, nochAktiv);
    }

    private static Erfuellung ausserhalb(JsonNode b, WerteLeser.Lesung lesung) {
        if (!lesung.bekannt() || lesung.zahlenwert() == null) {
            return Erfuellung.NICHTS;
        }
        double wert = lesung.zahlenwert();
        double unten = b.path("schwelle_unten").asDouble();
        double oben = b.path("schwelle_oben").asDouble();
        double ruUnten = b.has("rueckkehr_unten") ? b.path("rueckkehr_unten").asDouble() : unten;
        double ruOben = b.has("rueckkehr_oben") ? b.path("rueckkehr_oben").asDouble() : oben;
        boolean ausgeloest = wert < unten || wert > oben;
        boolean nochAktiv = wert < ruUnten || wert > ruOben;
        return new Erfuellung(ausgeloest, nochAktiv);
    }

    private static List<String> textListe(JsonNode array) {
        List<String> out = new ArrayList<>();
        if (array.isArray()) {
            array.forEach(n -> out.add(n.asText()));
        }
        return out;
    }
}
