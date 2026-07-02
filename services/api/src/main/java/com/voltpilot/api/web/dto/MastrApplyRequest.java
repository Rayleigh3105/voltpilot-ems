package com.voltpilot.api.web.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Positive;
import java.math.BigDecimal;
import java.time.LocalDate;

/**
 * Persist the CONFIRMED registry values onto the site's assets. The values are
 * the ones the customer just previewed and confirmed (registry data is a
 * customer-confirmed prefill, not ground truth) - so they travel back from the
 * client rather than being re-fetched, range-checked here, and land only in
 * the caller's own tenant via RLS. At least one of {@code pv}/{@code storage}
 * must be present.
 */
public record MastrApplyRequest(@Valid PvApply pv, @Valid StorageApply storage) {

    public boolean isEmpty() {
        return pv == null && storage == null;
    }

    public record PvApply(
            @NotBlank @Pattern(regexp = "SEE\\d{12}") String mastrNummer,
            @Positive BigDecimal capacityKwp,
            @Positive Integer moduleCount,
            @DecimalMin("0") @DecimalMax("359.9") BigDecimal azimuthDeg,
            @DecimalMin("0") @DecimalMax("90") BigDecimal tiltDeg,
            LocalDate commissionedOn) {
    }

    public record StorageApply(
            @NotBlank @Pattern(regexp = "SEE\\d{12}") String mastrNummer,
            @Positive BigDecimal capacityKwh,
            @Positive BigDecimal maxChargeKw,
            @Positive BigDecimal maxDischargeKw,
            LocalDate commissionedOn) {
    }
}
