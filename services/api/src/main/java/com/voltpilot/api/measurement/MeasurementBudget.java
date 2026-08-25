package com.voltpilot.api.measurement;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** D5 budget and the 96-byte/90-day volume preview from report §9. */
public final class MeasurementBudget {

    public static final double SOFT_SAMPLES_PER_MINUTE = 120.0;
    public static final double HARD_SAMPLES_PER_MINUTE = 600.0;
    public static final double HARD_REQUESTS_PER_MINUTE = 30.0;
    public static final double HARD_DUTY_CYCLE_PERCENT = 20.0;
    public static final int BYTES_PER_SAMPLE = 96;

    private static final double DAYS_PER_YEAR = 365.0;
    private static final double SECONDS_PER_DAY = 86_400.0;

    private MeasurementBudget() {}

    public record Candidate(String pointKey, boolean enabled, Integer cadenceS, String pollGroup,
            int requestCostMs, MeasurementRetention retention, String family) {}

    public record PollGroupLoad(String pollGroup, double requestsPerMinute,
            int estimatedRequestMs, double dutyCyclePercent) {}

    public record Estimate(int enabledPointCount, double samplesPerMinute,
            double requestsPerMinute, double dutyCyclePercent, boolean softWarning,
            double hardSamplesPerMinute, List<String> limitingDriverFamilies,
            boolean hardRejected, List<String> reasons, List<PollGroupLoad> pollGroups,
            int rawRetentionDays, int assumedBytesPerSample, int byteCorridorMin,
            int byteCorridorMax, double rawGbPerYear, double longTermGbPerYear,
            double totalGbPerYear, boolean volumeEstimateIncomplete,
            String retentionSummary, String limitSummary) {}

    public static Estimate estimate(List<Candidate> candidates) {
        return estimate(candidates, Map.of());
    }

    /** Family values may only tighten the global 600-sample ceiling. */
    public static Estimate estimate(List<Candidate> candidates,
            Map<String, Integer> driverSampleLimits) {
        List<Candidate> enabled = candidates == null ? List.of() : candidates.stream()
                .filter(Candidate::enabled).toList();
        double sampleLimit = HARD_SAMPLES_PER_MINUTE;
        List<String> limitingFamilies = new ArrayList<>();
        if (driverSampleLimits != null) {
            for (Candidate c : enabled) {
                Integer configured = c.family() == null ? null : driverSampleLimits.get(c.family());
                if (configured == null || configured <= 0
                        || configured >= HARD_SAMPLES_PER_MINUTE) {
                    continue;
                }
                if (configured < sampleLimit) {
                    sampleLimit = configured;
                    limitingFamilies.clear();
                }
                if (configured == sampleLimit && !limitingFamilies.contains(c.family())) {
                    limitingFamilies.add(c.family());
                }
            }
        }
        double samples = 0.0;
        double rawSamples = 0.0;
        double longSamples = 0.0;
        boolean incomplete = false;
        Map<String, Group> groups = new LinkedHashMap<>();
        for (Candidate c : enabled) {
            if (c.cadenceS() != null) {
                samples += 60.0 / c.cadenceS();
                rawSamples += MeasurementRetention.RAW_DAYS * SECONDS_PER_DAY / c.cadenceS();
                if (c.pollGroup() != null && !c.pollGroup().isBlank() && c.requestCostMs() > 0) {
                    groups.computeIfAbsent(c.pollGroup(), k -> new Group())
                            .accept(c.cadenceS(), c.requestCostMs());
                }
            }
            MeasurementRetention retention = c.retention();
            if (retention != null && retention.longTermCadenceS() != null) {
                longSamples += (DAYS_PER_YEAR - MeasurementRetention.RAW_DAYS)
                        * SECONDS_PER_DAY / retention.longTermCadenceS();
            } else if (retention != null
                    && ("event_history".equals(retention.longTermStrategy())
                        || "change_history".equals(retention.longTermStrategy()))) {
                // Event frequency is device behavior, not polling cadence. Do not
                // invent a number; flag the storage estimate as incomplete.
                incomplete = true;
            }
        }

        List<PollGroupLoad> loads = groups.entrySet().stream()
                .map(e -> e.getValue().view(e.getKey()))
                .sorted(Comparator.comparingDouble(PollGroupLoad::dutyCyclePercent).reversed())
                .toList();
        double requests = loads.stream().mapToDouble(PollGroupLoad::requestsPerMinute).sum();
        double duty = loads.stream().mapToDouble(PollGroupLoad::dutyCyclePercent).sum();
        List<String> reasons = new ArrayList<>();
        if (samples > sampleLimit + 1e-9) {
            reasons.add(sampleLimit < HARD_SAMPLES_PER_MINUTE
                    ? "Das engere Treiberbudget von " + (int) sampleLimit
                            + " Samples pro Minute wird überschritten."
                    : "Mehr als 600 gespeicherte Samples pro Minute.");
        }
        if (requests > HARD_REQUESTS_PER_MINUTE + 1e-9) {
            reasons.add("Mehr als 30 Leseanfragen pro Minute.");
        }
        if (duty > HARD_DUTY_CYCLE_PERCENT + 1e-9) {
            reasons.add("Der geschätzte Bus-Duty-Cycle überschreitet 20 %.");
        }

        double rawGb = rawSamples * BYTES_PER_SAMPLE / 1_000_000_000.0;
        double longGb = longSamples * BYTES_PER_SAMPLE / 1_000_000_000.0;
        return new Estimate(enabled.size(), round(samples), round(requests), round(duty),
                samples >= SOFT_SAMPLES_PER_MINUTE - 1e-9, sampleLimit,
                List.copyOf(limitingFamilies), !reasons.isEmpty(),
                List.copyOf(reasons), loads, MeasurementRetention.RAW_DAYS, BYTES_PER_SAMPLE,
                64, 128, roundGb(rawGb), roundGb(longGb), roundGb(rawGb + longGb), incomplete,
                "90 Tage roh; danach je Semantik 5/15 Minuten oder Ereignis-/Änderungshistorie.",
                "Kein Punktzahl-Limit; Warnung ab 120 Samples/min, harte Grenze bei "
                        + "600 Samples/min, 30 Requests/min oder 20 % Duty Cycle.");
    }

    /** Conservative request-duration estimate until family bench values exist. */
    public static int requestCostMs(String sourceKind) {
        if (sourceKind == null || "ocpp_sampled_value".equals(sourceKind)) {
            return 0; // inbound/event source, no poll request generated here
        }
        if (sourceKind.startsWith("modbus") || "sunspec_model".equals(sourceKind)) {
            return 400;
        }
        return 250;
    }

    private static final class Group {
        int fastestCadence = Integer.MAX_VALUE;
        int requestMs;

        void accept(int cadence, int cost) {
            fastestCadence = Math.min(fastestCadence, cadence);
            requestMs = Math.max(requestMs, cost);
        }

        PollGroupLoad view(String key) {
            double rpm = 60.0 / fastestCadence;
            double duty = rpm * requestMs / 60_000.0 * 100.0;
            return new PollGroupLoad(key, round(rpm), requestMs, round(duty));
        }
    }

    private static double round(double value) {
        return Math.round(value * 1000.0) / 1000.0;
    }

    private static double roundGb(double value) {
        return Math.round(value * 1_000_000.0) / 1_000_000.0;
    }
}
