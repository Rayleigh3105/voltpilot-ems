package com.voltpilot.api.measurement;

import com.voltpilot.api.measurement.MeasurementCatalog.Point;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/** RLS-scoped additional-measurement history with bounded, semantic aggregation. */
@Service
public class MeasurementHistoryService {

    public record Datum(Instant time, Double value, Double minimum, Double maximum,
            String text, long sampleCount, boolean gap) {}
    public record Marker(Instant time, String kind, String label) {}
    public record Meta(String pointKey, String label, String sourceLabel, String unit,
            String aggregationKind, String semanticStatus, String catalogVersion,
            String representation, boolean rawAvailable, Instant from, Instant to,
            int bucketSeconds, String aggregationExplanation) {}
    public record History(Meta meta, List<Datum> data, List<Marker> markers) {}
    public record ComparisonOption(UUID deviceId, String deviceLabel, String pointKey,
            String label, String unit, String aggregationKind, String compatibilityKey,
            Instant lastReadAt) {}

    private final JdbcTemplate jdbc;
    private final MeasurementCatalog catalog;
    private final MeasurementSelectionRepository selections;

    public MeasurementHistoryService(JdbcTemplate jdbc, MeasurementCatalog catalog,
            MeasurementSelectionRepository selections) {
        this.jdbc = jdbc;
        this.catalog = catalog;
        this.selections = selections;
    }

    public History history(UUID deviceId, String pointKey, String range, Instant freeFrom,
            Instant freeTo, String representation) {
        if (selections.deviceScope(deviceId) == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Gerät nicht gefunden.");
        }
        Point point = catalog.resolve(pointKey);
        if (point == null && selections.recordedPointKeys(deviceId).stream().noneMatch(pointKey::equals)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Messwert nicht gefunden.");
        }
        CustomMeta custom = point == null ? customMeta(deviceId, pointKey) : null;
        Window window = window(range, freeFrom, freeTo);
        String selectedRepresentation = "raw".equals(representation) ? "raw" : "decoded";
        String numeric = selectedRepresentation.equals("raw") ? "raw_numeric"
                : "COALESCE(decoded_numeric,raw_numeric)";
        String text = selectedRepresentation.equals("raw") ? "raw_text"
                : "COALESCE(decoded_text,raw_text)";
        String sql = "WITH ordered AS (SELECT time, aggregation_kind, gap, " + numeric
                + " value_numeric, " + text + " value_text, lag(" + numeric + ") OVER "
                + "(ORDER BY time,edge_sequence) previous_numeric FROM device_measurement_sample "
                + "WHERE device_id=? AND point_key=? AND time>=? AND time<=?), bucketed AS ("
                + "SELECT time_bucket(CAST(? AS interval),time) bucket, aggregation_kind, "
                + "avg(value_numeric) avg_value,min(value_numeric) min_value,max(value_numeric) max_value,"
                + "sum(CASE WHEN previous_numeric IS NOT NULL AND value_numeric>=previous_numeric "
                + "THEN value_numeric-previous_numeric ELSE 0 END) positive_delta,"
                + "last(value_numeric,time) last_numeric,last(value_text,time) last_text,count(*) samples,"
                + "bool_or(gap) has_gap FROM ordered GROUP BY 1,2) SELECT *, CASE "
                + "WHEN aggregation_kind='counter' THEN positive_delta "
                + "WHEN aggregation_kind='gauge' THEN avg_value ELSE last_numeric END chart_value "
                + "FROM bucketed ORDER BY bucket LIMIT 2200";
        List<Datum> data = jdbc.query(sql, (rs, n) -> new Datum(
                rs.getTimestamp("bucket").toInstant(), nullableDouble(rs, "chart_value"),
                nullableDouble(rs, "min_value"), nullableDouble(rs, "max_value"),
                rs.getString("last_text"), rs.getLong("samples"), rs.getBoolean("has_gap")),
                deviceId, pointKey, Timestamp.from(window.from()), Timestamp.from(window.to()),
                window.bucket());
        boolean rawAvailable = Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT EXISTS(SELECT 1 FROM device_measurement_sample WHERE device_id=? "
                        + "AND point_key=? AND time>=? AND time<=? AND "
                        + "(raw_numeric IS NOT NULL OR raw_text IS NOT NULL))",
                Boolean.class, deviceId, pointKey, Timestamp.from(window.from()),
                Timestamp.from(window.to())));
        if (selectedRepresentation.equals("raw") && !rawAvailable) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Für diesen Zeitraum sind keine echten Rohdaten vorhanden.");
        }
        List<Marker> markers = markers(deviceId, pointKey, window);
        String aggregation = point == null ? custom == null ? "unknown" : "gauge"
                : point.aggregationKind();
        String explanation = switch (aggregation) {
            case "counter" -> "Zähler: positive Differenzen je Zeitfenster; Resets werden nicht als Verbrauch gezählt.";
            case "gauge" -> "Messwert: Mittelwert je Zeitfenster; Minimum und Maximum bleiben sichtbar.";
            default -> "Zustand/Ereignis: letzter Wert je Zeitfenster; Wechsel bleiben als Marker erhalten.";
        };
        Meta meta = new Meta(pointKey, point == null ? custom == null ? pointKey : custom.label()
                : point.labelDe() == null ? point.labelSource() : point.labelDe(),
                point == null ? custom == null ? null : "Eigenes Register" : point.labelSource(),
                point == null ? custom == null ? null : custom.unit() : point.unit(),
                aggregation, point == null ? "unknown" : point.semanticStatus(),
                point == null ? custom == null ? null : custom.catalogVersion() : catalog.version(),
                selectedRepresentation, rawAvailable,
                window.from(), window.to(), window.bucketSeconds(), explanation);
        return new History(meta, data, markers);
    }

    public byte[] csv(History history) {
        StringBuilder out = new StringBuilder();
        Meta m = history.meta();
        out.append("# point_key=").append(csv(m.pointKey())).append('\n')
                .append("# label=").append(csv(m.label())).append('\n')
                .append("# source_label=").append(csv(m.sourceLabel())).append('\n')
                .append("# unit=").append(csv(m.unit())).append('\n')
                .append("# aggregation=").append(csv(m.aggregationKind())).append('\n')
                .append("# semantic_status=").append(csv(m.semanticStatus())).append('\n')
                .append("# catalog_version=").append(csv(m.catalogVersion())).append('\n')
                .append("# representation=").append(csv(m.representation())).append('\n')
                .append("time,value,min,max,text,sample_count,gap\n");
        for (Datum d : history.data()) {
            out.append(d.time()).append(',').append(value(d.value())).append(',')
                    .append(value(d.minimum())).append(',').append(value(d.maximum())).append(',')
                    .append(csv(d.text())).append(',').append(d.sampleCount()).append(',')
                    .append(d.gap()).append('\n');
        }
        return out.toString().getBytes(StandardCharsets.UTF_8);
    }

    /** A deliberately small, recent, semantically known site picker; never a catalog wall. */
    public List<ComparisonOption> comparisonOptions(UUID siteId) {
        Boolean visible = jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM site WHERE id=?)",
                Boolean.class, siteId);
        if (!Boolean.TRUE.equals(visible)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        record Seen(UUID deviceId, String deviceLabel, String pointKey, Instant lastReadAt) {}
        List<Seen> seen = jdbc.query("SELECT d.id device_id, COALESCE(d.name,d.external_ref) device_label,"
                        + "s.point_key,max(s.time) last_read FROM device_measurement_sample s "
                        + "JOIN device d ON d.id=s.device_id WHERE s.site_id=? GROUP BY d.id,2,s.point_key "
                        + "ORDER BY last_read DESC LIMIT 200",
                (rs, n) -> new Seen(rs.getObject("device_id", UUID.class),
                        rs.getString("device_label"), rs.getString("point_key"),
                        rs.getTimestamp("last_read").toInstant()), siteId);
        List<ComparisonOption> result = new ArrayList<>();
        for (Seen item : seen) {
            Point point = catalog.resolve(item.pointKey());
            if (point == null || !"known".equals(point.semanticStatus()) || point.unit() == null
                    || !(point.aggregationKind().equals("gauge")
                            || point.aggregationKind().equals("counter"))) continue;
            String label = point.labelDe() == null ? point.labelSource() : point.labelDe();
            String compatibility = point.aggregationKind() + "|"
                    + label.toLowerCase(java.util.Locale.ROOT).replaceAll("[^a-z0-9äöüß]+", "-");
            result.add(new ComparisonOption(item.deviceId(), item.deviceLabel(), item.pointKey(),
                    label, point.unit(), point.aggregationKind(), compatibility, item.lastReadAt()));
            if (result.size() == 40) break;
        }
        return List.copyOf(result);
    }

    private List<Marker> markers(UUID deviceId, String pointKey, Window w) {
        List<Marker> result = new ArrayList<>();
        result.addAll(jdbc.query("SELECT requested_at marker_time,event_kind,requested_enabled,apply_status "
                        + "FROM device_measurement_selection_event WHERE device_id=? AND point_key=? "
                        + "AND requested_at>=? AND requested_at<=? ORDER BY requested_at",
                (rs, n) -> new Marker(rs.getTimestamp("marker_time").toInstant(),
                        rs.getString("event_kind"), selectionLabel(rs.getString("event_kind"),
                                rs.getBoolean("requested_enabled"), rs.getString("apply_status"))),
                deviceId, pointKey, Timestamp.from(w.from()), Timestamp.from(w.to())));
        result.addAll(jdbc.query("SELECT occurred_at marker_time,event_kind FROM device_measurement_event "
                        + "WHERE device_id=? AND point_key=? AND occurred_at>=? AND occurred_at<=? "
                        + "AND event_kind IN ('data_gap','counter_reset') ORDER BY occurred_at",
                (rs, n) -> new Marker(rs.getTimestamp("marker_time").toInstant(),
                        rs.getString("event_kind"), "data_gap".equals(rs.getString("event_kind"))
                                ? "Datenlücke" : "Zählerneustart"), deviceId, pointKey,
                Timestamp.from(w.from()), Timestamp.from(w.to())));
        result.addAll(jdbc.query("SELECT effective_at marker_time,event_type,from_value,to_value "
                        + "FROM component_change_event WHERE site_id=(SELECT site_id FROM device WHERE id=?) "
                        + "AND event_type='family_changed' AND effective_at>=? AND effective_at<=? "
                        + "ORDER BY effective_at",
                (rs, n) -> new Marker(rs.getTimestamp("marker_time").toInstant(),
                        rs.getString("event_type"), "Anbindungsfamilie gewechselt: "
                                + display(rs.getString("from_value")) + " → "
                                + display(rs.getString("to_value"))),
                deviceId, Timestamp.from(w.from()), Timestamp.from(w.to())));
        result.sort(java.util.Comparator.comparing(Marker::time));
        return List.copyOf(result);
    }

    private CustomMeta customMeta(UUID deviceId, String pointKey) {
        List<CustomMeta> rows = jdbc.query("SELECT custom_definition->>'label' label, "
                        + "custom_definition->>'unit' unit,catalog_version "
                        + "FROM device_measurement_selection WHERE device_id=? AND point_key=? "
                        + "AND custom_definition IS NOT NULL",
                (rs, n) -> new CustomMeta(rs.getString("label"), rs.getString("unit"),
                        rs.getString("catalog_version")), deviceId, pointKey);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private static String selectionLabel(String kind, boolean enabled, String status) {
        if ("first_sample".equals(kind) || "first_sample".equals(status)) return "Erster Wert";
        if ("edge_ack".equals(kind)) return "Auswahl angewendet";
        return enabled ? "Aufzeichnung angefordert" : "Aufzeichnung beendet (Historie bleibt)";
    }

    private static String display(String value) {
        return value == null || value.isBlank() ? "unbekannt" : value;
    }

    private static Window window(String range, Instant freeFrom, Instant freeTo) {
        Instant to = freeTo == null ? Instant.now() : freeTo;
        Duration duration = switch (range == null ? "24h" : range) {
            case "24h" -> Duration.ofHours(24);
            case "7d" -> Duration.ofDays(7);
            case "30d" -> Duration.ofDays(30);
            case "90d" -> Duration.ofDays(90);
            case "year" -> Duration.ofDays(366);
            case "free" -> freeFrom == null ? null : Duration.between(freeFrom, to);
            default -> throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unbekannter Zeitraum.");
        };
        if (duration == null || duration.isNegative() || duration.isZero()
                || duration.compareTo(Duration.ofDays(366)) > 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Der freie Zeitraum muss zwischen einer Sekunde und einem Jahr liegen.");
        }
        Instant from = "free".equals(range) ? freeFrom : to.minus(duration);
        int bucketSeconds = duration.compareTo(Duration.ofDays(2)) <= 0 ? 300
                : duration.compareTo(Duration.ofDays(31)) <= 0 ? 900
                : duration.compareTo(Duration.ofDays(100)) <= 0 ? 3600 : 21600;
        return new Window(from.truncatedTo(ChronoUnit.SECONDS), to.truncatedTo(ChronoUnit.SECONDS),
                bucketSeconds + " seconds", bucketSeconds);
    }

    private record Window(Instant from, Instant to, String bucket, int bucketSeconds) {}
    private record CustomMeta(String label, String unit, String catalogVersion) {}

    private static Double nullableDouble(java.sql.ResultSet rs, String name)
            throws java.sql.SQLException {
        double value = rs.getDouble(name);
        return rs.wasNull() ? null : value;
    }
    private static String value(Double value) { return value == null ? "" : value.toString(); }
    private static String csv(String value) {
        if (value == null) return "";
        return '"' + value.replace("\"", "\"\"") + '"';
    }
}
