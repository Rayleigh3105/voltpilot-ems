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
 */
@Repository
public class TelemetryWriteRepository {

    private final JdbcTemplate jdbc;

    public TelemetryWriteRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * @param event   the parsed event (identity + measurements)
     * @param rawJson the exact event JSON, stored verbatim in the payload column
     * @return {@code true} if a new row was inserted, {@code false} if it already
     *     existed (idempotent no-op)
     */
    @Transactional
    public boolean insert(TelemetryRawEvent event, String rawJson) {
        // Bind the RLS tenant for this transaction (transaction-local; reset on
        // commit/rollback, so it never leaks across the connection pool).
        // set_config is a function -> query for its result rather than update().
        jdbc.queryForObject(
                "SELECT set_config('app.tenant_id', ?, true)", String.class, event.tenant_id().toString());

        JsonNode m = event.measurements();
        int rows = jdbc.update(
                "INSERT INTO telemetry "
                        + "(time, tenant_id, site_id, device_id, power_kw, soc_pct, pv_power_kw, "
                        + " load_kw, grid_limit_kw, payload) "
                        + "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb "
                        + "WHERE NOT EXISTS ("
                        + "  SELECT 1 FROM telemetry WHERE device_id = ? AND time = ?)",
                Timestamp.from(event.observed_at()),
                event.tenant_id(),
                event.site_id(),
                event.device_id(),
                decimal(m, "power_kw"),
                decimal(m, "soc_pct"),
                decimal(m, "pv_power_kw"),
                decimal(m, "load_kw"),
                decimal(m, "grid_limit_kw"),
                rawJson,
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
