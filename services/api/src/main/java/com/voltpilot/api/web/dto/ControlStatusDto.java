package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * The latest inverter-control confirmation for a site (report §5.4): what the
 * schedule commanded ({@code commandedKw}) vs. what the inverter read back
 * ({@code confirmedKw}), a healthy/mismatch verdict ({@code allMatch}), and the
 * freshness anchor ({@code checkedAt}) the portal turns into "geprüft vor X".
 *
 * <p>{@code controlEnabled} reflects the device's global control kill-switch and
 * {@code certified} whether the model is bench-certified for control - so the
 * portal can distinguish "confirmed", "control off", and "not yet released for
 * this model" without register-level detail. Populated by the status listener
 * from the additive {@code control} block; the portal strip stays free of
 * Modbus/register vocabulary.
 */
public record ControlStatusDto(UUID deviceId, Double commandedKw, Double confirmedKw,
        boolean allMatch, boolean controlEnabled, boolean certified,
        String mismatchRoles, Instant slotStart, Instant checkedAt) {
}
