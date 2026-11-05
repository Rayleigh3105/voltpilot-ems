package com.voltpilot.api.repo;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.SiteSourceDto;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * The edge-reported per-measurement-point Ist ({@code device_source_status},
 * migration V20260721000000): per (device, source) the latest own reading +
 * freshness, written by {@link com.voltpilot.api.sources.SourceStatusListener}
 * from the heartbeat's {@code sources} block and read by the portal to render
 * the PV breakdown. RLS-scoped like every device-owned table.
 */
@Repository
public class DeviceSourceStatusRepository {

    /**
     * One reported measurement point (the row shape of the heartbeat entry).
     *
     * @param bms die {@code bms_*}-Kanäle einer per CAN gekoppelten Batterie
     *        (P4), oder {@code null}/leer, wenn keine gekoppelt ist - der
     *        Normalfall. Der Listener hat sie bereits auf eine WEISSE LISTE
     *        eingekürzt; hier wird nur noch geschrieben.
     */
    public record SourceRow(String sourceId, String kind, String role, String label, String brand,
            String model, Double pvKw, Double powerKw, Double loadKw, String health,
            Instant readAt, Map<String, Double> bms) {}

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final TypeReference<Map<String, Double>> BMS_TYPE = new TypeReference<>() {};

    private final JdbcTemplate jdbc;

    public DeviceSourceStatusRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Replace the device's whole reported set with one heartbeat's view -
     * wholesale, because the heartbeat carries the COMPLETE Ist: a source the
     * customer removed on the device must disappear here too, and a merge would
     * keep ghosts in the breakdown forever.
     *
     * <p><b>Concurrent writers: the youngest report wins.</b> Two heartbeats of
     * one box can be written at the same time (a second API instance on the same
     * topic, a redelivery). The former {@code DELETE} + {@code INSERT} lost that
     * race: the {@code DELETE} cannot see the other transaction's uncommitted
     * rows, the {@code INSERT} then died on the primary key once it committed.
     * Now every row is an {@code ON CONFLICT} upsert that overwrites only a row
     * that is not YOUNGER than this report ({@code reported_at}, the box's own
     * report time), and the vanished rows go the same way. Rows are written in
     * {@code source_id} order, so two writers queue on one lock chain instead of
     * deadlocking. Same limit as {@code EntityObservedRepository}: an OLDER
     * report written while a younger one is uncommitted can add a row the younger
     * one no longer carries; the next heartbeat replaces the set again.
     */
    @Transactional
    public void replaceForDevice(UUID deviceId, UUID tenantId, UUID siteId, Instant reportedAt,
            List<SourceRow> rows) {
        Timestamp reported = Timestamp.from(reportedAt);
        Integer younger = jdbc.queryForObject(
                "SELECT count(*) FROM device_source_status WHERE device_id = ? AND reported_at > ?",
                Integer.class, deviceId, reported);
        if (younger != null && younger > 0) {
            return; // a younger report is already stored: this one is out of order
        }
        List<SourceRow> ordered = rows.stream()
                .sorted(java.util.Comparator.comparing(SourceRow::sourceId)).toList();
        for (SourceRow r : ordered) {
            jdbc.update(
                    "INSERT INTO device_source_status (device_id, source_id, tenant_id, site_id, "
                            + "kind, role, label, brand, model, pv_kw, power_kw, load_kw, health, "
                            + "read_at, reported_at, bms) "
                            + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb) "
                            + "ON CONFLICT (device_id, source_id) DO UPDATE SET "
                            + "tenant_id = EXCLUDED.tenant_id, site_id = EXCLUDED.site_id, "
                            + "kind = EXCLUDED.kind, role = EXCLUDED.role, label = EXCLUDED.label, "
                            + "brand = EXCLUDED.brand, model = EXCLUDED.model, "
                            + "pv_kw = EXCLUDED.pv_kw, power_kw = EXCLUDED.power_kw, "
                            + "load_kw = EXCLUDED.load_kw, health = EXCLUDED.health, "
                            + "read_at = EXCLUDED.read_at, reported_at = EXCLUDED.reported_at, "
                            + "bms = EXCLUDED.bms "
                            + "WHERE device_source_status.reported_at <= EXCLUDED.reported_at",
                    deviceId, r.sourceId(), tenantId, siteId, r.kind(), r.role(), r.label(),
                    r.brand(), r.model(), r.pvKw(), r.powerKw(), r.loadKw(), r.health(),
                    r.readAt() == null ? null : Timestamp.from(r.readAt()),
                    reported, bmsJson(r.bms()));
        }
        String[] kept = ordered.stream().map(SourceRow::sourceId).toArray(String[]::new);
        jdbc.update(con -> {
            java.sql.PreparedStatement ps = con.prepareStatement(
                    "DELETE FROM device_source_status WHERE device_id = ? AND reported_at <= ? "
                            + "AND NOT (source_id = ANY (?))");
            ps.setObject(1, deviceId);
            ps.setTimestamp(2, reported);
            ps.setArray(3, con.createArrayOf("text", kept));
            return ps;
        });
    }

    /**
     * Every reported measurement point of a site, primary first, stable order - as reported by the
     * boxes that take part in operation (UEMS AP-07 IP-11): the rows of an ausgebaut box stay stored,
     * but its last „liest" is no current reading.
     */
    public List<SiteSourceDto> forSite(UUID siteId) {
        return jdbc.query(
                "SELECT device_id, source_id, kind, role, label, brand, model, pv_kw, power_kw, "
                        + "load_kw, health, read_at, reported_at, bms FROM device_source_status s "
                        + "WHERE s.site_id = ? "
                        + "AND EXISTS (SELECT 1 FROM device d WHERE d.id = s.device_id AND d.ausgebaut_am IS NULL) "
                        + "ORDER BY (kind <> 'primary'), device_id, source_id",
                DeviceSourceStatusRepository::mapRow, siteId);
    }

    /**
     * Die {@code bms_*}-Kanäle als {@code jsonb}, oder {@code null}.
     *
     * <p>Ein leerer Satz wird zu SQL-{@code NULL}, nicht zu einem leeren
     * JSON-Objekt: „keine Kopplung" ist ABWESENHEIT, und ein leeres Objekt läse
     * sich als „gekoppelt, aber nichts gemeldet".
     */
    private static String bmsJson(Map<String, Double> bms) {
        if (bms == null || bms.isEmpty()) {
            return null;
        }
        try {
            return MAPPER.writeValueAsString(bms);
        } catch (Exception e) {
            // Unschreibbar heißt ABWESEND, nie eine halbe Wahrheit: der
            // Herzschlag bringt den Satz in Sekunden erneut.
            return null;
        }
    }

    /** {@code null}/unlesbar -> {@code null}: abwesend bleibt abwesend. */
    private static Map<String, Double> readBms(String json) {
        if (json == null || json.isBlank()) {
            return null;
        }
        try {
            Map<String, Double> parsed = MAPPER.readValue(json, BMS_TYPE);
            return parsed == null || parsed.isEmpty() ? null : parsed;
        } catch (Exception e) {
            return null;
        }
    }

    private static SiteSourceDto mapRow(ResultSet rs, int rowNum) throws SQLException {
        Timestamp readAt = rs.getTimestamp("read_at");
        return new SiteSourceDto(
                rs.getObject("device_id", UUID.class),
                rs.getString("source_id"),
                rs.getString("kind"),
                rs.getString("role"),
                rs.getString("label"),
                rs.getString("brand"),
                rs.getString("model"),
                (Double) rs.getObject("pv_kw"),
                (Double) rs.getObject("power_kw"),
                (Double) rs.getObject("load_kw"),
                rs.getString("health"),
                readAt == null ? null : readAt.toInstant(),
                rs.getTimestamp("reported_at").toInstant(),
                readBms(rs.getString("bms")));
    }
}
