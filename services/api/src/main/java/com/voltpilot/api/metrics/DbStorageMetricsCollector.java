package com.voltpilot.api.metrics;

import com.voltpilot.api.metrics.DbHealthMetrics.TenantTableSize;
import com.voltpilot.api.repo.DbHealthMetricsRepository;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.MultiGauge;
import io.micrometer.core.instrument.Tags;
import java.util.ArrayList;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Der teure, mandantenweise Speicher-Waechter. Er sammelt getaktet und haelt
 * MultiGauge-Zeilen im Speicher; ein Prometheus-Scrape fuehrt niemals SQL aus.
 * Wegen der vier Vollscans ist die Vorgabe ein Tag, getrennt vom billigen
 * 60-Sekunden-Lauf in {@link DbHealthMetricsCollector}.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.metrics.db.enabled", havingValue = "true",
        matchIfMissing = true)
public class DbStorageMetricsCollector {

    private static final Logger log = LoggerFactory.getLogger(DbStorageMetricsCollector.class);

    public static final String TABLE_BYTES = "voltpilot_db_table_bytes";
    public static final String PLAN_FRACTION = "voltpilot_db_table_plan_fraction";
    public static final String PLAN_WARNING = "voltpilot_db_table_plan_warning";

    private final DbHealthMetricsRepository repo;
    private final MultiGauge bytes;
    private final MultiGauge planFraction;
    private final MultiGauge planWarning;
    private boolean failing;

    public DbStorageMetricsCollector(DbHealthMetricsRepository repo, MeterRegistry registry) {
        this.repo = repo;
        this.bytes = MultiGauge.builder(TABLE_BYTES)
                .description("Physischer Tabellenanteil je Speicherklasse und interner Mandantenkennung")
                .register(registry);
        this.planFraction = MultiGauge.builder(PLAN_FRACTION)
                .description("Anteil am Planwert fuer 100 Messstellen aus AP-07 k_speicher.py")
                .register(registry);
        this.planWarning = MultiGauge.builder(PLAN_WARNING)
                .description("1 ab einschliesslich 70 Prozent des Planwerts, sonst 0")
                .register(registry);
    }

    @Scheduled(fixedDelayString = "${voltpilot.metrics.db.storage-interval-ms:86400000}",
            initialDelayString = "${voltpilot.metrics.db.storage-initial-delay-ms:300000}")
    public void tick() {
        try {
            collect();
            if (failing) {
                failing = false;
                log.warn("db storage metrics collection recovered");
            }
        } catch (Exception e) {
            if (!failing) {
                failing = true;
                log.warn("db storage metrics collection failed: {}", e.getMessage());
            } else {
                log.debug("db storage metrics collection still failing: {}", e.getMessage());
            }
        }
    }

    /** Sammelt einen Stand; paket-sichtbar fuer die Scrape- und DB-Tests. */
    void collect() {
        List<TenantTableSize> sizes = repo.tenantTableSizes();
        List<MultiGauge.Row<?>> byteRows = new ArrayList<>(sizes.size());
        List<MultiGauge.Row<?>> fractionRows = new ArrayList<>(sizes.size());
        List<MultiGauge.Row<?>> warningRows = new ArrayList<>(sizes.size());
        for (TenantTableSize size : sizes) {
            Tags tags = Tags.of(
                    "class", size.storageClass(),
                    "tenant", size.tenantId().toString());
            byteRows.add(MultiGauge.Row.of(tags, size.bytes()));
            fractionRows.add(MultiGauge.Row.of(tags, DbHealthMetrics.planFraction(size)));
            warningRows.add(MultiGauge.Row.of(tags, DbHealthMetrics.planWarning(size)));
        }
        bytes.register(byteRows, true);
        planFraction.register(fractionRows, true);
        planWarning.register(warningRows, true);
        log.debug("db storage metrics collected: {} tenant/class rows", sizes.size());
    }
}
