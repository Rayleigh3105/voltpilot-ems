package com.voltpilot.api.measurement;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
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

        // A misconfigured value above D5's ceiling never widens 600.
        assertThat(MeasurementBudget.estimate(points, Map.of("bench-driver", 900))
                .hardSamplesPerMinute()).isEqualTo(600.0);
    }

    @Test
    void annualVolumeUses96BytesNinetyRawDaysAndSemanticLongTermLane() {
        var estimate = MeasurementBudget.estimate(List.of(point("temperature", 60, "bms", 400)));

        assertThat(estimate.rawRetentionDays()).isEqualTo(90);
        assertThat(estimate.assumedBytesPerSample()).isEqualTo(96);
        assertThat(estimate.totalGbPerYear()).isBetween(0.014, 0.016);
        assertThat(estimate.volumeEstimateIncomplete()).isFalse();
    }

    private static MeasurementBudget.Candidate point(String key, int cadence, String group,
            int cost) {
        return new MeasurementBudget.Candidate(key, true, cadence, group, cost, FIFTEEN,
                "default-driver");
    }
}
