package com.voltpilot.writer;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

@Component
public class MeasurementRawConsumer {
    private static final Logger log = LoggerFactory.getLogger(MeasurementRawConsumer.class);
    private static final Set<String> QUALITY = Set.of(
            "good", "uncertain", "invalid", "stale", "device_error");
    private static final Pattern POINT_KEY = Pattern.compile("^[a-z0-9][a-z0-9._*\\[\\]@-]{0,239}$");
    private static final Set<String> SAMPLE_FIELDS = Set.of("point_key", "raw", "decoded",
            "quality", "observed_at", "signed_data", "signed_data_format");

    private final ObjectMapper mapper;
    private final MeasurementWriteRepository repository;

    public MeasurementRawConsumer(ObjectMapper mapper, MeasurementWriteRepository repository) {
        this.mapper = mapper;
        this.repository = repository;
    }

    @KafkaListener(topics = "${voltpilot.redpanda.measurements-topic:measurements.raw}",
            groupId = "${spring.kafka.consumer.group-id:timescale-writer}")
    public void onMessage(String value) {
        try {
            MeasurementRawEvent event = mapper.readerFor(MeasurementRawEvent.class)
                    .with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                    .with(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                    .readValue(value);
            if (!valid(event)) {
                log.warn("Skipping invalid measurements.raw event");
                return;
            }
            repository.insert(event);
        } catch (JsonProcessingException e) {
            log.warn("Skipping unparseable measurements.raw: {}", e.getMessage());
        }
    }

    private static boolean valid(MeasurementRawEvent event) {
        if (event == null || !"1.0".equals(event.schema_version()) || event.event_id() == null
                || event.tenant_id() == null || event.site_id() == null || event.device_id() == null
                || event.catalog_version() == null || event.catalog_version().isBlank()
                || event.sequence() < 0 || event.observed_at() == null || event.ingested_at() == null
                || event.source_topic() == null || event.samples() == null
                || !event.samples().isArray() || event.samples().isEmpty()
                || event.samples().size() > 256 || event.dropped_samples() < 0) {
            return false;
        }
        String expectedTopic = "ems/" + event.tenant_id() + "/" + event.site_id() + "/"
                + event.device_id() + "/v2/measurement-samples";
        if (!expectedTopic.equals(event.source_topic())) return false;
        Set<String> points = new HashSet<>();
        for (JsonNode sample : event.samples()) {
            String pointKey = sample.path("point_key").asText("");
            if (!sample.isObject() || !onlyFields(sample, SAMPLE_FIELDS)
                    || !points.add(pointKey) || !POINT_KEY.matcher(pointKey).matches()
                    || sample.get("raw") == null
                    || !scalar(sample.get("raw"))
                    || !QUALITY.contains(sample.path("quality").asText())) {
                return false;
            }
            if (sample.has("decoded") && !scalar(sample.get("decoded"))) return false;
            try {
                if (sample.has("observed_at")) Instant.parse(sample.get("observed_at").asText());
            } catch (Exception e) {
                return false;
            }
            if (sample.path("signed_data").asText("").length() > 32768
                    || sample.path("signed_data_format").asText("").length() > 128) return false;
        }
        return true;
    }

    private static boolean onlyFields(JsonNode node, Set<String> allowed) {
        var fields = node.fieldNames();
        while (fields.hasNext()) if (!allowed.contains(fields.next())) return false;
        return true;
    }

    private static boolean scalar(JsonNode node) {
        return node.isTextual() || node.isBoolean()
                || node.isNumber() && Double.isFinite(node.asDouble());
    }
}
