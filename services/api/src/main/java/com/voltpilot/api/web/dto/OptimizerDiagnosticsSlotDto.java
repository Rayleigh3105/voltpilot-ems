package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * One plan slot of the admin optimizer diagnostics: the persisted schedule
 * columns (BigDecimal pass-through, null where the optimizer wrote none) plus
 * the computed €-decomposition in ct/kWh (Double; null = honestly not
 * computable for this slot - see {@link OptimizerDiagnosticsDto}).
 *
 * <ul>
 * <li>{@code solverPriceCtKwh} - the bare day-ahead SPOT price the persisted
 * {@code price_eur_mwh} carries (/10 = ct/kWh).</li>
 * <li>{@code importPriceCtKwh}/{@code exportValueCtKwh} - the REAL per-slot
 * import cost / export value per the site's tariff and remuneration (the P1
 * pricing the solver optimized against; com.voltpilot.api.optimizer
 * .SlotEconomics mirrors services/optimization pricing.py).</li>
 * <li>{@code wearCostEur} - the persisted P2 wear this slot spends;
 * {@code wearCostCtKwh} the derived rate per kWh of throughput (null for idle
 * slots and pre-P2 rows).</li>
 * <li>{@code valueOfStoredEnergyCtKwh} - the value of a stored kWh: the
 * PERSISTED exact SoC shadow price ({@code schedule.stored_value_ct_kwh},
 * Fahrplan-Warum) where the run carries it, else the forward best-use
 * APPROXIMATION (the run-level flag marks which one applied).</li>
 * <li>{@code decisionLabel} - solarladen | netzladen | entladen | ruhe (the
 * schedule.ts chargeKind twin); curtailment is orthogonal, read
 * {@code curtailKw}.</li>
 * <li>{@code whyText} - one composed German sentence explaining the decision
 * from those numbers.</li>
 * <li>{@code slotRole}/{@code slotFlags} - the optimizer-persisted
 * Fahrplan-Warum role (§6 vocabulary) and binding-constraint codes; null on
 * pre-feature runs (the decision label above remains the fallback).</li>
 * <li>{@code limitDischargeToLoad} - whether this slot meets the emission rule
 * of the REDUCE-only right {@code limit_discharge_to_load} (Netz-null-Reduzieren,
 * 2026-09-08): a real planned DISCHARGE ({@code batteryKw < -0.05}) into a
 * planned grid exchange of ~ 0 ({@code |gridKw| <= 0.05}). ⚠ It is DERIVED here,
 * from this row's own two persisted numbers, because the flag is deliberately
 * not persisted (like its three siblings) - it needs neither lambda nor a price,
 * which is exactly why it can be recomputed exactly. So it states "this slot's
 * SHAPE grants the right", never "the box received the flag": a run published
 * while {@code OPTIMIZER_LIMIT_DISCHARGE_ENABLED} was off, or by an optimizer
 * older than the field, carries the same shape and would read the same. Null =
 * the row carries no battery or grid power at all, so nothing can be said.</li>
 * </ul>
 */
public record OptimizerDiagnosticsSlotDto(
        Instant time,
        BigDecimal batteryKw,
        BigDecimal gridKw,
        BigDecimal socPct,
        BigDecimal loadKw,
        BigDecimal pvKw,
        BigDecimal curtailKw,
        BigDecimal costEur,
        BigDecimal baselineCostEur,
        BigDecimal wearCostEur,
        Double solverPriceCtKwh,
        Double importPriceCtKwh,
        Double exportValueCtKwh,
        Double wearCostCtKwh,
        Double valueOfStoredEnergyCtKwh,
        String decisionLabel,
        String whyText,
        String slotRole,
        java.util.List<String> slotFlags,
        Boolean limitDischargeToLoad) {
}
