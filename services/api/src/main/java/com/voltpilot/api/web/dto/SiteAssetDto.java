package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;

/**
 * One asset row of a site as the portal sees it: battery parameters (the
 * optimizer's inputs, incl. {@code roundtripEfficiencyPct}), PV parameters (the
 * forecast's inputs), the registry provenance ("MaStR verknüpft", zuletzt
 * abgerufen) and {@code deviceId} - the executing device that controls this
 * asset. A battery with {@code deviceId == null} has NO control path: the
 * optimizer plans it but can never publish the plan to the edge, so the portal
 * warns and offers the link editor.
 */
public record SiteAssetDto(
        UUID id,
        String type,
        UUID deviceId,
        BigDecimal capacityKwh,
        BigDecimal maxChargeKw,
        BigDecimal maxDischargeKw,
        BigDecimal roundtripEfficiencyPct,
        BigDecimal pvCapacityKwp,
        Integer moduleCount,
        BigDecimal azimuthDeg,
        BigDecimal tiltDeg,
        LocalDate commissionedOn,
        String registry,
        String registryUnitId,
        Instant registryFetchedAt) {
}
