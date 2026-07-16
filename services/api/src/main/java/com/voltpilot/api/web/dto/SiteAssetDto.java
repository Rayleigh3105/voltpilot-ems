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
 *
 * <p>{@code speicherschonung} is the battery's EFFECTIVE "Umgang mit dem
 * Speicher" preset, derived server-side from the stored wear cost
 * ({@link com.voltpilot.api.web.Speicherschonung}): {@code aggressiv} /
 * {@code ausgewogen} (also for NULL = platform default) / {@code schonend},
 * or {@code individuell} when an admin configured a custom value. Null for
 * non-battery assets. The raw ct value stays admin-only (optimizer-config).
 */
public record SiteAssetDto(
        UUID id,
        String type,
        UUID deviceId,
        BigDecimal capacityKwh,
        BigDecimal maxChargeKw,
        BigDecimal maxDischargeKw,
        BigDecimal roundtripEfficiencyPct,
        String speicherschonung,
        BigDecimal pvCapacityKwp,
        Integer moduleCount,
        BigDecimal azimuthDeg,
        BigDecimal tiltDeg,
        LocalDate commissionedOn,
        String registry,
        String registryUnitId,
        Instant registryFetchedAt) {
}
