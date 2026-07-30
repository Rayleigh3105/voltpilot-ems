package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.SchedulePlanDto;
import com.voltpilot.api.web.dto.ScheduleSlotDto;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Optimizer plans for the current tenant's sites. The {@code schedule}
 * hypertable carries {@code tenant_id} and is RLS-scoped (migration
 * V20260701020000), so - like telemetry/weather - every query is transparently
 * narrowed to the caller's tenant. Written by services/optimization (one row
 * per plan slot); the api only reads the latest run per site.
 */
@Repository
public class ScheduleRepository {

    /**
     * The optimizer's default AC round-trip efficiency when the asset carries
     * none - MUST mirror services/optimization {@code inputs.load_battery_sites}
     * (0.92), so the reconstructed plan-start SoC matches the solver's.
     */
    private static final double DEFAULT_ROUNDTRIP_EFFICIENCY = 0.92;

    private final JdbcTemplate jdbc;

    public ScheduleRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** The most recent plan for a site, or {@code null} if none stored. */
    public SchedulePlanDto latestForSite(UUID siteId) {
        List<Instant> runs = jdbc.query(
                "SELECT max(generated_at) AS generated_at FROM schedule WHERE site_id = ?",
                (rs, i) -> {
                    var ts = rs.getTimestamp("generated_at");
                    return ts == null ? null : ts.toInstant();
                },
                siteId);
        Instant generatedAt = runs.isEmpty() ? null : runs.get(0);
        if (generatedAt == null) {
            return null;
        }
        List<ScheduleSlotDto> slots = jdbc.query(
                "SELECT time, battery_kw, grid_kw, soc_pct, price_eur_mwh, cost_eur, baseline_cost_eur, "
                        + "curtail_kw, pv_kw, load_kw, slot_role, slot_flags, stored_value_ct_kwh, "
                        + "grid_value_ct_kwh, peak_pressure_eur_kw "
                        + "FROM schedule WHERE site_id = ? AND generated_at = ? "
                        + "ORDER BY time ASC",
                (rs, i) -> new ScheduleSlotDto(
                        rs.getTimestamp("time").toInstant(),
                        rs.getBigDecimal("battery_kw"),
                        rs.getBigDecimal("grid_kw"),
                        rs.getBigDecimal("soc_pct"),
                        rs.getBigDecimal("price_eur_mwh"),
                        rs.getBigDecimal("cost_eur"),
                        rs.getBigDecimal("baseline_cost_eur"),
                        rs.getBigDecimal("curtail_kw"),
                        rs.getBigDecimal("pv_kw"),
                        rs.getBigDecimal("load_kw"),
                        rs.getString("slot_role"),
                        splitFlags(rs.getString("slot_flags")),
                        rs.getBigDecimal("stored_value_ct_kwh"),
                        rs.getBigDecimal("grid_value_ct_kwh"),
                        rs.getBigDecimal("peak_pressure_eur_kw"),
                        // The decision prices are not persisted columns - they are
                        // recomposed from spot + master data by SlotEconomics and
                        // filled in downstream (SchedulePricingService).
                        null, null, null,
                        // The MEASURED load is a separate aggregation (P3), see
                        // measuredLoadPerSlot below.
                        null),
                siteId, Timestamp.from(generatedAt));
        slots = MeasuredLoad.assign(slots, measuredLoadPerSlot(siteId, slots, 15));
        List<Object[]> meta = jdbc.query(
                "SELECT plan_id, device_id, terminal_value_eur_per_kwh, peak_target_kw, "
                        + "fallback_14a FROM schedule "
                        + "WHERE site_id = ? AND generated_at = ? LIMIT 1",
                (rs, i) -> new Object[] {
                        rs.getObject("plan_id", UUID.class),
                        rs.getObject("device_id", UUID.class),
                        rs.getBigDecimal("terminal_value_eur_per_kwh"),
                        rs.getBigDecimal("peak_target_kw"),
                        rs.getObject("fallback_14a", Boolean.class)
                },
                siteId, Timestamp.from(generatedAt));
        UUID planId = meta.isEmpty() ? null : (UUID) meta.get(0)[0];
        UUID deviceId = meta.isEmpty() ? null : (UUID) meta.get(0)[1];
        BigDecimal terminalValue = meta.isEmpty() ? null : (BigDecimal) meta.get(0)[2];
        BigDecimal peakTargetKw = meta.isEmpty() ? null : (BigDecimal) meta.get(0)[3];
        Boolean fallback14a = meta.isEmpty() ? null : (Boolean) meta.get(0)[4];
        BigDecimal savings = slots.stream()
                .map(s -> nz(s.baselineCostEur()).subtract(nz(s.costEur())))
                .reduce(BigDecimal.ZERO, BigDecimal::add);
        Banked banked = bankedValue(siteId, slots, terminalValue, 15);
        return new SchedulePlanDto(planId, deviceId, generatedAt, 15, savings,
                banked.valueEur(), banked.socStartPct(), banked.socEndPct(), peakTargetKw,
                fallback14a, slots);
    }

    /**
     * The MEASURED house consumption per plan slot (P3 "Ist-Last sichtbar",
     * report vp-netzbezug-nacht-s3 §6): the quarter-hour MEAN of
     * {@code telemetry.load_kw}, i.e. the SAME quantity the forecaster predicts
     * since P2 - so the portal's solid Ist line and its dotted Prognose line are
     * comparable by construction.
     *
     * <p>Read straight from RAW telemetry (the plan window is at most 24 h, and
     * the 15-min rollups lag their refresh by up to a quarter hour - the running
     * slot, where the forecast error actually shows, would be missing). The
     * query is RLS-scoped exactly like every other read here; the window ends at
     * {@code now}, so a future slot can never receive a value, and a slot with
     * no samples simply gets no row - null, never a fabricated 0.
     */
    private Map<Instant, BigDecimal> measuredLoadPerSlot(
            UUID siteId, List<ScheduleSlotDto> slots, int slotMinutes) {
        MeasuredLoad.Window window = MeasuredLoad.window(
                slots.stream().map(ScheduleSlotDto::start).toList(), slotMinutes, Instant.now());
        if (window == null) {
            return Map.of();
        }
        List<Object[]> rows = jdbc.query(
                "SELECT time_bucket('15 minutes', time) AS bucket, avg(load_kw) AS load_kw "
                        + "FROM telemetry "
                        + "WHERE site_id = ? AND time >= ? AND time < ? AND load_kw IS NOT NULL "
                        + "GROUP BY 1",
                (rs, i) -> new Object[] {
                        rs.getTimestamp("bucket").toInstant(),
                        rs.getBigDecimal("load_kw")
                },
                siteId, Timestamp.from(window.from()), Timestamp.from(window.to()));
        Map<Instant, BigDecimal> byBucket = new HashMap<>();
        for (Object[] row : rows) {
            BigDecimal value = (BigDecimal) row[1];
            if (value != null) {
                byBucket.put((Instant) row[0], value.setScale(3, RoundingMode.HALF_UP));
            }
        }
        return byBucket;
    }

    /**
     * The persisted Fahrplan-Warum binding CSV as a list ({@code null} stays
     * {@code null} - "keine Bindung erfasst" / pre-feature row, so the portal
     * can tell "no bindings recorded" from "explain never ran").
     */
    static List<String> splitFlags(String csv) {
        if (csv == null || csv.isBlank()) {
            return null;
        }
        return List.of(csv.split(","));
    }

    private record Banked(BigDecimal valueEur, BigDecimal socStartPct, BigDecimal socEndPct) {
        static final Banked NONE = new Banked(null, null, null);
    }

    /**
     * The run's banked terminal value (FK2, audit vp-solver-xlsx-f2 §4.3):
     * {@code terminal_value_eur_per_kwh x (SoC_end - SoC_start)} in EUR - the
     * value the optimizer credits for energy stored INTO (positive) or drawn
     * OUT OF (negative) the horizon. On bank days the headline savings read
     * negative although real value was stored; this is the honest companion
     * line.
     *
     * <p>The schedule table persists SoC only at slot END, so the plan-START
     * SoC is reconstructed by reversing the solver's first-slot dynamics
     * ({@code soc[1] = soc[0] + (eta*charge - discharge/eta) * dt}, solver.py)
     * with the battery asset's efficiency - exact up to the persisted
     * rounding, and identical to the {@code soc0} the objective credited
     * against. Null whenever honestly not computable: pre-FK2 runs (no
     * terminal value), no battery asset / capacity, or missing SoC data -
     * never a fabricated number.
     */
    private Banked bankedValue(
            UUID siteId, List<ScheduleSlotDto> slots, BigDecimal terminalValue, int slotMinutes) {
        if (slots.isEmpty()) {
            return Banked.NONE;
        }
        ScheduleSlotDto first = slots.get(0);
        ScheduleSlotDto last = slots.get(slots.size() - 1);
        if (first.socPct() == null || last.socPct() == null) {
            return Banked.NONE;
        }
        List<Object[]> battery = jdbc.query(
                "SELECT capacity_kwh, roundtrip_efficiency_pct FROM asset "
                        + "WHERE site_id = ? AND type = 'battery' AND is_primary",
                (rs, i) -> new Object[] {
                        rs.getBigDecimal("capacity_kwh"),
                        rs.getBigDecimal("roundtrip_efficiency_pct")
                },
                siteId);
        BigDecimal capacity = battery.isEmpty() ? null : (BigDecimal) battery.get(0)[0];
        if (capacity == null || capacity.signum() <= 0) {
            return Banked.NONE;
        }
        BigDecimal efficiencyPct = battery.isEmpty() ? null : (BigDecimal) battery.get(0)[1];
        double roundtrip = efficiencyPct == null
                ? DEFAULT_ROUNDTRIP_EFFICIENCY
                : efficiencyPct.doubleValue() / 100.0;
        double eta = Math.sqrt(roundtrip);
        double batteryKw = first.batteryKw() == null ? 0.0 : first.batteryKw().doubleValue();
        double chargeKw = Math.max(batteryKw, 0.0);
        double dischargeKw = Math.max(-batteryKw, 0.0);
        double dtHours = slotMinutes / 60.0;
        double capacityKwh = capacity.doubleValue();
        double firstSlotDeltaPct =
                (eta * chargeKw - dischargeKw / eta) * dtHours / capacityKwh * 100.0;
        double socStartPct = first.socPct().doubleValue() - firstSlotDeltaPct;
        double socEndPct = last.socPct().doubleValue();
        BigDecimal socStart = BigDecimal.valueOf(socStartPct).setScale(2, RoundingMode.HALF_UP);
        BigDecimal socEnd = last.socPct();
        if (terminalValue == null) {
            // SoC bounds are still honest to show; the euro line needs V_end.
            return new Banked(null, socStart, socEnd);
        }
        double bankedEur = terminalValue.doubleValue()
                * (socEndPct - socStartPct) / 100.0 * capacityKwh;
        return new Banked(
                BigDecimal.valueOf(bankedEur).setScale(4, RoundingMode.HALF_UP),
                socStart, socEnd);
    }

    private static BigDecimal nz(BigDecimal v) {
        return v == null ? BigDecimal.ZERO : v;
    }
}
