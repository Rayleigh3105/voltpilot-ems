package com.voltpilot.api.optimizer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;

import java.time.Instant;
import java.time.LocalDate;
import org.junit.jupiter.api.Test;

/**
 * Pins the Java feste-Vergütung schedule against the Python source of truth
 * (services/optimization voltpilot_optimization/config.py +
 * tests/test_pricing.py) - the SAME vectors, so the two sides cannot drift:
 * the diagnostics must show exactly the export value the solver priced with.
 */
class EegRatesTest {

    private final EegRates rates = EegRates.defaults();

    @Test
    void blendedRateWeightsTheTranches() {
        // test_pricing.test_blended_rate_weights_the_tranches: 25 kWp @ 2023-06-15
        // = (10*8.2 + 15*7.1) / 25; 60 kWp = (10*8.2 + 30*7.1 + 20*5.8) / 60.
        assertThat(rates.festeVerguetungCtPerKwh(LocalDate.of(2023, 6, 15), 25.0))
                .isCloseTo((10 * 8.2 + 15 * 7.1) / 25.0, within(1e-9));
        assertThat(rates.festeVerguetungCtPerKwh(LocalDate.of(2023, 6, 15), 60.0))
                .isCloseTo((10 * 8.2 + 30 * 7.1 + 20 * 5.8) / 60.0, within(1e-9));
    }

    @Test
    void unknownCapacityAssumesTheSmallestBand() {
        assertThat(rates.festeVerguetungCtPerKwh(LocalDate.of(2023, 6, 15), null))
                .isEqualTo(8.2);
    }

    @Test
    void degressionStepsAndPreScheduleDates() {
        // test_pricing.test_degression_steps_and_pre_schedule_dates.
        assertThat(rates.festeVerguetungCtPerKwh(LocalDate.of(2024, 9, 1), 5.0))
                .isEqualTo(8.03);
        assertThat(rates.festeVerguetungCtPerKwh(LocalDate.of(2010, 1, 1), 5.0))
                .isEqualTo(24.4);
    }

    @Test
    void remunerationExpiresAfterTwentyYearsPlusCommissioningYear() {
        LocalDate commissioned = LocalDate.of(2004, 6, 1);
        // Dec 31 of 2024 (Berlin) is still remunerated; 2025 is not.
        assertThat(EegRates.remunerationExpired(commissioned,
                Instant.parse("2024-12-31T12:00:00Z"))).isFalse();
        assertThat(EegRates.remunerationExpired(commissioned,
                Instant.parse("2025-06-01T12:00:00Z"))).isTrue();
    }

    @Test
    void solarspitzengesetzCutoffMatchesThePythonConstant() {
        assertThat(EegRates.SOLARSPITZENGESETZ_CUTOFF).isEqualTo(LocalDate.of(2025, 2, 25));
    }

    @Test
    void envJsonOverrideReplacesTheScheduleWholesale() {
        EegRates custom = EegRates.fromJson(
                "[{\"from\": \"2020-01-01\", \"le10\": 50.0, \"le40\": 40.0, \"le100\": 30.0}]");
        assertThat(custom.festeVerguetungCtPerKwh(LocalDate.of(2023, 6, 15), 5.0))
                .isEqualTo(50.0);
        // Blank = the built-in schedule.
        assertThat(EegRates.fromJson("  ").festeVerguetungCtPerKwh(
                LocalDate.of(2023, 6, 15), null)).isEqualTo(8.2);
    }

    @Test
    void garbageJsonFailsLoudly() {
        assertThatThrownBy(() -> EegRates.fromJson("not json"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("OPTIMIZER_EEG_RATES_JSON");
        assertThatThrownBy(() -> EegRates.fromJson("[]"))
                .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> EegRates.fromJson(
                "[{\"from\": \"2020-01-01\", \"le10\": -1, \"le40\": 1, \"le100\": 1}]"))
                .isInstanceOf(IllegalStateException.class);
    }
}
