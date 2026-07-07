package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;
import java.math.BigDecimal;
import java.util.UUID;

/**
 * Customer-entered battery master data (the manual, non-MaStR path) plus the
 * optional controlling-device selection.
 *
 * <p>{@code capacityKwh}/{@code maxChargeKw}/{@code maxDischargeKw} are the
 * optimizer's inputs and required; {@code roundtripEfficiencyPct} is optional
 * (the platform default 92% applies when omitted). {@code deviceId} is the
 * device that controls this battery - optional: when omitted the api auto-links
 * the site's single device (if there is exactly one), which is the common case;
 * on a multi-device site the owner passes it explicitly.
 */
public record SaveBatteryRequest(
        @NotNull @Positive BigDecimal capacityKwh,
        @NotNull @Positive BigDecimal maxChargeKw,
        @NotNull @Positive BigDecimal maxDischargeKw,
        @DecimalMin("1.0") @DecimalMax("100.0") BigDecimal roundtripEfficiencyPct,
        UUID deviceId) {
}
