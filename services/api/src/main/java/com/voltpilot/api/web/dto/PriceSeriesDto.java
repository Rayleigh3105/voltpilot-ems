package com.voltpilot.api.web.dto;

import java.util.List;

/**
 * A day-ahead price series for a site's bidding zone. The zone/resolution/currency
 * are series-level metadata (prices are market-wide per zone, not per tenant), and
 * {@code points} are the ordered slots the portal renders as 15-min bars.
 *
 * <p>{@code boxFeed} says whether THIS site's box is fed the current price
 * (Vertrag {@code docs/contracts/v2/mqtt-price-current.md}) - the portal
 * unlocks the Regel-Baukasten's price block on it, and the Probelauf then
 * computes on exactly these {@code points}, the same rows the feed publishes.
 * One derivation ({@code PreisZuleitung}), never a second rule.
 */
public record PriceSeriesDto(
        String biddingZone,
        String resolution,
        String currency,
        List<PricePointDto> points,
        BoxFeedDto boxFeed) {

    /** {@code grund} is a code ({@code kein_dynamischer_tarif}, {@code keine_zone},
     * {@code keine_box}, {@code edge_light}), set exactly when {@code aktiv} is false. */
    public record BoxFeedDto(boolean aktiv, String grund) {}
}
