package com.voltpilot.api.ueberwachung;

import com.voltpilot.api.repo.EarningsRepository;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Der {@code geld}-Leser (Alerting Scheibe 4, Konzept §6.3): Erlöse und Netzkosten je Periode -
 * DIESELBEN Tarif-/Vergütungsgrundlagen wie die Erlöse-Fläche (Hausregel "Optimierung und
 * Erlösanzeige nutzen dieselben Tarif-/Vergütungsgrundlagen - die Überwachung auch"), weil beide
 * aus {@link EarningsRepository#aggregateForSite} lesen - keine zweite Geldwahrheit.
 */
@Component
public class GeldWerteLeser implements WerteLeser {

    static final String FELD_ERLOES = "erloes";
    static final String FELD_KOSTEN = "kosten";

    private final EarningsRepository earnings;
    private final JdbcTemplate jdbc;

    public GeldWerteLeser(EarningsRepository earnings, JdbcTemplate jdbc) {
        this.earnings = earnings;
        this.jdbc = jdbc;
    }

    @Override
    public Lesung lese(WerteKatalog.Eintrag eintrag, Bezug bezug, Instant jetzt) {
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
            return Lesung.unbekannt();
        }
        return geldWert(eintrag.leser().feld(), bezug.id(), fenster, jetzt);
    }

    @Override
    public Lesung leseVorperiode(WerteKatalog.Eintrag eintrag, Bezug bezug, String periode, Instant jetzt) {
        if (!"anlage".equals(bezug.art())) {
            return Lesung.unbekannt();
        }
        PeriodenFenster.Fenster vorige = PeriodenFenster.vorige(periode, jetzt, abrechnungLeistung(bezug.id()));
        return geldWert(eintrag.leser().feld(), bezug.id(), vorige, jetzt);
    }

    private Lesung geldWert(String feld, UUID anlageId, PeriodenFenster.Fenster fenster, Instant jetzt) {
        EarningsRepository.SiteAggregate agg = earnings.aggregateForSite(anlageId, fenster.von(), fenster.bis());
        if (agg == null || agg.bucketCount() == 0) {
            return Lesung.unbekannt();
        }
        BigDecimal wert = switch (feld) {
            case FELD_KOSTEN -> agg.stromkostenEur();
            case FELD_ERLOES -> nullSafeAdd(agg.einspeiseErloesEur(), agg.eigenverbrauchsWertEur());
            default -> throw new IllegalArgumentException("GeldWerteLeser: unbekanntes Feld '" + feld + "'");
        };
        return wert == null ? Lesung.unbekannt() : Lesung.zahl(wert.doubleValue(), "EUR", jetzt);
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
