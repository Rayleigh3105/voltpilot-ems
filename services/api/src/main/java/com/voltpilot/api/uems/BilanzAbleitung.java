package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Die ENERGIEBILANZ eines elektrischen Systems (UEMS AP-10 §4.3–§4.9) als reine Regel: aus der
 * zeitgültigen STELLUNG einer Messstelle wird ihre Bilanz-Rolle, aus den Rollen der Rest eines
 * Hauptzählers, und Zustand, Abdeckung, Kennzeichen und Version pflanzen sich fort.
 *
 * <p>Die EINE Wahrheit steht in {@code docs/contracts/v2/bilanz-vectors.json} (Prosa:
 * {@code bilanz.md}); der TS-Zwilling ist {@code frontend/portal/src/uemsBilanz.ts}. Wer eine
 * Regel ändert, ändert die Vektor-Datei UND beide Zwillinge.
 *
 * <p><b>Was diese Klasse NICHT tut:</b> sie baut die gewichtete Summe des Formel-Vertrags (PR #688,
 * {@code messstelle-formel.md}) nicht nach — {@link #richtung} und {@link #live} RUFEN
 * {@link MessstelleFormelRegeln} auf. Die Zustandswörter sind die der Verbrauchsregel AP-08
 * ({@link VerbrauchRegeln}); zwei Wortlaute für dieselbe Aussage wären genau die Drift, die diese
 * Verträge verhindern sollen.
 *
 * <p><b>Die Grenze des Captains:</b> ein Rest ist eine DIFFERENZ. Er heißt „nicht zugeordnet“ und
 * nennt nie eine Ursache — kein Verlust, kein Schwund, kein Gerät. Ein negativer Rest wird negativ
 * gezeigt, nie auf 0 geklemmt; {@code null} und 0 sehen nie gleich aus.
 *
 * <p>Rein: ohne Spring, ohne DB, ohne Uhr.
 */
public final class BilanzAbleitung {

    private BilanzAbleitung() {}

    // ------------------------------------------------------------------- Wörter und Schwellen

    /** Die Zustandswörter sind die der Verbrauchsregel — nie ein zweiter Wortlaut. */
    public static final String VOLLSTAENDIG = VerbrauchRegeln.VOLLSTAENDIG;

    public static final String UNVOLLSTAENDIG = VerbrauchRegeln.UNVOLLSTAENDIG;
    public static final String KEINE_WERTE = VerbrauchRegeln.KEINE_WERTE;
    public static final String MIT_ERSATZWERT = "mit Ersatzwert";

    /** Von gut nach schlecht; der „schlechteste Eingang“ ist der letzte vorkommende. */
    public static final List<String> ZUSTAND_RANG =
            List.of(VOLLSTAENDIG, MIT_ERSATZWERT, UNVOLLSTAENDIG, KEINE_WERTE);

    /** Bis hierher (einschließlich) rechnet eine Differenz; danach gibt es „keine Werte“. */
    private static final int RANG_RECHENBAR = ZUSTAND_RANG.indexOf(MIT_ERSATZWERT);

    public static final int MENGE_NACHKOMMASTELLEN = 6;
    public static final String TAUSENDER_TRENNZEICHEN = " ";
    /** U+2212 — das Minuszeichen der Kundensätze, nicht der ASCII-Bindestrich. */
    public static final String MINUS = "−";

    public static final String BERECHNET_DIFFERENZ = "berechnet (Differenz)";
    public static final String BERECHNET_SUMME = "berechnet (Summe)";
    public static final String BERECHNET_SALDO = "berechnet (Saldo)";
    public static final String NICHT_ZUGEORDNET = "nicht zugeordnet";
    public static final String UNPLAUSIBEL_NEGATIV = "unplausibel (negativ)";
    /** Das Katalog-Wort steht EINMAL — im Größen-Katalog der Messstelle (AP-10 IP-4). */
    public static final String SALDIERT = MessstelleRegeln.SALDIERT;
    public static final String SALDIERT_KENNZEICHEN = "saldiert (Bezug − Abgabe)";

    /**
     * Die Kundensätze des Rests, WÖRTLICH die Vorlagen aus {@code saetze} der Vektor-Datei
     * ({@code rest_zugeordnet}, {@code rest_negativ}, {@code rest_keine_werte}); der Test hält
     * sie dort fest. Ein Rest heißt „nicht zugeordnet“ — nie „Verlust“, und er nennt keine Ursache.
     */
    public static final String SATZ_REST_ZUGEORDNET = "{menge} {einheit} sind keiner Messstelle zugeordnet";
    public static final String SATZ_REST_NEGATIV = "Messwerte passen nicht zusammen ({menge} {einheit})";
    public static final String SATZ_REST_KEINE_WERTE = "nicht zugeordnet: keine Werte";

    /** Wörter, die eine URSACHE behaupten — kein Satz dieses Vertrags darf sie tragen. */
    public static final List<String> VERBOTENE_WOERTER =
            List.of("Verlust", "Verluste", "Verlusten", "Schwund", "Diebstahl", "Leckage");

    /**
     * Was ein berechneter Wert von einem Eingang ERBT: was über die PERIODE spricht, nicht was über
     * einen einzelnen Messwert spricht. Alles andere bleibt am Eingang und ist nur in der Herkunft
     * sichtbar.
     */
    public record Erbregel(Pattern muster, String als) {}

    public static final List<Erbregel> KENNZEICHEN_ERBEND = List.of(
            new Erbregel(Pattern.compile("^ab \\d{2}\\.\\d{2}\\.\\d{4}$"), "{0}"),
            new Erbregel(Pattern.compile("^mit Ersatzwert$"), "{0}"),
            new Erbregel(Pattern.compile("^verteilt \\(.+\\)$"), "enthält {0}"));

    // -------------------------------------------------------------------------- Bilanz-Rolle

    public static final String ZUFLUSS = "zufluss";
    public static final String ABFLUSS = "abfluss";
    public static final String ZUGEORDNET = "zugeordnet";
    public static final String AUSSERHALB = "ausserhalb";

    /** Die Stellung einer Messstelle an einem Tag, so wie AP-04 sie führt. */
    public record RolleEingang(
            String stellung, String richtung, String art, String medium, String unterzaehlerVon) {}

    public record RolleAnteil(String rolle, String anteil) {}

    /** {@code rollen} leer heißt: diese Messstelle kommt in KEINER Bilanz vor — {@code grund} sagt warum. */
    public record RolleUrteil(List<RolleAnteil> rollen, String ziel, String grund) {}

    private static RolleUrteil keineRolle(String grund) {
        return new RolleUrteil(List.of(), null, grund);
    }

    /**
     * §4.3 — die Bilanz-Rolle wird aus der Stellung ABGELEITET, nie gewählt. Ein Speicher mit der
     * Richtung „Laden / Entladen“ geht mit ZWEI Anteilen ein (E4): der positive ist ein Abfluss,
     * der negative ein Zufluss — nie als Saldo, nie nur mit einer Hälfte.
     */
    public static RolleUrteil rolle(RolleEingang e) {
        if (MessstelleRegeln.BERECHNET.equals(e.art())) {
            return keineRolle("berechnet");
        }
        if (!"Strom".equals(e.medium())) {
            return keineRolle("medium");
        }
        if ("keine".equals(e.stellung())) {
            return keineRolle("keine_stellung");
        }
        return switch (e.stellung()) {
            case "Abzweig" -> new RolleUrteil(
                    List.of(new RolleAnteil(AUSSERHALB, "gesamt")), null, "kein_vorgaenger");
            case "Hauptzähler" -> switch (String.valueOf(e.richtung())) {
                case "Bezug" -> einfach(ZUFLUSS);
                case "Abgabe" -> einfach(ABFLUSS);
                default -> keineRolle("richtung_unbestimmt");
            };
            case "Erzeuger" -> einfach(ZUFLUSS);
            case "Speicher" -> switch (String.valueOf(e.richtung())) {
                case "Laden / Entladen" -> new RolleUrteil(
                        List.of(new RolleAnteil(ABFLUSS, "positiv"), new RolleAnteil(ZUFLUSS, "negativ")),
                        null, null);
                case "Laden" -> einfach(ABFLUSS);
                case "Entladen" -> einfach(ZUFLUSS);
                default -> keineRolle("richtung_unbestimmt");
            };
            case "Unterzähler" -> e.unterzaehlerVon() == null
                    ? keineRolle("kein_vorgaenger")
                    : new RolleUrteil(List.of(new RolleAnteil(ZUGEORDNET, "gesamt")), e.unterzaehlerVon(), null);
            default -> keineRolle("keine_stellung");
        };
    }

    private static RolleUrteil einfach(String rolle) {
        return new RolleUrteil(List.of(new RolleAnteil(rolle, "gesamt")), null, null);
    }

    // ----------------------------------------------------------------------------- Eingänge

    /**
     * Ein Eingang einer Bilanz: eine Messstelle mit ihrer Rolle und dem, was AP-08 an ihrem
     * Periodenwert sagt. {@code menge == null} heißt „keine Werte“ — nie „gemessen 0“.
     */
    public record Eingang(
            String messstelle,
            String rolle,
            String anteil,
            BigDecimal menge,
            String zustand,
            Integer abdeckungProzent,
            int version,
            List<String> kennzeichen) {}

    private static int rang(String zustand) {
        int i = ZUSTAND_RANG.indexOf(zustand);
        if (i < 0) {
            throw new IllegalArgumentException("unbekannter Zustand " + zustand + " — bekannt sind "
                    + ZUSTAND_RANG);
        }
        return i;
    }

    private static String schlechtester(List<String> zustaende) {
        String schlecht = VOLLSTAENDIG;
        for (String z : zustaende) {
            if (rang(z) > rang(schlecht)) {
                schlecht = z;
            }
        }
        return schlecht;
    }

    private static Integer kleinsteAbdeckung(List<Integer> werte) {
        Integer min = null;
        for (Integer w : werte) {
            if (w != null && (min == null || w < min)) {
                min = w;
            }
        }
        return min;
    }

    /** Die geerbten Kennzeichen der Eingänge, in der Reihenfolge ihres ersten Vorkommens. */
    private static List<String> geerbt(List<List<String>> kennzeichen) {
        LinkedHashSet<String> raus = new LinkedHashSet<>();
        for (List<String> liste : kennzeichen) {
            for (String k : liste) {
                for (Erbregel regel : KENNZEICHEN_ERBEND) {
                    if (regel.muster().matcher(k).matches()) {
                        raus.add(regel.als().replace("{0}", k));
                        break;
                    }
                }
            }
        }
        return List.copyOf(raus);
    }

    private static BigDecimal summiere(List<Eingang> eingaenge, String rolle) {
        BigDecimal summe = BigDecimal.ZERO;
        for (Eingang e : eingaenge) {
            if (e.rolle().equals(rolle)) {
                summe = summe.add(e.menge());
            }
        }
        return summe.stripTrailingZeros();
    }

    // ---------------------------------------------------------------------------------- Rest

    /**
     * Der Rest eines Hauptzählers. {@code menge == null} heißt „keine Werte“; {@code fehlend} nennt
     * die Eingänge, die dazu geführt haben.
     */
    public record RestUrteil(
            BigDecimal zufluss,
            BigDecimal abfluss,
            BigDecimal zugeordnet,
            BigDecimal verbrauchSystem,
            BigDecimal menge,
            String groesse,
            String richtung,
            String einheit,
            String zustand,
            Integer abdeckungProzent,
            List<String> fehlend,
            List<String> kennzeichen,
            String kundensatz) {}

    /**
     * §4.3 — {@code Rest(X, T) = Σ Zufluss − Σ Abfluss − Σ zugeordnet(X)}, Ergebnis fest
     * Wirkenergie · Bezug (E1). §4.5 Zeile „Differenz“: vollständig nur, wenn ALLE Eingänge
     * vollständig sind; sonst „keine Werte“ und Menge {@code null} — nie eine um den fehlenden
     * Eingang verkleinerte Differenz, die zu HOCH wäre.
     *
     * @param vermerke was an dieser Periode zusätzlich zu sagen ist (etwa eine geänderte Stellung);
     *     sie werden nie erraten, sondern von dem hereingereicht, der die Änderung kennt
     */
    public static RestUrteil rest(
            String hauptzaehler, String einheit, int version, List<String> vermerke, List<Eingang> eingaenge) {
        List<String> fehlend = new ArrayList<>();
        for (Eingang e : eingaenge) {
            if ((e.menge() == null || rang(e.zustand()) > RANG_RECHENBAR) && !fehlend.contains(e.messstelle())) {
                fehlend.add(e.messstelle());
            }
        }
        String zustand = schlechtester(eingaenge.stream().map(Eingang::zustand).toList());
        Integer abdeckung = kleinsteAbdeckung(eingaenge.stream().map(Eingang::abdeckungProzent).toList());
        RichtungUrteil richtung = richtung("rest", MessstelleRegeln.BERECHNET, "Intervallmenge", null);

        List<String> kennzeichen = new ArrayList<>(List.of(BERECHNET_DIFFERENZ));
        if (!fehlend.isEmpty()) {
            kennzeichen.add(KEINE_WERTE);
            kennzeichen.addAll(geerbt(eingaenge.stream().map(Eingang::kennzeichen).toList()));
            kennzeichen.addAll(vermerke);
            if (version > 1) {
                kennzeichen.add(korrigiert(version));
            }
            return new RestUrteil(null, null, null, null, null, richtung.groesse(), richtung.richtung(),
                    einheit, KEINE_WERTE, abdeckung, List.copyOf(fehlend), List.copyOf(kennzeichen),
                    SATZ_REST_KEINE_WERTE);
        }

        BigDecimal zufluss = summiere(eingaenge, ZUFLUSS);
        BigDecimal abfluss = summiere(eingaenge, ABFLUSS);
        BigDecimal zugeordnet = summiere(eingaenge, ZUGEORDNET);
        BigDecimal verbrauch = zufluss.subtract(abfluss).stripTrailingZeros();
        BigDecimal menge = verbrauch.subtract(zugeordnet)
                .setScale(MENGE_NACHKOMMASTELLEN, RoundingMode.HALF_UP)
                .stripTrailingZeros();
        boolean negativ = menge.signum() < 0;
        kennzeichen.add(negativ ? UNPLAUSIBEL_NEGATIV : NICHT_ZUGEORDNET);
        kennzeichen.addAll(geerbt(eingaenge.stream().map(Eingang::kennzeichen).toList()));
        kennzeichen.addAll(vermerke);
        if (version > 1) {
            kennzeichen.add(korrigiert(version));
        }
        String satz = (negativ ? SATZ_REST_NEGATIV : SATZ_REST_ZUGEORDNET)
                .replace("{menge}", zahlDe(menge))
                .replace("{einheit}", einheit);
        return new RestUrteil(zufluss, abfluss, zugeordnet, verbrauch, menge, richtung.groesse(),
                richtung.richtung(), einheit, zustand, abdeckung, List.of(), List.copyOf(kennzeichen), satz);
    }

    private static String korrigiert(int version) {
        return "korrigiert (Version " + version + ")";
    }

    // ------------------------------------------------------------------- Rest aus der Stellung

    /** Fehler: an diesem Tag ist die Messstelle kein Hauptzähler Bezug — es gibt keinen Rest (§4.3). */
    public static final String REST_OHNE_HAUPTZAEHLER = "rest_ohne_hauptzaehler";

    /**
     * Eine zeitgültige elektrische Stellung einer Messstelle (AP-04 {@code messstelle_stellung}), mit
     * den Merkmalen der Messstelle, die die Rolle braucht. {@code ab}/{@code bis} sind TAGE, der
     * letzte Tag gehört dazu; {@code null} heißt offen.
     */
    public record StellungZeile(
            String messstelle,
            String anlage,
            String stellung,
            String richtung,
            String art,
            String medium,
            String unterzaehlerVon,
            LocalDate ab,
            LocalDate bis) {

        boolean gilt(LocalDate tag) {
            return (ab == null || !tag.isBefore(ab)) && (bis == null || !tag.isAfter(bis));
        }
    }

    /** Ein Term des Rests: welche Messstelle mit welcher Rolle und welchem Anteil eingeht. */
    public record RestTerm(String messstelle, String rolle, String anteil) {}

    /**
     * Die Fassung eines Rests an EINEM Tag, aus der Stellung abgeleitet. {@code fehler != null} heißt:
     * an diesem Tag gibt es keinen Rest ({@code terme} leer). {@code ausserhalb} nennt die Abzweige
     * desselben Systems — gemessen, aber in keiner Bilanz (die Sicht nennt sie).
     */
    public record RestFassung(
            String hauptzaehler, String anlage, List<RestTerm> terme, List<String> ausserhalb, String fehler) {}

    /**
     * §4.3 / E3 — der Rest eines Hauptzählers X an einem TAG, aus den Stellungen dieses Tages: Ein
     * {@code rest} speichert keine Terme. Zieht ein Unterzähler um, ändern sich beide Reste am selben
     * Tag, ohne dass jemand eine Formel anfasst (F7).
     *
     * <ul>
     *   <li>X muss an dem Tag Hauptzähler mit der Rolle Zufluss sein (Richtung Bezug), sonst
     *       {@link #REST_OHNE_HAUPTZAEHLER}.
     *   <li>Zufluss und Abfluss sind X selbst und die Erzeuger, Speicher (mit beiden Anteilen, E4) und
     *       der Hauptzähler Abgabe DESSELBEN Systems (Anlage). Einen zweiten Hauptzähler Bezug lässt
     *       der Messstellen-Vertrag §6 nicht zu (höchstens einer je Anlage und Richtung); stünde doch
     *       einer da, ginge er nicht als zweiter Zufluss ein.
     *   <li>Zugeordnet sind genau die Unterzähler VON X — ein Unterzähler eines Unterzählers zählt im
     *       Rest von X nicht doppelt.
     *   <li>Berechnete Messstellen, andere Medien und „keine“ Stellung gehen nie ein ({@link #rolle}).
     * </ul>
     *
     * <p>Die Reihenfolge der Terme ist Zufluss (X zuerst) · Abfluss · zugeordnet, je in der
     * Reihenfolge der Zeilen; sie ändert keine Zahl. Vermerke wie „Stellung geändert (…)“ leitet
     * diese Regel NICHT ab — sie werden von dem hereingereicht, der die Änderung kennt.
     */
    public static RestFassung restAusStellung(
            String hauptzaehler, LocalDate tag, List<StellungZeile> zeilen) {
        List<StellungZeile> amTag = zeilen.stream().filter(z -> z.gilt(tag)).toList();
        StellungZeile x = amTag.stream()
                .filter(z -> z.messstelle().equals(hauptzaehler))
                .findFirst()
                .orElse(null);
        if (x == null || !"Hauptzähler".equals(x.stellung())
                || !List.of(new RolleAnteil(ZUFLUSS, "gesamt")).equals(rolle(eingangVon(x)).rollen())) {
            return new RestFassung(hauptzaehler, null, List.of(), List.of(), REST_OHNE_HAUPTZAEHLER);
        }
        List<RestTerm> zufluss = new ArrayList<>(List.of(new RestTerm(x.messstelle(), ZUFLUSS, "gesamt")));
        List<RestTerm> abfluss = new ArrayList<>();
        List<RestTerm> zugeordnet = new ArrayList<>();
        List<String> ausserhalb = new ArrayList<>();
        for (StellungZeile z : amTag) {
            if (z.messstelle().equals(x.messstelle())) {
                continue;
            }
            RolleUrteil u = rolle(eingangVon(z));
            if (hauptzaehler.equals(u.ziel())) {
                zugeordnet.add(new RestTerm(z.messstelle(), ZUGEORDNET, "gesamt"));
                continue;
            }
            boolean imSystem = x.anlage() != null && x.anlage().equals(z.anlage());
            boolean zweiterBezug = "Hauptzähler".equals(z.stellung()) && "Bezug".equals(z.richtung());
            if (!imSystem || u.ziel() != null || zweiterBezug) {
                continue;
            }
            for (RolleAnteil r : u.rollen()) {
                switch (r.rolle()) {
                    case ZUFLUSS -> zufluss.add(new RestTerm(z.messstelle(), ZUFLUSS, r.anteil()));
                    case ABFLUSS -> abfluss.add(new RestTerm(z.messstelle(), ABFLUSS, r.anteil()));
                    case AUSSERHALB -> ausserhalb.add(z.messstelle());
                    default -> { }
                }
            }
        }
        List<RestTerm> terme = new ArrayList<>(zufluss);
        terme.addAll(abfluss);
        terme.addAll(zugeordnet);
        return new RestFassung(hauptzaehler, x.anlage(), List.copyOf(terme), List.copyOf(ausserhalb), null);
    }

    private static RolleEingang eingangVon(StellungZeile z) {
        return new RolleEingang(z.stellung(), z.richtung(), z.art(), z.medium(), z.unterzaehlerVon());
    }

    // --------------------------------------------------------------------------------- Summe

    /** Ein Summand einer gewichteten Summe auf der MENGEN-Ebene (der Live-Wert läuft über {@link #live}). */
    public record Summand(
            String messstelle,
            BigDecimal menge,
            String zustand,
            Integer abdeckungProzent,
            int version,
            List<String> kennzeichen,
            String vorzeichen,
            BigDecimal faktor) {}

    public record SummeUrteil(
            BigDecimal menge,
            String zustand,
            Integer abdeckungProzent,
            int vorhanden,
            int gesamt,
            List<String> fehlend,
            List<String> kennzeichen,
            String anzeige) {}

    /**
     * §4.5 Zeile „Summe“ — die Summe der VORHANDENEN Eingänge, Zustand „schlechtester Eingang“;
     * fehlt einer, heißt die Zahl „mindestens …“ und NENNT ihn. Eine Summe verschweigt nie einen
     * Summanden: die Anzeige sagt, dass sie eine Untergrenze ist.
     */
    public static SummeUrteil summe(String einheit, List<Summand> eingaenge) {
        BigDecimal menge = BigDecimal.ZERO;
        int vorhanden = 0;
        List<String> fehlend = new ArrayList<>();
        for (Summand s : eingaenge) {
            if (s.menge() == null || rang(s.zustand()) > RANG_RECHENBAR) {
                if (!fehlend.contains(s.messstelle())) {
                    fehlend.add(s.messstelle());
                }
                continue;
            }
            BigDecimal teil = s.menge().multiply(s.faktor());
            menge = "-".equals(s.vorzeichen()) ? menge.subtract(teil) : menge.add(teil);
            vorhanden++;
        }
        menge = menge.setScale(MENGE_NACHKOMMASTELLEN, RoundingMode.HALF_UP).stripTrailingZeros();
        // Eine Summe mit noch einem Wert ist HÖCHSTENS „unvollständig“: „keine Werte“ heißt sie
        // erst, wenn KEIN Eingang einen Wert hat — sonst sähen 1 055 kWh und gar nichts gleich aus.
        String zustand = schlechtester(eingaenge.stream().map(Summand::zustand).toList());
        if (vorhanden == 0) {
            zustand = KEINE_WERTE;
        } else if (rang(zustand) > rang(UNVOLLSTAENDIG)) {
            zustand = UNVOLLSTAENDIG;
        }
        Integer abdeckung = kleinsteAbdeckung(eingaenge.stream().map(Summand::abdeckungProzent).toList());
        List<String> kennzeichen = new ArrayList<>(List.of(BERECHNET_SUMME));
        kennzeichen.addAll(geerbt(eingaenge.stream().map(Summand::kennzeichen).toList()));
        String anzeige = fehlend.isEmpty()
                ? null
                : "mindestens " + zahlDe(menge) + " " + einheit + " (" + String.join(", ", fehlend) + " "
                        + (fehlend.size() == 1 ? "fehlt" : "fehlen") + ")";
        return new SummeUrteil(menge, zustand, abdeckung, vorhanden, eingaenge.size(),
                List.copyOf(fehlend), List.copyOf(kennzeichen), anzeige);
    }

    // --------------------------------------------------------------------------------- Saldo

    public record SaldoUrteil(
            BigDecimal menge,
            String groesse,
            String richtung,
            String einheit,
            String zustand,
            Integer abdeckungProzent,
            List<String> fehlend,
            List<String> kennzeichen,
            String fehler,
            String grund) {}

    /**
     * §4.4/§4.5 — genau zwei Eingänge derselben Grenze: Bezug minus Abgabe. Das Ergebnis ist
     * Wirkenergie · {@code saldiert}, ein Katalog-Eintrag NUR für berechnete Messstellen. Ein Saldo
     * geht nie als Zufluss in eine Rest-Bilanz ein — dort zählen Bezug und Abgabe einzeln.
     */
    public static SaldoUrteil saldo(String einheit, String art, List<Eingang> eingaenge) {
        RichtungUrteil richtung = richtung("saldo", art, "Intervallmenge", null);
        long bezug = eingaenge.stream().filter(e -> ZUFLUSS.equals(e.rolle())).count();
        long abgabe = eingaenge.stream().filter(e -> ABFLUSS.equals(e.rolle())).count();
        if (richtung.fehler() != null || eingaenge.size() != 2 || bezug != 1 || abgabe != 1) {
            String grund = richtung.fehler() != null ? richtung.grund() : "saldo_braucht_zwei";
            return new SaldoUrteil(null, null, null, null, null, null, List.of(), List.of(),
                    MessstelleFormelRegeln.Fehler.GROESSEN_GEMISCHT.code(), grund);
        }
        List<String> fehlend = eingaenge.stream()
                .filter(e -> e.menge() == null || rang(e.zustand()) > RANG_RECHENBAR)
                .map(Eingang::messstelle)
                .distinct()
                .toList();
        String zustand = schlechtester(eingaenge.stream().map(Eingang::zustand).toList());
        Integer abdeckung = kleinsteAbdeckung(eingaenge.stream().map(Eingang::abdeckungProzent).toList());
        List<String> kennzeichen = new ArrayList<>(List.of(BERECHNET_SALDO, SALDIERT_KENNZEICHEN));
        kennzeichen.addAll(geerbt(eingaenge.stream().map(Eingang::kennzeichen).toList()));
        if (!fehlend.isEmpty()) {
            return new SaldoUrteil(null, richtung.groesse(), richtung.richtung(), einheit, KEINE_WERTE,
                    abdeckung, fehlend, List.copyOf(kennzeichen), null, null);
        }
        BigDecimal menge = summiere(eingaenge, ZUFLUSS)
                .subtract(summiere(eingaenge, ABFLUSS))
                .setScale(MENGE_NACHKOMMASTELLEN, RoundingMode.HALF_UP)
                .stripTrailingZeros();
        return new SaldoUrteil(menge, richtung.groesse(), richtung.richtung(), einheit, zustand, abdeckung,
                List.of(), List.copyOf(kennzeichen), null, null);
    }

    // ------------------------------------------------------------------------------ Richtung

    public record RichtungUrteil(
            String groesse, String richtung, String einheit, String wertart, String fehler, String grund) {}

    /**
     * E1 — die Ergebnis-Richtung ist JE TYP eine Regel, keine Ableitung aus Vorzeichen: 100 minus
     * 60 minus 30 ergibt 10 kWh <b>Bezug</b>, nicht „richtungslos“.
     *
     * <ul>
     *   <li>{@code gewichtete_summe}: unverändert der Formel-Vertrag (PR #688) — hier wird
     *       {@link MessstelleFormelRegeln#formelGroesse} AUFGERUFEN, nie nachgebaut.
     *   <li>{@code rest}: fest Wirkenergie · Bezug. Der Live-Wert ist ein Momentanwert und trägt die
     *       Katalog-Richtung der Wirkleistung ({@code richtungslos}).
     *   <li>{@code saldo}: Wirkenergie · {@code saldiert} — zulässig NUR für {@code art = berechnet},
     *       nie an einem Messkanal bindbar.
     * </ul>
     */
    public static RichtungUrteil richtung(
            String typ, String art, String wertart, List<MessstelleFormelRegeln.Term> terme) {
        return switch (typ) {
            case "gewichtete_summe" -> {
                MessstelleFormelRegeln.GroesseUrteil u =
                        MessstelleFormelRegeln.formelGroesse(terme == null ? List.of() : terme);
                if (u.fehler() != null) {
                    yield new RichtungUrteil(null, null, null, null, u.fehler().code(), u.grund());
                }
                MessstelleRegeln.Groesse g = u.hauptgroesse();
                yield g == null
                        ? new RichtungUrteil(null, null, null, null, null, null)
                        : new RichtungUrteil(g.groesse(), g.richtung(), g.einheit(), g.wertart(), null, null);
            }
            case "rest" -> "Momentanwert".equals(wertart)
                    ? new RichtungUrteil("Wirkleistung", "richtungslos", "kW", "Momentanwert", null, null)
                    : new RichtungUrteil("Wirkenergie", "Bezug", "kWh", wertart, null, null);
            // Ob `saldiert` an dieser Messstelle stehen darf, sagt der KATALOG (AP-10 IP-4) — nicht
            // eine zweite Liste hier: nur `art = berechnet` darf die Richtung tragen.
            case "saldo" -> MessstelleRegeln.groessePruefen("Strom", art,
                            new MessstelleRegeln.Groesse("Wirkenergie", SALDIERT, "kWh", "Intervallmenge"))
                    .fehler() == null
                    ? new RichtungUrteil("Wirkenergie", SALDIERT, "kWh", wertart, null, null)
                    : new RichtungUrteil(null, null, null, null,
                            MessstelleFormelRegeln.Fehler.GROESSEN_GEMISCHT.code(), "saldiert_nur_berechnet");
            default -> throw new IllegalArgumentException("unbekannter Formel-Typ " + typ);
        };
    }

    // --------------------------------------------------------------------------------- Ebene

    /** Ein System (eine Anlage) als Zeile einer Standort- oder Unternehmens-Summe. */
    public record SystemZeile(
            String anlage,
            String kurzname,
            String messstelle,
            BigDecimal menge,
            String zustand,
            Integer abdeckungProzent,
            int version,
            List<String> kennzeichen) {}

    public record EbeneUrteil(
            BigDecimal menge,
            String zustand,
            Integer abdeckungProzent,
            int mitWerten,
            int gesamt,
            List<String> fehlend,
            List<String> kennzeichen,
            List<String> anzeigeKennzeichen) {}

    /**
     * §4.8 — Standort und Unternehmen bilanzieren als SUMME über ihre Systeme, mit „x von y“ und
     * OHNE eigenen Rest: ein Standort hat keine eigene Bilanzgrenze. Das geerbte Kennzeichen eines
     * Systems wird in der Anzeige seinem Namen vorangestellt („Lindach ab 15.10.2026“) — an der
     * Zahl selbst steht nur, was die Regel sagt.
     */
    public static EbeneUrteil ebene(String einheit, String wort, List<SystemZeile> systeme) {
        SummeUrteil s = summe(einheit, systeme.stream()
                .map(z -> new Summand(z.messstelle(), z.menge(), z.zustand(), z.abdeckungProzent(),
                        z.version(), List.of(), "+", BigDecimal.ONE))
                .toList());
        List<String> kennzeichen =
                List.of(BERECHNET_SUMME, s.vorhanden() + " von " + systeme.size() + " " + wort);
        List<String> anzeige = new ArrayList<>();
        for (SystemZeile z : systeme) {
            for (String k : geerbt(List.of(z.kennzeichen()))) {
                anzeige.add(z.kurzname() + " " + k);
            }
        }
        return new EbeneUrteil(s.menge(), s.zustand(), s.abdeckungProzent(), s.vorhanden(), systeme.size(),
                s.fehlend(), kennzeichen, List.copyOf(anzeige));
    }

    // ---------------------------------------------------------------------------- Live-Wert

    /** Ein Term des Live-Werts; {@code grund} sagt, WARUM ein Wert fehlt (nie geraten). */
    public record LiveTerm(
            String messstelle, String vorzeichen, double faktor, Double wert, String einheit, String grund) {}

    public record Fehlender(String term, String grund) {}

    public record LiveUrteil(Double wert, boolean unvollstaendig, List<Fehlender> fehlende) {}

    /**
     * §4.5 letzte Zeile — der Live-Wert ist {@code null} statt einer Teilsumme; die Antwort nennt,
     * welcher Term fehlt und warum. Gerechnet wird mit
     * {@link MessstelleFormelRegeln#gewichteteSumme} (PR #688) — dieselbe Summe wie im
     * Formel-Vertrag, nicht eine zweite.
     */
    public static LiveUrteil live(String einheit, List<LiveTerm> terme) {
        MessstelleFormelRegeln.SummeUrteil u = MessstelleFormelRegeln.gewichteteSumme(einheit,
                terme.stream()
                        .map(t -> new MessstelleFormelRegeln.Summand(
                                t.vorzeichen(), t.faktor(), t.wert(), t.einheit()))
                        .toList());
        List<Fehlender> fehlende = u.fehlende().stream()
                .map(i -> new Fehlender(terme.get(i).messstelle(),
                        terme.get(i).grund() == null ? "kein_wert" : terme.get(i).grund()))
                .toList();
        return new LiveUrteil(u.wert(), u.unvollstaendig(), fehlende);
    }

    // ------------------------------------------------------------------------ Gebäude-Sicht

    public record GebaeudeZeile(String messstelle, String rolle, BigDecimal menge, boolean imGebaeude) {}

    public record GebaeudeUrteil(
            BigDecimal gemessenImGebaeude,
            BigDecimal imSystemAusserhalb,
            BigDecimal restNichtVerortet,
            BigDecimal zuflussImGebaeude,
            BigDecimal gebaeudeverbrauch,
            String grund) {}

    /**
     * §4.8 — ein Gebäude ist eine SICHT (Ort × Stellung), keine Bilanzgrenze: es gibt gemessene
     * Zeilen im Gebäude, Zeilen desselben Systems außerhalb und den Rest des Systems als „nicht
     * verortet“. {@code gebaeudeverbrauch} ist deshalb IMMER {@code null} — eine Summe daraus wäre
     * eine Behauptung, für die es keinen Messwert gibt.
     */
    public static GebaeudeUrteil gebaeude(
            String gebaeude, String anlage, String einheit, List<GebaeudeZeile> zeilen, BigDecimal rest) {
        BigDecimal drin = BigDecimal.ZERO;
        BigDecimal draussen = BigDecimal.ZERO;
        BigDecimal zufluss = null;
        for (GebaeudeZeile z : zeilen) {
            if (ZUGEORDNET.equals(z.rolle())) {
                if (z.imGebaeude()) {
                    drin = drin.add(z.menge());
                } else {
                    draussen = draussen.add(z.menge());
                }
            } else if (ZUFLUSS.equals(z.rolle()) && z.imGebaeude()) {
                zufluss = zufluss == null ? z.menge() : zufluss.add(z.menge());
            }
        }
        return new GebaeudeUrteil(drin.stripTrailingZeros(), draussen.stripTrailingZeros(), rest,
                zufluss == null ? null : zufluss.stripTrailingZeros(), null, "kein_gebaeude_rest");
    }

    // --------------------------------------------------------------------------- Versorgung

    /** Wo eine Messstelle an einem Tag hängt: ihr Ort und der Weg von dort zur Wurzel. */
    public record Verortung(String messstelle, String anlage, String stellung, List<String> ortPfad) {}

    public record VersorgungUrteil(
            Map<String, List<String>> versorgt, List<String> ausserhalbGebaeude, List<String> nichtMessbar) {}

    /**
     * §4.8/AP-00 Inv. 9 — „System AN versorgt Gebäude G an T“ gilt genau dann, wenn eine Messstelle
     * mit Stellung ≠ „keine“ in AN an T ihren Ort in G oder darunter hat. Es gibt kein gepflegtes
     * Feld: eine Messstelle ohne Gebäude wird GENANNT, ein Gebäude ohne Messstelle heißt „nicht
     * messbar“ — nie „versorgt von …“.
     */
    public static VersorgungUrteil versorgung(
            String tag, List<String> gebaeude, List<Verortung> messstellen) {
        Map<String, List<String>> versorgt = new LinkedHashMap<>();
        List<String> ausserhalb = new ArrayList<>();
        LinkedHashSet<String> messbar = new LinkedHashSet<>();
        for (Verortung v : messstellen) {
            if ("keine".equals(v.stellung())) {
                continue;
            }
            String g = v.ortPfad().stream().filter(gebaeude::contains).findFirst().orElse(null);
            if (g == null) {
                ausserhalb.add(v.messstelle());
                continue;
            }
            messbar.add(g);
            List<String> liste = versorgt.computeIfAbsent(v.anlage(), k -> new ArrayList<>());
            if (!liste.contains(g)) {
                liste.add(g);
            }
        }
        Map<String, List<String>> fertig = new LinkedHashMap<>();
        versorgt.forEach((anlage, liste) -> {
            List<String> sortiert = new ArrayList<>(liste);
            sortiert.sort(String::compareTo);
            fertig.put(anlage, List.copyOf(sortiert));
        });
        List<String> nichtMessbar = gebaeude.stream().filter(g -> !messbar.contains(g)).toList();
        return new VersorgungUrteil(Map.copyOf(fertig), List.copyOf(ausserhalb), nichtMessbar);
    }

    // -------------------------------------------------------------------------------- Zahlen

    /**
     * Die Zahl eines Kundensatzes: Tausender mit Leerzeichen, Minuszeichen U+2212. Sie steht nur in
     * SÄTZEN — die Beträge des Vertrags reisen als Dezimaltext.
     */
    public static String zahlDe(BigDecimal wert) {
        BigDecimal betrag = wert.abs().stripTrailingZeros();
        String klartext = betrag.toPlainString();
        int punkt = klartext.indexOf('.');
        String ganz = punkt < 0 ? klartext : klartext.substring(0, punkt);
        String rest = punkt < 0 ? "" : klartext.substring(punkt + 1);
        StringBuilder gruppiert = new StringBuilder();
        for (int i = 0; i < ganz.length(); i++) {
            if (i > 0 && (ganz.length() - i) % 3 == 0) {
                gruppiert.append(TAUSENDER_TRENNZEICHEN);
            }
            gruppiert.append(ganz.charAt(i));
        }
        String text = gruppiert.toString();
        if (!rest.isEmpty()) {
            text = text + "," + rest;
        }
        return (wert.signum() < 0 ? MINUS : "") + text;
    }
}
