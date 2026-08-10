package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

/**
 * The fulfilment ledger of one consumer read for the portal (Inkrement 5 / §9.4
 * + §14.13 "Heute: erfüllte/offene Aufgaben"). Each {@link Task} is the CURRENT
 * (or most recent) instance of a recurring requirement; {@code state} is the
 * EFFECTIVE state at read time (a period past its deadline without a stored
 * fulfilment reads {@code missed}) and {@code atRisk} is the derived §17 warn
 * "Frist gefährdet". Empty {@code tasks} = no recurring requirement / no
 * telemetry evidence yet, the honest empty state - the portal maps the state and
 * reason via its pure TS table, never greps German.
 */
public record ConsumerFulfillmentDto(List<Task> tasks) {

    public record Task(String requirementId, Instant periodStart, Instant deadline,
            Integer requiredRuntimeSeconds, Integer actualRuntimeSeconds,
            BigDecimal requiredEnergyKwh, BigDecimal actualEnergyKwh,
            String energyConfirmation, String state, boolean atRisk, String reasonCode) {}
}
