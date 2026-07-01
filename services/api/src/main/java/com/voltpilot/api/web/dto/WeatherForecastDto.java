package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;

/**
 * The latest weather-forecast run for a site. {@code runAt} is the issue time of
 * the run; {@code points} are its hourly slots in time order.
 */
public record WeatherForecastDto(Instant runAt, List<WeatherPointDto> points) {
}
