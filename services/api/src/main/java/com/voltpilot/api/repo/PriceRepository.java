package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.PricePointDto;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Day-ahead spot prices for a bidding zone. These are PUBLIC market data (one
 * series per zone, not per tenant), so there is no RLS and no tenant predicate -
 * the app role has a plain SELECT grant. Written by services/market-data
 * (energy-charts / ENTSO-E); the api only reads.
 */
@Repository
public class PriceRepository {

    private final JdbcTemplate jdbc;

    public PriceRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** The resolution of the most recent slot for a zone (e.g. {@code PT15M}), or null. */
    public String latestResolution(String biddingZone) {
        List<String> res = jdbc.query(
                "SELECT resolution FROM day_ahead_prices WHERE bidding_zone = ? "
                        + "ORDER BY ts DESC LIMIT 1",
                (rs, i) -> rs.getString("resolution"), biddingZone);
        return res.isEmpty() ? null : res.get(0);
    }

    /** The currency for a zone's latest slot (defaults to EUR when nothing stored). */
    public String currencyFor(String biddingZone) {
        List<String> cur = jdbc.query(
                "SELECT currency FROM day_ahead_prices WHERE bidding_zone = ? "
                        + "ORDER BY ts DESC LIMIT 1",
                (rs, i) -> rs.getString("currency"), biddingZone);
        return cur.isEmpty() ? "EUR" : cur.get(0);
    }

    /**
     * Price slots for a zone over {@code [from, to]}, ascending. Slot end is
     * derived from the resolution so a 15-min bar's width is explicit downstream.
     */
    public List<PricePointDto> findForZone(String biddingZone, Instant from, Instant to, int limit) {
        return jdbc.query(
                "SELECT ts, resolution, price_eur_mwh FROM day_ahead_prices "
                        + "WHERE bidding_zone = ? AND ts >= ? AND ts <= ? "
                        + "ORDER BY ts ASC LIMIT ?",
                (rs, i) -> {
                    Instant start = rs.getTimestamp("ts").toInstant();
                    Instant end = start.plusSeconds(resolutionSeconds(rs.getString("resolution")));
                    return new PricePointDto(start, end, rs.getBigDecimal("price_eur_mwh"));
                },
                biddingZone, Timestamp.from(from), Timestamp.from(to), limit);
    }

    private static long resolutionSeconds(String resolution) {
        return "PT60M".equals(resolution) ? 3600L : 900L; // default quarter-hour
    }
}
