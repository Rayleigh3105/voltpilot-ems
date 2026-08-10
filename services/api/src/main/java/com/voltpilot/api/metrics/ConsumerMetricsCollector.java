package com.voltpilot.api.metrics;

import com.voltpilot.api.metrics.ConsumerMetrics.Snapshot;
import com.voltpilot.api.repo.ConsumerMetricsRepository;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.MultiGauge;
import io.micrometer.core.instrument.Tags;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Exposes the consumer-control §18 metrics as Prometheus gauges (Inkrement 5),
 * following {@link FleetMetricsCollector} rule for rule: collected on a TIMER
 * (never per scrape), the age of the last successful collect is a watchdog over
 * the watchdog, and a failing tick never throws (the alert base must never
 * vanish silently). The RULES live in {@link ConsumerMetrics}; here is only the
 * wiring.
 *
 * <p><b>The metric names are the contract.</b> They are registered verbatim,
 * without a Micrometer {@code baseUnit}, and end NEVER on {@code _total} (the
 * Prometheus-client gauge trap). {@code ConsumerMetricsScrapeTest} reads them
 * back from the REAL scrape body, so a rename breaks there.
 *
 * <p>Labels carry INTERNAL identifiers only (state/reason) - the endpoint
 * answers anonymously, so no customer name/address/measurement is exposed.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.metrics.consumer.enabled", havingValue = "true",
        matchIfMissing = true)
public class ConsumerMetricsCollector {

    private static final Logger log = LoggerFactory.getLogger(ConsumerMetricsCollector.class);

    /** Total controllable consumers - the denominator for quotas. */
    public static final String CONSUMERS = "voltpilot_consumers";
    /** Enabled consumers with an active policy. */
    public static final String ACTIVE = "voltpilot_consumers_active";
    /** Consumers bound to an edge device/source. */
    public static final String CONNECTED = "voltpilot_consumers_connected";
    /** Consumers whose live state is disturbed (offline / clamped / missed / readback-mismatch). */
    public static final String DISTURBED = "voltpilot_consumers_disturbed";
    /** Recurring-requirement instances per EFFECTIVE state. */
    public static final String TASKS = "voltpilot_consumer_tasks";
    /** Task instances whose deadline is at risk ("Frist gefährdet", §17). */
    public static final String TASKS_AT_RISK = "voltpilot_consumer_tasks_at_risk";
    /** Consumers currently clamped by a guard, per reason (§18 "geklemmte Befehle nach Grund"). */
    public static final String CLAMPED = "voltpilot_consumer_clamped";
    /** Active manual overrides. */
    public static final String OVERRIDES = "voltpilot_consumer_overrides_active";
    /** Seconds since the last SUCCESSFUL collect - the watchdog over the watchdog. */
    public static final String COLLECT_AGE = "voltpilot_consumer_metrics_collect_age_seconds";

    private final ConsumerMetricsRepository repo;
    private final Clock clock;

    private final MultiGauge tasks;
    private final MultiGauge clamped;

    /** Strong references so MultiGauge's weak row objects survive (FleetMetrics note). */
    private volatile Snapshot snapshot =
            new ConsumerMetrics.Snapshot(0, 0, 0, 0, Map.of(), 0, Map.of(), 0);
    private final AtomicReference<Instant> lastCollect = new AtomicReference<>();
    private volatile boolean failing;

    @Autowired
    public ConsumerMetricsCollector(ConsumerMetricsRepository repo, MeterRegistry registry) {
        this(repo, registry, Clock.systemUTC());
    }

    /** Test seam with a controllable clock; production ctor MUST stay {@code @Autowired}. */
    ConsumerMetricsCollector(ConsumerMetricsRepository repo, MeterRegistry registry, Clock clock) {
        this.repo = repo;
        this.clock = clock;

        this.tasks = MultiGauge.builder(TASKS)
                .description("Wiederkehrende Anforderungs-Instanzen je Zustand"
                        + " (pending|running|fulfilled|missed|blocked)")
                .register(registry);
        this.clamped = MultiGauge.builder(CLAMPED)
                .description("Durch einen Guard geklemmte Verbraucher je Grund")
                .register(registry);

        Gauge.builder(CONSUMERS, () -> snapshot.total())
                .description("Steuerbare Verbraucher der Plattform").register(registry);
        Gauge.builder(ACTIVE, () -> snapshot.active())
                .description("Verbraucher mit aktiver Policy (freigeschaltet)").register(registry);
        Gauge.builder(CONNECTED, () -> snapshot.connected())
                .description("Verbundene Verbraucher").register(registry);
        Gauge.builder(DISTURBED, () -> snapshot.disturbed())
                .description("Gestoerte Verbraucher (offline/geklemmt/verpasst/Readback-Abweichung)")
                .register(registry);
        Gauge.builder(TASKS_AT_RISK, () -> snapshot.tasksAtRisk())
                .description("Anforderungen mit gefaehrdeter Frist").register(registry);
        Gauge.builder(OVERRIDES, () -> snapshot.overridesActive())
                .description("Aktive manuelle Eingriffe").register(registry);
        Gauge.builder(COLLECT_AGE, this::collectAgeSeconds)
                .description("Sekunden seit dem letzten ERFOLGREICHEN Sammel-Lauf")
                .register(registry);
    }

    @Scheduled(fixedDelayString = "${voltpilot.metrics.consumer.interval-ms:60000}",
            initialDelayString = "${voltpilot.metrics.consumer.initial-delay-ms:15000}")
    public void tick() {
        try {
            collect();
            if (failing) {
                failing = false;
                log.warn("consumer metrics collection recovered");
            }
        } catch (Exception e) {
            if (!failing) {
                failing = true;
                log.warn("consumer metrics collection failed: {}", e.getMessage());
            } else {
                log.debug("consumer metrics collection still failing: {}", e.getMessage());
            }
        }
    }

    /** Collect + publish a stand. Package-visible for the test. */
    void collect() {
        Instant now = clock.instant();
        Snapshot snap = ConsumerMetrics.compute(repo.consumers(), repo.tasks(),
                repo.activeOverrides(now), now);
        this.snapshot = snap;
        publish(snap);
        this.lastCollect.set(now);
    }

    private void publish(Snapshot snap) {
        // Every task state gets a row (0 included) so a rule can watch "missed > 0".
        List<MultiGauge.Row<?>> taskRows = new ArrayList<>();
        for (String state : ConsumerMetrics.TASK_STATES) {
            taskRows.add(MultiGauge.Row.of(Tags.of("state", state),
                    snap.tasksByState().getOrDefault(state, 0)));
        }
        tasks.register(taskRows, true);

        List<MultiGauge.Row<?>> clampRows = new ArrayList<>();
        for (Map.Entry<String, Integer> e : snap.clampedByReason().entrySet()) {
            clampRows.add(MultiGauge.Row.of(Tags.of("reason", e.getKey()), e.getValue()));
        }
        clamped.register(clampRows, true);
    }

    private double collectAgeSeconds() {
        Instant last = lastCollect.get();
        return last == null ? Double.NaN
                : Math.max(0, clock.instant().getEpochSecond() - last.getEpochSecond());
    }

    /** The last published snapshot. Package-visible for the test. */
    Snapshot snapshot() {
        return snapshot;
    }
}
