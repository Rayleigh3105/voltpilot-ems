package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * Schema proof of the v2 EVENT contract on the ingest side (UEMS AP-07 IP-3, decision E11) -
 * always runs (no Docker). It pins the contract files Ingest accepts and emits since IP-5
 * (runtime: {@link BoxEventsValidator}, {@link EventsRawEvent}; their proofs
 * {@code BoxEventsValidatorTest} and {@code DatenannahmeTest} run the same fixtures and vector
 * cases through the code):
 *
 * <ul>
 *   <li>the box envelope {@code mqtt-events-2.1.schema.json} against its fixtures in
 *       {@code docs/contracts/v2/examples/} (the E0 fixture discipline) AND against every
 *       envelope case of {@code events-vocabulary-vectors.json}, exactly as the case labels it;
 *   <li>the Redpanda event {@code events.raw} ({@code events-raw.event.schema.json}) - which
 *       Ingest produces from box envelopes and the cloud services from their own events -
 *       against its fixtures;
 *   <li>the transport facts IP-5 honours: topic leaf {@code v2/events}, QoS 1, not retained,
 *       the topic identity rule, schema_version 2.1, at most 64 events per envelope, and the
 *       Kafka topic/key of {@code events.raw}.
 * </ul>
 *
 * <p>The semantic rules JSON Schema cannot express (topic identity, open intervals, count from
 * sequences …) are pinned by {@code services/api .../uems/EreignisVokabularVectorsTest} against
 * the same vector file.
 */
class EventsContractSchemaTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path V2 = Path.of("../../docs/contracts/v2");
    private static final Path EXAMPLES = V2.resolve("examples");

    private static JsonNode read(Path p) throws Exception {
        return MAPPER.readTree(Files.readString(p));
    }

    private static List<Path> fixtures(String prefix) throws Exception {
        try (Stream<Path> files = Files.list(EXAMPLES)) {
            return files.filter(p -> p.getFileName().toString().startsWith(prefix)).sorted().toList();
        }
    }

    private static void assertFixturesValidateAsLabelled(String prefix, JsonNode schema) throws Exception {
        List<Path> files = fixtures(prefix);
        long valid = files.stream().filter(p -> p.getFileName().toString().contains(".valid.")).count();
        long invalid = files.stream().filter(p -> p.getFileName().toString().contains(".invalid.")).count();
        assertThat(valid).as(prefix + " valid fixtures").isGreaterThanOrEqualTo(2);
        assertThat(invalid).as(prefix + " invalid fixtures").isGreaterThanOrEqualTo(1);
        for (Path p : files) {
            boolean expected = p.getFileName().toString().contains(".valid.");
            List<String> v = ContractSchemaRunner.violations(read(p), schema);
            assertThat(v.isEmpty()).as(p.getFileName() + " " + v).isEqualTo(expected);
        }
    }

    @Test
    void boxEnvelopeFixturesValidateAsLabelled() throws Exception {
        assertFixturesValidateAsLabelled("mqtt-events-2.1.", read(V2.resolve("mqtt-events-2.1.schema.json")));
    }

    @Test
    void eventsRawFixturesValidateAsLabelled() throws Exception {
        assertFixturesValidateAsLabelled("events-raw.", read(V2.resolve("events-raw.event.schema.json")));
    }

    /** Every envelope case of the vocabulary vectors: schema-valid exactly when the case says so. */
    @Test
    void everyEnvelopeCaseOfTheVocabularyValidatesAsLabelled() throws Exception {
        JsonNode schema = read(V2.resolve("mqtt-events-2.1.schema.json"));
        List<String> mismatches = new ArrayList<>();
        int seen = 0;
        for (JsonNode c : read(V2.resolve("events-vocabulary-vectors.json")).path("cases")) {
            if (!"umschlag".equals(c.path("pruefung").asText())) {
                continue;
            }
            seen++;
            List<String> v = ContractSchemaRunner.violations(c.path("input").path("umschlag"), schema);
            if (v.isEmpty() != c.path("expected").path("schema").asBoolean()) {
                mismatches.add(c.path("name").asText() + " " + v);
            }
        }
        assertThat(seen).as("envelope cases").isGreaterThanOrEqualTo(5);
        assertThat(mismatches).isEmpty();
    }

    /** The valid fixtures follow the identity rule: the topic segments ARE the payload identity. */
    @Test
    void validEnvelopesCarryTheTopicIdentityAndAreBoundedToSixtyFourEvents() throws Exception {
        JsonNode schema = read(V2.resolve("mqtt-events-2.1.schema.json"));
        assertThat(schema.path("x-topic").asText()).startsWith("ems/{tenant_id}/{site_id}/{device_id}/v2/events");
        assertThat(schema.path("x-mqtt").path("qos").asInt()).isEqualTo(1);
        assertThat(schema.path("x-mqtt").path("retained").asBoolean(true)).isFalse();
        assertThat(schema.path("properties").path("schema_version").path("const").asText()).isEqualTo("2.1");
        assertThat(schema.path("properties").path("events").path("maxItems").asInt()).isEqualTo(64);
        for (Path p : fixtures("mqtt-events-2.1.valid.")) {
            JsonNode u = read(p);
            assertThat(u.path("events").size()).as(p.getFileName().toString()).isBetween(1, 64);
            for (String id : List.of("tenant_id", "site_id", "device_id")) {
                assertThat(u.path(id).asText()).as(p.getFileName() + " " + id)
                        .matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
            }
            u.path("events").forEach(e -> assertThat(e.has("box"))
                    .as("the box comes from the topic, never from the payload").isFalse());
        }
        // A 65th event is refused by the schema (the one keyword the api-side runner leaves out).
        JsonNode big = read(fixtures("mqtt-events-2.1.valid.").get(0)).deepCopy();
        JsonNode first = big.path("events").get(0);
        ArrayNode events = MAPPER.createArrayNode();
        for (int i = 0; i < 65; i++) {
            events.add(first.deepCopy());
        }
        ((ObjectNode) big).set("events", events);
        assertThat(ContractSchemaRunner.violations(big, schema)).isNotEmpty();
    }

    /** The events.raw record: Kafka topic and key IP-5 publishes with, and the box path's envelope facts. */
    @Test
    void eventsRawIsKeyedPerSiteAndTheBoxPathCarriesItsEnvelope() throws Exception {
        JsonNode schema = read(V2.resolve("events-raw.event.schema.json"));
        assertThat(schema.path("x-kafka").path("topic").asText()).isEqualTo("events.raw");
        assertThat(schema.path("x-kafka").path("key").asText()).isEqualTo("{tenant_id}:{site_id}");
        JsonNode box = read(EXAMPLES.resolve("events-raw.valid.box-range-limit.json"));
        assertThat(box.path("source_topic").asText()).isEqualTo("ems/" + box.path("tenant_id").asText() + "/"
                + box.path("site_id").asText() + "/" + box.path("device_id").asText() + "/v2/events");
        assertThat(box.path("ereignis").path("box").asText()).isEqualTo(box.path("device_id").asText());
    }
}
