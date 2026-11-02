package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * The edge-reported live state of one controllable consumer entity
 * (Verbrauchssteuerung Inkrement 3, D9/§15.1; table consumer_runtime_status).
 *
 * <p>Honesty rules the consumers must keep: {@code confirmed} is TRI-STATE
 * (null = no readback evidence - "Ausführung nicht bestätigt" territory, never
 * a claimed yes/no); {@code actualKw} null = not measured (never a fabricated
 * 0); an entity with NO row at all renders "Zustand nicht bestätigt". The
 * portal maps {@code reasonCode} through its pure, tested TS table - no
 * surface ever greps German sentences.
 */
public record ConsumerRuntimeStatusDto(UUID entityId, String state, String reasonCode,
        Double actualKw, Boolean confirmed, Integer runtimeSecondsToday, Integer startsToday,
        Instant reportedAt, com.fasterxml.jackson.databind.JsonNode stufe,
        com.fasterxml.jackson.databind.JsonNode heizstab, java.math.BigDecimal stufeEnergieKwhHeute) {

    /**
     * Every consumer without stages - the shape before Heizstab V1. For a heating rod over an
     * output set {@code stufe} is the reported stage (commanded/CONFIRMED with kW, outputs on,
     * mismatch_since - heizstab-shelly.md), {@code heizstab} the box controller's verdict
     * (heizstab-regler.md) and {@code stufeEnergieKwhHeute} the assumed energy of the day from
     * the confirmed stages; all three null otherwise.
     */
    public ConsumerRuntimeStatusDto(UUID entityId, String state, String reasonCode,
            Double actualKw, Boolean confirmed, Integer runtimeSecondsToday, Integer startsToday,
            Instant reportedAt) {
        this(entityId, state, reasonCode, actualKw, confirmed, runtimeSecondsToday, startsToday,
                reportedAt, null, null, null);
    }
}
