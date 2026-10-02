package com.voltpilot.api.mispel;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.mispel.MispelAbgrenzungRepository.Zeile;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Die Kundenansicht der Abgrenzungsoption (MP-18, Bedienkonzept BK-18 Variante A): je (Rumpf-)Monat die Mengen nach
 * Anlage 1 in den Farben der Festlegung (A1 S. 18, Abschn. 2.3), jede mit Formelnummer und Begriff aus dem Katalog der
 * Vektor-Datei, dazu der Stand und „Was das wert ist“.
 *
 * <p><b>Nur aus den gespeicherten Läufen</b> (MP-8, MP-21): die Mengen sind die Monatswerte des Nachweis-Texts, gelesen
 * über {@link MispelNachweis#lesen} (Prüfsumme). Selbst gebildet werden nur
 * <ul>
 *   <li>Grau = (4) − (26) − (31) − (16): die Einspeisung, die weder förderfähig noch saldierungsfähig ist (AW ≤ 0,
 *       Fremdtankstrom). Anlage 1 benennt diese Restgröße nicht; sie ist ≥ 0, weil (16) + (28) = (13) ≤ (11) und
 *       (31) ≤ (28) (A1 S. 35–39);</li>
 *   <li>in A5 die Summen (26a) + (26b) und (31a) + (31b) für den Balken — A5 kennt keine Gesamtsumme (A1 S. 50);</li>
 *   <li>die Beträge: (20) × Umlagen bzw. Netzentgelt-Arbeitspreis aus dem Preisblatt der Anlage, (32) × max(AW − JMW, 0)
 *       mit dem Jahresmarktwert Solar (A1 S. 21 Vor. 5). Unbekannt heißt {@code offen}, nie 0.</li>
 * </ul>
 */
public final class MispelMengen {

    public static final String OFFEN = "offen";
    public static final String BESTIMMT = "bestimmt";

    private static final BigDecimal HUNDERT = BigDecimal.valueOf(100);

    private MispelMengen() {}

    /** Das Preisblatt der Anlage (ct/kWh netto, {@code null} = nicht gepflegt) und die USt in Prozent. */
    public record Preise(BigDecimal umlagenCt, BigDecimal netzentgeltCt, BigDecimal ustPct) {}

    /** Anzulegender Wert der Anlage und Jahresmarktwert Solar des Jahres; {@code null} = unbekannt bzw. nicht veröffentlicht. */
    public record Marktwert(BigDecimal awCt, BigDecimal jahresmarktwertCt, boolean jahresmarktwertVorlaeufig) {}

    /** Eine Menge mit ihrer Formel: Nummer, Begriff und Fundstelle wörtlich aus Anlage 1; kWh kaufmännisch auf 3 Stellen. */
    public record Menge(String nr, String begriff, String fundstelle, BigDecimal kwh) {}

    /** Ein Stück des Farbbalkens: {@code gruen}, {@code gelb}, {@code rot} oder {@code grau}. */
    public record Farbe(String farbe, String formel, String begriff, String fundstelle, BigDecimal kwh) {}

    /** Was sich beim Endgültig-Werden geändert hat: die vorige (vorläufige) Fassung, ihre Gründe und der Unterschied. */
    public record Aenderung(int vorherFassung, String vorherWertequelle, List<String> vorherGruende,
            BigDecimal vorherSummeEur, BigDecimal differenzEur) {}

    /** Ein Lauf: ein Kalendermonat oder ein Rumpfmonat (A1 S. 102). */
    public record Teil(String schluessel, LocalDate ersterTag, LocalDate letzterTag, String formelsatz,
            String formelsatzBezeichnung, int fassung, String stand, List<String> standGruende, String wertequelle,
            Instant gerechnetAm, int luecken, Menge einspeisung, List<Farbe> farben, Menge netzbezug,
            Menge umlagereduziert, Menge umlagebelastet, Menge foerderfaehig, Aenderung aenderung) {}

    /** Ein Betrag: {@code bestimmt} mit {@code eur} oder {@code offen} mit {@code grund}; nie 0 für unbekannt. */
    public record Betrag(String stand, BigDecimal eur, BigDecimal mengeKwh, String formel, BigDecimal satzCt,
            String grund) {}

    /** „Was das wert ist“; {@code marktpraemie == null} ohne Förderseite (A10, A11). */
    public record Wert(Betrag vermiedeneUmlagen, Betrag vermiedenesNetzentgelt, Betrag marktpraemie,
            BigDecimal summeOhneMarktpraemieEur, BigDecimal ustPct) {}

    // ------------------------------------------------------------------ Teile

    /** Die Teile aus den geltenden Läufen; {@code alle} sind alle Fassungen des Zeitraums (für die Änderung). */
    public static List<Teil> teile(List<MispelNachweis.Lauf> geltende, List<Zeile> alle, Preise preise) {
        List<Teil> raus = new ArrayList<>();
        for (MispelNachweis.Lauf l : geltende) {
            Aenderung a = l.endgueltig() ? aenderung(l, alle, preise) : null;
            raus.add(teil(l, a));
        }
        return List.copyOf(raus);
    }

    static Teil teil(MispelNachweis.Lauf l, Aenderung aenderung) {
        Map<String, Bruch> m = werte(l);
        String fs = l.zeile().formelsatz();
        MispelNachweis.Formelsatz satz = MispelNachweis.FORMELSAETZE.get(fs);
        List<String> gruende = new ArrayList<>();
        l.nachweis().path("stand_gruende").forEach(g -> gruende.add(g.asText()));
        Bruch b4 = wert(m, "(4)");
        Bruch gruen = summe(m, "(26)", "(26a)", "(26b)");
        Bruch gelb = summe(m, "(31)", "(31a)", "(31b)");
        Bruch rot = wert(m, "(16)");
        List<Farbe> farben = new ArrayList<>();
        Bruch grau = b4;
        if (gruen != null) {
            farben.add(farbe("gruen", m, gruen, "(26)", "(26a)", "(26b)"));
            grau = grau.minus(gruen);
        }
        if (gelb != null) {
            farben.add(farbe("gelb", m, gelb, "(31)", "(31a)", "(31b)"));
            grau = grau.minus(gelb);
        }
        if (rot != null) {
            farben.add(farbe("rot", m, rot, nr(m, "(16)")));
            grau = grau.minus(rot);
        }
        String grauFormel = "(4) − " + String.join(" − ", farben.stream().map(Farbe::formel)
                .map(f -> f.contains("+") ? "[" + f + "]" : f).toList());
        farben.add(new Farbe("grau", grauFormel, "Netzeinspeisung, die weder förderfähig noch saldierungsfähig ist",
                "A1 S. 34–39", kwh(grau)));
        Bruch foerder = summe(m, "(32)", "(32a)", "(32b)");
        return new Teil(l.schluessel(), l.ersterTag(), l.letzterTag(), fs, satz == null ? fs : satz.bezeichnung(),
                l.zeile().fassung(), l.zeile().stand(), List.copyOf(gruende), l.zeile().wertequelle(),
                l.zeile().gerechnetAm(), l.nachweis().path("viertelstunden").path("luecken").asInt(0),
                menge(m, nr(m, "(4)")), List.copyOf(farben), menge(m, nr(m, "(3)")), menge(m, nr(m, "(20)")),
                menge(m, nr(m, "(21)")), foerder == null ? null : foerderMenge(m, foerder), aenderung);
    }

    /** Die vorige vorläufige Fassung desselben Zeitraums, wenn ihre Zahlen anders waren. */
    private static Aenderung aenderung(MispelNachweis.Lauf l, List<Zeile> alle, Preise preise) {
        Zeile vorher = alle.stream()
                .filter(z -> z.zeitraumVon().equals(l.zeile().zeitraumVon()) && z.fassung() < l.zeile().fassung()
                        && MispelNachweis.VORLAEUFIG.equals(z.stand()))
                .max(Comparator.comparingInt(Zeile::fassung)).orElse(null);
        if (vorher == null) {
            return null;
        }
        MispelNachweis.Lauf v = MispelNachweis.lesen(vorher);
        if (werte(v).equals(werte(l))) {
            return null;
        }
        List<String> gruende = new ArrayList<>();
        v.nachweis().path("stand_gruende").forEach(g -> gruende.add(g.asText()));
        BigDecimal jetzt = wert(List.of(teil(l, null)), preise, null).summeOhneMarktpraemieEur();
        BigDecimal davor = wert(List.of(teil(v, null)), preise, null).summeOhneMarktpraemieEur();
        return new Aenderung(vorher.fassung(), vorher.wertequelle(), List.copyOf(gruende), davor,
                jetzt == null || davor == null ? null : jetzt.subtract(davor));
    }

    // ------------------------------------------------------------------ Wert

    /** „Was das wert ist“ über die Teile eines Monats oder Jahres. */
    public static Wert wert(List<Teil> teile, Preise preise, Marktwert marktwert) {
        BigDecimal ust = preise == null || preise.ustPct() == null ? null : preise.ustPct();
        BigDecimal menge20 = teile.stream().map(t -> t.umlagereduziert().kwh()).reduce(BigDecimal.ZERO, BigDecimal::add);
        Betrag umlagen = vermieden(menge20, preise == null ? null : preise.umlagenCt(), ust);
        Betrag netz = vermieden(menge20, preise == null ? null : preise.netzentgeltCt(), ust);
        Betrag praemie = praemie(teile, marktwert);
        BigDecimal summe = BESTIMMT.equals(umlagen.stand()) && BESTIMMT.equals(netz.stand())
                ? umlagen.eur().add(netz.eur()) : null;
        return new Wert(umlagen, netz, praemie, summe, ust);
    }

    private static Betrag vermieden(BigDecimal menge, BigDecimal satzCt, BigDecimal ust) {
        if (satzCt == null || ust == null) {
            return new Betrag(OFFEN, null, menge, "(20)", satzCt, "preisblatt_fehlt");
        }
        BigDecimal eur = menge.multiply(satzCt).multiply(HUNDERT.add(ust))
                .divide(HUNDERT.multiply(HUNDERT), 2, RoundingMode.HALF_UP);
        return new Betrag(BESTIMMT, eur, menge, "(20)", satzCt, null);
    }

    private static Betrag praemie(List<Teil> teile, Marktwert mw) {
        List<Teil> mit = teile.stream().filter(t -> t.foerderfaehig() != null).toList();
        if (mit.isEmpty()) {
            return null;
        }
        BigDecimal menge = mit.stream().map(t -> t.foerderfaehig().kwh()).reduce(BigDecimal.ZERO, BigDecimal::add);
        String formel = mit.get(0).foerderfaehig().nr();
        if (mit.stream().anyMatch(t -> t.foerderfaehig().nr().contains("a"))) {
            return new Betrag(OFFEN, null, menge, formel, null, "je_anlage_a5");
        }
        if (mw == null || mw.awCt() == null) {
            return new Betrag(OFFEN, null, menge, formel, null, "anzulegender_wert_fehlt");
        }
        if (mw.jahresmarktwertCt() == null || mw.jahresmarktwertVorlaeufig()) {
            return new Betrag(OFFEN, null, menge, formel, null, "jahresmarktwert_offen");
        }
        BigDecimal satz = mw.awCt().subtract(mw.jahresmarktwertCt()).max(BigDecimal.ZERO);
        return new Betrag(BESTIMMT, menge.multiply(satz).divide(HUNDERT, 2, RoundingMode.HALF_UP), menge, formel,
                satz, null);
    }

    // ------------------------------------------------------------------ Werte lesen

    private static Map<String, Bruch> werte(MispelNachweis.Lauf l) {
        Map<String, Bruch> raus = new LinkedHashMap<>();
        JsonNode m = l.nachweis().path("monatswerte").path(l.schluessel());
        m.fields().forEachRemaining(e -> raus.put(e.getKey(), MispelNachweis.bruch(e.getValue())));
        return raus;
    }

    /** Die Formel mit dieser Nummer: genau „(16)“, sonst die Fassung des Formelsatzes („(16)A11“, „(20)A10“). */
    private static String nr(Map<String, Bruch> m, String nr) {
        if (m.containsKey(nr)) {
            return nr;
        }
        return m.keySet().stream().filter(k -> k.startsWith(nr)).findFirst().orElse(null);
    }

    private static Bruch wert(Map<String, Bruch> m, String nr) {
        String k = nr(m, nr);
        return k == null ? null : m.get(k);
    }

    /** Die erste vorhandene Formel oder die Summe der a/b-Formeln (A5); {@code null}, wenn der Formelsatz keine hat. */
    private static Bruch summe(Map<String, Bruch> m, String ganz, String a, String b) {
        if (m.containsKey(ganz)) {
            return m.get(ganz) == null ? Bruch.NULL : m.get(ganz);
        }
        if (m.containsKey(a) || m.containsKey(b)) {
            return nullAlsNull(m.get(a)).plus(nullAlsNull(m.get(b)));
        }
        return null;
    }

    private static Bruch nullAlsNull(Bruch b) {
        return b == null ? Bruch.NULL : b;
    }

    private static Farbe farbe(String farbe, Map<String, Bruch> m, Bruch wert, String ganz, String a, String b) {
        if (m.containsKey(ganz)) {
            return farbe(farbe, m, wert, ganz);
        }
        MispelNachweis.Formel f = MispelNachweis.KATALOG.get(a);
        return new Farbe(farbe, a + " + " + b, f == null ? "" : f.begriff(), f == null ? "" : f.fundstelle(), kwh(wert));
    }

    private static Farbe farbe(String farbe, Map<String, Bruch> m, Bruch wert, String nr) {
        MispelNachweis.Formel f = formel(nr);
        return new Farbe(farbe, nr, f.begriff(), f.fundstelle(), kwh(wert));
    }

    private static Menge menge(Map<String, Bruch> m, String nr) {
        if (nr == null) {
            return null;
        }
        MispelNachweis.Formel f = formel(nr);
        return new Menge(nr, f.begriff(), f.fundstelle(), kwh(m.get(nr)));
    }

    private static Menge foerderMenge(Map<String, Bruch> m, Bruch wert) {
        String nr = m.containsKey("(32)") ? "(32)" : "(32a) + (32b)";
        MispelNachweis.Formel f = formel(m.containsKey("(32)") ? "(32)" : "(32a)");
        return new Menge(nr, f.begriff(), f.fundstelle(), kwh(wert));
    }

    private static MispelNachweis.Formel formel(String nr) {
        return MispelNachweis.KATALOG.getOrDefault(nr, new MispelNachweis.Formel(nr, "", "", ""));
    }

    private static BigDecimal kwh(Bruch b) {
        return b == null ? null : MispelNachweis.gerundet("(4)", b);
    }
}
