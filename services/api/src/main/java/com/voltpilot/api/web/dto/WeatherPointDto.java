package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * One hourly weather-forecast slot for a site (Open-Meteo). {@code ghiWM2} is the
 * shortwave / global-horizontal irradiance useful for PV; any value may be null if
 * the provider omitted it for that hour.
 *
 * <p>{@code dniWM2} is the HISTORICAL reading (Open-Meteo's {@code direct_radiation},
 * horizontal, not beam-normal - N1, docs/forecasting.md); {@code dniNormalWM2} is the
 * correctly-read {@code direct_normal_irradiance} (true DNI), added for S0. The
 * Wetter-Seite's Sonnenstunden derivation (``wetterTag.ts``) uses the true one since
 * the Captain's fix (11.11.2026).
 */
public record WeatherPointDto(
        Instant ts,
        BigDecimal temperatureC,
        BigDecimal cloudCoverPct,
        BigDecimal ghiWM2,
        BigDecimal dniWM2,
        BigDecimal dhiWM2,
        BigDecimal dniNormalWM2) {
}
