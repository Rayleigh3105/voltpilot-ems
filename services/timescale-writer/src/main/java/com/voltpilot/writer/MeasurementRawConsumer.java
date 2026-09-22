package com.voltpilot.writer;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
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
    // entity_id kommt NUR an einem geteilten Punkt (derselbe point_key mehrfach, je mit eigener
    // Komponente, UEMS AP-07 IP-18b); dort ist (point_key, entity_id) der Schlüssel im Ereignis.
    private static final Set<String> SAMPLE_FIELDS = Set.of("point_key", "raw", "decoded",
            "quality", "observed_at", "signed_data", "signed_data_format", "entity_id");

    private final ObjectMapper mapper;
    private final MeasurementWriteRepository repository;
    private final WriterVerwerfMetriken verworfen;

    public MeasurementRawConsumer(ObjectMapper mapper, MeasurementWriteRepository repository,
            WriterVerwerfMetriken verworfen) {
        this.mapper = mapper;
        this.repository = repository;
        this.verworfen = verworfen;
    }

    @KafkaListener(topics = "${voltpilot.redpanda.measurements-topic:measurements.raw}",
            groupId = "${spring.kafka.consumer.group-id:timescale-writer}")
    public void onMessage(String value) {
        try {
            MeasurementRawEvent event = mapper.readerFor(MeasurementRawEvent.class)
                    .with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                    .with(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                    .readValue(value);
            String grund = pruefen(event);
            if (grund != null) {
                log.warn("Skipping invalid measurements.raw event");
                verworfen.umschlagMitSamples("measurements", grund, sampleAnzahl(event));
                return;
            }
            repository.insert(event);
        } catch (JsonProcessingException e) {
            log.warn("Skipping unparseable measurements.raw: {}", e.getMessage());
            verworfen.umschlag("measurements", WriterVerwerfMetriken.UNLESBAR);
        }
    }

    private static String pruefen(MeasurementRawEvent event) {
        if (event == null || !"1.0".equals(event.schema_version())) {
            return WriterVerwerfMetriken.UNGUELTIG;
        }
        if (event.event_id() == null || event.tenant_id() == null || event.site_id() == null
                || event.device_id() == null || event.catalog_version() == null
                || event.catalog_version().isBlank() || event.observed_at() == null
                || event.ingested_at() == null || event.source_topic() == null
                || event.samples() == null || !event.samples().isArray()
                || event.samples().isEmpty()) {
            return WriterVerwerfMetriken.PFLICHTFELD;
        }
        if (event.sequence() < 0 || event.samples().size() > 256 || event.dropped_samples() < 0) {
            return WriterVerwerfMetriken.UNGUELTIG;
        }
        String expectedTopic = "ems/" + event.tenant_id() + "/" + event.site_id() + "/"
                + event.device_id() + "/v2/measurement-samples";
        if (!expectedTopic.equals(event.source_topic())) return WriterVerwerfMetriken.IDENTITAET;
        Set<String> points = new HashSet<>();
        Set<String> geteilt = new HashSet<>();
        for (JsonNode sample : event.samples()) {
            String pointKey = sample.path("point_key").asText("");
            if (!points.add(pointKey)) geteilt.add(pointKey);
        }
        Set<String> paare = new HashSet<>();
        for (JsonNode sample : event.samples()) {
            String pointKey = sample.path("point_key").asText("");
            UUID komponente = MeasurementWriteRepository.komponente(sample);
            // Ein einfacher Punkt trägt keine Komponente; ein geteilter trägt sie JE Vorkommen,
            // und dasselbe Paar zweimal ist doppelt wie bisher der Punkt.
            boolean schluessel = geteilt.contains(pointKey)
                    ? komponente != null && paare.add(pointKey + "|" + komponente)
                    : !sample.has("entity_id");
            if (!sample.isObject() || !onlyFields(sample, SAMPLE_FIELDS)
                    || !schluessel || !POINT_KEY.matcher(pointKey).matches()
                    || sample.get("raw") == null
                    || !scalar(sample.get("raw"))
                    || !QUALITY.contains(sample.path("quality").asText())) {
                return WriterVerwerfMetriken.UNGUELTIG;
            }
            if (sample.has("decoded") && !scalar(sample.get("decoded"))) {
                return WriterVerwerfMetriken.UNGUELTIG;
            }
            try {
                if (sample.has("observed_at")) Instant.parse(sample.get("observed_at").asText());
            } catch (Exception e) {
                return WriterVerwerfMetriken.UNGUELTIG;
            }
            if (sample.path("signed_data").asText("").length() > 32768
                    || sample.path("signed_data_format").asText("").length() > 128) {
                return WriterVerwerfMetriken.UNGUELTIG;
            }
        }
        return null;
    }

    private static int sampleAnzahl(MeasurementRawEvent event) {
        return event != null && event.samples() != null && event.samples().isArray()
                ? event.samples().size() : 0;
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
