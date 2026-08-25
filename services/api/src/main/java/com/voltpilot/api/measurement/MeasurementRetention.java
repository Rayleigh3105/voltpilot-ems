package com.voltpilot.api.measurement;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.Locale;

/**
 * D6 as executable metadata: 90 days raw for every sampled point, then exactly
 * the semantically correct long-term lane (5 min, 15 min, event history or
 * change history). This class does not create aggregates; the writer slice will
 * consume the policy stamped onto each selection/event.
 */
public record MeasurementRetention(String retentionClass, int rawRetentionDays,
        Integer longTermCadenceS, String longTermStrategy) {

    public static final int RAW_DAYS = 90;

    public static MeasurementRetention ofCatalog(JsonNode point) {
        Integer cadence = nullableInt(point.get("long_term_cadence_s"));
        String aggregation = text(point, "aggregation_kind");
        String group = lower(text(point, "group"));
        if ("event".equals(aggregation) || "state".equals(aggregation)
                || "bitfield".equals(aggregation)) {
            return new MeasurementRetention("state_event", RAW_DAYS, null, "event_history");
        }
        if (cadence != null && cadence == 300) {
            String clazz = group.contains("phase") || group.contains("mppt")
                    || group.contains("string") ? "phase_mppt_string" : "live_power";
            return new MeasurementRetention(clazz, RAW_DAYS, 300, "five_minute");
        }
        if (cadence != null && cadence == 900) {
            String clazz = "counter".equals(aggregation) ? "energy_counter" : "thermal_bms";
            return new MeasurementRetention(clazz, RAW_DAYS, 900, "fifteen_minute");
        }
        if ("text".equals(aggregation) || "none".equals(aggregation)
                || group.contains("identity") || group.contains("config")
                || group.contains("firmware")) {
            return new MeasurementRetention("identity_configuration", RAW_DAYS, null,
                    "change_history");
        }
        // Unknown means unknown: no aggregate cadence is invented. The raw lane
        // still has the decided 90-day lifetime.
        return new MeasurementRetention("unclassified", RAW_DAYS, null, "none");
    }

    public static MeasurementRetention ofCustomClass(String requested) {
        String value = requested == null ? "" : requested.trim().toLowerCase(Locale.ROOT);
        return switch (value) {
            case "live_power" -> new MeasurementRetention(value, RAW_DAYS, 300, "five_minute");
            case "phase_mppt_string" ->
                    new MeasurementRetention(value, RAW_DAYS, 300, "five_minute");
            case "thermal_bms" ->
                    new MeasurementRetention(value, RAW_DAYS, 900, "fifteen_minute");
            case "energy_counter" ->
                    new MeasurementRetention(value, RAW_DAYS, 900, "fifteen_minute");
            case "state_event" ->
                    new MeasurementRetention(value, RAW_DAYS, null, "event_history");
            case "identity_configuration" ->
                    new MeasurementRetention(value, RAW_DAYS, null, "change_history");
            default -> throw new IllegalArgumentException(
                    "Bitte eine Aufbewahrungsklasse für den eigenen Messwert wählen.");
        };
    }

    private static Integer nullableInt(JsonNode n) {
        return n == null || n.isNull() ? null : n.asInt();
    }

    private static String text(JsonNode n, String field) {
        JsonNode v = n == null ? null : n.get(field);
        return v == null || v.isNull() ? null : v.asText();
    }

    private static String lower(String s) {
        return s == null ? "" : s.toLowerCase(Locale.ROOT);
    }
}
