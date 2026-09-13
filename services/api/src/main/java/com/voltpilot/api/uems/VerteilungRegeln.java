package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Die FESTE VERTEILUNG einer Messstelle auf Kostenstellen (UEMS AP-10 §4.6, E11/E12) als reine
 * Regel.
 *
 * <p>Eine Verteilung ist eine eigene ZEITGÜLTIGE Beziehung Messstelle → Kostenstelle (Tage,
 * Muster A) mit Anteil. An jedem Tag mit Zeilen sind es genau 100 %; gibt es an einem Tag keine
 * Zeile, ist die Messstelle „nicht verteilt“ — das ist ein Zustand, kein Fehler. Sie wirkt JE TAG
 * auf die Tagesmenge: kein Stichtag, kein Mittel, keine Interpolation. Ein Periodenbetrag, über
 * dessen Zeitraum sich die Verteilung ÄNDERT, wird deshalb nicht geteilt, sondern verlangt
 * Tagesmengen — eine anteilig geschätzte Aufteilung wäre eine erfundene Zahl.
 *
 * <p><b>Keine dynamischen Schlüssel:</b> kein Anteil aus Messwerten, Flächen, Stückzahlen oder
 * Betriebsstunden (Grenze des Captains, AP-09 S2).
 *
 * <p>Die EINE Wahrheit steht in {@code docs/contracts/v2/verteilung-vectors.json} (Prosa:
 * {@code verteilung.md}); der TS-Zwilling ist {@code frontend/portal/src/uemsVerteilung.ts}.
 *
 * <p>Rein: ohne Spring, ohne DB, ohne Uhr.
 */
public final class VerteilungRegeln {

    private VerteilungRegeln() {}

    /** Die Summe aller Zeilen eines Tages — genau so viel, nie „ungefähr“. */
    public static final BigDecimal SUMME_PROZENT = new BigDecimal("100");

    public static final int ANTEIL_NACHKOMMASTELLEN = 1;
    public static final int MENGE_NACHKOMMASTELLEN = 6;

    public static final String VERTEILT = "verteilt";
    public static final String NICHT_VERTEILT = "nicht verteilt";

    public static final String FEHLER_SUMME = "verteilung_summe";
    public static final String FEHLER_ZIEL = "ziel_besteht_nicht";
    public static final String FEHLER_ANTEIL = "anteil_ungueltig";
    public static final String FEHLER_UEBERLAPPT = "formel_fassung_ueberlappt";
    public static final String FEHLER_TAGESMENGEN = "tagesmengen_noetig";
    public static final String FEHLER_TERM_FAKTOR = "verteilungs_term_ohne_faktor";
    public static final String FEHLER_NICHT_VERTEILT = "nicht_verteilt";

    /** Der Satz, den ein Ziel bekommt, dessen Quelle ein unplausibler Rest ist. */
    public static final String ERBE_REST_UNPLAUSIBEL = "keine Werte (Rest unplausibel)";

    public static final String GRUND_REST_UNPLAUSIBEL = "rest_unplausibel";
    public static final String GRUND_QUELLE_KEINE_WERTE = "quelle_keine_werte";

    // ------------------------------------------------------------------------------- Bausteine

    /** Eine Zeile eines Verteilungs-Satzes: ein Ziel und sein Anteil. */
    public record Zeile(String kostenstelle, BigDecimal anteilProzent) {}

    /** Ein zeitgültiges Ziel; {@code gueltigBis == null} heißt „läuft“. */
    public record Ziel(String kostenstelle, LocalDate gueltigAb, LocalDate gueltigBis) {}

    /** Eine zeitgültige Verteilungszeile, wie sie gespeichert ist. */
    public record Bestandszeile(
            String kostenstelle,
            BigDecimal anteilProzent,
            LocalDate gueltigAb,
            LocalDate gueltigBis,
            LocalDate aufgehobenAm) {}

    private static boolean gilt(LocalDate tag, LocalDate ab, LocalDate bis) {
        if (ab != null && tag.isBefore(ab)) {
            return false;
        }
        return bis == null || !tag.isAfter(bis);
    }

    // ------------------------------------------------------------------------------- Satz (100 %)

    /** {@code gueltig == false} nennt in {@code fehler} den Grund und in {@code fakten} die Zahlen dazu. */
    public record SatzUrteil(
            boolean gueltig, BigDecimal summe, String fehler, Map<String, String> fakten) {}

    /**
     * §4.6 — ein Verteilungs-Satz wird als GANZES geschrieben (alle Ziele eines Tages in einer
     * Anfrage), damit die 100 % überhaupt prüfbar sind. Geprüft wird in fester Reihenfolge:
     * jeder Anteil liegt in (0, 100], jedes Ziel besteht an diesem Tag, die Summe ist genau 100 %.
     * Eine Summe von 110 % wird abgelehnt, nie stillschweigend normiert.
     */
    public static SatzUrteil satz(LocalDate tag, String messstelle, List<Zeile> zeilen, List<Ziel> ziele) {
        BigDecimal summe = BigDecimal.ZERO;
        for (Zeile z : zeilen) {
            summe = summe.add(z.anteilProzent());
        }
        summe = summe.setScale(ANTEIL_NACHKOMMASTELLEN, RoundingMode.HALF_UP).stripTrailingZeros();
        for (Zeile z : zeilen) {
            if (z.anteilProzent().signum() <= 0 || z.anteilProzent().compareTo(SUMME_PROZENT) > 0) {
                return new SatzUrteil(false, summe, FEHLER_ANTEIL,
                        Map.of("kostenstelle", z.kostenstelle(),
                                "anteil_prozent", z.anteilProzent().stripTrailingZeros().toPlainString()));
            }
        }
        for (Zeile z : zeilen) {
            Ziel ziel = ziele.stream()
                    .filter(y -> y.kostenstelle().equals(z.kostenstelle()))
                    .findFirst()
                    .orElse(null);
            if (ziel == null || !gilt(tag, ziel.gueltigAb(), ziel.gueltigBis())) {
                return new SatzUrteil(false, summe, FEHLER_ZIEL,
                        Map.of("kostenstelle", z.kostenstelle(), "tag", tag.toString()));
            }
        }
        if (summe.compareTo(SUMME_PROZENT) != 0) {
            return new SatzUrteil(false, summe, FEHLER_SUMME,
                    Map.of("summe", summe.toPlainString(), "tag", tag.toString()));
        }
        return new SatzUrteil(true, summe, null, Map.of());
    }

    // ------------------------------------------------------------------------------- Am Tag

    public record AmTagUrteil(List<Zeile> zeilen, String zustand) {}

    /**
     * Welche Zeilen an einem Tag gelten. Eine Zeile endet mit ihrem Ziel (F12): endet die
     * Kostenstelle, endet der Anteil — er wandert NIE still auf einen Nachfolger. Ohne gültige
     * Zeile heißt der Zustand „nicht verteilt“.
     */
    public static AmTagUrteil amTag(LocalDate tag, List<Bestandszeile> zeilen, List<Ziel> ziele) {
        List<Zeile> gueltig = new ArrayList<>();
        for (Bestandszeile b : zeilen) {
            if (b.aufgehobenAm() != null && !tag.isBefore(b.aufgehobenAm())) {
                continue;
            }
            if (!gilt(tag, b.gueltigAb(), b.gueltigBis())) {
                continue;
            }
            Ziel ziel = ziele.stream()
                    .filter(y -> y.kostenstelle().equals(b.kostenstelle()))
                    .findFirst()
                    .orElse(null);
            if (ziel == null || !gilt(tag, ziel.gueltigAb(), ziel.gueltigBis())) {
                continue;
            }
            gueltig.add(new Zeile(b.kostenstelle(), b.anteilProzent()));
        }
        return new AmTagUrteil(List.copyOf(gueltig), gueltig.isEmpty() ? NICHT_VERTEILT : VERTEILT);
    }

    // ------------------------------------------------------------------------------- Fassung

    public record Beendet(String kostenstelle, LocalDate gueltigBis) {}

    public record NeueZeile(
            String kostenstelle, BigDecimal anteilProzent, LocalDate gueltigAb, LocalDate gueltigBis) {}

    public record FassungUrteil(
            List<Beendet> beendet,
            List<NeueZeile> neu,
            boolean rueckwirkend,
            long tageRueckwirkend,
            String fehler) {}

    /**
     * Eine neue Fassung beendet die laufende am VORTAG — nichts wird überschrieben. Beginnt sie vor
     * dem Beginn der laufenden, überlappte sie; das wird abgelehnt. Liegt ihr Beginn vor heute, ist
     * sie rückwirkend und bekommt ihr Abzeichen (mit der Zahl der Tage) — rückwirkend ist erlaubt,
     * aber nie unsichtbar.
     */
    public static FassungUrteil fassung(
            LocalDate heute, List<Bestandszeile> bestehend, LocalDate gueltigAb, List<Zeile> zeilen) {
        boolean rueckwirkend = gueltigAb.isBefore(heute);
        long tage = ChronoUnit.DAYS.between(gueltigAb, heute);
        for (Bestandszeile b : bestehend) {
            if (!gueltigAb.isAfter(b.gueltigAb())) {
                return new FassungUrteil(List.of(), List.of(), rueckwirkend, tage, FEHLER_UEBERLAPPT);
            }
        }
        List<Beendet> beendet = bestehend.stream()
                .filter(b -> b.gueltigBis() == null || !b.gueltigBis().isBefore(gueltigAb))
                .map(b -> new Beendet(b.kostenstelle(), gueltigAb.minusDays(1)))
                .toList();
        List<NeueZeile> neu = zeilen.stream()
                .map(z -> new NeueZeile(z.kostenstelle(), z.anteilProzent(), gueltigAb, null))
                .toList();
        return new FassungUrteil(beendet, neu, rueckwirkend, tage, null);
    }

    // ------------------------------------------------------------------------------- Satz ab Tag

    /** Eine Zeile, die eine Korrektur aufhebt: sie bleibt lesbar, gilt aber nie mehr. */
    public record Aufgehoben(String kostenstelle, LocalDate gueltigAb) {}

    /**
     * {@code fehler != null}: nichts wird geschrieben ({@code fakten} nennt die Zahlen). Sonst sagen
     * {@code aufgehoben}, {@code beendet} und {@code neu}, was geschrieben wird; {@code unveraendert}
     * heißt: derselbe Stand steht schon da — nichts wird geschrieben, auch kein Protokoll.
     */
    public record SatzAbTagUrteil(
            String fehler,
            BigDecimal summe,
            Map<String, String> fakten,
            List<Aufgehoben> aufgehoben,
            List<Beendet> beendet,
            List<NeueZeile> neu,
            boolean rueckwirkend,
            long tageRueckwirkend,
            boolean unveraendert) {}

    /**
     * AP-10 IP-8 — der Schreibweg {@code PUT …/verteilung} als EINE Regel: ab {@code tag} gilt GENAU
     * dieser Satz ({@code zeilen} leer = ab dem Tag „nicht verteilt“). Reihenfolge:
     * <ol>
     *   <li>jeder Anteil in (0, 100] mit höchstens {@link #ANTEIL_NACHKOMMASTELLEN} Nachkommastelle
     *       ({@code anteil_ungueltig} — nie still gerundet), dann {@link #satz} (Ziel besteht, 100 %);</li>
     *   <li>eine neue Zeile endet mit ihrem Ziel (F12) — und an keinem Tag danach bleibt ein Rest
     *       ≠ 100 % ({@code verteilung_summe} mit dem ersten solchen Tag);</li>
     *   <li>steht derselbe Stand ab dem Tag schon da, ist nichts zu tun ({@code unveraendert});</li>
     *   <li>mit {@code korrektur} werden die Zeilen, die GENAU am Tag beginnen, aufgehoben;</li>
     *   <li>der Rest folgt {@link #fassung}: die laufende endet am Vortag, eine Fassung am oder nach dem
     *       Tag überlappt ({@code formel_fassung_ueberlappt}).</li>
     * </ol>
     * Rückwirkend ist ein Tag vor {@code heute} — mit der Zahl der Tage, nie unsichtbar.
     */
    public static SatzAbTagUrteil satzAbTag(LocalDate heute, LocalDate tag, List<Zeile> zeilen, List<Ziel> ziele,
            List<Bestandszeile> bestehend, boolean korrektur) {
        boolean rueckwirkend = tag.isBefore(heute);
        long tage = rueckwirkend ? ChronoUnit.DAYS.between(tag, heute) : 0;
        BigDecimal summe = BigDecimal.ZERO;
        for (Zeile z : zeilen) {
            summe = summe.add(z.anteilProzent());
        }
        summe = summe.setScale(ANTEIL_NACHKOMMASTELLEN, RoundingMode.HALF_UP).stripTrailingZeros();
        for (Zeile z : zeilen) {
            BigDecimal a = z.anteilProzent();
            if (a.signum() <= 0 || a.compareTo(SUMME_PROZENT) > 0
                    || a.stripTrailingZeros().scale() > ANTEIL_NACHKOMMASTELLEN) {
                return abgelehnt(FEHLER_ANTEIL, summe, Map.of("kostenstelle", z.kostenstelle(),
                        "anteil_prozent", a.stripTrailingZeros().toPlainString()), rueckwirkend, tage);
            }
        }
        if (!zeilen.isEmpty()) {
            SatzUrteil s = satz(tag, null, zeilen, ziele);
            if (!s.gueltig()) {
                return abgelehnt(s.fehler(), summe, s.fakten(), rueckwirkend, tage);
            }
        }
        List<NeueZeile> neu = new ArrayList<>();
        for (Zeile z : zeilen) {
            LocalDate ende = ziele.stream().filter(y -> y.kostenstelle().equals(z.kostenstelle()))
                    .findFirst().map(Ziel::gueltigBis).orElse(null);
            neu.add(new NeueZeile(z.kostenstelle(), z.anteilProzent(), tag, ende));
        }
        // Ein Rest am Tag nach dem Ende eines Ziels: die übrigen Zeilen ergäben weniger als 100 %.
        List<LocalDate> enden = neu.stream().map(NeueZeile::gueltigBis).filter(e -> e != null)
                .distinct().sorted().toList();
        for (LocalDate ende : enden) {
            LocalDate danach = ende.plusDays(1);
            BigDecimal rest = neu.stream().filter(n -> gilt(danach, n.gueltigAb(), n.gueltigBis()))
                    .map(NeueZeile::anteilProzent).reduce(BigDecimal.ZERO, BigDecimal::add);
            if (rest.signum() > 0 && rest.compareTo(SUMME_PROZENT) != 0) {
                return abgelehnt(FEHLER_SUMME, summe, Map.of("summe", rest.stripTrailingZeros().toPlainString(),
                        "tag", danach.toString()), rueckwirkend, tage);
            }
        }
        List<Bestandszeile> wirksam = bestehend.stream().filter(b -> b.aufgehobenAm() == null).toList();
        if (unveraendert(tag, neu, wirksam)) {
            return new SatzAbTagUrteil(null, summe, Map.of(), List.of(), List.of(), List.of(), rueckwirkend, tage,
                    true);
        }
        List<Aufgehoben> aufgehoben = new ArrayList<>();
        List<Bestandszeile> rest = new ArrayList<>();
        for (Bestandszeile b : wirksam) {
            if (korrektur && tag.equals(b.gueltigAb())) {
                aufgehoben.add(new Aufgehoben(b.kostenstelle(), b.gueltigAb()));
            } else {
                rest.add(b);
            }
        }
        FassungUrteil f = fassung(heute, rest, tag, zeilen);
        if (f.fehler() != null) {
            LocalDate laufend = rest.stream().map(Bestandszeile::gueltigAb).max(LocalDate::compareTo).orElseThrow();
            return abgelehnt(f.fehler(), summe, Map.of("gueltig_ab", tag.toString(), "laufend_ab", laufend.toString()),
                    rueckwirkend, tage);
        }
        return new SatzAbTagUrteil(null, summe, Map.of(), List.copyOf(aufgehoben), f.beendet(), List.copyOf(neu),
                rueckwirkend, tage, false);
    }

    /** Gilt ab dem Tag schon GENAU dieser Stand — dieselben Ziele, Anteile und Enden, nichts danach? */
    private static boolean unveraendert(LocalDate tag, List<NeueZeile> neu, List<Bestandszeile> wirksam) {
        if (wirksam.stream().anyMatch(b -> b.gueltigAb() != null && b.gueltigAb().isAfter(tag))) {
            return false;
        }
        List<String> vorher = wirksam.stream()
                .filter(b -> gilt(tag, b.gueltigAb(), b.gueltigBis()))
                .map(b -> stand(b.kostenstelle(), b.anteilProzent(), b.gueltigBis()))
                .sorted().toList();
        List<String> nachher = neu.stream().map(n -> stand(n.kostenstelle(), n.anteilProzent(), n.gueltigBis()))
                .sorted().toList();
        return vorher.equals(nachher);
    }

    private static String stand(String kostenstelle, BigDecimal anteil, LocalDate bis) {
        return kostenstelle + "=" + anteil.stripTrailingZeros().toPlainString() + "@" + bis;
    }

    private static SatzAbTagUrteil abgelehnt(String fehler, BigDecimal summe, Map<String, String> fakten,
            boolean rueckwirkend, long tage) {
        return new SatzAbTagUrteil(fehler, summe, new LinkedHashMap<>(fakten), List.of(), List.of(), List.of(),
                rueckwirkend, tage, false);
    }

    // ------------------------------------------------------------------------------- Mengen

    /** Eine Tagesmenge der Quelle; {@code menge == null} heißt „keine Werte“. */
    public record Tagesmenge(LocalDate tag, BigDecimal menge) {}

    /** Ein zeitgültiger Verteilungs-Abschnitt (eine Fassung). */
    public record Abschnitt(LocalDate gueltigAb, LocalDate gueltigBis, List<Zeile> zeilen) {}

    public record MengenUrteil(
            Map<String, BigDecimal> jeZiel, BigDecimal summe, BigDecimal nichtVerteilt, String fehler) {}

    /**
     * E12 — die Verteilung wirkt JE TAG auf die Tagesmenge; der Monat je Ziel ist die Summe der
     * verteilten Tage. Deckt GENAU EIN Abschnitt den ganzen Zeitraum, genügt der Periodenbetrag
     * (das Ergebnis ist dann exakt dasselbe). Wechselt die Verteilung mitten in der Periode, sind
     * Tagesmengen nötig: ein Periodenbetrag anteilig auf die Abschnitte zu verteilen hieße, die
     * Tagesmengen zu erfinden.
     */
    public static MengenUrteil mengen(
            LocalDate von,
            LocalDate bis,
            BigDecimal periodeMenge,
            List<Tagesmenge> tage,
            List<Abschnitt> verteilung) {
        List<Abschnitt> deckend = verteilung.stream()
                .filter(a -> gilt(von, a.gueltigAb(), a.gueltigBis()) && gilt(bis, a.gueltigAb(), a.gueltigBis()))
                .toList();
        if (tage == null || tage.isEmpty()) {
            if (deckend.size() != 1 || periodeMenge == null) {
                return new MengenUrteil(Map.of(), null, null, FEHLER_TAGESMENGEN);
            }
            return verteile(List.of(new Tagesmenge(von, periodeMenge)), deckend);
        }
        return verteile(tage, verteilung);
    }

    private static MengenUrteil verteile(List<Tagesmenge> tage, List<Abschnitt> verteilung) {
        Map<String, BigDecimal> jeZiel = new LinkedHashMap<>();
        BigDecimal summe = BigDecimal.ZERO;
        BigDecimal offen = BigDecimal.ZERO;
        for (Tagesmenge t : tage) {
            if (t.menge() == null) {
                continue;
            }
            summe = summe.add(t.menge());
            List<Zeile> zeilen = verteilung.stream()
                    .filter(a -> gilt(t.tag(), a.gueltigAb(), a.gueltigBis()))
                    .findFirst()
                    .map(Abschnitt::zeilen)
                    .orElse(List.of());
            if (zeilen.isEmpty()) {
                offen = offen.add(t.menge());
                continue;
            }
            for (Zeile z : zeilen) {
                BigDecimal anteil = t.menge()
                        .multiply(z.anteilProzent())
                        .divide(SUMME_PROZENT, MENGE_NACHKOMMASTELLEN, RoundingMode.HALF_UP);
                jeZiel.merge(z.kostenstelle(), anteil, BigDecimal::add);
            }
        }
        Map<String, BigDecimal> fertig = new LinkedHashMap<>();
        jeZiel.forEach((k, v) -> fertig.put(k, v.stripTrailingZeros()));
        return new MengenUrteil(fertig, summe.stripTrailingZeros(), offen.stripTrailingZeros(), null);
    }

    // ------------------------------------------------------------------------------- Erbe

    /** Die Quelle einer Verteilung: der Wert, der aufgeteilt wird. */
    public record Quelle(
            String messstelle,
            BigDecimal menge,
            String zustand,
            Integer abdeckungProzent,
            int version,
            List<String> kennzeichen) {}

    public record ErbeUrteil(
            BigDecimal menge,
            String zustand,
            Integer abdeckungProzent,
            int version,
            List<String> kennzeichen,
            String grund) {}

    /**
     * §4.5 Zeile „Verteilung“ — das Ziel bekommt {@code Eingang × Anteil} und ERBT Zustand,
     * Abdeckung, Version und Kennzeichen der Quelle; dazu kommt „verteilt (n % von MS-xx)“. Ein
     * verteilter Wert wird dadurch nie ein gemessener: trägt die Quelle „berechnet (Differenz)“,
     * trägt das Ziel es auch.
     *
     * <p>Zwei Quellen werden NICHT verteilt: eine ohne Werte und ein unplausibler (negativer) Rest.
     * Das Ziel bekommt dann „keine Werte“ — nie einen negativen Kostenstellen-Wert.
     */
    public static ErbeUrteil erbe(
            Quelle quelle, BigDecimal anteilProzent, int fassung, String ziel, String einheit) {
        String kennzeichenVerteilt = "verteilt ("
                + anteilProzent.stripTrailingZeros().toPlainString() + " % von " + quelle.messstelle() + ")";
        if (quelle.menge() == null || BilanzAbleitung.KEINE_WERTE.equals(quelle.zustand())) {
            return new ErbeUrteil(null, BilanzAbleitung.KEINE_WERTE, quelle.abdeckungProzent(),
                    quelle.version(), List.of(BilanzAbleitung.KEINE_WERTE), GRUND_QUELLE_KEINE_WERTE);
        }
        if (quelle.menge().signum() < 0) {
            return new ErbeUrteil(null, BilanzAbleitung.KEINE_WERTE, quelle.abdeckungProzent(),
                    quelle.version(), List.of(ERBE_REST_UNPLAUSIBEL), GRUND_REST_UNPLAUSIBEL);
        }
        BigDecimal menge = quelle.menge()
                .multiply(anteilProzent)
                .divide(SUMME_PROZENT, MENGE_NACHKOMMASTELLEN, RoundingMode.HALF_UP)
                .stripTrailingZeros();
        List<String> kennzeichen = new ArrayList<>(List.of(kennzeichenVerteilt));
        kennzeichen.addAll(quelle.kennzeichen());
        return new ErbeUrteil(menge, quelle.zustand(), quelle.abdeckungProzent(), quelle.version(),
                List.copyOf(kennzeichen), null);
    }

    // ------------------------------------------------------------------------------- Term

    /**
     * Ein Term der Art {@code verteilung} (E11): er meint „Anteil der Kostenstelle X an der
     * Messstelle Y“ und folgt der Verteilung — er trägt deshalb KEINEN eigenen Faktor.
     */
    public record VerteilungsTerm(
            String art,
            String verteilungZiel,
            String quellMessstelle,
            String anteil,
            BigDecimal faktor,
            String vorzeichen) {}

    public record TermUrteil(
            BigDecimal menge, BigDecimal anteilProzent, List<String> kennzeichen, String fehler) {}

    /**
     * Trägt ein Verteilungs-Term einen zulässigen Faktor? Nur 1 (oder keinen): ein kopierter Anteil
     * als Faktor liefe der Verteilung davon ({@link #FEHLER_TERM_FAKTOR}). Der Schreibweg der Formel
     * (AP-10 IP-5, {@link AnteilLeseweg}) fragt dieselbe Regel, bevor er einen Term speichert.
     */
    public static boolean faktorErlaubt(BigDecimal faktor) {
        return faktor == null || faktor.compareTo(BigDecimal.ONE) == 0;
    }

    /**
     * Der Verteilungs-Term liest den Anteil des TAGES aus der Verteilung. Ein kopierter Faktor
     * (etwa 0,7 statt des Verweises) wird abgelehnt: er liefe der Verteilung davon, sobald sie sich
     * ändert. Gibt es am Tag keine Verteilungszeile, gibt es keinen Anteil — nie einen geratenen.
     */
    public static TermUrteil term(
            VerteilungsTerm t, LocalDate tag, BigDecimal quelleMenge, List<Abschnitt> verteilung) {
        if (!faktorErlaubt(t.faktor())) {
            return new TermUrteil(null, null, List.of(), FEHLER_TERM_FAKTOR);
        }
        BigDecimal anteil = verteilung.stream()
                .filter(a -> gilt(tag, a.gueltigAb(), a.gueltigBis()))
                .findFirst()
                .flatMap(a -> a.zeilen().stream()
                        .filter(z -> z.kostenstelle().equals(t.verteilungZiel()))
                        .findFirst())
                .map(Zeile::anteilProzent)
                .orElse(null);
        if (anteil == null) {
            return new TermUrteil(null, null, List.of(), FEHLER_NICHT_VERTEILT);
        }
        BigDecimal menge = quelleMenge
                .multiply(anteil)
                .divide(SUMME_PROZENT, MENGE_NACHKOMMASTELLEN, RoundingMode.HALF_UP)
                .stripTrailingZeros();
        String kennzeichen = "verteilt (" + anteil.stripTrailingZeros().toPlainString() + " % von "
                + t.quellMessstelle() + ")";
        return new TermUrteil(menge, anteil.stripTrailingZeros(), List.of(kennzeichen), null);
    }
}
