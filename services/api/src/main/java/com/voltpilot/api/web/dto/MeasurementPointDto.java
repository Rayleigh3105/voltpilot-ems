package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/**
 * One additional measurement point of a site (the multi-source Anlage master
 * data). Phase 1 records read-only Erzeuger (PV) sources: a site with a
 * battery-hybrid inverter PLUS a separate AC-coupled PV records the second PV
 * here so its kWp sums into the aggregate {@code asset.pv} the forecast reads.
 *
 * <p>Read-only by construction: {@code control} is always false for the roles
 * recorded here (only the battery-hybrid inverter may be a control point, and it
 * is not a measurement point in Phase 1).
 */
public record MeasurementPointDto(
        UUID id,
        String role,
        String label,
        String brand,
        String model,
        BigDecimal capacityKwp,
        String registryUnitId,
        boolean control,
        Instant createdAt) {
}
