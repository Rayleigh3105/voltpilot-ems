package com.voltpilot.api.measurement;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** D5 budget and the 96-byte/90-day volume preview from report §9. */
public final class MeasurementBudget {

    public static final double SOFT_SAMPLES_PER_MINUTE = MeasurementBudgetContract.limit("samples_soft");
    public static final double HARD_SAMPLES_PER_MINUTE = MeasurementBudgetContract.limit("samples_hard");
    public static final double HARD_REQUESTS_PER_MINUTE = MeasurementBudgetContract.limit("requests");
    public static final double HARD_DUTY_CYCLE_PERCENT = MeasurementBudgetContract.limit("duty_pct");
    public static final int BYTES_PER_SAMPLE = 96;
    /**
     * Free registers have no catalog family/bench identity yet. Use the
     * conservative upper bound for a validated Modbus read; clients cannot
     * lower this value in a preview or apply request.
     */
    public static final int CUSTOM_REGISTER_REQUEST_COST_MS = MeasurementBudgetContract.cost("custom", null);

    private static final double DAYS_PER_YEAR = 365.0;
    private static final double SECONDS_PER_DAY = 86_400.0;
    private static final int MAX_CADENCE_S = 86_400;
    private static final int MAX_REQUEST_COST_MS = 60_000;
    /** A driver may tighten, never exceed, the platform's 600-sample ceiling. */
    private static final int MAX_DRIVER_SAMPLE_LIMIT = (int) HARD_SAMPLES_PER_MINUTE;

    private MeasurementBudget() {}

    public record Candidate(String pointKey, boolean enabled, Integer cadenceS, String pollGroup,
            int requestCostMs, MeasurementRetention retention, String family) {}

    public record PollGroupLoad(String pollGroup, double requestsPerMinute,
            int serverRequestCostMs, double dutyCyclePercent) {}

    /** Eine oder mehrere Leseanfragen, die je Takt einer Datenquelle anfallen. */
    public record SourceRequest(int requestsPerCadence, int requestCostMs) {}

    /**
     * Die physische Last EINER Datenquelle. Anders als {@link Candidate} zählt sie Kanäle und
     * Blockanfragen getrennt: mehrere Kanäle können mit einer einzigen Anfrage gelesen werden.
     */
    public record SourceCandidate(String source, String protocol, int channels, int cadenceS,
            List<SourceRequest> requests) {}

    /** Die vorrechenbare Last einer Datenquelle oder Summe mehrerer Quellen. */
    public record SourceEstimate(int channels, double samplesPerMinute,
            double requestsPerMinute, double dutyCyclePercent, boolean softWarning,
            boolean hardRejected, List<String> reasons) {}

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

    /**
     * Rechnet Kanäle × Takt, Anfragen je Takt und die serverseitigen Kosten je Protokoll. Diese
     * Form ist der UEMS-Deckel je Datenquelle/Box; sie verändert keinen Takt und schreibt nichts.
     */
    public static SourceEstimate estimateSources(List<SourceCandidate> candidates) {
        List<SourceCandidate> all = candidates == null ? List.of() : candidates;
        int channels = 0;
        double samples = 0;
        double requests = 0;
        double duty = 0;
        for (SourceCandidate source : all) {
            if (source == null || source.channels() < 0 || source.cadenceS() <= 0
                    || source.cadenceS() > MAX_CADENCE_S || source.requests() == null) {
                return rejectedSource("Das Lesebudget enthält eine ungültige Datenquelle.");
            }
            channels += source.channels();
            double cycles = 60.0 / source.cadenceS();
            samples += source.channels() * cycles;
            for (SourceRequest request : source.requests()) {
                if (request == null || request.requestsPerCadence() < 0
                        || request.requestCostMs() < 0
                        || request.requestCostMs() > MAX_REQUEST_COST_MS) {
                    return rejectedSource("Das Lesebudget enthält ungültige Anfragekosten.");
                }
                requests += request.requestsPerCadence() * cycles;
                duty += request.requestsPerCadence() * cycles * request.requestCostMs()
                        / 60_000.0 * 100.0;
            }
        }
        if (!finiteNonNegative(samples) || !finiteNonNegative(requests)
                || !finiteNonNegative(duty)) {
            return rejectedSource("Das Lesebudget konnte wegen eines numerischen Überlaufs nicht sicher berechnet werden.");
        }
        List<String> reasons = new ArrayList<>();
        if (samples > HARD_SAMPLES_PER_MINUTE + 1e-9) {
            reasons.add("Mehr als 600 gespeicherte Messwerte pro Minute.");
        }
        if (requests > HARD_REQUESTS_PER_MINUTE + 1e-9) {
            reasons.add("Mehr als 30 Leseanfragen pro Minute.");
        }
        if (duty > HARD_DUTY_CYCLE_PERCENT + 1e-9) {
            reasons.add("Die geschätzte Bus-Auslastung überschreitet 20 %.");
        }
        return new SourceEstimate(channels, round(samples), round(requests), round(duty),
                samples >= SOFT_SAMPLES_PER_MINUTE - 1e-9, !reasons.isEmpty(),
                List.copyOf(reasons));
    }

    /** AP-07 E10: same cost table as the Node-RED planner. */
    public static int requestCostMsForProtocol(String protocol) {
        return requestCostMsForFamily(null, protocol);
    }

    public static int requestCostMsForFamily(String family, String sourceKind) {
        return MeasurementBudgetContract.cost(family, sourceKind);
    }

    /** Units are words for Modbus, cards for WAGO and definitions for unbenched registers. */
    public static int requestsForUnits(String family, String sourceKind, int units) {
        return MeasurementBudgetContract.requests(family, sourceKind, units);
    }

    /** Family values may only tighten the global 600-sample ceiling. */
    public static Estimate estimate(List<Candidate> candidates,
            Map<String, Integer> driverSampleLimits) {
        List<Candidate> all = candidates == null ? List.of() : candidates;
        String invalid = validateInputs(all, driverSampleLimits);
        if (invalid != null) {
            return rejected(invalid);
        }
        List<Candidate> enabled = all.stream().filter(Candidate::enabled).toList();
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
        if (loads.stream().anyMatch(load -> !finiteNonNegative(load.requestsPerMinute())
                || load.serverRequestCostMs() <= 0
                || !finiteNonNegative(load.dutyCyclePercent()))) {
            return rejected("Die Pollgruppenlast konnte wegen eines numerischen Überlaufs nicht sicher berechnet werden.");
        }
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
        double totalGb = rawGb + longGb;
        if (!finiteNonNegative(samples) || !finiteNonNegative(rawSamples)
                || !finiteNonNegative(longSamples) || !finiteNonNegative(requests)
                || !finiteNonNegative(duty) || !finiteNonNegative(rawGb)
                || !finiteNonNegative(longGb) || !finiteNonNegative(totalGb)) {
            return rejected("Das Messwertbudget konnte wegen eines numerischen Überlaufs nicht sicher berechnet werden.");
        }
        return new Estimate(enabled.size(), round(samples), round(requests), round(duty),
                samples >= SOFT_SAMPLES_PER_MINUTE - 1e-9, sampleLimit,
                List.copyOf(limitingFamilies), !reasons.isEmpty(),
                List.copyOf(reasons), loads, MeasurementRetention.RAW_DAYS, BYTES_PER_SAMPLE,
                64, 128, roundGb(rawGb), roundGb(longGb), roundGb(totalGb), incomplete,
                "90 Tage roh; danach je Semantik 5/15 Minuten oder Ereignis-/Änderungshistorie.",
                "Kein Punktzahl-Limit; Warnung ab 120 Samples/min, harte Grenze bei "
                        + "600 Samples/min, 30 Requests/min oder 20 % Duty Cycle.");
    }

    /** Conservative request-duration estimate until family bench values exist. */
    public static int requestCostMs(String sourceKind) {
        return requestCostMs(sourceKind, null);
    }

    public static int requestCostMs(String sourceKind, String family) {
        if (sourceKind == null || "ocpp_sampled_value".equals(sourceKind)) {
            return 1; // inbound/event source: positive sentinel, no poll group is created
        }
        return requestCostMsForFamily(family, sourceKind);
    }

    public static int customRegisterRequestCostMs() {
        return CUSTOM_REGISTER_REQUEST_COST_MS;
    }

    private static String validateInputs(List<Candidate> candidates,
            Map<String, Integer> driverSampleLimits) {
        for (Candidate c : candidates) {
            if (c == null) {
                return "Das Messwertbudget enthält einen ungültigen Messpunkt.";
            }
            if (c.cadenceS() == null || c.cadenceS() <= 0 || c.cadenceS() > MAX_CADENCE_S) {
                return "Die Kadenz muss zwischen 1 und 86400 Sekunden liegen.";
            }
            if (c.requestCostMs() <= 0 || c.requestCostMs() > MAX_REQUEST_COST_MS) {
                return "Die serverseitige Request-Kostenannahme ist ungültig.";
            }
            MeasurementRetention r = c.retention();
            if (r == null || r.rawRetentionDays() != MeasurementRetention.RAW_DAYS
                    || r.longTermStrategy() == null || r.longTermStrategy().isBlank()
                    || !Set.of("five_minute", "fifteen_minute", "event_history",
                            "change_history", "none").contains(r.longTermStrategy())
                    || (r.longTermCadenceS() != null
                        && (r.longTermCadenceS() <= 0 || r.longTermCadenceS() > MAX_CADENCE_S))) {
                return "Die Aufbewahrungs- oder Langfristkadenz ist ungültig.";
            }
        }
        if (driverSampleLimits != null) {
            for (Map.Entry<String, Integer> entry : driverSampleLimits.entrySet()) {
                if (entry.getKey() == null || entry.getKey().isBlank()
                        || entry.getValue() == null || entry.getValue() <= 0
                        || entry.getValue() > MAX_DRIVER_SAMPLE_LIMIT) {
                    return "Das konfigurierte Treiberbudget ist ungültig.";
                }
            }
        }
        return null;
    }

    private static Estimate rejected(String reason) {
        return new Estimate(0, 0.0, 0.0, 0.0, false, HARD_SAMPLES_PER_MINUTE,
                List.of(), true, List.of(reason), List.of(), MeasurementRetention.RAW_DAYS,
                BYTES_PER_SAMPLE, 64, 128, 0.0, 0.0, 0.0, true,
                "Keine sichere Schätzung wegen ungültiger Eingabedaten.",
                "Ungültige Budgeteingabe wird aus Sicherheitsgründen hart abgelehnt.");
    }

    private static SourceEstimate rejectedSource(String reason) {
        return new SourceEstimate(0, 0, 0, 0, false, true, List.of(reason));
    }

    private static boolean finiteNonNegative(double value) {
        return Double.isFinite(value) && value >= 0.0;
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
        if (value > Long.MAX_VALUE / 1000.0) {
            return value;
        }
        return Math.round(value * 1000.0) / 1000.0;
    }

    private static double roundGb(double value) {
        if (value > Long.MAX_VALUE / 1_000_000.0) {
            return value;
        }
        return Math.round(value * 1_000_000.0) / 1_000_000.0;
    }
}
