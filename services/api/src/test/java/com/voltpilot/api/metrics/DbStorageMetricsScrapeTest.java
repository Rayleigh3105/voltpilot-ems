package com.voltpilot.api.metrics;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.metrics.DbHealthMetrics.TenantTableSize;
import com.voltpilot.api.repo.DbHealthMetricsRepository;
import io.micrometer.prometheusmetrics.PrometheusConfig;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class DbStorageMetricsScrapeTest {

    private static final UUID TENANT = UUID.fromString("71000000-0000-0000-0000-000000000016");

    private static final class StubRepo extends DbHealthMetricsRepository {
        private final List<TenantTableSize> sizes;

        StubRepo(List<TenantTableSize> sizes) {
            super(null);
            this.sizes = sizes;
        }

        @Override
        public List<TenantTableSize> tenantTableSizes() {
            return sizes;
        }
    }

    private static String scrape(List<TenantTableSize> sizes) {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        new DbStorageMetricsCollector(new StubRepo(sizes), registry).collect();
        return registry.scrape();
    }

    @Test
    void metricIsVisiblePerClassAndInternalTenantIdOnly() {
        String scrape = scrape(DbHealthMetrics.STORAGE_PLAN.stream()
                .map(p -> new TenantTableSize(TENANT, p.storageClass(), 1234L))
                .toList());

        for (var plan : DbHealthMetrics.STORAGE_PLAN) {
            assertThat(scrape).contains("voltpilot_db_table_bytes{class=\""
                    + plan.storageClass() + "\",tenant=\"" + TENANT + "\"} 1234.0");
        }
        assertThat(scrape).doesNotContain("name=").doesNotContain("kunde=");
    }

    @Test
    void warningStartsAtExactlySeventyPercentOfThePlan() {
        long plan = DbHealthMetrics.plannedBytes("vm");
        long threshold = plan * 7 / 10;
        String below = scrape(List.of(new TenantTableSize(TENANT, "vm", threshold - 1)));
        String at = scrape(List.of(new TenantTableSize(TENANT, "vm", threshold)));

        assertThat(below).contains("voltpilot_db_table_plan_warning{class=\"vm\",tenant=\""
                + TENANT + "\"} 0.0");
        assertThat(at).contains("voltpilot_db_table_plan_warning{class=\"vm\",tenant=\""
                + TENANT + "\"} 1.0");
        assertThat(at).contains("voltpilot_db_table_plan_fraction{class=\"vm\",tenant=\""
                + TENANT + "\"} 0.7");
    }
}
