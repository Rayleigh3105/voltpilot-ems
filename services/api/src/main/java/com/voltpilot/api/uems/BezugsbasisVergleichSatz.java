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

    /** S5: „Stand Nr. n vom TT.MM.JJJJ“ für den jüngsten Stand, sonst {@link #UNGESICHERT}. */
    static String stand(java.util.List<com.voltpilot.api.web.dto.BezugsbasisVergleichDto.Stand> staende) {
        if (staende.isEmpty()) {
            return UNGESICHERT;
        }
        var s = staende.get(0);
        return "Stand Nr. " + s.nummer() + " vom "
                + s.am().format(java.time.format.DateTimeFormatter.ofPattern("dd.MM.yyyy"));
    }
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

    /**
     * Wie viele Monate des Zeitraums eine geltende Fassung haben (P4 je Monat) und was der Satz über die übrigen sagt:
     * {@code ab} (Monat) mit {@code wieder} = „gilt wieder ab“ nach einem Ende, sonst „gilt erst ab“; {@code endete} (Tag)
     * = „endete am“. Ohne beides nennt der Satz nur die Zahl der Monate ohne Fassung (eine Lücke zwischen Monaten mit
     * Fassung).
     */
    public record Geltung(int mitFassung, String ab, boolean wieder, LocalDate endete) {

        /** Jeder der {@code soll} Monate hat eine Fassung. */
        public static Geltung voll(int soll) {
            return new Geltung(soll, null, false, null);
        }
    }

    /** Der Zeitraum-Satz (U5, §10 „Zeitraum“), jeder Monat mit geltender Fassung. */
    public static String zeitraum(Map<String, Object> e, String von, String bis, String einheit, int soll) {
        return zeitraum(e, von, bis, einheit, soll, Geltung.voll(soll));
    }

    /**
     * Der Zeitraum-Satz (U5, §10 „Zeitraum“) mit P4 je Monat: nur {@code g.mitFassung()} der {@code soll} Monate haben
     * eine geltende Fassung, die übrigen zählen nicht mit. Dann sagt der Satz vorn, wie viele Monate bewertbar sind und
     * warum die übrigen nicht: „6 von 12 Monaten bewertbar, die Bezugsbasis gilt erst ab April 2026.“ · „3 von 6 Monaten
     * bewertbar, die Bezugsbasis endete am 31.12.2025.“
     */
    public static String zeitraum(Map<String, Object> e, String von, String bis, String einheit, int soll, Geltung g) {
        String kopf = von + " bis " + bis + ": ";
        String urteil = (String) e.get("urteil");
        String geltung = geltung(g);
        if ("nicht_anwendbar".equals(urteil)) {
            return kopf + "nicht bewertbar — kein Monat mit Vergleich."
                    + (geltung == null ? "" : " " + Character.toUpperCase(geltung.charAt(0)) + geltung.substring(1)
                            + ".");
        }
        int x = Integer.parseInt(((String) e.get("monate")).split(" ", 2)[0]);
        int mitFassung = g.mitFassung();
        if (mitFassung < soll) {
            int ohne = soll - mitFassung;
            kopf += x + " von " + soll + " Monaten bewertbar, " + (geltung != null ? geltung
                    : "in " + ohne + (ohne == 1 ? " Monat" : " Monaten") + " gilt keine Fassung der Bezugsbasis") + ". ";
        }
        String d = prozent((String) e.get("delta_prozent"));
        String richtung = "mehr".equals(e.get("richtung")) ? "mehr" : "weniger";
        String zahlen = kopf + menge((String) e.get("gemessen")) + " " + einheit + " gemessen, "
                + menge((String) e.get("erwartet")) + " " + einheit + " erwartet — ";
        String summe = "(Summe über " + (x < ZAHLWORT.size() ? ZAHLWORT.get(x) : x + " Monate") + ")";
        String satz = switch (urteil) {
            case "im_rahmen" -> zahlen + d + " %: im Rahmen der Bezugsbasis " + summe + ".";
            case "besser", "schlechter" -> zahlen + d + " % " + richtung + ": " + urteil + " " + summe + ".";
            // G2 (IP-13): hat jeder Monat mit Fassung einen Vergleich, fehlt das Urteil, weil ein Wert unvollständig ist.
            default -> x == mitFassung
                    ? zahlen + d + " % " + richtung + "; ohne Urteil, die Werte sind unvollständig."
                    : zahlen + d + " % " + richtung + "; ohne Urteil: " + x + " von " + mitFassung
                            + " Monaten mit Vergleich.";
        };
        return satz + vorlaeufig(e);
    }

    /**
     * „die Bezugsbasis gilt erst ab April 2026“ · „… gilt wieder ab März 2027“ · „… endete am 31.12.2025“, beides in der
     * Folge der Zeit verbunden (ohne Monat mit Fassung liegt das Ende vor dem neuen Beginn); ohne beides {@code null}.
     */
    private static String geltung(Geltung g) {
        String ab = g.ab() == null ? null : "gilt " + (g.wieder() ? "wieder" : "erst") + " ab " + g.ab();
        String endete = g.endete() == null ? null : "endete am " + g.endete().format(TAG);
        if (ab == null && endete == null) {
            return null;
        }
        if (ab == null || endete == null) {
            return "die Bezugsbasis " + (ab == null ? endete : ab);
        }
        return "die Bezugsbasis " + (g.mitFassung() == 0 ? endete + " und " + ab : ab + " und " + endete);
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
