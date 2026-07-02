package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;

/**
 * One asset row of a site as the portal sees it: battery parameters (the
 * optimizer's inputs), PV parameters (the forecast's inputs) and the registry
 * provenance ("MaStR verknüpft", zuletzt abgerufen).
 */
public record SiteAssetDto(
        UUID id,
        String type,
        BigDecimal capacityKwh,
        BigDecimal maxChargeKw,
        BigDecimal maxDischargeKw,
        BigDecimal pvCapacityKwp,
        Integer moduleCount,
        BigDecimal azimuthDeg,
        BigDecimal tiltDeg,
        LocalDate commissionedOn,
        String registry,
        String registryUnitId,
        Instant registryFetchedAt) {
}
