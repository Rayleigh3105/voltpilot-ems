package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Headline statistics for a price range: the mean/min/max over the raw slots in
 * the window, the timestamps of the cheapest and most expensive slot (so the
 * portal can name "günstigste/teuerste Stunde"), the slot {@code count}, and the
 * actual data {@code coverageStart}/{@code coverageEnd}. Coverage lets the UI
 * tell a genuinely empty period apart from one only partly filled (the collector
 * only fetches today+tomorrow, so history grows day by day). All prices EUR/MWh.
 */
public record PriceRangeSummaryDto(
        BigDecimal avgEurMwh,
        BigDecimal minEurMwh,
        BigDecimal maxEurMwh,
        Instant cheapestTs,
        Instant mostExpensiveTs,
        int count,
        Instant coverageStart,
        Instant coverageEnd) {

    /** An all-empty summary for a window with no stored prices. */
    public static PriceRangeSummaryDto empty() {
        return new PriceRangeSummaryDto(null, null, null, null, null, 0, null, null);
    }
}
