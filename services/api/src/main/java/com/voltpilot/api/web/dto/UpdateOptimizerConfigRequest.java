package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import java.math.BigDecimal;

/**
 * Write the per-site / per-asset optimizer overrides (admin panel, design
 * §2.7). FULL-REPRESENTATION for the four override fields: the body IS the
 * override state - a null field CLEARS that override back to the platform
 * default, exactly matching the columns' NULL semantics. (The panel reads the
 * current state via GET and sends the whole set back.)
 *
 * <p>Cross-field validation (effective SoC band must stay a real window, a
 * battery-less site cannot carry battery overrides) happens in the controller
 * where the platform defaults and the site's assets are known.
 */
public record UpdateOptimizerConfigRequest(
        @DecimalMin(value = "0", message = "wearCostCtPerKwh must be >= 0")
        BigDecimal wearCostCtPerKwh,

        @DecimalMin(value = "0", message = "socMinPct must be within 0..100")
        @DecimalMax(value = "100", message = "socMinPct must be within 0..100")
        BigDecimal socMinPct,

        @DecimalMin(value = "0", message = "socMaxPct must be within 0..100")
        @DecimalMax(value = "100", message = "socMaxPct must be within 0..100")
        BigDecimal socMaxPct,

        @DecimalMin(value = "0", message = "backupReserveSocPct must be within 0..100")
        @DecimalMax(value = "100", message = "backupReserveSocPct must be within 0..100")
        BigDecimal backupReserveSocPct) {

    /** True when any of the battery-asset override fields is set. */
    public boolean touchesBattery() {
        return wearCostCtPerKwh != null || socMinPct != null || socMaxPct != null;
    }
}
