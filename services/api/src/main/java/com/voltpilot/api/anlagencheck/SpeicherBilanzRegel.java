package com.voltpilot.api.anlagencheck;

import java.time.LocalDate;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Die Speicher-Bilanz (Bedienkonzept vp-privatkunde-bedienkonzept §6.5, Captain BK-7 = A) - rein und rahmenfrei.
 *
 * <p><b>Ladestand-Ausgleich</b> (Befund 4 des Konzepts): steht der Speicher am Ende des Fensters voller als am Anfang,
 * steckt ein Teil der Ladung noch in ihm. Wirkungsgrad = (heraus + Ladestand-Unterschied × Kapazität) ÷ hinein; ohne
 * Ausgleich zeigte das Labor 84 % statt 90 %. Vollzyklen = heraus ÷ Kapazität. Verlust = hinein − heraus − Unterschied
 * im Speicher. Ohne Kapazität: Fenster 90 Tage (der Unterschied fällt dort kaum ins Gewicht), keine Vollzyklen.
 *
 * <p>Startwerte (nicht vom Captain entschieden): Bilanz ab {@link #MIN_VOLLZYKLEN} Vollzyklen im Fenster, ohne
 * Kapazität ab {@link #MIN_HERAUS_OHNE_KAPAZITAET_KWH} kWh heraus; ein Monat zählt für den Vergleich ab
 * {@link #MONAT_MIN_VOLLZYKLEN} Vollzyklen; der Vergleich braucht {@link #MIN_VERGLEICHSMONATE} Monate.
 */
public final class SpeicherBilanzRegel {

    public static final int FENSTER_TAGE = 30;
    public static final int FENSTER_OHNE_KAPAZITAET_TAGE = 90;
    public static final double MIN_VOLLZYKLEN = 5.0;
    public static final double MIN_HERAUS_OHNE_KAPAZITAET_KWH = 50.0;
    public static final double MONAT_MIN_VOLLZYKLEN = 3.0;
    public static final double MONAT_MIN_HERAUS_OHNE_KAPAZITAET_KWH = 15.0;
    public static final int MIN_VERGLEICHSMONATE = 3;
    /** Rundung der Anzeige: erst einen ganzen Punkt unter dem Band ist „niedriger". */
    public static final double TOLERANZ = 0.005;

    private SpeicherBilanzRegel() {
    }

    /** Ein Berliner Tag aus {@code telemetry_rollup_1d} (oder der v2-Rekonstruktion). */
    public record Tag(LocalDate tag, Double hineinKwh, Double herausKwh, Double ladestandEndePct) {}

    public enum Zustand { NORMAL, WENIG, OHNE_DATEN }

    public enum Satz { UNAUFFAELLIG, NIEDRIGER }

    public record Monat(YearMonth monat, double hineinKwh, double herausKwh, Double wirkungsgrad, Double vollzyklen) {}

    /**
     * @param ausgleichKwh der Ladestand-Unterschied in kWh (Ende − Anfang), {@code null} ohne Kapazität oder Ladestand
     * @param vergleichMin kleinster Monats-Wirkungsgrad der letzten 12 Monate, {@code null} unter
     *     {@link #MIN_VERGLEICHSMONATE}
     */
    public record Bilanz(Zustand zustand, LocalDate von, LocalDate bis, int fensterTage, int tageMitDaten,
            Double hineinKwh, Double herausKwh, Double ausgleichKwh, Double wirkungsgrad, Double verlustKwh,
            Double vollzyklen, Double vollzyklenSeitBeginn, Double kapazitaetKwh, Double vergleichMin,
            Double vergleichMax, int vergleichMonate, Satz satz, List<Monat> monate) {}

    /**
     * @param tage die Tage (jede Reihenfolge), mindestens das Fenster und der Tag davor, für den Vergleich 12 Monate
     * @param heute der Berliner Tag heute - das Fenster endet gestern
     * @param herausVorherKwh was der Speicher VOR dem ersten Tag von {@code tage} je abgegeben hat (seit Beginn)
     */
    public static Bilanz bilanz(List<Tag> tage, Double kapazitaetKwh, LocalDate heute, double herausVorherKwh) {
        Double kap = kapazitaetKwh != null && kapazitaetKwh > 0 ? kapazitaetKwh : null;
        int fenster = kap != null ? FENSTER_TAGE : FENSTER_OHNE_KAPAZITAET_TAGE;
        LocalDate bis = heute.minusDays(1);
        LocalDate von = bis.minusDays(fenster - 1L);
        Map<LocalDate, Tag> nachTag = new TreeMap<>();
        double herausAlle = herausVorherKwh;
        for (Tag t : tage) {
            nachTag.put(t.tag(), t);
            if (t.herausKwh() != null && t.tag().isBefore(heute)) {
                herausAlle += t.herausKwh();
            }
        }
        Summe s = summe(nachTag, von, bis, kap);
        List<Monat> monate = monate(nachTag, heute, kap);

        if (s.tageMitDaten == 0 || s.hinein <= 0) {
            return new Bilanz(Zustand.OHNE_DATEN, von, bis, fenster, s.tageMitDaten, null, null, null, null, null,
                    null, null, kap, null, null, 0, null, monate);
        }
        Double vollzyklen = kap != null ? s.heraus / kap : null;
        boolean wenig = kap != null ? vollzyklen < MIN_VOLLZYKLEN : s.heraus < MIN_HERAUS_OHNE_KAPAZITAET_KWH;
        double ausgleich = s.ausgleich != null ? s.ausgleich : 0;
        Double wirkungsgrad = (s.heraus + ausgleich) / s.hinein;
        Double verlust = s.hinein - s.heraus - ausgleich;
        Double seitBeginn = kap != null ? herausAlle / kap : null;

        List<Double> vergleich = monate.stream().map(Monat::wirkungsgrad).filter(w -> w != null).toList();
        Double min = vergleich.size() >= MIN_VERGLEICHSMONATE
                ? vergleich.stream().mapToDouble(Double::doubleValue).min().orElseThrow() : null;
        Double max = min != null ? vergleich.stream().mapToDouble(Double::doubleValue).max().orElseThrow() : null;
        Satz satz = null;
        if (!wenig && min != null) {
            satz = wirkungsgrad < min - TOLERANZ ? Satz.NIEDRIGER : Satz.UNAUFFAELLIG;
        }
        if (wenig) {
            return new Bilanz(Zustand.WENIG, von, bis, fenster, s.tageMitDaten, s.hinein, s.heraus, s.ausgleich,
                    null, null, vollzyklen, seitBeginn, kap, min, max, min != null ? vergleich.size() : 0, null,
                    monate);
        }
        return new Bilanz(Zustand.NORMAL, von, bis, fenster, s.tageMitDaten, s.hinein, s.heraus, s.ausgleich,
                wirkungsgrad, verlust, vollzyklen, seitBeginn, kap, min, max, min != null ? vergleich.size() : 0,
                satz, monate);
    }

    private static final class Summe {
        double hinein;
        double heraus;
        Double ausgleich;
        int tageMitDaten;
    }

    /** Summen über [von, bis] mit dem Ladestand am Ende des Vortags von {@code von} und am Ende von {@code bis}. */
    private static Summe summe(Map<LocalDate, Tag> nachTag, LocalDate von, LocalDate bis, Double kap) {
        Summe s = new Summe();
        for (LocalDate d = von; !d.isAfter(bis); d = d.plusDays(1)) {
            Tag t = nachTag.get(d);
            if (t == null || t.hineinKwh() == null || t.herausKwh() == null) {
                continue;
            }
            s.hinein += t.hineinKwh();
            s.heraus += t.herausKwh();
            s.tageMitDaten++;
        }
        Tag anfang = nachTag.get(von.minusDays(1));
        Tag ende = nachTag.get(bis);
        if (kap != null && anfang != null && ende != null && anfang.ladestandEndePct() != null
                && ende.ladestandEndePct() != null) {
            s.ausgleich = (ende.ladestandEndePct() - anfang.ladestandEndePct()) / 100.0 * kap;
        }
        return s;
    }

    /** Die letzten 12 vollen Monate vor dem laufenden, älteste zuerst; Monate ohne Daten fehlen. */
    static List<Monat> monate(Map<LocalDate, Tag> nachTag, LocalDate heute, Double kap) {
        List<Monat> out = new ArrayList<>();
        YearMonth laufend = YearMonth.from(heute);
        for (int i = 12; i >= 1; i--) {
            YearMonth m = laufend.minusMonths(i);
            Summe s = summe(nachTag, m.atDay(1), m.atEndOfMonth(), kap);
            if (s.tageMitDaten == 0 || s.hinein <= 0) {
                continue;
            }
            double ausgleich = s.ausgleich != null ? s.ausgleich : 0;
            Double vz = kap != null ? s.heraus / kap : null;
            boolean genug = kap != null ? vz >= MONAT_MIN_VOLLZYKLEN : s.heraus >= MONAT_MIN_HERAUS_OHNE_KAPAZITAET_KWH;
            boolean vollstaendig = s.tageMitDaten >= m.lengthOfMonth() - 2;
            Double wg = genug && vollstaendig ? (s.heraus + ausgleich) / s.hinein : null;
            out.add(new Monat(m, s.hinein, s.heraus, wg, vz));
        }
        return out;
    }
}
