package com.voltpilot.api.web;

import java.math.BigDecimal;
import java.util.Map;

/**
 * The customer-facing Speicherschonung presets (FK4): "Umgang mit dem Speicher"
 * as a ladder over the ONE existing optimizer parameter
 * {@code asset.wear_cost_ct_per_kwh} (ct per kWh cycled; the optimizer reads it
 * per 15-min cycle, so a preset takes effect on the next plan with NO optimizer
 * change). The ladder is derived from the tipping-point analysis in the
 * vp-solver-xlsx-f2 audit (§4.4): up to ~10 ct the daily PV-shift dispatch is
 * invariant, trimming starts around ~12 ct - so the presets differentiate only
 * on MARGINAL opportunities (flat spreads, micro-arbitrage), which is exactly
 * where "schonend vs. aggressiv" belongs.
 *
 * <p>This is THE mapping constant - both directions (preset -> ct on write,
 * stored ct -> preset on read) derive from {@link #PRESET_WEAR_CT}. The read
 * side maps NULL to {@code ausgewogen} (the stored NULL means "platform
 * default", which is the same 4.0 ct), and any other value to
 * {@link #INDIVIDUELL} - an admin set a custom value via the optimizer-config
 * surface; the portal shows it honestly and a customer preset pick simply
 * overwrites it. The raw ct value itself stays admin-only (optimizer-config).
 */
public final class Speicherschonung {

    /** The preset ladder: preset name -> wear cost in ct per kWh cycled. */
    public static final Map<String, BigDecimal> PRESET_WEAR_CT = Map.of(
            "aggressiv", new BigDecimal("1"),
            "ausgewogen", new BigDecimal("4"),
            "schonend", new BigDecimal("8"));

    /** NULL stored wear = the platform default 4.0 ct = the ausgewogen preset. */
    public static final String DEFAULT_PRESET = "ausgewogen";

    /** A stored value outside the ladder: an admin-configured custom wear cost. */
    public static final String INDIVIDUELL = "individuell";

    private Speicherschonung() {
    }

    /** The wear cost a preset writes; the caller validates the preset name. */
    public static BigDecimal wearCtFor(String preset) {
        BigDecimal ct = PRESET_WEAR_CT.get(preset);
        if (ct == null) {
            throw new IllegalArgumentException("Unknown Speicherschonung preset: " + preset);
        }
        return ct;
    }

    /** The effective preset for a stored wear cost (numeric match, so 4.000 = ausgewogen). */
    public static String presetFor(BigDecimal storedWearCt) {
        if (storedWearCt == null) {
            return DEFAULT_PRESET;
        }
        return PRESET_WEAR_CT.entrySet().stream()
                .filter(e -> e.getValue().compareTo(storedWearCt) == 0)
                .map(Map.Entry::getKey)
                .findFirst()
                .orElse(INDIVIDUELL);
    }
}
