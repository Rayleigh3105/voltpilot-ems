package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.BezugsbasisVergleichDto;
import com.voltpilot.api.web.dto.EnergiezielDto;
import com.voltpilot.api.web.dto.KennzahlDto;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Wie eine Kennzahl steht (Konzept Auswerten a1 §6.4, §6.5, §10.8) - REIN, ohne Datenbank: die Liste „Kennzahlen“, die
 * Seite einer Kennzahl und die Leitkachel der Übersicht lesen dasselbe Urteil aus derselben Ableitung. Das Urteil und die
 * Abweichungen je Monat sind die Zeilen des Bezugsbasis-Lesers (Operation {@code vergleich}), der Zeitraum dessen Operation
 * {@code zeitraum}, die Veränderungen zu Vorjahr und Vormonat die Operation {@code roh} der Zwillinge (ohne Urteil, VG3),
 * der Stand des Energieziels die Summe seines Lesers (Z3).
 *
 * <p>Selbst gerechnet werden nur die Mengen, die die Seite der Kennzahl zeigt, exakt und ungerundet aus derselben Zeile:
 * der erwartete Kennzahlwert (erwartet ÷ Nenner), die Abweichung in der Einheit des Zählers (gemessen − erwartet) und ihre
 * Summe über die Monate mit Urteil („Zusammengezählt“). Das Portal rundet sie nur zur Anzeige.
 */
final class KennzahlAuswertung {

    /** Zwölf Monate: so weit reichen Abweichungsgrafik und Verlauf der Karte. */
    static final int MONATE = 12;
    /** Mit dem Vorjahr des ältesten der zwölf Monate: so weit liest der Dienst die Monatswerte. */
    static final int MONATE_GELESEN = 2 * MONATE;

    private static final String BASIS_FEHLT = "basis_fehlt";
    /** Ein Monat zählt mit, wenn er ein Urteil trägt - wie im Stand eines Energieziels (verbesserung.md §2). */
    private static final Set<String> MIT_URTEIL = Set.of("besser", "schlechter", "im_rahmen");

    private KennzahlAuswertung() {}

    /** Der letzte abgeschlossene Monat am Tag {@code heute} - für ihn gilt das Urteil. */
    static YearMonth letzterMonat(LocalDate heute) {
        return YearMonth.from(heute).minusMonths(1);
    }

    /**
     * Die Auswertung bis zum Monat {@code bis}.
     *
     * @param jeMonat die Monatswerte der Kennzahl nach Schlüssel {@code JJJJ-MM}, mindestens {@code bis − 23} …
     *     {@code bis}; ein fehlender Schlüssel ist ein Monat ohne Wert
     * @param vergleich der Vergleich über {@code bis − 11} … {@code bis}; {@code null} ohne freigegebene Bezugsbasis
     * @param ersteGeltung der erste Tag einer freigegebenen Fassung - nur gebraucht, solange {@code bis} noch ohne Fassung
     *     ist
     * @param seitGeltung der Vergleich über die Monate der zwölf, für die schon eine Fassung gilt ({@code vergleich}
     *     selbst, wenn sie für alle zwölf gilt); {@code null} ohne
     * @param ziel der Stand des offenen Energieziels; {@code null} ohne
     */
    static KennzahlDto.Auswertung auswertung(YearMonth bis, Map<String, KennzahlDto.Wert> jeMonat,
            BezugsbasisVergleichDto.Vergleich vergleich, LocalDate ersteGeltung,
            BezugsbasisVergleichDto.Vergleich seitGeltung, EnergiezielDto.Stand ziel) {
        Map<String, BezugsbasisVergleichDto.Bereinigt> bereinigt = new HashMap<>();
        Map<String, String> saetze = new HashMap<>();
        if (vergleich != null) {
            for (BezugsbasisVergleichDto.Monat m : vergleich.monate()) {
                bereinigt.put(m.periode(), m.bereinigt());
                saetze.put(m.periode(), m.satz());
            }
        }
        List<KennzahlDto.AuswertungMonat> monate = new ArrayList<>();
        KennzahlDto.Wert juengster = null;
        YearMonth juengsterMonat = null;
        BigDecimal zusammen = null;
        for (YearMonth m = bis.minusMonths(MONATE - 1); !m.isAfter(bis); m = m.plusMonths(1)) {
            KennzahlDto.Wert w = jeMonat.get(m.toString());
            String wert = wertVon(w);
            BezugsbasisVergleichDto.Bereinigt b = bereinigt.get(m.toString());
            BigDecimal abweichung = abweichung(b);
            boolean zaehlt = abweichung != null && MIT_URTEIL.contains(b.urteil());
            if (zaehlt) {
                zusammen = zusammen == null ? abweichung : zusammen.add(abweichung);
            }
            monate.add(new KennzahlDto.AuswertungMonat(m.toString(), wert, b == null ? null : b.deltaProzent(),
                    b == null ? null : b.urteil(), b == null ? null : b.grund(), erwartetWert(b, w), text(abweichung),
                    zaehlt ? text(zusammen) : null, wert == null ? null : roh(w, m, m.minusYears(1), jeMonat)));
            if (wert != null) {
                juengster = w;
                juengsterMonat = m;
            }
        }
        KennzahlDto.AuswertungWert wert = juengster == null ? null
                : new KennzahlDto.AuswertungWert(juengsterMonat.toString(), juengster.wert(), juengster.einheit(),
                        juengster.zustand(), juengster.richtung());
        return new KennzahlDto.Auswertung(bis.toString(), wert, roh(juengster, juengsterMonat, juengsterMonat == null
                ? null : juengsterMonat.minusYears(1), jeMonat), roh(juengster, juengsterMonat, juengsterMonat == null
                ? null : juengsterMonat.minusMonths(1), jeMonat), List.copyOf(monate),
                urteil(bis, bereinigt.get(bis.toString()), saetze.get(bis.toString()), vergleich, ersteGeltung),
                zeitraum(seitGeltung), ziel(ziel));
    }

    /**
     * Die rohe Veränderung des Werts {@code juengster} (des Monats {@code monat}) gegen den Monat {@code frueher}
     * (Vorjahresmonat oder Vormonat) - ohne beide Werte, oder mit 0 davor, {@code null}.
     */
    private static KennzahlDto.AuswertungRoh roh(KennzahlDto.Wert juengster, YearMonth monat, YearMonth frueher,
            Map<String, KennzahlDto.Wert> jeMonat) {
        if (juengster == null || monat == null) {
            return null;
        }
        String davor = wertVon(jeMonat.get(frueher.toString()));
        Map<String, Object> roh = BezugsbasisRegeln.roh(juengster.wert(), davor);
        if (roh.get("delta_prozent") == null) {
            return null;
        }
        return new KennzahlDto.AuswertungRoh(frueher.toString(), davor, (String) roh.get("delta_prozent"),
                (String) roh.get("richtung"));
    }

    /** gemessen − erwartet in der Einheit des Zählers, exakt; {@code null} ohne beide. */
    private static BigDecimal abweichung(BezugsbasisVergleichDto.Bereinigt b) {
        if (b == null || b.erwartet() == null || b.gemessen() == null || b.gemessen().wert() == null) {
            return null;
        }
        return new BigDecimal(b.gemessen().wert()).subtract(new BigDecimal(b.erwartet()));
    }

    /**
     * Der erwartete Kennzahlwert: erwartet ÷ Nenner des Monats, gerundet wie der Kennzahlwert selbst (eine Bezugsbasis
     * gibt es nur an Quotient und Zusammenfassung, B2 - nie an einem Anteil). {@code null} ohne erwartet oder Nenner.
     */
    private static String erwartetWert(BezugsbasisVergleichDto.Bereinigt b, KennzahlDto.Wert w) {
        if (b == null || b.erwartet() == null || w == null || w.nenner() == null) {
            return null;
        }
        BigDecimal nenner = new BigDecimal(w.nenner());
        if (nenner.signum() == 0) {
            return null;
        }
        return text(new BigDecimal(b.erwartet()).divide(nenner, KennzahlRegeln.WERT_NACHKOMMASTELLEN,
                RoundingMode.HALF_UP));
    }

    private static KennzahlDto.AuswertungZeitraum zeitraum(BezugsbasisVergleichDto.Vergleich v) {
        if (v == null || v.zeitraum() == null) {
            return null;
        }
        BezugsbasisVergleichDto.Zeitraum z = v.zeitraum();
        return new KennzahlDto.AuswertungZeitraum(v.von(), v.bis(), z.deltaProzent(), z.bandProzent(), z.richtung(),
                z.urteil(), z.grund(), z.monate(), z.satz());
    }

    private static String text(BigDecimal d) {
        return d == null ? null : d.stripTrailingZeros().toPlainString();
    }

    /**
     * Das Urteil des Monats {@code bis}; solange für ihn noch keine Fassung gilt und eine erst später gilt, dazu der erste
     * Monat, für den sie am letzten Tag gilt (P4).
     */
    private static KennzahlDto.AuswertungVergleich urteil(YearMonth bis, BezugsbasisVergleichDto.Bereinigt b,
            String satz, BezugsbasisVergleichDto.Vergleich vergleich, LocalDate ersteGeltung) {
        if (vergleich == null || b == null) {
            return null;
        }
        String ersterMonat = BASIS_FEHLT.equals(b.grund()) && ersteGeltung != null
                && ersteGeltung.isAfter(bis.atEndOfMonth()) ? YearMonth.from(ersteGeltung).toString() : null;
        return new KennzahlDto.AuswertungVergleich(
                vergleich.bezugsbasis() == null ? null : vergleich.bezugsbasis().kennzeichen(), b.urteil(),
                b.deltaProzent(), b.bandProzent(), b.richtung(), b.grund(), satz, ersterMonat);
    }

    private static KennzahlDto.AuswertungZiel ziel(EnergiezielDto.Stand stand) {
        if (stand == null) {
            return null;
        }
        EnergiezielDto.Energieziel z = stand.energieziel();
        EnergiezielDto.Summe summe = stand.monateBewertbar() > 0 ? stand.summe() : null;
        return new KennzahlDto.AuswertungZiel(z.id(), z.kennzeichen(), stand.zielwertProzent(), stand.zielperiode(),
                summe == null ? null : summe.deltaProzent(), summe == null ? null : summe.richtung(),
                summe == null ? null : summe.urteil(), stand.monateBewertbar(), stand.monateSoll());
    }

    private static String wertVon(KennzahlDto.Wert w) {
        return w == null ? null : w.wert();
    }
}
