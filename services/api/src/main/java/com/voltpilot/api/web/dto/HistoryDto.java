package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;

/**
 * A site's history for one period (see docs/contracts/openapi.yaml): the
 * bucketed series, the period aggregates, and - for the day range only - the
 * Tagesprotokoll plus the persisted optimizer plan for the plan-vs-actual
 * overlay (both empty lists otherwise). {@code from} is inclusive, {@code to}
 * exclusive; period boundaries are Europe/Berlin local time (DACH product).
 *
 * <p>{@code coverage} ist additiv (F4/P7): wie vollständig der Zeitraum
 * gemessen ist, aus einer eigenen billigen Abfrage - null, wenn die Anlage noch
 * nie eine Viertelstunde gemessen hat.
 */
public record HistoryDto(
        String range,
        Instant from,
        Instant to,
        int bucketMinutes,
        List<HistoryBucketDto> buckets,
        HistoryTotalsDto totals,
        List<ProtocolEventDto> protocol,
        List<HistoryPlanPointDto> plan,
        HistoryCoverageDto coverage) {
}
