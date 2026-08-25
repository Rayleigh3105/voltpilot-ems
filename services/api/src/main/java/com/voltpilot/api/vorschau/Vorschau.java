package com.voltpilot.api.vorschau;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Die REINEN Regeln der KUNDEN-VORSCHAU (Steuerung Stufe 7, Konzept
 * `vp-steuerung-konzept-b3` §3.5 + §3.8) - Docker-frei geprüft wie
 * {@code Handeingriff}/{@code Vorschlaege}/{@code Tagesprotokoll}.
 *
 * <p>Sie macht aus der ROHEN Antwort des Rechendienstes (zwei Pläne + ihr
 * Delta) die EINE Zahl, die eine Folgen-Karte trägt - und sie tut es mit drei
 * Ehrlichkeitsregeln, die zusammen das Leitprinzip sind:
 *
 * <ol>
 *   <li><b>Ohne beide Läufe keine Zahl.</b> Ein Delta, dessen eine Hälfte
 *       fehlt, ist keine Differenz, sondern eine Behauptung. Dann ist
 *       {@code deltaEur} {@code null} und die Fläche sagt „nicht
 *       abschätzbar" - nie eine 0.</li>
 *   <li><b>Die Zahl ist eine NÄHERUNG, und sie sagt das.</b> Sie rechnet über
 *       den Fahrplan-Horizont, nicht über die Lebensdauer der Regel, und sie
 *       modelliert die Handlung, nicht die Anlage. {@code naeherung} ist
 *       deshalb IMMER wahr - es gibt keinen Zweig, der eine exakte Zahl
 *       behauptet.</li>
 *   <li><b>Unter der Sichtbarkeitsschwelle wird nichts behauptet.</b> Ein
 *       Unterschied von zwei Cent über 24 Stunden liegt innerhalb dessen, was
 *       Prognose und Preisvintage ohnehin bewegen; ihn als Aussage zu
 *       drucken wäre eine Genauigkeit, die die Datenlage nicht hergibt.</li>
 * </ol>
 *
 * <p><b>⚠ Das Vorzeichen ist die AUSSAGE, und es zeigt aus KUNDENSICHT.</b>
 * Der Rechendienst liefert {@code netSavingsEur} (mehr = besser). Die
 * Folgen-Karte fragt aber „was KOSTET mich das?", also ist
 * {@code deltaEur = variante − basis}: negativ = es kostet, positiv = es
 * bringt. Wer das dreht, dreht jede Folgen-Karte des Portals.
 */
public final class Vorschau {

    /**
     * Unter diesem Betrag (EUR über den Horizont) wird KEINE Zahl behauptet.
     * Zwei Cent liegen innerhalb der Prognose-Unschärfe eines Tages.
     */
    public static final BigDecimal SICHTBAR_AB = new BigDecimal("0.02");

    private Vorschau() {
    }

    /**
     * Das Ergebnis, wie die Folgen-Karte es liest.
     *
     * @param deltaEur     variante − basis in EUR (negativ = es kostet);
     *                     {@code null} = nicht abschätzbar.
     * @param basisEur     der Netto-Vorteil des Fahrplans, wie er JETZT gilt.
     * @param varianteEur  derselbe Wert unter der Entscheidung.
     * @param horizonSlots über wie viele Viertelstunden gerechnet wurde.
     * @param naeherung    IMMER wahr - siehe Klassen-Doku.
     * @param grund        warum es keine Zahl gibt; nur gesetzt, wenn
     *                     {@code deltaEur} null ist.
     */
    public record Ergebnis(BigDecimal deltaEur, BigDecimal basisEur, BigDecimal varianteEur,
            Integer horizonSlots, boolean naeherung, String grund) {}

    /** Der Grund, wenn der Rechendienst keine vergleichbaren Zahlen lieferte. */
    public static final String KEINE_ZAHL =
            "Für diesen Zeitraum lässt sich der Unterschied gerade nicht berechnen.";

    /** Der Grund, wenn der Unterschied unter der Sichtbarkeitsschwelle liegt. */
    public static final String KEIN_UNTERSCHIED =
            "Am Ergebnis ändert das im Fahrplan-Zeitraum praktisch nichts.";

    /**
     * Die Vorschau aus der rohen Antwort des Rechendienstes.
     *
     * <p>Gelesen wird ausschliesslich {@code netSavingsEur} - der EHRLICHE
     * Netto-Wert (Ersparnis minus dem Verschleiss, den der Plan dafür
     * ausgibt). {@code savingsEur} allein würde eine Entscheidung belohnen,
     * die den Speicher verschleisst.
     */
    public static Ergebnis ausAntwort(Map<String, Object> antwort) {
        BigDecimal basis = zahl(block(antwort, "baseline"), "netSavingsEur");
        BigDecimal variante = zahl(block(antwort, "variant"), "netSavingsEur");
        Integer slots = ganzzahl(antwort, "horizonSlots");
        if (basis == null || variante == null) {
            return new Ergebnis(null, basis, variante, slots, true, KEINE_ZAHL);
        }
        BigDecimal delta = variante.subtract(basis).setScale(2, RoundingMode.HALF_UP);
        if (delta.abs().compareTo(SICHTBAR_AB) < 0) {
            // ⚠ KEINE Zahl, aber ein ANDERER Grund als „nicht berechenbar": es
            // IST berechnet, und das Ergebnis ist „macht nichts aus". Die zwei
            // zu verwechseln hiesse, eine Auskunft als Fehlen auszugeben.
            return new Ergebnis(null, basis, variante, slots, true, KEIN_UNTERSCHIED);
        }
        return new Ergebnis(delta, basis, variante, slots, true, null);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> block(Map<String, Object> doc, String key) {
        Object v = doc == null ? null : doc.get(key);
        return v instanceof Map ? (Map<String, Object>) v : Map.of();
    }

    private static BigDecimal zahl(Map<String, Object> doc, String key) {
        Object v = doc.get(key);
        if (v instanceof Number n) {
            double d = n.doubleValue();
            return Double.isFinite(d) ? BigDecimal.valueOf(d) : null;
        }
        return null;
    }

    private static Integer ganzzahl(Map<String, Object> doc, String key) {
        Object v = doc == null ? null : doc.get(key);
        return v instanceof Number n ? n.intValue() : null;
    }

    /**
     * Die Knöpfe als Nutzlast des Rechendienstes - NUR die drei, die ein Kunde
     * wirklich treffen kann.
     *
     * <p><b>⚠ Die Admin-Regler (Verschleisskosten, SoC-Band, Netzladen) reisen
     * hier NIE mit</b>, und das ist eine Konstruktions-Aussage, keine
     * Beteuerung: sie stehen gar nicht im Rumpf dieser Route, also lässt sich
     * durch die Vorschau-Tür nichts stellen, was der Kunde sonst nicht darf.
     */
    public static Map<String, Object> knoepfe(Boolean socFloorNow, Integer forcedChargeSlots,
            Integer verbraucherAbSlot, Integer verbraucherSlots, BigDecimal verbraucherKw) {
        Map<String, Object> doc = new LinkedHashMap<>();
        if (Boolean.TRUE.equals(socFloorNow)) {
            doc.put("socFloorNow", true);
        }
        if (forcedChargeSlots != null) {
            doc.put("forcedChargeSlots", forcedChargeSlots);
        }
        if (verbraucherAbSlot != null || verbraucherSlots != null || verbraucherKw != null) {
            Map<String, Object> fenster = new LinkedHashMap<>();
            fenster.put("fromSlot", verbraucherAbSlot);
            fenster.put("slots", verbraucherSlots);
            fenster.put("kw", verbraucherKw);
            doc.put("consumerLoadShift", fenster);
        }
        return doc;
    }
}
