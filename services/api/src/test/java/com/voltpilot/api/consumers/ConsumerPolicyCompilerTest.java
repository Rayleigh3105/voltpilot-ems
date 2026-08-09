package com.voltpilot.api.consumers;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.consumers.ConsumerRepository.ConsumerRow;
import java.io.IOException;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * The pure edge half of the policy compiler (D-19, §13.2) - runs without
 * Docker. The GOLDEN-ARTIFACT rule is pinned here on the Java side: the same
 * policy + the same window answers + the same `now` produce a BYTE-IDENTICAL
 * generated flow-graph document, compared against the COMMITTED golden file
 * (never self-seeded). flowc's own determinism (document -> content_hash) is
 * pinned separately by its committed fixture hashes, so the two pins together
 * cover the whole chain policy -> document -> artifact hash.
 */
class ConsumerPolicyCompilerTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final UUID ENTITY = UUID.fromString("6f1d2c3b-4a59-4687-9abc-def012345678");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID POLICY = UUID.fromString("b58a3c21-7e90-4d12-a345-6789abcdef02");
    private static final Instant NOW = Instant.parse("2026-08-10T09:00:00Z");

    private final ConsumerPolicyCompiler compiler =
            new ConsumerPolicyCompiler(new ConsumerSignalCatalog(), MAPPER);

    /** A fixed window oracle: cheap-price windows for every cloud leaf. */
    private static final ConsumerPolicyCompiler.WindowSource WINDOWS =
            (siteId, signal, op, value, from, to) -> List.of(
                    new ConsumerPolicyCompiler.Window(Instant.parse("2026-08-10T10:00:00Z"),
                            Instant.parse("2026-08-10T14:15:00Z")),
                    new ConsumerPolicyCompiler.Window(Instant.parse("2026-08-11T09:30:00Z"),
                            Instant.parse("2026-08-11T13:00:00Z")));

    private static ConsumerRow wallbox() {
        return new ConsumerRow(ENTITY, "wallbox", "Wallbox Garage", null, "edge-src-1",
                "continuous", new BigDecimal("11.0"), new BigDecimal("1.4"), null,
                new BigDecimal("0.1"), null, "consumer_first", "allow", false, null,
                null, null, null, null, null, "off", true, 1);
    }

    private JsonNode policy() throws IOException {
        return MAPPER.readTree("""
                {
                  "schema_version": "1.0",
                  "entity_id": "%s",
                  "timezone": "Europe/Berlin",
                  "requirements": [
                    {
                      "id": "charge-when-connected",
                      "kind": "reactive",
                      "enforcement": "must_run",
                      "condition": {
                        "signal": "consumer.vehicle_connected",
                        "operator": "eq", "value": true, "max_age_s": 20
                      },
                      "target": { "kind": "percent", "value": 100 }
                    },
                    {
                      "id": "cheap-or-full",
                      "kind": "reactive",
                      "enforcement": "opportunistic",
                      "condition": {
                        "any": [
                          { "signal": "market.spot_price_ct_kwh", "operator": "lt", "value": 5 },
                          { "signal": "storage.soc_pct", "operator": "gt", "value": 80,
                            "reset_value": 75, "max_age_s": 120 }
                        ]
                      },
                      "target": { "kind": "kw", "value": 4.2 }
                    }
                  ]
                }
                """.formatted(ENTITY));
    }

    @Test
    void samePolicyCompilesToTheCommittedGoldenDocumentByteForByte() throws IOException {
        ObjectNode a = compiler.compile(policy(), wallbox(), SITE, TENANT, POLICY, 3, WINDOWS, NOW);
        ObjectNode b = compiler.compile(policy(), wallbox(), SITE, TENANT, POLICY, 3, WINDOWS, NOW);
        assertThat(a.toString()).isEqualTo(b.toString());

        Path golden = Path.of("src", "test", "resources", "consumers",
                "golden-generated-flow.json");
        assertThat(golden).as("golden file must be COMMITTED, never self-seeded").exists();
        // String comparison (not JsonNode.equals): Jackson reads the golden's
        // numbers as DoubleNode while the compiler builds DecimalNode - the
        // BYTES are what the golden rule pins.
        JsonNode expected = MAPPER.readTree(Files.readString(golden));
        assertThat(a.toString()).isEqualTo(expected.toString());
    }

    @Test
    void theGeneratedDocumentCarriesTheD19Shape() throws IOException {
        ObjectNode doc = compiler.compile(policy(), wallbox(), SITE, TENANT, POLICY, 3,
                WINDOWS, NOW);
        assertThat(doc.path("origin").path("kind").asText()).isEqualTo("consumer-policy");
        assertThat(doc.path("flow_id").asText())
                .isEqualTo(ConsumerPolicyCompiler.generatedFlowId(ENTITY).toString());
        assertThat(doc.path("flow_version").asInt()).isEqualTo(3);
        // ONE node, ONE claim (V-5 stays intact).
        assertThat(doc.path("nodes")).hasSize(1);
        JsonNode node = doc.path("nodes").get(0);
        assertThat(node.path("type").asText()).isEqualTo("vp.consumer.reactive");
        assertThat(node.path("claims")).hasSize(1);
        assertThat(node.path("claims").get(0).path("entity_id").asText())
                .isEqualTo(ENTITY.toString());

        JsonNode reqs = node.path("parameters").path("requirements");
        assertThat(reqs).hasSize(2);
        // must_run comes EXCLUSIVELY from enforcement (the override rule §13.2).
        assertThat(reqs.get(0).path("must_run").asBoolean()).isTrue();
        assertThat(reqs.get(1).path("must_run").asBoolean()).isFalse();
        // percent target -> kW of the rated power (E8).
        assertThat(reqs.get(0).path("value").asDouble()).isEqualTo(11.0);
        // The cloud leaf became precomputed UTC windows (D1)...
        JsonNode mixed = reqs.get(1).path("condition").path("any");
        assertThat(mixed.get(0).has("windows")).isTrue();
        assertThat(mixed.get(0).path("windows").get(0).get(0).asText())
                .isEqualTo("2026-08-10T10:00:00Z");
        // ...and the local leaf kept hysteresis + freshness.
        assertThat(mixed.get(1).path("reset_value").asDouble()).isEqualTo(75.0);
        assertThat(mixed.get(1).path("max_age_s").asInt()).isEqualTo(120);
        // The TTL renewal chain: renew <= ttl/2, trigger = renew cadence.
        JsonNode params = node.path("parameters");
        assertThat(params.path("renew_s").asInt() * 2)
                .isLessThanOrEqualTo(params.path("ttl_s").asInt());
        assertThat(doc.path("triggers").get(0).path("every_s").asInt())
                .isEqualTo(params.path("renew_s").asInt());
    }

    @Test
    void pureCloudReactiveAndNonReactivePoliciesCompileToNoArtifact() throws IOException {
        // D1 split: a PURE price condition is entirely the market plan's job.
        JsonNode pureCloud = MAPPER.readTree("""
                {
                  "schema_version": "1.0", "entity_id": "%s", "timezone": "Europe/Berlin",
                  "requirements": [
                    { "id": "cheap", "kind": "reactive", "enforcement": "opportunistic",
                      "condition": { "signal": "market.spot_price_ct_kwh", "operator": "lt", "value": 5 },
                      "target": { "kind": "on_off", "value": true } }
                  ]
                }
                """.formatted(ENTITY));
        assertThat(compiler.compile(pureCloud, wallbox(), SITE, TENANT, POLICY, 1, WINDOWS, NOW))
                .isNull();
        assertThat(compiler.needsArtifact(pureCloud)).isFalse();

        JsonNode fixedWindow = MAPPER.readTree("""
                {
                  "schema_version": "1.0", "entity_id": "%s", "timezone": "Europe/Berlin",
                  "requirements": [
                    { "id": "noon", "kind": "fixed_window", "enforcement": "must_run",
                      "recurrence": { "days": "daily", "from": "13:00", "to": "14:00" },
                      "target": { "kind": "on_off", "value": true } }
                  ]
                }
                """.formatted(ENTITY));
        assertThat(compiler.compile(fixedWindow, wallbox(), SITE, TENANT, POLICY, 1, WINDOWS, NOW))
                .isNull();
    }

    @Test
    void anEmptyWindowAnswerBecomesAnExpiredSentinelNeverAGuess() throws IOException {
        ConsumerPolicyCompiler.WindowSource none =
                (siteId, signal, op, value, from, to) -> List.of();
        JsonNode mixedPolicy = MAPPER.readTree("""
                {
                  "schema_version": "1.0", "entity_id": "%s", "timezone": "Europe/Berlin",
                  "requirements": [
                    { "id": "mixed", "kind": "reactive", "enforcement": "must_run",
                      "condition": { "all": [
                        { "signal": "market.spot_price_ct_kwh", "operator": "lt", "value": 5 },
                        { "signal": "consumer.vehicle_connected", "operator": "eq", "value": true,
                          "max_age_s": 20 }
                      ] },
                      "target": { "kind": "on_off", "value": true } }
                  ]
                }
                """.formatted(ENTITY));
        ObjectNode doc = compiler.compile(mixedPolicy, wallbox(), SITE, TENANT, POLICY, 1,
                none, NOW);
        JsonNode windows = doc.path("nodes").get(0).path("parameters").path("requirements")
                .get(0).path("condition").path("all").get(0).path("windows");
        assertThat(windows).hasSize(1);
        // Sentinel strictly in the past: the edge reads `unknown` and never starts.
        assertThat(Instant.parse(windows.get(0).get(1).asText())).isBefore(NOW);
    }
}
