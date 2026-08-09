package com.voltpilot.api.consumers;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Pure unit test of the {@link ConsumerPolicyValidator} against the CROSS-LANGUAGE
 * shared vectors (docs/contracts/v2/consumer-policy-vectors.json), the exact file
 * the TS twin ({@code frontend/portal/src/consumers/validate.test.ts}) runs - so
 * both validators produce the same verdict per case (the topology-vectors /
 * FlowGraphValidator / EdgeRef precedent). Also pins the contract example
 * fixtures (docs/contracts/v2/examples) as valid/invalid. Always runs (no Docker).
 */
class ConsumerPolicyValidatorTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    // Working dir is services/api; the repo root is two levels up.
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");

    private final ConsumerPolicyValidator validator =
            new ConsumerPolicyValidator(new ConsumerSignalCatalog());

    private static JsonNode read(Path p) throws IOException {
        return MAPPER.readTree(Files.readString(p));
    }

    private List<String> errorRules(JsonNode doc) {
        return validator.validate(doc).stream()
                .filter(ConsumerFinding::isError)
                .map(ConsumerFinding::rule)
                .toList();
    }

    @Test
    void sharedVectorsProduceTheExpectedVerdict() throws IOException {
        JsonNode vectors = read(V2.resolve("consumer-policy-vectors.json"));
        JsonNode cases = vectors.get("cases");
        assertThat(cases).isNotNull();
        assertThat(cases.size()).isGreaterThan(20);
        for (JsonNode c : cases) {
            String name = c.path("name").asText();
            List<String> rules = errorRules(c.get("document"));
            JsonNode expect = c.get("expect");
            if (expect.isTextual() && "valid".equals(expect.asText())) {
                assertThat(rules).as("case %s must be valid", name).isEmpty();
            } else {
                String rule = expect.path("rule").asText();
                assertThat(rules).as("case %s must trip %s", name, rule).contains(rule);
            }
        }
    }

    @Test
    void contractExampleFixturesValidateAsLabelled() throws IOException {
        Path examples = V2.resolve("examples");
        assertThat(errorRules(read(examples.resolve("consumer-policy.valid.heater.json")))).isEmpty();
        assertThat(errorRules(read(examples.resolve("consumer-policy.valid.wallbox-ranges.json"))))
                .isEmpty();
        assertThat(errorRules(read(examples.resolve("consumer-policy.valid.pump-flexible.json"))))
                .isEmpty();
        // The JSON-schema-level invalid fixture (percent 150) is caught semantically too.
        assertThat(errorRules(read(examples.resolve(
                "consumer-policy.invalid.percent-out-of-range.json"))))
                .contains("target_value_type");
    }

    @Test
    void controlProfileOnlyValidationSharesTheRuleCodes() throws IOException {
        JsonNode good = MAPPER.readTree(
                "{\"control_kind\":\"continuous\",\"rated_power_kw\":11,"
                        + "\"power_ranges_kw\":[[1.4,3.7],[4.2,11.0]]}");
        assertThat(validator.validateControlProfile(good)).isEmpty();
        JsonNode overlap = MAPPER.readTree(
                "{\"control_kind\":\"continuous\",\"rated_power_kw\":11,"
                        + "\"power_ranges_kw\":[[1.4,4.0],[3.5,11.0]]}");
        assertThat(validator.validateControlProfile(overlap).stream()
                .map(ConsumerFinding::rule)).contains("power_ranges_not_ascending");
    }
}
