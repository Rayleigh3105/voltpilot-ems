package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;

/**
 * S4 ("die Woche je Stunde"): the hourly PV/load outlook from "übermorgen"
 * onward, read from {@code forecast_weekly} (stored separately from the
 * quarter-hour forecast). {@code pvRunAt}/{@code loadRunAt} stay separate for
 * the same reason as {@link ForecastDto}. {@code null} and an empty list
 * mean no weekly run has landed yet for that kind (not enough weather reach,
 * or the site is brand new) - never a fabricated row.
 */
public record WeeklyOutlookDto(
        Instant pvRunAt,
        List<ForecastValueDto> pvKw,
        Instant loadRunAt,
        List<ForecastValueDto> loadKw) {
}
