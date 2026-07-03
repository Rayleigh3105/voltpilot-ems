package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.PriceBucketDto;
import com.voltpilot.api.web.dto.PricePointDto;
import com.voltpilot.api.web.dto.PriceRangeSummaryDto;
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

    /**
     * Aggregated price buckets over {@code [from, to)} for a zone, one row per
     * {@code time_bucket(bucketInterval, ts)} with avg/min/max of the slots in
     * it. Aggregation happens in SQL so a full year returns ~365 daily rows, not
     * ~35k slots. {@code berlinDaily} anchors daily buckets to Europe/Berlin
     * calendar days (used for month/year); finer buckets use plain UTC-aligned
     * boundaries (the slots themselves sit on those boundaries).
     */
    public List<PriceBucketDto> aggregate(
            String biddingZone, Instant from, Instant to, String bucketInterval, boolean berlinDaily) {
        String bucketExpr = berlinDaily
                ? "time_bucket(?::interval, ts, 'Europe/Berlin')"
                : "time_bucket(?::interval, ts)";
        return jdbc.query(
                "SELECT " + bucketExpr + " AS bucket, "
                        + "avg(price_eur_mwh) AS avg_p, "
                        + "min(price_eur_mwh) AS min_p, "
                        + "max(price_eur_mwh) AS max_p "
                        + "FROM day_ahead_prices "
                        + "WHERE bidding_zone = ? AND ts >= ? AND ts < ? "
                        + "GROUP BY 1 ORDER BY 1",
                (rs, i) -> new PriceBucketDto(
                        rs.getTimestamp("bucket").toInstant(),
                        rs.getBigDecimal("avg_p"),
                        rs.getBigDecimal("min_p"),
                        rs.getBigDecimal("max_p")),
                bucketInterval, biddingZone, Timestamp.from(from), Timestamp.from(to));
    }

    /**
     * Headline stats over the raw slots in {@code [from, to)}: avg/min/max, the
     * slot count, actual data coverage, and the timestamps of the cheapest and
     * most expensive slot (for the "günstigste/teuerste Stunde" cards). All in
     * SQL, all indexed on {@code (bidding_zone, ts)}.
     */
    public PriceRangeSummaryDto summarize(String biddingZone, Instant from, Instant to) {
        PriceRangeSummaryDto base = jdbc.query(
                "SELECT avg(price_eur_mwh) AS avg_p, min(price_eur_mwh) AS min_p, "
                        + "max(price_eur_mwh) AS max_p, count(*) AS n, "
                        + "min(ts) AS cov_start, max(ts) AS cov_end "
                        + "FROM day_ahead_prices "
                        + "WHERE bidding_zone = ? AND ts >= ? AND ts < ?",
                rs -> {
                    if (!rs.next() || rs.getInt("n") == 0) {
                        return PriceRangeSummaryDto.empty();
                    }
                    return new PriceRangeSummaryDto(
                            rs.getBigDecimal("avg_p"),
                            rs.getBigDecimal("min_p"),
                            rs.getBigDecimal("max_p"),
                            null,
                            null,
                            rs.getInt("n"),
                            toInstant(rs.getTimestamp("cov_start")),
                            toInstant(rs.getTimestamp("cov_end")));
                },
                biddingZone, Timestamp.from(from), Timestamp.from(to));
        if (base == null || base.count() == 0) {
            return PriceRangeSummaryDto.empty();
        }
        Instant cheapest = extremeSlot(biddingZone, from, to, true);
        Instant priciest = extremeSlot(biddingZone, from, to, false);
        return new PriceRangeSummaryDto(
                base.avgEurMwh(), base.minEurMwh(), base.maxEurMwh(),
                cheapest, priciest, base.count(), base.coverageStart(), base.coverageEnd());
    }

    /** Timestamp of the cheapest (or most expensive) slot in the window, or null. */
    private Instant extremeSlot(String biddingZone, Instant from, Instant to, boolean cheapest) {
        String order = cheapest ? "ASC" : "DESC";
        List<Instant> ts = jdbc.query(
                "SELECT ts FROM day_ahead_prices "
                        + "WHERE bidding_zone = ? AND ts >= ? AND ts < ? "
                        + "ORDER BY price_eur_mwh " + order + ", ts ASC LIMIT 1",
                (rs, i) -> rs.getTimestamp("ts").toInstant(),
                biddingZone, Timestamp.from(from), Timestamp.from(to));
        return ts.isEmpty() ? null : ts.get(0);
    }

    private static Instant toInstant(Timestamp t) {
        return t == null ? null : t.toInstant();
    }
}
