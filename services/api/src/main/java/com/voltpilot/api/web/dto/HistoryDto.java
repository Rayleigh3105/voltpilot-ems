package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;

/**
 * A site's history for one period (see docs/contracts/openapi.yaml): the
 * bucketed series, the period aggregates, and - for the day range only - the
 * Tagesprotokoll plus the persisted optimizer plan for the plan-vs-actual
 * overlay (both empty lists otherwise). {@code from} is inclusive, {@code to}
 * exclusive; period boundaries are Europe/Berlin local time (DACH product).
 */
public record HistoryDto(
        String range,
        Instant from,
        Instant to,
        int bucketMinutes,
        List<HistoryBucketDto> buckets,
        HistoryTotalsDto totals,
        List<ProtocolEventDto> protocol,
        List<HistoryPlanPointDto> plan) {
}
