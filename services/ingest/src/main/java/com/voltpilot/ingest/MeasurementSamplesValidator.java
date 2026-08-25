package com.voltpilot.ingest;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

@Component
public class MeasurementSamplesValidator {
    private static final Pattern KEY = Pattern.compile("^[a-z0-9][a-z0-9._*\\[\\]@-]{0,239}$");
    private static final Pattern CATALOG = Pattern.compile("^[0-9]{4}\\.[0-9]{2}\\.[0-9]{2}\\.[0-9]+$");
    private static final Set<String> QUALITY = Set.of(
            "good", "uncertain", "invalid", "stale", "device_error");
    private static final Set<String> ROOT_FIELDS = Set.of("schema_version", "tenant_id",
            "site_id", "device_id", "catalog_version", "sequence", "observed_at", "samples",
            "dropped_samples", "gap");
    private static final Set<String> SAMPLE_FIELDS = Set.of("point_key", "raw", "decoded",
            "quality", "observed_at", "signed_data", "signed_data_format");
    private final ObjectMapper mapper;

    public MeasurementSamplesValidator(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    public MeasurementRawEvent toEvent(String topic, String payload, Instant ingestedAt) {
        try {
            JsonNode r = mapper.reader().with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                    .readTree(payload);
            if (r == null || !r.isObject() || !onlyFields(r, ROOT_FIELDS)
                    || !"2.0".equals(r.path("schema_version").asText())) bad("schema");
            UUID tenant = uuid(r, "tenant_id");
            UUID site = uuid(r, "site_id");
            UUID device = uuid(r, "device_id");
            String[] p = topic.split("/");
            if (p.length != 6 || !"ems".equals(p[0]) || !"v2".equals(p[4])
                    || !"measurement-samples".equals(p[5])
                    || !p[1].equals(tenant.toString()) || !p[2].equals(site.toString())
                    || !p[3].equals(device.toString())) bad("topic identity");
            String catalog = text(r, "catalog_version");
            if (!CATALOG.matcher(catalog).matches()) bad("catalog_version");
            if (!r.path("sequence").isIntegralNumber()) bad("sequence");
            long seq = r.path("sequence").asLong(-1);
            Instant observed = OffsetDateTime.parse(text(r, "observed_at")).toInstant();
            JsonNode samples = r.get("samples");
            if (seq < 0 || samples == null || !samples.isArray() || samples.isEmpty()
                    || samples.size() > 256) bad("batch bounds");
            Set<String> points = new HashSet<>();
            for (JsonNode s : samples) {
                if (!s.isObject() || !onlyFields(s, SAMPLE_FIELDS)) bad("sample fields");
                String key = text(s, "point_key");
                JsonNode raw = s.get("raw");
                if (!KEY.matcher(key).matches() || !points.add(key) || raw == null || !scalar(raw)
                        || !QUALITY.contains(text(s, "quality"))) bad("sample");
                if (s.has("decoded") && !scalar(s.get("decoded"))) bad("decoded");
                if (s.has("observed_at")) OffsetDateTime.parse(text(s, "observed_at"));
                if (s.has("signed_data") && text(s, "signed_data").length() > 32768) bad("signed_data");
                if (s.has("signed_data_format")
                        && text(s, "signed_data_format").length() > 128) bad("signed_data_format");
            }
            if (r.has("dropped_samples") && !r.get("dropped_samples").isIntegralNumber()) bad("drops");
            if (r.has("gap") && !r.get("gap").isBoolean()) bad("gap");
            long dropped = r.path("dropped_samples").asLong(0);
            if (dropped < 0) bad("drops");
            return new MeasurementRawEvent("1.0", UUID.randomUUID(), tenant, site, device,
                    catalog, seq, observed, ingestedAt, topic, samples, dropped,
                    r.path("gap").asBoolean(false));
        } catch (InvalidTelemetryException e) {
            throw e;
        } catch (Exception e) {
            throw new InvalidTelemetryException("invalid measurement samples: " + e.getMessage());
        }
    }

    private static boolean scalar(JsonNode node) {
        return node.isNumber() && Double.isFinite(node.asDouble())
                || node.isTextual() || node.isBoolean();
    }
    private static boolean onlyFields(JsonNode node, Set<String> allowed) {
        var names = node.fieldNames();
        while (names.hasNext()) if (!allowed.contains(names.next())) return false;
        return true;
    }
    private static UUID uuid(JsonNode node, String field) {
        try {
            return UUID.fromString(text(node, field));
        } catch (Exception e) {
            bad(field);
            return null;
        }
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node.get(field);
        if (value == null || !value.isTextual() || value.asText().isBlank()) bad(field);
        return value.asText();
    }

    private static void bad(String reason) {
        throw new InvalidTelemetryException(reason);
    }
}
