package com.voltpilot.api.profile;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
 * Der Vertrag des Java-Zwillings: {@link AnwendungDerivation} trifft für JEDEN
 * Fall der EINEN geteilten Vektor-Datei
 * ({@code docs/contracts/v2/anwendung-vectors.json}) dieselben Urteile wie die
 * TS-Zwillinge ({@code frontend/portal/src/anwendungen.test.ts} fährt sie
 * ebenfalls, und dort zusätzlich {@code surface.ts activeModes}).
 *
 * <p>Rein; läuft immer (kein Docker, keine DB, keine Uhr).
 */
class AnwendungDerivationTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt zwei
    // Ebenen darüber.
    private static final Path VECTORS =
            Path.of("..", "..", "docs", "contracts", "v2", "anwendung-vectors.json");

    private static JsonNode vectors() throws Exception {
        return MAPPER.readTree(Files.readString(VECTORS));
    }

    private static AnwendungDerivation.Input input(JsonNode in) {
        Set<String> nodeTypes = new LinkedHashSet<>();
        for (JsonNode n : in.path("active_node_types")) {
            nodeTypes.add(n.asText());
        }
        return new AnwendungDerivation.Input(in.path("has_storage").asBoolean(),
                in.path("has_pv").asBoolean(), in.path("has_controllable_consumer").asBoolean(),
                in.path("has_charge_point").asBoolean(), in.path("has_measurement").asBoolean(),
                in.path("has_leistungspreis").asBoolean(), in.path("has_grid_limit").asBoolean(),
                nodeTypes, in.path("has_customer_rule").asBoolean(),
                in.path("plant_kind").asText(null), in.path("tarif_art").asText(null),
                in.path("netzladen_erlaubt").asBoolean());
    }

    @TestFactory
    List<DynamicTest> derivationMatchesSharedVectors() throws Exception {
        JsonNode root = vectors();
        List<String> ids = new ArrayList<>();
        for (JsonNode n : root.path("anwendungen")) {
            ids.add(n.asText());
        }
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : root.path("derivation")) {
            String name = c.path("name").asText();
            AnwendungDerivation.Input in = input(c.path("input"));
            List<String> expected = new ArrayList<>();
            for (JsonNode n : c.path("expected_derived_active")) {
                expected.add(n.asText());
            }
            tests.add(DynamicTest.dynamicTest("derivedActive · " + name,
                    () -> assertThat(AnwendungDerivation.derivedActive(ids, in))
                            .containsExactlyElementsOf(expected)));
        }
        assertThat(tests).isNotEmpty();
        return tests;
    }

    @TestFactory
    List<DynamicTest> requirementsMatchSharedVectors() throws Exception {
        JsonNode root = vectors();
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : root.path("derivation")) {
            String name = c.path("name").asText();
            AnwendungDerivation.Input in = input(c.path("input"));
            JsonNode expected = c.path("expected_requirements");
            tests.add(DynamicTest.dynamicTest("requirementMet · " + name, () -> {
                expected.fieldNames().forEachRemaining(id -> assertThat(
                        AnwendungDerivation.requirementMet(id, in))
                                .as(name + " · " + id).isEqualTo(expected.path(id).asBoolean()));
                // Ein UNBEKANNTER Name gilt als NICHT erfüllt - eine
                // Voraussetzung, die niemand prüfen kann, darf nie ein Häkchen
                // bekommen.
                assertThat(AnwendungDerivation.requirementMet("gibt-es-nicht", in)).isFalse();
                assertThat(AnwendungDerivation.requirementMet(null, in)).isFalse();
            }));
        }
        return tests;
    }

    @Test
    void theVectorFileCoversEveryCatalogEntryAndRequirement() throws Exception {
        JsonNode root = vectors();
        AnwendungKatalog katalog = new AnwendungKatalog(MAPPER);

        List<String> vectorIds = new ArrayList<>();
        for (JsonNode n : root.path("anwendungen")) {
            vectorIds.add(n.asText());
        }
        assertThat(vectorIds)
                .as("die Vektoren nennen jeden Katalog-Eintrag in kanonischer Reihenfolge")
                .containsExactlyElementsOf(katalog.alle().stream()
                        .map(AnwendungKatalog.Anwendung::id).toList());

        Set<String> vectorReqs = new LinkedHashSet<>();
        for (JsonNode n : root.path("requirement_ids")) {
            vectorReqs.add(n.asText());
        }
        for (AnwendungKatalog.Anwendung a : katalog.alle()) {
            for (AnwendungKatalog.Voraussetzung v : a.voraussetzungen()) {
                assertThat(vectorReqs).as("Voraussetzung " + v.id() + " ist gepinnt")
                        .contains(v.id());
            }
        }
    }

    @Test
    void anUnknownApplicationIsNeverDerivedActive() throws Exception {
        AnwendungDerivation.Input in = input(vectors().path("derivation").get(0).path("input"));
        assertThat(AnwendungDerivation.derivedActive("gibt-es-nicht", in)).isFalse();
        assertThat(AnwendungDerivation.derivedActive((String) null, in)).isFalse();
    }

    @Test
    void marketAccessIsATariffOrDirektvermarktung() {
        AnwendungDerivation.Input dv = new AnwendungDerivation.Input(true, true, false, false, true,
                false, false, Set.of(), false, "direktvermarktung", "fest", false);
        AnwendungDerivation.Input dyn = new AnwendungDerivation.Input(true, true, false, false, true,
                false, false, Set.of(), false, "eigenverbrauch", "dynamisch", false);
        AnwendungDerivation.Input none = new AnwendungDerivation.Input(true, true, false, false,
                true, false, false, Set.of(), false, "eigenverbrauch", "fest", false);
        assertThat(dv.hasMarketAccess()).isTrue();
        assertThat(dyn.hasMarketAccess()).isTrue();
        assertThat(none.hasMarketAccess()).isFalse();
    }
}
