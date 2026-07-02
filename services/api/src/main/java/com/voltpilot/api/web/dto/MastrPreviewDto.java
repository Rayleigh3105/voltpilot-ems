package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;

/**
 * The mapped registry record shown for CONFIRMATION before anything is
 * persisted ("Anlage verknüpfen" step 2). Nullable fields mean "nicht im
 * Register hinterlegt" - Balkonkraftwerke carry no orientation, masked
 * residential units no name - and the portal renders that honestly.
 *
 * <p>{@code kind} is what the REGISTRY says the unit is ("pv" / "storage"),
 * regardless of which input field the customer used. {@code plz}/{@code ort}
 * are the registry's (masking-safe) location for the customer's own
 * plausibility check - never used to update site coordinates.
 */
public record MastrPreviewDto(
        String mastrNummer,
        String kind,
        String name,
        String status,
        String plantType,
        BigDecimal powerKw,
        BigDecimal inverterPowerKw,
        Integer moduleCount,
        String azimuthLabel,
        BigDecimal azimuthDeg,
        String tiltLabel,
        BigDecimal tiltDeg,
        LocalDate commissionedOn,
        BigDecimal storageCapacityKwh,
        BigDecimal chargePowerKw,
        String batteryTechnology,
        String plz,
        String ort,
        String linkedUnitNumber,
        List<String> warnings) {
}
