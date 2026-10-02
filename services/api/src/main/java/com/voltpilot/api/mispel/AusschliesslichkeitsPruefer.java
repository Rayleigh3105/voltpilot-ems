package com.voltpilot.api.mispel;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.YearMonth;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * MiSpeL MP-2 (W1 = D): misst das Ausmaß, in dem der Speicher einer Anlage Netzstrom aufnahm — die BNetzA-Lesart der
 * Ausschließlichkeitsoption (§ 19 Abs. 3a EEG): „kein Verbrauch im Stromspeicher …, während es gleichzeitig einen
 * Netzbezug gibt“ (Anlage 1 S. 11). Rein: ohne Spring, ohne DB, ohne Uhr.
 *
 * <p>Gerechnet wird mit den Formeln der Anlage 1, Nummer und Rechenweg wörtlich wie im Vertrag
 * {@code docs/contracts/v2/mispel-abgrenzung.md}: je Viertelstunde (1)¼ = MIN [ Z1NB¼ ; Z2V¼ ] (Speichervorrang,
 * § 21 Abs. 4 S. 3 EnFG, A1 S. 14–15, S. 33) und (2)¼ = MIN [ Z1NE¼ ; Z2E¼ ] (§ 21 Abs. 4 S. 4 EnFG, A1 S. 15–16,
 * S. 34); je Kalendermonat (3) bis (6), (9) = ∑M (1)¼, (10) = (5) – (9) und (11) = ∑M (2)¼ (A1 S. 34–35); das Jahr
 * summiert die Monate (A1 S. 14, Abschn. 2.1.4). Die Viertelstunden mit (1)¼ > 0 sind genau die, in denen der Speicher
 * Strom verbrauchte, während gleichzeitig (= in derselben Viertelstunde, A1 Abschn. 1 „Zeitgleichheit“) Netzbezug
 * bestand — ihre Zahl hängt nicht davon ab, ob der Speichervorrang auch für § 19 Abs. 3a EEG gilt; die Menge (9) ist die
 * Zuordnung nach Speichervorrang.
 *
 * <p>Eine Viertelstunde gehört zum Kalendermonat, in dem sie nach gesetzlicher Zeit beginnt (Regel {@code zeit} des
 * Vertrags). Eine Viertelstunde trägt Werte, wenn alle vier Zählerwerte da sind; fehlt einer oder die ganze
 * Viertelstunde, ist sie eine Lücke und geht in keine Summe ein — unbekannt ist keine Null. Die Festlegung kennt keine
 * Toleranz je Viertelstunde; die Staffel {@link #STAFFEL_KWH} zeigt nur, wie viel bei einer Schwelle übrig bliebe.
 */
public final class AusschliesslichkeitsPruefer {

    /** Gesetzliche Zeit (MEZ/MESZ) — Kalendermonat und Kalenderjahr der Festlegung. */
    public static final ZoneId GESETZLICHE_ZEIT = ZoneId.of("Europe/Berlin");

    /**
     * Schwellen je Viertelstunde in kWh für die offene Toleranzfrage. Keine davon steht in der Festlegung; die strenge
     * Lesart (Schwelle 0) ist (9) selbst.
     */
    public static final List<BigDecimal> STAFFEL_KWH =
            List.of(new BigDecimal("0.01"), new BigDecimal("0.1"), new BigDecimal("1"));

    private AusschliesslichkeitsPruefer() {}

    /**
     * Die vier Zählerwerte einer Viertelstunde in kWh (nie negativ; {@code null} = unbekannt): Netzbezug Z1NB¼ und
     * Netzeinspeisung Z1NE¼ am Netzanschluss, Verbrauch Z2V¼ (Laden) und Erzeugung Z2E¼ (Entladen) im Stromspeicher.
     */
    public record Viertelstunde(Instant beginn, BigDecimal z1nb, BigDecimal z1ne, BigDecimal z2v, BigDecimal z2e) {

        public Viertelstunde {
            for (BigDecimal w : new BigDecimal[] {z1nb, z1ne, z2v, z2e}) {
                if (w != null && w.signum() < 0) {
                    throw new IllegalArgumentException("Zählerwert negativ um " + beginn + ": " + w);
                }
            }
        }

        boolean mitWerten() {
            return z1nb != null && z1ne != null && z2v != null && z2e != null;
        }

        /** (1)¼ = MIN [ Z1NB¼ ; Z2V¼ ] (A1 S. 33). */
        public BigDecimal formel1() {
            return z1nb.min(z2v);
        }

        /** (2)¼ = MIN [ Z1NE¼ ; Z2E¼ ] (A1 S. 34). */
        public BigDecimal formel2() {
            return z1ne.min(z2e);
        }
    }

    /** Viertelstunden mit (1)¼ über der Schwelle und ihre Summe (1)¼. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Staffel(BigDecimal schwelleKwh, int viertelstunden, BigDecimal kwh) {}

    /**
     * Ein Kalendermonat (oder sein Teil bis zum Stand).
     *
     * @param viertelstundenSoll Viertelstunden des Monats nach gesetzlicher Zeit, die vor dem Stand begonnen haben
     * @param formeln (3), (4), (5), (6), (9), (10), (11) in kWh, Schlüssel = Formelnummer der Anlage 1
     * @param viertelstundenNetzstromImSpeicher Viertelstunden mit (1)¼ > 0
     * @param viertelstundenSpeicherEinspeisung Viertelstunden mit (2)¼ > 0
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Monat(YearMonth monat, int viertelstundenSoll, int viertelstundenMitWerten, int luecken,
            Map<String, BigDecimal> formeln, int viertelstundenNetzstromImSpeicher,
            int viertelstundenSpeicherEinspeisung, List<Staffel> toleranzStaffel) {}

    /**
     * Das Kalenderjahr: Summen der Monate, dieselben Schlüssel.
     *
     * @param netzstromImSpeicher strenge Lesart: irgendein Netzstrom im Speicher in diesem Jahr ((9) im Jahr > 0)
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Jahr(int jahr, int viertelstundenSoll, int viertelstundenMitWerten, int luecken,
            Map<String, BigDecimal> formeln, boolean netzstromImSpeicher, int viertelstundenNetzstromImSpeicher,
            int viertelstundenSpeicherEinspeisung, int monateMitNetzstromImSpeicher, List<Staffel> toleranzStaffel) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Ergebnis(Jahr jahr, List<Monat> monate) {}

    /**
     * Prüft ein Kalenderjahr bis zum Stand (ausschließlich). Viertelstunden außerhalb von [Jahresbeginn, min(Jahresende,
     * stand)) zählen nicht. Monate, die erst nach dem Stand beginnen, fehlen im Ergebnis. Jede Viertelstunde höchstens
     * einmal (die Verdichtung hat den Schlüssel Anlage + Beginn).
     */
    public static Ergebnis pruefe(int jahr, Iterable<Viertelstunde> viertelstunden, Instant stand) {
        Instant von = jahresbeginn(jahr);
        Instant bis = min(jahresbeginn(jahr + 1), stand);
        TreeMap<YearMonth, Summe> monate = new TreeMap<>();
        for (YearMonth m = YearMonth.of(jahr, 1); m.getYear() == jahr; m = m.plusMonths(1)) {
            Instant anfang = monatsbeginn(m);
            if (!anfang.isBefore(bis)) {
                break;
            }
            Instant ende = min(monatsbeginn(m.plusMonths(1)), bis);
            monate.put(m, new Summe((int) (Duration.between(anfang, ende).toMinutes() / 15)));
        }
        for (Viertelstunde v : viertelstunden) {
            if (v.beginn().isBefore(von) || !v.beginn().isBefore(bis) || !v.mitWerten()) {
                continue;
            }
            monate.get(YearMonth.from(v.beginn().atZone(GESETZLICHE_ZEIT))).add(v);
        }
        List<Monat> out = new ArrayList<>();
        Summe jahresSumme = new Summe(0);
        int monateMitNetzstrom = 0;
        for (Map.Entry<YearMonth, Summe> e : monate.entrySet()) {
            Summe s = e.getValue();
            out.add(new Monat(e.getKey(), s.soll, s.mitWerten, s.soll - s.mitWerten, s.formeln(), s.netzstromQh,
                    s.einspeisungQh, s.staffel()));
            jahresSumme.addMonat(s);
            if (s.f9.signum() > 0) {
                monateMitNetzstrom++;
            }
        }
        Jahr j = new Jahr(jahr, jahresSumme.soll, jahresSumme.mitWerten, jahresSumme.soll - jahresSumme.mitWerten,
                jahresSumme.formeln(), jahresSumme.f9.signum() > 0, jahresSumme.netzstromQh, jahresSumme.einspeisungQh, monateMitNetzstrom,
                jahresSumme.staffel());
        return new Ergebnis(j, out);
    }

    static Instant jahresbeginn(int jahr) {
        return monatsbeginn(YearMonth.of(jahr, 1));
    }

    static Instant monatsbeginn(YearMonth m) {
        return ZonedDateTime.of(m.getYear(), m.getMonthValue(), 1, 0, 0, 0, 0, GESETZLICHE_ZEIT).toInstant();
    }

    private static Instant min(Instant a, Instant b) {
        return a.isBefore(b) ? a : b;
    }

    /** Laufende Summen eines Monats oder Jahres. */
    private static final class Summe {
        int soll;
        int mitWerten;
        int netzstromQh;
        int einspeisungQh;
        BigDecimal f3 = BigDecimal.ZERO;
        BigDecimal f4 = BigDecimal.ZERO;
        BigDecimal f5 = BigDecimal.ZERO;
        BigDecimal f6 = BigDecimal.ZERO;
        BigDecimal f9 = BigDecimal.ZERO;
        BigDecimal f11 = BigDecimal.ZERO;
        final int[] staffelQh = new int[STAFFEL_KWH.size()];
        final BigDecimal[] staffelKwh = new BigDecimal[STAFFEL_KWH.size()];

        Summe(int soll) {
            this.soll = soll;
            Arrays.fill(staffelKwh, BigDecimal.ZERO);
        }

        void add(Viertelstunde v) {
            mitWerten++;
            BigDecimal eins = v.formel1();
            BigDecimal zwei = v.formel2();
            f3 = f3.add(v.z1nb());
            f4 = f4.add(v.z1ne());
            f5 = f5.add(v.z2v());
            f6 = f6.add(v.z2e());
            f9 = f9.add(eins);
            f11 = f11.add(zwei);
            if (eins.signum() > 0) {
                netzstromQh++;
            }
            if (zwei.signum() > 0) {
                einspeisungQh++;
            }
            for (int i = 0; i < STAFFEL_KWH.size(); i++) {
                if (eins.compareTo(STAFFEL_KWH.get(i)) > 0) {
                    staffelQh[i]++;
                    staffelKwh[i] = staffelKwh[i].add(eins);
                }
            }
        }

        void addMonat(Summe m) {
            soll += m.soll;
            mitWerten += m.mitWerten;
            netzstromQh += m.netzstromQh;
            einspeisungQh += m.einspeisungQh;
            f3 = f3.add(m.f3);
            f4 = f4.add(m.f4);
            f5 = f5.add(m.f5);
            f6 = f6.add(m.f6);
            f9 = f9.add(m.f9);
            f11 = f11.add(m.f11);
            for (int i = 0; i < STAFFEL_KWH.size(); i++) {
                staffelQh[i] += m.staffelQh[i];
                staffelKwh[i] = staffelKwh[i].add(m.staffelKwh[i]);
            }
        }

        Map<String, BigDecimal> formeln() {
            Map<String, BigDecimal> out = new LinkedHashMap<>();
            out.put("(3)", f3);
            out.put("(4)", f4);
            out.put("(5)", f5);
            out.put("(6)", f6);
            out.put("(9)", f9);
            // (10) = (5) – (9), A1 S. 34
            out.put("(10)", f5.subtract(f9));
            out.put("(11)", f11);
            return out;
        }

        List<Staffel> staffel() {
            List<Staffel> out = new ArrayList<>();
            for (int i = 0; i < STAFFEL_KWH.size(); i++) {
                out.add(new Staffel(STAFFEL_KWH.get(i), staffelQh[i], staffelKwh[i]));
            }
            return out;
        }
    }
}
