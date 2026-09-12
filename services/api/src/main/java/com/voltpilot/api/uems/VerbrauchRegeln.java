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
 * <p>Wer anruft: der Verdichtungs-Lauf je Viertelstunde (AP-08 IP-2) und — über
 * {@link #zaehlerstandAusTeilperioden} — Tag, Monat, Jahr und freier Zeitraum (AP-08 IP-5).
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

    // Die Kennzeichen, die die Zusammensetzung aus Teilperioden (P7, §4.5) wiedererkennen muss —
    // an EINER Stelle, damit Erzeugen und Wiedererkennen nicht auseinanderlaufen.
    static final String ANFANG_NICHT_GEMESSEN = "Anfang nicht gemessen (kein Stand an der Periodengrenze)";
    static final String ENDE_NICHT_GEMESSEN = "Ende nicht gemessen (kein Stand an der Periodengrenze)";
    static final String NUR_EIN_STAND = "nur ein Stand in der Periode — keine Menge bildbar";
    static final String ZUWACHS_NICHT_MESSBAR = "Zuwachs am Wechsel nicht messbar (Ablesestände fehlen)";
    static final String RUECKSETZUNG = "Rücksetzung ";
    static final String NEUSTART = "Neustart ";

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
            return leer(UNVOLLSTAENDIG, gute.size(), List.of(NUR_EIN_STAND));
        }

        List<Ereignis> grenzen = ereignisseIn(ereignisse, Ereignis.GERAETEGRENZE, von, bis);
        List<Ereignis> neustarts = ereignisseIn(ereignisse, Ereignis.NEUSTART, von, bis);

        List<String> kennzeichen = new ArrayList<>();
        BigDecimal menge = BigDecimal.ZERO;
        boolean unvollstaendig = false;
        if (standAnfang == null) {
            unvollstaendig = true;
            kennzeichen.add(ANFANG_NICHT_GEMESSEN);
        }
        if (standEnde == null) {
            unvollstaendig = true;
            kennzeichen.add(ENDE_NICHT_GEMESSEN);
        }

        for (int i = 0; i + 1 < folge.size(); i++) {
            Paar p = paar(folge.get(i), folge.get(i + 1), grenzen, kadenz, faktor, wertebereichModul,
                    hoechstzuwachsJeKadenz, kennzeichen);
            menge = menge.add(p.beitrag());
            unvollstaendig |= p.unvollstaendig();
        }

        unvollstaendig |= neustartKennzeichen(neustarts, kennzeichen);

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

    /**
     * Z6 (E4) — ist der fallende Stand {@code vorher → nachher} ein Überlauf? Die EINE Entscheidung:
     * die Mengenregel ({@link #paar}), die Prüfung der Meldung {@code counter_overflow}
     * ({@link EreignisVokabular}) und — als Zwilling {@code UeberlaufRegel} — die Erkennung im
     * Writer fragen hier.
     *
     * <p>Ein Überlauf ist es nur, wenn der Stand FÄLLT, der Wertebereich (Modul) UND der
     * Höchstzuwachs je Kadenz deklariert sind und {@code Modul − vorher + nachher} die Schranke
     * {@code Höchstzuwachs × (Zeitabstand ÷ Kadenz)} nicht überschreitet. Fehlt eine der beiden
     * Angaben, wird nichts geraten: die Antwort ist {@code null}, und der Sprung bleibt eine
     * Rücksetzung (Z5).
     *
     * @return der Zuwachs über den Überlauf (in Rohwert-Einheit, vor dem Faktor), sonst {@code null}
     */
    public static BigDecimal ueberlauf(Rohwert vorher, Rohwert nachher, Duration kadenz,
            BigDecimal wertebereichModul, BigDecimal hoechstzuwachsJeKadenz) {
        if (wertebereichModul == null || hoechstzuwachsJeKadenz == null
                || nachher.wert().compareTo(vorher.wert()) >= 0) {
            return null;
        }
        BigDecimal ueber = wertebereichModul.subtract(vorher.wert()).add(nachher.wert());
        BigDecimal schranke = hoechstzuwachsJeKadenz.multiply(kadenzen(vorher.zeit(), nachher.zeit(), kadenz));
        return ueber.compareTo(schranke) <= 0 ? ueber : null;
    }

    private static Ergebnis leer(String zustand, int erhalten, List<String> kennzeichen) {
        return new Ergebnis(null, null, null, null, null, zustand, erhalten, 0, null, List.copyOf(kennzeichen));
    }

    /** Der Beitrag EINER Nachbarschaft der Wertfolge (in Rohwert-Einheit, vor dem Faktor). */
    private record Paar(BigDecimal beitrag, boolean unvollstaendig) {}

    /**
     * Z2/Z4/Z5/Z6 — eine Nachbarschaft {@code vorher → nachher} einordnen und ihr Kennzeichen
     * anhängen. Die EINE Stelle dafür: die Rohwert-Regel und die Zusammensetzung aus
     * Teilperioden rufen beide hier an.
     */
    private static Paar paar(Rohwert vorher, Rohwert nachher, List<Ereignis> grenzen, Duration kadenz,
            BigDecimal faktor, BigDecimal wertebereichModul, BigDecimal hoechstzuwachsJeKadenz,
            List<String> kennzeichen) {
        Ereignis grenze = grenzen.stream()
                .filter(e -> e.zeit().isAfter(vorher.zeit()) && !e.zeit().isAfter(nachher.zeit()))
                .findFirst()
                .orElse(null);
        if (grenze != null) {
            BigDecimal alt = grenze.endstand() != null ? grenze.endstand().subtract(vorher.wert()) : BigDecimal.ZERO;
            BigDecimal neu =
                    grenze.anfangsstand() != null ? nachher.wert().subtract(grenze.anfangsstand()) : BigDecimal.ZERO;
            boolean mit = grenze.endstand() != null && grenze.anfangsstand() != null;
            kennzeichen.add("Gerätegrenze " + grenze.uhrzeit()
                    + (mit ? " mit Ablesestände" : " ohne Ablesestände"));
            if (!mit) {
                kennzeichen.add(ZUWACHS_NICHT_MESSBAR);
            }
            if (istLuecke(vorher.zeit(), nachher.zeit(), kadenz)) {
                kennzeichen.add("Lücke am Wechsel " + uhr(vorher.zeit()) + "–" + uhr(nachher.zeit())
                        + " (nicht aufgefüllt)");
            }
            return new Paar(alt.add(neu), !mit);
        }

        BigDecimal zuwachs = nachher.wert().subtract(vorher.wert());
        if (zuwachs.signum() < 0) {
            BigDecimal ueber = ueberlauf(vorher, nachher, kadenz, wertebereichModul, hoechstzuwachsJeKadenz);
            if (ueber != null) {
                kennzeichen.add("Überlauf " + uhr(nachher.zeit())
                        + " (Wertebereich " + wertebereichModul.toPlainString() + ")");
                return new Paar(ueber, false);
            }
            // Rücksetzung ohne Endstand: gezählt sind nur die Strecken bis vorher und ab
            // nachher - was dazwischen lag, weiß niemand und wird nicht geschätzt.
            kennzeichen.add(RUECKSETZUNG + uhr(nachher.zeit())
                    + " ohne Endstand — bis zu 1 Kadenz nicht gezählt");
            return new Paar(BigDecimal.ZERO, true);
        }

        if (istLuecke(vorher.zeit(), nachher.zeit(), kadenz)) {
            kennzeichen.add("Lücke " + uhr(vorher.zeit()) + "–" + uhr(nachher.zeit())
                    + ": Zuwachs " + runde(zuwachs.multiply(faktor), NACHKOMMASTELLEN).toPlainString()
                    + " gemessen, nicht auf Viertelstunden verteilbar");
        }
        return new Paar(zuwachs, false);
    }

    /** Z7 — je Neustart ein Kennzeichen, zuletzt; {@code true}, wenn es einen gab. */
    private static boolean neustartKennzeichen(List<Ereignis> neustarts, List<String> kennzeichen) {
        for (Ereignis neustart : neustarts) {
            kennzeichen.add(NEUSTART + neustart.uhrzeit() + ": bis zu " + neustart.verlustS()
                    + " s Zählung möglicherweise verloren");
        }
        return !neustarts.isEmpty();
    }

    // ------------------------------------------- Zählerstand aus Teilperioden (P7, §4.5)

    /**
     * Eine gebildete Periode, wie eine GRÖBERE sie braucht: ihr Ergebnis und die Stützstellen,
     * aus denen es entstand. Genau das trägt eine gespeicherte Viertelstunde, ein Tag, ein Monat.
     *
     * @param standAnfang Z1: {@code Stand(von)}, {@code null} wenn an dieser Grenze nicht gemessen
     * @param standEnde Z1: {@code Stand(bis)}, {@code null} wenn nicht gemessen
     * @param erster der erste gute Wert in {@code [von, bis)}, {@code null} ohne guten Wert
     * @param letzter der letzte gute Wert in {@code [von, bis)}
     * @param ergebnis Menge, Zustand, erhalten, erwartet und Kennzeichen dieser Periode
     */
    public record Teilperiode(
            Instant von,
            Instant bis,
            Rohwert standAnfang,
            Rohwert standEnde,
            Rohwert erster,
            Rohwert letzter,
            Ergebnis ergebnis) {}

    /** Eine Periode aus Rohwerten als {@link Teilperiode} — die Form, in der sie gespeichert wird. */
    public static Teilperiode teilperiode(
            List<Rohwert> werte,
            Instant von,
            Instant bis,
            Duration kadenz,
            Collection<Ereignis> ereignisse,
            BigDecimal faktor,
            BigDecimal wertebereichModul,
            BigDecimal hoechstzuwachsJeKadenz) {
        Ergebnis e = ergebnis("zaehlerstand", werte, von, bis, kadenz, ereignisse, faktor, wertebereichModul,
                hoechstzuwachsJeKadenz, false);
        List<Rohwert> gute = guteIn(werte, von, bis);
        return new Teilperiode(von, bis, periodenstand(werte, von, kadenz), periodenstand(werte, bis, kadenz),
                gute.isEmpty() ? null : gute.get(0), gute.isEmpty() ? null : gute.get(gute.size() - 1), e);
    }

    /**
     * P7/§4.5 — die Menge einer GRÖBEREN Periode {@code [von, bis)} aus den gespeicherten
     * Teilperioden, <b>aus den Periodenständen und nie als Summe der Teilmengen</b>.
     *
     * <p>Das Ergebnis ist dasselbe wie {@link #mengeZaehlerstand} über alle Rohwerte der Periode
     * ({@code VerbrauchTeilperiodenTest} hält das an jedem Zählerstand-Fall der Vektor-Datei fest).
     * Es wird nur aus dem gebildet, was die Teilperioden tragen:
     *
     * <ul>
     *   <li><b>Periodenstände:</b> {@code Stand(von)}/{@code Stand(bis)} der gröberen Periode trägt
     *       die Teilperiode, die dort beginnt oder endet; liegt dort keine an (sie hatte keinen
     *       einzigen Rohwert), ist es der letzte gute Wert davor — im Fenster
     *       {@code (t − Kadenz, t]}, nie ein älterer.
     *   <li><b>Menge:</b> {@code Stand am Kettenende − Stand am Kettenanfang}, dazu je Teilperiode ihr
     *       BRUCH (was ihre Menge von ihrer eigenen Standdifferenz trennt: Gerätegrenze, Überlauf,
     *       Rücksetzung — ohne solche ist er genau 0) und je Grenze, an der kein Stand gemessen
     *       wurde, die Nachbarschaft {@code letzter Wert davor → erster Wert danach}, eingeordnet wie
     *       jede andere (Lücke, Rücksetzung, Gerätegrenze). Die Summe gerundeter Teilmengen wäre
     *       schon ohne jede Lücke falsch (F16: 55 100,013 statt 55 100,000 aus 31 Tagen).
     *   <li><b>Zustand und Kennzeichen:</b> die Randkennzeichen der Teilperioden an INNEREN
     *       Grenzen entfallen (dort misst die gröbere Periode durch), alle anderen bleiben in ihrer
     *       Reihenfolge; Neustarts werden aus den Ereignissen der gröberen Periode gebildet.
     *   <li><b>Abdeckung:</b> Summe erhalten ÷ Summe erwartet — eine Teilperiode ohne Zeile zählt
     *       mit ihrer Erwartung ({@code Länge ÷ Kadenz}), nie als erfüllt.
     * </ul>
     *
     * @param teile die Teilperioden IN {@code [von, bis)} und höchstens je eine direkt davor und
     *     an {@code bis} (für die Periodenstände); eine, die über eine Grenze ragt, ist ein Fehler
     * @param kadenz die Kadenz der Reihe: Fenster der Periodenstände, Lückenschwelle, Erwartung
     *     der Zeit ohne Teilperiode
     */
    public static Teilperiode zaehlerstandAusTeilperioden(
            List<Teilperiode> teile,
            Instant von,
            Instant bis,
            Duration kadenz,
            Collection<Ereignis> ereignisse,
            BigDecimal faktor,
            BigDecimal wertebereichModul,
            BigDecimal hoechstzuwachsJeKadenz) {
        List<Teilperiode> alle = teile.stream().sorted(Comparator.comparing(Teilperiode::von)).toList();
        List<Teilperiode> innen = new ArrayList<>();
        Instant bisher = von;
        for (Teilperiode t : alle) {
            boolean drin = !t.von().isBefore(von) && !t.bis().isAfter(bis);
            boolean beruehrt = t.von().isBefore(bis) && t.bis().isAfter(von);
            if (beruehrt && !drin) {
                throw new IllegalArgumentException("Teilperiode " + t.von() + "–" + t.bis()
                        + " ragt über die Periode " + von + "–" + bis);
            }
            if (drin) {
                if (t.von().isBefore(bisher)) {
                    throw new IllegalArgumentException("Teilperioden überlappen bei " + t.von());
                }
                innen.add(t);
                bisher = t.bis();
            }
        }

        Rohwert standAnfang = standAnGrenze(alle, von, kadenz);
        Rohwert standEnde = standAnGrenze(alle, bis, kadenz);
        int erhalten = innen.stream().mapToInt(t -> t.ergebnis().erhalten()).sum();
        int erwartet = erwartetAusTeilperioden(innen, von, bis, kadenz);
        Rohwert erster = innen.stream().map(Teilperiode::erster).filter(r -> r != null).findFirst().orElse(null);
        Rohwert letzter = innen.stream().map(Teilperiode::letzter).filter(r -> r != null)
                .reduce((a, b) -> b).orElse(null);

        if (erster == null
                && (Duration.between(von, bis).compareTo(kadenz) < 0 || standEnde == null)) {
            return new Teilperiode(von, bis, standAnfang, standEnde, null, null,
                    leer(KEINE_WERTE, 0, List.of()).mitAbdeckung(erwartet));
        }

        // Die Kette: Stand(von) → je Teilperiode ihre Strecke → Stand(bis). `ueber.get(i)` ist die
        // Teilperiode, deren Strecke von punkte[i] nach punkte[i+1] führt — null heißt: diese
        // Nachbarschaft liegt über einer Grenze ohne gemessenen Stand und wird hier eingeordnet.
        List<Rohwert> punkte = new ArrayList<>();
        List<Teilperiode> ueber = new ArrayList<>();
        anhaengen(punkte, ueber, standAnfang, null);
        for (Teilperiode t : innen) {
            Rohwert a = t.standAnfang() != null ? t.standAnfang() : t.erster();
            Rohwert e = t.standEnde() != null ? t.standEnde() : t.letzter();
            a = a != null ? a : e;
            e = e != null ? e : a;
            if (a == null) {
                continue;
            }
            anhaengen(punkte, ueber, a, null);
            anhaengen(punkte, ueber, e, t);
        }
        anhaengen(punkte, ueber, standEnde, null);

        if (punkte.size() < 2) {
            return new Teilperiode(von, bis, standAnfang, standEnde, erster, letzter,
                    leer(UNVOLLSTAENDIG, erhalten, List.of(NUR_EIN_STAND)).mitAbdeckung(erwartet));
        }

        List<Ereignis> grenzen = ereignisseIn(ereignisse, Ereignis.GERAETEGRENZE, von, bis);
        List<String> kennzeichen = new ArrayList<>();
        boolean unvollstaendig = false;
        if (standAnfang == null) {
            unvollstaendig = true;
            kennzeichen.add(ANFANG_NICHT_GEMESSEN);
        }
        if (standEnde == null) {
            unvollstaendig = true;
            kennzeichen.add(ENDE_NICHT_GEMESSEN);
        }

        Rohwert kettenAnfang = punkte.get(0);
        Rohwert kettenEnde = punkte.get(punkte.size() - 1);
        BigDecimal menge = kettenEnde.wert().subtract(kettenAnfang.wert()).multiply(faktor);
        for (int i = 0; i + 1 < punkte.size(); i++) {
            Rohwert vorher = punkte.get(i);
            Rohwert nachher = punkte.get(i + 1);
            BigDecimal differenz = nachher.wert().subtract(vorher.wert());
            Teilperiode t = ueber.get(i);
            if (t == null) {
                Paar p = paar(vorher, nachher, grenzen, kadenz, faktor, wertebereichModul,
                        hoechstzuwachsJeKadenz, kennzeichen);
                menge = menge.add(p.beitrag().subtract(differenz).multiply(faktor));
                unvollstaendig |= p.unvollstaendig();
                continue;
            }
            // Der BRUCH der Teilperiode: was ihre Menge von ihrer Standdifferenz trennt. Ohne
            // Gerätegrenze, Überlauf und Rücksetzung ist er genau 0 — gerundet wie die Menge selbst.
            BigDecimal teilmenge = t.ergebnis().menge() != null ? t.ergebnis().menge() : BigDecimal.ZERO;
            menge = menge.add(teilmenge.subtract(runde(differenz.multiply(faktor), NACHKOMMASTELLEN)));
            for (String k : t.ergebnis().kennzeichen()) {
                if (k.equals(ANFANG_NICHT_GEMESSEN) || k.equals(ENDE_NICHT_GEMESSEN)
                        || k.equals(NUR_EIN_STAND) || k.startsWith(NEUSTART)) {
                    continue;
                }
                kennzeichen.add(k);
                unvollstaendig |= k.equals(ZUWACHS_NICHT_MESSBAR) || k.startsWith(RUECKSETZUNG);
            }
        }

        unvollstaendig |= neustartKennzeichen(ereignisseIn(ereignisse, Ereignis.NEUSTART, von, bis), kennzeichen);

        Ergebnis ergebnis = new Ergebnis(
                        runde(menge, NACHKOMMASTELLEN),
                        null,
                        null,
                        null,
                        null,
                        unvollstaendig ? UNVOLLSTAENDIG : VOLLSTAENDIG,
                        erhalten,
                        0,
                        null,
                        List.copyOf(kennzeichen))
                .mitAbdeckung(erwartet);
        return new Teilperiode(von, bis, standAnfang, standEnde, erster, letzter, ergebnis);
    }

    /** Einen Punkt an die Kette hängen — derselbe Zeitpunkt ist derselbe Stand und verbindet nur. */
    private static void anhaengen(List<Rohwert> punkte, List<Teilperiode> ueber, Rohwert punkt, Teilperiode teil) {
        if (punkt == null) {
            return;
        }
        if (!punkte.isEmpty() && !punkt.zeit().isAfter(punkte.get(punkte.size() - 1).zeit())) {
            return;
        }
        if (!punkte.isEmpty()) {
            ueber.add(teil);
        }
        punkte.add(punkt);
    }

    /**
     * Z1 an einer Grenze {@code t} der gröberen Periode — aus den Teilperioden: die dort beginnt
     * oder endet, hat ihren Stand schon gebildet; sonst hatte an {@code t} keine einen Rohwert, und
     * der Stand ist der letzte gute Wert davor, sofern er im Fenster {@code (t − Kadenz, t]} liegt.
     */
    private static Rohwert standAnGrenze(List<Teilperiode> alle, Instant t, Duration kadenz) {
        for (Teilperiode p : alle) {
            if (p.von().equals(t)) {
                return p.standAnfang();
            }
        }
        for (Teilperiode p : alle) {
            if (p.bis().equals(t)) {
                return p.standEnde();
            }
        }
        Rohwert kandidat = null;
        for (Teilperiode p : alle) {
            if (p.bis().isAfter(t)) {
                continue;
            }
            for (Rohwert r : new Rohwert[] {p.letzter(), p.standEnde()}) {
                if (r != null && !r.zeit().isAfter(t) && (kandidat == null || r.zeit().isAfter(kandidat.zeit()))) {
                    kandidat = r;
                }
            }
        }
        return kandidat != null && kandidat.zeit().isAfter(t.minus(kadenz)) ? kandidat : null;
    }

    /**
     * §4.5 — die Erwartung der gröberen Periode: Summe der Erwartungen ihrer Teilperioden, und
     * für die Zeit, in der keine Teilperiode steht, {@code Länge ÷ Kadenz}. Eine fehlende
     * Viertelstunde ist nie erfüllt.
     */
    public static int erwartetAusTeilperioden(List<Teilperiode> innen, Instant von, Instant bis, Duration kadenz) {
        Duration bedeckt = Duration.ZERO;
        int summe = 0;
        for (Teilperiode t : innen) {
            bedeckt = bedeckt.plus(Duration.between(t.von(), t.bis()));
            summe += t.ergebnis().erwartet();
        }
        Duration frei = Duration.between(von, bis).minus(bedeckt);
        return summe + (frei.isNegative() ? 0 : (int) (frei.toNanos() / kadenz.toNanos()));
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
        List<String> kennzeichen = fehlendeIntervallmengen(fehlend, erwartet);
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
            kennzeichen.add(gemesseneZeit((long) treffer.size() * kadenz.toSeconds(), von, bis));
        }
        BigDecimal energie = null;
        if (integrieren) {
            energie = rundeEnergie(integriere(werte, von, bis, kadenz));
            kennzeichen.add(AUS_LEISTUNG_INTEGRIERT);
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
     *
     * <p>Der nächste gute Wert darf HINTER {@code bis} liegen und der haltende VOR {@code von}
     * (höchstens {@code HALTEN_FAKTOR × Kadenz} weit): nur so ergeben die Energien benachbarter
     * Perioden zusammen genau die Energie der gröberen Periode (AP-08 IP-3, F24 Viertelstunde
     * 10:15).
     */
    static BigDecimal integriere(List<Rohwert> werte, Instant von, Instant bis, Duration kadenz) {
        Duration reichweite = kadenz.multipliedBy(HALTEN_FAKTOR);
        List<Rohwert> folge = werte.stream()
                .filter(Rohwert::gut)
                .filter(r -> r.zeit().isAfter(von.minus(reichweite)) && !r.zeit().isAfter(bis.plus(reichweite)))
                .sorted(Comparator.comparing(Rohwert::zeit))
                .toList();
        BigDecimal energie = BigDecimal.ZERO;
        for (int i = 0; i < folge.size(); i++) {
            Rohwert vorher = folge.get(i);
            if (!vorher.zeit().isBefore(bis)) {
                break;
            }
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

    /**
     * E5/M4 — eine Energie aus Leistung steht NIE ohne dieses Kennzeichen. Der Wortlaut ist Vertrag;
     * {@code kennzeichen} der Vektor-Datei nennt seinen Anfang {@link #AUS_LEISTUNG_INTEGRIERT_WORT}.
     */
    public static final String AUS_LEISTUNG_INTEGRIERT =
            "aus Leistung integriert (Rechteck-Halten ≤ 2 × Kadenz, nur gemessene Zeit)";

    /** Das Wort des Kennzeichen-Vokabulars, mit dem {@link #AUS_LEISTUNG_INTEGRIERT} beginnt. */
    public static final String AUS_LEISTUNG_INTEGRIERT_WORT = "aus Leistung integriert";

    /**
     * Die Stellen, unter denen eine ungerundete Energie nur Rechenrauschen trägt: jede Teil-Energie ist
     * eine 28-stellige Division durch 3 600, ihre Summe weicht darum im Bereich 10⁻²⁰ vom wahren Wert
     * ab. Vor der Rundung auf {@link #NACHKOMMASTELLEN} wird dieses Rauschen entfernt — sonst kippte
     * eine Summe genau auf der Rundungsgrenze (F3: 24,1125 kWh) als 24,11249…9 auf 24,112.
     */
    static final int ENERGIE_RAUSCHEN_STELLEN = 15;

    static BigDecimal rundeEnergie(BigDecimal energie) {
        return runde(energie.setScale(ENERGIE_RAUSCHEN_STELLEN, RoundingMode.HALF_EVEN), NACHKOMMASTELLEN);
    }

    /** I2 — das Kennzeichen einer Periode, der Intervallmengen fehlen (leer, wenn keine fehlt). */
    private static List<String> fehlendeIntervallmengen(int fehlend, int erwartet) {
        return fehlend == 0
                ? List.of()
                : List.of(fehlend + " von " + erwartet + " Intervallmengen "
                        + (fehlend == 1 ? "fehlt" : "fehlen") + " — Menge ist die Summe der gemessenen");
    }

    /** M3 — das Kennzeichen einer unvollständigen Momentanwert-Periode. */
    private static String gemesseneZeit(long gemessenS, Instant von, Instant bis) {
        return String.format(Locale.ROOT, "gemessene Zeit %d:%02d min von %d min",
                gemessenS / 60, gemessenS % 60, Duration.between(von, bis).toMinutes());
    }

    // ------------------ Momentanwert und Intervallmenge aus Teilperioden (AP-08 IP-3, §4.5)

    /**
     * Eine gebildete Periode einer Momentanwert- oder Intervallmengen-Reihe, wie eine GRÖBERE sie
     * braucht. Genau das trägt eine gespeicherte Viertelstunde, ein Tag, ein Monat (AP-08 IP-3).
     *
     * @param teil Periode, erster/letzter guter Wert und das (gerundete) Ergebnis; die Stände bleiben
     *     {@code null} — ein Momentanwert hat keinen Periodenstand
     * @param summe die Summe der guten Werte, UNGERUNDET: beim Momentanwert der Werte in
     *     {@code [von, bis)} (daraus das Mittel ohne Mittel von Mitteln), bei der Intervallmenge der
     *     Mengen mit Ende in {@code (von, bis]} mal Faktor; {@code null} ohne guten Wert
     * @param energie nur Momentanwert mit Integration (E5): die Energie UNGERUNDET, sonst {@code null}
     * @param gemessenS Momentanwert: die gemessene Zeit, erhalten × Kadenz (M2)
     * @param lueckeInnen Momentanwert: zwischen zwei guten Werten DIESER Periode liegt eine Lücke
     *     (über {@code LUECKE_FAKTOR × Kadenz})
     */
    public record Werteteil(
            Teilperiode teil, BigDecimal summe, BigDecimal energie, long gemessenS, boolean lueckeInnen) {}

    private static boolean lueckeZwischen(List<Rohwert> gute, Duration kadenz) {
        for (int i = 0; i + 1 < gute.size(); i++) {
            if (istLuecke(gute.get(i).zeit(), gute.get(i + 1).zeit(), kadenz)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Eine Momentanwert-Periode aus Rohwerten als {@link Werteteil} — die Form, in der sie
     * gespeichert wird. {@code werte} muss die Nachbarn bis {@code HALTEN_FAKTOR × Kadenz} vor
     * {@code von} und hinter {@code bis} enthalten, sonst fehlt der Energie das Halten über die
     * Grenze (M4).
     */
    public static Werteteil momentanwertTeil(
            List<Rohwert> werte, Instant von, Instant bis, Duration kadenz, boolean integrieren) {
        Ergebnis e = momentanwerte(werte, von, bis, kadenz, integrieren);
        List<Rohwert> gute = guteIn(werte, von, bis);
        return new Werteteil(
                new Teilperiode(von, bis, null, null, gute.isEmpty() ? null : gute.get(0),
                        gute.isEmpty() ? null : gute.get(gute.size() - 1), e),
                gute.isEmpty() ? null : gute.stream().map(Rohwert::wert).reduce(BigDecimal.ZERO, BigDecimal::add),
                integrieren && !gute.isEmpty() ? integriere(werte, von, bis, kadenz) : null,
                (long) gute.size() * kadenz.toSeconds(),
                lueckeZwischen(gute, kadenz));
    }

    /** Eine Intervallmengen-Periode aus Rohwerten als {@link Werteteil} (I1: Ende in {@code (von, bis]}). */
    public static Werteteil intervallmengeTeil(
            List<Rohwert> werte, Instant von, Instant bis, Duration kadenz, BigDecimal faktor) {
        Ergebnis e = mengeIntervall(werte, von, bis, kadenz, faktor);
        List<Rohwert> treffer = werte.stream()
                .filter(Rohwert::gut)
                .filter(r -> r.zeit().isAfter(von) && !r.zeit().isAfter(bis))
                .sorted(Comparator.comparing(Rohwert::zeit))
                .toList();
        return new Werteteil(
                new Teilperiode(von, bis, null, null, treffer.isEmpty() ? null : treffer.get(0),
                        treffer.isEmpty() ? null : treffer.get(treffer.size() - 1), e),
                treffer.isEmpty() ? null
                        : treffer.stream().map(Rohwert::wert).reduce(BigDecimal.ZERO, BigDecimal::add).multiply(faktor),
                null,
                0,
                false);
    }

    /** Die Teile IN {@code [von, bis)}, der letzte gute Wert davor und der erste gute Wert danach. */
    private record Geordnet(List<Werteteil> innen, Rohwert vorher, Rohwert danach) {}

    private static Geordnet ordnen(List<Werteteil> teile, Instant von, Instant bis) {
        List<Werteteil> innen = new ArrayList<>();
        Rohwert vorher = null;
        Rohwert danach = null;
        for (Werteteil w : teile.stream().sorted(Comparator.comparing(x -> x.teil().von())).toList()) {
            Teilperiode t = w.teil();
            if (!t.von().isBefore(von) && !t.bis().isAfter(bis)) {
                innen.add(w);
            } else if (!t.bis().isAfter(von)) {
                if (t.letzter() != null && (vorher == null || t.letzter().zeit().isAfter(vorher.zeit()))) {
                    vorher = t.letzter();
                }
            } else if (!t.von().isBefore(bis)) {
                if (t.erster() != null && (danach == null || t.erster().zeit().isBefore(danach.zeit()))) {
                    danach = t.erster();
                }
            } else {
                throw new IllegalArgumentException("Teilperiode " + t.von() + "–" + t.bis()
                        + " ragt über die Grenze von " + von + "–" + bis);
            }
        }
        return new Geordnet(innen, vorher, danach);
    }

    private static int erwartetAusWerteteilen(List<Werteteil> innen, Instant von, Instant bis, Duration kadenz) {
        return erwartetAusTeilperioden(innen.stream().map(Werteteil::teil).toList(), von, bis, kadenz);
    }

    /** M4 über eine Strecke {@code [a, b)} OHNE eigenen guten Wert: nur, was der Wert davor hält. */
    private static BigDecimal gehalten(Rohwert p, Rohwert n, Instant a, Instant b, Duration kadenz) {
        if (p == null) {
            return BigDecimal.ZERO;
        }
        boolean haelt = n != null
                && Duration.between(p.zeit(), n.zeit()).compareTo(kadenz.multipliedBy(HALTEN_FAKTOR)) <= 0;
        Instant haeltBis = haelt ? n.zeit() : p.zeit().plus(kadenz);
        Instant start = p.zeit().isAfter(a) ? p.zeit() : a;
        Instant ende = haeltBis.isBefore(b) ? haeltBis : b;
        if (!ende.isAfter(start)) {
            return BigDecimal.ZERO;
        }
        return p.wert()
                .multiply(BigDecimal.valueOf(Duration.between(start, ende).toSeconds()))
                .divide(BigDecimal.valueOf(3600), RECHNUNG);
    }

    /**
     * M1–M4 über eine GRÖBERE Periode aus ihren gespeicherten Teilperioden (AP-08 IP-3, §4.5).
     *
     * <p>Dasselbe Ergebnis wie {@link #momentanwerte} über alle Rohwerte der Periode
     * ({@code VerbrauchWerteteileTest} hält das an jeder Momentanwert-Erwartung der Vektor-Datei
     * fest), gebildet nur aus dem, was die Teile tragen:
     *
     * <ul>
     *   <li><b>Mittel</b> = Summe der Teilsummen ÷ Summe erhalten — nie ein Mittel von Mitteln. Ein
     *       Teil ohne {@code summe} (gebildet vor IP-3) trägt {@code Mittel × erhalten}, genau auf
     *       die Rundung seines Mittels. Min/Max über die Teile.
     *   <li><b>Vollständig</b> nur ohne Lücke zwischen zwei guten Werten — in einem Teil, zwischen
     *       zwei Teilen, zum letzten Wert davor und zum ersten danach — und mit beiden Rändern
     *       innerhalb einer Kadenz (M3). Ein unvollständiger Rand eines Teils ist an einer INNEREN
     *       Grenze kein Rand mehr.
     *   <li><b>Gemessene Zeit</b> = Summe der gemessenen Zeiten; Abdeckung aus erhalten ÷ erwartet,
     *       ein Teil ohne Zeile zählt mit {@code Länge ÷ Kadenz}.
     *   <li><b>Energie</b> (nur {@code integrieren}, dann trägt jeder Teil mit Werten seine) = Summe
     *       der ungerundeten Teil-Energien plus je Strecke ohne Teil mit Werten das Halten des Werts
     *       davor — nie Mittel × Länge. Ohne einen guten Wert gibt es keine Zahl.
     * </ul>
     *
     * @param teile die Teile IN {@code [von, bis)}, dazu höchstens je einer davor und danach mit
     *     gutem Wert (für Lücke und Halten über die Grenze); einer, der über eine Grenze ragt, ist
     *     ein Fehler
     */
    public static Werteteil momentanwertAusTeilperioden(
            List<Werteteil> teile, Instant von, Instant bis, Duration kadenz, boolean integrieren) {
        Geordnet g = ordnen(teile, von, bis);
        int erwartet = erwartetAusWerteteilen(g.innen(), von, bis, kadenz);
        List<Werteteil> gut = g.innen().stream().filter(w -> w.teil().erster() != null).toList();
        if (gut.isEmpty()) {
            Ergebnis leer = leer(KEINE_WERTE, 0, List.of()).mitAbdeckung(erwartet);
            return new Werteteil(new Teilperiode(von, bis, null, null, null, null, leer), null, null, 0, false);
        }
        if (integrieren && gut.stream().anyMatch(w -> w.energie() == null)) {
            throw new IllegalArgumentException("integrieren verlangt die Energie jeder Teilperiode mit Werten");
        }

        int erhalten = 0;
        long gemessenS = 0;
        BigDecimal summe = BigDecimal.ZERO;
        BigDecimal min = null;
        BigDecimal max = null;
        boolean lueckeInnen = false;
        Rohwert letzterBisher = null;
        for (Werteteil w : gut) {
            Ergebnis e = w.teil().ergebnis();
            erhalten += e.erhalten();
            gemessenS += w.gemessenS();
            summe = summe.add(w.summe() != null ? w.summe() : e.mittel().multiply(BigDecimal.valueOf(e.erhalten())));
            min = min == null || e.min().compareTo(min) < 0 ? e.min() : min;
            max = max == null || e.max().compareTo(max) > 0 ? e.max() : max;
            lueckeInnen |= w.lueckeInnen()
                    || (letzterBisher != null && istLuecke(letzterBisher.zeit(), w.teil().erster().zeit(), kadenz));
            letzterBisher = w.teil().letzter();
        }
        Rohwert erster = gut.get(0).teil().erster();
        Rohwert letzter = gut.get(gut.size() - 1).teil().letzter();
        boolean lueckeRand = (g.vorher() != null && erster.zeit().isAfter(von)
                        && istLuecke(g.vorher().zeit(), erster.zeit(), kadenz))
                || (g.danach() != null && istLuecke(letzter.zeit(), g.danach().zeit(), kadenz));
        boolean vollstaendig = !lueckeInnen
                && !lueckeRand
                && Duration.between(von, erster.zeit()).compareTo(kadenz) <= 0
                && Duration.between(letzter.zeit(), bis).compareTo(kadenz) <= 0;

        List<String> kennzeichen = new ArrayList<>();
        if (!vollstaendig) {
            kennzeichen.add(gemesseneZeit(gemessenS, von, bis));
        }
        BigDecimal energie = null;
        if (integrieren) {
            energie = BigDecimal.ZERO;
            Instant stelle = von;
            Rohwert wertDavor = g.vorher();
            for (Werteteil w : gut) {
                energie = energie.add(w.energie())
                        .add(gehalten(wertDavor, w.teil().erster(), stelle, w.teil().von(), kadenz));
                stelle = w.teil().bis();
                wertDavor = w.teil().letzter();
            }
            energie = energie.add(gehalten(wertDavor, g.danach(), stelle, bis, kadenz));
            kennzeichen.add(AUS_LEISTUNG_INTEGRIERT);
        }

        Ergebnis ergebnis = new Ergebnis(
                null,
                runde(summe.divide(BigDecimal.valueOf(erhalten), RECHNUNG), 1),
                min,
                max,
                energie == null ? null : rundeEnergie(energie),
                vollstaendig ? VOLLSTAENDIG : UNVOLLSTAENDIG,
                erhalten,
                0,
                null,
                List.copyOf(kennzeichen))
                .mitAbdeckung(erwartet);
        return new Werteteil(new Teilperiode(von, bis, null, null, erster, letzter, ergebnis),
                summe, energie, gemessenS, lueckeInnen);
    }

    /**
     * I1–I2 über eine GRÖBERE Periode aus ihren gespeicherten Teilperioden (AP-08 IP-3, §4.5).
     *
     * <p>Menge = Summe der UNGERUNDETEN Teilsummen, einmal gerundet — die Summe gerundeter
     * Teilmengen wäre schon ohne Lücke falsch. Jede fehlende Intervallmenge, auch die eines Teils
     * ohne Zeile ({@code Länge ÷ Kadenz}), macht die Periode unvollständig (I2).
     */
    public static Werteteil intervallmengeAusTeilperioden(
            List<Werteteil> teile, Instant von, Instant bis, Duration kadenz) {
        Geordnet g = ordnen(teile, von, bis);
        int erwartet = erwartetAusWerteteilen(g.innen(), von, bis, kadenz);
        List<Werteteil> gut = g.innen().stream().filter(w -> w.teil().ergebnis().erhalten() > 0).toList();
        if (gut.isEmpty()) {
            Ergebnis leer = leer(KEINE_WERTE, 0, List.of()).mitAbdeckung(erwartet);
            return new Werteteil(new Teilperiode(von, bis, null, null, null, null, leer), null, null, 0, false);
        }
        int erhalten = 0;
        BigDecimal summe = BigDecimal.ZERO;
        for (Werteteil w : gut) {
            erhalten += w.teil().ergebnis().erhalten();
            summe = summe.add(w.summe() != null ? w.summe() : w.teil().ergebnis().menge());
        }
        int fehlend = erwartet - erhalten;
        Ergebnis ergebnis = new Ergebnis(
                runde(summe, NACHKOMMASTELLEN),
                null,
                null,
                null,
                null,
                fehlend == 0 ? VOLLSTAENDIG : UNVOLLSTAENDIG,
                erhalten,
                0,
                null,
                fehlendeIntervallmengen(fehlend, erwartet))
                .mitAbdeckung(erwartet);
        return new Werteteil(new Teilperiode(von, bis, null, null, gut.get(0).teil().erster(),
                gut.get(gut.size() - 1).teil().letzter(), ergebnis), summe, null, 0, false);
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
