package com.voltpilot.api.repo;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

/**
 * DIE STEUERUNG MIT BESTAND (Bedienkonzept {@code vp-herzogau-p3-kachel-konzept}
 * §4.3, Captain-Entscheide HZ-3 A und P3-1 bis P3-4 A vom 14.10.2026): vorn
 * stehen der laufende Monat und die letzten 7 Tage, die Tageszahl steht in
 * der Detailansicht - alle drei in EINER Zählweise, „mit Bestand bewertet“.
 *
 * <p>Die Kassenrechnung eines Tages ({@code savedSteuerungEur}, Definition A)
 * bucht einen Abendverkauf am Verkaufstag und den Nachkauf am Folgetag. Mit
 * Bestand zählt zusätzlich, was der gesteuerte Speicher am Tagesende mehr
 * oder weniger hält als der Vergleichsspeicher, bewertet mit dem
 * Bezugspreis - so landen Verkauf und Nachkauf am selben Tag. Die Regeln:
 *
 * <ol>
 *   <li><b>Tag mit Bestand</b> = Steuerung des Tages + (Vorsprung 24:00 −
 *       Vorsprung 00:00) × Bewertung; Vorsprung = gemessener Ladestand −
 *       Vergleichsspeicher, ein Rückstand ist negativ. Gerundet wird je Tag:
 *       Steuerung und Bestand je auf den Cent, der Tag ist ihre Summe - so
 *       rechnet der Rechenweg der Fläche sichtbar nach.</li>
 *   <li><b>Tagesbeginn = Stand nach dem Monatsanker</b>: am Monatsersten ist
 *       der Vorsprung der des frisch verankerten Vergleichsspeichers (≈ 0),
 *       nie der Endstand des Vortags - der buchte einen Betrag, der in keiner
 *       Steuerungszahl steht. Das stellt {@link EarningsRepository} sicher.</li>
 *   <li><b>Monat</b> = Summe seiner Tage, <b>7 Tage</b> = Summe der 7
 *       abgeschlossenen Berliner Kalendertage ({@link #siebenTage}); über eine
 *       Monatsgrenze behält jeder Tag den Wert seines Monats.</li>
 *   <li><b>Bewertung</b> = Bezugspreis × Entlade-Wirkungsgrad √0,92
 *       ({@link #bewertungCtKwh}): Festpreis 25 ct → 23,98 ct; bei dynamischem
 *       Tarif das Tagesmittel der Bezugspreise. Nicht λ - der springt je
 *       Lauf (verworfen am 24.09.2026 als E2 B).</li>
 *   <li><b>Lücke</b>: fehlt ein gemessener Ladestand an einem Tagesrand, hat
 *       der Tag keine Zahl, und jede Summe, die ihn braucht, bleibt leer. Ein
 *       Tag ganz ohne Messung fehlt und zählt nicht (Regel wie
 *       {@code steuerungMonatBisherEur}).</li>
 *   <li><b>Gründe</b> ({@link #gruende}): {@code gestern_verkauft}, wann immer
 *       der Vergleichsspeicher den Tag mindestens 10 kWh voller beginnt (nicht
 *       nur bei Minus); bei Minus dazu {@code wenig_sonne}, sonst der Rückfall
 *       {@code anders_geladen}. {@code haelt_energie_fuer_morgen} entfällt,
 *       denn der Bestand ist eingerechnet; die Planregeln bleiben außen vor.</li>
 * </ol>
 *
 * <p>Die Fälle stehen in {@code docs/contracts/steuerung-tag-vectors.json},
 * Block {@code mit_bestand}; {@code SteuerungMitBestandTest} und das Portal
 * lesen sie. Rein und Docker-frei prüfbar wie {@link SteuerungGrund}.
 */
public final class SteuerungMitBestand {

    /** Entlade-Wirkungsgrad √0,92 ≈ 95,9 %: so viel Strom liefert eine gespeicherte kWh. */
    public static final double ENTLADE_WIRKUNGSGRAD = Math.sqrt(0.92);

    /** Länge des rollierenden Fensters in Berliner Kalendertagen. */
    public static final int FENSTER_TAGE = 7;

    private SteuerungMitBestand() {
    }

    /**
     * Die Bewertung einer gespeicherten kWh in ct: Bezugspreis × √0,92, beide
     * auf 0,01 ct (der Bezugspreis zuerst, damit „25,0 ct × 95,9 %“ sichtbar
     * nachrechnet). Null ohne Bezugspreis.
     */
    public static BigDecimal bewertungCtKwh(BigDecimal bezugCtKwh) {
        if (bezugCtKwh == null) {
            return null;
        }
        return bezugCtKwh.setScale(2, RoundingMode.HALF_UP)
                .multiply(BigDecimal.valueOf(ENTLADE_WIRKUNGSGRAD))
                .setScale(2, RoundingMode.HALF_UP);
    }

    /**
     * Die Eingaben eines Tages; jede darf fehlen.
     *
     * @param steuerungEur die Kassenrechnung des Tages ({@code savedSteuerungEur})
     * @param vorsprungStartKwh Vorsprung um 00:00 (nach Regel 2)
     * @param vorsprungEndeKwh Vorsprung nach dem letzten gemessenen Eimer des Tages
     * @param bezugCtKwh mittlerer Bezugspreis des Tages
     * @param pvKwh Erzeugung des Tages
     * @param loadKwh Verbrauch des Tages
     * @param messungBis Ende des letzten gemessenen Eimers - der Moment von
     *     {@code vorsprungEndeKwh}; null, wo unbekannt
     */
    public record Tag(
            LocalDate tag,
            BigDecimal steuerungEur,
            BigDecimal vorsprungStartKwh,
            BigDecimal vorsprungEndeKwh,
            BigDecimal bezugCtKwh,
            BigDecimal pvKwh,
            BigDecimal loadKwh,
            Instant messungBis) {
    }

    /**
     * Ein bewerteter Tag. {@code mitBestandEur} ist null bei einer Lücke;
     * {@code steuerungEur} und {@code bestandEur} sind auf den Cent gerundet,
     * {@code mitBestandEur} ist ihre Summe.
     */
    public record Bewertet(
            LocalDate tag,
            BigDecimal steuerungEur,
            BigDecimal vorsprungStartKwh,
            BigDecimal vorsprungEndeKwh,
            BigDecimal bezugCtKwh,
            BigDecimal bewertungCtKwh,
            BigDecimal bestandEur,
            BigDecimal mitBestandEur,
            List<String> gruende,
            Instant messungBis) {
    }

    /** Ein Zeitraum mit Bestand: Σ seiner Tage, null bei einer Lücke oder ohne Tag. */
    public record Fenster(LocalDate von, LocalDate bis, BigDecimal mitBestandEur) {
    }

    /**
     * Was eine Fläche zum angefragten Tag braucht: Monat und 7 Tage mit
     * Bestand, den Tag selbst und die Tage des Fensters (neuester zuerst).
     *
     * @param heute der angefragte Tag - null, solange er keinen Eimer hat
     * @param sieben null, wo der Aufrufer das Fenster nicht gerechnet hat
     * @param tage die Tage des 7-Tage-Fensters, die gemessen sind; leer ohne Fenster
     */
    public record Zeitraum(
            BigDecimal bezugCtKwh,
            BigDecimal bewertungCtKwh,
            Fenster monat,
            Fenster sieben,
            Bewertet heute,
            List<Bewertet> tage) {
    }

    /** Ein Tag nach den Regeln 1, 4, 5 und 6. */
    public static Bewertet bewerte(Tag t) {
        BigDecimal steuerung = t.steuerungEur() == null ? null
                : t.steuerungEur().setScale(2, RoundingMode.HALF_UP);
        BigDecimal bewertung = bewertungCtKwh(t.bezugCtKwh());
        BigDecimal bestand = t.vorsprungStartKwh() == null || t.vorsprungEndeKwh() == null
                || bewertung == null ? null
                : t.vorsprungEndeKwh().subtract(t.vorsprungStartKwh()).multiply(bewertung)
                        .divide(BigDecimal.valueOf(100), 2, RoundingMode.HALF_UP);
        BigDecimal mitBestand = steuerung == null || bestand == null ? null
                : steuerung.add(bestand);
        return new Bewertet(t.tag(), steuerung, t.vorsprungStartKwh(), t.vorsprungEndeKwh(),
                t.bezugCtKwh() == null ? null : t.bezugCtKwh().setScale(2, RoundingMode.HALF_UP),
                bewertung, bestand, mitBestand,
                gruende(t.vorsprungStartKwh(), mitBestand, t.pvKwh(), t.loadKwh()),
                t.messungBis());
    }

    /**
     * Die Gründe eines Tages mit Bestand (Regel 6), höchstens
     * {@link SteuerungGrund#HOECHSTENS}; jede Regel braucht ihre Eingaben.
     */
    public static List<String> gruende(BigDecimal vorsprungStartKwh, BigDecimal mitBestandEur,
            BigDecimal pvKwh, BigDecimal loadKwh) {
        List<String> gruende = new ArrayList<>(2);
        if (vorsprungStartKwh != null && vorsprungStartKwh.negate()
                .compareTo(SteuerungGrund.GESTERN_VERKAUFT_AB_KWH) >= 0) {
            gruende.add(SteuerungGrund.GESTERN_VERKAUFT);
        }
        if (mitBestandEur != null && mitBestandEur.signum() < 0) {
            boolean wenigSonne = pvKwh != null && loadKwh != null && loadKwh.signum() > 0
                    && pvKwh.compareTo(loadKwh.multiply(SteuerungGrund.WENIG_SONNE_UNTER_ANTEIL)) < 0;
            gruende.add(wenigSonne ? SteuerungGrund.WENIG_SONNE : SteuerungGrund.ANDERS_GELADEN);
        }
        return List.copyOf(gruende.subList(0, Math.min(SteuerungGrund.HOECHSTENS, gruende.size())));
    }

    /**
     * Das 7-Tage-Fenster zum angefragten Tag {@code tag}: die 7
     * abgeschlossenen Berliner Kalendertage. Läuft der Tag noch, sind das die
     * 7 Tage davor; wer auf einen abgeschlossenen Tag zurückblättert, sieht
     * die 7 Tage bis einschließlich dieses Tages. Kalendertage, nie 7 × 24 h.
     */
    public static Fenster siebenTage(LocalDate tag, boolean laeuft) {
        LocalDate bis = laeuft ? tag.minusDays(1) : tag;
        return new Fenster(bis.minusDays(FENSTER_TAGE - 1), bis, null);
    }

    /**
     * Σ der Tage in {@code [von, bis]} (Regel 3 und 5): null, wenn ein
     * gemessener Tag darin keine Zahl hat oder gar kein Tag gemessen ist.
     */
    public static Fenster fenster(Collection<Bewertet> tage, LocalDate von, LocalDate bis) {
        BigDecimal summe = null;
        for (Bewertet t : tage) {
            if (t.tag().isBefore(von) || t.tag().isAfter(bis)) {
                continue;
            }
            if (t.mitBestandEur() == null) {
                return new Fenster(von, bis, null);
            }
            summe = summe == null ? t.mitBestandEur() : summe.add(t.mitBestandEur());
        }
        return new Fenster(von, bis, summe);
    }

    /**
     * Monat, 7 Tage und Tag zum angefragten Tag aus den bewerteten Tagen
     * EINES Walks.
     *
     * @param tage bewertete Tage je Datum; sie müssen den Monat von
     *     {@code tag} bis einschließlich {@code tag} enthalten und, wenn
     *     {@code mitSieben}, das 7-Tage-Fenster
     * @param mitSieben false, wo der Walk das Fenster nicht abdeckt (die
     *     Mandanten-Route rechnet ihre 7 Tage aus der 14-Tage-Reihe)
     */
    public static Zeitraum zeitraum(Map<LocalDate, Bewertet> tage, LocalDate tag, boolean laeuft,
            boolean mitSieben) {
        Bewertet heute = tage.get(tag);
        Fenster monat = fenster(tage.values(), tag.withDayOfMonth(1), tag);
        Fenster sieben = null;
        List<Bewertet> liste = List.of();
        if (mitSieben) {
            Fenster spanne = siebenTage(tag, laeuft);
            sieben = fenster(tage.values(), spanne.von(), spanne.bis());
            liste = tage.values().stream()
                    .filter(t -> !t.tag().isBefore(spanne.von()) && !t.tag().isAfter(spanne.bis()))
                    .sorted(Comparator.comparing(Bewertet::tag).reversed())
                    .toList();
        }
        // Die Bewertung des Tages; vor seinem ersten Eimer die des jüngsten
        // gemessenen Tages davor.
        Bewertet preis = heute != null && heute.bewertungCtKwh() != null ? heute
                : tage.values().stream()
                        .filter(t -> t.tag().isBefore(tag) && t.bewertungCtKwh() != null)
                        .max(Comparator.comparing(Bewertet::tag))
                        .orElse(null);
        return new Zeitraum(preis == null ? null : preis.bezugCtKwh(),
                preis == null ? null : preis.bewertungCtKwh(), monat, sieben, heute, liste);
    }
}
