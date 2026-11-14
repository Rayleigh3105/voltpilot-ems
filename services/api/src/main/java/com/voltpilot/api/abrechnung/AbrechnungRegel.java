package com.voltpilot.api.abrechnung;

import com.voltpilot.api.history.Zeitraum;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.TreeMap;

/**
 * Die Menge EINER Richtung (Netzbezug oder Einspeisung) in einem Abrechnungs-Zeitraum - Bedienkonzept
 * vp-privatkunde-bedienkonzept §7.4, Paket R2. Rein und rahmenfrei.
 *
 * <p><b>Mit Zähler</b> (Zählerstand am Netzanschluss): Menge = Stand am Ende des letzten Tages minus Stand am
 * Ende des Tages vor dem ersten - auch über Datenlücken hinweg, denn der Zähler zählt in der Lücke weiter.
 * Fehlt der Stand des Vortags, gilt der erste Stand des ersten Tages mit Lesung (der Kleinstwert dieses
 * Tages); fehlt der letzte Tag, der letzte Stand davor. Die Tage außerhalb sind „nicht erfasst".
 *
 * <p><b>Fällt der Zähler</b> irgendwo im Zeitraum (Tausch, Rücksetzen, Überlauf), gilt seine Differenz nicht:
 * ein Zähler, der von 950 auf 5 springt, lieferte sonst eine negative oder viel zu kleine Menge
 * ({@code GeraeteEnergie}-Hausregel). Dann gilt die Summe der Tageswerte, mit Ansage.
 *
 * <p><b>Ohne Zähler</b> die Summe der Tageswerte; Tage ohne Messwert sind Lücken und werden genannt, nie als
 * 0 mitgezählt.
 *
 * <p><b>Welche Herkunft</b>: der Zähler, wenn er mindestens so viele Tage des Zeitraums belegt wie die Summe
 * (so gewinnt eine Anlage, die erst später einen Zähler bekam, die vollständigere Summe), sonst die Summe.
 *
 * <p>Tage vor dem {@code messbeginn} der Anlage sind keine Lücke, sondern „noch nicht gemessen" - sie nennt
 * die Antwort einmal für den ganzen Zeitraum, nicht je Zeile.
 *
 * <p>Kein Urteil über den Zähler: die Regel liefert Mengen und woraus sie entstehen, nie „stimmt".
 */
public final class AbrechnungRegel {

    public static final String HERKUNFT_ZAEHLER = "zaehler";
    public static final String HERKUNFT_SUMME = "summe";

    /** Unter einer halben Wattstunde ist ein Rückgang Rundung, kein Fallen (wie {@code GeraeteEnergie}). */
    static final double TOLERANZ_KWH = 0.0005;

    private AbrechnungRegel() {
    }

    /** Die Zählerstände eines Tages: der erste ({@code min}) und der letzte ({@code last}) des Berliner Tages. */
    public record Stand(double min, double last) {
    }

    /** Eine zusammenhängende Spanne von Tagen, beide eingeschlossen. */
    public record Spanne(LocalDate von, LocalDate bis) {
        public long tage() {
            return ChronoUnit.DAYS.between(von, bis) + 1;
        }
    }

    /**
     * Das Ergebnis einer Richtung.
     *
     * @param mengeKwh    die Menge, {@code null} ohne jeden Messwert im Zeitraum
     * @param herkunft    {@link #HERKUNFT_ZAEHLER} oder {@link #HERKUNFT_SUMME}; {@code null} ohne Menge
     * @param standVon    Zählerstand am Beginn (nur Zähler)
     * @param standBis    Zählerstand am Ende (nur Zähler)
     * @param zaehlerFaellt ein Zähler war da, fiel aber im Zeitraum - darum die Summe
     * @param luecken     die Tage ab Messbeginn, die in der Menge fehlen, als Spannen
     */
    public record Ergebnis(BigDecimal mengeKwh, String herkunft, BigDecimal standVon, BigDecimal standBis,
            boolean zaehlerFaellt, List<Spanne> luecken) {

        /** Anzahl der fehlenden Tage. */
        public long fehlendeTage() {
            long n = 0;
            for (Spanne s : luecken) {
                n += s.tage();
            }
            return n;
        }
    }

    /**
     * @param z         der Zeitraum
     * @param staende   Zählerstände je Tag (darf den Vortag von {@code z.von()} enthalten); leer = kein Zähler
     * @param tageswerte Tagesmenge je Tag mit Messwert (fehlender Schlüssel = kein Messwert)
     * @param messbeginn erster gemessener Tag der Anlage, {@code null} = noch nie gemessen
     */
    public static Ergebnis berechne(Zeitraum z, Map<LocalDate, Stand> staende,
            Map<LocalDate, BigDecimal> tageswerte, LocalDate messbeginn) {
        LocalDate ab = messbeginn == null ? null : (messbeginn.isAfter(z.von()) ? messbeginn : z.von());
        Ergebnis summe = summe(z, tageswerte, ab);
        Zaehler zaehler = zaehler(z, staende);
        if (zaehler == null) {
            return summe;
        }
        if (zaehler.faellt) {
            return new Ergebnis(summe.mengeKwh(), summe.herkunft(), null, null, true, summe.luecken());
        }
        List<Spanne> zLuecken = new ArrayList<>();
        // Vor dem ersten Stand (aber ab Messbeginn) und nach dem letzten fehlt der Zähler.
        if (ab != null && zaehler.erfasstVon.isAfter(ab)) {
            zLuecken.add(new Spanne(ab, zaehler.erfasstVon.minusDays(1)));
        }
        if (zaehler.erfasstBis.isBefore(z.bis())) {
            zLuecken.add(new Spanne(zaehler.erfasstBis.plusDays(1), z.bis()));
        }
        long zTage = ChronoUnit.DAYS.between(zaehler.erfasstVon, zaehler.erfasstBis) + 1;
        long sTage = summe.mengeKwh() == null ? 0 : belegteTage(z, tageswerte);
        if (zTage < sTage) {
            return summe;
        }
        BigDecimal menge = rund(BigDecimal.valueOf(zaehler.bis - zaehler.von));
        return new Ergebnis(menge, HERKUNFT_ZAEHLER, rund(BigDecimal.valueOf(zaehler.von)),
                rund(BigDecimal.valueOf(zaehler.bis)), false, zLuecken);
    }

    private record Zaehler(double von, double bis, LocalDate erfasstVon, LocalDate erfasstBis, boolean faellt) {
    }

    private static Zaehler zaehler(Zeitraum z, Map<LocalDate, Stand> staende) {
        if (staende == null || staende.isEmpty()) {
            return null;
        }
        NavigableMap<LocalDate, Stand> s = new TreeMap<>(staende).subMap(z.von().minusDays(1), true, z.bis(), true);
        if (s.isEmpty()) {
            return null;
        }
        Double von = null;
        LocalDate erfasstVon = null;
        Stand vortag = s.get(z.von().minusDays(1));
        if (vortag != null) {
            von = vortag.last();
            erfasstVon = z.von();
        }
        NavigableMap<LocalDate, Stand> imZeitraum = s.subMap(z.von(), true, z.bis(), true);
        if (imZeitraum.isEmpty()) {
            return null; // nur der Vortag: keine Lesung im Zeitraum
        }
        if (von == null) {
            Map.Entry<LocalDate, Stand> erster = imZeitraum.firstEntry();
            von = erster.getValue().min();
            erfasstVon = erster.getKey();
        }
        Map.Entry<LocalDate, Stand> letzter = imZeitraum.lastEntry();
        double bis = letzter.getValue().last();

        boolean faellt = false;
        Double vorher = null;
        for (Stand st : s.values()) {
            if (st.last() < st.min() - TOLERANZ_KWH || (vorher != null && st.min() < vorher - TOLERANZ_KWH)) {
                faellt = true;
                break;
            }
            vorher = st.last();
        }
        if (bis < von - TOLERANZ_KWH) {
            faellt = true;
        }
        return new Zaehler(von, bis, erfasstVon, letzter.getKey(), faellt);
    }

    private static Ergebnis summe(Zeitraum z, Map<LocalDate, BigDecimal> tageswerte, LocalDate ab) {
        BigDecimal menge = null;
        for (Map.Entry<LocalDate, BigDecimal> e : tageswerte.entrySet()) {
            LocalDate d = e.getKey();
            if (e.getValue() != null && !d.isBefore(z.von()) && !d.isAfter(z.bis())) {
                menge = menge == null ? e.getValue() : menge.add(e.getValue());
            }
        }
        List<Spanne> luecken = new ArrayList<>();
        if (ab != null) {
            LocalDate offen = null;
            for (LocalDate d = ab; !d.isAfter(z.bis()); d = d.plusDays(1)) {
                boolean fehlt = tageswerte.get(d) == null;
                if (fehlt && offen == null) {
                    offen = d;
                } else if (!fehlt && offen != null) {
                    luecken.add(new Spanne(offen, d.minusDays(1)));
                    offen = null;
                }
            }
            if (offen != null) {
                luecken.add(new Spanne(offen, z.bis()));
            }
        }
        return new Ergebnis(menge == null ? null : rund(menge), menge == null ? null : HERKUNFT_SUMME,
                null, null, false, luecken);
    }

    private static long belegteTage(Zeitraum z, Map<LocalDate, BigDecimal> tageswerte) {
        long n = 0;
        for (Map.Entry<LocalDate, BigDecimal> e : tageswerte.entrySet()) {
            LocalDate d = e.getKey();
            if (e.getValue() != null && !d.isBefore(z.von()) && !d.isAfter(z.bis())) {
                n++;
            }
        }
        return n;
    }

    static BigDecimal rund(BigDecimal v) {
        return v == null ? null : v.setScale(3, RoundingMode.HALF_UP);
    }
}
