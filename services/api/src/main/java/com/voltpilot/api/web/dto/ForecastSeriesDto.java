package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;

/**
 * One model's latest (or a specific) forecast run: {@code runAt} is the issue
 * time, {@code points} its slots in time order. {@code null}/empty when the
 * model has never run for the site - never a fabricated zero.
 */
public record ForecastSeriesDto(Instant runAt, List<ForecastValueDto> points) {
}
