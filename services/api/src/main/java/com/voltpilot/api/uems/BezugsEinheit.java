package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;

/**
 * Die EINHEITEN der Bezugsdaten als eigenes, reines Modul (UEMS AP-09 §4.4 U1–U5, IP-3).
 *
 * <p>Der Vertrag steht in {@code docs/contracts/v2/bezugsdaten-vectors.json} (Familie
 * {@code einheit}); der TS-Zwilling ist {@code frontend/portal/src/bezugsEinheit.ts}. Wer eine
 * Regel ändert, ändert die Vektor-Datei UND beide Zwillinge.
 *
 * <p><b>Warum ein eigenes Modul:</b> Import, Eingabe, Kennzahlen und Berichte brauchen dieselbe
 * Umrechnung. Sie steht deshalb EINMAL hier; {@link BezugsdatenRegeln} ruft sie auf, statt sie
 * ein zweites Mal zu führen.
 *
 * <p><b>Die Umrechnungsgrenze (E4, U1):</b> das Vokabular ist geschlossen und gilt <b>je
 * Größe</b>; gerechnet wird <b>nur innerhalb derselben Größe</b> und nur mit einem <b>festen</b>
 * Faktor aus dem Vertrag (t ↔ kg, l ↔ m³, min ↔ h). Ein vom Kunden eingegebener Faktor ist
 * ausgeschlossen: „48 Stück je Palette“ ist eine Annahme, und eine Annahme, die im Wert
 * verschwindet, ist später nicht mehr von einer Messung zu unterscheiden. Ein Wort außerhalb des
 * Vokabulars ist {@link #EINHEIT_UNBEKANNT} — nie ein geratener Faktor (U2, §7 B13).
 *
 * <p><b>Exakt, nicht gerundet:</b> jeder Betrag reist als Dezimaltext und wird als
 * {@link BigDecimal} gerechnet — 312,4 t sind genau 312 400 kg, nicht 312 399,999…
 *
 * <p><b>Rein:</b> ohne Spring, ohne Datenbank, ohne Netz und ohne Uhr.
 */
public final class BezugsEinheit {

    private BezugsEinheit() {}

    /** U2: das gelieferte Wort steht nicht im Vokabular der Ziel-Größe — die Zeile wird abgelehnt. */
    public static final String EINHEIT_UNBEKANNT = "einheit_unbekannt";

    /** U1: der Betrag wurde mit dem festen Faktor des Vertrags in die Einheit der Bezugsgröße gebracht. */
    public static final String EINHEIT_UMGERECHNET = "einheit_umgerechnet";

    /** U5: diese Einheiten nehmen keine Nachkommastellen an — „Stück sind ganze Zahlen“. */
    public static final List<String> GANZZAHL_EINHEITEN = List.of("Stück", "Personen", "Schichten");

    /**
     * Die Kundensätze der Befunde dieses Moduls — hier, nicht in der Fläche: EINE Formulierung,
     * nicht zwei. {@code BezugsEinheitTest} prüft sie Wort für Wort gegen
     * {@code befund_saetze} der Vektor-Datei.
     */
    public static final Map<String, String> SAETZE = Map.of(
            EINHEIT_UNBEKANNT, "Unbekannte Einheit — erlaubt sind die Einheiten dieser Größe.",
            EINHEIT_UMGERECHNET, "Der gelieferte Wert wurde in die Einheit der Bezugsgröße umgerechnet.");

    /** U1–U3: der Betrag in der Einheit der Bezugsgröße; {@code null} heißt „abgelehnt“. */
    public record Einheitswert(BigDecimal betrag, String einheit, List<String> befunde) {}

    /**
     * U1: eine erlaubte Umrechnung, wie sie im Vertrag steht. Sie gilt in BEIDE Richtungen — t →
     * kg ist kg → t mit umgekehrtem Vorzeichen des Zehnerschritts. Entweder {@code zehnerpotenz}
     * (exakt) oder {@code teiler} mit {@code nachkommastellen}; nie ein geschätzter Faktor.
     */
    public record Umrechnung(String von, String nach, Integer zehnerpotenz, Integer teiler, Integer nachkommastellen) {}

    /**
     * U1: die erlaubten Umrechnungen für die Schreib- und Vorschauwege des Servers (seit AP-09 IP-12) —
     * Zeile für Zeile der Block {@code umrechnung} der Vektor-Datei ({@code ImportVorschauTest} prüft
     * das). Die Tests der Regel rechnen weiter mit dem Block selbst.
     */
    public static final List<Umrechnung> UMRECHNUNGEN = List.of(
            new Umrechnung("t", "kg", 3, null, null),
            new Umrechnung("l", "m³", -3, null, null),
            new Umrechnung("min", "h", null, 60, 4));

    /**
     * U1–U3 — der gelieferte Betrag wird auf die Einheit der Bezugsgröße gebracht.
     *
     * <p>Keine gelieferte Einheit heißt: die Einheit der Bezugsgröße gilt (U3). Eine Einheit
     * außerhalb des Vokabulars der ZIEL-Größe ist {@link #EINHEIT_UNBEKANNT} und die Zeile wird
     * nicht übernommen (U2) — es wird nie ein Faktor geraten und nie über Größen hinweg
     * gerechnet. Innerhalb derselben Größe gilt genau der Faktor aus {@code umrechnung}, in
     * beiden Richtungen; das Ergebnis trägt {@link #EINHEIT_UMGERECHNET}.
     *
     * @param einheiten das Vokabular je Größe, wie es im Vertrag steht
     * @param umrechnungen die erlaubten Umrechnungen, wie sie im Vertrag stehen
     */
    public static Einheitswert einheit(
            BigDecimal betrag,
            String geliefert,
            String ziel,
            Map<String, List<String>> einheiten,
            List<Umrechnung> umrechnungen) {
        return einheit(betrag, geliefert, ziel, einheiten, umrechnungen, Map.of());
    }

    /**
     * U1–U3 mit den SYNONYMEN einer Zuordnungs-Vorlage (U2).
     *
     * <p>Ein Synonym ist eine Text-Ersetzung VOR der Prüfung („Stk“ ist Stück, „Std“ ist h) und
     * nie eine Umrechnung: es ändert das Wort, nie den Betrag. Ein Synonym auf ein Wort außerhalb
     * des Vokabulars bleibt {@link #EINHEIT_UNBEKANNT} — eine Vorlage kann das Vokabular nicht
     * erweitern.
     *
     * @param synonyme Wort aus der Datei → Einheit des Vokabulars
     */
    public static Einheitswert einheit(
            BigDecimal betrag,
            String geliefert,
            String ziel,
            Map<String, List<String>> einheiten,
            List<Umrechnung> umrechnungen,
            Map<String, String> synonyme) {
        String wort = synonym(geliefert, synonyme);
        if (wort == null || wort.equals(ziel)) {
            return new Einheitswert(betrag, ziel, List.of());
        }
        String groesse = groesseVon(ziel, einheiten);
        if (groesse == null || !einheiten.get(groesse).contains(wort)) {
            return new Einheitswert(null, ziel, List.of(EINHEIT_UNBEKANNT));
        }
        for (Umrechnung u : umrechnungen) {
            boolean hin = wort.equals(u.von()) && ziel.equals(u.nach());
            boolean zurueck = ziel.equals(u.von()) && wort.equals(u.nach());
            if (hin || zurueck) {
                return new Einheitswert(rechne(betrag, u, hin), ziel, List.of(EINHEIT_UMGERECHNET));
            }
        }
        // Gleiche Größe, aber kein Faktor im Vertrag: das ist keine Umrechnung, das wäre eine
        // Annahme. Sie wird abgelehnt wie ein unbekanntes Wort.
        return new Einheitswert(null, ziel, List.of(EINHEIT_UNBEKANNT));
    }

    /**
     * U2 — das Wort der Datei wird durch die Einheit der Vorlage ersetzt, sonst bleibt es, wie es
     * geliefert wurde. Groß-/Kleinschreibung und Punkte am Wortende („Stk.“) werden dabei
     * angeglichen, weil ein Typenschild nicht zwischen ihnen unterscheidet.
     */
    public static String synonym(String geliefert, Map<String, String> synonyme) {
        if (geliefert == null || synonyme == null || synonyme.isEmpty()) {
            return geliefert;
        }
        String schluessel = normal(geliefert);
        for (Map.Entry<String, String> e : synonyme.entrySet()) {
            if (normal(e.getKey()).equals(schluessel)) {
                return e.getValue();
            }
        }
        return geliefert;
    }

    /** Die Größe, zu der eine Einheit gehört — oder {@code null}, wenn keine sie führt. */
    public static String groesseVon(String einheit, Map<String, List<String>> einheiten) {
        for (Map.Entry<String, List<String>> e : einheiten.entrySet()) {
            if (e.getValue().contains(einheit)) {
                return e.getKey();
            }
        }
        return null;
    }

    /** U5 — nimmt diese Einheit Nachkommastellen an? Stück, Personen und Schichten tun es nicht. */
    public static boolean istGanzzahlig(String einheit) {
        return GANZZAHL_EINHEITEN.contains(einheit);
    }

    /** Der Kundensatz eines Befunds dieses Moduls — die Fläche erfindet keinen zweiten. */
    public static String satz(String befund) {
        return Objects.requireNonNull(SAETZE.get(befund), "kein Kundensatz für " + befund);
    }

    private static BigDecimal rechne(BigDecimal betrag, Umrechnung u, boolean hin) {
        if (u.zehnerpotenz() != null) {
            return betrag.scaleByPowerOfTen(hin ? u.zehnerpotenz() : -u.zehnerpotenz()).stripTrailingZeros();
        }
        BigDecimal teiler = BigDecimal.valueOf(u.teiler());
        return hin
                ? betrag.divide(teiler, u.nachkommastellen(), RoundingMode.HALF_UP).stripTrailingZeros()
                : betrag.multiply(teiler).stripTrailingZeros();
    }

    private static String normal(String wort) {
        String s = wort.trim().toLowerCase(Locale.GERMANY);
        while (s.endsWith(".")) {
            s = s.substring(0, s.length() - 1);
        }
        return s;
    }
}
