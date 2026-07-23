package com.voltpilot.api.web.dto;

import java.math.BigDecimal;

/**
 * Period aggregates of a history window. Formulas (documented once, here):
 *
 * <ul>
 *   <li>The four energy sums ({@code consumptionKwh}, {@code pvGenerationKwh},
 *       {@code gridImportKwh}, {@code gridExportKwh}) sum the period's buckets;
 *       each is <b>null when not a single bucket carried that channel</b> - the
 *       project's standing "— never a fabricated 0" discipline, which the cost
 *       fields already followed (audit V2/X1). A 0-bucket day therefore returns
 *       null everywhere instead of a confident 0,0 kWh.</li>
 *   <li>{@code gridCostEur} = sum over 15-min slots of (import kWh x the
 *       matching day-ahead price EUR/MWh / 1000); null when no price data
 *       overlaps the period at all. <b>This is always the bare SPOT cost</b> -
 *       it does NOT apply the site's configured retail tariff. {@code tarifArt}
 *       carries that context so the surface can label the number truthfully
 *       ("zu Börsenpreisen" when the site has no tariff configured; audit H8).</li>
 *   <li>{@code tarifArt} = the site's configured tariff kind
 *       ({@code dynamisch} | {@code fest} | {@code ohne}); null only when the
 *       site row is unreadable. Context for {@code gridCostEur}, not a
 *       period aggregate.</li>
 *   <li>{@code batterySavingsPlannedEur} = sum of (baseline_cost_eur -
 *       cost_eur) over the persisted optimizer schedule slots in the period
 *       (latest run per slot); null when no plan covers any slot ("where plans
 *       exist"). <b>This is the EX-ANTE PLANNED number</b>, not measured money:
 *       the measured counterpart is {@code savedEur} on
 *       {@code GET /api/v1/earnings}, and the two legitimately differ by a
 *       large factor. Any surface rendering it MUST say "geplant" (audit
 *       H3/X2).</li>
 *   <li>{@code batterySavingsEur} - <b>deprecated</b> alias of
 *       {@code batterySavingsPlannedEur}, kept for one release so the portal can
 *       switch independently. Same value; do not add new readers.</li>
 *   <li>{@code autarkiePct} (Autarkiegrad) = (1 - grid import / consumption)
 *       x 100, clamped to 0..100; null when consumption is zero or unknown.</li>
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
        String tarifArt,
        BigDecimal batterySavingsPlannedEur,
        // DEPRECATED alias of batterySavingsPlannedEur - same value, one release.
        BigDecimal batterySavingsEur,
        BigDecimal autarkiePct,
        BigDecimal eigenverbrauchPct) {

    /**
     * Canonical constructor for callers that carry the planned savings once:
     * mirrors it onto the deprecated alias so both fields stay in lockstep.
     */
    public static HistoryTotalsDto of(BigDecimal consumptionKwh, BigDecimal pvGenerationKwh,
            BigDecimal gridImportKwh, BigDecimal gridExportKwh, BigDecimal gridCostEur,
            String tarifArt, BigDecimal batterySavingsPlannedEur, BigDecimal autarkiePct,
            BigDecimal eigenverbrauchPct) {
        return new HistoryTotalsDto(consumptionKwh, pvGenerationKwh, gridImportKwh, gridExportKwh,
                gridCostEur, tarifArt, batterySavingsPlannedEur, batterySavingsPlannedEur,
                autarkiePct, eigenverbrauchPct);
    }
}
