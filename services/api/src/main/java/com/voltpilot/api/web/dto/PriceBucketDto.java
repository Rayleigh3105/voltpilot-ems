package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * One aggregated day-ahead price bucket for a historical range. {@code ts} is
 * the bucket start; {@code avg}/{@code min}/{@code max} are the mean and the
 * band of the finer slots that fall into it (all EUR/MWh, the series currency).
 * For the day range a bucket is a single 15-min slot, so the three values are
 * equal; for week/month/year they describe the intra-bucket spread the chart
 * draws as a band around the average line.
 */
public record PriceBucketDto(
        Instant ts,
        BigDecimal avgEurMwh,
        BigDecimal minEurMwh,
        BigDecimal maxEurMwh) {
}
