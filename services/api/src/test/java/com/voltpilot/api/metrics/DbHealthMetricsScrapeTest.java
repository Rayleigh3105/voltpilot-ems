package com.voltpilot.api.metrics;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.metrics.DbHealthMetrics.HypertableSize;
import com.voltpilot.api.metrics.DbHealthMetrics.JobStat;
import com.voltpilot.api.metrics.DbHealthMetrics.OptimizerCycle;
import com.voltpilot.api.repo.DbHealthMetricsRepository;
import io.micrometer.prometheusmetrics.PrometheusConfig;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * <b>Der Vertrag der Datenhaltungs-Metriken, gelesen aus dem ECHTEN
 * Scrape-Rumpf.</b> Wie {@code FleetMetricsScrapeTest}: die Alarm-Regeln kennen
 * von hier nur Zeichenketten, also zaehlt einzig, was am Draht steht - Namen,
 * Labels, die Ausblendung des Nutzungs-Reporters und die Ehrlichkeitsregeln
 * (kein erfundener Wert fuer einen nie gelaufenen Job / einen fehlenden Zyklus).
 * Ohne Spring, ohne Docker: die Datenbank ist eine Attrappe.
 */
class DbHealthMetricsScrapeTest {

    private static final Instant NOW = Instant.parse("2026-08-31T12:20:00Z");

    /** Eine ueberschreibbare Attrappe der Datenbank-Schicht. */
    private static final class StubRepo extends DbHealthMetricsRepository {
        private List<HypertableSize> sizes = new ArrayList<>();
        private List<JobStat> jobs = new ArrayList<>();
        private OptimizerCycle cycle;
        private boolean explode;

        StubRepo() {
            super(null);
        }

        @Override
        public List<HypertableSize> hypertableSizes() {
            if (explode) {
                throw new IllegalStateException("Failed to obtain JDBC Connection");
            }
            return sizes;
        }

        @Override
        public List<JobStat> jobStats() {
            return jobs;
        }

        @Override
        public OptimizerCycle latestOptimizerCycle() {
            return cycle;
        }
    }

    /** Eine gesunde Anlage mit einem gescheiterten und einem gesunden Job. */
    private static StubRepo fleet() {
        StubRepo repo = new StubRepo();
        repo.sizes.add(new HypertableSize("telemetry", 12_000_000L));
        repo.sizes.add(new HypertableSize("forecast", 3_000_000L));

        // Ein fehlgeschlagener Retention-Job, ein gesunder Kompressions-Job, ein
        // noch nie gelaufener, und der TimescaleDB-Nutzungs-Reporter (muss RAUS).
        repo.jobs.add(new JobStat(1000, "policy_retention", "Failed", 4L));
        repo.jobs.add(new JobStat(1001, "policy_compression", "Success", 0L));
        repo.jobs.add(new JobStat(1002, "policy_refresh_continuous_aggregate", null, null));
        repo.jobs.add(new JobStat(1, DbHealthMetrics.USAGE_REPORTER_PROC, "Failed", 9L));

        // Zyklus vor 5 Minuten, 41,5 s, 57 geplant / 3 uebersprungen.
        repo.cycle = new OptimizerCycle(
                NOW.minus(Duration.ofMinutes(5)), 41.5, 57, 3, 192);
        return repo;
    }

    private static String scrapeOf(StubRepo repo) {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        DbHealthMetricsCollector collector = new DbHealthMetricsCollector(
                repo, registry, Clock.fixed(NOW, ZoneOffset.UTC));
        collector.collect();
        return registry.scrape();
    }

    private static String line(String scrape, String prefix) {
        return scrape.lines().filter(l -> l.startsWith(prefix)).findFirst().orElse(null);
    }

    @Test
    void theContractNamesAppearVerbatimInTheScrape() {
        String scrape = scrapeOf(fleet());
        assertThat(scrape)
                .contains("voltpilot_db_total_bytes{")
                .contains("voltpilot_db_job_last_run_failed{")
                .contains("voltpilot_db_job_total_failures{")
                .contains("voltpilot_optimizer_cycle_seconds ")
                .contains("voltpilot_optimizer_cycle_age_seconds ");
    }

    @Test
    void noSuffixIsAppendedToAnyContractName() {
        String scrape = scrapeOf(fleet());
        // Der Fallstrick: eine gesetzte baseUnit haengte _bytes/_seconds an. Es
        // darf KEINE voltpilot_-Zeile geben, deren Name nicht vereinbart ist.
        Set<String> vereinbart = Set.of(
                DbHealthMetricsCollector.DB_TOTAL_BYTES,
                DbHealthMetricsCollector.JOB_LAST_RUN_FAILED,
                DbHealthMetricsCollector.JOB_TOTAL_FAILURES,
                DbHealthMetricsCollector.OPTIMIZER_CYCLE_SECONDS,
                DbHealthMetricsCollector.OPTIMIZER_CYCLE_SITES_PLANNED,
                DbHealthMetricsCollector.OPTIMIZER_CYCLE_SITES_SKIPPED,
                DbHealthMetricsCollector.OPTIMIZER_CYCLE_AGE_SECONDS,
                DbHealthMetricsCollector.COLLECT_AGE,
                DbHealthMetricsCollector.COLLECT_DURATION);

        List<String> gefunden = scrape.lines()
                .filter(l -> l.startsWith("voltpilot_"))
                .map(l -> l.substring(0, indexOfNameEnd(l)))
                .distinct()
                .toList();

        assertThat(gefunden).isNotEmpty().allSatisfy(name ->
                assertThat(vereinbart).as("unerwarteter Metrikname im Scrape: %s", name)
                        .contains(name));
        assertThat(gefunden).containsAll(vereinbart);
    }

    @Test
    void everyHypertableGetsItsOwnSizeSeries() {
        String scrape = scrapeOf(fleet());
        assertThat(line(scrape, "voltpilot_db_total_bytes{table=\"telemetry\"}"))
                .endsWith(" 1.2E7");
        assertThat(line(scrape, "voltpilot_db_total_bytes{table=\"forecast\"}"))
                .endsWith(" 3000000.0");
        // Kein vorgerechnetes Total, das sum() doppelt zaehlen wuerde.
        assertThat(scrape).doesNotContain("table=\"_all\"").doesNotContain("table=\"all\"");
    }

    @Test
    void aFailedJobIsOneAndAHealthyJobIsZero() {
        String scrape = scrapeOf(fleet());
        assertThat(line(scrape, "voltpilot_db_job_last_run_failed{job_id=\"1000\","
                + "proc=\"policy_retention\"}")).endsWith(" 1.0");
        assertThat(line(scrape, "voltpilot_db_job_last_run_failed{job_id=\"1001\","
                + "proc=\"policy_compression\"}")).endsWith(" 0.0");
        assertThat(line(scrape, "voltpilot_db_job_total_failures{job_id=\"1000\","
                + "proc=\"policy_retention\"}")).endsWith(" 4.0");
    }

    @Test
    void aJobThatNeverRanExportsNoFailedSeriesButSaysNothingFalse() {
        String scrape = scrapeOf(fleet());
        // Kein erfundenes 0 (= "erfolgreich") fuer einen nie gelaufenen Job.
        assertThat(scrape).doesNotContain(
                "voltpilot_db_job_last_run_failed{job_id=\"1002\"");
        assertThat(scrape).doesNotContain(
                "voltpilot_db_job_total_failures{job_id=\"1002\"");
    }

    @Test
    void theTimescaleUsageReporterIsExcludedSoOfflineDoesNotFalseAlarm() {
        String scrape = scrapeOf(fleet());
        // DER Fehlalarm-Fall: policy_telemetry (job 1) steht ohne Internet auf
        // Failed, ist aber keiner unserer Pflege-Jobs - er darf NIE erscheinen.
        assertThat(scrape).doesNotContain("job_id=\"1\"");
        assertThat(scrape).doesNotContain("proc=\"" + DbHealthMetrics.USAGE_REPORTER_PROC + "\"");
    }

    @Test
    void theOptimizerCycleValuesAreTheRealNumbers() {
        String scrape = scrapeOf(fleet());
        assertThat(line(scrape, "voltpilot_optimizer_cycle_seconds ")).endsWith(" 41.5");
        assertThat(line(scrape, "voltpilot_optimizer_cycle_sites_planned ")).endsWith(" 57.0");
        assertThat(line(scrape, "voltpilot_optimizer_cycle_sites_skipped ")).endsWith(" 3.0");
        // 5 Minuten seit dem Zyklus-Ende, beim Scrape gerechnet.
        assertThat(line(scrape, "voltpilot_optimizer_cycle_age_seconds ")).endsWith(" 300.0");
    }

    @Test
    void withoutACycleTheOptimizerSeriesReadNaNNeverAFabricatedZero() {
        StubRepo repo = fleet();
        repo.cycle = null;
        String scrape = scrapeOf(repo);
        // Kein erfundenes 0 (das ein "0-Sekunden-Zyklus" behauptete): der Wert
        // ist NaN, solange kein Zyklus vorliegt - dieselbe Ein-Gauge-Konvention
        // wie voltpilot_metrics_collect_age_seconds. Eine Schwellwert-Regel
        // (> N) feuert auf NaN NICHT, ein noch nie gelaufener Optimierer
        // alarmiert also nicht faelschlich.
        assertThat(line(scrape, "voltpilot_optimizer_cycle_seconds ")).endsWith(" NaN");
        assertThat(line(scrape, "voltpilot_optimizer_cycle_age_seconds ")).endsWith(" NaN");
        assertThat(line(scrape, "voltpilot_optimizer_cycle_sites_planned ")).endsWith(" NaN");
        assertThat(scrape).doesNotContain("voltpilot_optimizer_cycle_seconds 0.0");
        // Die uebrigen Metriken sind davon unberuehrt.
        assertThat(scrape).contains("voltpilot_db_total_bytes{table=\"telemetry\"}");
    }

    @Test
    void theLabelsCarryInternalIdentifiersAndNothingElse() {
        String scrape = scrapeOf(fleet());
        List<String> lines = scrape.lines().filter(l -> l.startsWith("voltpilot_")).toList();
        assertThat(lines).isNotEmpty();
        for (String l : lines) {
            int open = l.indexOf('{');
            if (open < 0) {
                continue;
            }
            String labels = l.substring(open + 1, l.indexOf('}'));
            for (String pair : labels.split(",")) {
                assertThat(pair.substring(0, pair.indexOf('=')))
                        .as("Label in %s", l)
                        .isIn("table", "job_id", "proc");
            }
        }
    }

    @Test
    void theAgeKeepsGrowingWhenTheCollectorStops() {
        MutableClock clock = new MutableClock(NOW);
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        DbHealthMetricsCollector collector = new DbHealthMetricsCollector(fleet(), registry, clock);
        collector.collect();
        assertThat(line(registry.scrape(), "voltpilot_optimizer_cycle_age_seconds "))
                .endsWith(" 300.0");

        clock.advance(Duration.ofHours(1));
        // Der Optimierer-Zyklus altert weiter, obwohl nicht neu gesammelt wurde.
        assertThat(line(registry.scrape(), "voltpilot_optimizer_cycle_age_seconds "))
                .endsWith(" 3900.0");
        // ... und der Sammler-Wachhund sagt, dass ER stehengeblieben ist.
        assertThat(line(registry.scrape(), "voltpilot_db_metrics_collect_age_seconds "))
                .endsWith(" 3600.0");
    }

    @Test
    void aRepeatedCollectRefreshesTheValueInsteadOfKeepingTheFirstOne() {
        MutableClock clock = new MutableClock(NOW);
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        StubRepo repo = fleet();
        DbHealthMetricsCollector collector = new DbHealthMetricsCollector(repo, registry, clock);
        collector.collect();
        assertThat(line(registry.scrape(), "voltpilot_db_total_bytes{table=\"telemetry\"}"))
                .endsWith(" 1.2E7");

        repo.sizes.set(0, new HypertableSize("telemetry", 20_000_000L));
        collector.collect();
        assertThat(line(registry.scrape(), "voltpilot_db_total_bytes{table=\"telemetry\"}"))
                .endsWith(" 2.0E7");
    }

    @Test
    void aFailingTickNeverThrowsAndLeavesTheLastStandStanding() {
        MutableClock clock = new MutableClock(NOW);
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        StubRepo repo = fleet();
        DbHealthMetricsCollector collector = new DbHealthMetricsCollector(repo, registry, clock);
        collector.tick();
        assertThat(line(registry.scrape(), "voltpilot_db_total_bytes{table=\"telemetry\"}"))
                .endsWith(" 1.2E7");

        repo.explode = true;
        clock.advance(Duration.ofMinutes(1));
        collector.tick();
        collector.tick();

        String scrape = registry.scrape();
        assertThat(line(scrape, "voltpilot_db_total_bytes{table=\"telemetry\"}")).endsWith(" 1.2E7");
        assertThat(line(scrape, "voltpilot_db_metrics_collect_age_seconds ")).endsWith(" 60.0");
    }

    private static int indexOfNameEnd(String line) {
        int brace = line.indexOf('{');
        int space = line.indexOf(' ');
        if (brace < 0) {
            return space < 0 ? line.length() : space;
        }
        return space < 0 ? brace : Math.min(brace, space);
    }

    private static final class MutableClock extends Clock {
        private Instant now;

        MutableClock(Instant now) {
            this.now = now;
        }

        void advance(Duration by) {
            now = now.plus(by);
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }
}
