package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * One Tagesprotokoll entry (day view only): a notable event of the day in
 * plain German, derived from the day's telemetry + prices. {@code type} is one
 * of {@code batterie-laden | batterie-entladen | pv-spitze | preis-tief |
 * preis-hoch}; the numeric fields are set where they apply (see
 * {@link com.voltpilot.api.history.Tagesprotokoll} for the heuristics).
 */
public record ProtocolEventDto(
        String type,
        Instant start,
        Instant end,
        String text,
        BigDecimal energyKwh,
        BigDecimal avgPriceEurMwh,
        BigDecimal avoidedCostEur,
        BigDecimal peakKw) {
}
