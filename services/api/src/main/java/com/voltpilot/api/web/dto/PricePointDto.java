package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * One day-ahead spot-price slot. {@code ts} is the slot start and {@code end} its
 * exclusive end (so a 15-min bar's width is explicit for the chart); price is in
 * the series' currency per MWh.
 */
public record PricePointDto(Instant ts, Instant end, BigDecimal priceEurMwh) {
}
