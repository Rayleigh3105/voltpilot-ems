package com.voltpilot.api.repo;

/**
 * The day-ahead price series MATERIALIZED per 15-min slot - the index-friendly
 * replacement of the per-bucket {@code LEFT JOIN LATERAL ... ORDER BY
 * (p.resolution = 'PT15M') DESC, p.ts DESC LIMIT 1} that {@link
 * HistoryRepository} and {@link EarningsRepository} used to run.
 *
 * <p><b>Why (a measured defect, scout vp-historie-konzept-t4 §5).</b> The
 * lateral's FIRST sort key is an EXPRESSION, so Postgres cannot use {@code
 * idx_day_ahead_prices_zone_ts (bidding_zone, ts DESC)} for an early abort: the
 * {@code LIMIT 1} only bites after the sort, so every bucket re-read and
 * discarded ~1.400 price rows ({@code loops=3621}, 111.784 buffer hits, 1.2 s
 * for one year window - reproduced on the demo stack). The same lateral ran
 * FIVE times per {@code /earnings} request. Building the series ONCE per (zone,
 * window) and equi-joining it turns that year window into ~10 ms, and the cost
 * stops growing with the number of buckets.
 *
 * <p><b>Semantics are identical, by construction - this is a query-shape change
 * only.</b> Each stored price row is expanded to the 15-min-aligned slot starts
 * its own validity interval {@code [ts, ts + length)} covers ({@code PT60M} = 60
 * minutes, every other resolution = 15 minutes - the lateral's CASE verbatim),
 * and the per-slot winner is picked with {@code DISTINCT ON} under the SAME
 * ordering keys the lateral used. So the finer resolution still wins where both
 * exist, the latest {@code ts} still breaks a tie among equals, an unknown
 * resolution is still treated as a 15-min slot that loses to PT15M, and a slot
 * no stored row covers still has no price (never a fabricated 0). Proven
 * slot-for-slot against the old lateral by {@code PriceSlotEqualityTest}.
 *
 * <p><b>The one assumption: the joined grid is 15-min aligned.</b> Every
 * consumer satisfies it - {@code telemetry_rollup_15m.bucket} /
 * {@code telemetry_v2_rollup_15m.bucket} and {@code time_bucket('15 minutes',
 * ...)} are epoch-aligned by definition, and {@code forecast.time} is floored to
 * the quarter hour (services/forecast {@code domain.floor_to_slot}). Price rows
 * themselves may sit anywhere: the expansion DERIVES each row's first covered
 * aligned slot instead of assuming the row is aligned.
 */
final class PriceSlots {

    /**
     * Lower window margin. The bound does timestamp arithmetic on a bound
     * parameter, so it carries an explicit {@code ::timestamptz} cast - without
     * it Postgres infers the placeholder as an {@code interval} from the
     * subtraction and refuses the comparison.
     *
     * <p>A covering row satisfies {@code ts > bucket - length}
     * with a maximum length of 60 minutes, plus one bucket (15 min) of slack in
     * case a caller's window start is not itself quarter-aligned. The upper
     * bound needs no margin - a row with {@code ts >= to} can never cover a
     * bucket {@code < to}.
     */
    private static final String LOWER_MARGIN = "INTERVAL '75 minutes'";

    /** The closed window predicate (binds window start, window end). */
    private static final String WINDOW =
            " AND p.ts > ?::timestamptz - " + LOWER_MARGIN + " AND p.ts < ?";

    /** The open-ended forward predicate (binds window start). */
    private static final String WINDOW_FROM =
            " AND p.ts > ?::timestamptz - " + LOWER_MARGIN;

    /**
     * The tenant's bidding zones (RLS-scoped like every read in this package).
     *
     * <p><b>The sub-select is RLS-RELATIVE, which is a feature.</b> Read through
     * the {@code @Primary} tenant-aware datasource it yields the caller's zones;
     * read through the BYPASSRLS admin role it yields the WHOLE fleet's zones.
     * {@link FleetMetricsRepository} relies on exactly that to build the
     * per-zone price-coverage metric without a second price query.
     */
    private static final String TENANT_ZONES =
            "p.bidding_zone IN (SELECT s2.bidding_zone FROM site s2)";

    private PriceSlots() {
    }

    /**
     * The series for ONE bidding zone over {@code [from, to)}.
     * Binds three parameters, in this order: bidding zone, window start, window
     * end.
     */
    static String forZone() {
        return cte("p.bidding_zone = ?", WINDOW);
    }

    /**
     * The series for every bidding zone the caller's sites price in (a
     * multi-zone fleet sums correctly) over {@code [from, to)}.
     * Binds two parameters: window start, window end.
     */
    static String forTenantZones() {
        return cte(TENANT_ZONES, WINDOW);
    }

    /**
     * The open-ended forward series for every bidding zone the caller's sites
     * price in - the forecast horizon has no fixed end, and the price table only
     * ever holds a day or two of future slots, so leaving the upper bound open is
     * cheap and cannot silently truncate a long horizon.
     * Binds one parameter: window start.
     */
    static String forTenantZonesFrom() {
        return cte(TENANT_ZONES, WINDOW_FROM);
    }

    /**
     * The expansion. The four-row {@code VALUES} is deliberate: a {@code PT60M}
     * row covers at most four aligned slots and everything else exactly one, so a
     * fixed cross join does the whole job without a set-returning function -
     * {@code generate_series} in a lateral costs ~30 us of executor setup PER
     * PRICE ROW and measured 100 ms where the {@code VALUES} join measured 3 ms.
     */
    private static String cte(String zonePredicate, String windowPredicate) {
        return "price_slot AS MATERIALIZED ("
                + "  SELECT DISTINCT ON (e.bidding_zone, e.slot)"
                + "         e.bidding_zone, e.slot, e.price_eur_mwh"
                + "  FROM (SELECT c.bidding_zone, c.price_eur_mwh, c.ts, c.fine,"
                + "               c.first_slot + q.n * INTERVAL '15 minutes' AS slot"
                + "        FROM (SELECT p.bidding_zone, p.price_eur_mwh, p.ts,"
                + "                     (p.resolution = 'PT15M') AS fine,"
                + "                     CASE WHEN time_bucket('15 minutes', p.ts) = p.ts"
                + "                          THEN p.ts"
                + "                          ELSE time_bucket('15 minutes', p.ts)"
                + "                               + INTERVAL '15 minutes' END AS first_slot,"
                + "                     p.ts + (CASE p.resolution"
                + "                             WHEN 'PT60M' THEN INTERVAL '60 minutes'"
                + "                             ELSE INTERVAL '15 minutes' END) AS slot_end"
                + "              FROM day_ahead_prices p"
                + "              WHERE " + zonePredicate + windowPredicate + ") c"
                + "        CROSS JOIN (VALUES (0), (1), (2), (3)) AS q(n)"
                + "        WHERE c.first_slot + q.n * INTERVAL '15 minutes' < c.slot_end) e"
                + "  ORDER BY e.bidding_zone, e.slot, e.fine DESC, e.ts DESC) ";
    }
}
