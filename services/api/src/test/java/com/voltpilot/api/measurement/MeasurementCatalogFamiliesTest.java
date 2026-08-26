package com.voltpilot.api.measurement;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.InputStream;
import java.util.LinkedHashSet;
import java.util.Set;
import org.junit.jupiter.api.Test;

class MeasurementCatalogFamiliesTest {

    @Test
    void everyBuiltinBindingFamilyResolvesToCanonicalCatalogPoints() throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        MeasurementCatalog catalog = new MeasurementCatalog(mapper);
        Set<String> configured = new LinkedHashSet<>();
        try (InputStream in = getClass().getResourceAsStream("/componenttemplates/builtin.json")) {
            assertThat(in).isNotNull();
            for (var template : mapper.readTree(in).path("templates")) {
                String family = template.path("family").asText();
                if (!family.isBlank()) configured.add(family);
            }
        }

        assertThat(configured).containsExactlyInAnyOrder(
                "string", "hybrid_1p", "hybrid_3p", "micro",
                "sunspec", "sunspec_live", "fronius_solar_api",
                "kaco_http", "kaco_http_hybrid", "kostal_plenticore",
                "goe_http_api", "shelly_http");
        for (String family : configured) {
            assertThat(MeasurementCatalogFamilies.expand(Set.of(family), catalog.families()))
                    .as("builtin family %s must not fall through", family)
                    .isNotEmpty();
        }
        assertThat(MeasurementCatalogFamilies.expand(Set.of("sunspec_live"), catalog.families()))
                .hasSize(19).allMatch(f -> f.startsWith("sunspec.model_"));
    }
}
