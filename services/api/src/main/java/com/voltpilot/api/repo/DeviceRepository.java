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

    /**
     * last_seen = newest telemetry ARRIVAL of this box (received_at, not the
     * observation time: a reconnecting edge replays buffered samples with old
     * observation timestamps, so arrival is the only correct liveness signal -
     * see migration V20260703000000). RLS-scoped like the device rows; null
     * until the first sample arrives.
     *
     * <p>BOTH pipes count: the v1 inverter telemetry AND the v2 entity
     * telemetry. A box without an inverter (e.g. only an I/O module that
     * switches consumers) never writes a v1 row - taking only v1 left such a
     * box „wartet auf die ersten Daten" forever while it was reading and
     * reporting just fine. The v2 lookup is bounded to 7 days so it stays on
     * the (site_id, time) index and a few recent chunks; a box silent for
     * longer than that and without v1 rows reads as not yet reported.
     */
    static String lastSeen(String alias) {
        return "GREATEST("
                + "(SELECT max(t.received_at) FROM telemetry t WHERE t.device_id = " + alias + ".id), "
                + "(SELECT max(v.received_at) FROM telemetry_v2 v WHERE v.site_id = " + alias
                + ".site_id AND v.device_id = " + alias + ".id AND v.time >= now() - interval '7 days'))";
    }

    public List<DeviceDto> findAll() {
        return jdbc.query(
                "SELECT d.id, d.site_id, d.external_ref, d.kind, d.name, d.status, d.created_at, "
                        + "d.lan_host, d.lan_seen_at, d.lan_source, "
                        + lastSeen("d") + " AS last_seen "
                        + "FROM device d ORDER BY d.created_at",
                DeviceRepository::mapDevice);
    }

    /** The current tenant's device, or empty when RLS hides it (=> 404). */
    public Optional<DeviceDto> findById(UUID deviceId) {
        return jdbc.query(
                "SELECT d.id, d.site_id, d.external_ref, d.kind, d.name, d.status, d.created_at, "
                        + "d.lan_host, d.lan_seen_at, d.lan_source, "
                        + lastSeen("d") + " AS last_seen "
                        + "FROM device d WHERE d.id = ?",
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
                        + "d.lan_host, d.lan_seen_at, d.lan_source, " + lastSeen("d") + " AS last_seen "
                        + "FROM device d "
                        + "WHERE d.external_ref = ?",
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
                "UPDATE device SET kind = ?, name = ? WHERE id = ? "
                        + "RETURNING id, site_id, external_ref, kind, name, status, created_at, "
                        + "lan_host, lan_seen_at, lan_source, "
                        + lastSeen("device") + " AS last_seen",
                DeviceRepository::mapDevice, kind, name, deviceId).stream().findFirst();
    }

    /** Shared transaction-scoped lock used by every topology writer. */
    public void lockTopology(UUID siteId) {
        jdbc.query("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", (rs, n) -> null,
                "site-topology:" + siteId);
    }

    /** Delete (unclaim) a device row. False when RLS hides it (=> 404). */
    public boolean delete(UUID deviceId) {
        return jdbc.update("DELETE FROM device WHERE id = ?", deviceId) > 0;
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

    /** Devices at a site (for the site-delete guard/preview), RLS-scoped. */
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

    public int countForSite(UUID siteId) {
        Integer count = jdbc.queryForObject(
                "SELECT count(*) FROM device WHERE site_id = ?", Integer.class, siteId);
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
