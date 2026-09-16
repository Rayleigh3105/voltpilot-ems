package com.voltpilot.api.metrics;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Die REINEN Regeln hinter den Datenhaltungs-Metriken - welcher Timescale-Job
 * ueberhaupt gemeldet wird und wie ein Job-Status zur Zahl wird. Ohne Spring,
 * ohne Datenbank pruefbar (das {@link FleetMetrics}-Muster); {@link
 * DbHealthMetricsCollector} haengt sie nur an Micrometer.
 *
 * <p><b>Der Anlass (Scout vp-scale-readiness-p4 §6.3).</b> {@code /metrics}
 * meldete die Flotten-Fachlichkeit, aber KEINE der Groessen, an denen man die
 * Skalierungs-Befunde VOR den Kunden saehe: die DB-Groesse je Hypertable (der
 * Ausloeser fuer die Kaltarchiv-Entscheidung bei 0,5 TB) und den Fehlstatus der
 * Timescale-Hintergrund-Jobs. Ein still fehlschlagender {@code drop_chunks}
 * fiele sonst erst am Diskstand auf. Diese Klasse traegt die zwei
 * Ehrlichkeitsregeln, die dabei zaehlen.
 */
public final class DbHealthMetrics {

    /**
     * Plan-Obergrenze je Mandant aus AP-07 {@code k_speicher.py}, Szenario
     * „100 Messstellen, 1 300 Kanaele, alle Kanaele in der Zehn-Jahres-Klasse“.
     * E7-A ist unkomprimiert entschieden; deshalb stehen hier die
     * unkomprimierten Planwerte. Diese Tabelle ist die Laufzeitquelle fuer die
     * 70-Prozent-Warnung und wird in {@code docs/performance/speicherplanung.md}
     * lesbar gespiegelt.
     */
    public static final List<StorageClassPlan> STORAGE_PLAN = List.of(
            new StorageClassPlan("roh", "device_measurement_sample", 20_217_600_000L),
            new StorageClassPlan("vm", "messreihe_viertelstunde", 109_414_656_000L),
            new StorageClassPlan("tag", "messreihe_tag", 1_329_692_000L),
            new StorageClassPlan("ereignis", "messreihe_ereignis", 350_688_000L));

    /** Ab 70 % des Planwerts soll der Betrieb gewarnt werden. */
    public static final double STORAGE_WARNING_FRACTION = 0.70;

    /**
     * Der TimescaleDB-eigene Nutzungs-/Telemetrie-Reporter (Proc
     * {@code policy_telemetry}, „Telemetry Reporter"). Er ruft bei TimescaleDB
     * zu Hause an und schlaegt LEGITIM fehl, sobald die Datenbank keinen
     * ausgehenden Internet-Zugang hat - in Produktion der Normalfall. Seinen
     * Fehlstatus zu melden waere ein DAUERHAFTER Fehlalarm, und er ist keiner
     * unserer Datenpflege-Jobs. Jeder ANDERE Job (Retention, Kompression, der
     * Rollup-Refresh) wird gemeldet - auch ein Fehlschlag der internen
     * Housekeeping-Retention ist selten und dann echt.
     *
     * <p>Empirisch belegt: auf dem Prod-Image {@code
     * timescale/timescaledb:2.17.2-pg16} steht dieser Job ohne Netz auf
     * {@code Failed}, waehrend die echten Policy-Jobs {@code Success}/NULL sind.
     */
    public static final String USAGE_REPORTER_PROC = "policy_telemetry";

    private DbHealthMetrics() {
    }

    /** Die Groesse EINES Hypertables in Bytes (aus {@code hypertable_size}). */
    public record HypertableSize(String table, long bytes) {
    }

    /** Einer internen Mandantenkennung zurechenbarer physischer Tabellenanteil. */
    public record TenantTableSize(UUID tenantId, String storageClass, long bytes) {
    }

    /** Eine Zeile der reproduzierten Planungstabelle. */
    public record StorageClassPlan(String storageClass, String table, long bytes) {
    }

    public static long plannedBytes(String storageClass) {
        return STORAGE_PLAN.stream()
                .filter(p -> p.storageClass().equals(storageClass))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException(
                        "unknown storage class: " + storageClass))
                .bytes();
    }

    public static double planFraction(TenantTableSize size) {
        return (double) size.bytes() / plannedBytes(size.storageClass());
    }

    /** Einschliesslich der Grenze: genau 70 % ist bereits eine Warnung. */
    public static double planWarning(TenantTableSize size) {
        return planFraction(size) >= STORAGE_WARNING_FRACTION ? 1.0 : 0.0;
    }

    /**
     * Der Stand EINES Timescale-Hintergrund-Jobs.
     *
     * @param lastRunStatus roher {@code job_stats.last_run_status}
     *        ({@code "Success"}/{@code "Failed"}), oder {@code null}, wenn der
     *        Job noch nie lief
     * @param totalFailures kumulierte Fehlschlaege, oder {@code null}, wenn der
     *        Job noch nie lief
     */
    public record JobStat(long jobId, String proc, String lastRunStatus, Long totalFailures) {
    }

    /** Der zuletzt abgeschlossene Optimierer-Zyklus (aus {@code optimizer_cycle_stat}). */
    public record OptimizerCycle(
            Instant finishedAt,
            double durationSeconds,
            int sitesPlanned,
            int sitesSkipped,
            Integer horizonSlots) {
    }

    /**
     * Ob ein Job ueberhaupt in die Metrik gehoert - alles ausser dem
     * TimescaleDB-Nutzungs-Reporter (siehe {@link #USAGE_REPORTER_PROC}).
     */
    public static boolean isReportableJob(String proc) {
        return proc != null && !USAGE_REPORTER_PROC.equals(proc);
    }

    /**
     * Der Wert der Metrik {@code voltpilot_db_job_last_run_failed}: {@code 1.0}
     * bei {@code Failed}, {@code 0.0} bei {@code Success}, sonst {@code null}.
     *
     * <p><b>{@code null} heisst „noch nie gelaufen", nie „erfolgreich".</b> Ein
     * gerade erst hinzugefuegter Job hat kein {@code last_run_status}; daraus
     * eine {@code 0} zu machen behauptete eine Gesundheit, die niemand geprueft
     * hat (die {@link FleetMetrics}-Regel: was nicht gemessen ist, wird nicht
     * als Zahl exponiert). Der Sammler laesst die Zeitreihe dann ganz weg. Ein
     * fortlaufender Zaehler steht daneben in {@code voltpilot_db_job_total_failures}.
     */
    public static Double lastRunFailedValue(String lastRunStatus) {
        if ("Failed".equals(lastRunStatus)) {
            return 1.0;
        }
        if ("Success".equals(lastRunStatus)) {
            return 0.0;
        }
        return null;
    }
}
