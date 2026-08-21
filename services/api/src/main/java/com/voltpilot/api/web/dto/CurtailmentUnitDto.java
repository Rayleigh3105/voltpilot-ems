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
 *       must never read as "the readback disagreed".
 * </ul>
 */
public record CurtailmentUnitDto(String sourceId, boolean certified, Double appliedCapKw,
        Boolean match) {
}
