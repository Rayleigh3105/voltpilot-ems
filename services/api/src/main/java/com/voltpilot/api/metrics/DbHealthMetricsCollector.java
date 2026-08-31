package com.voltpilot.api.metrics;

import com.voltpilot.api.metrics.DbHealthMetrics.HypertableSize;
import com.voltpilot.api.metrics.DbHealthMetrics.JobStat;
import com.voltpilot.api.metrics.DbHealthMetrics.OptimizerCycle;
import com.voltpilot.api.repo.DbHealthMetricsRepository;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.MultiGauge;
import io.micrometer.core.instrument.Tags;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Haengt die Datenhaltungs-Gesundheit aus {@link DbHealthMetricsRepository} als
 * Prometheus-Messwerte auf: DB-Groesse je Hypertable, Fehlstatus der
 * Timescale-Hintergrund-Jobs und die Dauer des letzten Optimierer-Zyklus. Die
 * REGELN stehen in {@link DbHealthMetrics}; hier steht nur die Verdrahtung.
 * Aufbau und Disziplin folgen {@link FleetMetricsCollector} - siehe dort fuer
 * die drei tragenden Entscheidungen (getaktet statt je Scrape; Alter beim
 * Scrape gerechnet; {@code @Autowired} am Produktions-Konstruktor).
 *
 * <p><b>Eigener Schalter, eigener Takt.</b> Getrennt vom Flotten-Sammler
 * abschaltbar ({@code voltpilot.metrics.db.enabled}, Vorgabe AN) - dieselbe
 * Entscheidung wie zwischen Flotten- und Verbraucher-Sammler: je Job ein
 * Schalter. Beide Saetze exponieren in dieselbe Registry, also auf dasselbe
 * {@code /metrics}.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.metrics.db.enabled", havingValue = "true",
        matchIfMissing = true)
public class DbHealthMetricsCollector {

    private static final Logger log = LoggerFactory.getLogger(DbHealthMetricsCollector.class);

    /**
     * Groesse je Hypertable in Bytes. Der Ausloeser fuer die
     * Kaltarchiv-Entscheidung (E3-Schwelle 0,5 TB) ist die SUMME - {@code
     * sum(voltpilot_db_total_bytes)} in der Alarm-Regel, kein vorgerechnetes
     * Total (Prometheus-Konvention, verhindert Doppelzaehlung).
     */
    public static final String DB_TOTAL_BYTES = "voltpilot_db_total_bytes";

    /** 1 wenn der letzte Lauf eines Timescale-Jobs {@code Failed} war, sonst 0. */
    public static final String JOB_LAST_RUN_FAILED = "voltpilot_db_job_last_run_failed";

    /** Kumulierte Fehlschlaege eines Timescale-Jobs (steigt auch nach Erholung). */
    public static final String JOB_TOTAL_FAILURES = "voltpilot_db_job_total_failures";

    /** Wanduhr-Dauer des letzten Optimierer-Zyklus - die „kippen"-Kurve des Takts. */
    public static final String OPTIMIZER_CYCLE_SECONDS = "voltpilot_optimizer_cycle_seconds";

    /** Anlagen, die der letzte Zyklus geplant hat - Kontext fuer die Dauer. */
    public static final String OPTIMIZER_CYCLE_SITES_PLANNED =
            "voltpilot_optimizer_cycle_sites_planned";

    /** Anlagen, die der letzte Zyklus uebersprang. */
    public static final String OPTIMIZER_CYCLE_SITES_SKIPPED =
            "voltpilot_optimizer_cycle_sites_skipped";

    /**
     * Sekunden seit dem Ende des letzten Optimierer-Zyklus - beim SCRAPE
     * gerechnet, waechst also, wenn der Optimierer stirbt (die Dauer allein
     * froere auf einem gesunden Wert ein). {@code NaN}, solange noch kein Zyklus
     * geschrieben wurde - kein erfundenes Alter (wie {@code
     * voltpilot_metrics_collect_age_seconds}).
     */
    public static final String OPTIMIZER_CYCLE_AGE_SECONDS =
            "voltpilot_optimizer_cycle_age_seconds";

    /** Sekunden seit dem letzten ERFOLGREICHEN Sammel-Lauf DIESES Sammlers. */
    public static final String COLLECT_AGE = "voltpilot_db_metrics_collect_age_seconds";

    /** Dauer des letzten Sammel-Laufs (Kosten-Beleg). */
    public static final String COLLECT_DURATION = "voltpilot_db_metrics_collect_duration_seconds";

    private final DbHealthMetricsRepository repo;
    private final Clock clock;

    private final MultiGauge dbBytes;
    private final MultiGauge jobFailed;
    private final MultiGauge jobTotalFailures;

    /**
     * Starke Referenzen fuer die MultiGauge-Zeilen: {@link MultiGauge}
     * referenziert das Zeilen-Objekt schwach, ein nur lokal gebauter
     * Schnappschuss koennte also eingesammelt werden. Reine Zahlen brauchen das
     * nicht, {@link #cycle} als Objekt aber schon.
     */
    private volatile OptimizerCycle cycle;

    private final AtomicReference<Instant> lastCollect = new AtomicReference<>();
    private volatile double lastDurationSeconds = Double.NaN;
    private volatile boolean failing;

    @Autowired
    public DbHealthMetricsCollector(DbHealthMetricsRepository repo, MeterRegistry registry) {
        this(repo, registry, Clock.systemUTC());
    }

    /**
     * Test-Naht mit steuerbarer Uhr. <b>Der Produktions-Konstruktor oben MUSS
     * {@code @Autowired} tragen</b> - siehe {@link FleetMetricsCollector}.
     */
    DbHealthMetricsCollector(DbHealthMetricsRepository repo, MeterRegistry registry, Clock clock) {
        this.repo = repo;
        this.clock = clock;

        // OHNE Micrometer-baseUnit (wie FleetMetricsCollector): eine gesetzte
        // baseUnit haengte die Einheit als Suffix an den Namen und braeche den
        // Metrik-Vertrag - die Einheit steht schon IM Namen (_bytes/_seconds).
        this.dbBytes = MultiGauge.builder(DB_TOTAL_BYTES)
                .description("Groesse je Hypertable in Bytes; die DB-Summe ist"
                        + " sum(voltpilot_db_total_bytes) (E3-Schwelle 0,5 TB)")
                .register(registry);
        this.jobFailed = MultiGauge.builder(JOB_LAST_RUN_FAILED)
                .description("1 wenn der letzte Lauf eines Timescale-Jobs Failed war, sonst 0;"
                        + " fehlt, wenn der Job noch nie lief")
                .register(registry);
        this.jobTotalFailures = MultiGauge.builder(JOB_TOTAL_FAILURES)
                .description("Kumulierte Fehlschlaege eines Timescale-Jobs")
                .register(registry);

        Gauge.builder(OPTIMIZER_CYCLE_SECONDS, this,
                        c -> c.cycle == null ? Double.NaN : c.cycle.durationSeconds())
                .description("Dauer des letzten Optimierer-Zyklus ueber alle Anlagen;"
                        + " NaN bis zum ersten Zyklus")
                .register(registry);
        Gauge.builder(OPTIMIZER_CYCLE_SITES_PLANNED, this,
                        c -> c.cycle == null ? Double.NaN : c.cycle.sitesPlanned())
                .description("Anlagen, die der letzte Zyklus geplant hat")
                .register(registry);
        Gauge.builder(OPTIMIZER_CYCLE_SITES_SKIPPED, this,
                        c -> c.cycle == null ? Double.NaN : c.cycle.sitesSkipped())
                .description("Anlagen, die der letzte Zyklus uebersprang")
                .register(registry);
        Gauge.builder(OPTIMIZER_CYCLE_AGE_SECONDS, this::cycleAgeSeconds)
                .description("Sekunden seit dem Ende des letzten Optimierer-Zyklus;"
                        + " NaN bis zum ersten Zyklus")
                .register(registry);

        Gauge.builder(COLLECT_AGE, this::collectAgeSeconds)
                .description("Sekunden seit dem letzten ERFOLGREICHEN Sammel-Lauf")
                .register(registry);
        Gauge.builder(COLLECT_DURATION, () -> lastDurationSeconds)
                .description("Dauer des letzten Sammel-Laufs")
                .register(registry);
    }

    /**
     * Ein Sammel-Lauf. Wirft NIE (die {@link FleetMetricsCollector}-Regel): ein
     * fehlgeschlagener Lauf laesst den letzten Stand stehen, dass er alt ist
     * sagt {@code voltpilot_db_metrics_collect_age_seconds}.
     */
    @Scheduled(fixedDelayString = "${voltpilot.metrics.db.interval-ms:60000}",
            initialDelayString = "${voltpilot.metrics.db.initial-delay-ms:15000}")
    public void tick() {
        try {
            collect();
            if (failing) {
                failing = false;
                log.warn("db health metrics collection recovered");
            }
        } catch (Exception e) {
            if (!failing) {
                failing = true;
                log.warn("db health metrics collection failed: {}", e.getMessage());
            } else {
                log.debug("db health metrics collection still failing: {}", e.getMessage());
            }
        }
    }

    /** Sammelt und veroeffentlicht einen Stand. Paket-sichtbar fuer die Tests. */
    void collect() {
        long startedNanos = System.nanoTime();

        List<HypertableSize> sizes = repo.hypertableSizes();
        List<JobStat> jobs = repo.jobStats();
        OptimizerCycle latestCycle = repo.latestOptimizerCycle();

        List<MultiGauge.Row<?>> byteRows = new ArrayList<>(sizes.size());
        for (HypertableSize s : sizes) {
            byteRows.add(MultiGauge.Row.of(Tags.of("table", s.table()), s.bytes()));
        }
        dbBytes.register(byteRows, true);

        List<MultiGauge.Row<?>> failedRows = new ArrayList<>();
        List<MultiGauge.Row<?>> totalRows = new ArrayList<>();
        for (JobStat job : jobs) {
            if (!DbHealthMetrics.isReportableJob(job.proc())) {
                continue;
            }
            Tags tags = Tags.of("job_id", Long.toString(job.jobId()), "proc", job.proc());
            Double failed = DbHealthMetrics.lastRunFailedValue(job.lastRunStatus());
            // Kein erfundener Wert: ein noch nie gelaufener Job bekommt keine
            // last_run-Zeile (nur den kumulierten Zaehler, falls vorhanden).
            if (failed != null) {
                failedRows.add(MultiGauge.Row.of(tags, failed));
            }
            if (job.totalFailures() != null) {
                totalRows.add(MultiGauge.Row.of(tags, job.totalFailures()));
            }
        }
        jobFailed.register(failedRows, true);
        jobTotalFailures.register(totalRows, true);

        this.cycle = latestCycle;

        this.lastDurationSeconds = (System.nanoTime() - startedNanos) / 1_000_000_000.0;
        this.lastCollect.set(clock.instant());
        log.debug("db health metrics collected: {} hypertables, {} jobs, cycle={}, {} ms",
                sizes.size(), jobs.size(), latestCycle != null,
                Math.round(lastDurationSeconds * 1000));
    }

    private double cycleAgeSeconds() {
        OptimizerCycle current = this.cycle;
        if (current == null || current.finishedAt() == null) {
            return Double.NaN;
        }
        return FleetMetrics.ageSeconds(current.finishedAt(), clock.instant());
    }

    private double collectAgeSeconds() {
        Instant last = lastCollect.get();
        return last == null ? Double.NaN : FleetMetrics.ageSeconds(last, clock.instant());
    }

    /** Der zuletzt gesammelte Optimierer-Zyklus. Paket-sichtbar fuer die Tests. */
    OptimizerCycle cycleSnapshot() {
        return cycle;
    }
}
