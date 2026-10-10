package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/** AP-16 NW-1. Rein: Monatswerte/Bilanz hinein, Vorschläge heraus; keine Einstufung, Uhr oder DB.
 * Zwillinge: uemsBewertung.ts und voltpilot_optimization/bewertung.py (aus k_faelle.py).
 */
public final class BewertungRegeln {
    private BewertungRegeln() {}
    public static final List<String> TRAEGER = List.of("Strom", "Gas", "Wärme", "Kälte", "Wasser", "Druckluft");
    public static final Kriterien STARTWERTE = new Kriterien("10", "80", "100000", "90", "5", 12, "80", 3);
    public static final List<String> URTEILE = List.of("ueber_schwelle", "unter_schwelle", "nicht_anwendbar", "nicht_belastbar", "erfuellt", "vorbehalt_datenlage", "vorbehalt_ersatzwerte", "unter_zwoelf", "vorlaeufig");
    public static final List<String> ABDECKUNG = List.of("gemessen", "geplant", "ersatz", "ungemessen");
    public static final List<String> EINSTUFUNGEN = List.of("wesentlich", "nicht_wesentlich", "offen");
    private static final String UEBER = "ueber_schwelle", UNTER = "unter_schwelle", NA = "nicht_anwendbar", NB = "nicht_belastbar";
    public record Kriterien(String K1, String K2, String K3, String K5, String K6, int K7, String K8, int mindest_monate) {}
    public record Anlage(String kennung, boolean hauptzaehler, String zufluss, String abgabe, String laden) {}
    public record Nenner(String wert, int vorhanden, int gesamt, String zustand) {}
    public record Messstelle(String kennung, String traeger, String art, boolean direkt, boolean archiviert, String wert, String ersatz) {}
    public record Einsatz(String kennung, String menge, String datenlage_prozent, String ersatz_prozent, String begruendung) {}
    public record RanglisteEingang(Nenner nenner, String traeger, int monate, List<Einsatz> einsaetze, Kriterien kriterien) {}
    public record Rest(String kennung, String wert) {}
    public record AbdeckungEingang(List<Messstelle> messstellen, String traeger, List<Rest> reste, String nenner, List<String> offene_bedarfe, String schwelle) {}
    public record Term(String messstelle, String verteilung) {}
    public record ProzessSumme(String kennung, List<Term> terme) {}

    private static BigDecimal d(String value) { return value == null ? null : new BigDecimal(value); }
    private static String text(BigDecimal value) { return value == null ? null : value.stripTrailingZeros().toPlainString(); }
    private static Map<String, Object> obj(Object... pairs) {
        var result = new LinkedHashMap<String, Object>();
        for (int i = 0; i < pairs.length; i += 2) result.put((String) pairs[i], pairs[i + 1]);
        return result;
    }
    /** KR4: nur Anzeige, nie zum Vergleich gegen eine Schwelle benutzen. */
    public static String prozent(BigDecimal teil, BigDecimal ganzes) {
        if (teil == null || ganzes == null || ganzes.signum() <= 0) return null;
        return teil.multiply(BigDecimal.valueOf(100)).divide(ganzes, 1, RoundingMode.HALF_UP).toPlainString();
    }
    private static String schwelle(BigDecimal teil, BigDecimal ganzes, String grenze) {
        if (teil == null || ganzes == null || ganzes.signum() <= 0) return NA;
        return teil.multiply(BigDecimal.valueOf(100)).compareTo(ganzes.multiply(d(grenze))) >= 0 ? UEBER : UNTER;
    }
    public static Map<String, Object> nenner(List<Anlage> anlagen) {
        var werte = new ArrayList<Map<String, Object>>();
        BigDecimal summe = BigDecimal.ZERO;
        int vorhanden = 0;
        for (var a : anlagen) {
            BigDecimal wert = !a.hauptzaehler || a.zufluss == null || a.abgabe == null || a.laden == null ? null
                : d(a.zufluss).subtract(d(a.abgabe)).subtract(d(a.laden));
            if (wert != null) { summe = summe.add(wert); vorhanden++; }
            werte.add(obj("kennung", a.kennung, "wert", text(wert)));
        }
        return obj("wert", vorhanden == anlagen.size() ? text(summe) : null, "vorhanden", vorhanden,
            "gesamt", anlagen.size(), "zustand", vorhanden == anlagen.size() ? "vollständig" : "unvollständig", "anlagen", werte);
    }
    private static List<Messstelle> relevante(List<Messstelle> messstellen, String traeger) {
        if (!TRAEGER.contains(traeger)) throw new IllegalArgumentException("traeger_unbekannt");
        var ms = messstellen.stream().filter(m -> m.traeger.equals(traeger) && m.direkt && !m.archiviert && m.art.equals("gemessen")).toList();
        if (ms.stream().map(Messstelle::kennung).distinct().count() != ms.size()) throw new IllegalArgumentException("messstelle_doppelt");
        return ms;
    }
    public static Map<String, Object> menge(List<Messstelle> messstellen, String traeger) {
        var ms = relevante(messstellen, traeger);
        var werte = ms.stream().filter(m -> m.wert != null).toList();
        BigDecimal menge = werte.stream().map(m -> d(m.wert)).reduce(BigDecimal.ZERO, BigDecimal::add);
        BigDecimal ersatz = werte.stream().map(m -> d(m.ersatz)).reduce(BigDecimal.ZERO, BigDecimal::add);
        return obj("menge", werte.isEmpty() ? null : text(menge), "ersatz", werte.isEmpty() ? null : text(ersatz),
            "zustand", werte.isEmpty() ? "keine Werte" : werte.size() != ms.size() ? "unvollständig" : ersatz.signum() > 0 ? "mit Ersatzwert" : "vollständig");
    }
    /** KR2–KR4: Urteil und Vorschlag; ausdrücklich keine menschliche Einstufung. */
    public static Map<String, Object> urteil(RanglisteEingang e) {
        if (!TRAEGER.contains(e.traeger)) throw new IllegalArgumentException("traeger_unbekannt");
        var k = e.kriterien;
        boolean strom = e.traeger.equals("Strom");
        BigDecimal n = strom && e.nenner.zustand.equals("vollständig") ? d(e.nenner.wert) : null;
        var zeilen = e.einsaetze.stream().sorted(Comparator.comparing((Einsatz x) -> d(x.menge),
            Comparator.nullsLast(Comparator.reverseOrder())).thenComparing(Einsatz::kennung)).toList();
        BigDecimal zugeordnet = zeilen.stream().filter(x -> x.menge != null).map(x -> d(x.menge)).reduce(BigDecimal.ZERO, BigDecimal::add);
        String k8 = schwelle(zugeordnet, n, k.K8);
        String k7 = e.monate >= k.K7 ? "erfuellt" : e.monate < k.mindest_monate ? "vorlaeufig" : "unter_zwoelf";
        var aus = new ArrayList<Map<String, Object>>();
        BigDecimal kum = BigDecimal.ZERO;
        int rang = 0;
        for (var x : zeilen) {
            rang++;
            BigDecimal m = d(x.menge);
            String k1 = schwelle(m, n, k.K1);
            String k2 = !strom || m == null || zugeordnet.signum() == 0 ? NA : !k8.equals(UEBER) ? NB
                : kum.multiply(BigDecimal.valueOf(100)).compareTo(zugeordnet.multiply(d(k.K2))) < 0 ? UEBER : UNTER;
            String k3 = !strom || m == null || e.monate != 12 ? NA : m.compareTo(d(k.K3)) >= 0 ? UEBER : UNTER;
            if (m != null) kum = kum.add(m);
            aus.add(obj("kennung", x.kennung, "menge", text(m), "rang", m != null && strom ? rang : null,
                "anteil_prozent", prozent(m, n), "kumuliert_zugeordnet_prozent", m != null && strom ? prozent(kum, zugeordnet) : null,
                "K1", k1, "K2", k2, "K3", k3, "K4", x.begruendung,
                "K5", x.datenlage_prozent != null && d(x.datenlage_prozent).compareTo(d(k.K5)) >= 0 ? "erfuellt" : "vorbehalt_datenlage",
                "K6", x.ersatz_prozent != null && d(x.ersatz_prozent).compareTo(d(k.K6)) <= 0 ? "erfuellt" : "vorbehalt_ersatzwerte",
                "vorschlag", List.of(k1, k2, k3).contains(UEBER) ? UEBER : UNTER,
                "zustand", m == null ? "keine Werte" : strom && !e.nenner.zustand.equals("vollständig") ? "unvollständig" : "vollständig"));
        }
        return obj("nenner", text(n), "anlagen", e.nenner.vorhanden + " von " + e.nenner.gesamt, "zugeordnet", text(zugeordnet),
            "rest", n == null ? null : text(n.subtract(zugeordnet)), "abdeckung_prozent", prozent(zugeordnet, n), "K8", k8, "K7", k7, "einsaetze", aus);
    }
    /** Kompatibler Name aus IP-2; neue Aufrufer verwenden {@link #urteil(RanglisteEingang)}. */
    public static Map<String, Object> rangliste(RanglisteEingang e) { return urteil(e); }
    /** Gleiche Regel je Einsatz, Ort und Umfang; Rest wird nicht einem Einsatz zugeschlagen. */
    public static Map<String, Object> abdeckung(AbdeckungEingang e) {
        var ms = relevante(e.messstellen, e.traeger);
        var m = menge(ms, e.traeger);
        BigDecimal rest = e.reste.stream().allMatch(r -> r.wert != null)
            ? e.reste.stream().map(r -> d(r.wert)).reduce(BigDecimal.ZERO, BigDecimal::add) : null;
        BigDecimal n = e.traeger.equals("Strom") ? d(e.nenner) : null;
        var geplant = new TreeSet<>(e.offene_bedarfe);
        ms.stream().filter(s -> s.wert == null).map(Messstelle::kennung).forEach(geplant::add);
        var aus = new LinkedHashMap<>(m);
        aus.putAll(obj("gemessen", ms.stream().filter(s -> s.wert != null).map(Messstelle::kennung).toList(),
            "geplant", new ArrayList<>(geplant), "ersatz_messstellen", ms.stream().filter(s -> s.wert != null && d(s.ersatz).signum() > 0).map(Messstelle::kennung).toList(),
            "ungemessen", e.reste.isEmpty() ? null : text(rest), "abdeckung_prozent", prozent(d((String) m.get("menge")), n),
            "K8", schwelle(d((String) m.get("menge")), n, e.schwelle)));
        return aus;
    }
    public static List<Map<String, Object>> prozessSummePasst(List<String> gemessen, List<ProzessSumme> summen) {
        var zugeordnet = Set.copyOf(gemessen);
        return summen.stream().flatMap(s -> s.terme.stream().filter(t -> !zugeordnet.contains(t.messstelle))
            .map(t -> obj("summe", s.kennung, "messstelle", t.messstelle, "verteilung", t.verteilung))).toList();
    }
    public static Map<String, Object> toleranz(String fuehrend, String vergleich, String grenze) {
        BigDecimal a = d(fuehrend), b = d(vergleich);
        BigDecimal diff = a == null || b == null ? null : a.subtract(b).abs();
        String p = prozent(diff, a);
        return obj("abweichung_prozent", p, "toleranz_prozent", grenze,
            "befund", p == null ? null : diff.multiply(BigDecimal.valueOf(100)).compareTo(a.multiply(d(grenze))) > 0);
    }

    /** Eine Seite des Monatsvergleichs (IP-17): Monatsmenge und ihr gespeicherter Mengenzustand. */
    public record MonatsSeite(String menge, String zustand) {}
    public static final String PASST = "passt", ABWEICHUNG = "abweichung", NICHT_VERGLEICHBAR = "nicht_vergleichbar";

    /**
     * G5 im Lesemodell (IP-17): EIN Monat führend ↔ Vergleich. Vergleichbar sind nur zwei vollständig
     * gemessene Monatsmengen über den ganzen Monat; eine Lücke oder ein Ersatzwert ist kein Befund, sondern
     * {@code nicht_vergleichbar} mit Grund. Die Abweichung selbst rechnet {@link #toleranz}; keine Ursache.
     */
    public static Map<String, Object> monatsvergleich(MonatsSeite fuehrend, MonatsSeite vergleich,
            boolean ganzerMonat, String grenze) {
        String grund = !ganzerMonat ? "vergleich_nicht_ganzer_monat" : luecke("fuehrend", fuehrend);
        if (grund == null) grund = luecke("vergleich", vergleich);
        Map<String, Object> t = grund == null ? toleranz(fuehrend.menge(), vergleich.menge(), grenze) : null;
        if (t != null && t.get("befund") == null) grund = "fuehrend_nicht_positiv";
        if (grund != null) return obj("zustand", NICHT_VERGLEICHBAR, "grund", grund, "abweichung_prozent", null,
            "toleranz_prozent", grenze, "befund", null);
        boolean befund = (Boolean) t.get("befund");
        return obj("zustand", befund ? ABWEICHUNG : PASST, "grund", null,
            "abweichung_prozent", t.get("abweichung_prozent"), "toleranz_prozent", grenze, "befund", befund);
    }
    private static String luecke(String seite, MonatsSeite s) {
        if (s == null || s.menge() == null || !"vollständig".equals(s.zustand()))
            return seite + (s != null && s.menge() != null && "mit Ersatzwert".equals(s.zustand()) ? "_ersatzwert" : "_luecke");
        return null;
    }
}
