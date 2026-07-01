package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * One bucket of a site's history series (15-min for the day view, hourly for
 * the week, daily for month/year). All energies are kWh over the bucket;
 * import/export and battery charge/discharge are split per raw sample before
 * aggregation (see migration V20260701030000 for the exact semantics).
 * {@code priceEurMwh} and {@code costEur} (= import energy x the matching
 * day-ahead price) are null where no price is stored for the bucket.
 */
public record HistoryBucketDto(
        Instant start,
        BigDecimal pvKwh,
        BigDecimal loadKwh,
        BigDecimal gridImportKwh,
        BigDecimal gridExportKwh,
        BigDecimal batteryChargeKwh,
        BigDecimal batteryDischargeKwh,
        BigDecimal socMinPct,
        BigDecimal socMaxPct,
        BigDecimal socLastPct,
        BigDecimal priceEurMwh,
        BigDecimal costEur) {
}
