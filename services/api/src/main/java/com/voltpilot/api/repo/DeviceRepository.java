package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.DeviceDto;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** Devices for the current tenant (RLS-scoped, see migration V2). */
@Repository
public class DeviceRepository {

    private final JdbcTemplate jdbc;

    public DeviceRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public List<DeviceDto> findAll() {
        // Only boxes that take part in operation: an ausgebaut box (UEMS AP-07
        // IP-11) keeps its row and its recordings, but is no device of the
        // tenant anymore - no list, no scope, no route reaches it.
        // last_seen = newest status-heartbeat ARRIVAL. Until an existing box has
        // sent its first heartbeat after AP-06 IP-15, telemetry arrival remains
        // the compatibility fallback, preserving the former one-box result.
        return jdbc.query(
                "SELECT d.id, d.site_id, d.external_ref, d.kind, d.name, d.status, d.created_at, "
                        + "d.lan_host, d.lan_seen_at, d.lan_source, "
                        + "coalesce(d.device_status_seen_at, (SELECT max(t.received_at) FROM telemetry t "
                        + "WHERE t.device_id = d.id)) AS last_seen "
                        + "FROM device d WHERE d.ausgebaut_am IS NULL ORDER BY d.created_at",
                DeviceRepository::mapDevice);
    }

    /** The current tenant's active device, or empty when RLS hides it or it is ausgebaut (=> 404). */
    public Optional<DeviceDto> findById(UUID deviceId) {
        return jdbc.query(
                "SELECT d.id, d.site_id, d.external_ref, d.kind, d.name, d.status, d.created_at, "
                        + "d.lan_host, d.lan_seen_at, d.lan_source, "
                        + "coalesce(d.device_status_seen_at, (SELECT max(t.received_at) FROM telemetry t "
                        + "WHERE t.device_id = d.id)) AS last_seen "
                        + "FROM device d WHERE d.id = ? AND d.ausgebaut_am IS NULL",
                DeviceRepository::mapDevice, deviceId).stream().findFirst();
    }

    /**
     * The current tenant's device with this external ref, if it has one. RLS
     * hides other tenants' devices, so a hit always means "already claimed by
     * the caller's own account".
     */
    public Optional<DeviceDto> findByExternalRef(String externalRef) {
        return jdbc.query(
                "SELECT d.id, d.site_id, d.external_ref, d.kind, d.name, d.status, d.created_at, "
                        + "d.lan_host, d.lan_seen_at, d.lan_source, "
                        + "coalesce(d.device_status_seen_at, t.last_seen) AS last_seen "
                        + "FROM device d "
                        + "LEFT JOIN LATERAL (SELECT received_at AS last_seen FROM telemetry "
                        + "  WHERE device_id = d.id ORDER BY received_at DESC LIMIT 1) t ON true "
                        + "WHERE d.external_ref = ? AND d.ausgebaut_am IS NULL",
                DeviceRepository::mapDevice,
                externalRef).stream().findFirst();
    }

    /**
     * Claim a device into a site for the current tenant - a single insert. RLS'
     * WITH CHECK enforces {@code tenant_id = app.tenant_id}; the global unique
     * index on {@code external_ref} makes claiming another tenant's device fail
     * with a duplicate-key error (surfaced as HTTP 409).
     */
    public DeviceDto claim(UUID tenantId, UUID siteId, String externalRef, String kind) {
        lockTopology(siteId);
        jdbc.query("SELECT id FROM site WHERE id = ? FOR UPDATE", (rs, n) -> rs.getObject(1), siteId);
        return jdbc.queryForObject(
                "INSERT INTO device (tenant_id, site_id, external_ref, kind, status) "
                        + "VALUES (?, ?, ?, ?, 'claimed') "
                        + "RETURNING id, site_id, external_ref, kind, name, status, created_at, "
                        + "lan_host, lan_seen_at, lan_source, "
                        + "NULL::timestamptz AS last_seen",
                DeviceRepository::mapDevice,
                tenantId, siteId, externalRef, kind == null || kind.isBlank() ? "inverter" : kind);
    }

    /**
     * Update the editable device fields (kind + label). The external_ref is the
     * device's identity and deliberately NOT updatable. Returns the updated
     * device, or empty when RLS hides it (=> 404).
     */
    public Optional<DeviceDto> update(UUID deviceId, String kind, String name) {
        return jdbc.query(
                "UPDATE device SET kind = ?, name = ? WHERE id = ? AND ausgebaut_am IS NULL "
                        + "RETURNING id, site_id, external_ref, kind, name, status, created_at, "
                        + "lan_host, lan_seen_at, lan_source, "
                        + "coalesce(device.device_status_seen_at, (SELECT max(t.received_at) FROM telemetry t "
                        + "WHERE t.device_id = device.id)) AS last_seen",
                DeviceRepository::mapDevice, kind, name, deviceId).stream().findFirst();
    }

    /** Shared transaction-scoped lock used by every topology writer. */
    public void lockTopology(UUID siteId) {
        jdbc.query("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", (rs, n) -> null,
                "site-topology:" + siteId);
    }

    /**
     * Unclaim = the box is ausgebaut (UEMS AP-07 E8, AP-06 E7): the row stays with its
     * identity, so every recording keeps naming the box that read it; the sticker ref is
     * claimable again (the unique index only covers boxes that are not ausgebaut). Final -
     * a trigger refuses to undo it. False when RLS hides the box or it is ausgebaut already
     * (=> 404).
     */
    public boolean ausbauen(UUID deviceId) {
        return jdbc.update("UPDATE device SET status = 'ausgebaut', ausgebaut_am = now() "
                + "WHERE id = ? AND ausgebaut_am IS NULL", deviceId) > 0;
    }

    /**
     * What the foreign keys {@code ON DELETE SET NULL} did when unclaim still deleted the row:
     * components, assets, the entity registry state and the site's stored lead box no longer
     * point at an ausgebaut box, so no push, command or gateway choice reaches it. Same
     * transaction as {@link #ausbauen}, RLS-scoped.
     */
    public void ausDerTopologieLoesen(UUID deviceId) {
        jdbc.update("UPDATE measurement_point SET device_id = NULL WHERE device_id = ?", deviceId);
        jdbc.update("UPDATE asset SET device_id = NULL WHERE device_id = ?", deviceId);
        jdbc.update("UPDATE entity_registry_state SET device_id = NULL WHERE device_id = ?", deviceId);
        jdbc.update("UPDATE site SET lead_device_id = NULL WHERE lead_device_id = ?", deviceId);
    }

    /**
     * Stamp the purge watermark (migration V20260706000000): the timescale-writer
     * refuses telemetry whose OBSERVATION time is at or before this instant, so
     * replayed old samples can never resurrect purged history. Deliberately its
     * own auto-committed statement, run BEFORE the series delete transaction:
     * once committed, nothing older than the watermark can be written anymore,
     * and the delete then sweeps whatever raced in. DevicePurgeService holds a
     * database-wide per-device session lock across both commits; OCPP ingest
     * takes the same key before re-reading this value. False when RLS hides the
     * device (=> 404).
     */
    public boolean setDataPurgedBefore(UUID deviceId, java.time.Instant purgedBefore) {
        return jdbc.update("UPDATE device SET data_purged_before = ? WHERE id = ?",
                java.sql.Timestamp.from(purgedBefore), deviceId) > 0;
    }

    /**
     * The committed purge watermark for replay guards. This deliberately stays
     * a separate lookup instead of becoming part of the public DeviceDto: it
     * is an ingestion safety boundary, not customer-facing device state.
     */
    public Optional<java.time.Instant> dataPurgedBefore(UUID deviceId) {
        return jdbc.query("SELECT data_purged_before FROM device "
                        + "WHERE id = ? AND data_purged_before IS NOT NULL",
                (rs, n) -> rs.getTimestamp(1).toInstant(), deviceId).stream().findFirst();
    }

    /**
     * Records the box's OWN reachability (Anlagen-Zentrale Stufe 2, D5) - the
     * one fact the box reports about ITSELF. Replaced on every heartbeat that
     * carries it; a heartbeat WITHOUT the block never reaches this method, so
     * a stored address survives a silent stretch instead of vanishing.
     *
     * <p>RLS-scoped like every other write here - the listener sets the topic's
     * tenant first, so a fabricated identity updates zero rows.
     */
    public boolean setLanAddress(UUID deviceId, String host, java.time.Instant seenAt,
            String source) {
        return jdbc.update(
                "UPDATE device SET lan_host = ?, lan_seen_at = ?, lan_source = ? WHERE id = ?",
                host, seenAt == null ? null : java.sql.Timestamp.from(seenAt), source,
                deviceId) > 0;
    }

    /**
     * Records the cloud ARRIVAL of a valid status heartbeat. The listener has
     * already checked topic/payload identity and selected the tenant in
     * {@link com.voltpilot.api.tenant.TenantContext}; RLS therefore keeps a
     * forged or cross-tenant id from refreshing another box.
     */
    public boolean markStatusSeen(UUID deviceId) {
        return jdbc.update("UPDATE device SET device_status_seen_at = now() "
                + "WHERE id = ? AND ausgebaut_am IS NULL", deviceId) > 0;
    }

    /** Active devices at a site (for the site-delete guard/preview), RLS-scoped; an ausgebaut box does not count. */
    public int countForSite(UUID siteId) {
        Integer count = jdbc.queryForObject(
                "SELECT count(*) FROM device WHERE site_id = ? AND ausgebaut_am IS NULL", Integer.class, siteId);
        return count == null ? 0 : count;
    }

    private static DeviceDto mapDevice(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        java.sql.Timestamp lastSeen = rs.getTimestamp("last_seen");
        java.sql.Timestamp createdAt = rs.getTimestamp("created_at");
        java.sql.Timestamp lanSeen = rs.getTimestamp("lan_seen_at");
        return new DeviceDto(
                rs.getObject("id", UUID.class),
                rs.getObject("site_id", UUID.class),
                rs.getString("external_ref"),
                rs.getString("kind"),
                rs.getString("name"),
                rs.getString("status"),
                lastSeen == null ? null : lastSeen.toInstant(),
                createdAt == null ? null : createdAt.toInstant(),
                rs.getString("lan_host"),
                lanSeen == null ? null : lanSeen.toInstant(),
                rs.getString("lan_source"));
    }
}
