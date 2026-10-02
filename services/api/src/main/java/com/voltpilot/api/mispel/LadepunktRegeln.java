package com.voltpilot.api.mispel;

import com.voltpilot.api.uems.ZaehlerrolleRegeln;
import java.math.BigDecimal;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

/**
 * MiSpeL MP-31: die reinen Regeln des bidirektionalen Ladepunkts (ohne Spring, Datenbank, Uhr), Vertrag
 * {@code docs/contracts/v2/mispel-ladepunkt-bidirektional.md}.
 *
 * <p>Anlage 1 S. 7 und S. 26 (Abschn. 3.2.5): nur ein bidirektional nutzbarer Ladepunkt ist dem Stromspeicher
 * gleichgestellt; ein ausschließlich unidirektional nutzbarer ist gewöhnlicher sonstiger Verbrauch. Fn. 21: V2G und
 * V2H zählen, außer die Rückspeisung ist technisch unterbunden, sobald gleichzeitig ins Netz eingespeist wird — das
 * ist die Alternative zur Ausschließlichkeitsoption (Fn. 22, Abschn. 2.1.3).
 */
public final class LadepunktRegeln {

    public static final String UNIDIREKTIONAL = "unidirektional";
    public static final String BIDIREKTIONAL = "bidirektional";
    public static final List<String> NUTZBARKEITEN = List.of(UNIDIREKTIONAL, BIDIREKTIONAL);

    /** Die Einordnung nach Anlage 1 — sie entscheidet, ob der Ladepunkt in die Formelsätze eingeht. */
    public static final String SONSTIGER_VERBRAUCH = "sonstiger_verbrauch";
    public static final String LADEPUNKT_DER_FESTLEGUNG = "ladepunkt_der_festlegung";
    public static final String ALTERNATIVE_ZUR_AUSSCHLIESSLICHKEIT = "alternative_zur_ausschliesslichkeit";

    public static final String FEHLER = ZaehlerrolleRegeln.FEHLER;
    public static final String HINWEIS = ZaehlerrolleRegeln.HINWEIS;

    /** Fundstellen, wörtlich wie im Vertrag. */
    public static final String A1_S7_S26 = "Anlage 1 S. 7 (Begriff „Ladepunkt“) und S. 26, Abschn. 3.2.5";
    public static final String A1_S26_FN21 = "Anlage 1 S. 26, Abschn. 3.2.5, Fn. 21";
    public static final String A1_S27_FN22 = "Anlage 1 S. 27, Fn. 22; Abschn. 2.1.3";
    public static final String A1_S25_S26 = "Anlage 1 S. 25, Abschn. 3.2.4, und S. 26, Abschn. 3.2.5";
    public static final String A1_S26_S27 = "Anlage 1 S. 26–27, Abschn. 3.2.5; S. 32–33, Formelsatz-Eingänge";
    public static final String T_S28 = ZaehlerrolleRegeln.T_S28;

    private static final BigDecimal NULL = BigDecimal.ZERO;
    private static final BigDecimal HUNDERT = BigDecimal.valueOf(100);
    private static final BigDecimal MAX_LEISTUNG_KW = BigDecimal.valueOf(1000);
    private static final BigDecimal MAX_KAPAZITAET_KWH = BigDecimal.valueOf(500);
    private static final int MINUTEN_DER_WOCHE = 7 * 24 * 60;

    private LadepunktRegeln() {}

    /** Die technische Fähigkeit einer Fassung. */
    public record Faehigkeit(String nutzbarkeit, boolean v2h, boolean v2g, boolean rueckspeisungBeiEinspeisungUnterbunden,
            BigDecimal rueckspeiseleistungKw) {

        /** Ein Ladepunkt ohne Fassung: der Bestand gilt als unidirektional. */
        public static final Faehigkeit BESTAND = new Faehigkeit(UNIDIREKTIONAL, false, false, false, null);

        public boolean bidirektional() {
            return BIDIREKTIONAL.equals(nutzbarkeit);
        }
    }

    /** Ein Anwesenheitsfenster ab {@code wochentag} (ISO, 1 = Montag) um {@code ankunft} bis {@code abfahrt}. */
    public record Fenster(int wochentag, LocalTime ankunft, LocalTime abfahrt, BigDecimal abfahrtSocPct) {}

    /** Die Planungsangaben am Ladepunkt (MP-33). */
    public record Fahrzeugfenster(BigDecimal mindestSocPct, BigDecimal kapazitaetKwh, List<Fenster> anwesenheit) {}

    /** Ein Befund mit Schwere, Fundstelle und Satz; {@code messstelle} nennt den Zähler, wenn es um einen geht. */
    public record Befund(String code, String schwere, String messstelle, String fundstelle, String satz) {}

    /** Der Zähler Z2 am Ladepunkt in einer Richtung, mit den Angaben seiner Zählerrolle (MP-6) und deren Urteil. */
    public record Z2(String groesse, String kennzeichen, ZaehlerrolleRegeln.Angaben angaben, String urteil) {}

    /** Eine Ablehnung mit Code, Status, Satz und Fakten. */
    public record Ablehnung(String code, int status, String satz, Map<String, Object> fakten) {}

    // ------------------------------------------------------------------ Form

    /** Formfehler der Fähigkeit: 400 {@code faehigkeit_ungueltig} mit Grund, sonst {@code null}. */
    public static Ablehnung formPruefen(Faehigkeit f) {
        if (f.nutzbarkeit() == null || !NUTZBARKEITEN.contains(f.nutzbarkeit())) {
            return ungueltig("faehigkeit_ungueltig", "nutzbarkeit",
                    "„nutzbarkeit“ ist „unidirektional“ oder „bidirektional“ (Anlage 1 S. 26, Abschn. 3.2.5).");
        }
        if (!f.bidirektional()) {
            if (f.v2h() || f.v2g() || f.rueckspeisungBeiEinspeisungUnterbunden() || f.rueckspeiseleistungKw() != null) {
                return ungueltig("faehigkeit_ungueltig", "angaben_ohne_rueckspeisung",
                        "Ein ausschließlich unidirektional nutzbarer Ladepunkt speist nicht zurück: ohne V2H, V2G, "
                                + "Sperre und Rückspeiseleistung.");
            }
            return null;
        }
        if (!f.v2h() && !f.v2g()) {
            return ungueltig("faehigkeit_ungueltig", "betriebsweise",
                    "Ein bidirektional nutzbarer Ladepunkt speist ins Haus (V2H), ins Netz (V2G) oder beides "
                            + "(Anlage 1 S. 26, Fn. 21).");
        }
        if (f.v2g() && f.rueckspeisungBeiEinspeisungUnterbunden()) {
            return ungueltig("faehigkeit_ungueltig", "unterbunden",
                    "V2G speist ins Netz; die Sperre der Rückspeisung bei gleichzeitiger Einspeisung (Anlage 1 S. 27, "
                            + "Fn. 22) gibt es nur ohne V2G.");
        }
        BigDecimal kw = f.rueckspeiseleistungKw();
        if (kw != null && (kw.compareTo(NULL) <= 0 || kw.compareTo(MAX_LEISTUNG_KW) > 0)) {
            return ungueltig("faehigkeit_ungueltig", "rueckspeiseleistung",
                    "Die Rückspeiseleistung liegt über 0 und höchstens bei 1000 kW.");
        }
        return null;
    }

    /** Gleiche Fähigkeit (Leistung als Zahl, nicht als Schreibweise). */
    public static boolean gleich(Faehigkeit a, Faehigkeit b) {
        return a.nutzbarkeit().equals(b.nutzbarkeit()) && a.v2h() == b.v2h() && a.v2g() == b.v2g()
                && a.rueckspeisungBeiEinspeisungUnterbunden() == b.rueckspeisungBeiEinspeisungUnterbunden()
                && (a.rueckspeiseleistungKw() == null ? b.rueckspeiseleistungKw() == null
                        : b.rueckspeiseleistungKw() != null
                                && a.rueckspeiseleistungKw().compareTo(b.rueckspeiseleistungKw()) == 0);
    }

    /** Formfehler des Fahrzeugfensters: 400 {@code fahrzeugfenster_ungueltig} mit Grund, sonst {@code null}. */
    public static Ablehnung formPruefen(Fahrzeugfenster f) {
        if (ausserhalb(f.mindestSocPct(), NULL, HUNDERT, true)) {
            return ungueltig("fahrzeugfenster_ungueltig", "mindest_soc", "Der Mindest-Ladestand liegt zwischen 0 und 100 %.");
        }
        if (ausserhalb(f.kapazitaetKwh(), NULL, MAX_KAPAZITAET_KWH, false)) {
            return ungueltig("fahrzeugfenster_ungueltig", "kapazitaet",
                    "Die nutzbare Kapazität liegt über 0 und höchstens bei 500 kWh.");
        }
        for (Fenster w : f.anwesenheit()) {
            if (w == null || w.wochentag() < 1 || w.wochentag() > 7 || w.ankunft() == null || w.abfahrt() == null
                    || w.ankunft().equals(w.abfahrt())) {
                return ungueltig("fahrzeugfenster_ungueltig", "anwesenheit",
                        "Ein Fenster hat einen Wochentag (1 = Montag … 7 = Sonntag) und verschiedene Uhrzeiten für "
                                + "Ankunft und Abfahrt (HH:MM).");
            }
            if (w.ankunft().getSecond() != 0 || w.abfahrt().getSecond() != 0 || w.ankunft().getNano() != 0
                    || w.abfahrt().getNano() != 0) {
                return ungueltig("fahrzeugfenster_ungueltig", "anwesenheit",
                        "Ankunft und Abfahrt sind volle Minuten (HH:MM).");
            }
            if (ausserhalb(w.abfahrtSocPct(), NULL, HUNDERT, true)) {
                return ungueltig("fahrzeugfenster_ungueltig", "abfahrt_soc",
                        "Der Ladestand bei Abfahrt liegt zwischen 0 und 100 %.");
            }
            if (w.abfahrtSocPct() != null && f.mindestSocPct() != null
                    && w.abfahrtSocPct().compareTo(f.mindestSocPct()) < 0) {
                return ungueltig("fahrzeugfenster_ungueltig", "abfahrt_soc",
                        "Der Ladestand bei Abfahrt liegt nicht unter dem Mindest-Ladestand.");
            }
        }
        List<int[]> spannen = new ArrayList<>();
        for (Fenster w : f.anwesenheit()) {
            int von = (w.wochentag() - 1) * 24 * 60 + w.ankunft().getHour() * 60 + w.ankunft().getMinute();
            int dauer = Math.floorMod(minuten(w.abfahrt()) - minuten(w.ankunft()), 24 * 60);
            spannen.add(new int[] {von, von + dauer});
        }
        spannen.sort(Comparator.comparingInt(s -> s[0]));
        for (int i = 0; i < spannen.size(); i++) {
            int[] a = spannen.get(i);
            int[] b = spannen.get((i + 1) % spannen.size());
            int bVon = i + 1 < spannen.size() ? b[0] : b[0] + MINUTEN_DER_WOCHE;
            if (spannen.size() > 1 && a[1] > bVon) {
                return ungueltig("fahrzeugfenster_ungueltig", "ueberschneidung",
                        "Zwei Anwesenheitsfenster überschneiden sich; ein Ladepunkt hat zu jeder Zeit höchstens "
                                + "ein Fenster.");
            }
        }
        return null;
    }

    // ------------------------------------------------------------------ Einordnung und Befunde

    /** Die Einordnung nach Anlage 1 (S. 7, S. 26 Fn. 21, S. 27 Fn. 22). */
    public static String einordnung(Faehigkeit f) {
        if (!f.bidirektional()) {
            return SONSTIGER_VERBRAUCH;
        }
        if (!f.v2g() && f.rueckspeisungBeiEinspeisungUnterbunden()) {
            return ALTERNATIVE_ZUR_AUSSCHLIESSLICHKEIT;
        }
        return LADEPUNKT_DER_FESTLEGUNG;
    }

    /** Die Fundstelle der Einordnung. */
    public static String einordnungFundstelle(String einordnung) {
        return switch (einordnung) {
            case ALTERNATIVE_ZUR_AUSSCHLIESSLICHKEIT -> A1_S27_FN22;
            case LADEPUNKT_DER_FESTLEGUNG -> A1_S26_FN21;
            default -> A1_S7_S26;
        };
    }

    /**
     * Die Befunde am Ladepunkt: Zähler Z2 (aus den Zählerrollen, MP-6) gegen die Einordnung, und der Förderweg.
     *
     * @param z2           die Zähler Z2, hinter denen der Ladepunkt am Tag liegt (Z2V und/oder Z2E), leer = keiner
     * @param foerderweg   der Förderweg der Anlage am Tag ({@code null} = unbekannt)
     */
    public static List<Befund> befunde(Faehigkeit f, List<Z2> z2, FoerderwegRegeln.Foerderweg foerderweg) {
        List<Befund> out = new ArrayList<>();
        String einordnung = einordnung(f);
        if (SONSTIGER_VERBRAUCH.equals(einordnung)) {
            for (Z2 z : z2) {
                out.add(new Befund("unidirektional_hinter_z2", FEHLER, z.kennzeichen(), A1_S25_S26,
                        "Der Ladepunkt ist ausschließlich unidirektional nutzbar und damit sonstiger Verbrauch — hinter "
                                + z.kennzeichen() + " (Z2) darf kein sonstiger Verbrauch liegen."));
            }
            return out;
        }
        if (LADEPUNKT_DER_FESTLEGUNG.equals(einordnung)) {
            if (z2.isEmpty()) {
                out.add(new Befund("z2_fehlt", HINWEIS, null, A1_S26_S27,
                        "Kein Zähler Z2 misst diesen Ladepunkt. Ohne ihn bleiben nur der Ein-Zähler-Fall A11 "
                                + "(Fremdtankstrom nicht erkennbar) oder die Pauschaloption."));
            } else if (z2.size() == 1) {
                out.add(new Befund("z2_richtung_fehlt", HINWEIS, z2.get(0).kennzeichen(), A1_S26_S27,
                        "Am Ladepunkt misst nur " + z2.get(0).groesse() + ". Verbrauch im Ladepunkt (Z2V) und "
                                + "Erzeugung im Ladepunkt (Z2E) brauchen beide Richtungen."));
            }
            if (foerderweg == FoerderwegRegeln.Foerderweg.MARKTPRAEMIE_AUSSCHLIESSLICHKEIT) {
                out.add(new Befund("ausschliesslichkeit_mit_ladepunkt", FEHLER, null, A1_S27_FN22,
                        "Mit einem bidirektional nutzbaren Ladepunkt hinter derselben Einspeisestelle gibt es keine "
                                + "Ausschließlichkeitsoption. Möglich bleibt die Alternative: die Rückspeisung technisch "
                                + "unterbinden, sobald gleichzeitig eingespeist wird."));
            }
        }
        for (Z2 z : z2) {
            if ("nicht_tauglich".equals(z.urteil())) {
                out.add(new Befund("z2_nicht_tauglich", FEHLER, z.kennzeichen(), T_S28,
                        z.kennzeichen() + " (" + z.groesse() + ") ist als Zähler nicht tauglich; die Befunde seiner "
                                + "Zählerrolle nennen den Grund."));
            } else if ("nicht_pruefbar".equals(z.urteil())) {
                out.add(new Befund("z2_nicht_pruefbar", HINWEIS, z.kennzeichen(), T_S28,
                        z.kennzeichen() + " (" + z.groesse() + ") ist nicht prüfbar — Eichstatus oder Messobjekt "
                                + "unbekannt. Auch Ladepunkt-Messwerte müssen mess- und eichrechtskonform sein."));
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ Bausteine

    private static int minuten(LocalTime t) {
        return t.getHour() * 60 + t.getMinute();
    }

    private static boolean ausserhalb(BigDecimal wert, BigDecimal unten, BigDecimal oben, boolean untenEinschliesslich) {
        if (wert == null) {
            return false;
        }
        int u = wert.compareTo(unten);
        return (untenEinschliesslich ? u < 0 : u <= 0) || wert.compareTo(oben) > 0;
    }

    private static Ablehnung ungueltig(String code, String grund, String satz) {
        return new Ablehnung(code, 400, satz, Map.of("grund", grund));
    }

    /**
     * MiSpeL MP-38: der Eichstatus eines signierten Ladepunkt-Messwerts (Vokabular der Zählerrolle, MP-6). Nur eine
     * gültige OCMF-Signatur macht den Wert {@code eichrechtskonform}; ungültig, nicht prüfbar oder fehlend bleibt er
     * ein Gerätewert ohne Eichstatus ({@code null}) — „auch nicht mess- und eichrechtskonform erfasste Messwerte … zu
     * verwenden … scheidet … aus“ (Tenor S. 28, Abschn. 3.2.3.2.1; A1 S. 23, Abschn. 3.2.1).
     */
    public static String eichstatusSigniert(String signaturstatus) {
        return "gueltig".equals(signaturstatus) ? "eichrechtskonform" : null;
    }
}
