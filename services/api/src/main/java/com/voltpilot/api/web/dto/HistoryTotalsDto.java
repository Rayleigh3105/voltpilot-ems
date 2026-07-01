package com.voltpilot.api.web.dto;

import java.math.BigDecimal;

/**
 * Period aggregates of a history window. Formulas (documented once, here):
 *
 * <ul>
 *   <li>{@code gridCostEur} = sum over 15-min slots of (import kWh x the
 *       matching day-ahead price EUR/MWh / 1000); null when no price data
 *       overlaps the period at all.</li>
 *   <li>{@code batterySavingsEur} = sum of (baseline_cost_eur - cost_eur) over
 *       the persisted optimizer schedule slots in the period (latest run per
 *       slot); null when no plan covers any slot ("where plans exist").</li>
 *   <li>{@code autarkiePct} (Autarkiegrad) = (1 - grid import / consumption)
 *       x 100, clamped to 0..100; null when consumption is zero.</li>
 *   <li>{@code eigenverbrauchPct} (Eigenverbrauchsquote) = (pv generated -
 *       grid export) / pv generated x 100, clamped to 0..100; null when no PV
 *       was generated. Approximation: all exported energy is attributed to PV
 *       (battery-to-grid export is not separated in v1).</li>
 * </ul>
 */
public record HistoryTotalsDto(
        BigDecimal consumptionKwh,
        BigDecimal pvGenerationKwh,
        BigDecimal gridImportKwh,
        BigDecimal gridExportKwh,
        BigDecimal gridCostEur,
        BigDecimal batterySavingsEur,
        BigDecimal autarkiePct,
        BigDecimal eigenverbrauchPct) {
}
