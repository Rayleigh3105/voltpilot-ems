package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;

/**
 * A day-ahead price series aggregated over one historical range (Tag/Woche/
 * Monat/Jahr). Prices are market-wide per bidding zone, so this carries the
 * zone/currency as series metadata and no tenant. {@code bucket} is the
 * aggregation granularity as an ISO-8601 duration ({@code PT15M} for the day,
 * {@code PT1H} for the week, {@code P1D} for month/year); {@code from}/{@code to}
 * are the half-open window (Europe/Berlin boundaries). The day range anchored on
 * today extends {@code to} into tomorrow so the forward-looking day-ahead curve
 * stays visible.
 */
public record PriceHistoryDto(
        String biddingZone,
        String currency,
        String bucket,
        Instant from,
        Instant to,
        List<PriceBucketDto> buckets,
        PriceRangeSummaryDto summary) {
}
