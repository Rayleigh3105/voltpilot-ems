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
 * <li>{@code valueOfStoredEnergyCtKwh} - forward best-use APPROXIMATION of a
 * stored kWh's worth (the run-level flag marks it as such).</li>
 * <li>{@code decisionLabel} - solarladen | netzladen | entladen | ruhe (the
 * schedule.ts chargeKind twin); curtailment is orthogonal, read
 * {@code curtailKw}.</li>
 * <li>{@code whyText} - one composed German sentence explaining the decision
 * from those numbers.</li>
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
        String whyText) {
}
