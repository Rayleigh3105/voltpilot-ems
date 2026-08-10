package com.voltpilot.api.metrics;

import com.voltpilot.api.consumers.ConsumerRequirementLedger;
import com.voltpilot.api.consumers.ConsumerRequirementLedger.State;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The PURE §18 aggregation rules for the consumer-control observability metrics
 * (Inkrement 5). No I/O, {@code now} is passed - the FleetMetrics discipline, so
 * it is Docker-free testable and the collector just wires the numbers onto
 * Prometheus. The metric NAMES are the contract; they live in
 * {@link ConsumerMetricsCollector} and end NEVER on {@code _total} (the
 * Prometheus-client gauge trap).
 *
 * <p>Every figure is derived from CURRENT platform state (the ledger's effective
 * state, the reported runtime, active overrides) - a fulfilled/missed count is
 * the count of task instances that ARE currently fulfilled/missed, alertable and
 * honest, never a fabricated cumulative counter.
 */
public final class ConsumerMetrics {

    private ConsumerMetrics() {}

    /** One consumer joined with its live runtime state (nullable when unreported). */
    public record ConsumerRow(boolean enabled, boolean activePolicy, boolean connected,
            String runtimeState, Boolean confirmed, String reasonCode) {}

    /** One recurring-requirement instance from the ledger. */
    public record TaskRow(Instant deadline, State stored, Integer requiredRuntimeSeconds,
            int actualRuntimeSeconds) {}

    /** The computed snapshot the collector publishes. */
    public record Snapshot(int total, int active, int connected, int disturbed,
            Map<String, Integer> tasksByState, int tasksAtRisk, Map<String, Integer> clampedByReason,
            int overridesActive) {}

    /** The §14.13/§15 states/reasons that mean a consumer is disturbed / clamped. */
    static final Set<String> DISTURBED_STATES = Set.of("offline", "clamped", "missed");
    static final Set<String> CLAMP_REASONS = Set.of("guard_grid_limit", "guard_rated_power",
            "guard_min_off", "guard_min_on", "guard_max_starts", "guard_ramp");
    /** The ledger states, in a stable order so a "0" row exists for each. */
    static final List<String> TASK_STATES =
            List.of("pending", "running", "fulfilled", "missed", "blocked");

    public static Snapshot compute(List<ConsumerRow> consumers, List<TaskRow> tasks,
            int overridesActive, Instant now) {
        int total = 0;
        int active = 0;
        int connected = 0;
        int disturbed = 0;
        Map<String, Integer> clamped = new LinkedHashMap<>();
        for (ConsumerRow c : consumers) {
            total++;
            if (c.enabled() && c.activePolicy()) {
                active++;
            }
            if (c.connected()) {
                connected++;
            }
            if (isDisturbed(c)) {
                disturbed++;
            }
            if (c.reasonCode() != null && CLAMP_REASONS.contains(c.reasonCode())) {
                clamped.merge(c.reasonCode(), 1, Integer::sum);
            }
        }

        Map<String, Integer> byState = new LinkedHashMap<>();
        for (String s : TASK_STATES) {
            byState.put(s, 0);
        }
        int atRisk = 0;
        for (TaskRow t : tasks) {
            State effective =
                    ConsumerRequirementLedger.effectiveState(t.stored(), t.deadline(), now);
            byState.merge(effective.label(), 1, Integer::sum);
            if (ConsumerRequirementLedger.atRisk(effective, t.deadline(),
                    t.requiredRuntimeSeconds(), t.actualRuntimeSeconds(), now)) {
                atRisk++;
            }
        }
        return new Snapshot(total, active, connected, disturbed, byState, atRisk, clamped,
                overridesActive);
    }

    private static boolean isDisturbed(ConsumerRow c) {
        if (Boolean.FALSE.equals(c.confirmed())) {
            return true; // the readback disagreed - Ausführung nicht bestätigt
        }
        return c.runtimeState() != null && DISTURBED_STATES.contains(c.runtimeState());
    }
}
