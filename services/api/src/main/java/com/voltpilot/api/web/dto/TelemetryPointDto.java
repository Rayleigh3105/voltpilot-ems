package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.math.BigDecimal;

/** One telemetry sample for a site (see docs/contracts/openapi.yaml). */
public record TelemetryPointDto(
        Instant ts,
        BigDecimal powerKw,
        BigDecimal socPct,
        BigDecimal pvPowerKw,
        BigDecimal loadKw,
        BigDecimal gridLimitKw) {
}
