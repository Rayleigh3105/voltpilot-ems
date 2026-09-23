package com.voltpilot.api.uems;

import java.math.BigInteger;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * AP-17 NW-1: reine Regeln der Bezugsbasis (docs/contracts/v2/bezugsbasis.md). Keine Route ruft sie bisher auf.
 * Zwillinge: {@code bezugsbasis.ts} und {@code voltpilot_optimization/bezugsbasis.py}; alle drei fahren
 * {@code bezugsbasis-vectors.json}. Gerechnet wird mit exakten Brüchen; gerundet wird nur die Ausgabe, kaufmännisch
 * (,5 vom Nullpunkt weg) — nie {@code Math.round}. Band, Spannweite und Abhängigkeit werden per Kreuzprodukt geprüft.
 */
public final class BezugsbasisRegeln {
    private BezugsbasisRegeln() {}

    public record Startwerte(int mindest_monate, String toleranz_prozent, String spannweite_prozent, String abhaengig_r, int wiedervorlage_monate) {}
    public static final Startwerte STARTWERTE = new Startwerte(12, "2", "10", "0.9", 12);
    public static final List<String> METHODEN = List.of("verhaeltnis", "regression_eine_variable", "regression_zwei_variablen", "gradtage");
    public static final List<String> URTEILE = List.of("besser", "schlechter", "im_rahmen", "ohne_urteil", "nicht_anwendbar");
    public static final List<String> GRUENDE = List.of("basis_fehlt", "basis_beendet", "zu_wenig_perioden", "variable_fehlt",
            "variable_ausserhalb", "variablen_abhaengig", "keine_werte", "periode_nicht_zu_ende");
    public static final List<String> DATENLAGE = List.of("vollstaendig", "vorlaeufig");
    public static final List<String> RICHTUNGEN = List.of("mehr", "weniger", "gleich");
    public static final List<String> ANPASSUNGSGRUENDE = List.of("referenzperiode_vervollstaendigt", "grundlage_korrigiert",
            "struktur_geaendert", "variable_geaendert", "methode_geaendert", "nicht_mehr_anwendbar", "sonstiger");
    public static final List<String> FAKTOR_ARTEN = List.of("flaeche", "standort", "anlage", "prozess", "kostenstelle", "wortlaut");
    public static final List<String> BASIS_ZUSTAENDE = List.of("entwurf", "freigegeben", "anstoss_liegt_vor", "ueberpruefung_faellig", "beendet");
    public static final List<String> FREIGABE_STATUS = List.of("beantragt", "freigegeben", "abgelehnt");
    private static final String NA = "nicht_anwendbar", OHNE = "ohne_urteil";
    private static final Pattern PERIODE = Pattern.compile("^(\\d{4})-(0[1-9]|1[0-2])/(\\d{4})-(0[1-9]|1[0-2])$");

    public record Variable(String name, String einheit, String art) {}
    public record Spannweite(String von, String bis, String toleriert_von, String toleriert_bis) {}
    public record Koeffizienten(String a, String b, String c) {}
    public record Fassung(String kennzeichen, int fassung, String methode, int monate, String basiswert, Koeffizienten koeffizienten,
                          String streuung_prozent, String toleranz_prozent, List<Spannweite> spannweite, List<Variable> variablen) {}
    public record Wert(String wert, String zustand, List<String> kennzeichen) {}
    public record VergleichEingang(Fassung fassung, boolean basis_beendet, boolean abgeschlossen, Wert gemessen, List<Wert> variablen) {}
    public record Monat(boolean abgeschlossen, Wert gemessen, List<Wert> variablen) {}
    public record ZeitraumEingang(Fassung fassung, boolean basis_beendet, int soll_monate, List<Monat> monate) {}
    public record Paar(String zaehler, String nenner) {}
    public record Reihe(String zaehler, List<String> variablen) {}

    /** Exakter Bruch z/n mit n &gt; 0 — das Gegenstück zu {@code fractions.Fraction}. */
    record Q(BigInteger z, BigInteger n) implements Comparable<Q> {
        static final Q NULL = new Q(BigInteger.ZERO, BigInteger.ONE);
        Q {
            if (n.signum() < 0) { z = z.negate(); n = n.negate(); }
            BigInteger g = z.gcd(n);
            if (g.signum() != 0 && !g.equals(BigInteger.ONE)) { z = z.divide(g); n = n.divide(g); }
        }
        static Q of(String text) {
            if (text == null) return null;
            var d = new java.math.BigDecimal(text);
            return d.scale() > 0 ? new Q(d.unscaledValue(), BigInteger.TEN.pow(d.scale()))
                    : new Q(d.toBigIntegerExact(), BigInteger.ONE);
        }
        static Q of(long v) { return new Q(BigInteger.valueOf(v), BigInteger.ONE); }
        Q plus(Q o) { return new Q(z.multiply(o.n).add(o.z.multiply(n)), n.multiply(o.n)); }
        Q minus(Q o) { return plus(o.negate()); }
        Q times(Q o) { return new Q(z.multiply(o.z), n.multiply(o.n)); }
        Q div(Q o) { return new Q(z.multiply(o.n), n.multiply(o.z)); }
        Q negate() { return new Q(z.negate(), n); }
        Q abs() { return new Q(z.abs(), n); }
        int signum() { return z.signum(); }
        @Override public int compareTo(Q o) { return z.multiply(o.n).compareTo(o.z.multiply(n)); }
    }

    private static BigInteger halbAuf(BigInteger z, BigInteger n) {
        boolean negativ = z.signum() < 0 != n.signum() < 0;
        BigInteger[] qr = z.abs().divideAndRemainder(n.abs());
        BigInteger ganz = qr[1].shiftLeft(1).compareTo(n.abs()) >= 0 ? qr[0].add(BigInteger.ONE) : qr[0];
        return negativ ? ganz.negate() : ganz;
    }
    private static String text(BigInteger z, int stellen) {
        String ziffern = z.abs().toString();
        while (ziffern.length() < stellen + 1) ziffern = "0" + ziffern;
        String ganz = ziffern.substring(0, ziffern.length() - stellen), bruch = ziffern.substring(ziffern.length() - stellen);
        return (z.signum() < 0 ? "-" : "") + ganz + (stellen > 0 ? "." + bruch : "");
    }
    static String fest(Q x, int stellen) {
        return x == null ? null : text(halbAuf(x.z.multiply(BigInteger.TEN.pow(stellen)), x.n), stellen);
    }
    static String kurz(Q x, int stellen) {
        String t = fest(x, stellen);
        if (t == null || !t.contains(".")) return t;
        t = t.replaceAll("0+$", "");
        return t.endsWith(".") ? t.substring(0, t.length() - 1) : t;
    }
    static String exakt(Q x) {
        if (x == null) return null;
        BigInteger n = x.n;
        int stellen = 0;
        BigInteger zwei = BigInteger.TWO, fuenf = BigInteger.valueOf(5);
        while (!n.equals(BigInteger.ONE)) {
            if (n.mod(zwei).signum() == 0) n = n.divide(zwei);
            else if (n.mod(fuenf).signum() == 0) n = n.divide(fuenf);
            else throw new IllegalArgumentException("kein endlicher Dezimalbruch: " + x);
            stellen++;
        }
        return stellen == 0 ? x.z.toString() : kurz(x, stellen);
    }
    /** √x kaufmännisch auf {@code stellen}: ⌊(⌊√⌊4·x·10^2k⌋⌋ + 1) / 2⌋ — exakt, ohne Gleitkomma. */
    static String wurzelFest(Q x, int stellen) {
        Q v = x.times(new Q(BigInteger.valueOf(4).multiply(BigInteger.TEN.pow(2 * stellen)), BigInteger.ONE));
        return text(v.z.divide(v.n).sqrt().add(BigInteger.ONE).shiftRight(1), stellen);
    }
    /** Zahl im Kennzeichen: Dezimalkomma, Tausender mit Leerzeichen (§5.8). */
    static String de(String t) {
        boolean minus = t.startsWith("-");
        String rest = minus ? t.substring(1) : t;
        int punkt = rest.indexOf('.');
        String ganz = punkt < 0 ? rest : rest.substring(0, punkt), bruch = punkt < 0 ? "" : rest.substring(punkt + 1);
        var sb = new StringBuilder();
        for (int i = 0; i < ganz.length(); i++) {
            if (i > 0 && (ganz.length() - i) % 3 == 0) sb.append(' ');
            sb.append(ganz.charAt(i));
        }
        return (minus ? "−" : "") + sb + (bruch.isEmpty() ? "" : "," + bruch);
    }

    private static Map<String, Object> map(Object... kv) {
        var m = new LinkedHashMap<String, Object>();
        for (int i = 0; i < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
        return m;
    }
    private static String datenlage(int monate) { return monate < STARTWERTE.mindest_monate() ? "vorlaeufig" : "vollstaendig"; }
    private static String vorlaeufig(int monate) { return "Bezugsbasis vorläufig (" + monate + " von " + STARTWERTE.mindest_monate() + " Monaten)"; }
    private static Q summe(List<Q> werte) { return werte.stream().reduce(Q.NULL, Q::plus); }
    private static Q mittel(List<Q> werte) { return summe(werte).div(Q.of(werte.size())); }

    /** P1/P2: ganze, abgeschlossene Kalendermonate {@code JJJJ-MM/JJJJ-MM}; unter der Mindestlänge vorläufig. */
    public static Map<String, Object> referenzperiode(String text, String laufenderMonat) {
        Matcher m = PERIODE.matcher(text == null ? "" : text);
        if (!m.matches()) return map("gueltig", false, "monate", null, "datenlage", null, "fehler", "referenzperiode_format");
        int von = Integer.parseInt(m.group(1)) * 12 + Integer.parseInt(m.group(2)) - 1;
        int bis = Integer.parseInt(m.group(3)) * 12 + Integer.parseInt(m.group(4)) - 1;
        if (bis < von) return map("gueltig", false, "monate", null, "datenlage", null, "fehler", "referenzperiode_reihenfolge");
        String[] lm = laufenderMonat.split("-");
        if (bis >= Integer.parseInt(lm[0]) * 12 + Integer.parseInt(lm[1]) - 1)
            return map("gueltig", false, "monate", null, "datenlage", null, "fehler", "periode_nicht_zu_ende");
        int monate = bis - von + 1;
        return map("gueltig", true, "monate", monate, "datenlage", datenlage(monate), "fehler", null);
    }

    /** M1: Σ Zähler ÷ Σ Nenner der Referenzperiode — Summe durch Summe, nie ein Mittel. */
    public static Map<String, Object> basiswert(List<Paar> grundlage) {
        int n = grundlage.size();
        if (n == 0 || grundlage.stream().anyMatch(g -> g.zaehler() == null || g.nenner() == null))
            return map("basiswert", null, "monate", n, "datenlage", null, "grund", "keine_werte", "kennzeichen", List.of());
        Q zaehler = summe(grundlage.stream().map(g -> Q.of(g.zaehler())).toList());
        Q nenner = summe(grundlage.stream().map(g -> Q.of(g.nenner())).toList());
        if (nenner.signum() <= 0)
            return map("basiswert", null, "monate", n, "datenlage", null, "grund", "keine_werte", "kennzeichen", List.of());
        String lage = datenlage(n);
        return map("basiswert", kurz(zaehler.div(nenner), 4), "monate", n, "datenlage", lage, "grund", null,
                "kennzeichen", lage.equals("vorlaeufig") ? List.of(vorlaeufig(n)) : List.of());
    }

    private record Summen(Q sxx, Q sxy, Q syy, Q mx, Q my) {}
    private static Summen summen(List<Q> xs, List<Q> ys) {
        Q mx = mittel(xs), my = mittel(ys), sxx = Q.NULL, sxy = Q.NULL, syy = Q.NULL;
        for (int i = 0; i < xs.size(); i++) {
            Q dx = xs.get(i).minus(mx), dy = ys.get(i).minus(my);
            sxx = sxx.plus(dx.times(dx));
            sxy = sxy.plus(dx.times(dy));
            syy = syy.plus(dy.times(dy));
        }
        return new Summen(sxx, sxy, syy, mx, my);
    }

    /** G4: Pearson r; abhängig ab |r| ≥ 0,9 — geprüft als sxy² ≥ 0,81·sxx·syy. */
    public static Map<String, Object> abhaengigkeit(List<String> x1, List<String> x2) {
        return abhaengigkeitQ(x1.stream().map(Q::of).toList(), x2.stream().map(Q::of).toList());
    }
    private static Map<String, Object> abhaengigkeitQ(List<Q> x1, List<Q> x2) {
        Summen s = summen(x1, x2);
        if (s.sxx.signum() == 0 || s.syy.signum() == 0) return map("r", null, "abhaengig", false);
        Q r2 = s.sxy.times(s.sxy).div(s.sxx.times(s.syy));
        String r = wurzelFest(r2, 3);
        String mitVorzeichen = s.sxy.signum() < 0 && !r.equals("0.000") ? "-" + r : r;
        Q grenze = Q.of(STARTWERTE.abhaengig_r());
        return map("r", kurz(Q.of(mitVorzeichen), 3), "abhaengig", r2.compareTo(grenze.times(grenze)) >= 0);
    }

    private static Map<String, Object> spannweite(List<Q> xs) {
        Q von = xs.stream().min(Q::compareTo).orElseThrow(), bis = xs.stream().max(Q::compareTo).orElseThrow();
        Q p = Q.of(STARTWERTE.spannweite_prozent()).div(Q.of(100));
        return map("von", exakt(von), "bis", exakt(bis), "toleriert_von", exakt(von.times(Q.of(1).minus(p))),
                "toleriert_bis", exakt(bis.times(Q.of(1).plus(p))));
    }

    /** M2/M3: kleinste Quadrate aus den Monatspaaren; R², Streuung in % des Mittels, Spannweite je Variable; G1, G4. */
    public static Map<String, Object> modell(String methode, List<Reihe> reihe) {
        int n = reihe.size();
        java.util.function.Function<String, Map<String, Object>> leer = grund -> map("methode", methode, "monate", n, "basiswert", null,
                "koeffizienten", null, "r2", null, "streuung_prozent", null, "spannweite", List.of(), "abgelehnt", List.of(), "grund", grund);
        if (n == 0 || reihe.stream().anyMatch(r -> r.zaehler() == null || r.variablen().contains(null))) return leer.apply("keine_werte");
        if (n < STARTWERTE.mindest_monate()) return leer.apply("zu_wenig_perioden");
        List<Q> ys = reihe.stream().map(r -> Q.of(r.zaehler())).toList();
        List<List<Q>> spalten = new ArrayList<>();
        for (int i = 0; i < reihe.get(0).variablen().size(); i++) {
            int k = i;
            spalten.add(reihe.stream().map(r -> Q.of(r.variablen().get(k))).toList());
        }
        List<Map<String, Object>> abgelehnt = new ArrayList<>();
        if (spalten.size() == 2) {
            var pruefung = abhaengigkeitQ(spalten.get(0), spalten.get(1));
            if ((boolean) pruefung.get("abhaengig")) {
                abgelehnt.add(map("variable", 2, "grund", "variablen_abhaengig", "r", pruefung.get("r")));
                spalten = spalten.subList(0, 1);
            }
        }
        String ergebnis = methode.equals("regression_zwei_variablen") && spalten.size() == 1 ? "regression_eine_variable" : methode;
        Q my = mittel(ys);
        var koeff = new LinkedHashMap<String, Q>();
        List<Q> erwartet = new ArrayList<>();
        if (spalten.size() == 1) {
            List<Q> x = spalten.get(0);
            Summen s = summen(x, ys);
            if (s.sxx.signum() == 0) {
                var aus = leer.apply("zu_wenig_perioden");
                aus.put("abgelehnt", abgelehnt);
                return aus;
            }
            Q b = s.sxy.div(s.sxx), a = my.minus(b.times(s.mx));
            koeff.put("a", a);
            koeff.put("b", b);
            for (Q xi : x) erwartet.add(a.plus(b.times(xi)));
        } else {
            List<Q> x1 = spalten.get(0), x2 = spalten.get(1);
            Summen s1 = summen(x1, ys), s2 = summen(x2, ys);
            Q s12 = Q.NULL;
            for (int i = 0; i < n; i++) s12 = s12.plus(x1.get(i).minus(s1.mx).times(x2.get(i).minus(s2.mx)));
            Q det = s1.sxx.times(s2.sxx).minus(s12.times(s12));
            if (det.signum() == 0) {
                var aus = leer.apply("zu_wenig_perioden");
                aus.put("abgelehnt", abgelehnt);
                return aus;
            }
            Q b = s1.sxy.times(s2.sxx).minus(s2.sxy.times(s12)).div(det);
            Q c = s2.sxy.times(s1.sxx).minus(s1.sxy.times(s12)).div(det);
            Q a = my.minus(b.times(s1.mx)).minus(c.times(s2.mx));
            koeff.put("a", a);
            koeff.put("b", b);
            koeff.put("c", c);
            for (int i = 0; i < n; i++) erwartet.add(a.plus(b.times(x1.get(i))).plus(c.times(x2.get(i))));
        }
        Q ssRes = Q.NULL, ssTot = Q.NULL;
        for (int i = 0; i < n; i++) {
            Q r = ys.get(i).minus(erwartet.get(i)), t = ys.get(i).minus(my);
            ssRes = ssRes.plus(r.times(r));
            ssTot = ssTot.plus(t.times(t));
        }
        int frei = n - spalten.size() - 1;
        Q summeX = summe(spalten.get(0));
        var ko = new LinkedHashMap<String, Object>();
        koeff.forEach((k, v) -> ko.put(k, kurz(v, 4)));
        return map("methode", ergebnis, "monate", n, "basiswert", summeX.signum() > 0 ? kurz(summe(ys).div(summeX), 4) : null,
                "koeffizienten", ko,
                "r2", ssTot.signum() > 0 ? kurz(Q.of(1).minus(ssRes.div(ssTot)), 3) : null,
                "streuung_prozent", my.signum() > 0 && frei > 0
                        ? wurzelFest(ssRes.div(Q.of(frei)).div(my.times(my)).times(Q.of(10000)), 1) : null,
                "spannweite", spalten.stream().map(BezugsbasisRegeln::spannweite).toList(),
                "abgelehnt", abgelehnt, "grund", null);
    }

    private static String streuungText(Fassung f) {
        return f.streuung_prozent() == null ? null : "Streuung ± " + de(fest(Q.of(f.streuung_prozent()), 1)) + " %";
    }
    private static List<String> basisKennzeichen(Fassung f) {
        var v = f.variablen();
        String wo = "Bezugsbasis " + f.kennzeichen() + ", Fassung " + f.fassung();
        var liste = new ArrayList<String>();
        switch (f.methode()) {
            case "verhaeltnis" -> liste.add("bereinigt um " + v.get(0).name() + " (" + wo + ")");
            case "regression_eine_variable" -> liste.add("bereinigt um " + v.get(0).name() + " (Modell mit einer Einflussgröße, " + wo + "; " + streuungText(f) + ")");
            case "regression_zwei_variablen" -> liste.add("bereinigt um " + v.get(0).name() + " und " + v.get(1).name()
                    + " (Modell mit zwei Einflussgrößen, " + wo + "; " + streuungText(f) + ")");
            case "gradtage" -> {
                liste.add("bereinigt um Gradtage (G20/15, " + wo + ")");
                liste.add(streuungText(f));
            }
            default -> throw new IllegalArgumentException("Ungeprüfte Methode: " + f.methode());
        }
        if (f.methode().equals("verhaeltnis") && v.get(0).art().equals("gradtagzahl")) liste.add("ohne Grundlast");
        if (f.monate() < STARTWERTE.mindest_monate()) liste.add(vorlaeufig(f.monate()));
        return liste;
    }
    private static Map<String, Object> ergebnis(String urteil, String grund, String gemessen, String erwartet, String delta,
                                                String band, String richtung, List<String> kennzeichen) {
        return map("urteil", urteil, "grund", grund, "gemessen", gemessen, "erwartet", erwartet, "delta_prozent", delta,
                "band_prozent", band, "richtung", richtung, "kennzeichen", kennzeichen);
    }
    private static Map<String, Object> na(String grund, String gemessen) { return ergebnis(NA, grund, gemessen, null, null, null, null, List.of()); }
    private static Q band(Fassung f) {
        Q toleranz = Q.of(f.toleranz_prozent());
        Q streuung = f.streuung_prozent() == null ? Q.NULL : Q.of(f.streuung_prozent());
        return toleranz.compareTo(streuung) >= 0 ? toleranz : streuung;
    }
    private static String richtung(Q g, Q e) { int c = g.compareTo(e); return c > 0 ? "mehr" : c < 0 ? "weniger" : "gleich"; }
    /** U2/U3: im Rahmen, wenn |g − e|·100 ≤ Band·e — nie auf das Band gerundet. */
    private static String urteil(Q g, Q e, Q band, boolean unvollstaendig) {
        if (unvollstaendig) return OHNE;
        if (g.minus(e).abs().times(Q.of(100)).compareTo(band.times(e)) <= 0) return "im_rahmen";
        return g.compareTo(e) < 0 ? "besser" : "schlechter";
    }
    private static void dazu(List<String> liste, List<String> weitere) {
        if (weitere == null) return;
        for (String k : weitere) if (!liste.contains(k)) liste.add(k);
    }
    private static Q delta(Q g, Q e) { return g.minus(e).times(Q.of(100)).div(e); }

    /** U1–U4, G2, G3, G5: gemessen gegen erwartet einer freigegebenen Fassung, mit Grund statt Zahl, wo die Daten es nicht tragen. */
    public static Map<String, Object> vergleich(VergleichEingang e) {
        Fassung f = e.fassung();
        if (f == null) return na(e.basis_beendet() ? "basis_beendet" : "basis_fehlt", null);
        if (!e.abgeschlossen()) return na("periode_nicht_zu_ende", null);
        Wert gemessen = e.gemessen();
        if (gemessen.wert() == null) return na("keine_werte", null);
        int k = f.variablen().size();
        List<Wert> variablen = e.variablen();
        if (variablen.size() < k || variablen.subList(0, k).stream().anyMatch(v -> v.wert() == null)) return na("variable_fehlt", gemessen.wert());
        List<Q> xs = variablen.subList(0, k).stream().map(v -> Q.of(v.wert())).toList();
        List<Integer> ausserhalb = new ArrayList<>();
        List<Spannweite> sw = f.spannweite() == null ? List.of() : f.spannweite();
        for (int i = 0; i < sw.size(); i++)
            if (xs.get(i).compareTo(Q.of(sw.get(i).toleriert_von())) < 0 || xs.get(i).compareTo(Q.of(sw.get(i).toleriert_bis())) > 0) ausserhalb.add(i);
        List<String> kennzeichen = basisKennzeichen(f);
        Q erwartet;
        if (f.methode().equals("verhaeltnis")) {
            erwartet = Q.of(f.basiswert()).times(xs.get(0));
            for (int i : ausserhalb) {
                Spannweite s = sw.get(i);
                Variable v = f.variablen().get(i);
                kennzeichen.add(v.name() + " außerhalb der Basis-Spannweite (" + de(s.von()) + "–" + de(s.bis()) + " " + v.einheit() + ")");
            }
        } else {
            if (!ausserhalb.isEmpty()) return na("variable_ausserhalb", gemessen.wert());
            Koeffizienten ko = f.koeffizienten();
            erwartet = Q.of(ko.a()).plus(Q.of(ko.b()).times(xs.get(0)));
            if (xs.size() > 1) erwartet = erwartet.plus(Q.of(ko.c()).times(xs.get(1)));
        }
        if (erwartet.signum() <= 0) return na("keine_werte", gemessen.wert());
        Q g = Q.of(gemessen.wert());
        boolean unvollstaendig = "unvollstaendig".equals(gemessen.zustand())
                || variablen.stream().anyMatch(v -> "unvollstaendig".equals(v.zustand()));
        dazu(kennzeichen, gemessen.kennzeichen());
        for (Wert v : variablen) dazu(kennzeichen, v.kennzeichen());
        if (unvollstaendig) dazu(kennzeichen, List.of("unvollständig"));
        return ergebnis(urteil(g, erwartet, band(f), unvollstaendig), null, exakt(g), exakt(erwartet), fest(delta(g, erwartet), 1),
                fest(band(f), 1), richtung(g, erwartet), kennzeichen);
    }

    /** U5: Σ gemessen ÷ Σ erwartet über die Monate — nie ein Mittel der Monats-Δ; fehlt ein Monat: „x von y Monaten“. */
    public static Map<String, Object> zeitraum(ZeitraumEingang e) {
        Fassung f = e.fassung();
        List<Map<String, Object>> einzeln = e.monate().stream()
                .map(m -> vergleich(new VergleichEingang(f, e.basis_beendet(), m.abgeschlossen(), m.gemessen(), m.variablen()))).toList();
        List<Map<String, Object>> nutzbar = einzeln.stream().filter(x -> !NA.equals(x.get("urteil"))).toList();
        int y = e.soll_monate();
        if (nutzbar.isEmpty()) {
            String grund = !einzeln.isEmpty() && f == null ? (String) einzeln.get(0).get("grund") : "keine_werte";
            var aus = na(grund, null);
            aus.put("monate", "0 von " + y);
            return aus;
        }
        Q g = summe(nutzbar.stream().map(x -> Q.of((String) x.get("gemessen"))).toList());
        Q erw = summe(nutzbar.stream().map(x -> Q.of((String) x.get("erwartet"))).toList());
        boolean unvollstaendig = nutzbar.size() < y || nutzbar.stream().anyMatch(x -> OHNE.equals(x.get("urteil")));
        List<String> kennzeichen = basisKennzeichen(f);
        for (var x : nutzbar) {
            @SuppressWarnings("unchecked") List<String> k = (List<String>) x.get("kennzeichen");
            dazu(kennzeichen, k);
        }
        if (nutzbar.size() < y) dazu(kennzeichen, List.of(nutzbar.size() + " von " + y + " Monaten"));
        var aus = ergebnis(urteil(g, erw, band(f), unvollstaendig), null, exakt(g), exakt(erw), fest(delta(g, erw), 1),
                fest(band(f), 1), richtung(g, erw), kennzeichen);
        aus.put("monate", nutzbar.size() + " von " + y);
        return aus;
    }

    /** U1: die rohe Veränderung zur Vorperiode trägt nie ein Urteil. */
    public static Map<String, Object> roh(String aktuell, String vorher) {
        Q a = Q.of(aktuell), v = Q.of(vorher);
        if (a == null || v == null || v.signum() <= 0) return map("delta_prozent", null, "richtung", null, "urteil", OHNE);
        return map("delta_prozent", fest(delta(a, v), 1), "richtung", richtung(a, v), "urteil", OHNE);
    }

    /** Plan-Abnahme (E8): dieselbe Periode roh gegen den Vormonat — ohne Urteil — und bereinigt gegen die Basis. */
    public static Map<String, Object> rohUndBereinigt(String gemessen, String vorher, String variable, String variableVorher, VergleichEingang bereinigt) {
        var r = roh(gemessen, vorher);
        r.put("variable_delta_prozent", roh(variable, variableVorher).get("delta_prozent"));
        return map("roh", r, "bereinigt", vergleich(bereinigt));
    }

    /** M3: dieselbe Periode gegen das Modell mit Konstante und gegen das Verhältnis ohne Grundlast. */
    public static Map<String, Object> methodenPaar(VergleichEingang modell, VergleichEingang verhaeltnis) {
        return map("modell", vergleich(modell), "verhaeltnis", vergleich(verhaeltnis));
    }

    /** M5: Anzeige-Rundung kaufmännisch; ,5 vom Nullpunkt weg. */
    public static String runden(String wert, int stellen) { return fest(Q.of(wert), stellen); }

    /**
     * F4/F5 (AP-17 IP-17): die Frist der laufenden Fassung, beim Abruf abgeleitet — kein Läufer, keine Uhr. Beginn ist
     * der Freigabetag oder das jüngste „geprüft, bleibt“ ({@code bestaetigt_am}); fällig am Beginn + Wiedervorlage in
     * Kalendermonaten (Monatsende geklemmt: 31.01. + 1 → 28.02.). Ab dem Fälligkeitstag ist die Überprüfung fällig,
     * {@code faellig_seit_tagen} zählt ganze Tage bis zum Stichtag. Eine beendete Basis hat keine Frist mehr.
     * Alle Tage als JJJJ-MM-TT in der Zeitzone der Kennzahl.
     */
    public record FristEingang(String freigegeben_am, int wiedervorlage_monate, String bestaetigt_am, String beendet_zum, String stichtag) {}

    public static Map<String, Object> frist(FristEingang e) {
        Map<String, Object> r = new LinkedHashMap<>();
        if (e.beendet_zum() != null) {
            r.put("faellig_am", null);
            r.put("zustand", "beendet");
            r.put("faellig_seit_tagen", null);
            return r;
        }
        if (e.wiedervorlage_monate() <= 0) throw new IllegalArgumentException("wiedervorlage_monate > 0");
        LocalDate beginn = LocalDate.parse(e.freigegeben_am());
        if (e.bestaetigt_am() != null && LocalDate.parse(e.bestaetigt_am()).isAfter(beginn)) beginn = LocalDate.parse(e.bestaetigt_am());
        LocalDate faellig = beginn.plusMonths(e.wiedervorlage_monate());
        LocalDate stichtag = LocalDate.parse(e.stichtag());
        boolean ist = !stichtag.isBefore(faellig);
        r.put("faellig_am", faellig.toString());
        r.put("zustand", ist ? "ueberpruefung_faellig" : "freigegeben");
        r.put("faellig_seit_tagen", ist ? (int) ChronoUnit.DAYS.between(faellig, stichtag) : null);
        return r;
    }
}
