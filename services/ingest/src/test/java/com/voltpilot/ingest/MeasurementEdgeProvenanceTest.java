package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Real Node-RED runtime -> Go Outbox/restart -> in-process current Ingest. No containers. */
class MeasurementEdgeProvenanceTest {
    private static final Path ROOT = Path.of("../..").toAbsolutePath().normalize();
    private static final Path V2 = ROOT.resolve("docs/contracts/v2");
    private static final ObjectMapper MAPPER = new ObjectMapper();
    @TempDir Path temporary;

    @Test
    void newBoxAndPreUpdateReplayAreAcceptedByCurrentCloud() throws Exception {
        Path local = temporary.resolve("local.json");
        run(ROOT, local, "node", "edge-app/nodered/measurements/testdata/provenance-simulator.js");
        Path replay = temporary.resolve("replay.json");
        Path old20 = V2.resolve("examples/mqtt-measurement-samples.valid.json");
        Path old21 = V2.resolve("examples/mqtt-measurement-samples-2.1.valid.ohne-herkunftsfelder.json");
        run(ROOT.resolve("edge-app/core"), replay, "go", "run",
                "./internal/measurements/testdata/provenance-replay", local.toString(),
                old20.toString(), old21.toString());
        JsonNode envelopes = MAPPER.readTree(Files.readString(replay));
        assertThat(envelopes.size()).isEqualTo(4);
        assertThat(envelopes.get(0)).isEqualTo(MAPPER.readTree(Files.readString(old20)));
        assertThat(envelopes.get(1)).isEqualTo(MAPPER.readTree(Files.readString(old21)));
        assertThat(envelopes.get(2).path("schema_version").asText()).isEqualTo("2.1");
        assertThat(envelopes.get(2).path("applied_revision").asLong()).isEqualTo(7);
        assertThat(envelopes.get(2).path("samples").get(0).path("entity_id").asText())
                .isEqualTo("00000000-0000-0000-0000-0000000000a1");
        assertThat(envelopes.get(2).path("samples").get(0).path("raw").asInt()).isEqualTo(50);
        assertThat(envelopes.get(2).path("samples").get(0).path("decoded").asInt()).isEqualTo(50);
        assertThat(envelopes.get(3).path("applied_revision").asLong()).isEqualTo(7);
        assertThat(envelopes.get(3).path("samples").get(0).has("entity_id")).isFalse();

        var validator = new MeasurementSamplesValidator(MAPPER, Messzeitregel.E13);
        for (JsonNode envelope : envelopes) {
            String schema = envelope.path("schema_version").asText().equals("2.0")
                    ? "mqtt-measurement-samples.schema.json" : "mqtt-measurement-samples-2.1.schema.json";
            assertThat(ContractSchemaRunner.violations(envelope, MAPPER.readTree(Files.readString(V2.resolve(schema)))))
                    .as(envelope.toString()).isEmpty();
            String topic = "ems/" + envelope.path("tenant_id").asText() + "/"
                    + envelope.path("site_id").asText() + "/" + envelope.path("device_id").asText()
                    + "/v2/measurement-samples";
            var accepted = validator.annehmen(topic, envelope.toString(),
                    Instant.parse(envelope.path("observed_at").asText()).plusSeconds(10));
            assertThat(accepted.ablehnungen()).isEmpty();
            assertThat(accepted.weiter().samples()).hasSize(envelope.path("samples").size());
        }
    }

    private void run(Path cwd, Path output, String... command) throws Exception {
        Path errors = temporary.resolve(output.getFileName() + ".stderr");
        Process process = new ProcessBuilder(command).directory(cwd.toFile())
                .redirectOutput(output.toFile()).redirectError(errors.toFile()).start();
        try {
            assertThat(process.waitFor(60, TimeUnit.SECONDS)).as("test bridge completed").isTrue();
            assertThat(process.exitValue()).as(Files.readString(errors)).isZero();
        } finally {
            if (process.isAlive()) process.destroyForcibly();
        }
    }
}
