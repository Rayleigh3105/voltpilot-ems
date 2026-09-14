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
 *       slot's IMPORT PRICE). Since Stufe 3 of the structured Bezugspreis
 *       (report vp-nacht-bezug-e7 §3.4) the import price is the SAME per-slot
 *       composition the optimizer plans with (SlotEconomics.importPriceCtSql:
 *       flat tariff / spot + Aufschlag / (spot + Preisblatt-Komponenten) x
 *       (1+USt)); a site without any price data stays at bare spot,
 *       byte-identical to before. Valued at the CURRENTLY maintained
 *       tariff/sheet - no price-sheet history (documented v1 simplification).
 *       Null when nothing is computable in the period.</li>
 *   <li>{@code tarifArt} = the site's configured tariff kind
 *       ({@code dynamisch} | {@code fest} | {@code ohne}); null only when the
 *       site row is unreadable. Context for {@code gridCostEur}, not a
 *       period aggregate.</li>
 *   <li>{@code tarifPriced} = whether the import valuation engaged a real
 *       tariff/Preisblatt beyond bare spot - drives the honest "bewertet zu
 *       Ihrem Stromtarif" vs "zu Börsenpreisen" label (a bare {@code tarifArt}
 *       echo cannot tell an {@code ohne} site with a maintained Preisblatt
 *       from one without). Null only alongside a null {@code tarifArt}.</li>
 *   <li>{@code batterySavingsPlannedEur} = sum of (baseline_cost_eur -
 *       cost_eur) over the persisted optimizer schedule slots in the period
 *       (latest run per slot); null when no plan covers any slot ("where plans
 *       exist"). <b>This is the EX-ANTE PLANNED number</b>, not measured money:
 *       the measured counterpart is {@code savedEur} on
 *       {@code GET /api/v1/earnings}, and the two legitimately differ by a
 *       large factor. Any surface rendering it MUST say "geplant" (audit
 *       H3/X2).</li>
 *   <li>{@code steuerungPlannedEur} = sum of (stur_cost_eur - cost_eur) over
 *       the SAME plan slots: what the plan earns against <b>the same battery
 *       WITHOUT smart control</b> - the stur self-consumption reference of
 *       {@code services/optimization/voltpilot_optimization/stur.py}, whose
 *       measured twin is {@code savedSteuerungEur} on {@code /earnings}.
 *       <b>This is the number the customer surface shows</b> (Captain
 *       04.09.2026: "du musst Anlage immer mit Speicher berechnen, einer halt
 *       ohne smart Steuerung"); {@code batterySavingsPlannedEur} keeps
 *       answering the operator/optimizer question. It is <b>null when even ONE
 *       covered slot of the window carries no Messlatte</b> (a run that
 *       predates migration V20260867000000, or a site the optimizer plans no
 *       battery for) - a partial sum would describe a window nobody computed,
 *       so the surface hides the line instead of understating it. By
 *       construction {@code steuerungPlannedEur <= batterySavingsPlannedEur}:
 *       a stur battery is better than none. Like its sibling it is EX-ANTE
 *       PLANNED money - any surface rendering it MUST say "geplant".</li>
 *   <li>{@code batterySavingsEur} - <b>deprecated</b> alias of
 *       {@code batterySavingsPlannedEur}, kept for one release so the portal can
 *       switch independently. Same value; do not add new readers.</li>
 *   <li>{@code autarkiePct} (Autarkiegrad) = (1 - grid import / consumption)
 *       x 100, <b>not clamped</b>; null when consumption is zero or unknown.</li>
 *   <li>{@code eigenverbrauchPct} (Eigenverbrauchsquote) = (pv generated -
 *       grid export) / pv generated x 100, <b>not clamped</b>; null when no PV
 *       was generated. Approximation: all exported energy is attributed to PV
 *       (battery-to-grid export is not separated in v1).</li>
 *   <li>{@code autarkieUnplausibel} / {@code eigenverbrauchUnplausibel} = the
 *       delivered ratio lies outside 0..100 - the meters do not add up (import
 *       above consumption, export above generation). The value is NOT bent
 *       back into the range (AP-10 E16 Nr. 5): a clamped 100 % would read as a
 *       perfect result. The portal then says "Messwerte passen nicht zusammen"
 *       instead of drawing the ratio. Null exactly when the ratio is null
 *       (unknown is not "plausible"); derived here, once, from the delivered
 *       value, so no caller can send a value and a flag that disagree.</li>
 * </ul>
 */
public record HistoryTotalsDto(
        BigDecimal consumptionKwh,
        BigDecimal pvGenerationKwh,
        BigDecimal gridImportKwh,
        BigDecimal gridExportKwh,
        BigDecimal gridCostEur,
        String tarifArt,
        Boolean tarifPriced,
        BigDecimal batterySavingsPlannedEur,
        // DEPRECATED alias of batterySavingsPlannedEur - same value, one release.
        BigDecimal batterySavingsEur,
        BigDecimal steuerungPlannedEur,
        BigDecimal autarkiePct,
        BigDecimal eigenverbrauchPct,
        Boolean autarkieUnplausibel,
        Boolean eigenverbrauchUnplausibel) {

    /**
     * Canonical constructor for callers that carry the planned savings once:
     * mirrors it onto the deprecated alias so both fields stay in lockstep.
     */
    public static HistoryTotalsDto of(BigDecimal consumptionKwh, BigDecimal pvGenerationKwh,
            BigDecimal gridImportKwh, BigDecimal gridExportKwh, BigDecimal gridCostEur,
            String tarifArt, Boolean tarifPriced, BigDecimal batterySavingsPlannedEur,
            BigDecimal autarkiePct, BigDecimal eigenverbrauchPct) {
        return of(consumptionKwh, pvGenerationKwh, gridImportKwh, gridExportKwh, gridCostEur,
                tarifArt, tarifPriced, batterySavingsPlannedEur, null,
                autarkiePct, eigenverbrauchPct);
    }

    /** Canonical constructor carrying BOTH planned figures (see above). */
    public static HistoryTotalsDto of(BigDecimal consumptionKwh, BigDecimal pvGenerationKwh,
            BigDecimal gridImportKwh, BigDecimal gridExportKwh, BigDecimal gridCostEur,
            String tarifArt, Boolean tarifPriced, BigDecimal batterySavingsPlannedEur,
            BigDecimal steuerungPlannedEur,
            BigDecimal autarkiePct, BigDecimal eigenverbrauchPct) {
        return new HistoryTotalsDto(consumptionKwh, pvGenerationKwh, gridImportKwh, gridExportKwh,
                gridCostEur, tarifArt, tarifPriced, batterySavingsPlannedEur,
                batterySavingsPlannedEur, steuerungPlannedEur,
                autarkiePct, eigenverbrauchPct,
                unplausibel(autarkiePct), unplausibel(eigenverbrauchPct));
    }

    /** A share outside 0..100 cannot be a share; null stays null. */
    static Boolean unplausibel(BigDecimal pct) {
        if (pct == null) {
            return null;
        }
        return pct.signum() < 0 || pct.compareTo(BigDecimal.valueOf(100)) > 0;
    }
}
