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
 *   <li>{@code executionMode} - the PRECISE reason, including the portable
 *       idle follower, bounded full-battery relief and certified native mode.
 *   <li>{@code executionDirection} - {@code deepen|reduce}, only for
 *       {@code follow}: the discharge was RAISED to cover the house, or
 *       LIMITED to what it needs. Both are deliberate; an unnamed correction
 *       reads as a defect.
 *   <li>{@code executionPlannedKw} - the setpoint BEFORE the correction.
 *   <li>{@code executionTargetKw} - the MEASURED value it tracks (house
 *       deficit for follower modes, PV surplus for trim/absorb).
 * </ul>
 *
 * <p>All five are null for an older edge (and the target also when the device
 * could not measure it) - consumers then keep their generic wording and claim
 * NO direction, never a guessed one.
 *
 * <p><b>The certification fields (Plattform-Register, 10.08.2026) say WHY the
 * control is not released - the question "Steuerung: wird vorbereitet" used to
 * swallow.</b>
 *
 * <ul>
 *   <li>{@code certSource} - WHICH source granted it: {@code env} (the
 *       fleet-wide allowlist), {@code device} (a First-Light grant on that box)
 *       or {@code platform} (the model register).
 *   <li>{@code platformCertVerdict} - what the register says about THIS
 *       device's selected model: {@code granted} |
 *       {@code covered_not_activated} (the model is certified, one click is
 *       missing) | {@code not_covered} (a bench run is genuinely needed) |
 *       {@code unknown}.
 *   <li>{@code platformCertModel} - the register entry that matched, so a
 *       surface can name it.
 *   <li>{@code platformCertReason} - the plain-German cause where a
 *       covered-looking model still gets nothing.
 * </ul>
 *
 * <p>All four are null for an older edge. ⚠ A null verdict is "we do not know",
 * NEVER "not covered": those are different sentences, and a consumer that
 * collapses them tells a customer to book a bench run they do not need.
 */
public record ControlStatusDto(UUID deviceId, Double commandedKw, Double confirmedKw,
        boolean allMatch, boolean controlEnabled, boolean certified,
        String mismatchRoles, Instant slotStart, Instant checkedAt,
        String controlSource, String executionMode, String executionDirection,
        Double executionPlannedKw, Double executionTargetKw,
        Double executionFloorSocPct, Boolean executionMeasurementsFresh,
        String certSource, String platformCertVerdict, String platformCertModel,
        String platformCertReason,
        /*
         * Der Messkanal, ohne den diese Anlage AUSDRÜCKLICH eingerichtet wurde
         * („Trotzdem fortfahren (nur Lesen)"; heute: {@code soc_pct}, eine
         * Batterie ohne gekoppeltes BMS).
         *
         * ⚠ Das ist als einziges Feld dieser Zeile eine PORTAL-Tatsache, keine
         * Meldung des Geräts: sie steht in der gespeicherten Anbindung der
         * Wechselrichter-Komponente. Sie gehört hierher, weil sie genau EINE
         * Frage beantwortet, die diese Fläche stellt - „warum steuert diese
         * Anlage nicht?" -, und weil die Antwort sonst „VoltPilot prüft das
         * Modell am Prüfstand" hieße, was schlicht falsch wäre: ein
         * Prüfstandslauf bringt kein BMS ans Laufen.
         *
         * {@code null} = keine solche Ausnahme. Der Beleg verschwindet von
         * selbst, sobald die Komponente nach einem vollständigen Test neu
         * gespeichert wird.
         */
        String missingReadingChannel) {

    /** Der Bequemlichkeits-Konstruktor der Aufrufer ohne diese Ausnahme. */
    public ControlStatusDto(UUID deviceId, Double commandedKw, Double confirmedKw,
            boolean allMatch, boolean controlEnabled, boolean certified,
            String mismatchRoles, Instant slotStart, Instant checkedAt,
            String controlSource, String executionMode, String executionDirection,
            Double executionPlannedKw, Double executionTargetKw,
            String certSource, String platformCertVerdict, String platformCertModel,
            String platformCertReason) {
        this(deviceId, commandedKw, confirmedKw, allMatch, controlEnabled, certified,
                mismatchRoles, slotStart, checkedAt, controlSource, executionMode,
                executionDirection, executionPlannedKw, executionTargetKw, null, null, certSource,
                platformCertVerdict, platformCertModel, platformCertReason, null);
    }
}
