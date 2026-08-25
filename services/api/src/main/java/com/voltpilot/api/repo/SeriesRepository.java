package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.SiteDeletionPreviewDto;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * Series-data cleanup for entity deletion. The timeseries hypertables carry no
 * foreign keys (hypertables), so deleting a site or device must remove its
 * series rows explicitly - through the SAME RLS-scoped app datasource as every
 * customer query, so the deletes are transparently limited to the caller's
 * tenant. {@code forecast} is the one table without RLS (backend-only
 * consumers); its delete is safe because the controller has already resolved
 * the site through the RLS-scoped {@link SiteRepository}, proving ownership.
 */
@Repository
public class SeriesRepository {

    /**
     * Every tenant-scoped OCPP table introduced by Slice 10. Keep this list in
     * lockstep with V20260840000000: these tables intentionally have explicit
     * delete paths in addition to the additive composite-FK backstop.
     */
    private static final String[] OCPP_TABLES = {
            "ocpp_station", "ocpp_connector_state", "ocpp_protocol_event",
            "ocpp_connector_status_event", "ocpp_authorization_event", "ocpp_transaction",
            "ocpp_meter_sample", "ocpp_station_status_event", "ocpp_configuration_key",
            "ocpp_configuration_unknown_key", "ocpp_station_capability"
    };

    private final JdbcTemplate jdbc;

    public SeriesRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** What deleting this site would remove (for the portal's confirm dialog). */
    public SiteDeletionPreviewDto previewForSite(UUID siteId, int deviceCount) {
        return jdbc.queryForObject(
                "SELECT (SELECT count(*) FROM telemetry WHERE site_id = ?) AS telemetry_count, "
                        + "(SELECT min(time) FROM telemetry WHERE site_id = ?) AS telemetry_from, "
                        + "(SELECT max(time) FROM telemetry WHERE site_id = ?) AS telemetry_to, "
                        + "(SELECT count(*) FROM forecast WHERE site_id = ?) AS forecast_count, "
                        + "(SELECT count(*) FROM schedule WHERE site_id = ?) AS schedule_count, "
                        + "(SELECT count(*) FROM weather_forecast WHERE site_id = ?) AS weather_count",
                (rs, i) -> {
                    Timestamp from = rs.getTimestamp("telemetry_from");
                    Timestamp to = rs.getTimestamp("telemetry_to");
                    return new SiteDeletionPreviewDto(
                            deviceCount,
                            rs.getLong("telemetry_count"),
                            from == null ? null : from.toInstant(),
                            to == null ? null : to.toInstant(),
                            rs.getLong("forecast_count"),
                            rs.getLong("schedule_count"),
                            rs.getLong("weather_count"));
                },
                siteId, siteId, siteId, siteId, siteId, siteId);
    }

    /** Remove every series row of a site (telemetry, rollups, feeds, quality). */
    public void deleteForSite(UUID siteId) {
        deleteOcpp("site_id", siteId);
        for (String table : new String[] {
                "telemetry", "telemetry_rollup_15m", "telemetry_rollup_1h", "telemetry_rollup_1d",
                "weather_forecast", "schedule", "forecast",
                "forecast_model_state", "forecast_accuracy", "plan_accuracy"}) {
            jdbc.update("DELETE FROM " + table + " WHERE site_id = ?", siteId);
        }
    }

    /**
     * Purge ALL recorded data of one device ("Datenaufzeichnungen löschen"):
     * delete its raw telemetry and recompute the site's rollup hypertables from
     * the remaining raw rows, all in ONE transaction so a crash can never leave
     * the rollups showing data whose raw rows are already gone. Rollups
     * aggregate per SITE across its devices (migration V20260701030000), so a
     * site-scoped rebuild is the only way one device's contribution truly
     * disappears. Runs through the RLS-scoped app datasource: the deletes are
     * transparently limited to the caller's tenant, and the rollup re-inserts
     * pass the same WITH CHECK. Unclaim reuses this so a removed device's data
     * never lingers in the Historie week/month/year buckets either.
     *
     * <p>The delete is bounded by the purge watermark (audit B6a): a
     * legitimately NEW sample - observed after the watermark - that arrives
     * between the watermark commit and this delete must survive, because the
     * edge already got its QoS1 ack and will never replay it. Unclaim passes
     * {@code null} (no bound): the device row itself goes, so ALL its rows go.
     *
     * @param purgedBefore the purge watermark (delete only rows observed at or
     *     before it), or {@code null} to delete everything (unclaim)
     * @return the number of raw telemetry rows removed
     */
    @Transactional
    public long purgeDeviceRecordings(UUID deviceId, UUID siteId, Instant purgedBefore) {
        // OCPP snapshots and raw events are recordings too. They are not
        // bounded by telemetry's watermark because their own occurred_at can
        // be a station clock; erase the complete device history atomically.
        deleteOcpp("device_id", deviceId);
        long purged = purgedBefore == null
                ? jdbc.update("DELETE FROM telemetry WHERE device_id = ?", deviceId)
                : jdbc.update("DELETE FROM telemetry WHERE device_id = ? AND time <= ?",
                        deviceId, Timestamp.from(purgedBefore));
        recomputeRollupsForSite(siteId);
        return purged;
    }

    private void deleteOcpp(String column, UUID id) {
        for (String table : OCPP_TABLES) {
            jdbc.update("DELETE FROM " + table + " WHERE " + column + " = ?", id);
        }
    }

    /**
     * Rebuild a site's rollups from its raw telemetry - delete, then re-insert
     * with the SAME aggregate expressions as {@code refresh_telemetry_rollups}
     * (migration V20260701030000), just site-scoped. Buckets whose raw rows are
     * all gone simply do not reappear (an upsert could never empty them, which
     * is why this is a full site rebuild and not a refresh call).
     */
    private void recomputeRollupsForSite(UUID siteId) {
        for (String table : new String[] {
                "telemetry_rollup_15m", "telemetry_rollup_1h", "telemetry_rollup_1d"}) {
            jdbc.update("DELETE FROM " + table + " WHERE site_id = ?", siteId);
        }
        // NULL-safe aggregates (audit B2), in sync with refresh_telemetry_rollups
        // (V20260712000000): average only over samples where the source channels
        // exist - GREATEST would otherwise coerce a NULL channel to 0.
        jdbc.update(
                "INSERT INTO telemetry_rollup_15m "
                        + "SELECT time_bucket('15 minutes', time) AS bucket, tenant_id, site_id, "
                        + "  avg(pv_power_kw) * 0.25, avg(load_kw) * 0.25, "
                        + "  avg(CASE WHEN power_kw IS NOT NULL THEN greatest(power_kw, 0) END) * 0.25, "
                        + "  avg(CASE WHEN power_kw IS NOT NULL THEN greatest(-power_kw, 0) END) * 0.25, "
                        + "  avg(CASE WHEN power_kw IS NOT NULL AND load_kw IS NOT NULL AND pv_power_kw IS NOT NULL "
                        + "       THEN greatest(power_kw - load_kw + pv_power_kw, 0) END) * 0.25, "
                        + "  avg(CASE WHEN power_kw IS NOT NULL AND load_kw IS NOT NULL AND pv_power_kw IS NOT NULL "
                        + "       THEN greatest(-(power_kw - load_kw + pv_power_kw), 0) END) * 0.25, "
                        + "  min(soc_pct), max(soc_pct), last(soc_pct, time), count(*) "
                        + "FROM telemetry WHERE site_id = ? GROUP BY 1, 2, 3",
                siteId);
        jdbc.update(
                "INSERT INTO telemetry_rollup_1h "
                        + "SELECT time_bucket('1 hour', bucket), tenant_id, site_id, "
                        + "  sum(pv_kwh), sum(load_kwh), sum(grid_import_kwh), sum(grid_export_kwh), "
                        + "  sum(battery_charge_kwh), sum(battery_discharge_kwh), "
                        + "  min(soc_min_pct), max(soc_max_pct), last(soc_last_pct, bucket), sum(n_samples) "
                        + "FROM telemetry_rollup_15m WHERE site_id = ? GROUP BY 1, 2, 3",
                siteId);
        jdbc.update(
                "INSERT INTO telemetry_rollup_1d "
                        + "SELECT time_bucket('1 day', bucket, 'Europe/Berlin'), tenant_id, site_id, "
                        + "  sum(pv_kwh), sum(load_kwh), sum(grid_import_kwh), sum(grid_export_kwh), "
                        + "  sum(battery_charge_kwh), sum(battery_discharge_kwh), "
                        + "  min(soc_min_pct), max(soc_max_pct), last(soc_last_pct, bucket), sum(n_samples) "
                        + "FROM telemetry_rollup_1h WHERE site_id = ? GROUP BY 1, 2, 3",
                siteId);
    }
}
