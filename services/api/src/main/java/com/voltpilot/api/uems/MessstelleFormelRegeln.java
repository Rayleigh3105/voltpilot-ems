package com.voltpilot.api.uems;

import com.voltpilot.api.uems.MessstelleRegeln.Groesse;
import com.voltpilot.api.uems.MessstelleRegeln.KatalogEintrag;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Rueckwirkung;
import com.voltpilot.api.uems.OrtsbaumAbleitung.RueckwirkungEingang;
import com.voltpilot.api.uems.OrtsbaumAbleitung.RueckwirkungErgebnis;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
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
 * <h2>Die vier Regeln</h2>
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
 *   <li><b>Fassungen je Tag</b> ({@link #fassungEintrag}, {@link #fassungAm}, AP-10 IP-3, §6): eine
 *       neue Fassung beendet die laufende am Vortag, eine Überlappung wird abgelehnt, eine
 *       rückwirkende trägt ihr Kennzeichen; gerechnet wird mit der Fassung DES TAGES.
 *   <li><b>Je Typ</b> ({@link #hauptgroesse}, {@link #periodenwert}, AP-10 IP-4, §0/§2.1): die Klasse
 *       VERZWEIGT nach {@code formel_typ} — die gewichtete Summe bleibt, wo sie ist, {@code rest}
 *       und {@code saldo} rechnet {@link BilanzAbleitung} mit fester Ergebnis-Richtung.
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

    /** Die Vertrags-Richtung, die der AP-08-Haken einem richtungslosen Kanal gibt. */
    public static final String ERZEUGUNG = "Erzeugung";

    private MessstelleFormelRegeln() {}

    // -------------------------------------------- AP-08: „gilt als Erzeugung"

    /**
     * Darf der per-Term-Haken „gilt als Erzeugung" gesetzt werden? NUR fuer einen Kanal OHNE
     * Vertrags-Richtung ({@code katalogRichtung == null} — der Katalog gibt keine, z. B. der
     * Gen-Port {@code direction: null}). Ein Kanal MIT Katalog-Richtung (auch {@code richtungslos}
     * aus {@code direction: none}) traegt den Haken nicht — er waere ein wirkungsloser Schalter.
     * Genau die in {@code messstelle-formel.md} §2 reservierte AP-08-Stelle.
     */
    public static boolean erzeugungsHakenErlaubt(String katalogRichtung) {
        return katalogRichtung == null;
    }

    /**
     * Die WIRKSAME Richtung eines Terms: ein richtungsloser Kanal ({@code katalogRichtung == null})
     * zaehlt mit gesetztem Haken als {@link #ERZEUGUNG}, sonst behaelt der Term seine
     * Katalog-Richtung (der Haken auf einem gerichteten Kanal ist wirkungslos und wird ohnehin
     * abgewiesen). So bleibt eine Summe aus lauter {@code +}-Erzeugungs-Termen {@code Erzeugung},
     * statt an einem richtungslosen Gen-Port zu {@code richtungslos} zu degradieren.
     */
    public static String richtungMitErzeugungsHaken(String katalogRichtung, boolean giltAlsErzeugung) {
        return giltAlsErzeugung && katalogRichtung == null ? ERZEUGUNG : katalogRichtung;
    }

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

    // ------------------------------------------------- Fassungen je Tag (§6, AP-10 IP-3)

    /** Der Formel-Typ von PR #688; {@code rest} und {@code saldo} stehen seit AP-10 IP-4 daneben (§0). */
    public static final String GEWICHTETE_SUMME = "gewichtete_summe";

    /**
     * Die Fehler der Fassungen. Eine EIGENE Tabelle neben {@link Fehler}: die schreibt
     * {@code messstelle-formel-vectors.json} Zeile für Zeile fest, und die Vektor-Datei bleibt mit
     * AP-10 unberührt. Der Code steht im Vertrag {@code bilanz-vectors.json} ({@code fehler_neu}).
     */
    public enum FassungFehler {
        /** Die neue Fassung beginnt nicht nach dem Beginn der jüngsten. */
        FORMEL_FASSUNG_UEBERLAPPT("formel_fassung_ueberlappt", 422);

        private final String code;
        private final int status;

        FassungFehler(String code, int status) {
            this.code = code;
            this.status = status;
        }

        public String code() {
            return code;
        }

        public int status() {
            return status;
        }
    }

    /**
     * Eine wirksame (nicht aufgehobene) Fassung: Nummer, erster Tag ({@code null} = gilt seit
     * Beginn — nur Fassung 1, der Bestand von PR #688) und letzter Tag einschließlich
     * ({@code null} = bis auf Weiteres).
     */
    public record Fassung(int nummer, LocalDate ab, LocalDate bis) {

        /** Gilt diese Fassung an dem Tag? Beide Enden einschließlich (Muster A). */
        public boolean deckt(LocalDate tag) {
            return (ab == null || !tag.isBefore(ab)) && (bis == null || !tag.isAfter(bis));
        }
    }

    /**
     * Die Fassung, die an dem Tag gilt — höchstens eine, weil sich wirksame Fassungen nie
     * überlappen. Leer vor dem ersten Tag der ersten Fassung (eine Fassung gilt nie rückwärts).
     */
    public static Optional<Fassung> fassungAm(List<Fassung> wirksam, LocalDate tag) {
        return wirksam.stream().filter(f -> f.deckt(tag)).findFirst();
    }

    /**
     * Das Urteil über eine neue Fassung. {@code fehler == null} heißt: sie darf entstehen, als
     * Fassung {@code nummer} ab {@code ab} (offen); {@code beenden} ist die Fassung, die dafür am
     * Vortag endet ({@code null}: keine). {@code rueckwirkend}/{@code tage}/{@code abzeichen} sind
     * das Rückwirkend-Kennzeichen ({@link OrtsbaumAbleitung#rueckwirkung}, dieselben Wörter wie am
     * Ortsbaum). Bei {@code fehler} nennt {@code konflikt} die Fassung, an der er hängt.
     */
    public record FassungUrteil(FassungFehler fehler, String satz, Fassung konflikt, int nummer,
            LocalDate ab, Fassung beenden, LocalDate beendenAm, boolean rueckwirkend, long tage,
            String abzeichen) {}

    /**
     * Eine neue Fassung ab dem Tag {@code ab} (§6): sie beendet die laufende am VORTAG und gilt
     * bis auf Weiteres; nichts wird überschrieben. Beginnt sie nicht NACH dem Beginn der jüngsten
     * Fassung (am selben Tag oder davor), überlappt sie und wird abgelehnt
     * ({@code formel_fassung_ueberlappt}) — Fassungen reihen sich nur hinten an, damit ihre Nummer
     * die Reihenfolge der Tage bleibt. Die jüngste Fassung ohne ersten Tag (Bestand) endet an
     * jedem Vortag. Eine Fassung vor dem Eintragstag (in der Zeitzone des Standorts) ist erlaubt,
     * aber nie unsichtbar: sie trägt das Rückwirkend-Kennzeichen samt Zahl der Tage.
     */
    public static FassungUrteil fassungEintrag(List<Fassung> wirksam, LocalDate ab,
            OffsetDateTime eingetragenUm, ZoneId zone) {
        if (ab == null) {
            throw new IllegalArgumentException("Eine eingetragene Fassung hat einen ersten Tag");
        }
        Fassung juengste = wirksam.stream().max(Comparator.comparingInt(Fassung::nummer)).orElse(null);
        if (juengste != null && juengste.ab() != null && !ab.isAfter(juengste.ab())) {
            String satz = ab.equals(juengste.ab())
                    ? "Ab diesem Tag gilt schon Fassung " + juengste.nummer() + "."
                    : "Ab dem " + OrtsbaumAbleitung.datumText(juengste.ab()) + " gilt schon Fassung "
                            + juengste.nummer() + " — eine neue Fassung beginnt nach diesem Tag.";
            return new FassungUrteil(FassungFehler.FORMEL_FASSUNG_UEBERLAPPT, satz, juengste, 0, null, null,
                    null, false, 0, null);
        }
        Fassung beenden = juengste != null && (juengste.bis() == null || !ab.isAfter(juengste.bis()))
                ? juengste : null;
        RueckwirkungErgebnis r = OrtsbaumAbleitung.rueckwirkung(
                new RueckwirkungEingang(eingetragenUm, ab, null, zone, null));
        boolean rueckwirkend = r.art() == Rueckwirkung.RUECKWIRKEND;
        return new FassungUrteil(null, null, null, juengste == null ? 1 : juengste.nummer() + 1, ab, beenden,
                beenden == null ? null : ab.minusDays(1), rueckwirkend, rueckwirkend ? r.tage() : 0,
                r.abzeichen());
    }

    /**
     * Bleibt die Hauptgröße der Messstelle mit der Formel einer neuen Fassung dieselbe? Die
     * Hauptgröße ist identitätsstiftend (eine andere Größe ist eine andere Messstelle) — eine
     * Fassung, deren abgeleitete Größe abweicht, ist {@code groessen_gemischt} mit dem ersten
     * verletzten Merkmal ({@code groesse} → {@code wertart} → {@code richtung}); sonst {@code null}.
     */
    public static String hauptgroesseAbweichung(Groesse messstelle, Groesse formel) {
        if (!messstelle.groesse().equals(formel.groesse())) {
            return "groesse";
        }
        if (!messstelle.wertart().equals(formel.wertart())) {
            return "wertart";
        }
        if (!messstelle.richtung().equals(formel.richtung())) {
            return "richtung";
        }
        return null;
    }

    // ------------------------------------------- Formel-Typen je Typ (§0, §2.1, AP-10 IP-4)

    /** Die Bilanz-Differenz eines Hauptzählers: Zufluss − Abfluss − zugeordnet (E1, E3). */
    public static final String REST = "rest";

    /** Bezug − Abgabe derselben Grenze, Ergebnis Wirkenergie · saldiert (E1). */
    public static final String SALDO = "saldo";

    /** Die drei Formel-Typen in der Reihenfolge des Vertrags (§0, {@code vokabulare.formel_typ}). */
    public static final List<String> FORMEL_TYPEN = List.of(GEWICHTETE_SUMME, REST, SALDO);

    private static String bekannterTyp(String typ) {
        if (!FORMEL_TYPEN.contains(typ)) {
            throw new IllegalArgumentException("unbekannter Formel-Typ " + typ + " — bekannt sind " + FORMEL_TYPEN);
        }
        return typ;
    }

    /**
     * Speichert der Typ Terme? {@code rest} NICHT: seine Fassung ist „aus der Stellung je Tag“
     * (E3, {@link BilanzAbleitung#restAusStellung}) — zieht ein Unterzähler um, ändert sich der Rest,
     * ohne dass jemand eine Formel anfasst.
     */
    public static boolean speichertTerme(String typ) {
        return !REST.equals(bekannterTyp(typ));
    }

    /**
     * §2.1 — die Hauptgröße JE TYP. Diese Klasse VERZWEIGT nur und rechnet die neuen Typen nicht
     * selbst: die gewichtete Summe bleibt {@link #formelGroesse} (unverändert, vektor-gleich mit
     * {@code messstelle-formel-vectors.json}); {@code rest} und {@code saldo} beantwortet
     * {@link BilanzAbleitung#richtung} — mit FESTER Richtung, nie aus den Vorzeichen der Terme:
     * Bezug − Bezug − Bezug bleibt Bezug (F1), Bezug − Abgabe ist {@code saldiert}, und das nur an
     * einer berechneten Messstelle (der Katalog prüft die Art).
     *
     * @param art die Art der Messstelle, an der die Formel steht
     * @param wertart {@code Intervallmenge} (Mengen-Ebene) oder {@code Momentanwert} (Live-Wert eines
     *     {@code rest}); die gewichtete Summe leitet sie aus ihren Termen ab
     */
    public static GroesseUrteil hauptgroesse(String typ, String art, String wertart, List<Term> terme) {
        if (GEWICHTETE_SUMME.equals(bekannterTyp(typ))) {
            return formelGroesse(terme == null ? List.of() : terme);
        }
        BilanzAbleitung.RichtungUrteil r = BilanzAbleitung.richtung(typ, art, wertart, terme);
        if (r.fehler() != null) {
            return new GroesseUrteil(fehler(r.fehler()), r.grund(), null);
        }
        return new GroesseUrteil(null, null, new Groesse(r.groesse(), r.richtung(), r.einheit(), r.wertart()));
    }

    private static Fehler fehler(String code) {
        for (Fehler f : Fehler.values()) {
            if (f.code().equals(code)) {
                return f;
            }
        }
        throw new IllegalStateException("Fehler-Code " + code + " steht nicht in der Fehlertabelle");
    }

    /**
     * Ein Eingang des Periodenwerts einer berechneten Messstelle: die Menge einer Messstelle mit dem,
     * was AP-08 an ihr sagt. Eine gewichtete Summe liest {@code vorzeichen} und {@code faktor}, ein
     * {@code rest} und ein {@code saldo} die Bilanz-{@code rolle} und den {@code anteil}.
     * {@code menge == null} heißt „keine Werte“ — nie „gemessen 0“.
     */
    public record Periodeneingang(
            String messstelle,
            String rolle,
            String anteil,
            String vorzeichen,
            BigDecimal faktor,
            BigDecimal menge,
            String zustand,
            Integer abdeckungProzent,
            int version,
            List<String> kennzeichen) {}

    /**
     * Der Periodenwert JE TYP (§4.5). {@code satz} ist der Kundensatz eines {@code rest}
     * („10 kWh sind keiner Messstelle zugeordnet“) bzw. die Anzeige „mindestens …“ einer
     * unvollständigen Summe; {@code fehler}/{@code grund} nennt, warum ein {@code saldo} keiner ist.
     */
    public record Periodenwert(
            String typ,
            BigDecimal menge,
            String zustand,
            Integer abdeckungProzent,
            List<String> fehlend,
            List<String> kennzeichen,
            String satz,
            String fehler,
            String grund) {}

    /**
     * §4.5 — der Periodenwert JE TYP, und die Fortpflanzung ist die des Typs: eine Summe rechnet mit
     * den vorhandenen Eingängen weiter („mindestens …“), eine Differenz ({@code rest}, {@code saldo})
     * bei einem nicht vollständigen Eingang gar nicht („keine Werte“). Gerechnet wird in
     * {@link BilanzAbleitung} ({@code summe}, {@code rest}, {@code saldo}) — hier wird nur verzweigt.
     *
     * @param zahlEbene die Ebene der Periode — sie bestimmt die Stellen des Kundensatzes (E11); für
     *     {@code saldo} ohne Satz ohne Bedeutung
     * @param version die Version des berechneten Werts (&gt; 1 nach einer Korrektur eines Eingangs)
     * @param vermerke was an dieser Periode zusätzlich zu sagen ist (etwa „Stellung geändert (…)“) —
     *     hereingereicht, nie erraten; nur der {@code rest} trägt sie
     */
    public static Periodenwert periodenwert(
            String typ, String art, String einheit, String zahlEbene, int version, List<String> vermerke,
            List<Periodeneingang> eingaenge) {
        return switch (bekannterTyp(typ)) {
            case GEWICHTETE_SUMME -> {
                BilanzAbleitung.SummeUrteil u = BilanzAbleitung.summe(einheit, zahlEbene, eingaenge.stream()
                        .map(e -> new BilanzAbleitung.Summand(e.messstelle(), e.menge(), e.zustand(),
                                e.abdeckungProzent(), e.version(), e.kennzeichen(), e.vorzeichen(), e.faktor()))
                        .toList());
                yield new Periodenwert(typ, u.menge(), u.zustand(), u.abdeckungProzent(), u.fehlend(),
                        u.kennzeichen(), u.anzeige(), null, null);
            }
            case REST -> {
                List<BilanzAbleitung.Eingang> bilanz = bilanzEingaenge(eingaenge);
                String hauptzaehler = bilanz.stream()
                        .filter(e -> BilanzAbleitung.ZUFLUSS.equals(e.rolle()))
                        .map(BilanzAbleitung.Eingang::messstelle)
                        .findFirst()
                        .orElse(null);
                BilanzAbleitung.RestUrteil u =
                        BilanzAbleitung.rest(hauptzaehler, einheit, zahlEbene, version, vermerke, bilanz);
                yield new Periodenwert(typ, u.menge(), u.zustand(), u.abdeckungProzent(), u.fehlend(),
                        u.kennzeichen(), u.kundensatz(), null, null);
            }
            default -> {
                BilanzAbleitung.SaldoUrteil u = BilanzAbleitung.saldo(einheit, art, bilanzEingaenge(eingaenge));
                yield new Periodenwert(typ, u.menge(), u.zustand(), u.abdeckungProzent(), u.fehlend(),
                        u.kennzeichen(), null, u.fehler(), u.grund());
            }
        };
    }

    private static List<BilanzAbleitung.Eingang> bilanzEingaenge(List<Periodeneingang> eingaenge) {
        return eingaenge.stream()
                .map(e -> new BilanzAbleitung.Eingang(e.messstelle(), e.rolle(), e.anteil(), e.menge(),
                        e.zustand(), e.abdeckungProzent(), e.version(), e.kennzeichen()))
                .toList();
    }

    private static double runde(double wert) {
        double faktor = Math.pow(10, SUMME_NACHKOMMASTELLEN);
        return Math.round(wert * faktor) / faktor;
    }
}
