package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * The latest FEED-IN CURTAILMENT execution truth a device reported (scout
 * {@code vp-pilsting-abregeln}, Frage 2/3; PR 3 of 4): whether the plant is
 * actually throttling its PV, or whether the plan's "Abregeln" slot stays a
 * plan because the curtailment actor is not released yet.
 *
 * <p>Why this is its OWN read instead of extra fields on
 * {@link ControlStatusDto}: the two heartbeat blocks are INDEPENDENT. The edge
 * omits {@code control} when its primary inverter has no readback (blocked /
 * none yet) and omits {@code curtailment} when the site has no
 * curtailment-capable source, so either can arrive alone. Folding them into one
 * DTO would mean synthesizing a control row whose three non-null booleans each
 * drive customer copy - a site with only curtailment would then be told "Die
 * Steuerung ist für dieses Modell noch nicht freigegeben", which is a claim
 * nobody measured. Two rows also keep their freshness honest: each is staleness-
 * checked on its OWN {@code checkedAt}.
 *
 * <ul>
 *   <li>{@code units} / {@code certifiedUnits} - configured curtailment units
 *       and how many carry a per-unit First-Light release.
 *       {@code certifiedUnits < units} is THE actionable cause the portal
 *       names ("0 von 2 Wechselrichtern freigegeben").
 *   <li>{@code controlEnabled} - the device's control kill-switch.
 *   <li>{@code active} - at least one unit currently APPLIES a cap.
 *   <li>{@code appliedCapKw} - the summed applied caps; null = none applied
 *       (never a fabricated 0).
 *   <li>{@code allMatch} - over the applying units' readbacks; null = nothing
 *       applied. Only TRUE is a confirmation.
 *   <li>{@code possibleOverride} - a unit's MEASURED power exceeds its cap
 *       after the settle window, so a foreign controller may be overriding the
 *       limit (Modbus has the lowest priority on Fronius).
 *   <li>{@code checkedAt} - the newest per-unit readback timestamp, the
 *       freshness anchor. A stale block is NO evidence: the portal then falls
 *       back to its plan wording.
 *   <li>{@code exportGuard} - „Grenzen &amp; Wächter" Stufe 0: the live feed-in
 *       watchdog (which limit the box holds, and whether it reaches any device
 *       at all). Null = not reported (older edge / no feed-in limit
 *       configured), never a fabricated "no limit".
 *   <li>{@code deviceExportLimit} - the limit the INVERTER ITSELF holds, read
 *       from its own register at most once a day. Null = not reported. It has
 *       its OWN read timestamp because it ages on a completely different clock
 *       than {@code checkedAt}.
 *   <li>{@code perUnit} - the ADDITIVE per-unit breakdown (R4a / E2): WHICH
 *       unit is released, holds which cap, confirmed by which readback. It
 *       ages on {@code checkedAt} like everything else in this block - a
 *       second freshness stamp for the same observation would be a second
 *       answer to the same question. See the tri-state below.
 * </ul>
 *
 * <p><b>⚠ {@code perUnit} is THREE-valued, and the two empty cases are
 * different statements.</b> {@code null} = not loaded on this path (the fleet
 * aggregate reads the row without its units - the fleet view is per SITE and
 * renders no per-unit list, so loading it would be work nobody reads).
 * {@code []} = the device reported none (an older edge that predates the list,
 * or units without a join key). Only a non-empty list is an attribution.
 * <b>And the list may be SHORTER than {@code units}</b> - an entry without a
 * source id is dropped at ingest rather than attributed to nothing, so
 * {@code units} stays THE count and must never be derived from the list.
 *
 * <p>No row at all (204) = an older edge or a plant without a curtailment
 * actor. Every consumer keeps its pre-PR-3 PLAN wording then, never a
 * fabricated execution claim.
 */
public record CurtailmentStatusDto(UUID deviceId, int units, int certifiedUnits,
        boolean controlEnabled, boolean active, Double appliedCapKw, Boolean allMatch,
        boolean possibleOverride, Instant checkedAt, ExportGuardDto exportGuard,
        DeviceExportLimitDto deviceExportLimit, List<CurtailmentUnitDto> perUnit) {

    /**
     * The pre-R4a shape: everything but the per-unit list, which stays
     * {@code null} = "not loaded here". Kept so every existing caller (the
     * listener's parse, the fleet aggregate's row mapper, tests) is unchanged -
     * a 12-argument copy at each of them would be a place to forget a field.
     */
    public CurtailmentStatusDto(UUID deviceId, int units, int certifiedUnits,
            boolean controlEnabled, boolean active, Double appliedCapKw, Boolean allMatch,
            boolean possibleOverride, Instant checkedAt, ExportGuardDto exportGuard,
            DeviceExportLimitDto deviceExportLimit) {
        this(deviceId, units, certifiedUnits, controlEnabled, active, appliedCapKw, allMatch,
                possibleOverride, checkedAt, exportGuard, deviceExportLimit, null);
    }

    /** The same row with its per-unit list attached (the read path). */
    public CurtailmentStatusDto withPerUnit(List<CurtailmentUnitDto> units) {
        return new CurtailmentStatusDto(deviceId, this.units, certifiedUnits, controlEnabled,
                active, appliedCapKw, allMatch, possibleOverride, checkedAt, exportGuard,
                deviceExportLimit, units);
    }
}
