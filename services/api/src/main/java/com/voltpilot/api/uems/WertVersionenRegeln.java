package com.voltpilot.api.uems;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/**
 * Die reinen Regeln, nach denen das Lese-Modell „Werte je Messstelle“ Versionen liest (UEMS AP-08 IP-18): welche
 * Version ein Schritt zeigt und welche Entscheidungen von Menschen eine Version ausmachen. Kein Spring, keine
 * Datenbank — gerechnet wird hier NICHTS an einem Wert: jede Zahl einer Version steht gespeichert in
 * {@code messreihe_viertelstunde_version} bzw. {@code messreihe_periode_version} (Version 1 in der Zeile der
 * Verdichtung), jede Entscheidung als Fassung in {@code messreihe_ersatzwert} bzw. {@code messreihe_korrektur}.
 *
 * <p><b>Drei Sätze, die das Paket definieren:</b>
 * <ol>
 *   <li>Ohne Angabe zeigt ein Schritt seine NEUESTE Version (die wirksame); {@code version=n} zeigt genau Version n —
 *       die damalige Zahl, nicht die heutige mit einem Etikett.</li>
 *   <li>Eine Version, die es nicht gibt, ist keine leere Antwort und nie stillschweigend die höchste: gibt es sie an
 *       keinem Schritt der Anfrage, ist die Anfrage benannt abgelehnt ({@link VersionGibtEsNicht}); fehlt sie nur an
 *       einzelnen Schritten eines Zeitraums, nennen diese {@code version_nicht_gespeichert} und ihre höchste.</li>
 *   <li>Das „warum“ ist der Text, den ein Mensch zu seiner Fassung geschrieben hat — nie ein Systemwort. Fehlt er,
 *       sagt die Historie das ({@code fehlt}) und erfindet keinen.</li>
 * </ol>
 */
public final class WertVersionenRegeln {

    private WertVersionenRegeln() {}

    /** Der Status einer Ersatzwert-Fassung, mit dem er wirkt ({@code events-vocabulary-vectors.json}). */
    public static final String ERSATZWERT_WIRKSAM = "wirksam";
    /** Der Status einer Korrektur-Fassung, mit dem sie wirkt. */
    public static final String KORREKTUR_FREIGEGEBEN = "freigegeben";
    /** Der Status, mit dem beide Vorgänge aufhören zu wirken. */
    public static final String ZURUECKGENOMMEN = "zurueckgenommen";

    // ------------------------------------------------------------------------------ Welche Version

    /**
     * Welche Version ein Schritt zeigt.
     *
     * @param version die gezeigte Version; 0 = die angefragte ist für diesen Schritt nicht gespeichert
     * @param hoechste die neueste Version des Schritts — ohne spätere Version 1
     */
    public record Wahl(int version, int hoechste) {
        public boolean gespeichert() {
            return version > 0;
        }
    }

    /**
     * Die Wahl je Schritt. {@code spaetere} sind die gespeicherten Versionen ab 2 (Version 1 ist die Zeile der
     * Verdichtung — oder, in einer Lücke, gar keine: dann ist Version 1 „keine Werte“).
     *
     * @param angefragt {@code null} = die neueste
     */
    public static Wahl wahl(Collection<Integer> spaetere, Integer angefragt) {
        int hoechste = 1;
        for (Integer v : spaetere) {
            if (v == null || v < 2) {
                throw new IllegalArgumentException("eine spätere Version ist eine ganze Zahl ab 2: " + v);
            }
            hoechste = Math.max(hoechste, v);
        }
        if (angefragt == null) {
            return new Wahl(hoechste, hoechste);
        }
        if (angefragt < 1) {
            throw new IllegalArgumentException("eine Version ist eine ganze Zahl ab 1: " + angefragt);
        }
        return new Wahl(angefragt == 1 || spaetere.contains(angefragt) ? angefragt : 0, hoechste);
    }

    /**
     * Eine angefragte Version, die an KEINEM Schritt der Anfrage gespeichert ist — die benannte Ablehnung (404
     * {@code version_gibt_es_nicht}). Version 1 wird nie abgelehnt: sie ist die Zeile der Verdichtung oder, ohne
     * Zeile, „keine Werte“.
     */
    public static final class VersionGibtEsNicht extends RuntimeException {
        public static final String CODE = "version_gibt_es_nicht";

        private final int version;
        private final int hoechste;

        VersionGibtEsNicht(int version, int hoechste) {
            super("Version " + version + " gibt es für diesen Zeitraum nicht — die neueste ist Version " + hoechste
                    + ".");
            this.version = version;
            this.hoechste = hoechste;
        }

        public int version() {
            return version;
        }

        public int hoechste() {
            return hoechste;
        }
    }

    /**
     * Prüft die Anfrage als Ganzes: {@code hoechste} ist die neueste Version über alle Schritte (je Schritt die
     * gespeicherte, an der Stunde die ihrer Viertelstunden).
     */
    public static void pruefeVorhanden(Integer angefragt, int hoechste) {
        if (angefragt != null && angefragt > 1 && angefragt > hoechste) {
            throw new VersionGibtEsNicht(angefragt, Math.max(1, hoechste));
        }
    }

    // ------------------------------------------------------------------------------ Welche Entscheidungen

    /** Ein Vorgang: Ersatzwert ({@code EW-…}) oder Korrektur ({@code K-…}). */
    public enum Vorgang {
        ERSATZWERT("ersatzwert", "EW-"),
        KORREKTUR("korrektur", "K-");

        private final String wort;
        private final String praefix;

        Vorgang(String wort, String praefix) {
            this.wort = wort;
            this.praefix = praefix;
        }

        public String wort() {
            return wort;
        }

        public static Vorgang aus(String kennung) {
            for (Vorgang v : values()) {
                if (kennung != null && kennung.startsWith(v.praefix)) {
                    return v;
                }
            }
            throw new IllegalArgumentException("keine Kennung eines Ersatzwerts oder einer Korrektur: " + kennung);
        }
    }

    /** Eine gespeicherte Fassung eines Vorgangs — nur, was die Wahl braucht. */
    public record Fassung(String kennung, int fassung, String status, Instant am) {}

    /** Eine gewählte Fassung. */
    public record Schluessel(String kennung, int fassung) {}

    /**
     * Die Entscheidungen, die Version n gegenüber Version n − 1 ausmachen — in der Reihenfolge, in der sie getroffen
     * wurden:
     * <ul>
     *   <li>ein Vorgang, der in n wirkt und in n − 1 nicht: seine wirkende Fassung (Ersatzwert {@code wirksam},
     *       Korrektur {@code freigegeben});</li>
     *   <li>einer, der in n − 1 wirkte und in n nicht mehr: seine Fassung {@code zurueckgenommen} — ohne eine solche
     *       (etwa ein Ersatzwert, der eine korrigierte Viertelstunde überschreibt, Befund IP-17) keine Entscheidung,
     *       der Anlass nennt dann, was geschah;</li>
     *   <li>der Anlass der Version (Kennung + Fassung), wenn er nicht schon dabei ist — er steht immer da.</li>
     * </ul>
     * Nur Fassungen, die bis zum Bilden der Version gespeichert waren ({@code am ≤ gebildet}), zählen: eine spätere
     * Entscheidung gehört einer späteren Version. Die jüngste passende gewinnt.
     *
     * @param vorher was in Version n − 1 wirkt (Korrekturen und Ersatzwerte; Version 1: leer)
     * @param jetzt was in Version n wirkt
     */
    public static List<Schluessel> entscheidungen(Collection<String> vorher, Collection<String> jetzt,
            Schluessel anlass, Collection<Fassung> fassungen, Instant gebildet) {
        Objects.requireNonNull(anlass, "eine Version ab 2 hat immer einen Anlass");
        List<Fassung> gewaehlt = new ArrayList<>();
        Set<String> dazu = new LinkedHashSet<>(jetzt);
        dazu.removeAll(vorher);
        Set<String> weg = new LinkedHashSet<>(vorher);
        weg.removeAll(jetzt);
        for (String k : dazu) {
            String wirkt = Vorgang.aus(k) == Vorgang.ERSATZWERT ? ERSATZWERT_WIRKSAM : KORREKTUR_FREIGEGEBEN;
            juengste(fassungen, k, wirkt, gebildet).ifPresent(gewaehlt::add);
        }
        for (String k : weg) {
            juengste(fassungen, k, ZURUECKGENOMMEN, gebildet).ifPresent(gewaehlt::add);
        }
        boolean anlassDabei = gewaehlt.stream()
                .anyMatch(f -> f.kennung().equals(anlass.kennung()) && f.fassung() == anlass.fassung());
        if (!anlassDabei) {
            Fassung a = fassungen.stream()
                    .filter(f -> f.kennung().equals(anlass.kennung()) && f.fassung() == anlass.fassung())
                    .findFirst().orElse(new Fassung(anlass.kennung(), anlass.fassung(), null, null));
            gewaehlt.add(a);
        }
        gewaehlt.sort(Comparator.comparing(Fassung::am, Comparator.nullsLast(Comparator.naturalOrder()))
                .thenComparing(Fassung::kennung).thenComparingInt(Fassung::fassung));
        return gewaehlt.stream().map(f -> new Schluessel(f.kennung(), f.fassung())).toList();
    }

    private static java.util.Optional<Fassung> juengste(Collection<Fassung> fassungen, String kennung, String status,
            Instant gebildet) {
        return fassungen.stream()
                .filter(f -> f.kennung().equals(kennung) && status.equals(f.status()))
                .filter(f -> gebildet == null || f.am() == null || !f.am().isAfter(gebildet))
                .max(Comparator.comparingInt(Fassung::fassung));
    }

    // ------------------------------------------------------------------------------ Warum

    /** Was an einer Entscheidung fehlt — geschlossen: kein Text zu dieser Fassung geschrieben. */
    public static final String FEHLT_WARUM = "warum";
    /** Die Fassung ist nicht lesbar (Vorgänge werden nur beim Offboarding gelöscht, sonst ein Befund). */
    public static final String FEHLT_FASSUNG = "fassung";

    /**
     * Der Text, den ein Mensch mit DIESER Fassung geschrieben hat: die anlegende Fassung trägt die Begründung, jede
     * weitere ihren Grund. {@code null} = keiner geschrieben — nie ein Ersatz aus Art, Methode oder Status.
     */
    public static String begruendung(int fassung, String begruendung, String grund) {
        String text = fassung == 1 ? begruendung : grund;
        return text == null || text.isBlank() ? null : text;
    }
}
