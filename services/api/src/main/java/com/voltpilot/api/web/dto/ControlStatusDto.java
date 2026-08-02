package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * The latest inverter-control confirmation for a site (report §5.4): what the
 * device regulates ({@code commandedKw}) vs. what the inverter read back
 * ({@code confirmedKw}), a healthy/mismatch verdict ({@code allMatch}), and the
 * freshness anchor ({@code checkedAt}) the portal turns into "geprüft vor X".
 *
 * <p>{@code controlEnabled} reflects the device's global control kill-switch and
 * {@code certified} whether the model is bench-certified for control - so the
 * portal can distinguish "confirmed", "control off", and "not yet released for
 * this model" without register-level detail. Populated by the status listener
 * from the additive {@code control} block; the portal strip stays free of
 * Modbus/register vocabulary.
 *
 * <p><b>The execution fields (PR 3 of the Fahrplan concept) say WHY the
 * commanded value is what it is.</b> Since the in-slot duties the device
 * knowingly deviates from the plan's watt value, so {@code commandedKw} alone
 * made the portal state a bare number next to a Fahrplan bar showing a
 * different one:
 *
 * <ul>
 *   <li>{@code controlSource} - the device's COARSE truth
 *       ({@code schedule|default}). It collapses every non-schedule mode
 *       (self-consumption fallback, a v2 desired holding the battery,
 *       calibration) into {@code default}, so it must never be rendered as
 *       "the built-in safety rule is running".
 *   <li>{@code executionMode} - the PRECISE reason
 *       ({@code plan|follow|trim|fallback}).
 *   <li>{@code executionDirection} - {@code deepen|reduce}, only for
 *       {@code follow}: the discharge was RAISED to cover the house, or
 *       LIMITED to what it needs. Both are deliberate; an unnamed correction
 *       reads as a defect.
 *   <li>{@code executionPlannedKw} - the setpoint BEFORE the correction.
 *   <li>{@code executionTargetKw} - the MEASURED value it tracks (house
 *       deficit for {@code follow}, PV surplus for {@code trim}).
 * </ul>
 *
 * <p>All five are null for an older edge (and the target also when the device
 * could not measure it) - consumers then keep their generic wording and claim
 * NO direction, never a guessed one.
 */
public record ControlStatusDto(UUID deviceId, Double commandedKw, Double confirmedKw,
        boolean allMatch, boolean controlEnabled, boolean certified,
        String mismatchRoles, Instant slotStart, Instant checkedAt,
        String controlSource, String executionMode, String executionDirection,
        Double executionPlannedKw, Double executionTargetKw) {
}
