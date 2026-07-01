package com.voltpilot.api.web.dto;

import java.util.List;

/**
 * A day-ahead price series for a site's bidding zone. The zone/resolution/currency
 * are series-level metadata (prices are market-wide per zone, not per tenant), and
 * {@code points} are the ordered slots the portal renders as 15-min bars.
 */
public record PriceSeriesDto(
        String biddingZone,
        String resolution,
        String currency,
        List<PricePointDto> points) {
}
