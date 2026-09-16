package com.voltpilot.api.history;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.web.dto.HistoryBucketDto;
import com.voltpilot.api.web.dto.HistoryTotalsDto;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Unit tests of the period-window arithmetic (Europe/Berlin boundaries, ISO
 * weeks, DST offsets) and the totals formulas (Autarkiegrad,
 * Eigenverbrauchsquote, null semantics). Pure, no Spring/DB.
 */
class HistoryRangeTest {

    @Test
    void dayWindowIsBerlinLocalMidnightToMidnight() {
        // CEST (+02:00) in June...
        HistoryRange.Window summer = HistoryRange.DAY.window(LocalDate.parse("2026-06-15"));
        assertThat(summer.from()).isEqualTo(Instant.parse("2026-06-14T22:00:00Z"));
        assertThat(summer.to()).isEqualTo(Instant.parse("2026-06-15T22:00:00Z"));
        // ...CET (+01:00) in January.
        HistoryRange.Window winter = HistoryRange.DAY.window(LocalDate.parse("2026-01-10"));
        assertThat(winter.from()).isEqualTo(Instant.parse("2026-01-09T23:00:00Z"));
        assertThat(winter.to()).isEqualTo(Instant.parse("2026-01-10T23:00:00Z"));
    }

    @Test
    void weekWindowStartsOnTheIsoMonday() {
        // 2026-06-17 is a Wednesday; its ISO week starts Monday 2026-06-15.
        HistoryRange.Window w = HistoryRange.WEEK.window(LocalDate.parse("2026-06-17"));
        assertThat(w.from()).isEqualTo(Instant.parse("2026-06-14T22:00:00Z"));
        assertThat(w.to()).isEqualTo(Instant.parse("2026-06-21T22:00:00Z"));
    }

    @Test
    void monthAndYearWindowsAreCalendarPeriods() {
        HistoryRange.Window m = HistoryRange.MONTH.window(LocalDate.parse("2026-06-17"));
        assertThat(m.from()).isEqualTo(Instant.parse("2026-05-31T22:00:00Z"));
        assertThat(m.to()).isEqualTo(Instant.parse("2026-06-30T22:00:00Z"));

        HistoryRange.Window y = HistoryRange.YEAR.window(LocalDate.parse("2026-06-17"));
        assertThat(y.from()).isEqualTo(Instant.parse("2025-12-31T23:00:00Z"));
        assertThat(y.to()).isEqualTo(Instant.parse("2026-12-31T23:00:00Z"));
    }

    @Test
    void parseIsCaseInsensitiveAndNullSafeOnGarbage() {
        assertThat(HistoryRange.parse("day")).isEqualTo(HistoryRange.DAY);
        assertThat(HistoryRange.parse("WEEK")).isEqualTo(HistoryRange.WEEK);
        assertThat(HistoryRange.parse("Month")).isEqualTo(HistoryRange.MONTH);
        assertThat(HistoryRange.parse("year")).isEqualTo(HistoryRange.YEAR);
        assertThat(HistoryRange.parse("decade")).isNull();
        assertThat(HistoryRange.parse(null)).isNull();
    }

    // ---- totals formulas ------------------------------------------------------

    @Test
    void totalsComputeAutarkieAndEigenverbrauch() {
        // consumption 10 kWh, pv 8, import 4, export 2:
        //   Autarkiegrad        = (1 - 4/10) * 100  = 60.0 %
        //   Eigenverbrauchsquote = (8 - 2)/8 * 100  = 75.0 %
        HistoryTotalsDto t = HistoryService.totals(List.of(
                bucket(5, 4, 3, 1, 0.30), bucket(5, 4, 1, 1, null)), null);
        assertThat(t.consumptionKwh()).isEqualByComparingTo("10");
        assertThat(t.pvGenerationKwh()).isEqualByComparingTo("8");
        assertThat(t.gridImportKwh()).isEqualByComparingTo("4");
        assertThat(t.gridExportKwh()).isEqualByComparingTo("2");
        assertThat(t.autarkiePct()).isEqualByComparingTo("60.0");
        assertThat(t.eigenverbrauchPct()).isEqualByComparingTo("75.0");
        // One priced bucket -> its cost, not null.
        assertThat(t.gridCostEur()).isEqualByComparingTo("0.30");
        // No plan slots in the window -> savings stays null ("where plans exist").
        assertThat(t.batterySavingsEur()).isNull();
    }

    /**
     * AP-10 E16 Nr. 5, the normal case: meters that add up deliver the SAME
     * number as before the clamp was lifted - same value, same scale - and the
     * flag says so. The repair must not move a single plausible figure.
     */
    @Test
    void totalsPlausibleRatiosAreUnchangedAndNotFlagged() {
        HistoryTotalsDto t = HistoryService.totals(List.of(
                bucket(5, 4, 3, 1, 0.30), bucket(5, 4, 1, 1, null)), null);
        assertThat(t.autarkiePct()).isEqualTo(new BigDecimal("60.0"));
        assertThat(t.eigenverbrauchPct()).isEqualTo(new BigDecimal("75.0"));
        assertThat(t.autarkieUnplausibel()).isFalse();
        assertThat(t.eigenverbrauchUnplausibel()).isFalse();

        // The edges of the range are plausible: no import at all is 100 %
        // autark, exporting everything generated is 0 % Eigenverbrauch.
        HistoryTotalsDto edges = HistoryService.totals(List.of(bucket(10, 8, 0, 8, null)), null);
        assertThat(edges.autarkiePct()).isEqualTo(new BigDecimal("100.0"));
        assertThat(edges.eigenverbrauchPct()).isEqualTo(new BigDecimal("0.0"));
        assertThat(edges.autarkieUnplausibel()).isFalse();
        assertThat(edges.eigenverbrauchUnplausibel()).isFalse();
    }

    /**
     * AP-10 E16 Nr. 5: meters that do NOT add up are reported, not bent into
     * 0..100. Import above consumption and export above generation give
     * negative shares; before the fix both read a confident 0.0 - and a
     * negative import a perfect 100.0 % Autarkie.
     */
    @Test
    void totalsImplausibleRatiosTravelUnclampedWithFlag() {
        // consumption 10, import 12 -> (1 - 12/10) * 100 = -20.0
        // pv 8, export 10          -> (8 - 10)/8 * 100  = -25.0
        HistoryTotalsDto below = HistoryService.totals(List.of(bucket(10, 8, 12, 10, null)), null);
        assertThat(below.autarkiePct()).isEqualTo(new BigDecimal("-20.0"));
        assertThat(below.eigenverbrauchPct()).isEqualTo(new BigDecimal("-25.0"));
        assertThat(below.autarkieUnplausibel()).isTrue();
        assertThat(below.eigenverbrauchUnplausibel()).isTrue();

        // A negative import (a meter counting the wrong way) -> 110.0 % Autarkie.
        HistoryTotalsDto above = HistoryService.totals(List.of(bucket(10, 8, -1, 2, null)), null);
        assertThat(above.autarkiePct()).isEqualTo(new BigDecimal("110.0"));
        assertThat(above.autarkieUnplausibel()).isTrue();
        // Each ratio carries its own flag: this one's meters add up.
        assertThat(above.eigenverbrauchPct()).isEqualTo(new BigDecimal("75.0"));
        assertThat(above.eigenverbrauchUnplausibel()).isFalse();
    }

    @Test
    void totalsFeatureSwitchRestoresTheLegacyVisibleClamp() {
        HistoryTotalsDto legacy = HistoryService.totals(
                List.of(bucket(10, 8, 12, 10, null)),
                new com.voltpilot.api.repo.HistoryRepository.PlannedSavings(null, null),
                null,
                false);

        assertThat(legacy.autarkiePct()).isEqualTo(new BigDecimal("0.0"));
        assertThat(legacy.eigenverbrauchPct()).isEqualTo(new BigDecimal("0.0"));
        assertThat(legacy.autarkieUnplausibel()).isFalse();
        assertThat(legacy.eigenverbrauchUnplausibel()).isFalse();
    }

    /**
     * Audit V2/X1: a 0-bucket period must return "—" for EVERY aggregate, not a
     * confident 0,0 kWh next to an honest "noch keine Daten". Before the fix the
     * energy sums answered 0.0 while the cost fields correctly answered null.
     */
    @Test
    void totalsNullSemanticsForEmptyData() {
        HistoryTotalsDto empty = HistoryService.totals(List.of(), null);
        assertThat(empty.consumptionKwh()).isNull();
        assertThat(empty.pvGenerationKwh()).isNull();
        assertThat(empty.gridImportKwh()).isNull();
        assertThat(empty.gridExportKwh()).isNull();
        assertThat(empty.autarkiePct()).isNull(); // no consumption -> undefined
        assertThat(empty.eigenverbrauchPct()).isNull(); // no PV -> undefined
        // Unknown is neither plausible nor implausible.
        assertThat(empty.autarkieUnplausibel()).isNull();
        assertThat(empty.eigenverbrauchUnplausibel()).isNull();
        assertThat(empty.gridCostEur()).isNull(); // no priced bucket at all
        assertThat(empty.batterySavingsPlannedEur()).isNull();
    }

    /**
     * The same discipline per CHANNEL: a plant that measures load but no PV at
     * all reports pv = null (never 0), and the ratio that needs it is undefined.
     */
    @Test
    void totalsNullAChannelNoBucketCarried() {
        HistoryBucketDto loadOnly = new HistoryBucketDto(Instant.parse("2026-06-15T10:00:00Z"),
                null, BigDecimal.valueOf(4), null, null,
                null, null, null, null, null, null, null);
        HistoryTotalsDto t = HistoryService.totals(List.of(loadOnly), null);
        assertThat(t.consumptionKwh()).isEqualByComparingTo("4");
        assertThat(t.pvGenerationKwh()).isNull();
        assertThat(t.gridImportKwh()).isNull();
        assertThat(t.eigenverbrauchPct()).isNull();
        assertThat(t.autarkiePct()).isNull(); // import unknown -> not "100 % autark"
    }

    /**
     * Audit H3/H8: the planned savings carry a name that says so, and the
     * spot-priced gridCost carries the site's tariff context. The deprecated
     * alias mirrors the planned value for one release.
     */
    @Test
    void totalsCarryThePlannedSavingsNameAndTheTariffContext() {
        HistoryTotalsDto t = HistoryService.totals(
                List.of(bucket(5, 4, 3, 1, 0.30)),
                new com.voltpilot.api.repo.HistoryRepository.PlannedSavings(
                        BigDecimal.valueOf(150.26), BigDecimal.valueOf(43.11)),
                new com.voltpilot.api.repo.HistoryRepository.TariffContext("ohne", false));
        assertThat(t.batterySavingsPlannedEur()).isEqualByComparingTo("150.26");
        assertThat(t.batterySavingsEur()).isEqualByComparingTo("150.26"); // deprecated alias
        // Die MESSLATTE reist daneben (Captain 04.09.2026): was der Plan gegen
        // DENSELBEN Speicher OHNE smarte Steuerung erwirtschaftet.
        assertThat(t.steuerungPlannedEur()).isEqualByComparingTo("43.11");
        assertThat(t.tarifArt()).isEqualTo("ohne");
        // Stufe 3: the label switch travels with the number - a bare-spot site
        // must read "zu Börsenpreisen", a tariff-valued one the tariff copy.
        assertThat(t.tarifPriced()).isFalse();
        assertThat(HistoryService.totals(
                List.of(bucket(5, 4, 3, 1, 0.30)),
                new com.voltpilot.api.repo.HistoryRepository.PlannedSavings(null, null),
                new com.voltpilot.api.repo.HistoryRepository.TariffContext("fest", true))
                .tarifPriced()).isTrue();

        // No tariff context available (older/unreadable site) -> null, not a guess.
        assertThat(HistoryService.totals(List.of(), null).tarifArt()).isNull();
        assertThat(HistoryService.totals(List.of(), null).tarifPriced()).isNull();
    }

    private static HistoryBucketDto bucket(
            double loadKwh, double pvKwh, double importKwh, double exportKwh, Double costEur) {
        return new HistoryBucketDto(Instant.parse("2026-06-15T10:00:00Z"),
                BigDecimal.valueOf(pvKwh), BigDecimal.valueOf(loadKwh),
                BigDecimal.valueOf(importKwh), BigDecimal.valueOf(exportKwh),
                null, null, null, null, null, null,
                costEur == null ? null : BigDecimal.valueOf(costEur));
    }
}
