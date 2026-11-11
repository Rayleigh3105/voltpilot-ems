package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * An active TTL-bound manual override of a consumer (Inkrement 5 / §11 + §14.13).
 * The portal shows "Eingriff aktiv bis HH:MM"; {@code kind} = start | stop.
 * Absent (204 / not in the list) = no active override, the normal state.
 * {@code targetOutputs}: the outputs a heating rod's per-phase switch ASKED for
 * (channel numbers; what runs is the box's confirmed stage); absent = none.
 */
public record ConsumerOverrideDto(UUID entityId, String kind, String targetCommand,
        BigDecimal targetValue, Instant endsAt,
        @JsonInclude(JsonInclude.Include.NON_NULL) List<Integer> targetOutputs) {
}
