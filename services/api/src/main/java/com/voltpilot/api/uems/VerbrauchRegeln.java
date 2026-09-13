package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

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
 *       höchstens zwei Kadenzen (M1–M6). Ein Vorzeichen-Wert, den eine Bindung mit Anteil liest,
 *       wird VORHER je Rohwert geteilt ({@link #anteilJeRohwert}, M5/E15).
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

    // Zustandswörter und Kennzeichen-Sätze sind der Vertrag ergebnis-zustand (AP-08 IP-8): diese
    // Klasse formuliert keinen Satz selbst, sie ruft ErgebnisZustand an.
    public static final String VOLLSTAENDIG = ErgebnisZustand.VOLLSTAENDIG;
    public static final String UNVOLLSTAENDIG = ErgebnisZustand.UNVOLLSTAENDIG;
    public static final String KEINE_WERTE = ErgebnisZustand.KEINE_WERTE;

    // Die Kennzeichen, die die Zusammensetzung aus Teilperioden (P7, §4.5) wiedererkennen muss —
    // an EINER Stelle, damit Erzeugen und Wiedererkennen nicht auseinanderlaufen.
    static final String ANFANG_NICHT_GEMESSEN = ErgebnisZustand.ANFANG_NICHT_GEMESSEN;
    static final String ENDE_NICHT_GEMESSEN = ErgebnisZustand.ENDE_NICHT_GEMESSEN;
    static final String NUR_EIN_STAND = ErgebnisZustand.NUR_EIN_STAND;
    static final String ZUWACHS_NICHT_MESSBAR = ErgebnisZustand.ZUWACHS_NICHT_MESSBAR;
    static final String RUECKSETZUNG = ErgebnisZustand.anfang("ruecksetzung");
    static final String NEUSTART = ErgebnisZustand.anfang("neustart");

    /** Dieselbe Rechengenauigkeit wie der Python-Zwilling (Decimal-Vorgabe: 28 Stellen, half-even). */
    private static final MathContext RECHNUNG = new MathContext(28, RoundingMode.HALF_EVEN);

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
     * @param zeit Zeitpunkt; das Kennzeichen nennt ihn in der Zone des {@link ReihenKontext}
     * @param endstand Ablesestand des ALTEN Zählers, {@code null} wenn er fehlt
     * @param anfangsstand Ablesestand des NEUEN Zählers, {@code null} wenn er fehlt
     * @param verlustS Z7: so viele Sekunden Zählung können verloren sein
     */
    public record Ereignis(
            String art,
            Instant zeit,
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

    /** Die Uhrzeit IN einem Kennzeichen — in der Zeitzone des Standorts, die der Träger mitbringt (E10). */
    private static String uhr(Instant t, ReihenKontext reihe) {
        return ErgebnisZustand.uhr(t, reihe.zeitzone());
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
     *   <li>Gerätegrenze in {@code (vorher, nachher]}: mit Ableseständen
     *       {@code (Endstand − vorher) + (nachher − Anfangsstand)}, ohne Ablesestände Beitrag 0
     *       und die Periode ist unvollständig (Z4). Nie {@code nachher − vorher}.
     *   <li>Fallender Stand mit deklariertem Wertebereich und plausiblem Zuwachs: Überlauf mit
     *       Beitrag {@code Modul − vorher + nachher} — lückenlos (Z6).
     *   <li>Fallender Stand sonst: Rücksetzung, Beitrag 0, Periode unvollständig (Z5).
     *   <li>Loch über {@code LUECKE_FAKTOR × Kadenz}: der Zuwachs darüber ist GEMESSEN und zählt
     *       zur Periode, ist aber nicht auf feinere Perioden verteilbar (Z2).
     * </ul>
     *
     * @param reihe Einheit und Zeitzone, in denen die Kennzeichen sprechen
     * @param faktor Z8: Rohwert × faktor ergibt die Einheit der Reihe
     * @param wertebereichModul Z6: der deklarierte Wertebereich, oder {@code null}
     * @param hoechstzuwachsJeKadenz Z6: der größte plausible Zuwachs je Kadenz, oder {@code null}
     */
    public static Ergebnis mengeZaehlerstand(
            ReihenKontext reihe,
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
            Paar p = paar(reihe, folge.get(i), folge.get(i + 1), grenzen, kadenz, faktor, wertebereichModul,
                    hoechstzuwachsJeKadenz, kennzeichen);
            menge = menge.add(p.beitrag());
            unvollstaendig |= p.unvollstaendig();
        }

        unvollstaendig |= neustartKennzeichen(reihe, neustarts, kennzeichen);

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
    private static Paar paar(ReihenKontext reihe, Rohwert vorher, Rohwert nachher, List<Ereignis> grenzen,
            Duration kadenz, BigDecimal faktor, BigDecimal wertebereichModul, BigDecimal hoechstzuwachsJeKadenz,
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
            kennzeichen.add(ErgebnisZustand.geraetegrenze(uhr(grenze.zeit(), reihe), mit));
            if (!mit) {
                kennzeichen.add(ZUWACHS_NICHT_MESSBAR);
            }
            if (istLuecke(vorher.zeit(), nachher.zeit(), kadenz)) {
                kennzeichen.add(ErgebnisZustand.lueckeAmWechsel(
                        uhr(vorher.zeit(), reihe), uhr(nachher.zeit(), reihe)));
            }
            return new Paar(alt.add(neu), !mit);
        }

        BigDecimal zuwachs = nachher.wert().subtract(vorher.wert());
        if (zuwachs.signum() < 0) {
            BigDecimal ueber = ueberlauf(vorher, nachher, kadenz, wertebereichModul, hoechstzuwachsJeKadenz);
            if (ueber != null) {
                kennzeichen.add(ErgebnisZustand.ueberlauf(uhr(nachher.zeit(), reihe), wertebereichModul));
                return new Paar(ueber, false);
            }
            // Rücksetzung ohne Endstand: gezählt sind nur die Strecken bis vorher und ab
            // nachher - was dazwischen lag, weiß niemand und wird nicht geschätzt.
            kennzeichen.add(ErgebnisZustand.ruecksetzung(uhr(nachher.zeit(), reihe)));
            return new Paar(BigDecimal.ZERO, true);
        }

        LueckenZuwachs luecke = lueckenZuwachs(vorher, nachher, List.of(), kadenz, faktor);
        if (luecke != null) {
            kennzeichen.add(lueckenKennzeichen(luecke, reihe));
        }
        return new Paar(zuwachs, false);
    }

    /** Z7 — je Neustart ein Kennzeichen, zuletzt; {@code true}, wenn es einen gab. */
    private static boolean neustartKennzeichen(
            ReihenKontext reihe, List<Ereignis> neustarts, List<String> kennzeichen) {
        for (Ereignis neustart : neustarts) {
            kennzeichen.add(ErgebnisZustand.neustart(uhr(neustart.zeit(), reihe), neustart.verlustS()));
        }
        return !neustarts.isEmpty();
    }

    // ---------------------------------------------- Zuwachs über eine Lücke (Z2, E2, IP-6)

    /**
     * E2 — die Kette der Kalender-Zeiträume, vom feinsten zum gröbsten, in der der KLEINSTE ganz
     * enthaltende Zeitraum gesucht wird ({@code regeln.luecke_zeitraeume}). Ein freier Zeitraum
     * folgt derselben Regel {@link #zaehltZu}, steht aber nicht in der Kette.
     */
    public static final List<String> LUECKE_ZEITRAEUME = List.of("viertelstunde", "stunde", "tag", "monat", "jahr");

    /**
     * Z2/E2 — der Zuwachs über EINE Lücke: GEMESSEN (der Zähler hat weitergezählt, während die Werte
     * fehlten), aber NICHT VERTEILBAR (niemand weiß, wann in der Lücke er anfiel). Dieselben Felder
     * trägt das Ereignis {@code data_gap} als Nutzlast ({@code stand_vor}, {@code stand_nach},
     * {@code zuwachs}; die Einheit ist die der Reihe).
     *
     * @param messzeitVor Messzeit des letzten guten Werts vor der Lücke
     * @param messzeitNach Messzeit des ersten guten Werts danach
     * @param standVor der Stand davor in der Einheit der Reihe (Rohwert × Faktor)
     * @param standNach der Stand danach, ebenso
     * @param zuwachs {@code standNach − standVor}, ungerundet
     */
    public record LueckenZuwachs(
            Instant messzeitVor, Instant messzeitNach, BigDecimal standVor, BigDecimal standNach, BigDecimal zuwachs) {}

    /** Ein Zeitraum der Kette {@link #LUECKE_ZEITRAEUME}: {@code [von, bis)}. */
    public record Zeitraum(String art, Instant von, Instant bis) {}

    /**
     * Z2/E2 — ist die Nachbarschaft zweier guter Werte eine Lücke mit gemessenem Zuwachs? {@code null},
     * wenn nicht: kein Loch ÜBER {@code LUECKE_FAKTOR × Kadenz}, ein fallender Stand (Rücksetzung
     * oder Überlauf, Z5/Z6) oder eine Gerätegrenze in {@code (vorher, nachher]} (Z4 — dann ist
     * {@code nachher − vorher} gar kein Zuwachs eines Zählers).
     */
    public static LueckenZuwachs lueckenZuwachs(
            Rohwert vorher, Rohwert nachher, Collection<Ereignis> ereignisse, Duration kadenz, BigDecimal faktor) {
        if (!istLuecke(vorher.zeit(), nachher.zeit(), kadenz) || nachher.wert().compareTo(vorher.wert()) < 0
                || !ereignisseIn(ereignisse, Ereignis.GERAETEGRENZE, vorher.zeit(), nachher.zeit()).isEmpty()) {
            return null;
        }
        BigDecimal vor = vorher.wert().multiply(faktor);
        BigDecimal nach = nachher.wert().multiply(faktor);
        return new LueckenZuwachs(vorher.zeit(), nachher.zeit(), vor, nach, nach.subtract(vor));
    }

    /**
     * E2 — DIE Stelle, die entscheidet, ob der Zuwachs über eine Lücke zu {@code [von, bis)} zählt:
     * genau dann, wenn die Periode die Lücke GANZ enthält. Der Wert davor ist ihr Stand am Anfang oder
     * liegt in ihr ({@code messzeitVor > von − Kadenz}, das Fenster von Z1), und der Wert danach liegt
     * in ihr oder ist ihr Stand am Ende ({@code messzeitNach ≤ bis}).
     *
     * <p>Eine Periode, die die Lücke nur ANSCHNEIDET, bekommt ihn nicht — ihr fehlt der Stand an der
     * Grenze („Anfang/Ende nicht gemessen“), sonst stünde dieselbe Energie zweimal in der Bilanz. Die
     * Viertelstunden IN der Lücke haben gar keinen Wert und bleiben „keine Werte“, nie 0 und nie ein
     * Anteil. {@link #mengeZaehlerstand} und {@link #zaehlerstandAusTeilperioden} kommen über ihre
     * Periodenstände zu genau diesem Ergebnis; {@code VerbrauchVectorsTest} hält beide aneinander.
     */
    public static boolean zaehltZu(LueckenZuwachs luecke, Instant von, Instant bis, Duration kadenz) {
        return luecke.messzeitVor().isAfter(von.minus(kadenz)) && !luecke.messzeitNach().isAfter(bis);
    }

    /**
     * E2 — die Lücken mit gemessenem Zuwachs, die {@code [von, bis)} zählt, in Zeitfolge: jede
     * Nachbarschaft guter Werte nach {@link #lueckenZuwachs}, gefiltert nach {@link #zaehltZu}. Eine
     * Gerätegrenze wirkt wie in {@link #mengeZaehlerstand} nur, wenn sie in {@code (von, bis]} liegt.
     */
    public static List<LueckenZuwachs> lueckenZuwaechse(
            List<Rohwert> werte, Instant von, Instant bis, Duration kadenz, Collection<Ereignis> ereignisse,
            BigDecimal faktor) {
        List<Ereignis> grenzen = ereignisseIn(ereignisse, Ereignis.GERAETEGRENZE, von, bis);
        List<Rohwert> gut = werte.stream().filter(Rohwert::gut).sorted(Comparator.comparing(Rohwert::zeit)).toList();
        List<LueckenZuwachs> out = new ArrayList<>();
        for (int i = 0; i + 1 < gut.size(); i++) {
            LueckenZuwachs l = lueckenZuwachs(gut.get(i), gut.get(i + 1), grenzen, kadenz, faktor);
            if (l != null && zaehltZu(l, von, bis, kadenz)) {
                out.add(l);
            }
        }
        return List.copyOf(out);
    }

    /**
     * Das Kennzeichen, mit dem der Zuwachs in der Periode steht, die ihn zählt — Vertrag nach Text
     * („Lücke 14:00–17:31: Zuwachs 337,6 kWh gemessen, nicht auf Viertelstunden verteilbar“): Uhrzeiten
     * in der Zone des Standorts, der Zuwachs UNGERUNDET in der Einheit der Reihe an
     * {@link ErgebnisZustand#lueckeZuwachs} — beides aus dem {@link ReihenKontext}.
     */
    public static String lueckenKennzeichen(LueckenZuwachs luecke, ReihenKontext reihe) {
        return ErgebnisZustand.lueckeZuwachs(uhr(luecke.messzeitVor(), reihe), uhr(luecke.messzeitNach(), reihe),
                luecke.zuwachs(), reihe.einheit());
    }

    /**
     * E2 — der KLEINSTE Zeitraum der Kette Viertelstunde → Stunde → Tag → Monat → Jahr, der die
     * Lücke ganz enthält ({@link #zaehltZu}); {@code null}, wenn keiner es tut (über den
     * Jahreswechsel — dann zählt der Zuwachs nur in einem freien Zeitraum, der sie umfasst).
     * Viertelstunde und Stunde im UTC-Raster, Tag/Monat/Jahr in der Zeitzone des Standorts (23-/25-
     * Stunden-Tage). Geprüft werden je Stufe der Zeitraum des Werts davor und der, in den sein Fenster
     * {@code (t − Kadenz, t]} als Stand am Anfang reicht.
     */
    public static Zeitraum kleinsterZeitraum(LueckenZuwachs luecke, Duration kadenz, ZoneId zone) {
        for (String art : LUECKE_ZEITRAEUME) {
            for (Instant t : List.of(luecke.messzeitVor(), luecke.messzeitVor().plus(kadenz).minusNanos(1))) {
                Zeitraum z = zeitraum(art, t, zone);
                if (zaehltZu(luecke, z.von(), z.bis(), kadenz)) {
                    return z;
                }
            }
        }
        return null;
    }

    private static Zeitraum zeitraum(String art, Instant t, ZoneId zone) {
        LocalDate tag = t.atZone(zone).toLocalDate();
        return switch (art) {
            case "viertelstunde" -> raster(art, t, 900);
            case "stunde" -> raster(art, t, 3600);
            case "tag" -> kalender(art, tag, tag.plusDays(1), zone);
            case "monat" -> kalender(art, tag.withDayOfMonth(1), tag.withDayOfMonth(1).plusMonths(1), zone);
            case "jahr" -> kalender(art, tag.withDayOfYear(1), tag.withDayOfYear(1).plusYears(1), zone);
            default -> throw new IllegalArgumentException("unbekannter Zeitraum " + art);
        };
    }

    private static Zeitraum raster(String art, Instant t, long sekunden) {
        long beginn = Math.floorDiv(t.getEpochSecond(), sekunden) * sekunden;
        return new Zeitraum(art, Instant.ofEpochSecond(beginn), Instant.ofEpochSecond(beginn + sekunden));
    }

    private static Zeitraum kalender(String art, LocalDate von, LocalDate bis, ZoneId zone) {
        return new Zeitraum(art, von.atStartOfDay(zone).toInstant(), bis.atStartOfDay(zone).toInstant());
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
            ReihenKontext reihe,
            List<Rohwert> werte,
            Instant von,
            Instant bis,
            Duration kadenz,
            Collection<Ereignis> ereignisse,
            BigDecimal faktor,
            BigDecimal wertebereichModul,
            BigDecimal hoechstzuwachsJeKadenz) {
        Ergebnis e = ergebnis(reihe, "zaehlerstand", werte, von, bis, kadenz, ereignisse, faktor, wertebereichModul,
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
            ReihenKontext reihe,
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
                Paar p = paar(reihe, vorher, nachher, grenzen, kadenz, faktor, wertebereichModul,
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

        unvollstaendig |= neustartKennzeichen(
                reihe, ereignisseIn(ereignisse, Ereignis.NEUSTART, von, bis), kennzeichen);

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
    public static final String AUS_LEISTUNG_INTEGRIERT = ErgebnisZustand.AUS_LEISTUNG_INTEGRIERT;

    /** Das Wort des Kennzeichen-Vokabulars, mit dem {@link #AUS_LEISTUNG_INTEGRIERT} beginnt. */
    public static final String AUS_LEISTUNG_INTEGRIERT_WORT =
            ErgebnisZustand.muster("aus_leistung_integriert").wort();

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
                : List.of(ErgebnisZustand.intervallmengenFehlen(fehlend, erwartet));
    }

    /** M3 — das Kennzeichen einer unvollständigen Momentanwert-Periode. */
    private static String gemesseneZeit(long gemessenS, Instant von, Instant bis) {
        return ErgebnisZustand.gemesseneZeit(gemessenS, Duration.between(von, bis).toMinutes());
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

    // ------------------------------------------ Anteil eines Vorzeichen-Werts (AP-08 IP-7, M5/E15)

    /** Der positive Teil eines Vorzeichen-Werts, je Rohwert {@code max(0, P)} — speist Bezug. */
    public static final String ANTEIL_POSITIV = "positiv";
    /** Der Betrag des negativen Teils, je Rohwert {@code max(0, −P)} — speist Abgabe. */
    public static final String ANTEIL_NEGATIV = "negativ";

    /**
     * M5/E15 — DIE EINE STELLE, an der ein Vorzeichen-Wert in seinen Anteil geteilt wird: JE ROHWERT,
     * vor jeder Verdichtung. Erst daraus entstehen Mittel, Min, Max (die Nullen des anderen Anteils
     * zählen mit) und die Energie je Anteil.
     *
     * <p>Nie umgekehrt: das Mittel des ganzen Werts nach seinem Vorzeichen zuzuordnen (E15 Option C,
     * verworfen) ließe an F19 aus 12,8 kW Bezug und 22,8 kW Abgabe nur „Abgabe 10,0“ übrig. Das
     * Vorzeichen der Box ist schon im Rohwert (AP-04 E5) — hier wird es nie ein zweites Mal
     * angewendet, und ein Saldo entsteht hier nie (E12).
     *
     * @param anteil {@link #ANTEIL_POSITIV}, {@link #ANTEIL_NEGATIV} oder {@code null} = der ganze Wert
     *     (dann kommt {@code werte} unverändert zurück)
     */
    public static List<Rohwert> anteilJeRohwert(List<Rohwert> werte, String anteil) {
        if (anteil == null) {
            return werte;
        }
        boolean positiv = positiv(anteil);
        return werte.stream().map(r -> new Rohwert(r.zeit(), anteilDesWerts(r.wert(), positiv), r.gut())).toList();
    }

    /** Der Anteil EINES Werts: {@code max(0, P)} oder {@code max(0, −P)}; kein Wert bleibt kein Wert. */
    public static BigDecimal anteilDesWerts(BigDecimal wert, String anteil) {
        return anteilDesWerts(wert, positiv(anteil));
    }

    private static BigDecimal anteilDesWerts(BigDecimal wert, boolean positiv) {
        if (wert == null) {
            return null;
        }
        BigDecimal teil = positiv ? wert : wert.negate();
        return teil.signum() > 0 ? teil : BigDecimal.ZERO;
    }

    private static boolean positiv(String anteil) {
        return switch (anteil) {
            case ANTEIL_POSITIV -> true;
            case ANTEIL_NEGATIV -> false;
            default -> throw new IllegalArgumentException("unbekannter Anteil " + anteil
                    + " — bekannt sind positiv, negativ");
        };
    }

    /**
     * Die Kennzeichnung, die mit dem Anteil reist — Wortlaut UND Stelle (zuerst) sind Vertrag:
     * „positiver Anteil von K-3 · Wirkleistung“.
     *
     * @param quelle wie die Quelle heißt: Komponente · Messwert
     */
    public static String anteilKennzeichen(String anteil, String quelle) {
        return ErgebnisZustand.anteil(positiv(anteil), quelle);
    }

    /**
     * M1–M5 — {@link #momentanwerte} über den ANTEIL {@code anteil} der Rohwerte; das
     * Anteil-Kennzeichen steht vor allen anderen (es wird zuerst festgestellt). Ohne Anteil genau
     * {@link #momentanwerte}.
     */
    public static Ergebnis momentanwerteAnteil(List<Rohwert> werte, Instant von, Instant bis, Duration kadenz,
            boolean integrieren, String anteil, String quelle) {
        Ergebnis e = momentanwerte(anteilJeRohwert(werte, anteil), von, bis, kadenz, integrieren);
        if (anteil == null) {
            return e;
        }
        List<String> kennzeichen = new ArrayList<>();
        kennzeichen.add(anteilKennzeichen(anteil, quelle));
        kennzeichen.addAll(e.kennzeichen());
        return new Ergebnis(e.menge(), e.mittel(), e.min(), e.max(), e.energieKwh(), e.zustand(), e.erhalten(),
                e.erwartet(), e.abdeckungProzent(), List.copyOf(kennzeichen));
    }

    // ------------------------------------------------- Ersatzwert-Methoden (E7, AP-08 IP-13)

    public static final String GLEICHMAESSIG_VERTEILEN = "gleichmaessig_verteilen";
    public static final String PROFIL_VORPERIODE = "profil_vorperiode";
    public static final String PROFIL_VERGLEICHSQUELLE = "profil_vergleichsquelle";
    public static final String ABLESESTAND_NACHTRAGEN = "ablesestand_nachtragen";
    public static final String WERT_EINGEBEN = "wert_eingeben";
    public static final String VORPERIODE_UEBERNEHMEN = "vorperiode_uebernehmen";
    public static final String VERGLEICHSQUELLE_UEBERNEHMEN = "vergleichsquelle_uebernehmen";

    /** a–c verteilen einen GEMESSENEN Zuwachs; f und g übernehmen die Werte ihres Bezugs. */
    public static final List<String> VERTEILEN = List.of(GLEICHMAESSIG_VERTEILEN, PROFIL_VORPERIODE,
            PROFIL_VERGLEICHSQUELLE);
    public static final List<String> UEBERNEHMEN = List.of(VORPERIODE_UEBERNEHMEN, VERGLEICHSQUELLE_UEBERNEHMEN);

    /** Nur ein wirksamer Ersatzwert wirkt; ein zurückgenommener hinterlässt keine Spur in den Zahlen. */
    public static final String WIRKSAM = "wirksam";

    public static final String MIT_ERSATZWERT = ErgebnisZustand.MIT_ERSATZWERT;

    /**
     * Ein verteilter Anteil wird zum Speichern auf so viele Nachkommastellen ABGESCHNITTEN; den Rest
     * bekommt die letzte Viertelstunde ({@link #verteilen}). Gerechnet wird davor ungerundet (E11).
     */
    public static final int ERSATZWERT_STELLEN = 9;

    /** Die Genauigkeit der Division vor dem Abschneiden — dieselbe wie im Python-Zwilling. */
    private static final MathContext VERTEILEN_GENAUIGKEIT = new MathContext(40, RoundingMode.HALF_EVEN);

    /**
     * Die geschlossene Liste der benannten Ablehnungen ({@code regeln.ersatzwert_ablehnungen}). Eine
     * Methode, die nicht rechnen kann, lehnt mit ihrem Grund ab — sie weicht nie still auf eine andere aus.
     */
    public static final List<String> ERSATZWERT_ABLEHNUNGEN = List.of(
            "wertart_passt_nicht",
            "kein_gemessener_zuwachs",
            "zeitraum_nicht_die_luecke",
            "vorperiode_fehlt",
            "vergleichsquelle_fehlt",
            "profil_negativ",
            "profil_ohne_verbrauch",
            "betrag_fuer_mehrere_viertelstunden",
            "einheit_passt_nicht",
            "endstand_unter_letztem_wert",
            "anfangsstand_ueber_naechstem_wert",
            "ueberschneidet_ersatzwert");

    private static final long VIERTELSTUNDE_S = 900;

    /** Eine BENANNTE Ablehnung ({@link #grund()} aus {@link #ERSATZWERT_ABLEHNUNGEN}) — nie ein stiller Rückfall. */
    public static final class ErsatzwertAbgelehnt extends RuntimeException {

        private final String grund;

        public ErsatzwertAbgelehnt(String grund, String was) {
            super(grund + (was == null || was.isEmpty() ? "" : ": " + was));
            if (!ERSATZWERT_ABLEHNUNGEN.contains(grund)) {
                throw new IllegalArgumentException("unbekannte Ablehnung " + grund);
            }
            this.grund = grund;
        }

        public String grund() {
            return grund;
        }
    }

    /** Ein Wert des Bezugs einer Viertelstunde (Vorperiode oder Vergleichsquelle): Menge und Zustand. */
    public record Profilwert(BigDecimal menge, String zustand) {}

    /**
     * Ein Ersatzwert, wie die Rechenregel ihn braucht — die anlegende Fassung und ihr heutiger Status.
     *
     * @param von Beginn im Viertelstunden-Raster (bei d die Viertelstunde des Ablesestands)
     * @param luecke a–c: der GEMESSENE Zuwachs der Lücke ({@code data_gap}), {@code null} = keiner
     * @param lueckeVon a–c: die erste fehlende Messzeit der Lücke ({@code data_gap.von})
     * @param profil b, c, f, g: je Viertelstunde von {@code [von, bis)} in Zeitfolge der Wert des Bezugs
     *     ({@code null}-Eintrag = dort kein Wert); {@code null} = kein Bezug
     * @param profilEinheit g: die Einheit der Vergleichsquelle
     * @param betrag e: der eingegebene Wert in {@code einheit}
     * @param zeitpunkt d: der Ablesestand mit {@code endstand} und/oder {@code anfangsstand}
     */
    public record Ersatzwert(
            String kennung,
            String methode,
            Instant von,
            Instant bis,
            String status,
            LueckenZuwachs luecke,
            Instant lueckeVon,
            List<Profilwert> profil,
            String profilEinheit,
            BigDecimal betrag,
            String einheit,
            Instant zeitpunkt,
            BigDecimal endstand,
            BigDecimal anfangsstand) {}

    /** Der Wert, den ein Ersatzwert in EINER Viertelstunde setzt. */
    public record Anteil(Instant beginn, BigDecimal menge) {}

    /** Ein geltender Ersatzwert mit seinen Anteilen (d: keine). */
    public record Geltend(Ersatzwert ersatzwert, List<Anteil> anteile) {}

    /** Die geltenden Ersatzwerte einer Reihe und je abgelehnter Kennung ihr Grund. */
    public record Geltende(List<Geltend> gelten, Map<String, String> abgelehnt) {}

    /** Eine Version mit Ersatzwerten: das Ergebnis und die benannten Ablehnungen. */
    public record Version(Ergebnis ergebnis, Map<String, String> abgelehnt) {}

    private static Instant raster(Instant t, boolean auf) {
        long s = t.getEpochSecond();
        long k = Math.floorDiv(s, VIERTELSTUNDE_S) * VIERTELSTUNDE_S;
        if (auf && (k != s || t.getNano() != 0)) {
            k += VIERTELSTUNDE_S;
        }
        return Instant.ofEpochSecond(k);
    }

    /** Die Beginne der Viertelstunden in {@code [von, bis)} (UTC-Raster). */
    public static List<Instant> viertelstunden(Instant von, Instant bis) {
        List<Instant> out = new ArrayList<>();
        for (Instant t = raster(von, true); t.isBefore(bis); t = t.plusSeconds(VIERTELSTUNDE_S)) {
            out.add(t);
        }
        return List.copyOf(out);
    }

    /**
     * Die Viertelstunden, in denen ein Zuwachs anfiel: {@code [Boden(erste fehlende Messzeit), Decke(Messzeit
     * danach))} — dieselbe Rechnung wie der Datenbank-Auslöser {@code messreihe_ersatzwert_luecke}.
     */
    public static Zeitraum viertelstundenDerLuecke(Instant lueckeVon, Instant lueckeBis) {
        return new Zeitraum("luecke", raster(lueckeVon, false), raster(lueckeBis, true));
    }

    /**
     * Die Invariante „Summe = gemessener Zuwachs“ — für a, b und c die EINE Stelle.
     *
     * <p>Jeder Anteil außer dem letzten ist {@code Zuwachs × Gewicht ÷ Summe der Gewichte}, ungerundet
     * gerechnet und erst dann auf {@link #ERSATZWERT_STELLEN} Nachkommastellen ABGESCHNITTEN (nie aufgerundet,
     * darum nie negativ). Der letzte ist der Zuwachs minus alle anderen: die Summe der gespeicherten Anteile
     * ist EXAKT der Zuwachs, und der Rest aus dem Abschneiden (kleiner als n × 10⁻⁹) steht in der LETZTEN
     * Viertelstunde — dort, wo der Stand nach der Lücke den Zuwachs abschließt.
     */
    public static List<BigDecimal> verteilen(BigDecimal zuwachs, List<BigDecimal> gewichte) {
        if (gewichte.isEmpty()) {
            throw new IllegalArgumentException("ein Zuwachs braucht mindestens eine Viertelstunde");
        }
        BigDecimal summe = gewichte.stream().reduce(BigDecimal.ZERO, BigDecimal::add);
        List<BigDecimal> out = new ArrayList<>();
        BigDecimal verteilt = BigDecimal.ZERO;
        for (int i = 0; i + 1 < gewichte.size(); i++) {
            BigDecimal a = zuwachs.multiply(gewichte.get(i)).divide(summe, VERTEILEN_GENAUIGKEIT)
                    .setScale(ERSATZWERT_STELLEN, RoundingMode.DOWN);
            out.add(a);
            verteilt = verteilt.add(a);
        }
        out.add(zuwachs.subtract(verteilt));
        return List.copyOf(out);
    }

    private static List<BigDecimal> profil(Ersatzwert ew, int n) {
        String grund = PROFIL_VORPERIODE.equals(ew.methode()) || VORPERIODE_UEBERNEHMEN.equals(ew.methode())
                ? "vorperiode_fehlt" : "vergleichsquelle_fehlt";
        if (ew.profil() == null || ew.profil().size() != n) {
            throw new ErsatzwertAbgelehnt(grund, ew.kennung());
        }
        List<BigDecimal> out = new ArrayList<>();
        for (Profilwert p : ew.profil()) {
            if (p == null || p.menge() == null || !VOLLSTAENDIG.equals(p.zustand())) {
                throw new ErsatzwertAbgelehnt(grund, ew.kennung());
            }
            out.add(p.menge());
        }
        return out;
    }

    /**
     * E7 — die Werte je Viertelstunde, die ein Ersatzwert setzt (a, b, c, e, f, g), in Zeitfolge.
     *
     * <p>a–c verteilen den GEMESSENEN Zuwachs genau über die Viertelstunden seiner Lücke ({@link #verteilen});
     * b und c brauchen ein vollständiges Profil ohne negative Werte und mit Verbrauch. e setzt den Betrag EINER
     * Viertelstunde, f und g übernehmen die Werte ihres Bezugs. Methode d setzt keine Werte
     * ({@link #ablesestandEreignisse}). Kann eine Methode nicht rechnen, lehnt sie benannt ab.
     *
     * @param regel die Rechenregel der Reihe ({@code zaehlerstand} · {@code intervallmenge} · {@code momentanwert})
     * @param einheit die gespeicherte Einheit der Reihe
     */
    public static List<Anteil> ersatzwertAnteile(Ersatzwert ew, String regel, String einheit) {
        String m = ew.methode();
        if (!ErgebnisZustand.ERSATZWERT_METHODE_NAME.containsKey(m) || ABLESESTAND_NACHTRAGEN.equals(m)) {
            throw new IllegalArgumentException(m + " ist keine Methode mit Anteilen je Viertelstunde");
        }
        List<Instant> beginne = viertelstunden(ew.von(), ew.bis());
        if ("momentanwert".equals(regel) || (VERTEILEN.contains(m) && !"zaehlerstand".equals(regel))) {
            throw new ErsatzwertAbgelehnt("wertart_passt_nicht", m + " an " + regel);
        }
        List<BigDecimal> werte;
        if (VERTEILEN.contains(m)) {
            if (ew.luecke() == null || ew.luecke().zuwachs() == null || ew.lueckeVon() == null) {
                throw new ErsatzwertAbgelehnt("kein_gemessener_zuwachs", ew.kennung());
            }
            Zeitraum luecke = viertelstundenDerLuecke(ew.lueckeVon(), ew.luecke().messzeitNach());
            if (!luecke.von().equals(ew.von()) || !luecke.bis().equals(ew.bis())) {
                throw new ErsatzwertAbgelehnt("zeitraum_nicht_die_luecke", ew.kennung());
            }
            List<BigDecimal> gewichte;
            if (GLEICHMAESSIG_VERTEILEN.equals(m)) {
                gewichte = beginne.stream().map(t -> BigDecimal.ONE).toList();
            } else {
                gewichte = profil(ew, beginne.size());
                if (gewichte.stream().anyMatch(g -> g.signum() < 0)) {
                    throw new ErsatzwertAbgelehnt("profil_negativ", ew.kennung());
                }
                if (gewichte.stream().reduce(BigDecimal.ZERO, BigDecimal::add).signum() == 0) {
                    throw new ErsatzwertAbgelehnt("profil_ohne_verbrauch", ew.kennung());
                }
            }
            werte = verteilen(ew.luecke().zuwachs(), gewichte);
        } else if (WERT_EINGEBEN.equals(m)) {
            if (beginne.size() != 1) {
                throw new ErsatzwertAbgelehnt("betrag_fuer_mehrere_viertelstunden", ew.kennung());
            }
            if (einheit == null || !einheit.equals(ew.einheit())) {
                throw new ErsatzwertAbgelehnt("einheit_passt_nicht", ew.einheit() + " an " + einheit);
            }
            werte = List.of(ew.betrag());
        } else {
            werte = profil(ew, beginne.size());
            if (VERGLEICHSQUELLE_UEBERNEHMEN.equals(m) && (einheit == null || !einheit.equals(ew.profilEinheit()))) {
                throw new ErsatzwertAbgelehnt("einheit_passt_nicht", ew.profilEinheit() + " an " + einheit);
            }
        }
        List<Anteil> out = new ArrayList<>();
        for (int i = 0; i < beginne.size(); i++) {
            out.add(new Anteil(beginne.get(i), werte.get(i)));
        }
        return List.copyOf(out);
    }

    /**
     * E7 d — ein Ablesestand passt zu den Werten um seinen Zeitpunkt, sonst benannte Ablehnung: der Endstand
     * liegt nicht unter dem letzten guten Wert VOR dem Zeitpunkt, der Anfangsstand nicht über dem ersten guten
     * Wert AB dem Zeitpunkt (dieselbe Nachbarschaft {@code (vorher, nachher]} wie Z4).
     */
    public static void ablesestandPruefen(List<Rohwert> werte, Ersatzwert ew) {
        Rohwert vorher = null;
        Rohwert nachher = null;
        for (Rohwert w : werte.stream().filter(Rohwert::gut).sorted(Comparator.comparing(Rohwert::zeit)).toList()) {
            if (w.zeit().isBefore(ew.zeitpunkt())) {
                vorher = w;
            } else if (nachher == null) {
                nachher = w;
            }
        }
        if (ew.endstand() != null && vorher != null && ew.endstand().compareTo(vorher.wert()) < 0) {
            throw new ErsatzwertAbgelehnt("endstand_unter_letztem_wert", ew.kennung());
        }
        if (ew.anfangsstand() != null && nachher != null && ew.anfangsstand().compareTo(nachher.wert()) > 0) {
            throw new ErsatzwertAbgelehnt("anfangsstand_ueber_naechstem_wert", ew.kennung());
        }
    }

    /**
     * E7 d — die Gerätegrenze zum Zeitpunkt mit den nachgetragenen Ableseständen; Z4 rechnet danach. Eine
     * Gerätegrenze genau zu diesem Zeitpunkt wird ersetzt, sonst entsteht sie (die Rücksetzung von F6 ist nur
     * aus den Werten erkannt). Kein Rohwert wird angefasst.
     */
    public static List<Ereignis> ablesestandEreignisse(Collection<Ereignis> ereignisse, Ersatzwert ew) {
        List<Ereignis> out = new ArrayList<>(ereignisse.stream()
                .filter(e -> !(Ereignis.GERAETEGRENZE.equals(e.art()) && e.zeit().equals(ew.zeitpunkt())))
                .toList());
        out.add(new Ereignis(Ereignis.GERAETEGRENZE, ew.zeitpunkt(), ew.endstand(), ew.anfangsstand(), 0));
        return List.copyOf(out);
    }

    private static long[] kennungFolge(String kennung) {
        String[] teile = kennung.split("-");
        return new long[] {Long.parseLong(teile[1]), Long.parseLong(teile[2])};
    }

    /**
     * Welche Ersatzwerte einer Reihe gelten — und welche benannt abgelehnt sind.
     *
     * <p>Nur WIRKSAME zählen; ein zurückgenommener ist, als hätte es ihn nie gegeben. In der Folge ihrer
     * Kennung (Jahr, Nummer) hält der frühere seine Viertelstunden: ein späterer, der eine davon berührt, ist
     * {@code ueberschneidet_ersatzwert} — zwei Verteilungen desselben Zuwachses ergäben die doppelte Summe.
     * Ein abgelehnter hält keine Viertelstunde.
     *
     * @param vorabAbgelehnt die Ablehnungen, die nur mit den Rohwerten prüfbar sind (d,
     *     {@link #ablesestandPruefen})
     */
    public static Geltende geltende(List<Ersatzwert> ersatzwerte, String regel, String einheit,
            Map<String, String> vorabAbgelehnt) {
        List<Ersatzwert> wirksam = ersatzwerte.stream()
                .filter(e -> WIRKSAM.equals(e.status()))
                .sorted(Comparator.<Ersatzwert>comparingLong(e -> kennungFolge(e.kennung())[0])
                        .thenComparingLong(e -> kennungFolge(e.kennung())[1]))
                .toList();
        List<Geltend> gelten = new ArrayList<>();
        Map<String, String> abgelehnt = new LinkedHashMap<>();
        for (Ersatzwert ew : wirksam) {
            if (vorabAbgelehnt.containsKey(ew.kennung())) {
                abgelehnt.put(ew.kennung(), vorabAbgelehnt.get(ew.kennung()));
                continue;
            }
            if (gelten.stream().anyMatch(g -> g.ersatzwert().von().isBefore(ew.bis())
                    && ew.von().isBefore(g.ersatzwert().bis()))) {
                abgelehnt.put(ew.kennung(), "ueberschneidet_ersatzwert");
                continue;
            }
            try {
                if (ABLESESTAND_NACHTRAGEN.equals(ew.methode()) && !"zaehlerstand".equals(regel)) {
                    throw new ErsatzwertAbgelehnt("wertart_passt_nicht", ew.methode() + " an " + regel);
                }
                gelten.add(new Geltend(ew, ABLESESTAND_NACHTRAGEN.equals(ew.methode())
                        ? List.of() : ersatzwertAnteile(ew, regel, einheit)));
            } catch (ErsatzwertAbgelehnt x) {
                abgelehnt.put(ew.kennung(), x.grund());
            }
        }
        return new Geltende(List.copyOf(gelten), java.util.Collections.unmodifiableMap(abgelehnt));
    }

    /**
     * E7 — die Periode {@code [von, bis)} mit ihren geltenden Ersatzwerten: die neue Version über dem Bestand.
     *
     * <p>{@code basis} ist das Ergebnis aus den Rohwerten (Version 1, bei d schon mit dem Ablesestand gerechnet),
     * {@code standAnfang}/{@code standEnde} sagen, ob Z1 an den Grenzen einen Stand fand. Gerechnet wird IMMER
     * vom Bestand aus — nie auf dem Ergebnis einer früheren Version.
     *
     * <ul>
     *   <li>a–c: Enthält die Periode die Lücke ganz, steckt der Zuwachs schon in der Menge (E2) — sie bleibt,
     *       und der Satz „nicht auf Viertelstunden verteilbar“ weicht dem Ersatzwert. Schneidet sie die Lücke
     *       an, kommen die Anteile ihrer Viertelstunden zur gemessenen Menge ({@code null} hieß hier: kein
     *       gemessener Teil außerhalb der Lücke). Ein Rand IN der Lücke ist gedeckt, einer außerhalb bleibt
     *       „nicht gemessen“.
     *   <li>e–g gelten nur für die Viertelstunde selbst: ihr Wert IST die Menge (die gröbere Periode bildet
     *       die Kaskade, IP-17).
     *   <li>d: der Ablesestand wirkt schon in {@code basis} (Z4); hier kommt nur sein Kennzeichen dazu.
     * </ul>
     *
     * <p>Der Zustand ist „mit Ersatzwert“, sobald einer wirkt und eine Zahl dasteht; die Abdeckung des Verlaufs
     * bleibt die der Rohwerte. Kennzeichen: Ränder (Rang 20/21), die übrigen Sätze, zuletzt je Ersatzwert sein
     * Satz (Rang 70).
     */
    public static Ergebnis mitErsatzwerten(ReihenKontext reihe, Ergebnis basis, boolean standAnfang,
            boolean standEnde, Instant von, Instant bis, List<Geltend> gelten) {
        BigDecimal menge = basis.menge();
        List<String> kennzeichen = new ArrayList<>(basis.kennzeichen());
        boolean anfangGedeckt = false;
        boolean endeGedeckt = false;
        boolean ersetzt = false;
        boolean angeschnitten = false;
        List<String> saetze = new ArrayList<>();
        for (Geltend g : gelten) {
            Ersatzwert ew = g.ersatzwert();
            if (ABLESESTAND_NACHTRAGEN.equals(ew.methode())) {
                if (ew.zeitpunkt().isAfter(von) && !ew.zeitpunkt().isAfter(bis)) {
                    saetze.add(ErgebnisZustand.ersatzwert(ew.methode(), ew.kennung()));
                }
                continue;
            }
            List<BigDecimal> innen = g.anteile().stream()
                    .filter(a -> !a.beginn().isBefore(von) && a.beginn().isBefore(bis))
                    .map(Anteil::menge)
                    .toList();
            if (innen.isEmpty()) {
                continue;
            }
            if (VERTEILEN.contains(ew.methode())) {
                Instant lv = ew.lueckeVon();
                Instant lb = ew.luecke().messzeitNach();
                if (lv.isAfter(von) && !lb.isAfter(bis)) {
                    String satz = lueckenKennzeichen(ew.luecke(), reihe);
                    kennzeichen.removeIf(satz::equals);
                } else {
                    menge = (menge == null ? BigDecimal.ZERO : menge)
                            .add(innen.stream().reduce(BigDecimal.ZERO, BigDecimal::add));
                    angeschnitten = true;
                    anfangGedeckt |= !lv.isAfter(von) && von.isBefore(lb);
                    endeGedeckt |= !lv.isAfter(bis) && bis.isBefore(lb);
                }
            } else {
                if (innen.size() != 1 || !Duration.between(von, bis).equals(Duration.ofSeconds(VIERTELSTUNDE_S))) {
                    throw new IllegalArgumentException(
                            "e–g bilden die Viertelstunde; die gröbere Periode bildet die Kaskade (IP-17)");
                }
                menge = innen.get(0);
                ersetzt = true;
                kennzeichen.clear();
            }
            saetze.add(ErgebnisZustand.ersatzwert(ew.methode(), ew.kennung()));
        }
        if (saetze.isEmpty()) {
            return basis;
        }
        if (ersetzt || angeschnitten) {
            // Die Ränder neu sagen: gedeckt ist, was in der Lücke liegt; „nur ein Stand“ war ein Rand.
            List<String> vorn = new ArrayList<>();
            if (!ersetzt && !standAnfang && !anfangGedeckt) {
                vorn.add(ANFANG_NICHT_GEMESSEN);
            }
            if (!ersetzt && !standEnde && !endeGedeckt) {
                vorn.add(ENDE_NICHT_GEMESSEN);
            }
            kennzeichen.removeIf(k -> k.equals(ANFANG_NICHT_GEMESSEN) || k.equals(ENDE_NICHT_GEMESSEN)
                    || k.equals(NUR_EIN_STAND));
            kennzeichen.addAll(0, vorn);
        }
        kennzeichen.addAll(saetze);
        return new Ergebnis(menge, basis.mittel(), basis.min(), basis.max(), basis.energieKwh(),
                menge != null ? MIT_ERSATZWERT : basis.zustand(), basis.erhalten(), basis.erwartet(),
                basis.abdeckungProzent(), List.copyOf(kennzeichen));
    }

    /**
     * Der Eingang einer Version mit Ersatzwerten: dieselbe Regel wie {@link #ergebnis}, darüber die geltenden
     * Ersatzwerte ({@link #geltende}, {@link #mitErsatzwerten}). Ein Ablesestand (d) wird vorab an den Rohwerten
     * geprüft und wirkt als Gerätegrenze mit Ableseständen in der Rechnung selbst.
     */
    public static Version version(ReihenKontext reihe, String wertart, List<Rohwert> werte, Instant von,
            Instant bis, Duration kadenz, Collection<Ereignis> ereignisse, BigDecimal faktor,
            BigDecimal wertebereichModul, BigDecimal hoechstzuwachsJeKadenz, boolean integrieren,
            List<Ersatzwert> ersatzwerte) {
        Map<String, String> vorab = new LinkedHashMap<>();
        for (Ersatzwert ew : ersatzwerte) {
            if (WIRKSAM.equals(ew.status()) && ABLESESTAND_NACHTRAGEN.equals(ew.methode())) {
                try {
                    ablesestandPruefen(werte, ew);
                } catch (ErsatzwertAbgelehnt x) {
                    vorab.put(ew.kennung(), x.grund());
                }
            }
        }
        Geltende g = geltende(ersatzwerte, wertart, reihe.einheit(), vorab);
        List<Ereignis> mitAblesestand = new ArrayList<>(ereignisse);
        if ("zaehlerstand".equals(wertart)) {
            for (Geltend x : g.gelten()) {
                if (ABLESESTAND_NACHTRAGEN.equals(x.ersatzwert().methode())) {
                    mitAblesestand = new ArrayList<>(ablesestandEreignisse(mitAblesestand, x.ersatzwert()));
                }
            }
        }
        Ergebnis basis = ergebnis(reihe, wertart, werte, von, bis, kadenz, mitAblesestand, faktor,
                wertebereichModul, hoechstzuwachsJeKadenz, integrieren);
        if (g.gelten().isEmpty()) {
            return new Version(basis, g.abgelehnt());
        }
        boolean zaehler = "zaehlerstand".equals(wertart);
        return new Version(mitErsatzwerten(reihe, basis,
                !zaehler || periodenstand(werte, von, kadenz) != null,
                !zaehler || periodenstand(werte, bis, kadenz) != null,
                von, bis, g.gelten()), g.abgelehnt());
    }

    // ---------------------------------------------------------------------- Der Eingang

    /**
     * Der EINE Eingang: eine Reihe, eine Periode → das Ergebnis der Vektor-Datei.
     *
     * @param reihe Einheit und Zeitzone der Reihe, in denen die Kennzeichen sprechen
     * @param wertart {@code zaehlerstand}, {@code intervallmenge} oder {@code momentanwert}
     */
    public static Ergebnis ergebnis(
            ReihenKontext reihe,
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
        return ergebnis(reihe, wertart, werte, von, bis, kadenz, ereignisse, faktor, wertebereichModul,
                hoechstzuwachsJeKadenz, integrieren, null, null);
    }

    /**
     * Der Eingang mit Anteil (AP-08 IP-7): ein Anteil gibt es nur für einen Momentanwert — ein
     * Zählerstand oder eine Intervallmenge mit Anteil ist ein Fehler des Aufrufers (Regel 7 lässt
     * die Bindung gar nicht zu).
     *
     * @param anteil {@code positiv} | {@code negativ} | {@code null} = der ganze Wert
     * @param quelle Komponente · Messwert, wie das Anteil-Kennzeichen sie nennt
     */
    public static Ergebnis ergebnis(
            ReihenKontext reihe,
            String wertart,
            List<Rohwert> werte,
            Instant von,
            Instant bis,
            Duration kadenz,
            Collection<Ereignis> ereignisse,
            BigDecimal faktor,
            BigDecimal wertebereichModul,
            BigDecimal hoechstzuwachsJeKadenz,
            boolean integrieren,
            String anteil,
            String quelle) {
        if (anteil != null && !"momentanwert".equals(wertart)) {
            throw new IllegalArgumentException("einen Anteil hat nur ein Momentanwert, nicht " + wertart);
        }
        return switch (wertart) {
            case "zaehlerstand" -> mengeZaehlerstand(reihe,
                            werte, von, bis, kadenz, ereignisse, faktor, wertebereichModul, hoechstzuwachsJeKadenz)
                    .mitAbdeckung(erwarteteWerte(von, bis, kadenz));
            case "intervallmenge" -> mengeIntervall(werte, von, bis, kadenz, faktor);
            case "momentanwert" -> momentanwerteAnteil(werte, von, bis, kadenz, integrieren, anteil, quelle);
            default -> throw new IllegalArgumentException("unbekannte Wertart " + wertart
                    + " — bekannt sind zaehlerstand, intervallmenge, momentanwert");
        };
    }
}
