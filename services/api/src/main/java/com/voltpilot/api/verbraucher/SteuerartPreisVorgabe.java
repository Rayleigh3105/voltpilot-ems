package com.voltpilot.api.verbraucher;

import com.voltpilot.api.optimizer.OptimizerProperties;
import com.voltpilot.api.optimizer.SlotEconomics;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Die VORGABE der Preisgrenze fuer die Quelle „Guenstige Stunden"
 * (Captain-Entscheid <b>E7</b>: „Preisgrenze in ct mit Vorgabe aus den letzten
 * 7 Tagen").
 *
 * <p><b>⚠ Es ist der BEZUGSPREIS, nicht der Boersenpreis.</b> Die Bedingung der
 * Steuerart lautet {@code market.import_price_ct_kwh < X}; eine Vorgabe aus dem
 * nackten Spot laege systematisch zu tief und der Kunde bekaeme eine Regel, die
 * nie greift. Gerechnet wird deshalb mit der EINEN Kompositions-Wahrheit
 * {@link SlotEconomics#importPriceCtSql} - demselben Ausdruck, mit dem der
 * Optimierer plant und die Erloese bewerten.
 *
 * <p><b>⚠ Ohne belastbare Preise gibt es KEINE Vorgabe</b> ({@code null}): das
 * Feld startet dann leer und der Kunde traegt seine Grenze selbst ein. Eine
 * erfundene Zahl waere hier besonders teuer - sie entschiede, wann sein Geraet
 * laeuft.
 *
 * <p>Das Quantil ist {@link #QUANTIL}: „guenstig" heisst das billigste Viertel
 * des Tages. Ein Median waere die Haelfte und damit kein Sparen; ein sehr
 * niedriges Quantil ergaebe Fenster, die es an einem flachen Tag nie gibt.
 */
@Component
public class SteuerartPreisVorgabe {

    private static final Logger log = LoggerFactory.getLogger(SteuerartPreisVorgabe.class);

    /** Das billigste Viertel - die Vorgabe, die der Kunde dann verschiebt. */
    public static final double QUANTIL = 0.25;
    /** Das Rueckschau-Fenster (E7). */
    public static final Duration RUECKSCHAU = Duration.ofDays(7);

    private final JdbcTemplate jdbc;
    /** Der Bezugspreis-Ausdruck, EINMAL gebaut - das EarningsRepository-Muster. */
    private final String importPriceCt;

    public SteuerartPreisVorgabe(JdbcTemplate jdbc, OptimizerProperties optimizer) {
        this.jdbc = jdbc;
        this.importPriceCt = SlotEconomics.importPriceCtSql("p.price_eur_mwh",
                optimizer.defaultSupplyComponents());
    }

    /**
     * Die Preisgrenze, unter der die letzten sieben Tage im billigsten Viertel
     * lagen - auf 0,5 ct gerundet, damit sie wie eine gewaehlte Zahl aussieht.
     * {@code null}, wenn diese Anlage keine Zone, keinen Preis oder keinen
     * dynamischen Tarif hat.
     *
     * <p>Die Aufloesungen werden NICHT gemischt: liegen Viertelstunden-Preise
     * im Fenster, zaehlen nur sie - sonst waeren Stunden, die in beiden Formen
     * vorliegen, doppelt gewichtet.
     */
    public BigDecimal fuerAnlage(UUID siteId, Instant jetzt) {
        Instant von = jetzt.minus(RUECKSCHAU);
        try {
            BigDecimal q = jdbc.queryForObject(
                    "SELECT percentile_cont(?) WITHIN GROUP (ORDER BY " + importPriceCt + ") "
                            + "FROM site s "
                            + "LEFT JOIN site_supply_price ssp ON ssp.site_id = s.id "
                            + "JOIN day_ahead_prices p ON p.bidding_zone = s.bidding_zone "
                            + "WHERE s.id = ? AND p.ts >= ? AND p.ts < ? "
                            + "AND p.resolution = (CASE WHEN EXISTS ("
                            + "  SELECT 1 FROM day_ahead_prices q WHERE q.bidding_zone = s.bidding_zone "
                            + "  AND q.resolution = 'PT15M' AND q.ts >= ? AND q.ts < ?"
                            + ") THEN 'PT15M' ELSE 'PT60M' END)",
                    BigDecimal.class, QUANTIL, siteId, java.sql.Timestamp.from(von),
                    java.sql.Timestamp.from(jetzt), java.sql.Timestamp.from(von),
                    java.sql.Timestamp.from(jetzt));
            return runden(q);
        } catch (RuntimeException e) {
            // Eine fehlende Vorgabe ist ein leeres Feld, nie ein Fehler auf der
            // Steuerungsseite - dieselbe Fail-soft-Haltung wie jede andere
            // Zusatzquelle dieses Aggregats.
            log.warn("Preis-Vorgabe der Anlage {} nicht berechenbar: {}", siteId, e.toString());
            return null;
        }
    }

    /** Auf 0,5 ct kaufmaennisch, nie unter 0 - und {@code null} bleibt {@code null}. */
    static BigDecimal runden(BigDecimal ct) {
        if (ct == null) {
            return null;
        }
        BigDecimal halbe = ct.multiply(BigDecimal.valueOf(2))
                .setScale(0, RoundingMode.HALF_UP)
                .divide(BigDecimal.valueOf(2), 1, RoundingMode.HALF_UP);
        return halbe.signum() < 0 ? BigDecimal.ZERO.setScale(1) : halbe;
    }
}
