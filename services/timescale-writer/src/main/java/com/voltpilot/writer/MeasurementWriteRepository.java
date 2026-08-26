package com.voltpilot.writer;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/** RLS-scoped, idempotent persistence for validated measurements.raw events. */
@Repository
public class MeasurementWriteRepository {
    private final JdbcTemplate jdbc;

    record Meta(String selectionKey, boolean enabled, Instant enabledAt, Instant disabledAt,
            String applyStatus, Instant appliedAt, String aggregationKind, Integer cadence) {}

    record Previous(BigDecimal numeric, String text, String quality) {}

    record Value(BigDecimal numeric, String text) {
        static Value prefer(Value decoded, Value raw) {
            return decoded.numeric != null || decoded.text != null ? decoded : raw;
        }
    }

    public MeasurementWriteRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Transactional
    public int insert(MeasurementRawEvent event) {
        jdbc.queryForObject("SELECT set_config('app.tenant_id', ?, true)", String.class,
                event.tenant_id().toString());
        List<Instant> purgeRows = jdbc.query("SELECT data_purged_before FROM device "
                        + "WHERE id=? FOR SHARE",
                (rs, row) -> instant(rs.getTimestamp(1)), event.device_id());
        if (purgeRows.isEmpty()) {
            return 0;
        }
        Instant purgedBefore = purgeRows.get(0);

        int rows = 0;
        for (JsonNode sample : event.samples()) {
            String pointKey = sample.path("point_key").asText();
            Instant observedAt = sampleTime(sample, event.observed_at());
            Meta meta = metadata(event, pointKey);
            if (meta == null || observedAt == null || atOrBefore(observedAt, purgedBefore)
                    || meta.enabledAt() == null
                    || observedAt.isBefore(meta.enabledAt()) || !withinCutover(meta, observedAt)) {
                continue;
            }

            JsonNode rawNode = sample.get("raw");
            JsonNode decodedNode = sample.get("decoded");
            if (rawNode == null || !scalar(rawNode)) {
                continue;
            }
            Value raw = value(rawNode);
            Value decoded = decodedNode != null && scalar(decodedNode)
                    ? value(decodedNode) : new Value(null, null);
            int inserted = jdbc.update("INSERT INTO device_measurement_sample "
                            + "(time,received_at,tenant_id,site_id,device_id,point_key,raw_numeric,"
                            + "raw_text,decoded_numeric,decoded_text,quality,catalog_version,"
                            + "edge_sequence,aggregation_kind,long_term_cadence_s,gap,dropped_samples,"
                            + "signed_data,signed_data_format) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                            + "ON CONFLICT DO NOTHING",
                    Timestamp.from(observedAt), Timestamp.from(event.ingested_at()),
                    event.tenant_id(), event.site_id(), event.device_id(), pointKey,
                    raw.numeric(), raw.text(), decoded.numeric(), decoded.text(),
                    sample.path("quality").asText(), event.catalog_version(), event.sequence(),
                    meta.aggregationKind(), meta.cadence(), event.gap(), event.dropped_samples(),
                    text(sample, "signed_data"), text(sample, "signed_data_format"));
            if (inserted > 0) {
                updatePointState(event, pointKey, observedAt, raw, decoded,
                        sample.path("quality").asText());
                appendTransitions(event, pointKey, observedAt, raw, decoded,
                        sample.path("quality").asText(), meta);
                markFirstSample(event, meta.selectionKey(), observedAt);
                rows++;
            }
        }
        if ((event.gap() || event.dropped_samples() > 0)
                && !atOrBefore(event.observed_at(), purgedBefore)) {
            insertGap(event);
        }
        return rows;
    }

    private void updatePointState(MeasurementRawEvent event, String pointKey, Instant observedAt,
            Value raw, Value decoded, String quality) {
        jdbc.update("INSERT INTO device_measurement_point_state (tenant_id,site_id,device_id,"
                        + "point_key,first_read_at,last_read_at,edge_sequence,raw_numeric,raw_text,"
                        + "decoded_numeric,decoded_text,quality,gap,dropped_samples,catalog_version) "
                        + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT "
                        + "(tenant_id,site_id,device_id,point_key) DO UPDATE SET "
                        + "first_read_at=LEAST(device_measurement_point_state.first_read_at,"
                        + "EXCLUDED.first_read_at),last_read_at=EXCLUDED.last_read_at,"
                        + "edge_sequence=EXCLUDED.edge_sequence,raw_numeric=EXCLUDED.raw_numeric,"
                        + "raw_text=EXCLUDED.raw_text,decoded_numeric=EXCLUDED.decoded_numeric,"
                        + "decoded_text=EXCLUDED.decoded_text,quality=EXCLUDED.quality,gap=EXCLUDED.gap,"
                        + "dropped_samples=EXCLUDED.dropped_samples,catalog_version=EXCLUDED.catalog_version "
                        + "WHERE (EXCLUDED.last_read_at,EXCLUDED.edge_sequence) > "
                        + "(device_measurement_point_state.last_read_at,"
                        + "device_measurement_point_state.edge_sequence)",
                event.tenant_id(), event.site_id(), event.device_id(), pointKey,
                Timestamp.from(observedAt), Timestamp.from(observedAt), event.sequence(),
                raw.numeric(), raw.text(), decoded.numeric(), decoded.text(), quality,
                event.gap(), event.dropped_samples(), event.catalog_version());
    }

    private Meta metadata(MeasurementRawEvent event, String pointKey) {
        String template = templateKey(pointKey);
        List<Meta> rows = jdbc.query("SELECT s.point_key,s.enabled,s.enabled_at,s.disabled_at,s.apply_status,"
                        + "s.applied_at,"
                        + "COALESCE(m.aggregation_kind,CASE s.retention_class "
                        + "WHEN 'energy_counter' THEN 'counter' WHEN 'state_event' THEN 'event' "
                        + "WHEN 'identity_configuration' THEN 'text' WHEN 'unclassified' THEN 'none' "
                        + "ELSE 'gauge' END),COALESCE(m.long_term_cadence_s,s.long_term_cadence_s) "
                        + "FROM device_measurement_selection s "
                        + "LEFT JOIN LATERAL (SELECT m.aggregation_kind,m.long_term_cadence_s "
                        + "FROM measurement_catalog_point_metadata m "
                        + "WHERE m.catalog_version=? AND m.point_key IN (s.point_key,?) "
                        + "ORDER BY CASE WHEN m.point_key=s.point_key THEN 0 ELSE 1 END LIMIT 1) m ON true "
                        + "WHERE s.device_id=? AND s.point_key IN (?,?) "
                        + "ORDER BY CASE WHEN s.point_key=? THEN 0 ELSE 1 END LIMIT 1",
                (rs, n) -> new Meta(rs.getString(1), rs.getBoolean(2), instant(rs.getTimestamp(3)),
                        instant(rs.getTimestamp(4)), rs.getString(5), instant(rs.getTimestamp(6)),
                        rs.getString(7), (Integer) rs.getObject(8)),
                event.catalog_version(), template, event.device_id(), pointKey, template, pointKey);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private static boolean withinCutover(Meta meta, Instant observedAt) {
        if (meta.enabled()) {
            return !"rejected".equals(meta.applyStatus());
        }
        Instant cutover = meta.appliedAt() != null ? meta.appliedAt() : meta.disabledAt();
        return cutover != null && !observedAt.isAfter(cutover.plusSeconds(30));
    }

    private void appendTransitions(MeasurementRawEvent event, String pointKey, Instant at,
            Value raw, Value decoded, String quality, Meta meta) {
        List<Previous> rows = jdbc.query("SELECT COALESCE(decoded_numeric,raw_numeric),"
                        + "COALESCE(decoded_text,raw_text),quality FROM device_measurement_sample "
                        + "WHERE tenant_id=? AND site_id=? AND device_id=? AND point_key=? AND "
                        + "(time<? OR (time=? AND edge_sequence<?)) "
                        + "ORDER BY time DESC,edge_sequence DESC LIMIT 1",
                (rs, n) -> new Previous(rs.getBigDecimal(1), rs.getString(2), rs.getString(3)),
                event.tenant_id(), event.site_id(), event.device_id(), pointKey,
                Timestamp.from(at), Timestamp.from(at), event.sequence());
        Previous previous = rows.isEmpty() ? null : rows.get(0);
        if (previous == null) {
            return;
        }

        Value current = Value.prefer(decoded, raw);
        boolean changed = numericChanged(previous.numeric(), current.numeric())
                || !Objects.equals(previous.text(), current.text());
        String eventKind = null;
        if ("counter".equals(meta.aggregationKind()) && previous.numeric() != null
                && current.numeric() != null && current.numeric().compareTo(previous.numeric()) < 0) {
            eventKind = "counter_reset";
        } else if (changed && "bitfield".equals(meta.aggregationKind())) {
            eventKind = "bitfield_change";
        } else if (changed && "text".equals(meta.aggregationKind())) {
            eventKind = "text_change";
        } else if (changed && ("state".equals(meta.aggregationKind())
                || "event".equals(meta.aggregationKind()))) {
            eventKind = "state_change";
        }
        if (!Objects.equals(previous.quality(), quality)) {
            insertEvent(event, pointKey, at, "error_change", previous.numeric(),
                    current.numeric(), previous.quality(), quality, "{}");
        }
        if (eventKind != null) {
            String details = "bitfield_change".equals(eventKind)
                    ? bitfieldDetails(previous.numeric(), current.numeric()) : "{}";
            insertEvent(event, pointKey, at, eventKind, previous.numeric(), current.numeric(),
                    previous.text(), current.text(), details);
        }
    }

    private void insertGap(MeasurementRawEvent event) {
        insertEvent(event, "_pipeline", event.observed_at(), "data_gap", null, null, null, null,
                "{\"dropped_samples\":" + event.dropped_samples() + "}");
    }

    private void insertEvent(MeasurementRawEvent event, String pointKey, Instant at, String kind,
            BigDecimal previousNumeric, BigDecimal valueNumeric, String previousText, String valueText,
            String details) {
        jdbc.update("INSERT INTO device_measurement_event(occurred_at,tenant_id,site_id,device_id,"
                        + "point_key,event_kind,previous_numeric,value_numeric,previous_text,value_text,"
                        + "catalog_version,edge_sequence,details) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb) "
                        + "ON CONFLICT DO NOTHING",
                Timestamp.from(at), event.tenant_id(), event.site_id(), event.device_id(), pointKey,
                kind, previousNumeric, valueNumeric, previousText, valueText, event.catalog_version(),
                event.sequence(), details);
    }

    private void markFirstSample(MeasurementRawEvent event, String pointKey, Instant at) {
        int changed = jdbc.update("UPDATE device_measurement_selection SET apply_status='first_sample',"
                        + "apply_reason='Erster Wert gespeichert.',applied_at=COALESCE(applied_at,?) "
                        + "WHERE device_id=? AND point_key=? AND enabled "
                        + "AND apply_status<>'first_sample'",
                Timestamp.from(at), event.device_id(), pointKey);
        if (changed == 0) {
            return;
        }
        jdbc.update("INSERT INTO device_measurement_selection_event(tenant_id,site_id,device_id,"
                        + "point_key,desired_revision,event_kind,requested_at,requested_enabled,"
                        + "requested_cadence_s,enabled_at,disabled_at,catalog_version,actor,apply_status,"
                        + "apply_reason,applied_at,custom_definition,retention_class,raw_retention_days,"
                        + "long_term_cadence_s,long_term_strategy) SELECT tenant_id,site_id,device_id,"
                        + "point_key,desired_revision,'first_sample',?,enabled,cadence_s,enabled_at,"
                        + "disabled_at,catalog_version,'writer','first_sample','Erster Wert gespeichert.',"
                        + "?,custom_definition,retention_class,raw_retention_days,long_term_cadence_s,"
                        + "long_term_strategy FROM device_measurement_selection "
                        + "WHERE device_id=? AND point_key=? ON CONFLICT DO NOTHING",
                Timestamp.from(at), Timestamp.from(at), event.device_id(), pointKey);
    }

    private static Value value(JsonNode node) {
        if (node.isNumber()) {
            return new Value(node.decimalValue(), null);
        }
        return new Value(null, node.isTextual() ? node.asText()
                : Boolean.toString(node.asBoolean()));
    }

    private static boolean scalar(JsonNode node) {
        return node.isNumber() || node.isTextual() || node.isBoolean();
    }

    private static Instant sampleTime(JsonNode sample, Instant fallback) {
        try {
            return sample.has("observed_at")
                    ? Instant.parse(sample.get("observed_at").asText()) : fallback;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static Instant instant(Timestamp timestamp) {
        return timestamp == null ? null : timestamp.toInstant();
    }

    private static boolean atOrBefore(Instant value, Instant watermark) {
        return watermark != null && !value.isAfter(watermark);
    }

    private static String bitfieldDetails(BigDecimal previous, BigDecimal current) {
        if (previous == null || current == null || previous.signum() < 0 || current.signum() < 0) {
            return "{}";
        }
        try {
            BigInteger before = previous.toBigIntegerExact();
            BigInteger after = current.toBigIntegerExact();
            return "{\"set_bits\":" + after.andNot(before)
                    + ",\"cleared_bits\":" + before.andNot(after) + "}";
        } catch (ArithmeticException e) {
            return "{}";
        }
    }

    static String templateKey(String pointKey) {
        return pointKey == null ? null : pointKey.replaceAll("\\[[^]\\r\\n]+]", "[*]");
    }

    private static boolean numericChanged(BigDecimal before, BigDecimal after) {
        return before == null || after == null ? before != after : before.compareTo(after) != 0;
    }

    private static String text(JsonNode node, String field) {
        return node.has(field) && node.get(field).isTextual() ? node.get(field).asText() : null;
    }
}
