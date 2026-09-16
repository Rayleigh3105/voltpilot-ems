package com.voltpilot.api.uems;

import com.voltpilot.api.uems.DatenquelleRegeln.Fehlerklasse;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * Latest edge-reported state of each data source read by a box. The wire identifier is the
 * source's stable {@code DQ-*} Kennzeichen; this repository resolves it under RLS and accepts it
 * only while the reporting box is responsible for that source.
 */
@Repository
public class DeviceDataSourceStatusRepository {

    public record Meldung(String kennzeichen, String health, String errorClass, Instant since,
            Instant readAt, Double requestsPerMin, Double samplesPerMin) {}

    public record Status(String health, String errorClass, Instant since, Instant readAt,
            Double requestsPerMin, Double samplesPerMin, Instant reportedAt) {}

    public enum Lieferzustand {
        LIEFERT,
        LIEFERT_NICHT,
        MELDET_NOCH_NICHT_JE_QUELLE
    }

    /** Raw facts plus the customer wording; a missing row is the honest legacy-box result. */
    public record Ableitung(Lieferzustand zustand, Instant seit, String grund, String text) {}

    private final JdbcTemplate jdbc;

    public DeviceDataSourceStatusRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Replaces the complete set reported by one box. Older retained/out-of-order heartbeats are
     * ignored. Unknown, foreign or no-longer-assigned DQ identifiers produce no row.
     */
    @Transactional
    public void replaceForDevice(UUID deviceId, UUID tenantId, Instant reportedAt,
            List<Meldung> meldungen) {
        Integer newer = jdbc.queryForObject(
                "SELECT count(*) FROM device_data_source_status "
                        + "WHERE device_id = ? AND reported_at > ?",
                Integer.class, deviceId, Timestamp.from(reportedAt));
        if (newer != null && newer > 0) {
            return;
        }
        jdbc.update("DELETE FROM device_data_source_status WHERE device_id = ?", deviceId);
        for (Meldung m : meldungen) {
            jdbc.update(
                    "INSERT INTO device_data_source_status (device_id, data_source_id, tenant_id, "
                            + "site_id, health, error_class, since_at, read_at, requests_per_min, "
                            + "samples_per_min, reported_at) "
                            + "SELECT ?, q.id, q.tenant_id, q.site_id, ?, ?, ?, ?, ?, ?, ? "
                            + "FROM data_source q WHERE q.tenant_id = ? AND q.kennzeichen = ? "
                            + "AND EXISTS (SELECT 1 FROM data_source_assignment a "
                            + "WHERE a.tenant_id = q.tenant_id AND a.data_source_id = q.id "
                            + "AND a.device_id = ? AND a.effective_from <= ? "
                            + "AND (a.effective_to IS NULL OR a.effective_to > ?))",
                    deviceId, m.health(), m.errorClass(), timestamp(m.since()), timestamp(m.readAt()),
                    m.requestsPerMin(), m.samplesPerMin(), Timestamp.from(reportedAt), tenantId,
                    m.kennzeichen(), deviceId, Timestamp.from(reportedAt), Timestamp.from(reportedAt));
        }
    }

    public Status find(UUID deviceId, UUID dataSourceId) {
        List<Status> rows = jdbc.query(
                "SELECT health, error_class, since_at, read_at, requests_per_min, samples_per_min, "
                        + "reported_at FROM device_data_source_status "
                        + "WHERE device_id = ? AND data_source_id = ?",
                (rs, n) -> new Status(rs.getString("health"), rs.getString("error_class"),
                        instant(rs.getTimestamp("since_at")), instant(rs.getTimestamp("read_at")),
                        (Double) rs.getObject("requests_per_min"),
                        (Double) rs.getObject("samples_per_min"),
                        rs.getTimestamp("reported_at").toInstant()),
                deviceId, dataSourceId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    public static Ableitung ableiten(Status status) {
        if (status == null) {
            return new Ableitung(Lieferzustand.MELDET_NOCH_NICHT_JE_QUELLE, null, null,
                    "Box meldet noch nicht je Quelle");
        }
        if ("ok".equals(status.health())) {
            return new Ableitung(Lieferzustand.LIEFERT, null, null, "Liefert Daten");
        }
        String grund = DatenquelleRegeln.fehlerklasse(status.errorClass(), DatenquelleRegeln.Herkunft.BOX)
                .map(Fehlerklasse::kundenwort).orElse(null);
        String text = "Liefert keine Daten seit " + status.since()
                + (grund == null ? "" : " — " + grund);
        return new Ableitung(Lieferzustand.LIEFERT_NICHT, status.since(), status.errorClass(), text);
    }

    private static Timestamp timestamp(Instant value) {
        return value == null ? null : Timestamp.from(value);
    }

    private static Instant instant(Timestamp value) {
        return value == null ? null : value.toInstant();
    }
}
