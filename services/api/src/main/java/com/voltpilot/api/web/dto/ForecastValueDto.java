package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;

/** One forecast slot: mean power {@code valueKw} starting at {@code ts}. */
public record ForecastValueDto(Instant ts, BigDecimal valueKw) {
}
