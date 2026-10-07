package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeSet;

/**
 * Was eine Kostenstelle verbraucht hat — und was NIEMANDEM gehört (UEMS AP-10 IP-11, E12) — als reine Regel.
 *
 * <p><b>Vier Herkünfte, nie vermischt:</b>
 * <ul>
 *   <li><b>gemessen</b> — eine gemessene Messstelle geht an diesem Tag zu 100 % an die Kostenstelle;</li>
 *   <li><b>verteilt</b> — eine gemessene Messstelle geht zu einem Anteil unter 100 % an sie (ein Mensch hat ihn
 *       gesetzt);</li>
 *   <li><b>berechnet</b> — eine berechnete Messstelle (Summe, Rest) geht an sie, gleich zu welchem Anteil: sie wird
 *       durch die Verteilung nicht gemessen ({@link VerteilungRegeln#erbe});</li>
 *   <li><b>nicht verteilt</b> — eine Messstelle hat an einem Tag einen Wert, aber KEINE Verteilungszeile. Dieser Block
 *       gehört keiner Kostenstelle: er steht in jeder Kostenstellen-Sicht daneben, wird NIE auf Kostenstellen
 *       aufgeteilt und NIE weggelassen. Eine Summe der Kostenstellen, die den Gesamtverbrauch trifft, weil der Rest
 *       still verteilt wurde, wäre eine Lüge mit stimmiger Summe.</li>
 * </ul>
 *
 * <p><b>Tagesanteile (E12):</b> jeder Tag wird mit SEINEM Anteil verteilt ({@link VerteilungRegeln#amTag} und
 * {@link VerteilungRegeln#erbe} je Tag); die Menge über die Periode ist die Summe der verteilten Tage
 * ({@link BilanzAbleitung#summeOhneAnzeige}) — nie ein Periodenbetrag mit einem Stichtag-Anteil. Ein Wechsel mitten
 * im Monat braucht darum keine Sonderregel (F13: 14 × 500 × 70 % + 17 × 500 × 60 % = 10 000 kWh).
 *
 * <p><b>Ablesezeiträume (Messen PR4, Konzept §10.3):</b> eine Messstelle aus Ablesungen hat keine Tageswerte - ein
 * Ablesezeitraum wird nie auf Tage verteilt. Über einen Monat oder ein Jahr trägt sie darum MONATE statt Tage: die
 * gespeicherte Menge jedes Monats mit den Ablesezeiträumen, die der Kunde ihm zugeordnet hat. Gilt der Anteil dieser
 * Kostenstelle an jedem Tag dieser Zeiträume unverändert, bekommt sie Anteil × Menge als Ganzes
 * ({@link VerteilungRegeln#ablesezeitraum}, dann {@link VerteilungRegeln#erbe}); wechselt er, keine Zahl
 * ({@link VerteilungRegeln#GRUND_ANTEIL_WECHSELT}, Satz {@link VerteilungRegeln#ERBE_ANTEIL_WECHSELT} und „Verteilung
 * geändert am …“). Ein Monat mit Zeile, aber ohne gespeicherte Menge, fehlt ({@link #GRUND_KEINE_ABLESUNG}).
 *
 * <p><b>{@code null} ist nie 0:</b> eine Kostenstelle ohne Zuordnung hat KEINE Menge (Grund
 * {@code keine_zuordnung}); ein zugeordneter Tag ohne Tageswert hat „keine Werte“ (Grund {@code kein_tageswert}).
 * Posten verschiedener Größe, Richtung oder Einheit werden nie zu einer Zahl zusammengezählt
 * ({@code groessen_gemischt}, je Größe eine Summe).
 *
 * <p><b>Version:</b> ein verteilter Wert trägt die Version seiner Quelle ({@link VerteilungRegeln#erbe}); die Periode
 * trägt die höchste Version ihrer Tage und EINMAL „korrigiert (Version n)“ ({@link ErgebnisZustand#korrigiert}).
 *
 * <p>Die EINE Wahrheit steht in {@code docs/contracts/v2/verteilung-vectors.json} (Regel {@code kostenstelle}). Kein
 * TS-Zwilling: die Sicht wird serverseitig gebildet und reist fertig ins Portal ({@code zwillinge_grund}).
 *
 * <p>Rein: ohne Spring, ohne DB, ohne Uhr.
 */
public final class KostenstelleEnergieRegeln {

    private KostenstelleEnergieRegeln() {}

    public static final String GEMESSEN = "gemessen";
    public static final String VERTEILT = VerteilungRegeln.VERTEILT;
    public static final String BERECHNET = "berechnet";
    public static final String NICHT_VERTEILT = VerteilungRegeln.NICHT_VERTEILT;

    /** Die vier Herkünfte in ihrer Reihenfolge — die Reihenfolge ist Vertrag. */
    public static final List<String> HERKUENFTE = List.of(GEMESSEN, VERTEILT, BERECHNET, NICHT_VERTEILT);

    /** Die Art einer berechneten Messstelle (Messstellen-Vertrag). */
    public static final String ART_BERECHNET = MessstelleRegeln.BERECHNET;

    public static final String GRUND_KEINE_ZUORDNUNG = "keine_zuordnung";
    public static final String GRUND_GROESSEN_GEMISCHT = "groessen_gemischt";
    public static final String GRUND_KEIN_TAGESWERT = "kein_tageswert";
    /** Messen PR4: ein Monat, an dem die Kostenstelle eine Zeile hat, ohne gespeicherte Menge aus Ablesungen. */
    public static final String GRUND_KEINE_ABLESUNG = "keine_ablesung";

    /** Die Gründe, warum ein Block, Tag oder Monat KEINE Zahl trägt - geschlossen. */
    public static final List<String> GRUENDE = List.of(GRUND_KEINE_ZUORDNUNG, GRUND_GROESSEN_GEMISCHT,
            GRUND_KEIN_TAGESWERT, VerteilungRegeln.GRUND_QUELLE_KEINE_WERTE, VerteilungRegeln.GRUND_REST_UNPLAUSIBEL,
            VerteilungRegeln.GRUND_ANTEIL_WECHSELT, GRUND_KEINE_ABLESUNG);

    /** „Verteilung geändert am 15.01.2027“ — der Anteil DIESER Kostenstelle wechselt innerhalb der Periode. */
    public static final String SATZ_VERTEILUNG_GEAENDERT = "Verteilung geändert am {tag}";

    private static final BigDecimal HUNDERT = VerteilungRegeln.SUMME_PROZENT;
    private static final DateTimeFormatter DATUM = DateTimeFormatter.ofPattern("dd.MM.yyyy", Locale.ROOT);

    // ------------------------------------------------------------------------------- Eingang

    /** Ein gespeicherter Tageswert einer Messstelle; {@code menge == null} heißt „keine Werte“, nie 0. */
    public record Tageswert(LocalDate tag, BigDecimal menge, String zustand, Integer abdeckungProzent, int version,
            List<String> kennzeichen) {}

    /** Eine (nicht aufgehobene) Verteilungszeile mit ihrer Fassung — Fassung n = der n-te Satz ab einem Tag. */
    public record Anteil(String kostenstelle, BigDecimal anteilProzent, LocalDate gueltigAb, LocalDate gueltigBis,
            int fassung) {}

    /**
     * Ein Monat einer Messstelle aus Ablesungen: seine gespeicherte Menge (in der gezeigten Version) und die
     * Ablesezeiträume, die der Kunde ihm zugeordnet hat ({@code menge == null} heißt „keine Werte“, nie 0).
     */
    public record Monatswert(YearMonth monat, List<VerteilungRegeln.Ablesezeitraum> ablesezeitraeume,
            BigDecimal menge, String zustand, Integer abdeckungProzent, int version, List<String> kennzeichen) {}

    /** Die Monate einer Messstelle aus Ablesungen im Zeitraum und die Zone, in der sie ihre Monate schneidet. */
    public record Ablesung(ZoneId zone, List<Monatswert> monate) {}

    /**
     * Eine Messstelle mit ihrer Hauptgröße, ihren Anteilen und ihren Tageswerten im Zeitraum. {@code ablesung} ≠
     * {@code null}: sie trägt Monate aus Ablesungen statt Tage (Messen PR4).
     */
    public record Quelle(String messstelle, String art, String groesse, String richtung, String einheit,
            List<Anteil> anteile, List<Tageswert> tage, Ablesung ablesung) {

        public Quelle(String messstelle, String art, String groesse, String richtung, String einheit,
                List<Anteil> anteile, List<Tageswert> tage) {
            this(messstelle, art, groesse, richtung, einheit, anteile, tage, null);
        }
    }

    // ------------------------------------------------------------------------------- Ergebnis

    /**
     * Ein Tag eines Postens. {@code anteilProzent} ist bei „nicht verteilt“ {@code null}; {@code grund} sagt, warum
     * der Tag keine Zahl trägt.
     */
    public record Tag(LocalDate tag, BigDecimal anteilProzent, BigDecimal quelleMenge, BigDecimal menge,
            String zustand, Integer abdeckungProzent, int version, String grund) {}

    /**
     * Ein Monat eines Postens aus Ablesungen: der Anteil, der an jedem Tag seiner Ablesezeiträume galt ({@code null},
     * wenn er wechselt oder bei „nicht verteilt“), die Menge des Monats und der Teil daraus; {@code geaendertAm} der Tag,
     * an dem der Anteil mitten im Zeitraum wechselt.
     */
    public record Monat(YearMonth monat, List<VerteilungRegeln.Ablesezeitraum> ablesezeitraeume,
            BigDecimal anteilProzent, BigDecimal quelleMenge, BigDecimal menge, String zustand, Integer abdeckungProzent,
            int version, String grund, LocalDate geaendertAm) {}

    /**
     * Eine Messstelle in einer Herkunft: die Summe ihrer Tage (bzw. bei Ablesungen ihrer Monate) mit Zustand, Version,
     * Kennzeichen, Fassungen. Genau eine der Listen {@code tage}/{@code monate} trägt Einträge.
     */
    public record Posten(String messstelle, String art, String groesse, String richtung, String einheit,
            BigDecimal menge, String zustand, Integer abdeckungProzent, int version, List<String> kennzeichen,
            List<Integer> fassungen, List<String> fehlend, List<Tag> tage, List<Monat> monate) {}

    /** Die Summe der Posten GLEICHER Größe, Richtung und Einheit. */
    public record Summe(String groesse, String richtung, String einheit, BigDecimal menge, String zustand,
            Integer abdeckungProzent, int vorhanden, int gesamt, List<String> fehlend) {}

    /**
     * Ein Block: {@code menge}/{@code einheit}/{@code zustand} nur, wenn GENAU eine Summe entsteht; ohne Posten
     * {@code grund = keine_zuordnung} (Herkünfte der Kostenstelle) — nie 0.
     */
    public record Block(BigDecimal menge, String einheit, String zustand, String grund, List<Summe> summen,
            List<Posten> posten) {}

    /** {@code summe} = gemessen + verteilt + berechnet (ohne Posten); {@code nichtVerteilt} zählt dort NIE mit. */
    public record Urteil(String kostenstelle, LocalDate von, LocalDate bis, Block gemessen, Block verteilt,
            Block berechnet, Block summe, Block nichtVerteilt) {}

    // ------------------------------------------------------------------------------- Regel

    /**
     * Die Energie der Kostenstelle {@code kostenstelle} von {@code von} bis {@code bis} (Tage, der letzte
     * einschließlich).
     *
     * @param ziele alle Kostenstellen mit ihren Tagen — eine Zeile gilt nie länger als ihr Ziel (F12)
     * @param quellen die Messstellen mit Tageswerten oder Anteilen im Zeitraum
     */
    public static Urteil energie(String kostenstelle, LocalDate von, LocalDate bis, List<VerteilungRegeln.Ziel> ziele,
            List<Quelle> quellen) {
        Map<String, List<Posten>> jeHerkunft = new LinkedHashMap<>();
        HERKUENFTE.forEach(h -> jeHerkunft.put(h, new ArrayList<>()));
        List<Quelle> sortiert = quellen.stream()
                .sorted((a, b) -> a.messstelle().compareTo(b.messstelle()))
                .toList();
        for (Quelle q : sortiert) {
            Sammler s = q.ablesung() != null ? sammleMonate(kostenstelle, von, bis, ziele, q)
                    : sammle(kostenstelle, von, bis, ziele, q);
            for (String h : HERKUENFTE) {
                List<Tag> tage = s.tage.get(h);
                List<Monat> monate = s.monate.get(h);
                // „Nicht verteilt“ ist, was GEMESSEN wurde und niemandem gehört: ohne eine einzige Menge an den nicht
                // verteilten Tagen ist nichts offen — die Messstelle steht dann nicht im Block (sie hat nichts geliefert).
                // Ein Ablesezeitraum, der nur zum Teil niemandem gehört, hat eine Menge - nur keine Zahl für den Teil.
                boolean nichtsGemessen = NICHT_VERTEILT.equals(h) && tage.stream().allMatch(t -> t.menge() == null)
                        && monate.stream().allMatch(m -> m.menge() == null
                                && !VerteilungRegeln.GRUND_ANTEIL_WECHSELT.equals(m.grund()));
                if ((!tage.isEmpty() || !monate.isEmpty()) && !nichtsGemessen) {
                    jeHerkunft.get(h).add(posten(q, h, s, tage, monate));
                }
            }
        }
        Block gemessen = block(jeHerkunft.get(GEMESSEN), GRUND_KEINE_ZUORDNUNG, true);
        Block verteilt = block(jeHerkunft.get(VERTEILT), GRUND_KEINE_ZUORDNUNG, true);
        Block berechnet = block(jeHerkunft.get(BERECHNET), GRUND_KEINE_ZUORDNUNG, true);
        List<Posten> alle = new ArrayList<>();
        alle.addAll(jeHerkunft.get(GEMESSEN));
        alle.addAll(jeHerkunft.get(VERTEILT));
        alle.addAll(jeHerkunft.get(BERECHNET));
        Block summe = block(alle, GRUND_KEINE_ZUORDNUNG, false);
        Block nichtVerteilt = block(jeHerkunft.get(NICHT_VERTEILT), null, true);
        return new Urteil(kostenstelle, von, bis, gemessen, verteilt, berechnet, summe, nichtVerteilt);
    }

    /** Was eine Messstelle über die Tage (bzw. Monate aus Ablesungen) je Herkunft beiträgt. */
    private static final class Sammler {
        final Map<String, List<Tag>> tage = new LinkedHashMap<>();
        final Map<String, List<Monat>> monate = new LinkedHashMap<>();
        final Map<String, LinkedHashSet<String>> kennzeichen = new LinkedHashMap<>();
        final Map<String, TreeSet<Integer>> fassungen = new LinkedHashMap<>();

        Sammler() {
            for (String h : HERKUENFTE) {
                tage.put(h, new ArrayList<>());
                monate.put(h, new ArrayList<>());
                kennzeichen.put(h, new LinkedHashSet<>());
                fassungen.put(h, new TreeSet<>());
            }
        }
    }

    /**
     * Die Monate einer Messstelle aus Ablesungen (Messen PR4): je Kalendermonat des Zeitraums die gespeicherte Menge mit
     * ihren Ablesezeiträumen - an die Kostenstelle als Ganzes, wenn ihr Anteil an JEDEM Tag dieser Zeiträume derselbe
     * ist ({@link VerteilungRegeln#ablesezeitraum}); was an keinem Tag eine Zeile hat, ganz nach „nicht verteilt“.
     */
    private static Sammler sammleMonate(String kostenstelle, LocalDate von, LocalDate bis,
            List<VerteilungRegeln.Ziel> ziele, Quelle q) {
        Sammler s = new Sammler();
        ZoneId zone = q.ablesung().zone();
        Map<YearMonth, Monatswert> jeMonat = new LinkedHashMap<>();
        q.ablesung().monate().forEach(m -> jeMonat.put(m.monat(), m));
        List<VerteilungRegeln.Bestandszeile> zeilen = zeilen(q);
        boolean berechnet = ART_BERECHNET.equals(q.art());
        BigDecimal anteilVorher = null;
        LocalDate letzterTagVorher = null;
        for (YearMonth m = YearMonth.from(von); !m.isAfter(YearMonth.from(bis)); m = m.plusMonths(1)) {
            Monatswert mw = jeMonat.get(m);
            // Ohne zugeordneten Ablesezeitraum gelten die Tage des Kalendermonats - sie sagen nur, ob die Kostenstelle
            // ihn erwartet; eine Menge gibt es dann nicht.
            List<VerteilungRegeln.Ablesezeitraum> zeitraeume = mw != null && !mw.ablesezeitraeume().isEmpty()
                    ? mw.ablesezeitraeume()
                    : List.of(new VerteilungRegeln.Ablesezeitraum(m.atDay(1).atStartOfDay(zone).toInstant(),
                            m.plusMonths(1).atDay(1).atStartOfDay(zone).toInstant()));
            VerteilungRegeln.AblesezeitraumUrteil a = VerteilungRegeln.ablesezeitraum(zone, zeitraeume,
                    mw == null ? null : mw.menge(), zeilen, ziele);
            VerteilungRegeln.AblesezeitraumZiel z = a.ziele().stream()
                    .filter(x -> x.kostenstelle().equals(kostenstelle)).findFirst().orElse(null);
            List<VerteilungRegeln.Ablesezeitraum> gezeigt = mw == null ? List.of() : mw.ablesezeitraeume();
            if (z != null) {
                boolean wechselt = VerteilungRegeln.GRUND_ANTEIL_WECHSELT.equals(z.grund());
                String herkunft = berechnet ? BERECHNET
                        : !wechselt && z.anteilProzent().compareTo(HUNDERT) == 0 ? GEMESSEN : VERTEILT;
                s.fassungen.get(herkunft).addAll(fassungen(q, kostenstelle, a.ersterTag(), a.letzterTag()));
                if (mw == null) {
                    s.monate.get(herkunft).add(new Monat(m, gezeigt, z.anteilProzent(), null, null,
                            BilanzAbleitung.KEINE_WERTE, null, 1, GRUND_KEINE_ABLESUNG, z.geaendertAm()));
                } else if (wechselt) {
                    s.monate.get(herkunft).add(new Monat(m, gezeigt, null, mw.menge(), null,
                            BilanzAbleitung.KEINE_WERTE, mw.abdeckungProzent(), mw.version(), z.grund(),
                            z.geaendertAm()));
                    s.kennzeichen.get(herkunft).add(SATZ_VERTEILUNG_GEAENDERT.replace("{tag}",
                            DATUM.format(z.geaendertAm())));
                    s.kennzeichen.get(herkunft).add(VerteilungRegeln.ERBE_ANTEIL_WECHSELT);
                } else {
                    VerteilungRegeln.ErbeUrteil erbe = VerteilungRegeln.erbe(
                            new VerteilungRegeln.Quelle(q.messstelle(), mw.menge(), mw.zustand(),
                                    mw.abdeckungProzent(), mw.version(), mw.kennzeichen()),
                            z.anteilProzent(), fassung(q, kostenstelle, a.letzterTag()), kostenstelle, q.einheit());
                    s.monate.get(herkunft).add(new Monat(m, gezeigt, z.anteilProzent(), mw.menge(), erbe.menge(),
                            erbe.zustand(), erbe.abdeckungProzent(), erbe.version(), erbe.grund(), null));
                    if (anteilVorher != null && letzterTagVorher != null
                            && letzterTagVorher.plusDays(1).equals(a.ersterTag())
                            && anteilVorher.compareTo(z.anteilProzent()) != 0) {
                        s.kennzeichen.get(herkunft).add(SATZ_VERTEILUNG_GEAENDERT.replace("{tag}",
                                DATUM.format(a.ersterTag())));
                    }
                    if (!VerteilungRegeln.GRUND_QUELLE_KEINE_WERTE.equals(erbe.grund())) {
                        s.kennzeichen.get(herkunft).addAll(erbe.kennzeichen());
                    }
                }
                anteilVorher = wechselt ? null : z.anteilProzent();
                letzterTagVorher = a.letzterTag();
            } else {
                anteilVorher = null;
                letzterTagVorher = null;
            }
            VerteilungRegeln.AblesezeitraumOffen offen = a.nichtVerteilt();
            // „Nicht verteilt“ nur mit einem gespeicherten Monat: ohne Menge ist nichts gemessen, das niemandem gehört.
            if (offen != null && mw != null) {
                if (VerteilungRegeln.GRUND_ANTEIL_WECHSELT.equals(offen.grund())) {
                    s.monate.get(NICHT_VERTEILT).add(new Monat(m, gezeigt, null, mw.menge(), null,
                            BilanzAbleitung.KEINE_WERTE, mw.abdeckungProzent(), mw.version(), offen.grund(),
                            offen.geaendertAm()));
                    s.kennzeichen.get(NICHT_VERTEILT).add(VerteilungRegeln.ERBE_ANTEIL_WECHSELT);
                } else {
                    s.monate.get(NICHT_VERTEILT).add(new Monat(m, gezeigt, null, mw.menge(), mw.menge(),
                            mw.menge() == null ? BilanzAbleitung.KEINE_WERTE : mw.zustand(), mw.abdeckungProzent(),
                            mw.version(), offen.grund(), null));
                    if (mw.menge() != null) {
                        s.kennzeichen.get(NICHT_VERTEILT).addAll(mw.kennzeichen());
                    }
                }
            }
        }
        return s;
    }

    /** Die Zeilen einer Quelle, wie {@link VerteilungRegeln#amTag} sie liest. */
    private static List<VerteilungRegeln.Bestandszeile> zeilen(Quelle q) {
        return q.anteile().stream()
                .map(a -> new VerteilungRegeln.Bestandszeile(a.kostenstelle(), a.anteilProzent(), a.gueltigAb(),
                        a.gueltigBis(), null))
                .toList();
    }

    /** Die Fassungen der Zeilen der Kostenstelle, die einen Tag in [{@code von}, {@code bis}] berühren. */
    private static List<Integer> fassungen(Quelle q, String kostenstelle, LocalDate von, LocalDate bis) {
        return q.anteile().stream()
                .filter(a -> a.kostenstelle().equals(kostenstelle))
                .filter(a -> !a.gueltigAb().isAfter(bis) && (a.gueltigBis() == null || !a.gueltigBis().isBefore(von)))
                .map(Anteil::fassung)
                .toList();
    }

    private static Sammler sammle(String kostenstelle, LocalDate von, LocalDate bis,
            List<VerteilungRegeln.Ziel> ziele, Quelle q) {
        Sammler s = new Sammler();
        Map<LocalDate, Tageswert> werte = new LinkedHashMap<>();
        q.tage().forEach(t -> werte.put(t.tag(), t));
        List<VerteilungRegeln.Bestandszeile> zeilen = zeilen(q);
        boolean berechnet = ART_BERECHNET.equals(q.art());
        BigDecimal anteilVortag = null;
        for (LocalDate d = von; !d.isAfter(bis); d = d.plusDays(1)) {
            VerteilungRegeln.AmTagUrteil amTag = VerteilungRegeln.amTag(d, zeilen, ziele);
            Tageswert w = werte.get(d);
            BigDecimal anteil = null;
            String herkunft = null;
            if (amTag.zeilen().isEmpty()) {
                // Nicht verteilt: der Tag gehört KEINER Kostenstelle — er wird hier gesammelt und nirgends aufgeteilt.
                if (w != null) {
                    s.tage.get(NICHT_VERTEILT).add(new Tag(d, null, w.menge(), w.menge(), w.zustand(),
                            w.abdeckungProzent(), w.version(),
                            w.menge() == null ? VerteilungRegeln.GRUND_QUELLE_KEINE_WERTE : null));
                    if (w.menge() != null) {
                        s.kennzeichen.get(NICHT_VERTEILT).addAll(w.kennzeichen());
                    }
                }
            } else {
                VerteilungRegeln.Zeile zeile = amTag.zeilen().stream()
                        .filter(z -> z.kostenstelle().equals(kostenstelle))
                        .findFirst()
                        .orElse(null);
                if (zeile != null) {
                    anteil = zeile.anteilProzent();
                    herkunft = berechnet ? BERECHNET : anteil.compareTo(HUNDERT) == 0 ? GEMESSEN : VERTEILT;
                    int fassung = fassung(q, kostenstelle, d);
                    s.fassungen.get(herkunft).add(fassung);
                    if (w == null) {
                        s.tage.get(herkunft).add(new Tag(d, anteil, null, null, BilanzAbleitung.KEINE_WERTE, null, 1,
                                GRUND_KEIN_TAGESWERT));
                    } else {
                        VerteilungRegeln.ErbeUrteil erbe = VerteilungRegeln.erbe(
                                new VerteilungRegeln.Quelle(q.messstelle(), w.menge(), w.zustand(),
                                        w.abdeckungProzent(), w.version(), w.kennzeichen()),
                                anteil, fassung, kostenstelle, q.einheit());
                        s.tage.get(herkunft).add(new Tag(d, anteil, w.menge(), erbe.menge(), erbe.zustand(),
                                erbe.abdeckungProzent(), erbe.version(), erbe.grund()));
                        // Ein Tag ohne Werte sagt es an seinem Zustand; „keine Werte“ wird kein Kennzeichen des Postens.
                        if (!VerteilungRegeln.GRUND_QUELLE_KEINE_WERTE.equals(erbe.grund())) {
                            s.kennzeichen.get(herkunft).addAll(erbe.kennzeichen());
                        }
                    }
                }
            }
            if (d.isAfter(von) && anteil != null && anteilVortag != null && anteil.compareTo(anteilVortag) != 0) {
                s.kennzeichen.get(herkunft).add(SATZ_VERTEILUNG_GEAENDERT.replace("{tag}", DATUM.format(d)));
            }
            anteilVortag = anteil;
        }
        return s;
    }

    /** Die Fassung der Zeile, die am Tag für die Kostenstelle gilt. */
    private static int fassung(Quelle q, String kostenstelle, LocalDate tag) {
        return q.anteile().stream()
                .filter(a -> a.kostenstelle().equals(kostenstelle))
                .filter(a -> !tag.isBefore(a.gueltigAb()) && (a.gueltigBis() == null || !tag.isAfter(a.gueltigBis())))
                .mapToInt(Anteil::fassung)
                .findFirst()
                .orElseThrow();
    }

    private static Posten posten(Quelle q, String herkunft, Sammler s, List<Tag> tage, List<Monat> monate) {
        List<BilanzAbleitung.Summand> summanden = new ArrayList<>();
        tage.forEach(t -> summanden.add(new BilanzAbleitung.Summand(t.tag().toString(), t.menge(), t.zustand(),
                t.abdeckungProzent(), t.version(), List.of(), "+", BigDecimal.ONE)));
        monate.forEach(m -> summanden.add(new BilanzAbleitung.Summand(m.monat().toString(), m.menge(), m.zustand(),
                m.abdeckungProzent(), m.version(), List.of(), "+", BigDecimal.ONE)));
        BilanzAbleitung.SummeUrteil summe = BilanzAbleitung.summeOhneAnzeige(summanden);
        int version = Math.max(tage.stream().mapToInt(Tag::version).max().orElse(1),
                monate.stream().mapToInt(Monat::version).max().orElse(1));
        List<String> kennzeichen = new ArrayList<>();
        if (NICHT_VERTEILT.equals(herkunft)) {
            kennzeichen.add(NICHT_VERTEILT);
        }
        s.kennzeichen.get(herkunft).stream()
                .filter(k -> !ErgebnisZustand.istKorrigiert(k))
                .filter(k -> !kennzeichen.contains(k))
                .forEach(kennzeichen::add);
        if (version > 1) {
            kennzeichen.add(ErgebnisZustand.korrigiert(version));
        }
        return new Posten(q.messstelle(), q.art(), q.groesse(), q.richtung(), q.einheit(),
                summe.vorhanden() == 0 ? null : summe.menge(), summe.zustand(), summe.abdeckungProzent(), version,
                List.copyOf(kennzeichen), List.copyOf(s.fassungen.get(herkunft)), summe.fehlend(), List.copyOf(tage),
                List.copyOf(monate));
    }

    private static Block block(List<Posten> posten, String grundOhnePosten, boolean mitPosten) {
        Map<String, List<Posten>> jeGroesse = new LinkedHashMap<>();
        for (Posten p : posten) {
            jeGroesse.computeIfAbsent(p.groesse() + " " + p.richtung() + " " + p.einheit(),
                    k -> new ArrayList<>()).add(p);
        }
        List<Summe> summen = new ArrayList<>();
        for (List<Posten> gleiche : jeGroesse.values()) {
            BilanzAbleitung.SummeUrteil s = BilanzAbleitung.summeOhneAnzeige(gleiche.stream()
                    .map(p -> new BilanzAbleitung.Summand(p.messstelle(), p.menge(), p.zustand(), p.abdeckungProzent(),
                            p.version(), List.of(), "+", BigDecimal.ONE))
                    .toList());
            Posten erster = gleiche.get(0);
            summen.add(new Summe(erster.groesse(), erster.richtung(), erster.einheit(),
                    s.vorhanden() == 0 ? null : s.menge(), s.zustand(), s.abdeckungProzent(), s.vorhanden(),
                    s.gesamt(), s.fehlend()));
        }
        List<Posten> gezeigt = mitPosten ? List.copyOf(posten) : List.of();
        if (summen.isEmpty()) {
            return new Block(null, null, null, grundOhnePosten, List.of(), gezeigt);
        }
        if (summen.size() > 1) {
            return new Block(null, null, null, GRUND_GROESSEN_GEMISCHT, List.copyOf(summen), gezeigt);
        }
        Summe eine = summen.get(0);
        return new Block(eine.menge(), eine.einheit(), eine.zustand(), null, List.copyOf(summen), gezeigt);
    }
}
