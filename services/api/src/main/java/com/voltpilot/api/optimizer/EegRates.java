package com.voltpilot.api.optimizer;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * The feste EEG-Einspeisevergütung schedule - the Java TWIN of
 * services/optimization {@code voltpilot_optimization/config.py}
 * ({@code DEFAULT_EEG_RATE_SCHEDULE} + {@code feste_verguetung_ct_per_kwh})
 * and the expiry/§51a rules of {@code pricing.py}. The admin optimizer
 * diagnostics use it to reconstruct the per-slot export value the solver
 * priced an {@code eigenverbrauch} plant's feed-in at; the two sides MUST stay
 * byte-for-byte on the same numbers ({@code EegRatesTest} pins the shared
 * vectors against test_pricing.py's).
 *
 * <p>Rooftop-PV Teileinspeisung rates per commissioning date, tranche-wise:
 * the first 10 kWp earn the {@code le10} rate, the next 30 kWp {@code le40},
 * capacity above 40 kWp {@code le100}; the rate is locked at commissioning for
 * 20 years plus the commissioning year. Unknown capacity assumes the &le;10 kWp
 * band; pre-2012 dates use the first band (documented approximations - see the
 * Python module docstring for provenance).
 *
 * <p>{@code OPTIMIZER_EEG_RATES_JSON} replaces the schedule wholesale on the
 * OPTIMIZER; the api reads the same env ({@code voltpilot.optimizer
 * .eeg-rates-json}) so a rate correction never makes the diagnostics lie.
 * Garbage JSON fails construction loudly (the optimizer would refuse it too).
 */
public final class EegRates {

    /** Solarspitzengesetz (§51a EEG) entry into force: plants commissioned on/after
     * this date earn NO feste Vergütung in negative-price slots. */
    public static final LocalDate SOLARSPITZENGESETZ_CUTOFF = LocalDate.of(2025, 2, 25);

    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");

    /** One validity window: tranche rates (ct/kWh) for commissionings >= validFrom. */
    public record Band(LocalDate validFrom, double le10Ct, double le40Ct, double le100Ct) {
    }

    /** Mirrors config.py DEFAULT_EEG_RATE_SCHEDULE - keep the two in sync. */
    private static final List<Band> DEFAULT_SCHEDULE = List.of(
            // Coarse annual anchors (approximation - the real degression was monthly).
            new Band(LocalDate.of(2012, 1, 1), 24.4, 23.2, 21.9),
            new Band(LocalDate.of(2013, 1, 1), 17.0, 16.1, 14.4),
            new Band(LocalDate.of(2014, 1, 1), 13.7, 13.0, 11.6),
            new Band(LocalDate.of(2015, 1, 1), 12.6, 12.2, 10.9),
            new Band(LocalDate.of(2016, 1, 1), 12.3, 12.0, 10.7),
            new Band(LocalDate.of(2017, 1, 1), 12.3, 12.0, 10.7),
            new Band(LocalDate.of(2018, 1, 1), 12.2, 11.9, 10.6),
            new Band(LocalDate.of(2019, 1, 1), 11.5, 11.2, 10.0),
            new Band(LocalDate.of(2020, 1, 1), 9.9, 9.6, 7.6),
            new Band(LocalDate.of(2021, 1, 1), 8.2, 8.0, 6.3),
            new Band(LocalDate.of(2022, 1, 1), 6.9, 6.7, 5.3),
            // EEG 2023 (exact): fixed 2022-07-30 .. 2024-01-31, then 1% every 6 months.
            new Band(LocalDate.of(2022, 7, 30), 8.2, 7.1, 5.8),
            new Band(LocalDate.of(2024, 2, 1), 8.11, 7.03, 5.74),
            new Band(LocalDate.of(2024, 8, 1), 8.03, 6.95, 5.68),
            new Band(LocalDate.of(2025, 2, 1), 7.94, 6.88, 5.62),
            new Band(LocalDate.of(2025, 8, 1), 7.86, 6.80, 5.56),
            new Band(LocalDate.of(2026, 2, 1), 7.78, 6.73, 5.51));

    private final List<Band> bands;

    private EegRates(List<Band> bands) {
        this.bands = List.copyOf(bands);
    }

    /** The built-in schedule (config.py DEFAULT_EEG_RATE_SCHEDULE). */
    public static EegRates defaults() {
        return new EegRates(DEFAULT_SCHEDULE);
    }

    /**
     * The schedule from the {@code OPTIMIZER_EEG_RATES_JSON} shape (a JSON array
     * of {@code {"from": "YYYY-MM-DD", "le10": ct, "le40": ct, "le100": ct}}
     * objects); blank = the built-in schedule. Garbage raises loudly, exactly
     * like the Python side's env-typo discipline.
     */
    public static EegRates fromJson(String json) {
        if (json == null || json.isBlank()) {
            return defaults();
        }
        try {
            JsonNode root = new ObjectMapper().readTree(json);
            if (!root.isArray() || root.isEmpty()) {
                throw new IllegalArgumentException("must be a non-empty JSON array");
            }
            List<Band> parsed = new ArrayList<>();
            for (JsonNode item : root) {
                parsed.add(new Band(
                        LocalDate.parse(item.get("from").asText()),
                        requireRate(item, "le10"),
                        requireRate(item, "le40"),
                        requireRate(item, "le100")));
            }
            parsed.sort(Comparator.comparing(Band::validFrom));
            return new EegRates(parsed);
        } catch (Exception e) {
            throw new IllegalStateException(
                    "OPTIMIZER_EEG_RATES_JSON must be a JSON array of "
                            + "{\"from\": \"YYYY-MM-DD\", \"le10\": ct, \"le40\": ct, \"le100\": ct} "
                            + "objects: " + e.getMessage(), e);
        }
    }

    private static double requireRate(JsonNode item, String field) {
        JsonNode v = item.get(field);
        if (v == null || !v.isNumber() || v.asDouble() < 0) {
            throw new IllegalArgumentException("rate '" + field + "' must be a number >= 0");
        }
        return v.asDouble();
    }

    /**
     * The blended (capacity-weighted, tranche-wise) feste Teileinspeisung rate
     * for a plant of the given size and commissioning date, ct/kWh. Unknown
     * capacity assumes the &le;10 kWp band (the highest rate - an unknown size
     * never under-values export); pre-schedule dates use the first band.
     * Mirrors pricing.py {@code feste_verguetung_ct_per_kwh}.
     */
    public double festeVerguetungCtPerKwh(LocalDate commissionedOn, Double pvCapacityKwp) {
        Band band = bands.get(0);
        for (Band candidate : bands) {
            if (!candidate.validFrom().isAfter(commissionedOn)) {
                band = candidate;
            } else {
                break;
            }
        }
        if (pvCapacityKwp == null || pvCapacityKwp <= 10.0) {
            return band.le10Ct();
        }
        double kwp = pvCapacityKwp;
        double tranche10 = Math.min(kwp, 10.0);
        double tranche40 = Math.min(Math.max(kwp - 10.0, 0.0), 30.0);
        double trancheRest = Math.max(kwp - 40.0, 0.0);
        return (tranche10 * band.le10Ct()
                + tranche40 * band.le40Ct()
                + trancheRest * band.le100Ct()) / kwp;
    }

    /**
     * EEG remuneration runs for 20 years plus the commissioning year: it ends on
     * Dec 31 (Berlin) of the 20th year after the commissioning year. Mirrors
     * pricing.py {@code _remuneration_expired}.
     */
    public static boolean remunerationExpired(LocalDate commissionedOn, Instant at) {
        return at.atZone(BERLIN).getYear() > commissionedOn.getYear() + 20;
    }
}
