package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;

/**
 * "Gestern erwartet": the evening run (17:45 ± 15 min Europe/Berlin) of the
 * PREVIOUS day, per kind - what VoltPilot expected for yesterday, read back
 * today. {@code pvRunAt}/{@code loadRunAt} stay separate for the same reason
 * as {@link ForecastDto}: a kind whose evening run fell outside the
 * tolerance window (collector down, or the site is younger than one day)
 * must show {@code null} and an empty list for exactly that kind, not be
 * merged into the other kind's timestamp.
 */
public record YesterdayExpectedDto(
        Instant pvRunAt,
        List<ForecastValueDto> pvKw,
        Instant loadRunAt,
        List<ForecastValueDto> loadKw) {
}
