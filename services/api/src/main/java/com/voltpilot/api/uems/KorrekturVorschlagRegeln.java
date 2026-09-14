package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.math.BigDecimal;
import java.text.NumberFormat;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;

/**
 * Was das System an einem KORREKTUR-VORSCHLAG selbst sagt (UEMS AP-08 IP-14, Entscheid E14 = A vom
 * 11.09.2026) — rein, ohne Datenbank: die vorbelegte Begründung, die Vorschau alt/neu je Periode und die
 * Doppelvorschlag-Sperre über den fachlichen Schlüssel.
 *
 * <p><b>Nie automatisch.</b> Nichts hier entscheidet, ob eine Korrektur gilt. Die Begründung sagt, was das
 * System GESEHEN hat („Nachgeliefert nach Ablauf der Frist: 210 Messwerte …“), nie, was der Mensch tun soll;
 * die Vorschau zeigt, was die vorhandene Rechenregel ergäbe, und ändert keine Zahl. Auch eine Vorschau, die
 * nur Lücken füllt (alt „keine Werte“), bleibt ein Vorschlag: für den Kunden ist eine Zahl, die vorher keine
 * war, eine Änderung.
 *
 * <p>Vertrag: {@code docs/contracts/v2/korrektur-vorschlag-vectors.json} — jedes Muster und jeder Satz
 * ({@code KorrekturVorschlagRegelnTest}); {@code copy.test.ts} liest dieselben Sätze gegen das
 * Kunden-Wörterbuch. Die Uhrzeit spricht {@link ErgebnisZustand#uhr} (E10).
 */
public final class KorrekturVorschlagRegeln {

    /** Die drei Arten, aus denen das System vorschlägt — dieselben Wörter wie im Vokabular (IP-12). */
    public static final String NACHLIEFERUNG = "nachlieferung_nach_endgueltigkeit";
    public static final String ABLESESTAENDE = "ablesestaende_nachgetragen";
    public static final String UMKLASSIFIZIERUNG = "umklassifizierung";

    /** Die Richtung einer Umklassifizierung (E4: Rücksetzung ↔ Überlauf). */
    public static final String ALS_UEBERLAUF = "als_ueberlauf";
    public static final String ALS_RUECKSETZUNG = "als_ruecksetzung";

    /** Warum kein Vorschlag entstand — geschlossen, dieselbe Liste wie {@code ablehnungen} im Vertrag. */
    public static final String OHNE_AENDERUNG = "ohne_aenderung";
    public static final String LIEGT_SCHON_VOR = "liegt_schon_vor";
    public static final String SCHON_ENTSCHIEDEN = "schon_entschieden";
    public static final String REIHE_UNBEKANNT = "reihe_unbekannt";
    public static final String RICHTUNG_UNBEKANNT = "richtung_unbekannt";
    public static final String WERTEBEREICH_FEHLT = "wertebereich_fehlt";
    public static final List<String> ABLEHNUNGEN = List.of(OHNE_AENDERUNG, LIEGT_SCHON_VOR, SCHON_ENTSCHIEDEN,
            REIHE_UNBEKANNT, RICHTUNG_UNBEKANNT, WERTEBEREICH_FEHLT);

    /** Die Muster der vorbelegten Begründung, Schlüssel wie im Vertrag. */
    public static final Map<String, String> BEGRUENDUNG;

    static {
        Map<String, String> m = new LinkedHashMap<>();
        m.put(NACHLIEFERUNG, "Nachgeliefert nach Ablauf der Frist: {anzahl} für {zeitraum}, zuletzt eingegangen am "
                + "{eingang}; endgültig seit {frist}.");
        m.put(ABLESESTAENDE, "Ablesestände nach Ablauf der Frist eingetragen: Gerätegrenze {zeitpunkt}, eingetragen am "
                + "{eingang}; endgültig seit {frist}.");
        m.put(UMKLASSIFIZIERUNG + "_" + ALS_UEBERLAUF, "Der fallende Stand am {zeitpunkt} ist bisher eine Rücksetzung; "
                + "auf Wunsch rechnet die Vorschau ihn als Überlauf (Wertebereich {modul}).");
        m.put(UMKLASSIFIZIERUNG + "_" + ALS_RUECKSETZUNG, "Der fallende Stand am {zeitpunkt} ist bisher ein Überlauf; "
                + "auf Wunsch rechnet die Vorschau ihn als Rücksetzung.");
        BEGRUENDUNG = Map.copyOf(m);
    }

    /** Was an der Zeile der Erkennung steht ({@code erledigt_notiz}), wenn der Lauf sie schließt. */
    public static final String NOTIZ_ERLEDIGT = "Aufgenommen in den Korrektur-Vorschlag {kennung}.";
    public static final String NOTIZ_VERWORFEN = "Die nachgelieferten Messwerte ändern keinen Wert der Viertelstunde.";

    /** Die einzige Periode, die IP-14 vorschaut; Tag, Monat und Jahr bildet die Kaskade (IP-17). */
    public static final String VIERTELSTUNDE = "viertelstunde";

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final DateTimeFormatter DATUM = DateTimeFormatter.ofPattern("dd.MM.yyyy", Locale.ROOT);
    private static final String KEINE_WERTE = ErgebnisZustand.KEINE_WERTE;

    private KorrekturVorschlagRegeln() {}

    // ------------------------------------------------------------------------------ Die Begründung

    /** F10: „Nachgeliefert nach Ablauf der Frist: 210 Messwerte für 03.11.2026 14:00 bis 17:45, …“. */
    public static String nachlieferung(Instant von, Instant bis, int anzahl, Instant eingang, Instant frist,
            ZoneId zone) {
        return sprich(NACHLIEFERUNG, Map.of("anzahl", anzahl(anzahl), "zeitraum", zeitraum(von, bis, zone),
                "eingang", zeitpunkt(eingang, zone), "frist", zeitpunkt(frist, zone)));
    }

    /** F12: „Ablesestände nach Ablauf der Frist eingetragen: Gerätegrenze 15.01.2027 09:12, …“. */
    public static String ablesestaende(Instant zeitpunkt, Instant eingang, Instant frist, ZoneId zone) {
        return sprich(ABLESESTAENDE, Map.of("zeitpunkt", zeitpunkt(zeitpunkt, zone), "eingang", zeitpunkt(eingang, zone),
                "frist", zeitpunkt(frist, zone)));
    }

    /** E4: die angefragte Umklassifizierung eines fallenden Stands; {@code modul} nur {@link #ALS_UEBERLAUF}. */
    public static String umklassifizierung(String richtung, Instant zeitpunkt, BigDecimal modul, ZoneId zone) {
        if (ALS_UEBERLAUF.equals(richtung)) {
            return sprich(UMKLASSIFIZIERUNG + "_" + ALS_UEBERLAUF, Map.of("zeitpunkt", zeitpunkt(zeitpunkt, zone),
                    "modul", modul.stripTrailingZeros().toPlainString()));
        }
        if (ALS_RUECKSETZUNG.equals(richtung)) {
            return sprich(UMKLASSIFIZIERUNG + "_" + ALS_RUECKSETZUNG, Map.of("zeitpunkt", zeitpunkt(zeitpunkt, zone)));
        }
        throw new IllegalArgumentException("unbekannte Richtung " + richtung);
    }

    /** „Aufgenommen in den Korrektur-Vorschlag K-2026-0007.“ */
    public static String notizErledigt(String kennung) {
        return NOTIZ_ERLEDIGT.replace("{kennung}", kennung);
    }

    /** „15.01.2027 09:12“ — Datum und Wanduhr des Standorts, an der doppelten Stunde mit MESZ/MEZ. */
    static String zeitpunkt(Instant t, ZoneId zone) {
        return DATUM.format(LocalDate.ofInstant(t, zone)) + " " + ErgebnisZustand.uhr(t, zone);
    }

    /** [von, bis): „03.11.2026 14:00 bis 17:45“, an einem anderen Ortstag „… bis 04.11.2026 01:00“. */
    static String zeitraum(Instant von, Instant bis, ZoneId zone) {
        boolean selberTag = LocalDate.ofInstant(von, zone).equals(LocalDate.ofInstant(bis, zone));
        return zeitpunkt(von, zone) + " bis " + (selberTag ? ErgebnisZustand.uhr(bis, zone) : zeitpunkt(bis, zone));
    }

    /** „1 Messwert“, „210 Messwerte“, „1.440 Messwerte“ (E11: Tausenderpunkt). */
    static String anzahl(int n) {
        return NumberFormat.getIntegerInstance(Locale.GERMANY).format(n) + (n == 1 ? " Messwert" : " Messwerte");
    }

    private static String sprich(String schluessel, Map<String, String> werte) {
        String text = BEGRUENDUNG.get(schluessel);
        for (Map.Entry<String, String> w : werte.entrySet()) {
            text = text.replace("{" + w.getKey() + "}", w.getValue());
        }
        return text;
    }

    // ------------------------------------------------------------------------------- Die Vorschau

    /**
     * Ein Stand einer Viertelstunde, wie die Vorschau ihn zeigt. {@code version} {@code null} heißt: es steht
     * keine Zeile da (alt) bzw. die Version vergibt erst die Freigabe (neu).
     */
    public record Stand(Integer version, BigDecimal menge, String mengeZustand, List<String> kennzeichen,
            Integer erhalten, Integer erwartet, Integer abdeckungProzent, BigDecimal mittel, BigDecimal energie) {

        public Stand {
            kennzeichen = kennzeichen == null ? List.of() : List.copyOf(kennzeichen);
        }

        /** Keine Zeile: „keine Werte“, keine Zahl — nie 0. */
        public static Stand keineWerte() {
            return new Stand(null, null, KEINE_WERTE, List.of(), null, null, null, null, null);
        }

        /**
         * Dieselbe Aussage — ohne die Version, die nur sagt, WO der Stand steht. Darum zählt auch das Kennzeichen
         * „korrigiert (Version n)“ nicht (AP-08 IP-17): „alt“ einer korrigierten Viertelstunde trägt es, „neu“ aus der
         * Verdichtung nie — dieselben Zahlen sind keine Änderung.
         */
        public boolean gleich(Stand o) {
            return zahlGleich(menge, o.menge) && Objects.equals(mengeZustand, o.mengeZustand)
                    && ohneVersion(kennzeichen).equals(ohneVersion(o.kennzeichen))
                    && Objects.equals(erhalten, o.erhalten) && Objects.equals(erwartet, o.erwartet)
                    && Objects.equals(abdeckungProzent, o.abdeckungProzent) && zahlGleich(mittel, o.mittel)
                    && zahlGleich(energie, o.energie);
        }

        ObjectNode json() {
            ObjectNode n = JSON.createObjectNode();
            if (version == null) {
                n.putNull("version");
            } else {
                n.put("version", version);
            }
            n.put("menge", text(menge));
            n.put("menge_zustand", mengeZustand);
            ArrayNode k = n.putArray("kennzeichen");
            kennzeichen.forEach(k::add);
            ganz(n, "erhalten", erhalten);
            ganz(n, "erwartet", erwartet);
            ganz(n, "abdeckung_prozent", abdeckungProzent);
            n.put("mittel", text(mittel));
            n.put("energie", text(energie));
            return n;
        }

        private static List<String> ohneVersion(List<String> saetze) {
            return saetze.stream().filter(k -> !ErgebnisZustand.istKorrigiert(k)).toList();
        }

        private static boolean zahlGleich(BigDecimal a, BigDecimal b) {
            return a == null ? b == null : b != null && a.compareTo(b) == 0;
        }

        private static String text(BigDecimal x) {
            return x == null ? null : x.toPlainString();
        }

        private static void ganz(ObjectNode n, String feld, Integer wert) {
            if (wert == null) {
                n.putNull(feld);
            } else {
                n.put(feld, wert);
            }
        }
    }

    /** Eine Periode der Vorschau: die Viertelstunde ab {@code von}, alt und neu. */
    public record Periode(Instant von, Stand alt, Stand neu) {

        public boolean aendert() {
            return !alt.gleich(neu);
        }

        ObjectNode json() {
            ObjectNode n = JSON.createObjectNode();
            n.put("periode", VIERTELSTUNDE);
            n.put("von", von.toString());
            n.put("bis", ViertelstundeRegeln.ende(von).toString());
            n.put("aendert", aendert());
            n.set("alt", alt.json());
            n.set("neu", neu.json());
            return n;
        }
    }

    /** Die Vorschau als JSON-Array ({@code messreihe_korrektur.vorschau}), älteste Viertelstunde zuerst. */
    public static ArrayNode vorschau(List<Periode> perioden) {
        ArrayNode a = JSON.createArrayNode();
        perioden.stream().sorted(Comparator.comparing(Periode::von)).forEach(p -> a.add(p.json()));
        return a;
    }

    /** Ändert der Vorschlag überhaupt etwas? Ohne Änderung entsteht keiner — er wäre eine erfundene Tatsache. */
    public static boolean aendertEtwas(List<Periode> perioden) {
        return perioden.stream().anyMatch(Periode::aendert);
    }

    // -------------------------------------------------------------------------------- Die Sperre

    /** Ein vorhandener Vorschlag derselben Art an derselben Reihe (Fassung 1 + sein Status heute). */
    public record Bestehend(String kennung, Instant von, Instant bis, String status, JsonNode vorschau) {}

    /** Warum ein Vorschlag gesperrt ist, und durch welchen. */
    public record Sperre(String grund, String kennung) {}

    /**
     * Die Doppelvorschlag-Sperre über den FACHLICHEN Schlüssel (Kundenbereich + Art + Reihe + Zeitraum) — nie
     * über einen Zeitstempel. Der Aufrufer reicht nur Vorschläge derselben Art an derselben Reihe desselben
     * Kundenbereichs herein.
     *
     * <ul>
     *   <li>{@link #LIEGT_SCHON_VOR}: einer überschneidet den Zeitraum und ist noch nicht entschieden — zwei
     *       offene Vorschläge für dieselbe Viertelstunde könnten nie beide freigegeben werden;</li>
     *   <li>{@link #SCHON_ENTSCHIEDEN}: einer über GENAU diesen Zeitraum schlug schon dieselben neuen Werte vor —
     *       ein Mensch hat darüber entschieden, der Stundenlauf fragt nicht jede Stunde noch einmal.</li>
     * </ul>
     *
     * @return {@code null}, wenn der Vorschlag entstehen darf
     */
    public static Sperre sperre(List<Bestehend> bestehende, Instant von, Instant bis, JsonNode vorschau) {
        for (Bestehend b : bestehende) {
            if (EreignisVokabular.KORREKTUR_STATUS.get(0).equals(b.status()) && b.von().isBefore(bis)
                    && von.isBefore(b.bis())) {
                return new Sperre(LIEGT_SCHON_VOR, b.kennung());
            }
        }
        for (Bestehend b : bestehende) {
            if (b.von().equals(von) && b.bis().equals(bis) && neueWerte(b.vorschau()).equals(neueWerte(vorschau))) {
                return new Sperre(SCHON_ENTSCHIEDEN, b.kennung());
            }
        }
        return null;
    }

    private static List<JsonNode> neueWerte(JsonNode vorschau) {
        List<JsonNode> aus = new ArrayList<>();
        for (JsonNode p : vorschau) {
            ObjectNode n = JSON.createObjectNode();
            n.set("von", p.path("von"));
            n.set("neu", p.path("neu"));
            aus.add(n);
        }
        return aus;
    }

    // ----------------------------------------------------------------------------- Die Zeiträume

    /** Aufeinanderfolgende Viertelstunden als EIN Zeitraum — F10: 15 Viertelstunden, eine Korrektur. */
    public static List<List<Instant>> zusammenhaengend(List<Instant> beginne) {
        List<List<Instant>> aus = new ArrayList<>();
        List<Instant> laufend = null;
        for (Instant b : beginne.stream().sorted().distinct().toList()) {
            if (laufend == null || !ViertelstundeRegeln.ende(laufend.get(laufend.size() - 1)).equals(b)) {
                laufend = new ArrayList<>();
                aus.add(laufend);
            }
            laufend.add(b);
        }
        return aus.stream().map(List::copyOf).toList();
    }

    /**
     * Die Viertelstunden, deren Menge ein Bruch zum Zeitpunkt {@code t} berührt — dieselbe Auswahl wie
     * {@code BruchEreignisse}: die Viertelstunde, in der er liegt, und liegt er genau auf der Grenze, die davor
     * (die Regel wendet ihn in {@code (von, bis]} an).
     */
    public static List<Instant> viertelstundenUm(Instant t) {
        long s = t.getEpochSecond();
        Instant boden = Instant.ofEpochSecond(Math.floorDiv(s, 900) * 900);
        Instant davor = Instant.ofEpochSecond(-Math.floorDiv(-s, 900) * 900 - 900);
        return boden.equals(davor) ? List.of(boden) : List.of(davor, boden);
    }
}
