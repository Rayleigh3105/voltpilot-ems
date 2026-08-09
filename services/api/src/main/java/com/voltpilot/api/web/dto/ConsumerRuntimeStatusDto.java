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
        Instant reportedAt) {
}
