package com.voltpilot.api.repo;

import com.voltpilot.api.metrics.DbHealthMetrics.HypertableSize;
import com.voltpilot.api.metrics.DbHealthMetrics.JobStat;
import com.voltpilot.api.metrics.DbHealthMetrics.OptimizerCycle;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.List;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Rohzahlen hinter den Datenhaltungs-Metriken ({@code
 * com.voltpilot.api.metrics}): je Hypertable die Groesse in Bytes, je
 * Timescale-Hintergrund-Job sein letzter Lauf, und die Dauer des letzten
 * Optimierer-Zyklus. <b>Nur Lesepfade.</b>
 *
 * <p><b>Warum die BYPASSRLS-Rolle, und warum das hier richtig ist.</b> Wie
 * {@link FleetMetricsRepository} haengt diese Sammlung an einem Zeitgeber, hat
 * also keinen {@code TenantContext}; und sie ist der Sache nach ein
 * Plattform-Betriebsblick auf die ganze Datenbank. Also {@code
 * @Qualifier("adminJdbcTemplate")} an der {@code voltpilot_admin}-Rolle, der
 * {@code @Primary}-Pfad der Kunden bleibt unberuehrt.
 *
 * <p><b>Sichtbarkeit, empirisch belegt (timescale/timescaledb:2.17.2-pg16).</b>
 * {@code timescaledb_information.hypertables} listet ALLE Hypertables, auch die,
 * auf deren Daten die (NOSUPERUSER-)Admin-Rolle kein {@code SELECT} hat, und
 * {@code hypertable_size} rechnet dennoch ihre Groesse - die DB-Summe wird also
 * nicht unterzaehlt (kein superuser-Datenpfad noetig). Ebenso zeigt {@code
 * timescaledb_information.jobs}/{@code job_stats} der Admin-Rolle auch die von
 * der Flyway-Superrolle angelegten Retention-/Kompressions-Jobs.
 */
@Repository
public class DbHealthMetricsRepository {

    private final JdbcTemplate admin;

    public DbHealthMetricsRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate admin) {
        this.admin = admin;
    }

    /**
     * Groesse je Hypertable in Bytes. {@code hypertable_size} summiert die
     * Chunk-Groessen (Katalog + {@code pg_relation_size} je Chunk) - billig, und
     * die 60-s-Taktung des Sammlers haelt es aus dem Scrape heraus. Die DB-Summe
     * fuer die 0,5-TB-Schwelle ist {@code sum(voltpilot_db_total_bytes)} in der
     * Alarm-Regel (Prometheus-Konvention: Label fuer die Aufschluesselung, das
     * Aggregat im PromQL - wie {@code voltpilot_priced_slots_ahead{zone}}).
     */
    public List<HypertableSize> hypertableSizes() {
        List<HypertableSize> sizes = new ArrayList<>();
        admin.query(
                "SELECT hypertable_name AS name, "
                        + "hypertable_size(format('%I.%I', hypertable_schema, hypertable_name)) "
                        + "  AS bytes "
                        + "FROM timescaledb_information.hypertables "
                        + "ORDER BY hypertable_name",
                rs -> {
                    sizes.add(new HypertableSize(rs.getString("name"), rs.getLong("bytes")));
                });
        return sizes;
    }

    /**
     * Jeder Timescale-Hintergrund-Job mit seinem letzten Lauf. Der
     * TimescaleDB-Nutzungs-Reporter wird NICHT hier gefiltert, sondern im
     * Sammler ({@code DbHealthMetrics.isReportableJob}) - so beweist der reine
     * Scrape-Test die Ausblendung Ende zu Ende.
     */
    public List<JobStat> jobStats() {
        List<JobStat> jobs = new ArrayList<>();
        admin.query(
                "SELECT j.job_id, j.proc_name AS proc, "
                        + "s.last_run_status, s.total_failures "
                        + "FROM timescaledb_information.jobs j "
                        + "LEFT JOIN timescaledb_information.job_stats s ON s.job_id = j.job_id "
                        + "ORDER BY j.job_id",
                rs -> {
                    Long totalFailures = rs.getObject("total_failures", Long.class);
                    jobs.add(new JobStat(
                            rs.getLong("job_id"),
                            rs.getString("proc"),
                            rs.getString("last_run_status"),
                            totalFailures));
                });
        return jobs;
    }

    /**
     * Der zuletzt abgeschlossene Optimierer-Zyklus, oder {@code null}, wenn der
     * Optimierer noch keinen geschrieben hat. Ein-Zeilen-Tabelle
     * ({@code optimizer_cycle_stat}, id=1); der Optimierer schreibt sie am Ende
     * jedes Zyklus (see {@code voltpilot_optimization.cycle_stats}).
     */
    public OptimizerCycle latestOptimizerCycle() {
        List<OptimizerCycle> rows = admin.query(
                "SELECT finished_at, duration_seconds, sites_planned, sites_skipped, "
                        + "horizon_slots FROM optimizer_cycle_stat WHERE id = 1",
                (rs, i) -> {
                    Timestamp finished = rs.getTimestamp("finished_at");
                    Integer horizon = rs.getObject("horizon_slots", Integer.class);
                    return new OptimizerCycle(
                            finished == null ? null : finished.toInstant(),
                            rs.getDouble("duration_seconds"),
                            rs.getInt("sites_planned"),
                            rs.getInt("sites_skipped"),
                            horizon);
                });
        return rows.isEmpty() ? null : rows.get(0);
    }
}
