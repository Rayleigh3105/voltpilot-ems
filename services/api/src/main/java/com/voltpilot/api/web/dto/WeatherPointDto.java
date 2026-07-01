package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * One hourly weather-forecast slot for a site (Open-Meteo). {@code ghiWM2} is the
 * shortwave / global-horizontal irradiance useful for PV; any value may be null if
 * the provider omitted it for that hour.
 */
public record WeatherPointDto(
        Instant ts,
        BigDecimal temperatureC,
        BigDecimal cloudCoverPct,
        BigDecimal ghiWM2,
        BigDecimal dniWM2,
        BigDecimal dhiWM2) {
}
