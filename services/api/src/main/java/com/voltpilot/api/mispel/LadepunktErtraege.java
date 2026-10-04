package com.voltpilot.api.mispel;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * MiSpeL MP-41a: was ein bidirektionaler Ladepunkt im Kalendermonat gebracht hat (Bedienkonzept BK-41, Verlauf ›
 * Erlöse). Rein: liest die Mengen aus dem gespeicherten Monatslauf der Abgrenzung (Formelsätze A2, A3, A4, MP-32 —
 * Anlage 1 S. 29–39) und stellt die Posten gegen dasselbe Haus, in dem das Auto nur lädt.
 *
 * <p>Die Zahlen sind die der Festlegung, keine eigenen: (5), (6), (9), (10), (11), (12), (13), (14), (15), (16), (20),
 * (28), (31) wörtlich aus {@code monatswerte}. In A3 und A4 misst Z2 Stromspeicher und Ladepunkt gemeinsam (A1 S. 30–32)
 * — dann sind es die Mengen beider, und kein Posten aus dem Rechenwerk wird dem Auto allein zugeschrieben.
 *
 * <p>Der Vergleich „Auto lädt nur“ (Messlatte, MP-33d) kommt aus der Ablage je Viertelstunde (MP-33e,
 * {@link LadepunktMesslatteRepository}): die vier Posten, die nur aus ihm folgen, und die Summe aller Posten ohne
 * Marktprämie. Fehlt er für eine Viertelstunde des Monats, sind diese Posten und die Summe {@code offen} — „Ein Minus
 * steht nie allein“, „Unbekannt ist keine Null“. Die Summe steht nur, wenn alle sechs Posten bestimmt sind.
 */
public final class LadepunktErtraege {

    private LadepunktErtraege() {}

    /** Die Formelsätze mit Ladepunkt (A1 S. 29–31). */
    public static final Set<String> MIT_LADEPUNKT = Set.of("A2", "A3", "A4");
    /** Die Mengen der Karte in der Reihenfolge der Festlegung. */
    public static final List<String> MENGEN = List.of("(5)", "(9)", "(10)", "(6)", "(11)", "(12)", "(13)", "(14)",
            "(15)", "(16)", "(20)", "(28)", "(31)");

    public static final String WENIGER_GEKAUFT = "weniger_gekauft";
    public static final String MEHR_GELADEN = "mehr_geladen";
    public static final String INS_NETZ_VERKAUFT = "ins_netz_verkauft";
    public static final String VERMIEDENE_UMLAGEN = "vermiedene_umlagen";
    public static final String VERMIEDENES_NETZENTGELT = "vermiedenes_netzentgelt";
    public static final String AKKU_VERSCHLEISS = "akku_verschleiss";
    public static final String MARKTPRAEMIE = "marktpraemie";

    /** Grund: der Vergleich mit demselben Haus, in dem das Auto nur lädt, ist noch nicht gerechnet. */
    public static final String MESSLATTE_FEHLT = "messlatte_fehlt";
    /** Grund: A3/A4 — Z2 misst Stromspeicher und Ladepunkt gemeinsam; der Anteil des Autos folgt nur aus dem Vergleich. */
    public static final String SPEICHER_UND_LADEPUNKT = "speicher_und_ladepunkt";

    private static final BigDecimal HUNDERT = BigDecimal.valueOf(100);

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Ladepunkt(UUID komponente, String name, String einordnung) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Menge(String nr, String begriff, String fundstelle, BigDecimal kwh) {}

    /**
     * Ein Teil des Monats (Kalender- oder Rumpfmonat, A1 S. 102). {@code nurLadepunkt} {@code true} in A2 (Z2 misst nur
     * den Ladepunkt), {@code false} in A3/A4.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Teil(String schluessel, LocalDate ersterTag, LocalDate letzterTag, String formelsatz,
            String formelsatzBezeichnung, boolean nurLadepunkt, String stand, String wertequelle, List<Menge> mengen,
            Menge insHaus) {}

    /** Ein Posten: {@code bestimmt} mit {@code eur} (mit Vorzeichen) oder {@code offen} mit {@code grund}. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Posten(String schluessel, String stand, BigDecimal eur, BigDecimal mengeKwh, String formel,
            BigDecimal satzCt, String grund, boolean vorbehalt) {}

    /**
     * Die Messlatte „nur laden“ über den Monat (MP-33e): die Summen der vier Posten aus der Ablage je Viertelstunde,
     * EUR mit Vorzeichen, kWh wie {@code domain.MesslattePosten}. Ein PLAN-Wert, keine gemessene Wirkung.
     */
    public record Messlatte(BigDecimal wenigerGekauftEur, BigDecimal wenigerGekauftKwh, BigDecimal mehrGeladenEur,
            BigDecimal mehrGeladenKwh, BigDecimal insNetzVerkauftEur, BigDecimal insNetzVerkauftKwh,
            BigDecimal akkuVerschleissEur, BigDecimal rueckgespeistKwh) {}

    /** Der Vergleich mit demselben Haus, in dem das Auto nur lädt; {@code summeEur} ohne Marktprämie. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vergleich(String stand, String grund, BigDecimal summeEur) {}

    /** {@code ustPct} = der USt-Satz des Preisblatts, mit dem Umlagen und Netzentgelt brutto gerechnet sind. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Monat(UUID anlage, String monat, List<Ladepunkt> ladepunkte, List<Teil> teile, List<Posten> posten,
            Vergleich vergleich, BigDecimal ustPct) {}

    /** Der Teil eines Laufs mit Ladepunkt; {@code null} für A1, A5, A10, A11. */
    static Teil teil(MispelNachweis.Lauf l) {
        String fs = l.zeile().formelsatz();
        if (!MIT_LADEPUNKT.contains(fs)) {
            return null;
        }
        JsonNode werte = l.nachweis().path("monatswerte").path(l.schluessel());
        Map<String, Menge> mengen = new LinkedHashMap<>();
        for (String nr : MENGEN) {
            String schluessel = schluessel(werte, nr);
            MispelNachweis.Formel f = MispelNachweis.KATALOG.getOrDefault(schluessel == null ? nr : schluessel,
                    new MispelNachweis.Formel(nr, "", "", ""));
            BigDecimal kwh = schluessel == null ? null
                    : MispelNachweis.gerundet(schluessel, MispelNachweis.bruch(werte.get(schluessel)));
            mengen.put(nr, new Menge(schluessel == null ? nr : schluessel, f.begriff(), f.fundstelle(), kwh));
        }
        BigDecimal b6 = mengen.get("(6)").kwh();
        BigDecimal b11 = mengen.get("(11)").kwh();
        Menge insHaus = new Menge("(6) − (11)", "Erzeugung im Stromspeicher und/oder Ladepunkt, die nicht zeitgleich ins "
                + "Netz eingespeist wurde (gewillkürter Speichervorrang)", "A1 S. 14–16, Abschn. 2.1.5; S. 34–35",
                b6 == null || b11 == null ? null : b6.subtract(b11));
        MispelNachweis.Formelsatz satz = MispelNachweis.FORMELSAETZE.get(fs);
        return new Teil(l.schluessel(), l.ersterTag(), l.letzterTag(), fs, satz == null ? fs : satz.bezeichnung(),
                "A2".equals(fs), l.zeile().stand(), l.zeile().wertequelle(), List.copyOf(mengen.values()), insHaus);
    }

    /**
     * Die sieben Posten in der Reihenfolge der Karte und der Vergleich. Ohne Messlatte ({@code ml == null}) sind die
     * Posten, die nur aus dem Vergleich folgen, und die Summe offen; die Summe steht nur, wenn die sechs Posten außer
     * der Marktprämie alle bestimmt sind — sonst ist sie offen mit dem Grund des ersten offenen Postens.
     */
    static Monat monat(UUID anlage, String monat, List<Ladepunkt> ladepunkte, List<Teil> teile,
            MispelMengen.Preise preise, MispelMengen.Marktwert mw, Messlatte ml) {
        if (teile.isEmpty()) {
            return new Monat(anlage, monat, ladepunkte, List.of(), List.of(), new Vergleich(MispelMengen.OFFEN,
                    MESSLATTE_FEHLT, null), null);
        }
        boolean nurLadepunkt = teile.stream().allMatch(Teil::nurLadepunkt);
        List<Posten> posten = new ArrayList<>();
        posten.add(ml == null ? ausVergleich(WENIGER_GEKAUFT)
                : ausMesslatte(WENIGER_GEKAUFT, ml.wenigerGekauftEur(), ml.wenigerGekauftKwh(), null));
        posten.add(ml == null ? ausVergleich(MEHR_GELADEN)
                : ausMesslatte(MEHR_GELADEN, ml.mehrGeladenEur(), ml.mehrGeladenKwh(), null));
        posten.add(ml == null ? ausVergleich(INS_NETZ_VERKAUFT)
                : ausMesslatte(INS_NETZ_VERKAUFT, ml.insNetzVerkauftEur(), ml.insNetzVerkauftKwh(), null));
        BigDecimal menge20 = summe(teile, "(20)");
        BigDecimal ust = preise == null ? null : preise.ustPct();
        posten.add(nurLadepunkt ? vermieden(VERMIEDENE_UMLAGEN, menge20, preise == null ? null : preise.umlagenCt(),
                ust, false) : offen(VERMIEDENE_UMLAGEN, menge20, "(20)", SPEICHER_UND_LADEPUNKT, false));
        posten.add(nurLadepunkt ? vermieden(VERMIEDENES_NETZENTGELT, menge20,
                preise == null ? null : preise.netzentgeltCt(), ust, true)
                : offen(VERMIEDENES_NETZENTGELT, menge20, "(20)", SPEICHER_UND_LADEPUNKT, true));
        posten.add(ml == null ? ausVergleich(AKKU_VERSCHLEISS)
                : ausMesslatte(AKKU_VERSCHLEISS, ml.akkuVerschleissEur(), ml.rueckgespeistKwh(), null));
        posten.add(praemie(summe(teile, "(31)"), nurLadepunkt, mw));
        return new Monat(anlage, monat, ladepunkte, List.copyOf(teile), List.copyOf(posten), vergleich(posten), ust);
    }

    /**
     * „Gegenüber nur laden“: die Summe der gerundeten Posten ohne Marktprämie (A1 S. 39: erst mit dem
     * Jahresmarktwert) — nur, wenn jeder dieser sechs Posten bestimmt ist. Ein Minus steht so nie allein.
     */
    static Vergleich vergleich(List<Posten> posten) {
        BigDecimal summe = BigDecimal.ZERO;
        for (Posten p : posten) {
            if (MARKTPRAEMIE.equals(p.schluessel())) {
                continue;
            }
            if (!MispelMengen.BESTIMMT.equals(p.stand()) || p.eur() == null) {
                return new Vergleich(MispelMengen.OFFEN, p.grund() == null ? MESSLATTE_FEHLT : p.grund(), null);
            }
            summe = summe.add(p.eur());
        }
        return new Vergleich(MispelMengen.BESTIMMT, null, summe);
    }

    private static Posten ausVergleich(String schluessel) {
        return new Posten(schluessel, MispelMengen.OFFEN, null, null, null, null, MESSLATTE_FEHLT, false);
    }

    /**
     * Ein Posten aus der Messlatte: EUR auf Cent, die kWh dazu und als Satz das Mittel in ct/kWh (EUR ÷ kWh, ohne
     * Vorzeichen) — beim Verschleiß also die 3 ct je zurückgegebener kWh; ohne Menge kein Satz.
     */
    private static Posten ausMesslatte(String schluessel, BigDecimal eur, BigDecimal kwh, String formel) {
        BigDecimal satz = kwh == null || kwh.signum() == 0 ? null
                : eur.multiply(HUNDERT).divide(kwh, 1, RoundingMode.HALF_UP).abs();
        return new Posten(schluessel, MispelMengen.BESTIMMT, eur.setScale(2, RoundingMode.HALF_UP),
                kwh == null ? null : kwh.setScale(1, RoundingMode.HALF_UP), formel, satz, null, false);
    }

    private static Posten offen(String schluessel, BigDecimal menge, String formel, String grund, boolean vorbehalt) {
        return new Posten(schluessel, MispelMengen.OFFEN, null, menge, formel, null, grund, vorbehalt);
    }

    /** (20) × Satz × (1 + USt) wie die MiSpeL-Karte (MP-18); ohne Preisblatt offen. */
    private static Posten vermieden(String schluessel, BigDecimal menge, BigDecimal satzCt, BigDecimal ust,
            boolean vorbehalt) {
        if (menge == null) {
            return offen(schluessel, null, "(20)", "menge_offen", vorbehalt);
        }
        if (satzCt == null || ust == null) {
            return offen(schluessel, menge, "(20)", "preisblatt_fehlt", vorbehalt);
        }
        BigDecimal eur = menge.multiply(satzCt).multiply(HUNDERT.add(ust))
                .divide(HUNDERT.multiply(HUNDERT), 2, RoundingMode.HALF_UP);
        return new Posten(schluessel, MispelMengen.BESTIMMT, eur, menge, "(20)", satzCt, null, vorbehalt);
    }

    /** Marktprämie auf (31) mit dem Jahresmarktwert — erst nach Jahresende bestimmt. */
    private static Posten praemie(BigDecimal menge31, boolean nurLadepunkt, MispelMengen.Marktwert mw) {
        if (!nurLadepunkt) {
            return offen(MARKTPRAEMIE, menge31, "(31)", SPEICHER_UND_LADEPUNKT, false);
        }
        if (menge31 == null) {
            return offen(MARKTPRAEMIE, null, "(31)", "menge_offen", false);
        }
        if (mw == null || mw.awCt() == null) {
            return offen(MARKTPRAEMIE, menge31, "(31)", "anzulegender_wert_fehlt", false);
        }
        if (mw.jahresmarktwertCt() == null || mw.jahresmarktwertVorlaeufig()) {
            return offen(MARKTPRAEMIE, menge31, "(31)", "jahresmarktwert_offen", false);
        }
        BigDecimal satz = mw.awCt().subtract(mw.jahresmarktwertCt()).max(BigDecimal.ZERO);
        return new Posten(MARKTPRAEMIE, MispelMengen.BESTIMMT,
                menge31.multiply(satz).divide(HUNDERT, 2, RoundingMode.HALF_UP), menge31, "(31)", satz, null, false);
    }

    /** Die Summe einer Menge über die Teile; {@code null}, sobald ein Teil sie nicht hat (unbekannt ≠ 0). */
    private static BigDecimal summe(List<Teil> teile, String nr) {
        BigDecimal s = BigDecimal.ZERO;
        for (Teil t : teile) {
            BigDecimal kwh = t.mengen().stream().filter(m -> m.nr().startsWith(nr)).map(Menge::kwh).findFirst()
                    .orElse(null);
            if (kwh == null) {
                return null;
            }
            s = s.add(kwh);
        }
        return s;
    }

    /** Der Schlüssel in {@code monatswerte}: genau {@code nr} oder seine Fassung („(14)A2,A3,A4“). */
    private static String schluessel(JsonNode werte, String nr) {
        if (werte.has(nr)) {
            return nr;
        }
        var it = werte.fieldNames();
        while (it.hasNext()) {
            String k = it.next();
            if (k.startsWith(nr)) {
                return k;
            }
        }
        return null;
    }
}
