package com.voltpilot.api.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.uems.ZaehlerwechselMarke;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/** Reiner Abgleich von OpenAPI, gespeichertem Ereignisvokabular und Zählerwechsel-Marke. */
class ComponentEventsContractTest {
    private static final String ROUTE = "/api/v1/sites/{siteId}/components/{entityId}/events";
    private static final List<String> ARTEN = List.of("edited", "family_changed", "rolled_back",
            ZaehlerwechselMarke.ART);

    @Test
    void openApiDecktDasGesamteGespeicherteVokabularAb() throws Exception {
        Map<String, Object> api;
        try (var in = Files.newInputStream(Path.of("../../docs/contracts/openapi.yaml"))) {
            api = new Yaml().load(in);
        }
        Map<String, Object> schema = map(map(map(api, "components"), "schemas"), "ComponentChangeEvent");
        assertThat((List<?>) map(map(schema, "properties"), "eventType").get("enum"))
                .isEqualTo(ARTEN);
        Map<String, Object> antwort = map(map(map(map(map(api, "paths"), ROUTE), "get"), "responses"), "200");
        assertThat(map(map(map(map(antwort, "content"), "application/json"), "schema"), "items"))
                .containsEntry("$ref", "#/components/schemas/ComponentChangeEvent");
        String migration = Files.readString(Path.of(
                "src/main/resources/db/migration/V20260912120000__uems_zaehlerwechsel.sql"));
        var check = Pattern.compile("CHECK \\(event_type IN \\(([^)]+)\\)\\)").matcher(migration);
        assertThat(check.find()).isTrue();
        List<String> gespeichert = Pattern.compile("'([^']+)'").matcher(check.group(1))
                .results().map(m -> m.group(1)).toList();
        assertThat(gespeichert).containsExactlyElementsOf(ARTEN);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Map<String, Object> parent, String key) {
        return (Map<String, Object>) parent.get(key);
    }
}
