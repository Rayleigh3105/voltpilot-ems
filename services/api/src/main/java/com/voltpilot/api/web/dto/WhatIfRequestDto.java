package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The admin what-if knobs (design vp-admin-optimizer-ui-design §2.8/§4.3).
 *
 * <p>Every field is OPTIONAL and {@code null} means "leave this as the site
 * has it" - never "set it to zero". That is what makes an empty body a
 * meaningful request: it re-solves the site exactly as configured, which is
 * the baseline the variant is compared against.
 *
 * <p>{@code backupReserveSocPct = 0} IS "no reserve" (a 0 % floor and no floor
 * are the same constraint), so no separate clear flag is needed.
 *
 * <p>Deliberately NOT overridable here: prices, forecasts, tariff, §14a and
 * the feed-in cap all come from the real site, so a preview can never become
 * a fantasy plant.
 */
public record WhatIfRequestDto(
        @DecimalMin("0.0") @DecimalMax("100.0") BigDecimal wearCostCtPerKwh,
        @DecimalMin("0.0") @DecimalMax("100.0") BigDecimal backupReserveSocPct,
        @DecimalMin("0.0") @DecimalMax("100.0") BigDecimal socMinPct,
        @DecimalMin("0.0") @DecimalMax("100.0") BigDecimal socMaxPct,
        Boolean netzladenErlaubt,
        @Min(4) @Max(192) Integer horizonSlots) {

    /** The overrides as the solve service's camelCase JSON (omitting untouched knobs). */
    public Map<String, Object> overrides() {
        Map<String, Object> doc = new LinkedHashMap<>();
        put(doc, "wearCostCtPerKwh", wearCostCtPerKwh);
        put(doc, "backupReserveSocPct", backupReserveSocPct);
        put(doc, "socMinPct", socMinPct);
        put(doc, "socMaxPct", socMaxPct);
        if (netzladenErlaubt != null) {
            doc.put("netzladenErlaubt", netzladenErlaubt);
        }
        return doc;
    }

    private static void put(Map<String, Object> doc, String key, BigDecimal value) {
        if (value != null) {
            doc.put(key, value);
        }
    }
}
