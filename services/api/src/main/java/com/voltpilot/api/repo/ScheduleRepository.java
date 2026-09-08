package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.SchedulePlanDto;
import com.voltpilot.api.web.dto.ScheduleSlotDto;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.sql.ResultSet;
import java.sql.SQLException;
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
 * per plan slot).
 *
 * <p>Two READ MODES, deliberately separate (Konzept vp-fahrplan-kunde-konzept
 * §8 "PR 5"): {@link #latestForSite} is THE plan (one run - what the device is
 * executing right now), {@link #dayAsPlanned} is the TAGES-SPLICE ("wie der Tag
 * geplant war") across the runs of the day. The Jetzt-Held and the chart keep
 * reading the latest run; only the Film des Tages consumes the splice.
 */
@Repository
public class ScheduleRepository {

    /**
     * The slot columns both read modes select - one list, so the two row
     * mappers can never drift apart. The day splice prefixes its own
     * {@code generated_at, device_id} (the run a spliced slot came from).
     */
    private static final String SLOT_COLUMNS =
            "time, battery_kw, grid_kw, soc_pct, price_eur_mwh, cost_eur, baseline_cost_eur, "
                    + "curtail_kw, pv_kw, load_kw, slot_role, slot_flags, stored_value_ct_kwh, "
                    + "grid_value_ct_kwh, peak_pressure_eur_kw, "
                    + "cover_load_from_battery, unplanned_load_discharge, charge_from_surplus_only, "
                    + "why_next_best, why_next_best_margin_ct";

    /**
     * The optimizer's default AC round-trip efficiency when the asset carries
     * none - MUST mirror services/optimization {@code inputs.load_battery_sites}
     * (0.92), so the reconstructed plan-start SoC matches the solver's.
     */
    private static final double DEFAULT_ROUNDTRIP_EFFICIENCY = 0.92;

    /**
     * How long after a slot's boundary a run still counts as planning it
     * ex ante. A run is triggered ON the boundary and stamped when it starts,
     * so it is always a few hundred microseconds late for its own first slot;
     * one second covers that and stays two orders of magnitude below the
     * 15-minute re-plan cadence, so it can never let a genuine mid-slot re-plan
     * rewrite how the slot "was planned". Inlined into the SQL as a literal -
     * it is a compile-time constant of this class, never client input.
     */
    private static final String RUN_STAMP_TOLERANCE = "1 second";

    private final JdbcTemplate jdbc;

    public ScheduleRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Planned house load in the active slot of the newest tenant-visible run. */
    public Double activePlannedLoadKw(UUID siteId, Instant observedAt) {
        List<BigDecimal> values = jdbc.query(
                "SELECT load_kw FROM schedule WHERE site_id = ? AND time <= ? "
                        + "AND time + interval '15 minutes' > ? AND load_kw IS NOT NULL "
                        + "ORDER BY generated_at DESC LIMIT 1",
                (rs, i) -> rs.getBigDecimal("load_kw"), siteId,
                Timestamp.from(observedAt), Timestamp.from(observedAt));
        return values.isEmpty() ? null : values.get(0).doubleValue();
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
                "SELECT " + SLOT_COLUMNS + " FROM schedule "
                        + "WHERE site_id = ? AND generated_at = ? ORDER BY time ASC",
                (rs, i) -> mapSlot(rs),
                siteId, Timestamp.from(generatedAt));
        slots = MeasuredSlots.assign(slots, measuredPerSlot(siteId, slots, 15));
        List<Object[]> meta = jdbc.query(
                "SELECT plan_id, device_id, terminal_value_eur_per_kwh, peak_target_kw, effective_floor_soc_pct, "
                        + "fallback_14a, why_terminal_anchor, why_refill_free_pct, "
                        + "why_night_reserve_kwh, why_night_reserve_q FROM schedule "
                        + "WHERE site_id = ? AND generated_at = ? LIMIT 1",
                (rs, i) -> new Object[] {
                        rs.getObject("plan_id", UUID.class),
                        rs.getObject("device_id", UUID.class),
                        rs.getBigDecimal("terminal_value_eur_per_kwh"),
                        rs.getBigDecimal("peak_target_kw"),
                        rs.getBigDecimal("effective_floor_soc_pct"),
                        rs.getObject("fallback_14a", Boolean.class),
                        rs.getString("why_terminal_anchor"),
                        rs.getBigDecimal("why_refill_free_pct"),
                        rs.getBigDecimal("why_night_reserve_kwh"),
                        rs.getBigDecimal("why_night_reserve_q")
                },
                siteId, Timestamp.from(generatedAt));
        UUID planId = meta.isEmpty() ? null : (UUID) meta.get(0)[0];
        UUID deviceId = meta.isEmpty() ? null : (UUID) meta.get(0)[1];
        BigDecimal terminalValue = meta.isEmpty() ? null : (BigDecimal) meta.get(0)[2];
        BigDecimal peakTargetKw = meta.isEmpty() ? null : (BigDecimal) meta.get(0)[3];
        BigDecimal effectiveFloor = meta.isEmpty() ? null : (BigDecimal) meta.get(0)[4];
        Boolean fallback14a = meta.isEmpty() ? null : (Boolean) meta.get(0)[5];
        // Erklärbarkeit Stufe 1: run-level facts, repeated on every row of the
        // run (the terminal_value pattern), so ONE row answers for the plan.
        String whyAnchor = meta.isEmpty() ? null : (String) meta.get(0)[6];
        BigDecimal whyRefillFreePct = meta.isEmpty() ? null : (BigDecimal) meta.get(0)[7];
        // P3 (Nacht-Wertfunktion): what this run holds at sunrise for a heavier
        // night, and how often that much is needed. Null = nothing held back.
        BigDecimal nightReserveKwh = meta.isEmpty() ? null : (BigDecimal) meta.get(0)[8];
        BigDecimal nightReserveQ = meta.isEmpty() ? null : (BigDecimal) meta.get(0)[9];
        BigDecimal savings = slots.stream()
                .map(s -> nz(s.baselineCostEur()).subtract(nz(s.costEur())))
                .reduce(BigDecimal.ZERO, BigDecimal::add);
        Banked banked = bankedValue(siteId, slots, terminalValue, 15);
        return new SchedulePlanDto(planId, deviceId, generatedAt, 15, savings,
                banked.valueEur(), banked.socStartPct(), banked.socEndPct(), peakTargetKw, effectiveFloor,
                fallback14a, whyAnchor, whyRefillFreePct, nightReserveKwh, nightReserveQ, slots);
    }

    /**
     * "Wie der Tag geplant war" - the TAGES-SPLICE over the runs of the day
     * (Konzept vp-fahrplan-kunde-konzept §8 "PR 5", Captain-Entscheid D2: the
     * Film des Tages shows the WHOLE day, the already-elapsed morning phases
     * ticked off, not only the rest of the day).
     *
     * <p>Per 15-min slot it returns the value from the NEWEST run that planned
     * the slot BEFORE it began - i.e. the plan that was in force when the
     * quarter hour started, which is what the device executed. The per-slot
     * winner is picked with EXACTLY the splice the savings math has used all
     * along ({@code HistoryRepository.savings}:
     * {@code DISTINCT ON (time) ... ORDER BY time, generated_at DESC}), so the
     * two can never tell different stories about the same day; the added
     * upper bound on {@code generated_at} is what makes it EX-ANTE. For a
     * slot that has not started yet every stored run is older than it, so the
     * newest run wins - the future half of the splice IS the current plan. Only
     * the RUNNING slot can differ from {@link #latestForSite}: a re-plan landing
     * inside the quarter hour does not retroactively become "how it was
     * planned".
     *
     * <p><b>The bound carries one second of tolerance, and that second is the
     * whole point</b> (Herzogau 29.08.2026). A run is TRIGGERED on the slot
     * boundary and stamped when it starts, so its {@code generated_at} lands
     * microseconds AFTER the boundary it is planning for - the 10:00 run of
     * that day carried {@code 08:00:00.000867Z} against a first slot of
     * {@code 08:00:00Z}. A strict {@code generated_at <= time} therefore
     * excluded EVERY run from its OWN first slot, and the film showed the
     * PREVIOUS run for the slot in progress: "JETZT - Sonne speichern - läuft"
     * stood over a slot that had been commanded as a discharge. That hit every
     * slot of every plant; it only became visible on a day when two
     * consecutive runs disagreed sharply. One second is far below any real
     * re-plan (they are a quarter hour apart), so a run that genuinely lands
     * INSIDE its slot still loses it - which is the ex-ante property this mode
     * exists for.</p>
     *
     * <p>The window deliberately has NO upper bound: rows only exist up to the
     * newest run's horizon, so {@code time >= dayStart} is self-bounding and
     * still carries the plan's tomorrow (which the film keeps collapsed).
     *
     * <p>Honesty: a slot NO run planned before it began simply has no row - a
     * day whose optimizer only started at noon therefore begins at noon instead
     * of inventing a morning. Run-level facts (plan id, banked value, SoC
     * bounds, peak target, §14a fallback) describe ONE run and are therefore
     * null on a spliced day; {@code generatedAt}/{@code deviceId} name the
     * NEWEST run that contributed a slot. Returns {@code null} when the day
     * carries no planned slot at all.
     *
     * <p>The MEASURED channels ride along exactly as in the latest reading (the
     * window ends at {@code now}, so only the elapsed part of the day can carry
     * them) - the customer surface that consumes this mode does not render them,
     * but a spliced slot must not claim less than the same slot in the other
     * reading.
     */
    public SchedulePlanDto dayAsPlanned(UUID siteId, Instant dayStart) {
        // The newest contributing run - captured while mapping, so the splice
        // stays ONE query.
        Instant[] newestRun = {null};
        UUID[] runDevice = {null};
        // The table is ALIASED so the ex-ante predicate can qualify its right
        // side (`s.generated_at <= s.time + ...`): `time` is a col_name_keyword,
        // and a BARE `time` to the right of a comparison flirts with the
        // typed-literal grammar. Everywhere else in this repo it only ever
        // appears on the left, where that question does not arise.
        List<ScheduleSlotDto> slots = jdbc.query(
                "SELECT DISTINCT ON (s.time) s.generated_at, s.device_id, " + SLOT_COLUMNS
                        + " FROM schedule s "
                        + "WHERE s.site_id = ? AND s.time >= ? "
                        + "  AND s.generated_at <= s.time + interval '"
                        + RUN_STAMP_TOLERANCE + "' "
                        + "ORDER BY s.time, s.generated_at DESC",
                (rs, i) -> {
                    Instant generatedAt = rs.getTimestamp("generated_at").toInstant();
                    if (newestRun[0] == null || generatedAt.isAfter(newestRun[0])) {
                        newestRun[0] = generatedAt;
                        runDevice[0] = rs.getObject("device_id", UUID.class);
                    }
                    return mapSlot(rs);
                },
                siteId, Timestamp.from(dayStart));
        if (slots.isEmpty()) {
            return null;
        }
        slots = MeasuredSlots.assign(slots, measuredPerSlot(siteId, slots, 15));
        BigDecimal savings = slots.stream()
                .map(s -> nz(s.baselineCostEur()).subtract(nz(s.costEur())))
                .reduce(BigDecimal.ZERO, BigDecimal::add);
        // Run-level facts (plan id, banked value, SoC bounds, peak target,
        // §14a fallback, the Erklärbarkeit-Stufe-1 anchor/refill share and the
        // P3 night reserve) describe ONE run and are therefore null on a
        // spliced day - a day stitched from a dozen runs has no single anchor
        // to name, and no single amount it held for the night.
        return new SchedulePlanDto(null, runDevice[0], newestRun[0], 15, savings,
                null, null, null, null, null, null, null, null, null, null, slots);
    }

    /** One row of the {@link #SLOT_COLUMNS} projection as a slot DTO. */
    private static ScheduleSlotDto mapSlot(ResultSet rs) throws SQLException {
        return new ScheduleSlotDto(
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
                // The MEASURED load and PV are a separate aggregation
                // (P3 + its mirror), see measuredPerSlot below.
                null, null,
                // Duty-Vorschau (V20260802010000): tri-state, so read them as
                // nullable Booleans - getBoolean() would turn "not evaluated"
                // into a claimed false.
                rs.getObject("cover_load_from_battery", Boolean.class),
                rs.getObject("unplanned_load_discharge", Boolean.class),
                rs.getObject("charge_from_surplus_only", Boolean.class),
                // Erklärbarkeit Stufe 1 (V20260824000000): only ever set on a
                // RESTING slot - null elsewhere is the honest "no margin", not
                // a missing value.
                rs.getString("why_next_best"),
                rs.getBigDecimal("why_next_best_margin_ct"));
    }

    /**
     * The MEASURED house consumption AND PV production per plan slot (P3
     * "Ist-Last sichtbar", report vp-netzbezug-nacht-s3 §6, plus its Ist-PV
     * mirror): the quarter-hour MEANs of {@code telemetry.load_kw} and
     * {@code telemetry.pv_power_kw}, i.e. the SAME two quantities the forecaster
     * predicts since P2 - so the portal's solid Ist lines and its dotted
     * Prognose lines are comparable by construction.
     *
     * <p>Both channels ride ONE query over ONE window: they come from the same
     * rows, so a second scan would only cost time and could drift apart.
     * {@code avg()} ignores NULLs per column, so a bucket that carries only one
     * of the two channels yields exactly that one - and a device that reports no
     * PV at all yields none, which the portal shows as an ABSENT line, never a
     * 0-line claiming the sun did not shine.
     *
     * <p>Read straight from RAW telemetry (the plan window is at most 24 h, and
     * the 15-min rollups lag their refresh by up to a quarter hour - the running
     * slot, where the forecast error actually shows, would be missing). The
     * query is RLS-scoped exactly like every other read here; the window ends at
     * {@code now}, so a future slot can never receive a value, and a slot with
     * no samples simply gets no row.
     */
    private Map<Instant, MeasuredSlots.Measured> measuredPerSlot(
            UUID siteId, List<ScheduleSlotDto> slots, int slotMinutes) {
        MeasuredSlots.Window window = MeasuredSlots.window(
                slots.stream().map(ScheduleSlotDto::start).toList(), slotMinutes, Instant.now());
        if (window == null) {
            return Map.of();
        }
        List<Object[]> rows = jdbc.query(
                "SELECT time_bucket('15 minutes', time) AS bucket, avg(load_kw) AS load_kw, "
                        + "avg(pv_power_kw) AS pv_kw "
                        + "FROM telemetry "
                        + "WHERE site_id = ? AND time >= ? AND time < ? "
                        + "AND (load_kw IS NOT NULL OR pv_power_kw IS NOT NULL) "
                        + "GROUP BY 1",
                (rs, i) -> new Object[] {
                        rs.getTimestamp("bucket").toInstant(),
                        rs.getBigDecimal("load_kw"),
                        rs.getBigDecimal("pv_kw")
                },
                siteId, Timestamp.from(window.from()), Timestamp.from(window.to()));
        Map<Instant, MeasuredSlots.Measured> byBucket = new HashMap<>();
        for (Object[] row : rows) {
            BigDecimal load = scaled((BigDecimal) row[1]);
            BigDecimal pv = scaled((BigDecimal) row[2]);
            if (load != null || pv != null) {
                byBucket.put((Instant) row[0], new MeasuredSlots.Measured(load, pv));
            }
        }
        return byBucket;
    }

    private static BigDecimal scaled(BigDecimal value) {
        return value == null ? null : value.setScale(3, RoundingMode.HALF_UP);
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
