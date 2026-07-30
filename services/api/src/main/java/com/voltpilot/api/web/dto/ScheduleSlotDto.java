package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

/**
 * One planned 15-min slot of an optimizer run. {@code batteryKw} is signed
 * +charge/-discharge (the frozen schedule contract), {@code gridKw} is signed
 * +import/-export (the telemetry convention); costs are the projected slot cost
 * with the plan vs. with the battery idle (the no-battery baseline).
 *
 * <p>{@code curtailKw} is the planned PV curtailment for the slot (kW the
 * optimizer holds back, only ever &gt;= 0 - {@code schedule.curtail_kw},
 * migration V20260706040000): at negative prices the optimizer curtails feed-in
 * so the plant does not pay to export, and the portal surfaces the avoided loss
 * ("heute X kWh abgeregelt, Y € Verlust vermieden"). Null on runs that predate
 * the curtailment column or slots without curtailment data.
 *
 * <p>{@code pvKw} is the PV forecast input the slot planned with
 * ({@code schedule.pv_kw}). It feeds the portal's pv-aware "Laden aus dem
 * Netz" derivation: since FK3 (PV-bus semantics) an EEG site legitimately
 * charges solar while the house imports its load, so grid-charging is only
 * charge BEYOND the slot's available PV - not merely charging while
 * importing. Null on rows without a persisted PV input.
 *
 * <p>{@code loadKw} is the LOAD (consumption) forecast input the slot planned
 * with ({@code schedule.load_kw}). Together with {@code pvKw} it is what the
 * portal draws as the two forecast lines over the Fahrplan bars, so the plan
 * EXPLAINS itself ("warum hält er abends? da liegt die Nachtlast"). Null on
 * rows without a persisted load input - the line is then simply absent, never
 * a fabricated 0.
 *
 * <p><b>Fahrplan-Warum fields</b> (migration V20260723030000, design scout
 * vp-fahrplan-why-design §5.1) - the optimizer-persisted decision facts:
 * {@code slotRole} is the §6 vocabulary id (warten | pv_speichern |
 * guenstig_laden | eigenverbrauch | verkaufen | spitze_kappen |
 * reserve_halten | abregeln); {@code slotFlags} the binding-constraint codes
 * (soc_max, soc_floor, reserve_backup, reserve_peak, charge_cap,
 * discharge_cap, solar_only, grid_limit_14a, feed_in_cap, peak_defining,
 * curtailing - split from the persisted CSV); {@code storedValueCtKwh} the
 * EXACT value of a stored kWh at slot end (the run's SoC shadow price,
 * ct/kWh); {@code gridValueCtKwh} the effective per-kWh energy value at the
 * grid connection point; {@code peakPressureEurKw} the Leistungspreis
 * allocation on the slot (EUR/kW, null when the site runs no peak module).
 * All null on pre-feature rows or runs whose explain layer was off/failed -
 * the portal then renders exactly today's view (its {@code chargeKind}
 * fallback), never a fabricated explanation.
 *
 * <p><b>Der Preis, mit dem entschieden wurde</b> (P0 "Textwahrheit", report
 * vp-netzbezug-nacht-s3 §6): {@code priceEurMwh} is the bare SPOT price, but
 * the optimizer decides against the site's REAL import price / export value -
 * so a customer sentence built on spot regularly contradicts itself ("21,2
 * wäre teurer als 21,5"). {@code importPriceCtKwh} is what one imported kWh
 * really costs the site in this slot, {@code exportValueCtKwh} what one
 * exported kWh really earns, and {@code importPriceSource} names WHICH rule
 * priced the import ({@code fest} | {@code preisblatt} |
 * {@code sammelaufschlag} | {@code default-flag} | {@code spot}). All three
 * are a pure PASS-THROUGH of the existing {@link
 * com.voltpilot.api.optimizer.SlotEconomics} recomposition the admin
 * diagnostics already runs - no second price rule. Null when the slot has no
 * persisted spot price (or the site is hidden), and the portal then degrades
 * to a number-free sentence rather than passing spot off as "Netzstrom".
 *
 * <p><b>Ist-Last</b> (P3 "Ehrlichkeit im Fahrplan", report vp-netzbezug-nacht-s3
 * §6): {@code measuredLoadKw} is the MEASURED house consumption of this slot -
 * the quarter-hour MEAN of {@code telemetry.load_kw}, the same aggregation the
 * forecaster plans with since P2. It is present only for slots that already
 * happened (the running slot carries the mean of the samples so far), so the
 * portal can draw it as a solid line next to the dotted {@code loadKw} forecast
 * and the forecast error - the one that made Pilsting draw from the grid at
 * night - becomes visible. Null for future slots, for slots without telemetry
 * and on sites that report no load channel: the line is then simply absent,
 * never a fabricated 0.
 */
public record ScheduleSlotDto(
        Instant start,
        BigDecimal batteryKw,
        BigDecimal gridKw,
        BigDecimal socPct,
        BigDecimal priceEurMwh,
        BigDecimal costEur,
        BigDecimal baselineCostEur,
        BigDecimal curtailKw,
        BigDecimal pvKw,
        BigDecimal loadKw,
        String slotRole,
        List<String> slotFlags,
        BigDecimal storedValueCtKwh,
        BigDecimal gridValueCtKwh,
        BigDecimal peakPressureEurKw,
        BigDecimal importPriceCtKwh,
        BigDecimal exportValueCtKwh,
        String importPriceSource,
        BigDecimal measuredLoadKw) {

    /** The same slot with its decision prices filled in (P0 Textwahrheit). */
    public ScheduleSlotDto withPrices(
            BigDecimal importPriceCtKwh, BigDecimal exportValueCtKwh, String importPriceSource) {
        return new ScheduleSlotDto(start, batteryKw, gridKw, socPct, priceEurMwh, costEur,
                baselineCostEur, curtailKw, pvKw, loadKw, slotRole, slotFlags, storedValueCtKwh,
                gridValueCtKwh, peakPressureEurKw,
                importPriceCtKwh, exportValueCtKwh, importPriceSource, measuredLoadKw);
    }

    /** The same slot with its MEASURED load filled in (P3 Ist-Last). */
    public ScheduleSlotDto withMeasuredLoadKw(BigDecimal measuredLoadKw) {
        return new ScheduleSlotDto(start, batteryKw, gridKw, socPct, priceEurMwh, costEur,
                baselineCostEur, curtailKw, pvKw, loadKw, slotRole, slotFlags, storedValueCtKwh,
                gridValueCtKwh, peakPressureEurKw,
                importPriceCtKwh, exportValueCtKwh, importPriceSource, measuredLoadKw);
    }
}
