package com.voltpilot.api.measurement;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class MeasurementBudgetTest {

    private static final MeasurementRetention FIFTEEN =
            new MeasurementRetention("thermal_bms", 90, 900, "fifteen_minute");

    @Test
    void softWarningStartsAt120SamplesWithoutAnyPointCountLimit() {
        List<MeasurementBudget.Candidate> points = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            points.add(point("p" + i, 5, "one-block", 400));
        }
        var estimate = MeasurementBudget.estimate(points);

        assertThat(estimate.samplesPerMinute()).isEqualTo(120.0);
        assertThat(estimate.softWarning()).isTrue();
        assertThat(estimate.hardRejected()).isFalse();
        assertThat(estimate.requestsPerMinute()).isEqualTo(12.0);

        // 1,000 slow points are legal: load, never an arbitrary point count, is the gate.
        List<MeasurementBudget.Candidate> many = new ArrayList<>();
        for (int i = 0; i < 1_000; i++) {
            many.add(point("slow" + i, 3600, "same-cheap-block", 400));
        }
        assertThat(MeasurementBudget.estimate(many).hardRejected()).isFalse();
    }

    @Test
    void hardSampleRequestAndDutyLimitsAreIndependent() {
        List<MeasurementBudget.Candidate> sampleFlood = new ArrayList<>();
        for (int i = 0; i < 51; i++) {
            sampleFlood.add(point("p" + i, 5, "one-block", 400));
        }
        var samples = MeasurementBudget.estimate(sampleFlood);
        assertThat(samples.samplesPerMinute()).isEqualTo(612.0);
        assertThat(samples.hardRejected()).isTrue();
        assertThat(samples.reasons()).anyMatch(s -> s.contains("600"));

        List<MeasurementBudget.Candidate> requestFlood = new ArrayList<>();
        for (int i = 0; i < 31; i++) {
            requestFlood.add(point("r" + i, 60, "block-" + i, 400));
        }
        var requests = MeasurementBudget.estimate(requestFlood);
        assertThat(requests.requestsPerMinute()).isEqualTo(31.0);
        assertThat(requests.dutyCyclePercent()).isGreaterThan(20.0);
        assertThat(requests.reasons()).anyMatch(s -> s.contains("30 Leseanfragen"));
        assertThat(requests.reasons()).anyMatch(s -> s.contains("20 %"));
    }

    @Test
    void aBenchCalibratedDriverBudgetCanOnlyTightenTheGlobalLimit() {
        List<MeasurementBudget.Candidate> points = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            points.add(new MeasurementBudget.Candidate("p" + i, true, 6, "one-block", 400,
                    FIFTEEN, "bench-driver"));
        }
        var estimate = MeasurementBudget.estimate(points, Map.of("bench-driver", 90));

        assertThat(estimate.samplesPerMinute()).isEqualTo(100.0);
        assertThat(estimate.hardSamplesPerMinute()).isEqualTo(90.0);
        assertThat(estimate.limitingDriverFamilies()).containsExactly("bench-driver");
        assertThat(estimate.hardRejected()).isTrue();
        assertThat(estimate.reasons()).anyMatch(s -> s.contains("engere Treiberbudget"));

        // A driver budget above D5's ceiling is a hard configuration error,
        // rather than a silently ignored value that could hide bad metadata.
        assertThat(MeasurementBudget.estimate(points, Map.of("bench-driver", 900))
                .hardRejected()).isTrue();
    }

    @Test
    void annualVolumeUses96BytesNinetyRawDaysAndSemanticLongTermLane() {
        var estimate = MeasurementBudget.estimate(List.of(point("temperature", 60, "bms", 400)));

        assertThat(estimate.rawRetentionDays()).isEqualTo(90);
        assertThat(estimate.assumedBytesPerSample()).isEqualTo(96);
        assertThat(estimate.totalGbPerYear()).isBetween(0.014, 0.016);
        assertThat(estimate.volumeEstimateIncomplete()).isFalse();
    }

    @Test
    void invalidCadenceCostAndRetentionInputsFailClosedWithFiniteNonNegativeResults() {
        List<MeasurementBudget.Candidate> invalid = List.of(
                point("zero", 0, "block", 400),
                point("negative", -1, "block", 400),
                point("extreme", Integer.MAX_VALUE, "block", 400),
                point("cost", 60, "block", Integer.MAX_VALUE));

        for (MeasurementBudget.Candidate candidate : invalid) {
            var estimate = MeasurementBudget.estimate(Collections.singletonList(candidate));
            assertThat(estimate.hardRejected()).isTrue();
            assertThat(estimate.samplesPerMinute()).isFinite().isGreaterThanOrEqualTo(0.0);
            assertThat(estimate.requestsPerMinute()).isFinite().isGreaterThanOrEqualTo(0.0);
            assertThat(estimate.dutyCyclePercent()).isFinite().isGreaterThanOrEqualTo(0.0);
            assertThat(estimate.rawGbPerYear()).isFinite().isGreaterThanOrEqualTo(0.0);
            assertThat(estimate.longTermGbPerYear()).isFinite().isGreaterThanOrEqualTo(0.0);
            assertThat(estimate.totalGbPerYear()).isFinite().isGreaterThanOrEqualTo(0.0);
        }

        var invalidRetention = MeasurementBudget.estimate(List.of(
                new MeasurementBudget.Candidate("retention", true, 60, "block", 400,
                        new MeasurementRetention("thermal_bms", -1, 900, "fifteen_minute"),
                        "driver")));
        assertThat(invalidRetention.hardRejected()).isTrue();
        assertThat(invalidRetention.totalGbPerYear()).isEqualTo(0.0);

        assertThat(MeasurementBudget.estimate(Collections.singletonList(null)).hardRejected())
                .isTrue();
        assertThat(MeasurementBudget.estimate(List.of(point("driver", 60, "driver", 400)),
                Map.of("driver", -1)).hardRejected()).isTrue();

        var nullCadence = MeasurementBudget.estimate(List.of(new MeasurementBudget.Candidate(
                "null-cadence", true, null, "block", 400, FIFTEEN, "driver")));
        assertThat(nullCadence.hardRejected()).isTrue();

        var zeroCost = MeasurementBudget.estimate(List.of(point("zero-cost", 60, "block", 0)));
        assertThat(zeroCost.hardRejected()).isTrue();

        var unknownStrategy = MeasurementBudget.estimate(List.of(new MeasurementBudget.Candidate(
                "bad-retention", true, 60, "block", 400,
                new MeasurementRetention("thermal_bms", 90, 900, "bogus"), "driver")));
        assertThat(unknownStrategy.hardRejected()).isTrue();

        var extremeDriver = MeasurementBudget.estimate(List.of(point("driver", 60, "driver", 400)),
                Map.of("driver", Integer.MAX_VALUE));
        assertThat(extremeDriver.hardRejected()).isTrue();
    }

    @Test
    void numericAccumulationCannotEscapeFiniteResultContract() {
        // A large valid input exercises accumulation and the finite-result guard
        // without relying on a client-controlled floating-point value.
        List<MeasurementBudget.Candidate> many = new ArrayList<>();
        for (int i = 0; i < 100_000; i++) {
            many.add(point("overflow-" + i, 1, "block-" + i, 60_000));
        }
        var estimate = MeasurementBudget.estimate(many);
        assertThat(estimate.samplesPerMinute()).isFinite().isGreaterThanOrEqualTo(0.0);
        assertThat(estimate.requestsPerMinute()).isFinite().isGreaterThanOrEqualTo(0.0);
        assertThat(estimate.dutyCyclePercent()).isFinite().isGreaterThanOrEqualTo(0.0);
        assertThat(estimate.totalGbPerYear()).isFinite().isGreaterThanOrEqualTo(0.0);
    }

    private static MeasurementBudget.Candidate point(String key, int cadence, String group,
            int cost) {
        return new MeasurementBudget.Candidate(key, true, cadence, group, cost, FIFTEEN,
                "default-driver");
    }
}
