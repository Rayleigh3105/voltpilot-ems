package com.voltpilot.api.uems;

import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;

/**
 * Die Kundensätze des Vergleichs (UEMS AP-17 IP-19, {@code bezugsbasis.md} §10 und §16): aus dem Ergebnis der Operation
 * {@code vergleich} bzw. {@code zeitraum} — rein, nichts wird hier gerechnet außer der Anzeige-Rundung (M5, ganze
 * Einheiten, Prozent eine Stelle). Wörter nach SP1 und den IP-4-Konstanten im Portal ({@code glossar.ts}:
 * {@code UEMS_BEZUGSBASIS}, {@code UEMS_ERWARTET}, {@code UEMS_BEZUGSBASIS_URTEILE}); U6: kein Satz nennt eine Ursache.
 */
public final class BezugsbasisVergleichSatz {

    private BezugsbasisVergleichSatz() {}

    static final String UNGESICHERT = "ungesichert — noch kein Stand";
    static final String LEER = "Noch keine Bezugsbasis. Legen Sie fest, gegen welchen Zeitraum diese Kennzahl verglichen "
            + "werden soll — der Vergleich entsteht aus den gespeicherten Werten.";
    /** Die Urteil-Wörter (glossar.ts {@code UEMS_BEZUGSBASIS_URTEILE}); {@code ohne_urteil} hat kein Wort. */
    static final Map<String, String> URTEIL_WORT = Map.of("besser", "besser", "schlechter", "schlechter", "im_rahmen",
            "im Rahmen", "nicht_anwendbar", "nicht bewertbar");
    private static final List<String> ZAHLWORT = List.of("", "einen Monat", "zwei Monate", "drei Monate", "vier Monate",
            "fünf Monate", "sechs Monate", "sieben Monate", "acht Monate", "neun Monate", "zehn Monate", "elf Monate",
            "zwölf Monate");
    private static final DateTimeFormatter TAG = DateTimeFormatter.ofPattern("dd.MM.yyyy");

    /** Die erste Variable der Bedingung, wie der Satz sie nennt; {@code von}/{@code bis} die Spannweite der Fassung. */
    public record Variable(String name, String wert, String einheit, String von, String bis) {}

    /**
     * Was ein Monatssatz braucht, das nicht im Ergebnis steht. {@code variable} ist die Variable, die der Satz nennt (bei
     * {@code variable_fehlt}/{@code variable_ausserhalb} die betroffene, IP-13); {@code hinweis} ein zweiter Satz zum
     * Grund (§5.8 „Koordinaten fehlen“).
     */
    public record Monat(String beschriftung, String einheit, Variable variable, String basis, LocalDate beendetZum,
            String beendetGrund, Integer folgeFassung, LocalDate folgeAb, String hinweis) {

        public Monat(String beschriftung, String einheit, Variable variable, String basis, LocalDate beendetZum,
                String beendetGrund, Integer folgeFassung, LocalDate folgeAb) {
            this(beschriftung, einheit, variable, basis, beendetZum, beendetGrund, folgeFassung, folgeAb, null);
        }
    }

    /** Ganze Einheiten, kaufmännisch (M5), Tausender mit Leerzeichen, Dezimalkomma. */
    static String menge(String wert) {
        return BezugsbasisRegeln.de(BezugsbasisRegeln.runden(wert, 0));
    }

    /** Eine Größe, wie gespeichert (ohne Nullen am Ende). */
    static String zahl(String wert) {
        return BezugsbasisRegeln.de(new java.math.BigDecimal(wert).stripTrailingZeros().toPlainString());
    }

    /** Prozent ohne Vorzeichen, eine Stelle („12,9“). */
    static String prozent(String delta) {
        return BezugsbasisRegeln.de(delta.startsWith("-") ? delta.substring(1) : delta);
    }

    /** Das Band ohne Null am Ende („± 2 %“, „± 4,6 %“). */
    static String band(String band) {
        return zahl(band);
    }

    public static String monat(Map<String, Object> e, Monat m) {
        String urteil = (String) e.get("urteil");
        String grund = (String) e.get("grund");
        String kopf = m.beschriftung() + ": ";
        if ("nicht_anwendbar".equals(urteil)) {
            return switch (grund) {
                case "basis_fehlt" -> m.basis() == null ? LEER
                        : kopf + "nicht bewertbar — für diesen Monat gilt noch keine Fassung der Bezugsbasis "
                                + m.basis() + ".";
                case "basis_beendet" -> "Nicht bewertbar: Bezugsbasis beendet am "
                        + (m.beendetZum() == null ? "" : m.beendetZum().format(TAG))
                        + (m.beendetGrund() == null ? "" : " (" + m.beendetGrund() + ")") + "."
                        + (m.folgeFassung() == null ? "" : " Fassung " + m.folgeFassung() + " gilt seit "
                                + m.folgeAb().format(TAG) + ".");
                case "variable_ausserhalb" -> "Modell nicht anwendbar: " + m.variable().name() + " im "
                        + m.beschriftung() + " (" + zahl(m.variable().wert()) + " " + m.variable().einheit()
                        + ") liegt außerhalb der Bezugsbasis (" + zahl(m.variable().von()) + "–"
                        + zahl(m.variable().bis()) + " " + m.variable().einheit() + ").";
                case "variable_fehlt" -> kopf + "nicht bewertbar — " + m.variable().name() + " hat keinen Wert."
                        + (m.hinweis() == null ? "" : " " + m.hinweis());
                case "periode_nicht_zu_ende" -> kopf + "nicht bewertbar — der Monat ist noch nicht zu Ende.";
                default -> kopf + "nicht bewertbar — kein gemessener Wert.";
            };
        }
        String richtung = "mehr".equals(e.get("richtung")) ? "mehr" : "weniger";
        String d = prozent((String) e.get("delta_prozent"));
        String zahlen = kopf + menge((String) e.get("gemessen")) + " " + m.einheit() + " gemessen, "
                + menge((String) e.get("erwartet")) + " " + m.einheit() + " erwartet bei "
                + zahl(m.variable().wert()) + " " + m.variable().einheit() + " — ";
        String satz = switch (urteil) {
            case "schlechter" -> zahlen + d + " % mehr als die Bezugsbasis erwarten lässt: schlechter.";
            case "besser" -> zahlen + d + " % weniger: besser.";
            case "im_rahmen" -> zahlen + d + " % " + richtung + ": im Rahmen (± " + band((String) e.get("band_prozent"))
                    + " %).";
            default -> zahlen + d + " % " + richtung + "; ohne Urteil, die Werte sind unvollständig.";
        };
        return satz + vorlaeufig(e);
    }

    /** Der Zeitraum-Satz (U5, §10 „Zeitraum“). */
    public static String zeitraum(Map<String, Object> e, String von, String bis, String einheit, int soll) {
        String kopf = von + " bis " + bis + ": ";
        String urteil = (String) e.get("urteil");
        if ("nicht_anwendbar".equals(urteil)) {
            return kopf + "nicht bewertbar — kein Monat mit Vergleich.";
        }
        String d = prozent((String) e.get("delta_prozent"));
        String richtung = "mehr".equals(e.get("richtung")) ? "mehr" : "weniger";
        String zahlen = kopf + menge((String) e.get("gemessen")) + " " + einheit + " gemessen, "
                + menge((String) e.get("erwartet")) + " " + einheit + " erwartet — ";
        String summe = "(Summe über " + (soll < ZAHLWORT.size() ? ZAHLWORT.get(soll) : soll + " Monate") + ")";
        String satz = switch (urteil) {
            case "im_rahmen" -> zahlen + d + " %: im Rahmen der Bezugsbasis " + summe + ".";
            case "besser", "schlechter" -> zahlen + d + " % " + richtung + ": " + urteil + " " + summe + ".";
            // G2 (IP-13): hat jeder Monat einen Vergleich, fehlt das Urteil, weil ein Wert unvollständig ist.
            default -> (soll + " von " + soll).equals(e.get("monate"))
                    ? zahlen + d + " % " + richtung + "; ohne Urteil, die Werte sind unvollständig."
                    : zahlen + d + " % " + richtung + "; ohne Urteil: " + e.get("monate") + " Monaten mit Vergleich.";
        };
        return satz + vorlaeufig(e);
    }

    /** P2: eine vorläufige Fassung nennt es im Satz, nicht nur im Kennzeichen. */
    private static String vorlaeufig(Map<String, Object> e) {
        @SuppressWarnings("unchecked")
        List<String> kennzeichen = (List<String>) e.get("kennzeichen");
        return kennzeichen == null ? "" : kennzeichen.stream().filter(k -> k.startsWith("Bezugsbasis vorläufig (")).findFirst()
                .map(k -> " Die Bezugsbasis ist vorläufig " + k.substring("Bezugsbasis vorläufig ".length()) + ".")
                .orElse("");
    }
}
