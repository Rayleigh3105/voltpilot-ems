package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/**
 * Die REINEN Rechenregeln der Verbrauchsbildung — UEMS AP-08 §4 (Prosa in
 * {@code docs/contracts/v2/verbrauch.md}). Ohne Spring, ohne Repository, ohne Uhr — jede
 * Regel ist ohne einen einzigen Container prüfbar.
 *
 * <p><b>Die Regel steht nicht hier, sie steht in der Vektor-Datei.</b> Die eine Wahrheit ist
 * {@code docs/contracts/v2/verbrauch-vectors.json} mit 23 handgerechneten Referenzfällen des
 * Referenzunternehmens Ahrenberg. Der Zwilling ist
 * {@code services/optimization/voltpilot_optimization/verbrauch.py} (Test
 * {@code tests/test_verbrauch.py}); beide fahren dieselbe Datei PER PFAD
 * ({@link VerbrauchVectorsTest}). <b>Wer eine Regel ändert, ändert beide Seiten und die
 * Vektor-Datei.</b> Warum zwei Umsetzungen: der Optimierer rechnet Verbrauch in Python, die
 * Cloud-Schnittstelle in Java — zwei Umsetzungen driften auseinander, sobald sie nicht beide
 * gegen dieselbe Datei geprüft werden (dasselbe Muster wie beim sturen Speicher,
 * {@code repo/StandardSpeicher} ⟷ {@code voltpilot_optimization/stur.py}).
 *
 * <h2>Drei Wertarten, drei Regeln</h2>
 *
 * <ul>
 *   <li><b>Zählerstand</b> ({@link #mengeZaehlerstand}): Menge = Stand am Periodenende −
 *       Stand am Periodenanfang, über gemessene Strecken. Gerätegrenze, Rücksetzung,
 *       Überlauf und Neustart unterbrechen die Differenzbildung, statt einen fiktiven
 *       Verbrauch zu erzeugen (Z1–Z9).
 *   <li><b>Intervallmenge</b> ({@link #mengeIntervall}): Summe der guten Intervallmengen,
 *       deren Ende in {@code (von, bis]} liegt; jede fehlende Intervallmenge ist verlorene
 *       Menge, nie nur verlorene Zeit (I1–I5).
 *   <li><b>Momentanwert</b> ({@link #momentanwerte}): Mittel/Min/Max über die guten Werte in
 *       {@code [von, bis)}; Energie daraus nur gekennzeichnet, mit Rechteck-Halten über
 *       höchstens zwei Kadenzen (M1–M6).
 * </ul>
 *
 * <p>Die Hausregel der Zahlen-Ehrlichkeit gilt wörtlich: eine Lücke ist nie eine Null, ein
 * nicht gemessener Rand ist nie ein gemessener, und wo keine Menge bildbar ist, steht
 * {@code null} — nie {@code 0}.
 *
 * <p>Noch ruft kein Produktionsweg an — der Verdichtungs-Job bekommt die Regel mit AP-08 IP-2.
 */
public final class VerbrauchRegeln {

    /**
     * Ein Loch ÜBER zwei Kadenzen ist eine Lücke (Z2). Strikt größer — genau zwei Kadenzen
     * sind noch keine Lücke, dieselbe Schwelle wie {@link ZustandAbleitung#LUECKE_FAKTOR}.
     */
    public static final int LUECKE_FAKTOR = 2;

    /** Rechteck-Halten: ein Momentanwert gilt höchstens so viele Kadenzen lang weiter (M4). */
    public static final int HALTEN_FAKTOR = 2;

    /** Auf so viele Nachkommastellen wird verglichen; gerechnet wird ungerundet (§4.7 Nr. 12). */
    public static final int NACHKOMMASTELLEN = 3;

    /** Die Zeitzone, in der die Kennzeichen ihre Uhrzeiten nennen. */
    public static final ZoneId ANZEIGE_ZEITZONE = ZoneId.of("Europe/Berlin");

    public static final String VOLLSTAENDIG = "vollständig";
    public static final String UNVOLLSTAENDIG = "unvollständig";
    public static final String KEINE_WERTE = "keine Werte";

    /** Dieselbe Rechengenauigkeit wie der Python-Zwilling (Decimal-Vorgabe: 28 Stellen, half-even). */
    private static final MathContext RECHNUNG = new MathContext(28, RoundingMode.HALF_EVEN);

    private static final DateTimeFormatter UHR = DateTimeFormatter.ofPattern("HH:mm", Locale.GERMANY);

    private VerbrauchRegeln() {}

    // ------------------------------------------------------------------ Eingangs-Datensätze

    /**
     * Ein Rohwert der Reihe.
     *
     * @param zeit Messzeit
     * @param wert Wert VOR dem Faktor der Fassung
     * @param gut ob der Wert gut ist; ein nicht guter Wert zählt nirgends mit
     */
    public record Rohwert(Instant zeit, BigDecimal wert, boolean gut) {

        public Rohwert(Instant zeit, BigDecimal wert) {
            this(zeit, wert, true);
        }
    }

    /**
     * Ein Ereignis der Reihe (AP-07 IP-3). Es wirkt, wenn seine Zeit in {@code (von, bis]}
     * der Periode liegt.
     *
     * @param art {@code device_boundary} (Gerätegrenze, Z4) oder {@code device_restart} (Z7)
     * @param zeit Zeitpunkt
     * @param uhrzeit die Uhrzeit, wie das Kennzeichen sie nennt (HH:MM aus der Meldung)
     * @param endstand Ablesestand des ALTEN Zählers, {@code null} wenn er fehlt
     * @param anfangsstand Ablesestand des NEUEN Zählers, {@code null} wenn er fehlt
     * @param verlustS Z7: so viele Sekunden Zählung können verloren sein
     */
    public record Ereignis(
            String art,
            Instant zeit,
            String uhrzeit,
            BigDecimal endstand,
            BigDecimal anfangsstand,
            long verlustS) {

        public static final String GERAETEGRENZE = "device_boundary";
        public static final String NEUSTART = "device_restart";

        /** Der Zählverlust eines Neustarts, wenn die Meldung ihn nicht nennt (AP-05: bis 255 s). */
        public static final long VERLUST_VORGABE = 255;
    }

    /**
     * Das Ergebnis einer Periode — genau die Felder, die die Vektor-Datei je Erwartung nennt.
     *
     * @param menge Menge der Periode; {@code null} heißt „keine Menge bildbar“, nie {@code 0}
     * @param mittel Momentanwert: arithmetisches Mittel der guten Werte
     * @param energieKwh nur mit Integration: Energie aus der Leistung, immer gekennzeichnet
     * @param zustand {@link #VOLLSTAENDIG}, {@link #UNVOLLSTAENDIG} oder {@link #KEINE_WERTE}
     * @param erhalten gute Werte im Fenster der Periode (Z9)
     * @param erwartet Periodenlänge ÷ Kadenz (P4)
     * @param abdeckungProzent erhalten ÷ erwartet, abgeschnitten; {@code null} ohne Erwartung
     * @param kennzeichen was an dieser Periode zu sagen ist, in der Reihenfolge der Feststellung
     */
    public record Ergebnis(
            BigDecimal menge,
            BigDecimal mittel,
            BigDecimal min,
            BigDecimal max,
            BigDecimal energieKwh,
            String zustand,
            int erhalten,
            int erwartet,
            Integer abdeckungProzent,
            List<String> kennzeichen) {

        /** Z9 — die Abdeckung des VERLAUFS ergänzen; sie sagt nicht, ob die Menge stimmt. */
        Ergebnis mitAbdeckung(int erwarteteWerte) {
            Integer prozent = erwarteteWerte == 0
                    ? null
                    : BigDecimal.valueOf(erhalten)
                            .multiply(BigDecimal.valueOf(100))
                            .divide(BigDecimal.valueOf(erwarteteWerte), RECHNUNG)
                            .intValue();
            return new Ergebnis(
                    menge, mittel, min, max, energieKwh, zustand, erhalten, erwarteteWerte, prozent, kennzeichen);
        }
    }

    // ------------------------------------------------------------------------- Hilfen

    /**
     * Z1 — Stand(t) ist der LETZTE gute Rohwert mit Messzeit in {@code (t − Kadenz, t]}.
     *
     * <p>Kein Wert in diesem Fenster heißt: an dieser Periodengrenze wurde nicht gemessen. Der
     * Stand wird dann NICHT aus einem älteren Wert fortgeschrieben (das wäre eine erfundene
     * Zahl); die Periode wird unvollständig.
     */
    public static Rohwert periodenstand(List<Rohwert> werte, Instant t, Duration kadenz) {
        Rohwert treffer = null;
        for (Rohwert r : werte) {
            if (!r.gut()) {
                continue;
            }
            if (r.zeit().isAfter(t.minus(kadenz)) && !r.zeit().isAfter(t)) {
                treffer = r;
            } else if (r.zeit().isAfter(t)) {
                break;
            }
        }
        return treffer;
    }

    /** Gute Werte in {@code [von, bis)} — das Fenster der Abdeckung (Z9) und der Momentanwerte. */
    private static List<Rohwert> guteIn(List<Rohwert> werte, Instant von, Instant bis) {
        return werte.stream()
                .filter(Rohwert::gut)
                .filter(r -> !r.zeit().isBefore(von) && r.zeit().isBefore(bis))
                .sorted(Comparator.comparing(Rohwert::zeit))
                .toList();
    }

    /** Hat die Reihe zwischen zwei guten Werten ein Loch ÜBER {@code LUECKE_FAKTOR × Kadenz}, das in {@code [von, bis)} ragt? */
    private static boolean hatLoch(List<Rohwert> werte, Duration kadenz, Instant von, Instant bis) {
        List<Rohwert> gut = werte.stream().filter(Rohwert::gut).sorted(Comparator.comparing(Rohwert::zeit)).toList();
        for (int i = 0; i + 1 < gut.size(); i++) {
            Instant a = gut.get(i).zeit();
            Instant b = gut.get(i + 1).zeit();
            if (Duration.between(a, b).compareTo(kadenz.multipliedBy(LUECKE_FAKTOR)) > 0) {
                Instant lo = a.isAfter(von) ? a : von;
                Instant hi = b.isBefore(bis) ? b : bis;
                if (lo.isBefore(hi)) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean istLuecke(Instant vorher, Instant nachher, Duration kadenz) {
        return Duration.between(vorher, nachher).compareTo(kadenz.multipliedBy(LUECKE_FAKTOR)) > 0;
    }

    private static String uhr(Instant t) {
        return UHR.format(t.atZone(ANZEIGE_ZEITZONE));
    }

    private static BigDecimal runde(BigDecimal x, int stellen) {
        return x.setScale(stellen, RoundingMode.HALF_UP);
    }

    /**
     * P4 — die erwartete Anzahl Werte einer Periode: Periodenlänge ÷ Kadenz, abgeschnitten.
     *
     * <p>Paket-sichtbar statt privat, seit der Verdichtungs-Lauf (AP-07 IP-12) sie für eine Reihe
     * braucht, die gar keine Regel von AP-08 hat (Zustands-, Bitfeld- und Textreihen): er soll die
     * Erwartung AUFRUFEN statt sie ein zweites Mal zu rechnen. Das Verhalten ist unverändert.
     */
    static int erwarteteWerte(Instant von, Instant bis, Duration kadenz) {
        return (int) (Duration.between(von, bis).toNanos() / kadenz.toNanos());
    }

    /** P3 — die Länge der Periode in Stunden; am Umstellungstag 23 oder 25. */
    public static long stunden(Instant von, Instant bis) {
        return Duration.between(von, bis).toHours();
    }

    /** ISO-8601 mit Offset → Zeitpunkt. Gerechnet wird in UTC. */
    public static Instant zeit(String iso) {
        return OffsetDateTime.parse(iso).toInstant();
    }

    // --------------------------------------------------------------------- Zählerstand (Z)

    /**
     * Z1–Z9 — die Menge einer Periode {@code [von, bis)} aus Zählerständen.
     *
     * <p>Gerechnet wird über die Folge {@code Stand(von)} → gute Werte in der Periode →
     * {@code Stand(bis)}. Jede Nachbarschaft dieser Folge wird einzeln eingeordnet:
     *
     * <ul>
     *   <li>Gerätegrenze in {@code (vorher, nachher]}: mit Ablesestände
     *       {@code (Endstand − vorher) + (nachher − Anfangsstand)}, ohne Ablesestände Beitrag 0
     *       und die Periode ist unvollständig (Z4). Nie {@code nachher − vorher}.
     *   <li>Fallender Stand mit deklariertem Wertebereich und plausiblem Zuwachs: Überlauf mit
     *       Beitrag {@code Modul − vorher + nachher} — lückenlos (Z6).
     *   <li>Fallender Stand sonst: Rücksetzung, Beitrag 0, Periode unvollständig (Z5).
     *   <li>Loch über {@code LUECKE_FAKTOR × Kadenz}: der Zuwachs darüber ist GEMESSEN und zählt
     *       zur Periode, ist aber nicht auf feinere Perioden verteilbar (Z2).
     * </ul>
     *
     * @param faktor Z8: Rohwert × faktor ergibt die Einheit der Reihe
     * @param wertebereichModul Z6: der deklarierte Wertebereich, oder {@code null}
     * @param hoechstzuwachsJeKadenz Z6: der größte plausible Zuwachs je Kadenz, oder {@code null}
     */
    public static Ergebnis mengeZaehlerstand(
            List<Rohwert> werte,
            Instant von,
            Instant bis,
            Duration kadenz,
            Collection<Ereignis> ereignisse,
            BigDecimal faktor,
            BigDecimal wertebereichModul,
            BigDecimal hoechstzuwachsJeKadenz) {
        Rohwert standAnfang = periodenstand(werte, von, kadenz);
        Rohwert standEnde = periodenstand(werte, bis, kadenz);
        List<Rohwert> gute = guteIn(werte, von, bis);

        // Kadenz länger als die Periode (z. B. Monatsablesung gegen Viertelstunde, P5/E13):
        // hier ist gar kein Wert erwartbar - das ist "keine Werte", kein Fehlbestand.
        if (Duration.between(von, bis).compareTo(kadenz) < 0 && gute.isEmpty()) {
            return leer(KEINE_WERTE, 0, List.of());
        }
        if (gute.isEmpty() && standEnde == null) {
            return leer(KEINE_WERTE, 0, List.of());
        }

        List<Rohwert> folge = new ArrayList<>();
        if (standAnfang != null) {
            folge.add(standAnfang);
        }
        for (Rohwert r : gute) {
            if (standAnfang == null || !r.zeit().equals(standAnfang.zeit())) {
                folge.add(r);
            }
        }
        if (standEnde != null && (folge.isEmpty() || !standEnde.zeit().equals(folge.get(folge.size() - 1).zeit()))) {
            folge.add(standEnde);
        }
        if (folge.size() < 2) {
            return leer(UNVOLLSTAENDIG, gute.size(), List.of("nur ein Stand in der Periode — keine Menge bildbar"));
        }

        List<Ereignis> grenzen = ereignisseIn(ereignisse, Ereignis.GERAETEGRENZE, von, bis);
        List<Ereignis> neustarts = ereignisseIn(ereignisse, Ereignis.NEUSTART, von, bis);

        List<String> kennzeichen = new ArrayList<>();
        BigDecimal menge = BigDecimal.ZERO;
        boolean unvollstaendig = false;
        if (standAnfang == null) {
            unvollstaendig = true;
            kennzeichen.add("Anfang nicht gemessen (kein Stand an der Periodengrenze)");
        }
        if (standEnde == null) {
            unvollstaendig = true;
            kennzeichen.add("Ende nicht gemessen (kein Stand an der Periodengrenze)");
        }

        for (int i = 0; i + 1 < folge.size(); i++) {
            Rohwert vorher = folge.get(i);
            Rohwert nachher = folge.get(i + 1);
            Ereignis grenze = grenzen.stream()
                    .filter(e -> e.zeit().isAfter(vorher.zeit()) && !e.zeit().isAfter(nachher.zeit()))
                    .findFirst()
                    .orElse(null);
            if (grenze != null) {
                BigDecimal alt = grenze.endstand() != null ? grenze.endstand().subtract(vorher.wert()) : BigDecimal.ZERO;
                BigDecimal neu =
                        grenze.anfangsstand() != null ? nachher.wert().subtract(grenze.anfangsstand()) : BigDecimal.ZERO;
                menge = menge.add(alt).add(neu);
                boolean mit = grenze.endstand() != null && grenze.anfangsstand() != null;
                kennzeichen.add("Gerätegrenze " + grenze.uhrzeit()
                        + (mit ? " mit Ablesestände" : " ohne Ablesestände"));
                if (!mit) {
                    unvollstaendig = true;
                    kennzeichen.add("Zuwachs am Wechsel nicht messbar (Ablesestände fehlen)");
                }
                if (istLuecke(vorher.zeit(), nachher.zeit(), kadenz)) {
                    kennzeichen.add("Lücke am Wechsel " + uhr(vorher.zeit()) + "–" + uhr(nachher.zeit())
                            + " (nicht aufgefüllt)");
                }
                continue;
            }

            BigDecimal zuwachs = nachher.wert().subtract(vorher.wert());
            if (zuwachs.signum() < 0) {
                BigDecimal ueber = wertebereichModul == null
                        ? null
                        : wertebereichModul.subtract(vorher.wert()).add(nachher.wert());
                BigDecimal schranke = hoechstzuwachsJeKadenz == null
                        ? null
                        : hoechstzuwachsJeKadenz.multiply(kadenzen(vorher.zeit(), nachher.zeit(), kadenz));
                if (ueber != null && schranke != null && ueber.compareTo(schranke) <= 0) {
                    menge = menge.add(ueber);
                    kennzeichen.add("Überlauf " + uhr(nachher.zeit())
                            + " (Wertebereich " + wertebereichModul.toPlainString() + ")");
                } else {
                    // Rücksetzung ohne Endstand: gezählt sind nur die Strecken bis vorher und ab
                    // nachher - was dazwischen lag, weiß niemand und wird nicht geschätzt.
                    unvollstaendig = true;
                    kennzeichen.add("Rücksetzung " + uhr(nachher.zeit())
                            + " ohne Endstand — bis zu 1 Kadenz nicht gezählt");
                }
                continue;
            }

            if (istLuecke(vorher.zeit(), nachher.zeit(), kadenz)) {
                kennzeichen.add("Lücke " + uhr(vorher.zeit()) + "–" + uhr(nachher.zeit())
                        + ": Zuwachs " + runde(zuwachs.multiply(faktor), NACHKOMMASTELLEN).toPlainString()
                        + " gemessen, nicht auf Viertelstunden verteilbar");
            }
            menge = menge.add(zuwachs);
        }

        for (Ereignis neustart : neustarts) {
            unvollstaendig = true;
            kennzeichen.add("Neustart " + neustart.uhrzeit() + ": bis zu " + neustart.verlustS()
                    + " s Zählung möglicherweise verloren");
        }

        return new Ergebnis(
                runde(menge.multiply(faktor), NACHKOMMASTELLEN),
                null,
                null,
                null,
                null,
                unvollstaendig ? UNVOLLSTAENDIG : VOLLSTAENDIG,
                gute.size(),
                0,
                null,
                List.copyOf(kennzeichen));
    }

    private static List<Ereignis> ereignisseIn(Collection<Ereignis> alle, String art, Instant von, Instant bis) {
        return alle.stream()
                .filter(e -> art.equals(e.art()))
                .filter(e -> e.zeit().isAfter(von) && !e.zeit().isAfter(bis))
                .toList();
    }

    /** Der Zeitabstand in Kadenzen — die Plausibilitätsschranke des Überlaufs ist je Kadenz gegeben. */
    private static BigDecimal kadenzen(Instant von, Instant bis, Duration kadenz) {
        return BigDecimal.valueOf(Duration.between(von, bis).toNanos())
                .divide(BigDecimal.valueOf(kadenz.toNanos()), RECHNUNG);
    }

    private static Ergebnis leer(String zustand, int erhalten, List<String> kennzeichen) {
        return new Ergebnis(null, null, null, null, null, zustand, erhalten, 0, null, List.copyOf(kennzeichen));
    }

    // ------------------------------------------------------------------ Intervallmenge (I)

    /**
     * I1–I2 — Summe der guten Intervallmengen, deren Ende in {@code (von, bis]} liegt.
     *
     * <p>Anders als beim Momentanwert ist hier jede fehlende Intervallmenge verlorene MENGE,
     * nicht nur verlorene Zeit: schon ein fehlender Wert macht die Periode unvollständig, ganz
     * ohne Loch-Kriterium.
     */
    public static Ergebnis mengeIntervall(
            List<Rohwert> werte, Instant von, Instant bis, Duration kadenz, BigDecimal faktor) {
        List<Rohwert> treffer = werte.stream()
                .filter(Rohwert::gut)
                .filter(r -> r.zeit().isAfter(von) && !r.zeit().isAfter(bis))
                .sorted(Comparator.comparing(Rohwert::zeit))
                .toList();
        int erwartet = erwarteteWerte(von, bis, kadenz);
        if (treffer.isEmpty()) {
            return leer(KEINE_WERTE, 0, List.of()).mitAbdeckung(erwartet);
        }
        BigDecimal summe = treffer.stream().map(Rohwert::wert).reduce(BigDecimal.ZERO, BigDecimal::add).multiply(faktor);
        int fehlend = erwartet - treffer.size();
        List<String> kennzeichen = fehlend == 0
                ? List.of()
                : List.of(fehlend + " von " + erwartet + " Intervallmengen "
                        + (fehlend == 1 ? "fehlt" : "fehlen") + " — Menge ist die Summe der gemessenen");
        return new Ergebnis(
                runde(summe, NACHKOMMASTELLEN),
                null,
                null,
                null,
                null,
                fehlend == 0 ? VOLLSTAENDIG : UNVOLLSTAENDIG,
                treffer.size(),
                0,
                null,
                kennzeichen)
                .mitAbdeckung(erwartet);
    }

    // -------------------------------------------------------------------- Momentanwert (M)

    /**
     * M1–M4 — Mittel/Min/Max über die guten Werte in {@code [von, bis)}.
     *
     * <p>Vollständig ist die Periode nur, wenn sie kein Loch über {@code LUECKE_FAKTOR × Kadenz}
     * hat UND beide Ränder innerhalb einer Kadenz gemessen sind (M3). {@code integrieren}
     * liefert zusätzlich die Energie aus der Leistung: Rechteck-Halten über höchstens
     * {@code HALTEN_FAKTOR × Kadenz} und NUR über gemessene Zeit — nie Mittel × Periodenlänge,
     * das würde die Lücke stillschweigend auffüllen (M4).
     */
    public static Ergebnis momentanwerte(
            List<Rohwert> werte, Instant von, Instant bis, Duration kadenz, boolean integrieren) {
        List<Rohwert> treffer = guteIn(werte, von, bis);
        int erwartet = erwarteteWerte(von, bis, kadenz);
        if (treffer.isEmpty()) {
            return leer(KEINE_WERTE, 0, List.of()).mitAbdeckung(erwartet);
        }

        boolean randAnfang = Duration.between(von, treffer.get(0).zeit()).compareTo(kadenz) <= 0;
        boolean randEnde = Duration.between(treffer.get(treffer.size() - 1).zeit(), bis).compareTo(kadenz) <= 0;
        boolean vollstaendig = !hatLoch(werte, kadenz, von, bis) && randAnfang && randEnde;

        BigDecimal summe = treffer.stream().map(Rohwert::wert).reduce(BigDecimal.ZERO, BigDecimal::add);
        BigDecimal mittel = summe.divide(BigDecimal.valueOf(treffer.size()), RECHNUNG);

        List<String> kennzeichen = new ArrayList<>();
        if (!vollstaendig) {
            long gemessenS = (long) treffer.size() * kadenz.toSeconds();
            kennzeichen.add(String.format(
                    Locale.ROOT,
                    "gemessene Zeit %d:%02d min von %d min",
                    gemessenS / 60,
                    gemessenS % 60,
                    Duration.between(von, bis).toMinutes()));
        }
        BigDecimal energie = null;
        if (integrieren) {
            energie = runde(integriere(werte, von, bis, kadenz), NACHKOMMASTELLEN);
            kennzeichen.add("aus Leistung integriert (Rechteck-Halten ≤ 2 × Kadenz, nur gemessene Zeit)");
        }

        return new Ergebnis(
                null,
                runde(mittel, 1),
                runde(treffer.stream().map(Rohwert::wert).min(BigDecimal::compareTo).orElseThrow(), 1),
                runde(treffer.stream().map(Rohwert::wert).max(BigDecimal::compareTo).orElseThrow(), 1),
                energie,
                vollstaendig ? VOLLSTAENDIG : UNVOLLSTAENDIG,
                treffer.size(),
                0,
                null,
                List.copyOf(kennzeichen))
                .mitAbdeckung(erwartet);
    }

    /**
     * M4 — Rechteck-Halten: jeder Wert gilt bis zum nächsten guten Wert, höchstens
     * {@code HALTEN_FAKTOR × Kadenz}, geschnitten auf die Periode.
     */
    private static BigDecimal integriere(List<Rohwert> werte, Instant von, Instant bis, Duration kadenz) {
        List<Rohwert> folge = werte.stream()
                .filter(Rohwert::gut)
                .filter(r -> r.zeit().isAfter(von.minus(kadenz)) && r.zeit().isBefore(bis))
                .sorted(Comparator.comparing(Rohwert::zeit))
                .toList();
        BigDecimal energie = BigDecimal.ZERO;
        for (int i = 0; i < folge.size(); i++) {
            Rohwert vorher = folge.get(i);
            Rohwert nachher = i + 1 < folge.size() ? folge.get(i + 1) : null;
            boolean haelt = nachher != null
                    && Duration.between(vorher.zeit(), nachher.zeit()).compareTo(kadenz.multipliedBy(HALTEN_FAKTOR))
                            <= 0;
            Instant haeltBis = haelt ? nachher.zeit() : vorher.zeit().plus(kadenz);
            Instant start = vorher.zeit().isAfter(von) ? vorher.zeit() : von;
            Instant ende = haeltBis.isBefore(bis) ? haeltBis : bis;
            if (ende.isAfter(start)) {
                energie = energie.add(vorher.wert()
                        .multiply(BigDecimal.valueOf(Duration.between(start, ende).toSeconds()))
                        .divide(BigDecimal.valueOf(3600), RECHNUNG));
            }
        }
        return energie;
    }

    // ---------------------------------------------------------------------- Der Eingang

    /**
     * Der EINE Eingang: eine Reihe, eine Periode → das Ergebnis der Vektor-Datei.
     *
     * @param wertart {@code zaehlerstand}, {@code intervallmenge} oder {@code momentanwert}
     */
    public static Ergebnis ergebnis(
            String wertart,
            List<Rohwert> werte,
            Instant von,
            Instant bis,
            Duration kadenz,
            Collection<Ereignis> ereignisse,
            BigDecimal faktor,
            BigDecimal wertebereichModul,
            BigDecimal hoechstzuwachsJeKadenz,
            boolean integrieren) {
        return switch (wertart) {
            case "zaehlerstand" -> mengeZaehlerstand(
                            werte, von, bis, kadenz, ereignisse, faktor, wertebereichModul, hoechstzuwachsJeKadenz)
                    .mitAbdeckung(erwarteteWerte(von, bis, kadenz));
            case "intervallmenge" -> mengeIntervall(werte, von, bis, kadenz, faktor);
            case "momentanwert" -> momentanwerte(werte, von, bis, kadenz, integrieren);
            default -> throw new IllegalArgumentException("unbekannte Wertart " + wertart
                    + " — bekannt sind zaehlerstand, intervallmenge, momentanwert");
        };
    }
}
