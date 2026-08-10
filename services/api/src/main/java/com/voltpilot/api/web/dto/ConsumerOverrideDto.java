package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/**
 * An active TTL-bound manual override of a consumer (Inkrement 5 / §11 + §14.13).
 * The portal shows "Eingriff aktiv bis HH:MM"; {@code kind} = start | stop.
 * Absent (204 / not in the list) = no active override, the normal state.
 */
public record ConsumerOverrideDto(UUID entityId, String kind, String targetCommand,
        BigDecimal targetValue, Instant endsAt) {
}
