package com.voltpilot.api.metrics;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.DbHealthMetricsRepository;
import io.micrometer.prometheusmetrics.PrometheusConfig;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Clock;
import java.time.Duration;
import java.util.Map;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Datenhaltungs-Metriken gegen eine ECHTE TimescaleDB - das SQL, das {@link
 * DbHealthMetricsScrapeTest} bewusst wegattrappt. Bewiesen wird der ganze Weg
 * bis in den Scrape-Rumpf:
 *
 * <ul>
 *   <li>{@code hypertable_size} liefert je Hypertable eine {@code
 *       voltpilot_db_total_bytes}-Zeile - AUCH fuer Tabellen, auf deren Daten
 *       die (NOSUPERUSER-)Admin-Rolle kein {@code SELECT} hat (sonst zaehlte die
 *       0,5-TB-Summe zu wenig);</li>
 *   <li>die von der Flyway-Superrolle angelegten Retention-/Kompressions-Jobs
 *       sind der Admin-Rolle sichtbar, und ein gelaufener Job meldet seinen
 *       Fehlstatus;</li>
 *   <li>der TimescaleDB-Nutzungs-Reporter ({@code policy_telemetry}), der ohne
 *       Internet auf {@code Failed} steht, wird NICHT gemeldet - sonst ein
 *       Dauerfehlalarm;</li>
 *   <li>der Optimierer-Zyklus aus {@code optimizer_cycle_stat} wird gelesen.</li>
 * </ul>
 *
 * <p>Laeuft ohne Spring-Kontext: Flyway migriert, danach werden Repository und
 * Sammler direkt gebaut. Auto-Skip ohne Docker.
 */
@Testcontainers(disabledWithoutDocker = true)
class DbHealthMetricsDbTest {

    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "pw_admin";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static DataSource superuser() {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(POSTGRES.getUsername());
        ds.setPassword(POSTGRES.getPassword());
        return ds;
    }

    /** Die BYPASSRLS-Rolle, an der der Sammler haengt - genau wie in Produktion. */
    private static DataSource adminRole() {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(ADMIN_USER);
        ds.setPassword(ADMIN_PW);
        return ds;
    }

    @BeforeAll
    static void migrateAndSeed() throws Exception {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of(
                        "appDbUser", "voltpilot_app", "appDbPassword", "pw_app",
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW))
                .load()
                .migrate();

        try (Connection c = superuser().getConnection(); Statement s = c.createStatement()) {
            // Ein paar echte Zeilen, damit hypertable_size nicht 0 ist.
            s.execute("INSERT INTO forecast "
                    + "(time, tenant_id, site_id, kind, model, value_kw, run_at, horizon_min,"
                    + " method) SELECT now() - (g || ' hours')::interval, "
                    + "  '00000000-0000-0000-0000-0000000000a0', "
                    + "  '00000000-0000-0000-0000-0000000000f0', 'pv', 'pv-physical', 1.0, "
                    + "  now(), g * 60, 'test' FROM generate_series(1, 200) g");

            // Der zuletzt abgeschlossene Optimierer-Zyklus (das, was der Optimierer
            // am Ende jedes Laufs schreibt).
            s.execute("INSERT INTO optimizer_cycle_stat "
                    + "(id, finished_at, duration_seconds, sites_planned, sites_skipped, "
                    + " horizon_slots) VALUES (1, now(), 41.5, 57, 3, 192)");

            // Einen Retention-/Kompressions-Job wirklich laufen lassen, damit er
            // einen Status hat (Success, da nichts Altes zu loeschen ist).
            try (ResultSet rs = s.executeQuery(
                    "SELECT job_id FROM timescaledb_information.jobs "
                            + "WHERE proc_name IN ('policy_retention', 'policy_compression') "
                            + "ORDER BY job_id LIMIT 1")) {
                if (rs.next()) {
                    long jobId = rs.getLong(1);
                    try (Statement run = c.createStatement()) {
                        run.execute("CALL run_job(" + jobId + ")");
                    }
                }
            }
            s.execute("ANALYZE");
        }
    }

    private static String scrape() {
        DbHealthMetricsRepository repo =
                new DbHealthMetricsRepository(new JdbcTemplate(adminRole()));
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        DbHealthMetricsCollector collector =
                new DbHealthMetricsCollector(repo, registry, Clock.systemUTC());
        collector.collect();
        return registry.scrape();
    }

    private static String line(String scrape, String prefix) {
        return scrape.lines().filter(l -> l.startsWith(prefix)).findFirst().orElse(null);
    }

    @Test
    void everyHypertableGetsASizeSeriesEvenWithoutDataSelect() {
        String scrape = scrape();
        // Die grossen Wachstumstreiber sind je einzeln sichtbar; die DB-Summe
        // ist sum(voltpilot_db_total_bytes) (E3-Schwelle 0,5 TB).
        assertThat(scrape).contains("voltpilot_db_total_bytes{table=\"telemetry\"}");
        assertThat(scrape).contains("voltpilot_db_total_bytes{table=\"schedule\"}");
        assertThat(scrape).contains("voltpilot_db_total_bytes{table=\"forecast\"}");
        // forecast hat echte Zeilen - also eine Groesse > 0.
        String forecast = line(scrape, "voltpilot_db_total_bytes{table=\"forecast\"}");
        double bytes = Double.parseDouble(forecast.substring(forecast.lastIndexOf(' ') + 1));
        assertThat(bytes).isGreaterThan(0.0);
    }

    @Test
    void aRunJobReportsItsFailStatusAndTheUsageReporterIsExcluded() {
        String scrape = scrape();
        // Der gelaufene Retention-/Kompressions-Job hat einen Status (Success ->
        // 0) und einen Fehlschlag-Zaehler.
        assertThat(scrape).contains("voltpilot_db_job_last_run_failed{");
        assertThat(scrape).contains("voltpilot_db_job_total_failures{");
        assertThat(scrape).contains("proc=\"policy_retention\"")
                .containsAnyOf("proc=\"policy_compression\"", "proc=\"policy_retention\"");

        // DER Fehlalarm-Fall gegen einen ECHT fehlschlagenden Job: der
        // TimescaleDB-Nutzungs-Reporter steht ohne Internet auf Failed, darf aber
        // nie erscheinen.
        assertThat(scrape).doesNotContain("proc=\"policy_telemetry\"");
    }

    @Test
    void theOptimizerCycleIsReadFromItsTable() {
        String scrape = scrape();
        assertThat(line(scrape, "voltpilot_optimizer_cycle_seconds ")).endsWith(" 41.5");
        assertThat(line(scrape, "voltpilot_optimizer_cycle_sites_planned ")).endsWith(" 57.0");
        assertThat(line(scrape, "voltpilot_optimizer_cycle_sites_skipped ")).endsWith(" 3.0");
        // Der Zyklus endete "jetzt", also ist das beim Scrape gerechnete Alter klein.
        String age = line(scrape, "voltpilot_optimizer_cycle_age_seconds ");
        double ageS = Double.parseDouble(age.substring(age.lastIndexOf(' ') + 1));
        assertThat(ageS).isGreaterThanOrEqualTo(0.0).isLessThan(120.0);
    }

    @Test
    void aCollectRunCostsLittleEnoughToRunEveryMinute() {
        DbHealthMetricsRepository repo =
                new DbHealthMetricsRepository(new JdbcTemplate(adminRole()));
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        DbHealthMetricsCollector collector =
                new DbHealthMetricsCollector(repo, registry, Clock.systemUTC());
        collector.collect(); // aufwaermen
        long start = System.nanoTime();
        collector.collect();
        Duration cost = Duration.ofNanos(System.nanoTime() - start);
        // Die Zahl steht im PR: getaktet (60 s), nie pro Scrape - trotzdem billig.
        System.out.println("DbHealthMetricsCollector.collect() = " + cost.toMillis() + " ms");
        assertThat(cost).isLessThan(Duration.ofSeconds(5));
    }
}
