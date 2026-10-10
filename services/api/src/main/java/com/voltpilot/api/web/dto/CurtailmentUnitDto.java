package com.voltpilot.api.web.dto;

/**
 * One curtailment-capable unit as the device reported it (scout
 * {@code vp-geraeteseite-rev-b8} R4a, Captain-Entscheid E2). Until this list
 * existed the cloud could only COUNT ("0 von 2 Wechselrichtern freigegeben"),
 * so the Befehle-Seite had to say "an alle freigegebenen Wechselrichter" and a
 * PV device page could not show its OWN curtailment at all.
 *
 * <p><b>E2 rejected deriving it in the cloud.</b> Only the box knows which unit
 * it wrote to and what came back; a cloud-side heuristic ("every PV device with
 * a SunSpec control path is a target") would be exactly the fabricated
 * attribution {@code ANLAGENWEITE_BEFEHLE} exists to avoid.
 *
 * <ul>
 *   <li>{@code sourceId} - the JOIN KEY to the reported sources
 *       ({@code /sources.sourceId}). It is how a unit becomes a device NAME:
 *       the portal names devices through its ONE name builder
 *       ({@code entityLabel.deviceName}), so no name travels over the wire.
 *   <li>{@code certified} - a persisted per-unit First-Light release. The edge
 *       sources it from its CORE, never from the readback's own stamp (a
 *       readback stamp is a Layer-1 observation, never a gate authority), so
 *       this field and {@code CurtailmentStatusDto.certifiedUnits} can never
 *       disagree.
 *   <li>{@code appliedCapKw} - the cap THIS unit applies; null = none applied
 *       (a release lifted the limit), never a fabricated 0.
 *   <li>{@code match} - this unit's readback verdict; null = observed-only,
 *       nothing was commanded. Only TRUE is a confirmation - "nothing applied"
 *       must never read as "the readback disagreed". For a unit with
 *       {@code mode = grid_target} it judges the MEASUREMENT instead (the grid
 *       connection point follows the target), never a held register - a
 *       register that holds proves nothing about the effect there.
 *   <li>{@code mode} - HOW this unit curtails (netzseitiger Drossel-Slot,
 *       08.10.2026). null = the cap on the unit itself ({@code appliedCapKw}),
 *       i.e. every unit before this field existed. {@link #MODE_GRID_TARGET} =
 *       the unit does not cap its own output, it regulates the GRID CONNECTION
 *       POINT on {@code targetKw} (the primary hybrid inverter, which stores
 *       the surplus first and throttles its own PV for the rest). The word is
 *       STANDING - it says how the unit curtails, not that it does so right
 *       now. An unknown word of a newer box is dropped at ingest (null).
 *   <li>{@code targetKw} - only with {@code grid_target}: the target at the
 *       grid connection point in the sign of the grid point ({@code +} import,
 *       {@code -} feed-in; 0 = no feed-in). null = no target active right now,
 *       never a fabricated 0.
 * </ul>
 */
public record CurtailmentUnitDto(String sourceId, boolean certified, Double appliedCapKw,
        Boolean match, String mode, Double targetKw) {

    /** The one {@code mode} word besides null: the unit regulates the grid connection point. */
    public static final String MODE_GRID_TARGET = "grid_target";

    /** An ordinary cap unit: no mode, no grid target. */
    public CurtailmentUnitDto(String sourceId, boolean certified, Double appliedCapKw, Boolean match) {
        this(sourceId, certified, appliedCapKw, match, null, null);
    }
}
