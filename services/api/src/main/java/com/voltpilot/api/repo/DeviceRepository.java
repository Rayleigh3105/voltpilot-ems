package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.DeviceDto;
import com.voltpilot.api.web.dto.DeviceMovePreviewDto;
import com.voltpilot.api.web.dto.MoveProvisioningStatusDto;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** Devices for the current tenant (RLS-scoped, see migration V2). */
@Repository
public class DeviceRepository {

    public record MoveState(UUID deviceId, UUID tenantId, UUID siteId, int revision,
            String externalRef) {}

    private final JdbcTemplate jdbc;

    public DeviceRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public List<DeviceDto> findAll() {
        // last_seen = newest telemetry ARRIVAL per device (received_at, not the
        // observation time: a reconnecting edge replays buffered samples with old
        // observation timestamps, so arrival is the only correct liveness signal -
        // see migration V20260703000000). RLS-scoped like the device rows; null
        // until the first sample arrives.
        return jdbc.query(
                "SELECT d.id, d.site_id, d.external_ref, d.kind, d.name, d.status, d.created_at, "
                        + "d.lan_host, d.lan_seen_at, d.lan_source, "
                        + "(SELECT max(t.received_at) FROM telemetry t WHERE t.device_id = d.id) AS last_seen "
                        + "FROM device d ORDER BY d.created_at",
                DeviceRepository::mapDevice);
    }

    /** The current tenant's device, or empty when RLS hides it (=> 404). */
    public Optional<DeviceDto> findById(UUID deviceId) {
        return jdbc.query(
                "SELECT d.id, d.site_id, d.external_ref, d.kind, d.name, d.status, d.created_at, "
                        + "d.lan_host, d.lan_seen_at, d.lan_source, "
                        + "(SELECT max(t.received_at) FROM telemetry t WHERE t.device_id = d.id) AS last_seen "
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
                        + "d.lan_host, d.lan_seen_at, d.lan_source, t.last_seen "
                        + "FROM device d "
                        + "LEFT JOIN LATERAL (SELECT received_at AS last_seen FROM telemetry "
                        + "  WHERE device_id = d.id ORDER BY received_at DESC LIMIT 1) t ON true "
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
                        + "(SELECT max(t.received_at) FROM telemetry t WHERE t.device_id = device.id) AS last_seen",
                DeviceRepository::mapDevice, kind, name, deviceId).stream().findFirst();
    }

    /** Topologie-Vorprüfung des getrennten Standortwechsels. */
    public DeviceMovePreviewDto movePreview(UUID deviceId) {
        MoveState state = moveState(deviceId).orElse(null);
        if (state == null) return null;
        List<DeviceMovePreviewDto.TargetSiteDto> targets = jdbc.query(
                "SELECT s.id, s.name, s.component_authority, "
                        + "(SELECT count(*) FROM device d WHERE d.site_id = s.id) AS devices, "
                        + "(SELECT count(*) FROM measurement_point m WHERE m.site_id = s.id "
                        + " AND m.entity_type IS NOT NULL) AS entities, "
                        + "(SELECT count(*) FROM asset a WHERE a.site_id = s.id) AS assets "
                        + "FROM site s WHERE s.id <> ? ORDER BY s.name",
                (rs, n) -> {
                    boolean portal = "portal".equals(rs.getString("component_authority"));
                    int devices = rs.getInt("devices");
                    int entities = rs.getInt("entities");
                    int assets = rs.getInt("assets");
                    String reason = !portal
                            ? "Die Geräte dieses Standorts werden direkt an der Box verwaltet."
                            : devices > 0 || entities > 0 || assets > 0
                                ? "Der Zielstandort hat bereits eine eigene Gerätetopologie."
                                : null;
                    return new DeviceMovePreviewDto.TargetSiteDto(
                            rs.getObject("id", UUID.class), rs.getString("name"),
                            reason == null, reason);
                }, state.siteId());
        return new DeviceMovePreviewDto(deviceId, state.siteId(), state.revision(), targets);
    }

    public Optional<MoveState> moveState(UUID deviceId) {
        return jdbc.query(
                "SELECT id, tenant_id, site_id, revision, external_ref FROM device WHERE id = ? FOR UPDATE",
                (rs, n) -> new MoveState(rs.getObject("id", UUID.class),
                        rs.getObject("tenant_id", UUID.class), rs.getObject("site_id", UUID.class),
                        rs.getInt("revision"), rs.getString("external_ref")), deviceId)
                .stream().findFirst();
    }

    /**
     * Verschiebt dieselbe Geräte- und Entitätsidentität atomisch. Historische
     * Telemetrie, Befehle und Auditzeilen werden NICHT umgeschrieben; nur das
     * aktuelle Stammdaten-Soll und seine append-only Zuordnung wechseln.
     */
    public boolean move(MoveState state, UUID targetSiteId, java.time.Instant effectiveAt,
            String actor) {
        lockTopologyPair(state.siteId(), targetSiteId);
        if (!targetTopologyStillEmpty(targetSiteId)) return false;
        jdbc.update("UPDATE component_definition d SET site_id = ? FROM measurement_point m "
                        + "WHERE d.entity_id = m.id AND m.device_id = ? AND m.site_id = ?",
                targetSiteId, state.deviceId(), state.siteId());
        jdbc.update("UPDATE entity_role_assignment a SET site_id = ? FROM measurement_point m "
                        + "WHERE a.entity_id = m.id AND m.device_id = ? AND m.site_id = ?",
                targetSiteId, state.deviceId(), state.siteId());
        jdbc.update("UPDATE consumer_policy p SET site_id = ? FROM measurement_point m "
                        + "WHERE p.entity_id = m.id AND m.device_id = ? AND m.site_id = ?",
                targetSiteId, state.deviceId(), state.siteId());
        // consumer_profile folgt über ON UPDATE CASCADE.
        jdbc.update("UPDATE measurement_point SET site_id = ? WHERE device_id = ? AND site_id = ?",
                targetSiteId, state.deviceId(), state.siteId());
        jdbc.update("UPDATE entity_observed_state SET site_id = ? WHERE device_id = ?",
                targetSiteId, state.deviceId());
        // Current execution/health snapshots follow the device; historical
        // journals and telemetry retain their original site attribution.
        for (String table : new String[] {"device_control_status", "device_curtailment_status",
                "device_source_status", "device_edge_version", "device_update_status",
                "consumer_runtime_status", "device_charging_budget", "device_charge_point",
                "device_charge_connector", "ocpp_station", "ocpp_connector_state",
                "ocpp_configuration_key", "ocpp_configuration_unknown_key", "ocpp_station_capability"}) {
            jdbc.update("UPDATE " + table + " SET site_id = ? WHERE device_id = ? AND site_id = ?",
                    targetSiteId, state.deviceId(), state.siteId());
        }
        jdbc.update("UPDATE ocpp_transaction SET site_id = ? WHERE device_id = ? AND site_id = ? AND stopped_at IS NULL",
                targetSiteId, state.deviceId(), state.siteId());
        jdbc.update("DELETE FROM entity_registry_state WHERE site_id IN (?, ?)",
                state.siteId(), targetSiteId);
        jdbc.update("DELETE FROM device_component_apply WHERE device_id = ?", state.deviceId());
        // Physische Assets, die ausdrücklich an DIESEM Gerät hängen, reisen
        // unter derselben Asset-/Geräte-ID mit. Standortweite, nicht verknüpfte
        // Aggregate bleiben beim bisherigen Standort.
        jdbc.update("UPDATE asset SET site_id = ? WHERE device_id = ? AND site_id = ?",
                targetSiteId, state.deviceId(), state.siteId());
        int changed = jdbc.update(
                "UPDATE device SET site_id = ?, revision = revision + 1 "
                        + "WHERE id = ? AND site_id = ? AND revision = ?",
                targetSiteId, state.deviceId(), state.siteId(), state.revision());
        if (changed == 0) return false;
        jdbc.update(
                "INSERT INTO device_site_assignment (tenant_id, device_id, revision, "
                        + "from_site_id, to_site_id, effective_at, created_by) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?)",
                state.tenantId(), state.deviceId(), state.revision() + 1, state.siteId(),
                targetSiteId, java.sql.Timestamp.from(effectiveAt), actor);
        return true;
    }

    public Optional<MoveProvisioningStatusDto> moveProvisioningStatus(UUID deviceId) {
        return jdbc.query("SELECT device_id, revision, status, attempts, last_error, updated_at, applied_at "
                        + "FROM move_provisioning_operation WHERE device_id = ? ORDER BY revision DESC LIMIT 1",
                (rs, n) -> {
                    java.time.OffsetDateTime applied = rs.getObject("applied_at", java.time.OffsetDateTime.class);
                    return new MoveProvisioningStatusDto(rs.getObject("device_id", UUID.class),
                            rs.getInt("revision"), rs.getString("status"), rs.getInt("attempts"),
                            rs.getString("last_error"), rs.getObject("updated_at", java.time.OffsetDateTime.class).toInstant(),
                            applied == null ? null : applied.toInstant());
                }, deviceId)
                .stream().findFirst();
    }

    private boolean targetTopologyStillEmpty(UUID targetSiteId) {
        Integer devices = jdbc.queryForObject("SELECT count(*) FROM device WHERE site_id = ?", Integer.class, targetSiteId);
        Integer entities = jdbc.queryForObject("SELECT count(*) FROM measurement_point WHERE site_id = ? AND entity_type IS NOT NULL",
                Integer.class, targetSiteId);
        Integer assets = jdbc.queryForObject("SELECT count(*) FROM asset WHERE site_id = ?", Integer.class, targetSiteId);
        String authority = jdbc.queryForObject("SELECT component_authority FROM site WHERE id = ?", String.class, targetSiteId);
        return "portal".equals(authority) && devices != null && devices == 0
                && entities != null && entities == 0 && assets != null && assets == 0;
    }

    /** Shared transaction-scoped lock used by every topology writer. */
    public void lockTopology(UUID siteId) {
        jdbc.query("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", (rs, n) -> null,
                "site-topology:" + siteId);
    }

    private void lockTopologyPair(UUID a, UUID b) {
        UUID first = a.toString().compareTo(b.toString()) <= 0 ? a : b;
        UUID second = first.equals(a) ? b : a;
        lockTopology(first);
        lockTopology(second);
        jdbc.query("SELECT id FROM site WHERE id IN (?, ?) ORDER BY id FOR UPDATE",
                (rs, n) -> rs.getObject(1), first, second);
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
