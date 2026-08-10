package com.voltpilot.api.metrics;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.consumers.ConsumerRequirementLedger.State;
import com.voltpilot.api.metrics.ConsumerMetrics.ConsumerRow;
import com.voltpilot.api.metrics.ConsumerMetrics.TaskRow;
import com.voltpilot.api.repo.ConsumerMetricsRepository;
import io.micrometer.prometheusmetrics.PrometheusConfig;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * The consumer §18 metric contract, read from the REAL scrape body (the
 * FleetMetricsScrapeTest discipline) - no Spring, no Docker. Proves the metric
 * NAMES appear verbatim, that NONE ends on {@code _total}, and the §18
 * aggregation honesty (a missed-after-deadline task counts as missed, a
 * disturbed consumer is counted, clamped-by-reason).
 */
class ConsumerMetricsScrapeTest {

    private static final Instant NOW = Instant.parse("2026-08-10T20:00:00Z");

    private static final class StubRepo extends ConsumerMetricsRepository {
        List<ConsumerRow> consumers = List.of();
        List<TaskRow> tasks = List.of();
        int overrides;

        StubRepo() {
            super(null);
        }

        @Override
        public List<ConsumerRow> consumers() {
            return consumers;
        }

        @Override
        public List<TaskRow> tasks() {
            return tasks;
        }

        @Override
        public int activeOverrides(Instant now) {
            return overrides;
        }
    }

    private static String scrapeOf(StubRepo repo) {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        ConsumerMetricsCollector collector =
                new ConsumerMetricsCollector(repo, registry, Clock.fixed(NOW, ZoneOffset.UTC));
        collector.collect();
        return registry.scrape();
    }

    private static String line(String scrape, String prefix) {
        return scrape.lines().filter(l -> l.startsWith(prefix)).findFirst().orElse(null);
    }

    private static StubRepo fleet() {
        StubRepo repo = new StubRepo();
        repo.consumers = List.of(
                // active + connected + healthy
                new ConsumerRow(true, true, true, "running_optimized", Boolean.TRUE, null),
                // connected but disturbed (readback disagreed)
                new ConsumerRow(true, true, true, "waiting", Boolean.FALSE, null),
                // connected + clamped by a grid guard
                new ConsumerRow(true, true, true, "clamped", Boolean.TRUE, "guard_grid_limit"),
                // a draft consumer, not connected, no active policy
                new ConsumerRow(false, false, false, null, null, null));
        repo.tasks = List.of(
                new TaskRow(NOW.plusSeconds(3600), State.RUNNING, 3600, 1800), // running
                new TaskRow(NOW.minusSeconds(60), State.PENDING, 3600, 600),   // missed (past deadline)
                new TaskRow(NOW.plusSeconds(7200), State.FULFILLED, 3600, 3600)); // fulfilled
        repo.overrides = 1;
        return repo;
    }

    @Test
    void theContractNamesAppearVerbatimInTheScrape() {
        String scrape = scrapeOf(fleet());
        assertThat(scrape)
                .contains("voltpilot_consumers ")
                .contains("voltpilot_consumers_active ")
                .contains("voltpilot_consumers_connected ")
                .contains("voltpilot_consumers_disturbed ")
                .contains("voltpilot_consumer_tasks{")
                .contains("voltpilot_consumer_tasks_at_risk ")
                .contains("voltpilot_consumer_clamped{")
                .contains("voltpilot_consumer_overrides_active ");
    }

    @Test
    void noConsumerMetricNameEndsOnTotal() {
        String scrape = scrapeOf(fleet());
        List<String> names = scrape.lines()
                .filter(l -> l.startsWith("voltpilot_consumer"))
                .map(l -> {
                    int brace = l.indexOf('{');
                    int space = l.indexOf(' ');
                    int end = brace < 0 ? (space < 0 ? l.length() : space)
                            : (space < 0 ? brace : Math.min(brace, space));
                    return l.substring(0, end);
                })
                .distinct().toList();
        assertThat(names).isNotEmpty()
                .allSatisfy(n -> assertThat(n).doesNotEndWith("_total"));
    }

    @Test
    void theAggregatesAreHonest() {
        String scrape = scrapeOf(fleet());
        assertThat(line(scrape, "voltpilot_consumers ")).endsWith(" 4.0");
        assertThat(line(scrape, "voltpilot_consumers_active ")).endsWith(" 3.0");
        assertThat(line(scrape, "voltpilot_consumers_connected ")).endsWith(" 3.0");
        // disturbed = the readback-mismatch one + the clamped one
        assertThat(line(scrape, "voltpilot_consumers_disturbed ")).endsWith(" 2.0");
        assertThat(line(scrape, "voltpilot_consumer_overrides_active ")).endsWith(" 1.0");
        assertThat(line(scrape, "voltpilot_consumer_clamped{reason=\"guard_grid_limit\"}"))
                .endsWith(" 1.0");
    }

    @Test
    void aTaskPastItsDeadlineIsCountedMissedNotPending() {
        String scrape = scrapeOf(fleet());
        // A row exists for every state (0 included), and the past-deadline pending
        // task reads MISSED via effectiveState - the alertable signal.
        assertThat(line(scrape, "voltpilot_consumer_tasks{state=\"missed\"}")).endsWith(" 1.0");
        assertThat(line(scrape, "voltpilot_consumer_tasks{state=\"pending\"}")).endsWith(" 0.0");
        assertThat(line(scrape, "voltpilot_consumer_tasks{state=\"running\"}")).endsWith(" 1.0");
        assertThat(line(scrape, "voltpilot_consumer_tasks{state=\"fulfilled\"}")).endsWith(" 1.0");
    }

    @Test
    void anEmptyFleetIsAllZerosNotAbsent() {
        String scrape = scrapeOf(new StubRepo());
        assertThat(line(scrape, "voltpilot_consumers ")).endsWith(" 0.0");
        for (String s : ConsumerMetrics.TASK_STATES) {
            assertThat(line(scrape, "voltpilot_consumer_tasks{state=\"" + s + "\"}"))
                    .endsWith(" 0.0");
        }
    }

    @Test
    void labelsCarryOnlyStateAndReason() {
        String scrape = scrapeOf(fleet());
        for (String l : scrape.lines().filter(x -> x.startsWith("voltpilot_consumer")).toList()) {
            int open = l.indexOf('{');
            if (open < 0) {
                continue;
            }
            String labels = l.substring(open + 1, l.indexOf('}'));
            for (String pair : labels.split(",")) {
                assertThat(pair.substring(0, pair.indexOf('=')))
                        .as("label in %s", l).isIn(Set.of("state", "reason"));
            }
        }
    }
}
