package com.voltpilot.api.repo;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * The device-reported live flow state (flow_device_ack + flow_node_status,
 * migration V20260723020000), RLS-scoped like device_control_status.
 *
 * <p>Both sets are REPLACED per device on every heartbeat: the block carries
 * the complete Ist, so merging would keep ghosts of retired flows.
 */
@Repository
public class FlowStatusRepository {

    private final JdbcTemplate jdbc;

    public FlowStatusRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** One deployed artifact as the DEVICE acknowledges it. */
    public record Ack(UUID flowId, int flowVersion, String contentHash, String state,
            String detail, Instant reportedAt) {
    }

    /** One node's live state as the DEVICE reports it (never derived here). */
    public record NodeStatus(UUID flowId, String nodeId, String state, String text,
            Instant since, Instant reportedAt) {
    }

    /**
     * Replace the device's whole ack set, and hand back the PREVIOUS one - the
     * ALT-gegen-NEU comparison the Stufe-5b rule protocol needs
     * ({@link com.voltpilot.api.rules.RuleEventWriter}). Taking it from the
     * {@code DELETE ... RETURNING} is free: the statement scans exactly those
     * rows anyway, so the hot path keeps its query count.
     */
    @Transactional
    public List<Ack> replaceAcks(UUID deviceId, UUID siteId, List<Ack> acks, Instant reportedAt) {
        List<Ack> previous = jdbc.query(
                "DELETE FROM flow_device_ack WHERE device_id = ? "
                        + "RETURNING flow_id, flow_version, content_hash, state, detail, "
                        + "reported_at",
                (rs, i) -> new Ack(rs.getObject("flow_id", UUID.class), rs.getInt("flow_version"),
                        rs.getString("content_hash"), rs.getString("state"), rs.getString("detail"),
                        rs.getTimestamp("reported_at").toInstant()),
                deviceId);
        for (Ack ack : acks) {
            jdbc.update(
                    "INSERT INTO flow_device_ack (device_id, flow_id, tenant_id, site_id, "
                            + "flow_version, content_hash, state, detail, reported_at) "
                            + "VALUES (?, ?, NULLIF(current_setting('app.tenant_id', true), '')::uuid, "
                            + "?, ?, ?, ?, ?, ?) ON CONFLICT (device_id, flow_id) DO UPDATE SET "
                            + "flow_version = EXCLUDED.flow_version, content_hash = EXCLUDED.content_hash, "
                            + "state = EXCLUDED.state, detail = EXCLUDED.detail, "
                            + "reported_at = EXCLUDED.reported_at",
                    deviceId, ack.flowId(), siteId, ack.flowVersion(), ack.contentHash(),
                    ack.state(), ack.detail(), Timestamp.from(reportedAt));
        }
        return previous;
    }

    @Transactional
    public void replaceNodeStatuses(UUID deviceId, UUID siteId, List<NodeStatus> statuses,
            Instant reportedAt) {
        jdbc.update("DELETE FROM flow_node_status WHERE device_id = ?", deviceId);
        for (NodeStatus s : statuses) {
            jdbc.update(
                    "INSERT INTO flow_node_status (device_id, flow_id, node_id, tenant_id, site_id, "
                            + "state, text, since, reported_at) "
                            + "VALUES (?, ?, ?, NULLIF(current_setting('app.tenant_id', true), '')::uuid, "
                            + "?, ?, ?, ?, ?) ON CONFLICT (device_id, flow_id, node_id) DO UPDATE SET "
                            + "state = EXCLUDED.state, text = EXCLUDED.text, since = EXCLUDED.since, "
                            + "reported_at = EXCLUDED.reported_at",
                    deviceId, s.flowId(), s.nodeId(), siteId, s.state(), s.text(),
                    s.since() == null ? null : Timestamp.from(s.since()), Timestamp.from(reportedAt));
        }
    }

    public List<Ack> acksForSite(UUID siteId) {
        return jdbc.query(
                "SELECT flow_id, flow_version, content_hash, state, detail, reported_at "
                        + "FROM flow_device_ack WHERE site_id = ? ORDER BY reported_at DESC",
                (rs, i) -> new Ack(rs.getObject("flow_id", UUID.class), rs.getInt("flow_version"),
                        rs.getString("content_hash"), rs.getString("state"), rs.getString("detail"),
                        rs.getTimestamp("reported_at").toInstant()),
                siteId);
    }

    public List<NodeStatus> nodeStatusesForSite(UUID siteId) {
        return jdbc.query(
                "SELECT flow_id, node_id, state, text, since, reported_at "
                        + "FROM flow_node_status WHERE site_id = ? ORDER BY flow_id, node_id",
                (rs, i) -> new NodeStatus(rs.getObject("flow_id", UUID.class), rs.getString("node_id"),
                        rs.getString("state"), rs.getString("text"),
                        rs.getTimestamp("since") == null ? null : rs.getTimestamp("since").toInstant(),
                        rs.getTimestamp("reported_at").toInstant()),
                siteId);
    }
}
