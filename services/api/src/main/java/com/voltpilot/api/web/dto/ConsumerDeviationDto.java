package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

/**
 * Soll/Ist-Abweichung je Verbraucher (Inkrement 5, §18): what the co-optimizer
 * PLANNED for the current quarter-hour vs. what the edge CONFIRMED. A pure
 * DIAGNOSIS read path for the platform/support layer ({@code showTechnicalLayer()})
 * - it is not a customer surface. Every figure is null when honestly unknown
 * (no plan, no confirmed telemetry) - never a fabricated 0; {@code confirmed} is
 * tri-state (null = no readback).
 */
public record ConsumerDeviationDto(List<Row> consumers) {

    public record Row(UUID entityId, String name,
            BigDecimal plannedKw, BigDecimal actualKw, BigDecimal deviationKw,
            Integer plannedRuntimeTodaySeconds, Integer actualRuntimeTodaySeconds,
            Boolean confirmed, String state, String reasonCode) {}
}
