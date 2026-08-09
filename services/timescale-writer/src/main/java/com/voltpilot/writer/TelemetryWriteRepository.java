package com.voltpilot.writer;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.sql.Timestamp;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * Writes a {@code telemetry.raw} event into the TimescaleDB {@code telemetry}
 * hypertable.
 *
 * <p><b>Tenant scoping (RLS).</b> The writer connects as the non-privileged
 * {@code voltpilot_app} role - the same role the portal API reads with - for
 * which Row-Level-Security (api migration V2) is enforced. Each insert runs in a
 * transaction that first sets {@code app.tenant_id} to the event's tenant, so
 * the RLS {@code WITH CHECK} both permits the write AND guarantees the row's
 * {@code tenant_id} equals the session tenant. A mismatched tenant_id can never
 * be written, and the row lands exactly where the tenant's portal read finds it.
 *
 * <p><b>Idempotency (at-least-once safe).</b> Kafka may redeliver; the insert is
 * a guarded {@code INSERT ... WHERE NOT EXISTS} on {@code (device_id, time)}, so
 * re-processing the same sample is a no-op. Per-site ordering (single partition
 * per {@code tenant:site}) means redeliveries are sequential, not concurrent.
 * Since api migration V20260712000000 a UNIQUE index on {@code (device_id,
 * time)} backs the guard: a concurrent duplicate (zombie consumer during a
 * rebalance) that slips past both guards fails the constraint instead of
 * double-inserting; the exception makes Kafka redeliver, and the redelivery
 * no-ops on the guard.
 */
@Repository
public class TelemetryWriteRepository {

    private final JdbcTemplate jdbc;

    public TelemetryWriteRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Inserts one telemetry sample.
     *
     * <p><b>No {@code payload} (Datenhaltung Phase 2 / E2).</b> New rows no longer
     * carry the raw {@code telemetry.raw} JSON: it was ~636 B/row (~57% of the
     * telemetry size, ~77% even compressed) and no read path in api/optimizer/
     * forecast ever selected it - it merely duplicated the structured columns.
     * The {@code payload} column stays in the schema (old rows keep their JSONB;
     * dropping it is a later, separate step), it is just left NULL from now on.
     *
     * @param event the parsed event (identity + measurements)
     * @return {@code true} if a new row was inserted, {@code false} if it already
     *     existed (idempotent no-op)
     */
    @Transactional
    public boolean insert(TelemetryRawEvent event) {
        // Bind the RLS tenant for this transaction (transaction-local; reset on
        // commit/rollback, so it never leaks across the connection pool).
        // set_config is a function -> query for its result rather than update().
        jdbc.queryForObject(
                "SELECT set_config('app.tenant_id', ?, true)", String.class, event.tenant_id().toString());

        JsonNode m = event.measurements();
        // received_at = when the cloud actually RECEIVED this sample, taken from
        // the event's ingested_at (stamped by ingest at MQTT receipt). It is the
        // liveness signal (device online/offline) and MUST NOT be the observation
        // time: a reconnecting edge replays buffered samples with old observation
        // timestamps but arrives now. Falls back to observed_at if a producer
        // omitted ingested_at.
        Timestamp receivedAt = Timestamp.from(
                event.ingested_at() != null ? event.ingested_at() : event.observed_at());
        // Purge watermark guard (api migration V20260706000000): after a device
        // data purge ("Datenaufzeichnungen löschen"), any sample whose
        // OBSERVATION time is at or before device.data_purged_before is
        // refused - a store-and-forward edge replaying its old buffer after the
        // purge must never resurrect deleted history. New samples (observed
        // after the purge) insert normally. The device row is same-tenant, so
        // the RLS-scoped SELECT sees it; a telemetry row without a device row
        // (dev seeds, integrations) stays insertable.
        //
        // FOR SHARE first (audit B6b): lock the device row in share mode for
        // the length of this transaction, so a concurrent purge's watermark
        // UPDATE blocks until this insert commits (and its DELETE then sees
        // the row), while an in-flight watermark UPDATE makes this SELECT
        // wait and re-read the committed watermark. Without it, an insert
        // whose snapshot predates the watermark commit passes the NOT EXISTS
        // guard while the purge's DELETE cannot see the still-uncommitted
        // row - an old-observation row would survive the purge. The guard in
        // the INSERT below stays: it re-checks under the now-current snapshot
        // and covers device-less rows the lock cannot.
        jdbc.queryForList(
                "SELECT data_purged_before FROM device WHERE id = ? FOR SHARE",
                event.device_id());
        int rows = jdbc.update(
                "INSERT INTO telemetry "
                        + "(time, received_at, tenant_id, site_id, device_id, power_kw, soc_pct, pv_power_kw, "
                        + " load_kw, grid_limit_kw) "
                        + "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? "
                        + "WHERE NOT EXISTS ("
                        + "  SELECT 1 FROM telemetry WHERE device_id = ? AND time = ?) "
                        + "AND NOT EXISTS ("
                        + "  SELECT 1 FROM device WHERE id = ? AND data_purged_before >= ?)",
                Timestamp.from(event.observed_at()),
                receivedAt,
                event.tenant_id(),
                event.site_id(),
                event.device_id(),
                decimal(m, "power_kw"),
                decimal(m, "soc_pct"),
                decimal(m, "pv_power_kw"),
                decimal(m, "load_kw"),
                decimal(m, "grid_limit_kw"),
                event.device_id(),
                Timestamp.from(event.observed_at()),
                event.device_id(),
                Timestamp.from(event.observed_at()));
        return rows > 0;
    }

    private static BigDecimal decimal(JsonNode measurements, String field) {
        if (measurements == null) {
            return null;
        }
        JsonNode v = measurements.get(field);
        if (v == null || v.isNull() || !v.isNumber()) {
            return null;
        }
        return v.decimalValue();
    }
}
