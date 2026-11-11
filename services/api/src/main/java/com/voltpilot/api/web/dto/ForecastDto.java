package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;

/**
 * S1 ("der Lesepunkt", report vp-prognosen-konzept section 9): the site's
 * forecast, independent of whether it has a Fahrplan. {@code activePvModel}/
 * {@code activeLoadModel} are the models the series were read FROM (the same
 * precedence {@link com.voltpilot.api.forecast.ForecastModelService} resolves
 * for {@code /forecast-quality}). {@code pvRunAt}/{@code loadRunAt} are kept
 * SEPARATE, not one shared timestamp: both kinds are stamped with the same
 * collector cycle in the common case, but a partial cycle failure (one kind's
 * writer down, the other healthy) must stay visible rather than being
 * silently merged into a single "latest" that hides it. {@code null} and an
 * empty list mean the kind has never run for the site - never a fabricated
 * zero.
 */
public record ForecastDto(
        String activePvModel,
        String activeLoadModel,
        Instant pvRunAt,
        List<ForecastValueDto> pvKw,
        Instant loadRunAt,
        List<ForecastValueDto> loadKw,
        YesterdayExpectedDto yesterdayExpected,
        WeeklyOutlookDto weekly) {
}
