package com.voltpilot.writer;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.writer.EreignisVokabular.Grund;
import com.voltpilot.writer.EreignisVokabular.Urheber;
import com.voltpilot.writer.MessreiheEreignisRepository.Ausgang;
import com.voltpilot.writer.MessreiheEreignisRepository.Ergebnis;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.Instant;
import java.util.Iterator;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

/**
 * Consumer of the Redpanda topic {@code events.raw} (UEMS AP-07 IP-8; contract {@code
 * docs/contracts/v2/events-raw.event.schema.json}): ONE event per record - from a box envelope
 * the ingest decomposed (urheber {@code box}) or from a cloud service (datenannahme, writer,
 * cloud, kunde). Every event is judged against the contract and appended to {@code
 * messreihe_ereignis}, never changed, never deleted.
 *
 * <p>The record frame is checked here, exactly as the schema writes it down (schema_version
 * {@code 1.0}, ids, urheber, arrival time; for {@code box} the envelope's device, topic,
 * sequence and time, {@code ereignis.box} = {@code device_id} and the topic of exactly that box).
 * The event itself is judged by {@link EreignisVokabular} inside {@link
 * MessreiheEreignisRepository#anhaengen} (repeat = no-op, Fortschreibung = another row).
 *
 * <p>Invalid means DROPPED - logged and counted in {@code voltpilot_writer_events_raw_total}
 * with {@code ergebnis} and the contract's {@code grund}, never guessed, never mapped onto a
 * similar event. Same posture as the other consumers: a poison record advances the offset, a
 * transient database failure re-throws so Kafka redelivers (safe - the append is idempotent).
 */
@Component
public class EventsRawConsumer {

    private static final Logger log = LoggerFactory.getLogger(EventsRawConsumer.class);
    static final String METRIK = "voltpilot.writer.events.raw";

    private static final Set<String> FELDER = Set.of("schema_version", "event_id", "tenant_id",
            "site_id", "urheber", "ingested_at", "device_id", "source_topic", "sequence",
            "observed_at", "ereignis");
    private static final Pattern UUID_FORM =
            Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
    private static final Pattern ZEIT_UTC =
            Pattern.compile("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$");

    private final ObjectMapper mapper;
    private final MessreiheEreignisRepository repository;
    private final MeterRegistry meters;

    public EventsRawConsumer(ObjectMapper mapper, MessreiheEreignisRepository repository,
            MeterRegistry meters) {
        this.mapper = mapper;
        this.repository = repository;
        this.meters = meters;
    }

    @KafkaListener(topics = "${voltpilot.redpanda.events-topic:events.raw}",
            groupId = "${spring.kafka.consumer.group-id:timescale-writer}")
    public void onMessage(String value) {
        JsonNode r;
        try {
            r = mapper.readTree(value);
        } catch (JsonProcessingException e) {
            verworfen(null, Grund.SCHEMA_VERLETZT.code(), "unparseable: " + e.getOriginalMessage());
            return;
        }
        String[] fehler = rahmenFehler(r);
        if (fehler != null) {
            verworfen(r, fehler[0], fehler[1]);
            return;
        }
        Ergebnis e;
        try {
            e = repository.anhaengen(UUID.fromString(r.get("tenant_id").asText()),
                    UUID.fromString(r.get("site_id").asText()),
                    Urheber.vonCode(r.get("urheber").asText()), r.get("ereignis"),
                    Instant.parse(r.get("ingested_at").asText()));
        } catch (DataIntegrityViolationException ex) {
            // The database fence refused what the twin accepted - the twins diverged. Loud, but
            // never a stuck partition.
            log.error("events.raw event {} refused by the database: {}", r.path("event_id").asText(),
                    ex.getMostSpecificCause().getMessage());
            zaehle("verworfen", "datenbank");
            return;
        }
        if (e.ausgang() == Ausgang.VERWORFEN) {
            verworfen(r, e.grund(), e.hinweis());
            return;
        }
        zaehle(e.ausgang().name().toLowerCase(Locale.ROOT), "");
        if (log.isDebugEnabled()) {
            log.debug("events.raw event {} -> {}", r.path("event_id").asText(), e.ausgang());
        }
    }

    /** {grund, hint} of the first frame violation, or null. */
    private static String[] rahmenFehler(JsonNode r) {
        if (!r.isObject()) {
            return nein(Grund.SCHEMA_VERLETZT, "not an object");
        }
        for (Iterator<String> it = r.fieldNames(); it.hasNext(); ) {
            String f = it.next();
            if (!FELDER.contains(f)) {
                return nein(Grund.SCHEMA_VERLETZT, "unknown field " + f);
            }
        }
        if (!r.path("schema_version").isTextual()) {
            return nein(Grund.SCHEMA_VERLETZT, "schema_version");
        }
        if (!"1.0".equals(r.get("schema_version").asText())) {
            return nein(Grund.FASSUNG_UNBEKANNT, "schema_version " + r.get("schema_version").asText());
        }
        for (String f : new String[] {"event_id", "tenant_id", "site_id"}) {
            if (!uuid(r, f)) {
                return nein(Grund.SCHEMA_VERLETZT, f);
            }
        }
        if (!r.path("urheber").isTextual()) {
            return nein(Grund.SCHEMA_VERLETZT, "urheber");
        }
        Urheber u = Urheber.vonCode(r.get("urheber").asText());
        if (u == null) {
            return nein(Grund.WORT_UNBEKANNT, "urheber " + r.get("urheber").asText());
        }
        if (!zeit(r, "ingested_at")) {
            return nein(Grund.SCHEMA_VERLETZT, "ingested_at");
        }
        if (!r.path("ereignis").isObject()) {
            return nein(Grund.SCHEMA_VERLETZT, "ereignis");
        }
        if (r.has("device_id") && !uuid(r, "device_id")
                || r.has("source_topic") && (!r.get("source_topic").isTextual()
                        || r.get("source_topic").asText().isEmpty())
                || r.has("sequence") && !(r.get("sequence").isIntegralNumber()
                        && r.get("sequence").canConvertToLong() && r.get("sequence").asLong() >= 0)
                || r.has("observed_at") && !zeit(r, "observed_at")) {
            return nein(Grund.SCHEMA_VERLETZT, "envelope fields");
        }
        if (u == Urheber.BOX) {
            if (!r.has("device_id") || !r.has("source_topic") || !r.has("sequence")
                    || !r.has("observed_at")) {
                return nein(Grund.SCHEMA_VERLETZT, "box event without its envelope");
            }
            String box = r.get("device_id").asText();
            String topic = "ems/" + r.get("tenant_id").asText() + "/" + r.get("site_id").asText()
                    + "/" + box + "/v2/events";
            if (!box.equals(r.get("ereignis").path("box").asText())
                    || !topic.equals(r.get("source_topic").asText())) {
                return nein(Grund.KENNUNG_ABWEICHEND, "box or topic");
            }
        }
        return null;
    }

    private static String[] nein(Grund g, String hinweis) {
        return new String[] {g.code(), hinweis};
    }

    private static boolean uuid(JsonNode r, String f) {
        return r.path(f).isTextual() && UUID_FORM.matcher(r.get(f).asText()).matches();
    }

    private static boolean zeit(JsonNode r, String f) {
        if (!r.path(f).isTextual() || !ZEIT_UTC.matcher(r.get(f).asText()).matches()) {
            return false;
        }
        try {
            Instant.parse(r.get(f).asText());
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    private void verworfen(JsonNode r, String grund, String hinweis) {
        log.warn("Dropping events.raw event {}: {} ({})",
                r == null ? "?" : r.path("event_id").asText("?"), grund, hinweis);
        zaehle("verworfen", grund);
    }

    private void zaehle(String ergebnis, String grund) {
        Counter.builder(METRIK)
                .description("events.raw records by outcome (appended, repeat, dropped + reason)")
                .tag("ergebnis", ergebnis)
                .tag("grund", grund)
                .register(meters)
                .increment();
    }
}
