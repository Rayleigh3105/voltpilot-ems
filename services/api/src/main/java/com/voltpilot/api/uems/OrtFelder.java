package com.voltpilot.api.uems;

import com.voltpilot.api.uems.StandortLesemodell.Adresse;
import com.voltpilot.api.uems.StandortLesemodell.Lage;
import java.math.BigDecimal;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Die FORM der Felder der Ortsstruktur (AP-02 §4.1) — was eine Anfrage an Unternehmen,
 * Standort (IP-4) und Gebäude/Bereich (IP-5) haben muss, bevor irgendeine Regel urteilt.
 * Jeder Verstoß ist 400 {@code anfrage_ungueltig} mit dem Feld und einem Satz, der sagt,
 * was geht.
 *
 * <p>Die Vokabulare sind DIESELBEN wie die CHECKs von V20260911100000 ({@code
 * uems_nutzung_gueltig}, Zeitzone, Land, PLZ je Land); die Datenbank lehnt trotzdem selbst
 * ab. {@code StandortApiTest} hält Nutzung und Zeitzonen gegen die Datenbank fest. Die
 * REGELN (Name unter Geschwistern, Archivieren, Wiederherstellen) sind nicht hier, sondern
 * {@link OrtsbaumAbleitung}.
 */
public final class OrtFelder {

    public static final int NAME_HOECHSTENS = 120;
    public static final int NOTIZ_HOECHSTENS = 500;
    public static final int KURZNAME_HOECHSTENS = 24;
    public static final int RECHTSFORM_HOECHSTENS = 40;
    public static final int BAUJAHR_FRUEHESTENS = 1800;

    /** Die Zeitzonen des DACH-Raums (§4.1); die erste ist die Vorgabe. */
    public static final List<String> ZEITZONEN = List.of("Europe/Berlin", "Europe/Vienna", "Europe/Zurich");

    /** Das Land einer Adresse, mit dem Kundenwort und der Stellenzahl seiner PLZ. */
    private static final Map<String, String> ZU_LAND = Map.of(
            "DE", "zu Deutschland", "AT", "zu Österreich", "CH", "zur Schweiz");
    private static final Map<String, Integer> PLZ_STELLEN = Map.of("DE", 5, "AT", 4, "CH", 4);
    public static final List<String> LAENDER = List.of("DE", "AT", "CH");

    /** E4: die Nutzung — Code = Kundenwort in Kleinbuchstaben, ä→ae, ö→oe, ü→ue, ß→ss. */
    public static final List<String> NUTZUNGEN = List.of("produktion", "montage", "lager", "logistik",
            "buero", "technik", "aussenflaeche", "werkstatt", "labor", "verkauf", "sozialraeume",
            "sonstiges");

    private OrtFelder() {}

    /** Leer (fehlend, leer oder nur Leerzeichen) ist {@code null}; sonst ohne Randleerzeichen. */
    public static String text(String roh) {
        return roh == null || roh.isBlank() ? null : roh.strip();
    }

    /** Der Name (Regel 13): Pflicht, 1–120 Zeichen, ohne Randleerzeichen gespeichert. */
    public static String name(String roh, String feld) {
        String name = text(roh);
        if (name == null) {
            throw OrtAbgelehnt.anfrage(feld, "Bitte geben Sie einen Namen an.");
        }
        if (name.length() > NAME_HOECHSTENS) {
            throw OrtAbgelehnt.anfrage(feld, "Der Name hat höchstens " + NAME_HOECHSTENS + " Zeichen.");
        }
        return name;
    }

    /** Ein freier Text mit Obergrenze; leer ist {@code null}. */
    public static String text(String roh, String feld, int hoechstens, String wort) {
        String t = text(roh);
        if (t != null && t.length() > hoechstens) {
            throw OrtAbgelehnt.anfrage(feld, wort + " hat höchstens " + hoechstens + " Zeichen.");
        }
        return t;
    }

    /** Die Zeitzone aus dem Vokabular; fehlt sie, gilt {@code vorgabe} ({@code null}: Pflicht). */
    public static String zeitzone(String roh, String feld, String vorgabe) {
        String z = text(roh);
        if (z == null && vorgabe != null) {
            return vorgabe;
        }
        if (z == null || !ZEITZONEN.contains(z)) {
            throw OrtAbgelehnt.anfrage(feld, "Die Zeitzone ist Europe/Berlin, Europe/Vienna oder Europe/Zurich.");
        }
        return z;
    }

    /**
     * Eine Adresse in ihrer gespeicherten Form: jedes Feld ohne Randleerzeichen, leer ist
     * {@code null}; das Land aus dem Vokabular; eine PLZ nur mit Land und im Format je Land
     * (§5.10: „Die PLZ 84xxx passt nicht zu Österreich (vierstellig).").
     */
    public static Adresse adresse(Adresse roh, String feld) {
        if (roh == null) {
            return new Adresse(null, null, null, null);
        }
        String land = text(roh.land());
        if (land != null && !LAENDER.contains(land)) {
            throw OrtAbgelehnt.anfrage(feld + ".land",
                    "Das Land ist Deutschland, Österreich oder die Schweiz (DE, AT, CH).");
        }
        String plz = text(roh.plz());
        if (plz != null) {
            if (land == null) {
                throw OrtAbgelehnt.anfrage(feld + ".land", "Zur PLZ fehlt das Land.");
            }
            int stellen = PLZ_STELLEN.get(land);
            if (!plz.matches("[0-9]{" + stellen + "}")) {
                throw OrtAbgelehnt.anfrage(feld + ".plz", "Die PLZ " + plz + " passt nicht "
                        + ZU_LAND.get(land) + " (" + (stellen == 5 ? "fünfstellig" : "vierstellig") + ").");
            }
        }
        return new Adresse(text(roh.strasse()), plz, text(roh.ort()), land);
    }

    /** §4.1: die Adresse ist Pflicht — Straße, Ort und Land ({@link StandortLesemodell#adresseVollstaendig}). */
    public static void adressePflicht(Adresse a, String feld) {
        if (!StandortLesemodell.adresseVollstaendig(a.strasse(), a.ort(), a.land())) {
            throw OrtAbgelehnt.anfrage(feld, "Bitte geben Sie die Adresse an: Straße mit Hausnummer, Ort und Land.");
        }
    }

    /** E4: Codes des Vokabulars, jede höchstens einmal; leer ist {@code null} („nichts gewählt"). */
    public static List<String> nutzung(List<String> roh, String feld) {
        if (roh == null || roh.isEmpty()) {
            return null;
        }
        Set<String> gesehen = new HashSet<>();
        for (int i = 0; i < roh.size(); i++) {
            String n = roh.get(i);
            if (n == null || !NUTZUNGEN.contains(n)) {
                throw OrtAbgelehnt.anfrage(feld + "[" + i + "]", "„" + n + "“ ist keine Nutzung. Erlaubt sind: "
                        + String.join(", ", NUTZUNGEN) + ".");
            }
            if (!gesehen.add(n)) {
                throw OrtAbgelehnt.anfrage(feld + "[" + i + "]", "Jede Nutzung zählt nur einmal — „" + n
                        + "“ steht doppelt.");
            }
        }
        return List.copyOf(roh);
    }

    /** §4.1 Gebäude: das Baujahr, vierstellig, 1800 … laufendes Jahr; fehlend ist {@code null}. */
    public static Integer baujahr(Integer roh, String feld, int laufendesJahr) {
        if (roh != null && (roh < BAUJAHR_FRUEHESTENS || roh > laufendesJahr)) {
            throw OrtAbgelehnt.anfrage(feld, "Das Baujahr liegt zwischen " + BAUJAHR_FRUEHESTENS + " und "
                    + laufendesJahr + ".");
        }
        return roh;
    }

    /** Die Lage auf der Karte: beide Koordinaten oder keine, in ihrem Wertebereich. */
    public static Lage lage(Lage roh, String feld) {
        if (roh == null || (roh.breitengrad() == null && roh.laengengrad() == null)) {
            return null;
        }
        if (roh.breitengrad() == null || roh.laengengrad() == null) {
            throw OrtAbgelehnt.anfrage(feld, "Die Lage braucht Breiten- und Längengrad.");
        }
        if (roh.breitengrad().abs().compareTo(BigDecimal.valueOf(90)) > 0) {
            throw OrtAbgelehnt.anfrage(feld + ".breitengrad", "Der Breitengrad liegt zwischen -90 und 90.");
        }
        if (roh.laengengrad().abs().compareTo(BigDecimal.valueOf(180)) > 0) {
            throw OrtAbgelehnt.anfrage(feld + ".laengengrad", "Der Längengrad liegt zwischen -180 und 180.");
        }
        return roh;
    }
}
