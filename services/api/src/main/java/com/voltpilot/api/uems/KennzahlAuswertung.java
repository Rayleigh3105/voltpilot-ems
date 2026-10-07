package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.BezugsbasisVergleichDto;
import com.voltpilot.api.web.dto.EnergiezielDto;
import com.voltpilot.api.web.dto.KennzahlDto;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Wie eine Kennzahl steht (Konzept Auswerten a1 §6.4, §10.8) - REIN, ohne Datenbank: die Liste „Kennzahlen“ und die
 * Leitkachel der Übersicht lesen dasselbe Urteil aus derselben Ableitung. Gerechnet wird auch hier nichts Neues: das
 * Urteil und die Abweichungen je Monat sind die Zeilen des Bezugsbasis-Lesers (Operation {@code vergleich}), die
 * Veränderung zum Vorjahr ist die Operation {@code roh} der Zwillinge (ohne Urteil, VG3), der Stand des Energieziels die
 * Summe seines Lesers (Z3). Diese Klasse wählt nur aus und ordnet.
 */
final class KennzahlAuswertung {

    /** Zwölf Monate: so weit reichen Abweichungsgrafik und Verlauf der Karte. */
    static final int MONATE = 12;
    /** Mit dem Vorjahr des ältesten der zwölf Monate: so weit liest der Dienst die Monatswerte. */
    static final int MONATE_GELESEN = 2 * MONATE;

    private static final String BASIS_FEHLT = "basis_fehlt";

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
     * @param ziel der Stand des offenen Energieziels; {@code null} ohne
     */
    static KennzahlDto.Auswertung auswertung(YearMonth bis, Map<String, KennzahlDto.Wert> jeMonat,
            BezugsbasisVergleichDto.Vergleich vergleich, LocalDate ersteGeltung, EnergiezielDto.Stand ziel) {
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
        for (YearMonth m = bis.minusMonths(MONATE - 1); !m.isAfter(bis); m = m.plusMonths(1)) {
            String wert = wertVon(jeMonat.get(m.toString()));
            BezugsbasisVergleichDto.Bereinigt b = bereinigt.get(m.toString());
            monate.add(new KennzahlDto.AuswertungMonat(m.toString(), wert, b == null ? null : b.deltaProzent(),
                    b == null ? null : b.urteil(), b == null ? null : b.grund()));
            if (wert != null) {
                juengster = jeMonat.get(m.toString());
                juengsterMonat = m;
            }
        }
        KennzahlDto.AuswertungWert wert = juengster == null ? null
                : new KennzahlDto.AuswertungWert(juengsterMonat.toString(), juengster.wert(), juengster.einheit(),
                        juengster.zustand(), juengster.richtung());
        return new KennzahlDto.Auswertung(bis.toString(), wert, vorjahr(juengster, juengsterMonat, jeMonat),
                List.copyOf(monate), urteil(bis, bereinigt.get(bis.toString()), saetze.get(bis.toString()), vergleich,
                        ersteGeltung),
                ziel(ziel));
    }

    /** Die rohe Veränderung des jüngsten Werts gegen denselben Monat ein Jahr davor - ohne beide Werte {@code null}. */
    private static KennzahlDto.AuswertungVorjahr vorjahr(KennzahlDto.Wert juengster, YearMonth monat,
            Map<String, KennzahlDto.Wert> jeMonat) {
        if (juengster == null) {
            return null;
        }
        YearMonth vorjahr = monat.minusYears(1);
        String frueher = wertVon(jeMonat.get(vorjahr.toString()));
        Map<String, Object> roh = BezugsbasisRegeln.roh(juengster.wert(), frueher);
        if (roh.get("delta_prozent") == null) {
            return null;
        }
        return new KennzahlDto.AuswertungVorjahr(vorjahr.toString(), frueher, (String) roh.get("delta_prozent"),
                (String) roh.get("richtung"));
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
