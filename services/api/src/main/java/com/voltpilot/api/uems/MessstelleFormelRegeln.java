package com.voltpilot.api.uems;

import com.voltpilot.api.uems.MessstelleRegeln.Groesse;
import com.voltpilot.api.uems.MessstelleRegeln.KatalogEintrag;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Die REINEN Regeln der FORMEL einer berechneten Messstelle — UEMS AP-10,
 * Formel-Typ „gewichtete Summe" (Prosa in {@code docs/contracts/v2/messstelle-formel.md},
 * Konzept vp-helfer-konzept-h1 §2.2/§2.3). Ohne Spring, ohne Repository, ohne Uhr —
 * jede Regel ist ohne einen einzigen Container prüfbar.
 *
 * <p>Der Zwilling im Portal ist {@code frontend/portal/src/uemsMessstelleFormel.ts};
 * beide fahren dieselben Vektoren ({@code docs/contracts/v2/messstelle-formel-vectors.json}).
 * <b>Wer eine Regel ändert, ändert beide Seiten und die Vektor-Datei.</b>
 *
 * <p>Diese Klasse ergänzt {@link MessstelleRegeln} additiv und stützt sich auf deren
 * Größen-Katalog ({@link MessstelleRegeln#GROESSEN_KATALOG}, {@link MessstelleRegeln#KANAL_EINHEITEN},
 * {@link MessstelleRegeln#groessePruefen}) — der Helfer ist der erste AP-10-Formel-Typ, kein
 * zweites Modell.
 *
 * <h2>Die drei Regeln</h2>
 *
 * <ul>
 *   <li><b>Größe ableiten</b> ({@link #formelGroesse}): alle Terme tragen dieselbe
 *       Vertrags-Größe; die Hauptgröße der berechneten Messstelle wird daraus abgeleitet
 *       (Richtung {@code richtungslos} bei gemischter Richtung oder gemischtem Vorzeichen).
 *       Gemischte Größen sind {@code groessen_gemischt}.
 *   <li><b>Zyklus</b> ({@link #zyklus}): ein Term darf eine ANDERE Messstelle verketten
 *       (Bausteine), aber nie im Kreis.
 *   <li><b>Gewichtete Summe</b> ({@link #gewichteteSumme}): der Wert selbst — mit
 *       Einheiten-Normierung und der harten Ehrlichkeitsregel {@code null} statt Teilsumme.
 * </ul>
 */
public final class MessstelleFormelRegeln {

    /** Auf wie viele Nachkommastellen die Summe gerundet wird (deterministisch über die Zwillinge). */
    public static final int SUMME_NACHKOMMASTELLEN = 6;

    /** Die umrechenbaren Einheiten je Größe — dieselbe Tabelle wie der Messstellen-Vertrag. */
    public static final Map<String, List<String>> EINHEITEN_NORMIERUNG = MessstelleRegeln.KANAL_EINHEITEN;

    private static final String RICHTUNGSLOS = "richtungslos";
    private static final String PLUS = "+";
    private static final String MINUS = "-";

    private MessstelleFormelRegeln() {}

    /** Die Fehlertabelle: Code, Status der Schnittstelle und wer ihn feststellt. */
    public enum Fehler {
        /** Die Terme tragen nicht dieselbe Vertrags-Größe (Äpfel und Birnen). */
        GROESSEN_GEMISCHT("groessen_gemischt", 422),
        /** Ein messstelle-Term verkettet im Kreis. */
        FORMEL_ZYKLUS("formel_zyklus", 422);

        private final String code;
        private final int status;

        Fehler(String code, int status) {
            this.code = code;
            this.status = status;
        }

        public String code() {
            return code;
        }

        public int status() {
            return status;
        }

        /** Immer die Zwillinge dieses Vertrags. */
        public String geprueftVon() {
            return "MessstelleFormelRegeln";
        }
    }

    // ----------------------------------------------------------- Größe ableiten

    /**
     * Ein Term, so wie er zur Ableitung der Hauptgröße gesehen wird: die Vertrags-Größe des
     * Messwerts (Messkanal oder verkettete Messstelle) und sein Vorzeichen.
     */
    public record Term(String groesse, String richtung, String einheit, String wertart, String vorzeichen) {}

    /** Das Urteil über die abgeleitete Hauptgröße; {@code fehler == null} heißt: abgeleitet. */
    public record GroesseUrteil(Fehler fehler, String grund, Groesse hauptgroesse) {}

    /**
     * Leitet die Hauptgröße der berechneten Messstelle aus ihren Termen ab (§2.2). Alle Terme
     * müssen dieselbe Größe und Wertart tragen — sonst {@code groessen_gemischt} mit dem ersten
     * verletzten Merkmal. Die Einheit ist die Katalog-Einheit der Größe (W/kW/MW normiert die
     * Berechnung). Die Richtung ist die gemeinsame Richtung, wenn alle Terme dieselbe tragen und
     * alle mit {@code +} eingehen; sonst {@code richtungslos} (ein Netto). Ergibt sich eine
     * Größe, die der Katalog nicht kennt (z. B. Netto einer Größe ohne {@code richtungslos}),
     * ist das {@code groessen_gemischt} mit dem Grund aus dem Katalog.
     *
     * <p>Ohne Term gibt es keine Hauptgröße (die Messstelle bleibt Entwurf, {@code fehlt: formel}
     * über {@link MessstelleRegeln#lebenszyklus}) — kein Fehler.
     */
    public static GroesseUrteil formelGroesse(List<Term> terme) {
        if (terme.isEmpty()) {
            return new GroesseUrteil(null, null, null);
        }
        Term erster = terme.get(0);
        for (Term t : terme) {
            if (!erster.groesse().equals(t.groesse())) {
                return gemischt("groesse");
            }
            if (!erster.wertart().equals(t.wertart())) {
                return gemischt("wertart");
            }
        }
        KatalogEintrag e = katalog(erster.groesse());
        if (e == null) {
            return gemischt("groesse");
        }
        boolean alleGleicheRichtung = terme.stream().allMatch(t -> erster.richtung().equals(t.richtung()));
        boolean allePlus = terme.stream().allMatch(t -> PLUS.equals(t.vorzeichen()));
        String richtung = alleGleicheRichtung && allePlus ? erster.richtung() : RICHTUNGSLOS;
        Groesse haupt = new Groesse(erster.groesse(), richtung, e.einheit(), erster.wertart());
        MessstelleRegeln.GroesseUrteil imKatalog = MessstelleRegeln.groessePruefen(e.medien().get(0), haupt);
        if (imKatalog.fehler() != null) {
            return gemischt(imKatalog.grund());
        }
        return new GroesseUrteil(null, null, haupt);
    }

    private static GroesseUrteil gemischt(String grund) {
        return new GroesseUrteil(Fehler.GROESSEN_GEMISCHT, grund, null);
    }

    private static KatalogEintrag katalog(String groesse) {
        for (KatalogEintrag e : MessstelleRegeln.GROESSEN_KATALOG) {
            if (e.groesse().equals(groesse)) {
                return e;
            }
        }
        return null;
    }

    // ----------------------------------------------------------------- Zyklus

    public record ZyklusUrteil(boolean zyklus, List<String> kette) {}

    /**
     * Verkettet die Formel der Messstelle {@code kennzeichen} (mit den messstelle-Termen
     * {@code verweise}) im Kreis? {@code bestehende} bildet jede andere berechnete Messstelle auf
     * die Messstellen ab, die SIE verkettet. Das Urteil trägt bei einem Kreis dessen Kette
     * ({@code [kennzeichen, …, kennzeichen]}); die Prüfung folgt der Stellungs-Kette
     * ({@link MessstelleRegeln#stellungPruefen}).
     */
    public static ZyklusUrteil zyklus(String kennzeichen, List<String> verweise,
            Map<String, List<String>> bestehende) {
        Map<String, List<String>> graph = new LinkedHashMap<>(bestehende);
        graph.put(kennzeichen, verweise);
        List<String> pfad = new ArrayList<>();
        pfad.add(kennzeichen);
        ZyklusUrteil gefunden = suche(kennzeichen, kennzeichen, graph, pfad, new HashSet<>());
        return gefunden != null ? gefunden : new ZyklusUrteil(false, List.of());
    }

    private static ZyklusUrteil suche(String ziel, String aktuell, Map<String, List<String>> graph,
            List<String> pfad, Set<String> besucht) {
        besucht.add(aktuell);
        for (String naechste : graph.getOrDefault(aktuell, List.of())) {
            pfad.add(naechste);
            if (naechste.equals(ziel)) {
                return new ZyklusUrteil(true, List.copyOf(pfad));
            }
            if (!besucht.contains(naechste)) {
                ZyklusUrteil r = suche(ziel, naechste, graph, pfad, besucht);
                if (r != null) {
                    return r;
                }
            }
            pfad.remove(pfad.size() - 1);
        }
        return null;
    }

    // -------------------------------------------------------- Gewichtete Summe

    /**
     * Ein Summand der gewichteten Summe: Vorzeichen, Faktor, der Wert des Messwerts (oder
     * {@code null}, wenn er fehlt/veraltet) und seine Einheit (auf die Ziel-Einheit normiert).
     */
    public record Summand(String vorzeichen, double faktor, Double wert, String einheit) {}

    /**
     * Das Ergebnis. {@code wert == null} und {@code unvollstaendig == true}, wenn EIN Pflicht-Term
     * fehlt; {@code fehlende} nennt dann deren Positionen.
     */
    public record SummeUrteil(Double wert, boolean unvollstaendig, List<Integer> fehlende) {}

    /**
     * Die gewichtete Summe auf die {@code zielEinheit} (§2.3). <b>Die harte Ehrlichkeitsregel:</b>
     * fehlt oder veraltet EIN Pflicht-Term ({@code wert == null}), ist das Ergebnis {@code null}
     * („unvollständig"), NIE eine stillschweigend um den fehlenden Term reduzierte Teilsumme —
     * eine Summe mit heimlich fehlendem Summanden wäre ein Falschwert. Sonst die Summe der
     * {@code vorzeichen · faktor · normiert(wert)}, gerundet auf {@link #SUMME_NACHKOMMASTELLEN}.
     */
    public static SummeUrteil gewichteteSumme(String zielEinheit, List<Summand> terme) {
        List<Integer> fehlende = new ArrayList<>();
        for (int i = 0; i < terme.size(); i++) {
            if (terme.get(i).wert() == null) {
                fehlende.add(i);
            }
        }
        if (!fehlende.isEmpty()) {
            return new SummeUrteil(null, true, List.copyOf(fehlende));
        }
        double summe = 0;
        for (Summand t : terme) {
            double wert = normiere(t.wert(), t.einheit(), zielEinheit);
            summe += (MINUS.equals(t.vorzeichen()) ? -1 : 1) * t.faktor() * wert;
        }
        return new SummeUrteil(runde(summe), false, List.of());
    }

    /**
     * Rechnet {@code wert} von {@code von} auf {@code nach} um (Zehnerpotenzen je Größe,
     * {@link #EINHEITEN_NORMIERUNG}). Gleiche Einheit → unverändert; eine unbekannte Paarung
     * (bei konsistenter Formel unmöglich) bleibt ebenfalls unverändert.
     */
    public static double normiere(double wert, String von, String nach) {
        if (von == null || von.equals(nach)) {
            return wert;
        }
        for (List<String> familie : EINHEITEN_NORMIERUNG.values()) {
            int vonIndex = familie.indexOf(von);
            int nachIndex = familie.indexOf(nach);
            if (vonIndex >= 0 && nachIndex >= 0) {
                int stufen = vonIndex - nachIndex;
                double faktor = Math.pow(1000, Math.abs(stufen));
                return stufen >= 0 ? wert * faktor : wert / faktor;
            }
        }
        return wert;
    }

    private static double runde(double wert) {
        double faktor = Math.pow(10, SUMME_NACHKOMMASTELLEN);
        return Math.round(wert * faktor) / faktor;
    }
}
