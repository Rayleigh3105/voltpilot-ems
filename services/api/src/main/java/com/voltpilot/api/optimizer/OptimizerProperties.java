package com.voltpilot.api.optimizer;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * The api-side MIRROR of the optimizer's platform tunables
 * ({@code voltpilot.optimizer.*}, see services/optimization
 * {@code voltpilot_optimization/config.py} for the authoritative semantics and
 * default derivations). The api never optimizes - it only DISPLAYS these
 * (admin optimizer-config panel, diagnostics decomposition), so the compose
 * files pass the SAME {@code OPTIMIZER_*} environment variables to the api and
 * the optimization container; keep them in sync or the panel shows a default
 * the solver is not actually using (the {@code VOLTPILOT_ACTIVE_*_MODEL}
 * precedent).
 *
 * <ul>
 * <li>{@code defaultWearCostCtPerKwh} - platform battery wear cost per kWh
 * cycled ({@code OPTIMIZER_WEAR_COST_CT_PER_KWH}, default 4.0); the nullable
 * per-asset {@code asset.wear_cost_ct_per_kwh} overrides it.</li>
 * <li>{@code terminalValueQuantile} - the P3 best-use price quantile anchoring
 * the derived terminal energy value ({@code OPTIMIZER_TERMINAL_VALUE_QUANTILE},
 * default 0.3). Read-only in the admin panel (env-level, needs a redeploy).</li>
 * <li>{@code terminalValueCtPerKwh} - the fixed platform terminal-value
 * override ({@code OPTIMIZER_TERMINAL_VALUE_CT_PER_KWH}); blank = derive per
 * plan. Kept as the raw string so "unset" stays distinguishable from 0.</li>
 * <li>{@code eegRatesJson} - wholesale feste-Vergütung schedule override
 * ({@code OPTIMIZER_EEG_RATES_JSON}); blank = the built-in schedule. Parsed by
 * {@link EegRates#fromJson(String)} so the api's per-slot export values follow
 * the same correction the solver got.</li>
 * </ul>
 */
@ConfigurationProperties(prefix = "voltpilot.optimizer")
public record OptimizerProperties(
        double defaultWearCostCtPerKwh,
        double terminalValueQuantile,
        String terminalValueCtPerKwh,
        String eegRatesJson) {

    /** The platform usable-SoC band (domain.py DEFAULT_SOC_MIN/MAX_FRACTION). */
    public static final double DEFAULT_SOC_MIN_PCT = 5.0;
    public static final double DEFAULT_SOC_MAX_PCT = 95.0;

    public OptimizerProperties {
        if (defaultWearCostCtPerKwh < 0) {
            defaultWearCostCtPerKwh = 4.0;
        }
        if (terminalValueQuantile <= 0 || terminalValueQuantile > 1) {
            terminalValueQuantile = 0.3;
        }
    }

    /** The fixed terminal-value override in ct per stored kWh, or null (derive). */
    public Double terminalValueOverrideCtPerKwh() {
        if (terminalValueCtPerKwh == null || terminalValueCtPerKwh.isBlank()) {
            return null;
        }
        try {
            return Double.parseDouble(terminalValueCtPerKwh.trim());
        } catch (NumberFormatException e) {
            return null; // display-only mirror: never fail the api on a bad env
        }
    }
}
