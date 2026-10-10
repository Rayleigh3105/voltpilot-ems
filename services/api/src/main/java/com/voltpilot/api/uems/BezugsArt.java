package com.voltpilot.api.uems;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Die ARTEN einer Bezugsgröße als eigenes, reines Modul (UEMS AP-09 §4.2).
 *
 * <p>Der Vertrag steht in {@code docs/contracts/v2/bezugsdaten-vectors.json} (Block
 * {@code arten}); der TS-Zwilling ist {@code frontend/portal/src/bezugsArt.ts}. Wer eine Regel
 * ändert, ändert die Vektor-Datei UND beide Zwillinge.
 *
 * <p><b>Eine Art spricht nur vorhandene Wörter.</b> Produktionsmenge, Gutteile, Betriebszeit … sagen,
 * welche Einheiten, welche Wertart, welche Perioden, welche Geltungsbereiche und welche Herkünfte
 * möglich sind — jede Angabe ist ein Wort der vorhandenen Vokabulare. Die Einheiten fragt dieses
 * Modul darum bei {@link BezugsEinheit} an, statt sie zu kopieren; ein Wort, das kein Vokabular
 * führt, wird nie wählbar (Invariante 6).
 *
 * <p><b>Keine zweite Liste:</b> weder die Arten noch ihre Wörter stehen in dieser Klasse. Sie
 * kommen herein wie das {@link BezugsgroesseRegeln.Vokabular} — im Test aus der Vektor-Datei; ein
 * Betriebsweg, der die Art braucht, legt ihre eine Stelle in der Datenbank an.
 *
 * <p><b>Die Art schränkt ein, sie rechnet nicht um:</b> eine Einheit derselben Größe, die die Art
 * nicht führt, passt nicht. Die Umrechnung eines gelieferten Werts bleibt
 * {@link BezugsEinheit#einheit}.
 *
 * <p><b>Rein:</b> ohne Spring, ohne Datenbank, ohne Netz und ohne Uhr. Noch ruft kein
 * Produktionsweg das Modul an.
 */
public final class BezugsArt {

    private BezugsArt() {}

    /** {@code einheiten}/{@code geltung}: jedes Wort des Vokabulars („jede Einheit des Vokabulars“, „jedes Objekt“). */
    public static final String ALLE = "alle";

    /** {@code einheiten}: die Einheit der Messstelle, an der die Größe hängt („Einheit der Messstelle (m³ …)“). */
    public static final String EINHEIT_DER_MESSSTELLE = "messstelle";

    /** Die Felder, die {@link #pruefen} als nicht passend nennen kann — in dieser Reihenfolge. */
    public static final List<String> FELDER =
            List.of("art", "wertart", "geltung_art", "einheit", "periode_art", "herkunft_art");

    /**
     * Eine Auswahl von Wörtern, wie sie in der Datei steht: eine Liste ({@code aus} {@code null})
     * oder ein Verweis — {@link #ALLE} bzw. {@link #EINHEIT_DER_MESSSTELLE}.
     */
    public record Auswahl(String aus, List<String> woerter) {

        public static Auswahl liste(List<String> woerter) {
            return new Auswahl(null, List.copyOf(woerter));
        }

        public static Auswahl verweis(String aus) {
            return new Auswahl(Objects.requireNonNull(aus), List.of());
        }
    }

    /** Eine Art, wie sie im Block {@code arten.je_art} steht. */
    public record Art(
            String art,
            String name,
            Auswahl einheiten,
            String wertart,
            List<String> perioden,
            Auswahl geltung,
            List<String> herkunft) {}

    /** Die Angaben einer Bezugsgröße, gegen die ihre Art geprüft wird. {@code herkunftArt} {@code null} = nicht geprüft. */
    public record Eingang(
            String wertart,
            String geltungArt,
            String einheit,
            String periodeArt,
            String herkunftArt,
            String einheitDerMessstelle) {}

    /** Die Art mit diesem Wort — oder {@code null}, wenn das Vokabular der Arten sie nicht führt. */
    public static Art art(String wort, List<Art> arten) {
        for (Art a : arten) {
            if (a.art().equals(wort)) {
                return a;
            }
        }
        return null;
    }

    /**
     * Die wählbaren Einheiten einer Art, jede ein Wort des Einheiten-Vokabulars.
     *
     * <p>Eine Liste bleibt in ihrer Reihenfolge; {@link #ALLE} ist das ganze Vokabular in seiner
     * Reihenfolge; {@link #EINHEIT_DER_MESSSTELLE} ist genau die Einheit der Messstelle — ohne
     * Messstelle oder mit einer Einheit, die das Vokabular nicht führt, keine.
     */
    public static List<String> einheitenDer(Art art, Map<String, List<String>> einheiten, String einheitDerMessstelle) {
        List<String> kandidaten;
        if (ALLE.equals(art.einheiten().aus())) {
            kandidaten = new ArrayList<>();
            einheiten.values().forEach(kandidaten::addAll);
        } else if (EINHEIT_DER_MESSSTELLE.equals(art.einheiten().aus())) {
            kandidaten = einheitDerMessstelle == null ? List.of() : List.of(einheitDerMessstelle);
        } else {
            kandidaten = art.einheiten().woerter();
        }
        return kandidaten.stream()
                .filter(e -> BezugsEinheit.groesseVon(e, einheiten) != null)
                .toList();
    }

    /** Die wählbaren Geltungsbereich-Arten einer Art; {@link #ALLE} ist das ganze Vokabular. */
    public static List<String> geltungDer(Art art, List<String> geltungArten) {
        return ALLE.equals(art.geltung().aus()) ? List.copyOf(geltungArten) : imVokabular(art.geltung().woerter(), geltungArten);
    }

    /** Die wählbaren Perioden einer Art; leer heißt: keine Periode (jede Wertart außer Periodenwert). */
    public static List<String> periodenDer(Art art, List<String> periodeArten) {
        return imVokabular(art.perioden(), periodeArten);
    }

    /** Die möglichen Herkünfte der Werte einer Art. */
    public static List<String> herkunftDer(Art art, List<String> herkunftArten) {
        return imVokabular(art.herkunft(), herkunftArten);
    }

    /**
     * Passt eine Bezugsgröße zu ihrer Art? Die Antwort nennt ALLE Felder, die nicht passen, in der
     * Reihenfolge {@link #FELDER}; leer heißt: passt. Eine Art, die das Vokabular der Arten nicht
     * führt, ist nur {@code art} — gegen sie lässt sich nichts weiter prüfen.
     */
    public static List<String> pruefen(
            String artWort,
            Eingang e,
            List<Art> arten,
            BezugsgroesseRegeln.Vokabular v,
            List<String> herkunftArten) {
        Art art = art(artWort, arten);
        if (art == null) {
            return List.of("art");
        }
        List<String> abweichend = new ArrayList<>();
        if (!art.wertart().equals(e.wertart()) || !v.wertarten().contains(art.wertart())) {
            abweichend.add("wertart");
        }
        if (!geltungDer(art, v.geltungArten()).contains(e.geltungArt())) {
            abweichend.add("geltung_art");
        }
        if (!einheitenDer(art, v.einheiten(), e.einheitDerMessstelle()).contains(e.einheit())) {
            abweichend.add("einheit");
        }
        if (art.perioden().isEmpty()
                ? e.periodeArt() != null
                : !periodenDer(art, v.periodeArten()).contains(e.periodeArt())) {
            abweichend.add("periode_art");
        }
        if (e.herkunftArt() != null && !herkunftDer(art, herkunftArten).contains(e.herkunftArt())) {
            abweichend.add("herkunft_art");
        }
        return List.copyOf(abweichend);
    }

    private static List<String> imVokabular(List<String> woerter, List<String> vokabular) {
        return woerter.stream().filter(vokabular::contains).toList();
    }
}
