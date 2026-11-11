package com.voltpilot.api.ueberwachung;

import com.voltpilot.api.repo.EarningsRepository;
import com.voltpilot.api.repo.PeakShavingRepository;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Der {@code menge}-Leser (Alerting Scheibe 4, Konzept §6.3): Perioden-Mengen der Anlage - Verbrauch
 * (kWh, aus {@link EarningsRepository#aggregateForSite}, DIESELBE Summe wie die Erlöse-Fläche) und
 * Lastspitze im Abrechnungszeitraum (kW, aus {@link PeakShavingRepository}, dieselbe Zahl wie
 * {@code LastspitzenSection}). NIE im Minutentakt (§6.7 "wenn ihr Läufer neue Werte geschrieben
 * hat, sonst einmal täglich") - {@link UeberwachungsService} ruft diesen Leser nur gedrosselt auf
 * (siehe {@link UeberwachungsService#PERIODISCH_MINDESTABSTAND}).
 */
@Component
public class MengeWerteLeser implements WerteLeser {

    static final String FELD_VERBRAUCH_KWH = "verbrauch_kwh";
    static final String FELD_LASTSPITZE_PERIODE = "lastspitze_periode";

    private final EarningsRepository earnings;
    private final PeakShavingRepository peakShaving;
    private final JdbcTemplate jdbc;

    public MengeWerteLeser(EarningsRepository earnings, PeakShavingRepository peakShaving, JdbcTemplate jdbc) {
        this.earnings = earnings;
        this.peakShaving = peakShaving;
        this.jdbc = jdbc;
    }

    @Override
    public Lesung lese(WerteKatalog.Eintrag eintrag, Bezug bezug, Instant jetzt) {
        // Ohne Periode (direkter Aufruf, etwa ein Probelauf-Zeitpunkt ohne Bedingung) - Vorgabe "tag".
        return lesePeriode(eintrag, bezug, "tag", false, jetzt);
    }

    @Override
    public Lesung lesePeriode(WerteKatalog.Eintrag eintrag, Bezug bezug, String periode, boolean nurEndgueltig,
            Instant jetzt) {
        if (!"anlage".equals(bezug.art())) {
            return Lesung.unbekannt();
        }
        PeriodenFenster.Fenster fenster = PeriodenFenster.aktuelle(periode, jetzt, abrechnungLeistung(bezug.id()));
        if (nurEndgueltig && !fenster.abgeschlossen(jetzt)) {
            return Lesung.unbekannt(); // §6.3 "vorläufig oder erst endgültig"
        }
        String feld = eintrag.leser().feld();
        return switch (feld) {
            case FELD_VERBRAUCH_KWH -> verbrauch(bezug.id(), fenster, jetzt);
            case FELD_LASTSPITZE_PERIODE -> lastspitzePeriode(bezug.id(), jetzt);
            default -> throw new IllegalArgumentException("MengeWerteLeser: unbekanntes Feld '" + feld + "'");
        };
    }

    @Override
    public Lesung leseVorperiode(WerteKatalog.Eintrag eintrag, Bezug bezug, String periode, Instant jetzt) {
        if (!"anlage".equals(bezug.art()) || !FELD_VERBRAUCH_KWH.equals(eintrag.leser().feld())) {
            return Lesung.unbekannt();
        }
        PeriodenFenster.Fenster vorige = PeriodenFenster.vorige(periode, jetzt, abrechnungLeistung(bezug.id()));
        return verbrauch(bezug.id(), vorige, jetzt);
    }

    /** Verbrauch = Eigenverbrauch + Netzbezug (dieselbe Summe wie {@code consumptionKwh} der Historie). */
    private Lesung verbrauch(UUID anlageId, PeriodenFenster.Fenster fenster, Instant jetzt) {
        EarningsRepository.SiteAggregate agg = earnings.aggregateForSite(anlageId, fenster.von(), fenster.bis());
        if (agg == null || agg.bucketCount() == 0) {
            return Lesung.unbekannt();
        }
        BigDecimal verbrauch = nullSafeAdd(agg.selbstverbrauchKwh(), agg.bezogenKwh());
        if (verbrauch == null) {
            return Lesung.unbekannt();
        }
        return Lesung.zahl(verbrauch.doubleValue(), "kWh", jetzt);
    }

    /** Die bisher höchste gemessene Spitze der LAUFENDEN Abrechnungsperiode - dieselbe Zahl wie
     * {@code LastspitzenSection} (kein separates "vereinbarte Leistung"-Feld im Datenmodell, §6.10 Punkt 3). */
    private Lesung lastspitzePeriode(UUID anlageId, Instant jetzt) {
        LocalDate heute = jetzt.atZone(com.voltpilot.api.history.HistoryRange.ZONE).toLocalDate();
        BigDecimal spitze = peakShaving.laufendePeriodenSpitzeKw(anlageId, heute);
        return spitze == null ? Lesung.unbekannt() : Lesung.zahl(spitze.doubleValue(), "kW", jetzt);
    }

    private static BigDecimal nullSafeAdd(BigDecimal a, BigDecimal b) {
        if (a == null && b == null) {
            return null;
        }
        return (a == null ? BigDecimal.ZERO : a).add(b == null ? BigDecimal.ZERO : b);
    }

    String abrechnungLeistung(UUID anlageId) {
        List<String> rows = jdbc.query("SELECT abrechnung_leistung FROM site WHERE id = ?",
                (rs, n) -> rs.getString(1), anlageId);
        return rows.isEmpty() ? "jahr" : rows.get(0);
    }
}
