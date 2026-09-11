package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * Schema proof of {@code measurement-samples} 2.0 and 2.1 (UEMS AP-07 IP-2, W4: contracts are
 * additive) - always runs (no Docker):
 *
 * <ul>
 *   <li>every fixture in {@code docs/contracts/v2/examples/} validates against ITS schema exactly
 *       as its name labels it (the E0 fixture discipline), and the runtime
 *       {@link MeasurementSamplesValidator} agrees on every one of them (valid = every sample
 *       forwarded, nothing refused; invalid = the envelope or a sample refused);
 *   <li>2.1 is 2.0 plus exactly {@code applied_revision} (envelope) and {@code entity_id}
 *       (sample) - nothing else changed, so a 2.0 box stays valid and the two files cannot drift;
 *   <li>the validator's field sets are the schemas' property names.
 * </ul>
 */
class MeasurementSamplesContractSchemaTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path V2 = Path.of("../../docs/contracts/v2");
    private static final Path EXAMPLES = V2.resolve("examples");
    private static final String SCHEMA_2_0 = "mqtt-measurement-samples.schema.json";
    private static final String SCHEMA_2_1 = "mqtt-measurement-samples-2.1.schema.json";

    private final MeasurementSamplesValidator validator = new MeasurementSamplesValidator(MAPPER, Messzeitregel.E13);

    private static JsonNode read(Path p) throws Exception {
        return MAPPER.readTree(Files.readString(p));
    }

    private void assertFixturesValidateAsLabelled(String prefix, String schemaFile) throws Exception {
        JsonNode schema = read(V2.resolve(schemaFile));
        List<Path> files;
        try (Stream<Path> all = Files.list(EXAMPLES)) {
            files = all.filter(p -> p.getFileName().toString().startsWith(prefix)).sorted().toList();
        }
        assertThat(files.stream().filter(p -> p.getFileName().toString().contains(".valid.")).count())
                .as(prefix + " valid fixtures").isGreaterThanOrEqualTo(2);
        assertThat(files.stream().filter(p -> p.getFileName().toString().contains(".invalid.")).count())
                .as(prefix + " invalid fixtures").isGreaterThanOrEqualTo(1);
        for (Path p : files) {
            boolean expected = p.getFileName().toString().contains(".valid.");
            JsonNode payload = read(p);
            List<String> v = ContractSchemaRunner.violations(payload, schema);
            assertThat(v.isEmpty()).as(p.getFileName() + " " + v).isEqualTo(expected);
            String topic = "ems/" + payload.path("tenant_id").asText() + "/" + payload.path("site_id").asText()
                    + "/" + payload.path("device_id").asText() + "/v2/measurement-samples";
            // The fixtures are about form, not time: each arrives 7 s after its own observed_at.
            Instant eingang = Instant.parse(payload.path("observed_at").asText()).plusSeconds(7);
            boolean accepted;
            try {
                var annahme = validator.annehmen(topic, Files.readString(p), eingang);
                accepted = annahme.ablehnungen().isEmpty() && annahme.weiter() != null;
            } catch (UmschlagAbgewiesen e) {
                accepted = false;
            }
            assertThat(accepted).as("ingest on " + p.getFileName()).isEqualTo(expected);
        }
    }

    @Test
    void fixtures20ValidateAsLabelled() throws Exception {
        assertFixturesValidateAsLabelled("mqtt-measurement-samples.", SCHEMA_2_0);
    }

    @Test
    void fixtures21ValidateAsLabelled() throws Exception {
        assertFixturesValidateAsLabelled("mqtt-measurement-samples-2.1.", SCHEMA_2_1);
    }

    /** 2.1 minus its two provenance fields IS 2.0: same topic, same rules, same everything else. */
    @Test
    void version21IsVersion20PlusExactlyTheTwoProvenanceFields() throws Exception {
        JsonNode v20 = read(V2.resolve(SCHEMA_2_0));
        ObjectNode v21 = (ObjectNode) read(V2.resolve(SCHEMA_2_1));
        assertThat(v20.path("properties").path("schema_version").path("const").asText()).isEqualTo("2.0");
        assertThat(v21.path("properties").path("schema_version").path("const").asText()).isEqualTo("2.1");
        assertThat(v21.path("properties").path("applied_revision").path("type").asText()).isEqualTo("integer");
        assertThat(v21.path("properties").path("applied_revision").path("minimum").asInt()).isZero();
        assertThat(v21.path("$defs").path("sample").path("properties").path("entity_id").path("format").asText())
                .isEqualTo("uuid");
        for (String field : List.of("x-topic", "x-mqtt", "x-identity-rule", "x-honesty-rule", "required",
                "additionalProperties", "type")) {
            assertThat(v21.get(field)).as(field).isEqualTo(v20.get(field));
        }
        ObjectNode props = (ObjectNode) v21.get("properties").deepCopy();
        props.remove("applied_revision");
        props.set("schema_version", v20.path("properties").path("schema_version"));
        assertThat(props).isEqualTo(v20.get("properties"));
        ObjectNode defs = (ObjectNode) v21.get("$defs").deepCopy();
        ((ObjectNode) defs.path("sample").path("properties")).remove("entity_id");
        assertThat(defs).isEqualTo(v20.get("$defs"));
    }

    /** The runtime validator and the schemas name the same fields - the Java/schema twin. */
    @Test
    void validatorFieldSetsAreTheSchemaProperties() throws Exception {
        JsonNode v20 = read(V2.resolve(SCHEMA_2_0));
        JsonNode v21 = read(V2.resolve(SCHEMA_2_1));
        assertThat(MeasurementSamplesValidator.ROOT_FIELDS_2_0).isEqualTo(names(v20.path("properties")));
        assertThat(MeasurementSamplesValidator.ROOT_FIELDS_2_1).isEqualTo(names(v21.path("properties")));
        assertThat(MeasurementSamplesValidator.SAMPLE_FIELDS_2_0)
                .isEqualTo(names(v20.path("$defs").path("sample").path("properties")));
        assertThat(MeasurementSamplesValidator.SAMPLE_FIELDS_2_1)
                .isEqualTo(names(v21.path("$defs").path("sample").path("properties")));
    }

    private static Set<String> names(JsonNode object) {
        Set<String> names = new HashSet<>();
        object.fieldNames().forEachRemaining(names::add);
        return names;
    }
}
