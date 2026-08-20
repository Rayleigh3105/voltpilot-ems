package com.voltpilot.api.profile;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.profile.UsageProfileDeriver.Emphasis;
import com.voltpilot.api.profile.UsageProfileDeriver.Signals;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * The Java twin's contract: {@link UsageProfileDeriver} matches the committed
 * expectations for every case in the ONE shared vector file
 * (docs/contracts/v2/usage-profile-vectors.json), the same file the TS twin
 * (frontend/portal/src/usageProfile.test.ts) runs. Pure; always runs (no Docker).
 */
class UsageProfileDeriverTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    // Working dir is services/api; the repo root is two levels up.
    private static final Path VECTORS =
            Path.of("..", "..", "docs", "contracts", "v2", "usage-profile-vectors.json");

    @TestFactory
    List<DynamicTest> deriveMatchesSharedVectors() throws Exception {
        JsonNode root = MAPPER.readTree(Files.readString(VECTORS));
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : root.path("derivation")) {
            String name = c.path("name").asText();
            Signals signals = signals(c.path("signals"));
            String expectedDerived = c.path("expected_derived").asText();
            String expectedProfile = c.path("expected_profile").asText();
            tests.add(DynamicTest.dynamicTest(name, () -> {
                assertThat(UsageProfileDeriver.deriveDefault(signals))
                        .as("derived default of " + name).isEqualTo(expectedDerived);
                assertThat(UsageProfileDeriver.effectiveProfile(signals))
                        .as("effective profile of " + name).isEqualTo(expectedProfile);
            }));
        }
        assertThat(tests).isNotEmpty();
        return tests;
    }

    @TestFactory
    List<DynamicTest> emphasisMatchesSharedVectors() throws Exception {
        JsonNode root = MAPPER.readTree(Files.readString(VECTORS));
        JsonNode emphasis = root.path("emphasis");
        List<DynamicTest> tests = new ArrayList<>();
        for (String profile : List.of("arbitrage", "peak", "private")) {
            JsonNode expected = emphasis.path(profile);
            tests.add(DynamicTest.dynamicTest(profile, () -> {
                Emphasis e = UsageProfileDeriver.emphasisFor(profile);
                assertThat(e.money()).isEqualTo(expected.path("money").asText());
                assertThat(e.peak()).isEqualTo(expected.path("peak").asText());
                assertThat(e.flow()).isEqualTo(expected.path("flow").asText());
                assertThat(e.devices()).isEqualTo(expected.path("devices").asText());
            }));
        }
        return tests;
    }

    @Test
    void unknownProfileFallsBackToPrivateEmphasis() {
        Emphasis e = UsageProfileDeriver.emphasisFor("bogus");
        assertThat(e.money()).isEqualTo("minimal");
        assertThat(e.flow()).isEqualTo("prominent");
    }

    @Test
    void isProfileGuardsTheSettableVocabulary() {
        assertThat(UsageProfileDeriver.isProfile("arbitrage")).isTrue();
        assertThat(UsageProfileDeriver.isProfile("peak")).isTrue();
        // private und laden sind ABGELEITET, nie wählbar (report §3.3 bzw.
        // Lastmanagement Stufe 3).
        assertThat(UsageProfileDeriver.isProfile("private")).isFalse();
        assertThat(UsageProfileDeriver.isProfile("laden")).isFalse();
        assertThat(UsageProfileDeriver.isProfile("grey")).isFalse();
        assertThat(UsageProfileDeriver.isProfile(null)).isFalse();
    }

    private static Signals signals(JsonNode s) {
        Set<String> nodes = new LinkedHashSet<>();
        for (JsonNode n : s.path("active_strategy_node_types")) {
            nodes.add(n.asText());
        }
        String plantKind = s.path("plant_kind").isNull() ? null : s.path("plant_kind").asText(null);
        String override = s.path("override").isNull() ? null : s.path("override").asText(null);
        return new Signals(s.path("has_storage").asBoolean(), s.path("has_pv").asBoolean(),
                s.path("has_controllable_consumer").asBoolean(),
                s.path("has_charge_point").asBoolean(), nodes, plantKind,
                s.path("has_leistungspreis").asBoolean(), override);
    }
}
