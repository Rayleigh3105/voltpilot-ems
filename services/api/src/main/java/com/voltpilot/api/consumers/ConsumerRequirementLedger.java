package com.voltpilot.api.consumers;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * The PURE fulfilment ledger of recurring consumer requirements
 * (docs/verbrauchssteuerung.md §9.4 / Inkrement 5). This is the ONE place that
 * turns {telemetry evidence + the active policy's recurring requirements + the
 * current time in site zone} into {@link Row}s of {@code consumer_requirement_state}
 * - the FleetPflege/Tagesprotokoll/RolloutStates pattern (no I/O, every
 * time-dependent method takes {@code now}, so it is Docker-free testable and
 * shared by the writer, the read path and the metrics collector - one truth).
 *
 * <p><b>The whole point: Ist-Erfüllung comes from CONFIRMED telemetry, never from
 * the sent setpoint.</b> Runtime is the edge's readback-confirmed
 * {@code runtime_seconds_today}; the ENERGY confirmation follows the D3 hierarchy:
 * a measured kWh channel ({@link EnergyConfirmation#MEASURED}) → a kW telemetry
 * integral ({@link EnergyConfirmation#INTEGRATED}) → relay readback only, energy
 * "angenommen" ({@link EnergyConfirmation#ASSUMED}, Nennleistung × Zeit) → NO
 * readback ({@link EnergyConfirmation#NONE}) which can NEVER read "erfüllt".
 *
 * <p><b>Period boundaries are computed in SITE time and are DST-correct</b>
 * (Europe/Berlin in v1, {@code ZonedDateTime} arithmetic). Only recurring
 * requirements ({@code fixed_window}, {@code flexible_task}) produce a row; a
 * reactive/opportunistic requirement has no period/deadline to measure against.
 *
 * <p>"Frist gefährdet" (§17) is deliberately NOT a stored state - it is a DERIVED
 * warn ({@link #atRisk}) computed on the read side, so a period that is running
 * out of time is surfaced without a background job forcing a state change.
 */
public final class ConsumerRequirementLedger {

    private ConsumerRequirementLedger() {}

    /** The §9.4 lifecycle of a recurring requirement instance. */
    public enum State {
        PENDING, RUNNING, FULFILLED, MISSED, BLOCKED;

        public String label() {
            return name().toLowerCase();
        }

        public static State fromLabel(String s) {
            if (s == null) {
                return PENDING;
            }
            for (State v : values()) {
                if (v.label().equals(s)) {
                    return v;
                }
            }
            return PENDING;
        }
    }

    /** The D3 confirmation level of the ENERGY figure (§9.4). */
    public enum EnergyConfirmation {
        /**
         * ⚠ FREIGABE (Verbrauchsmanagement v1 §3.4, Paket P8) ist die Stufe der
         * SG-Ready-Wärmepumpe: der Relais-Rücklesewert belegt, dass die
         * FREIGABE gesetzt war - über den Verbrauch sagt er NICHTS. Sie liegt
         * deshalb bewusst NEBEN {@code ASSUMED} statt darin: {@code
         * Nennleistung × Zeit} wäre hier eine erfundene Energie, weil die
         * Pumpe selbst entscheidet, ob und wie stark sie anläuft. Folge:
         * {@link #actualEnergy} liefert für sie NIE eine Zahl, und weil das
         * gespeicherte Niveau nur neben einer Energie-Zahl steht, erreicht das
         * Wort auch nie die {@code energy_confirmation}-Spalte.
         */
        MEASURED, INTEGRATED, ASSUMED, FREIGABE, NONE;

        public String label() {
            return name().toLowerCase();
        }

        /** Any level other than NONE is a real readback - fulfilment is possible. */
        public boolean hasReadback() {
            return this != NONE;
        }
    }

    /**
     * One recurring requirement extracted from a policy document. {@code from}/
     * {@code to} are the local window ({@code to} may be 24:00 -> end of day);
     * either goal may be null.
     */
    public record Requirement(String requirementId, String kind, String enforcement,
            Set<DayOfWeek> days, LocalTime from, LocalTime to, boolean endOfDay,
            Integer requiredRuntimeSeconds, BigDecimal requiredEnergyKwh) {}

    /**
     * The telemetry evidence for a consumer at evaluation time (all from the
     * heartbeat / consumer_runtime_status, never from a setpoint). {@code
     * measuredEnergyKwh} is supplied by the writer for MEASURED/INTEGRATED levels
     * (null otherwise); ASSUMED energy is derived here from rated × runtime.
     */
    public record Evidence(int runtimeSecondsToday, String reportedState, String reportedReason,
            Boolean confirmed, EnergyConfirmation confirmationLevel, BigDecimal measuredEnergyKwh,
            BigDecimal ratedPowerKw) {}

    /** One computed ledger row (matches consumer_requirement_state). */
    public record Row(UUID instanceId, String requirementId, Instant periodStart, Instant deadline,
            BigDecimal requiredEnergyKwh, Integer requiredRuntimeSeconds, BigDecimal actualEnergyKwh,
            int actualRuntimeSeconds, EnergyConfirmation energyConfirmation, State state,
            String reasonCode) {}

    private static final Set<String> RUNNING_STATES = Set.of("running_forced", "running_optimized");
    private static final Set<String> BLOCKED_REASONS =
            Set.of("guard_grid_limit", "guard_rated_power", "guard_min_off", "guard_max_starts");

    /**
     * Evaluate the CURRENT period instance of every recurring requirement of one
     * consumer. Returns at most one row per requirement (the instance for the
     * current site-local day, if today matches the recurrence).
     */
    public static List<Row> evaluate(UUID entityId, List<Requirement> reqs, Evidence ev,
            Instant now, ZoneId zone) {
        List<Row> out = new ArrayList<>();
        for (Requirement r : reqs) {
            Row row = evaluateOne(entityId, r, ev, now, zone);
            if (row != null) {
                out.add(row);
            }
        }
        return out;
    }

    private static Row evaluateOne(UUID entityId, Requirement r, Evidence ev, Instant now,
            ZoneId zone) {
        Window w = currentWindow(r, now, zone);
        if (w == null) {
            return null; // today does not match the recurrence
        }
        UUID instanceId = instanceId(entityId, r.requirementId(), w.start());

        int runtime = Math.max(0, ev.runtimeSecondsToday());
        BigDecimal actualEnergy = actualEnergy(ev, runtime);
        EnergyConfirmation level = ev.confirmationLevel() == null
                ? EnergyConfirmation.NONE : ev.confirmationLevel();
        // The energy confirmation is only meaningful when an energy figure exists.
        EnergyConfirmation storedLevel = actualEnergy == null ? null : level;

        boolean metRuntime = r.requiredRuntimeSeconds() != null
                && runtime >= r.requiredRuntimeSeconds();
        boolean metEnergy = r.requiredEnergyKwh() != null && actualEnergy != null
                && actualEnergy.compareTo(r.requiredEnergyKwh()) >= 0;
        boolean met = metRuntime || metEnergy;
        // Fulfilment needs a real readback (D3): commanded runtime alone never
        // reads "erfüllt", and a readback that DISAGREED (confirmed=false) is not
        // trusted either.
        boolean confirmable = level.hasReadback() && !Boolean.FALSE.equals(ev.confirmed());

        boolean past = !now.isBefore(w.deadline());
        State state = deriveState(ev, met, confirmable, runtime, past);
        String reason = deriveReason(state, ev, confirmable);

        return new Row(instanceId, r.requirementId(), w.start(), w.deadline(),
                r.requiredEnergyKwh(), r.requiredRuntimeSeconds(), actualEnergy, runtime,
                storedLevel, state, reason);
    }

    private static State deriveState(Evidence ev, boolean met, boolean confirmable, int runtime,
            boolean past) {
        String reported = ev.reportedState() == null ? "" : ev.reportedState();
        boolean blockedNow = "clamped".equals(reported)
                || (ev.reportedReason() != null && BLOCKED_REASONS.contains(ev.reportedReason()));
        if (met && confirmable) {
            return State.FULFILLED;
        }
        if (past) {
            // Deadline passed and not provably fulfilled - honestly missed
            // (a met-but-unconfirmed run cannot be claimed).
            return State.MISSED;
        }
        if (blockedNow) {
            return State.BLOCKED;
        }
        if (RUNNING_STATES.contains(reported) || runtime > 0) {
            return State.RUNNING;
        }
        return State.PENDING;
    }

    private static String deriveReason(State state, Evidence ev, boolean confirmable) {
        return switch (state) {
            case BLOCKED -> ev.reportedReason() != null ? ev.reportedReason() : "guard_grid_limit";
            case MISSED -> confirmable ? "flex_deadline" : "readback_mismatch";
            case FULFILLED, RUNNING -> ev.reportedReason();
            case PENDING -> ev.reportedReason();
        };
    }

    /** Assumed energy = Nennleistung × Laufzeit; measured/integrated come in. */
    private static BigDecimal actualEnergy(Evidence ev, int runtimeSeconds) {
        EnergyConfirmation level = ev.confirmationLevel();
        if (level == EnergyConfirmation.MEASURED || level == EnergyConfirmation.INTEGRATED) {
            return ev.measuredEnergyKwh(); // may be null when telemetry is missing
        }
        if (level == EnergyConfirmation.ASSUMED && ev.ratedPowerKw() != null && runtimeSeconds > 0) {
            return ev.ratedPowerKw()
                    .multiply(BigDecimal.valueOf(runtimeSeconds))
                    .divide(BigDecimal.valueOf(3600), 3, RoundingMode.HALF_UP);
        }
        return null; // NONE, or ASSUMED without runtime - energy unknown, never a fabricated 0
    }

    // --- derived read-side warn (§17) ---------------------------------------

    /**
     * "Frist gefährdet": the period is still open (not fulfilled, deadline
     * ahead) but the time left is no longer enough to finish the remaining
     * runtime demand. Pure, so the writer/read path/portal all agree; a row
     * without a runtime demand or already fulfilled is never at risk.
     */
    public static boolean atRisk(State state, Instant deadline, Integer requiredRuntimeSeconds,
            int actualRuntimeSeconds, Instant now) {
        if (state == State.FULFILLED || state == State.MISSED || requiredRuntimeSeconds == null) {
            return false;
        }
        if (!now.isBefore(deadline)) {
            return false; // past the deadline the ledger state (missed) is the truth
        }
        long remainingDemand = Math.max(0, requiredRuntimeSeconds - actualRuntimeSeconds);
        if (remainingDemand == 0) {
            return false;
        }
        long secondsLeft = deadline.getEpochSecond() - now.getEpochSecond();
        return secondsLeft < remainingDemand;
    }

    /**
     * The EFFECTIVE state for a stored row read at {@code now}: a period whose
     * deadline has passed without a stored fulfilment reads MISSED even if the
     * last write (before the deadline) left it PENDING/RUNNING. So the read
     * path and the metrics collector agree on the final outcome without a
     * background job.
     */
    public static State effectiveState(State stored, Instant deadline, Instant now) {
        if (stored == State.FULFILLED) {
            return State.FULFILLED;
        }
        if (!now.isBefore(deadline) && stored != State.MISSED) {
            return State.MISSED;
        }
        return stored;
    }

    // --- policy parsing ------------------------------------------------------

    /**
     * Extract the recurring requirements of a policy document. Ignores reactive/
     * opportunistic requirements (no period) and malformed entries.
     */
    public static List<Requirement> requirementsOf(JsonNode document, BigDecimal ratedPowerKw) {
        List<Requirement> out = new ArrayList<>();
        if (document == null || !document.isObject()) {
            return out;
        }
        JsonNode reqs = document.get("requirements");
        if (reqs == null || !reqs.isArray()) {
            return out;
        }
        for (JsonNode req : reqs) {
            Requirement r = parseRequirement(req, ratedPowerKw);
            if (r != null) {
                out.add(r);
            }
        }
        return out;
    }

    private static Requirement parseRequirement(JsonNode req, BigDecimal ratedPowerKw) {
        if (req == null || !req.isObject()) {
            return null;
        }
        String kind = req.path("kind").asText("");
        if (!"fixed_window".equals(kind) && !"flexible_task".equals(kind)) {
            return null; // reactive/opportunistic carry no period
        }
        String id = req.path("id").asText("");
        if (id.isBlank()) {
            return null;
        }
        JsonNode rec = req.get("recurrence");
        if (rec == null || !rec.isObject()) {
            return null;
        }
        Set<DayOfWeek> days = parseDays(rec.path("days").asText("daily"));
        LocalTime from = parseTime(rec.path("from").asText(null));
        String toRaw = rec.path("to").asText(null);
        boolean endOfDay = "24:00".equals(toRaw);
        LocalTime to = endOfDay ? LocalTime.MIDNIGHT : parseTime(toRaw);
        if (from == null || to == null) {
            return null;
        }
        Integer requiredRuntime = null;
        BigDecimal requiredEnergy = null;
        if ("fixed_window".equals(kind)) {
            // A must_run fixed window must run for the whole window; a lighter
            // enforcement carries no runtime obligation to measure against.
            if ("must_run".equals(req.path("enforcement").asText(""))) {
                requiredRuntime = windowSeconds(from, to, endOfDay);
            }
        } else {
            JsonNode demand = req.get("demand");
            if (demand != null && demand.isObject()) {
                if (demand.hasNonNull("runtime_minutes")) {
                    requiredRuntime = (int) Math.round(demand.get("runtime_minutes").asDouble() * 60);
                }
                if (demand.hasNonNull("energy_kwh")) {
                    requiredEnergy = BigDecimal.valueOf(demand.get("energy_kwh").asDouble());
                }
            }
        }
        if (requiredRuntime == null && requiredEnergy == null) {
            return null; // nothing measurable
        }
        return new Requirement(id, kind, req.path("enforcement").asText("must_run"), days, from, to,
                endOfDay, requiredRuntime, requiredEnergy);
    }

    private static int windowSeconds(LocalTime from, LocalTime to, boolean endOfDay) {
        int end = endOfDay ? 86400 : to.toSecondOfDay();
        int start = from.toSecondOfDay();
        int span = end - start;
        if (span <= 0) {
            span += 86400; // over-midnight window
        }
        return span;
    }

    private static Set<DayOfWeek> parseDays(String raw) {
        return switch (raw == null ? "daily" : raw) {
            case "werktage" -> Set.of(DayOfWeek.MONDAY, DayOfWeek.TUESDAY, DayOfWeek.WEDNESDAY,
                    DayOfWeek.THURSDAY, DayOfWeek.FRIDAY);
            case "wochenende" -> Set.of(DayOfWeek.SATURDAY, DayOfWeek.SUNDAY);
            default -> Set.of(DayOfWeek.values());
        };
    }

    private static LocalTime parseTime(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            String[] p = raw.split(":");
            return LocalTime.of(Integer.parseInt(p[0]), p.length > 1 ? Integer.parseInt(p[1]) : 0);
        } catch (Exception e) {
            return null;
        }
    }

    // --- period computation (DST-correct, site zone) -------------------------

    private record Window(Instant start, Instant deadline) {}

    /**
     * The recurrence instance to track for now, in site time. For a normal or
     * all-day window that is TODAY's instance (its runtime is captured by the
     * edge's today-scoped {@code runtime_seconds_today} counter - looking back a
     * full day would read a stale, already-reset counter). Only an OVER-MIDNIGHT
     * window (from &gt; to) additionally considers yesterday's start-day, since
     * its active instance really did start yesterday. Returns null when no
     * matching instance exists for the local day.
     */
    private static Window currentWindow(Requirement r, Instant now, ZoneId zone) {
        ZonedDateTime local = now.atZone(zone);
        LocalDate today = local.toLocalDate();
        boolean overMidnight = !r.endOfDay() && !r.to().isAfter(r.from());
        int maxBack = overMidnight ? 1 : 0;
        // Pick the instance whose [start, deadline) contains now, else the most
        // recent already-started one.
        Window best = null;
        for (int back = 0; back <= maxBack; back++) {
            LocalDate startDay = today.minusDays(back);
            if (!r.days().contains(startDay.getDayOfWeek())) {
                continue;
            }
            ZonedDateTime start = startDay.atTime(r.from()).atZone(zone);
            ZonedDateTime deadline = deadlineOf(startDay, r, zone);
            if (!deadline.isAfter(start)) {
                deadline = deadline.plusDays(1); // over-midnight window
            }
            Instant s = start.toInstant();
            Instant d = deadline.toInstant();
            if (s.isAfter(now)) {
                // upcoming window today - track it as PENDING only if nothing started yet
                if (best == null) {
                    best = new Window(s, d);
                }
                continue;
            }
            // already started
            if (!now.isBefore(s) && (best == null || s.isAfter(best.start()))) {
                best = new Window(s, d);
            }
            if (!now.isBefore(s) && now.isBefore(d)) {
                return new Window(s, d); // the currently-active instance wins outright
            }
        }
        return best;
    }

    private static ZonedDateTime deadlineOf(LocalDate startDay, Requirement r, ZoneId zone) {
        if (r.endOfDay()) {
            return startDay.plusDays(1).atStartOfDay(zone);
        }
        return startDay.atTime(r.to()).atZone(zone);
    }

    /** Deterministic per-period id so re-computes are idempotent upserts. */
    public static UUID instanceId(UUID entityId, String requirementId, Instant periodStart) {
        String name = entityId + "|" + requirementId + "|" + periodStart.getEpochSecond();
        return UUID.nameUUIDFromBytes(name.getBytes(StandardCharsets.UTF_8));
    }
}
