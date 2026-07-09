package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;

/**
 * Record an additional Erzeuger (PV) measurement point (master data only - no
 * second device claim; the source is read through the site's one claimed edge).
 *
 * <p>{@code role} defaults to and, in Phase 1, must be the Erzeuger role
 * ("pv-generation"). {@code capacityKwp} is the per-source nameplate that sums
 * into the aggregate site PV. {@code registryUnitId} is the source's OWN MaStR
 * SEE number - optional (captain decision 3: capture it, but never block adding
 * a source when it is absent). {@code brand}/{@code model} are informational
 * (the edge reads the source; the portal just records what it is).
 */
public record CreateMeasurementPointRequest(
        String role,
        @Size(max = 120) String label,
        @Size(max = 60) String brand,
        @Size(max = 60) String model,
        @DecimalMin(value = "0.0") @DecimalMax(value = "10000.0") BigDecimal capacityKwp,
        @Size(max = 40) String registryUnitId) {
}
