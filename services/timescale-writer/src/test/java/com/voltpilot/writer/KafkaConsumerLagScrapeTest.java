package com.voltpilot.writer;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.writer.KafkaConsumerLag.PartitionOffsets;
import com.voltpilot.writer.KafkaConsumerLag.TopicLag;
import io.micrometer.prometheusmetrics.PrometheusConfig;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * <b>Die reinen Lag-Regeln UND der Vertrag aus dem echten Scrape-Rumpf.</b> Wie
 * die api-Sammler: die Alarm-Regeln kennen nur Zeichenketten, also zaehlt einzig,
 * was am Draht steht. Ohne Broker: {@link KafkaLagProbe} ist eine Attrappe.
 */
class KafkaConsumerLagScrapeTest {

    private static final String GROUP = "timescale-writer";
    private static final Instant NOW = Instant.parse("2026-08-31T13:00:00Z");

    // --- die reine Aggregation --------------------------------------------

    @Test
    void partitionLagIsEndMinusCommittedFlooredAtZero() {
        assertThat(KafkaConsumerLag.partitionLag(100, 175)).isEqualTo(75);
        assertThat(KafkaConsumerLag.partitionLag(175, 175)).isZero();
        // Committet knapp ueber dem gemeldeten Ende = Rennen der zwei Abfragen,
        // kein negativer Rueckstand.
        assertThat(KafkaConsumerLag.partitionLag(176, 175)).isZero();
    }

    @Test
    void perTopicSumsThePartitionsOfEachTopic() {
        List<TopicLag> lags = KafkaConsumerLag.perTopic(List.of(
                new PartitionOffsets("telemetry.raw", 0, 100, 175),
                new PartitionOffsets("telemetry.raw", 1, 200, 210),
                new PartitionOffsets("measurements.raw", 0, 5, 5)));
        assertThat(lags).containsExactlyInAnyOrder(
                new TopicLag("telemetry.raw", 85),   // 75 + 10
                new TopicLag("measurements.raw", 0)); // gemessene 0 ist ein Fakt
    }

    // --- der Scrape-Vertrag ------------------------------------------------

    private static final class StubProbe implements KafkaLagProbe {
        private List<PartitionOffsets> offsets = List.of();
        private boolean explode;

        @Override
        public List<PartitionOffsets> currentOffsets() throws Exception {
            if (explode) {
                throw new IllegalStateException("broker unreachable");
            }
            return offsets;
        }
    }

    private static StubProbe backlog() {
        StubProbe probe = new StubProbe();
        probe.offsets = List.of(
                new PartitionOffsets("telemetry.raw", 0, 100, 175),
                new PartitionOffsets("telemetry.raw", 1, 200, 210),
                new PartitionOffsets("measurements.raw", 0, 5, 5));
        return probe;
    }

    private static String scrapeOf(StubProbe probe, Clock clock) {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        KafkaLagMetricsCollector collector =
                new KafkaLagMetricsCollector(probe, registry, GROUP, clock);
        try {
            collector.collect();
        } catch (Exception e) {
            throw new AssertionError(e);
        }
        return registry.scrape();
    }

    private static String line(String scrape, String prefix) {
        return scrape.lines().filter(l -> l.startsWith(prefix)).findFirst().orElse(null);
    }

    @Test
    void theContractNameAppearsVerbatimWithGroupAndTopicLabels() {
        String scrape = scrapeOf(backlog(), Clock.fixed(NOW, ZoneOffset.UTC));
        assertThat(scrape).contains("voltpilot_kafka_consumer_lag{");
        assertThat(line(scrape, "voltpilot_kafka_consumer_lag{group=\"" + GROUP
                + "\",topic=\"telemetry.raw\"}")).endsWith(" 85.0");
        // Eine gemessene 0 (Writer aufgeholt) ist ein Fakt, keine Fabrikation.
        assertThat(line(scrape, "voltpilot_kafka_consumer_lag{group=\"" + GROUP
                + "\",topic=\"measurements.raw\"}")).endsWith(" 0.0");
    }

    @Test
    void noSuffixIsAppendedAndNoPrecomputedTotalDoubleCounts() {
        String scrape = scrapeOf(backlog(), Clock.fixed(NOW, ZoneOffset.UTC));
        Set<String> vereinbart = Set.of(
                KafkaLagMetricsCollector.CONSUMER_LAG,
                KafkaLagMetricsCollector.COLLECT_AGE);
        List<String> gefunden = scrape.lines()
                .filter(l -> l.startsWith("voltpilot_"))
                .map(l -> l.substring(0, indexOfNameEnd(l)))
                .distinct()
                .toList();
        assertThat(gefunden).isNotEmpty().allSatisfy(name ->
                assertThat(vereinbart).as("unerwarteter Metrikname: %s", name).contains(name));
        assertThat(gefunden).containsAll(vereinbart);
        // Kein vorgerechnetes Total, das sum() doppelt zaehlen wuerde.
        assertThat(scrape).doesNotContain("topic=\"__all__\"").doesNotContain("topic=\"all\"");
    }

    @Test
    void aGroupThatNeverConsumedHasNoLagSeries() {
        StubProbe empty = new StubProbe(); // leere Offset-Liste
        String scrape = scrapeOf(empty, Clock.fixed(NOW, ZoneOffset.UTC));
        // Nie konsumiert = kein Rueckstand zu melden - keine erfundene 0.
        assertThat(scrape).doesNotContain("voltpilot_kafka_consumer_lag{");
        // Der Poll war trotzdem erfolgreich: das Sammler-Alter ist 0.
        assertThat(line(scrape, "voltpilot_kafka_consumer_lag_collect_age_seconds "))
                .endsWith(" 0.0");
    }

    @Test
    void theLabelsCarryOnlyGroupAndTopic() {
        String scrape = scrapeOf(backlog(), Clock.fixed(NOW, ZoneOffset.UTC));
        for (String l : scrape.lines().filter(l -> l.startsWith("voltpilot_")).toList()) {
            int open = l.indexOf('{');
            if (open < 0) {
                continue;
            }
            String labels = l.substring(open + 1, l.indexOf('}'));
            for (String pair : labels.split(",")) {
                assertThat(pair.substring(0, pair.indexOf('=')))
                        .as("Label in %s", l).isIn("group", "topic");
            }
        }
    }

    @Test
    void theCollectAgeGrowsWhenTheProbeStops() {
        MutableClock clock = new MutableClock(NOW);
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        StubProbe probe = backlog();
        KafkaLagMetricsCollector collector =
                new KafkaLagMetricsCollector(probe, registry, GROUP, clock);
        collector.tick();
        assertThat(line(registry.scrape(), "voltpilot_kafka_consumer_lag_collect_age_seconds "))
                .endsWith(" 0.0");

        // Broker faellt aus: der letzte Lag-Stand bleibt stehen, der Wachhund waechst.
        probe.explode = true;
        clock.advance(Duration.ofMinutes(2));
        collector.tick();
        collector.tick();

        String scrape = registry.scrape();
        assertThat(line(scrape, "voltpilot_kafka_consumer_lag{group=\"" + GROUP
                + "\",topic=\"telemetry.raw\"}")).endsWith(" 85.0");
        assertThat(line(scrape, "voltpilot_kafka_consumer_lag_collect_age_seconds "))
                .endsWith(" 120.0");
    }

    @Test
    void aRepeatedCollectRefreshesTheValue() {
        MutableClock clock = new MutableClock(NOW);
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        StubProbe probe = backlog();
        KafkaLagMetricsCollector collector =
                new KafkaLagMetricsCollector(probe, registry, GROUP, clock);
        collector.tick();
        assertThat(line(registry.scrape(), "voltpilot_kafka_consumer_lag{group=\"" + GROUP
                + "\",topic=\"telemetry.raw\"}")).endsWith(" 85.0");

        // Der Writer holt auf: Lag faellt auf 0.
        probe.offsets = List.of(new PartitionOffsets("telemetry.raw", 0, 175, 175));
        collector.tick();
        assertThat(line(registry.scrape(), "voltpilot_kafka_consumer_lag{group=\"" + GROUP
                + "\",topic=\"telemetry.raw\"}")).endsWith(" 0.0");
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
