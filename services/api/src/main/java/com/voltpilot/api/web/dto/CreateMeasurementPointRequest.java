package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;

/**
 * Record an additional read-only measurement point (master data only - no second
 * device claim; the source is read through the site's one claimed edge).
 *
 * <p>{@code role} defaults to the Erzeuger role ("pv-generation") and may also be
 * the Netz grid-meter role ("grid-meter", at most one per site). {@code
 * capacityKwp} is the per-Erzeuger nameplate that sums into the aggregate site PV
 * (ignored for a Netz meter, which has no nameplate). {@code registryUnitId} is
 * the source's OWN MaStR SEE number - optional (captain decision 3: capture it,
 * but never block adding a source when it is absent). {@code brand}/{@code model}
 * are informational (the edge reads the source; the portal just records what it
 * is).
 */
public record CreateMeasurementPointRequest(
        String role,
        @Size(max = 120) String label,
        @Size(max = 60) String brand,
        @Size(max = 60) String model,
        @DecimalMin(value = "0.0") @DecimalMax(value = "10000.0") BigDecimal capacityKwp,
        @Size(max = 40) String registryUnitId) {
}
