package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.EnergiemanagementMappeController;
import com.voltpilot.api.web.dto.EnergiemanagementMappeDto;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.yaml.snakeyaml.Yaml;

/**
 * Konzept Nachweisen n1, Entscheid 7: Routen, DTOs, die Vokabulare {@code mappe_anlass}, {@code verzeichnis_gruppe} und
 * {@code teil} und der veröffentlichte Vertrag ({@code openapi.yaml}) laufen nicht auseinander; eine Mappe hat keine
 * Änderungs- und keine Löschroute. Rein: liest Quelltext-Klassen und Dateien, keine Datenbank.
 */
class EnergiemanagementMappeSchnittstelleVertragTest {

    private static final String BASIS = "/api/v1/energiemanagement";

    @Test
    @SuppressWarnings("unchecked")
    void openapiNenntJedeRouteMitIhremRechtUndDieTatsaechlichenDtoFelder() throws Exception {
        Map<String, Object> api;
        try (var in = Files.newInputStream(Path.of("../../docs/contracts/openapi.yaml"))) {
            api = new Yaml().load(in);
        }
        var paths = (Map<String, Object>) api.get("paths");
        var schemas = (Map<String, Object>) ((Map<String, Object>) api.get("components")).get("schemas");
        for (var route : Map.of("/mappen", List.of("get", "post"), "/mappen/{id}", List.of("get"),
                "/mappen/{id}/pdf", List.of("get"), "/mappen/{id}/csv", List.of("get")).entrySet()) {
            var methoden = (Map<String, Object>) paths.get(BASIS + route.getKey());
            assertThat(methoden).as(route.getKey()).containsKeys(route.getValue().toArray(String[]::new));
            assertThat(methoden).as("keine Änderungs- oder Löschroute").doesNotContainKeys("delete", "put", "patch");
            for (String m : route.getValue()) {
                var op = (Map<String, Object>) methoden.get(m);
                assertThat(op.get("description").toString()).as(m + " " + route.getKey())
                        .contains("energiemanagement." + (m.equals("get") ? "ansehen" : "verwalten"));
            }
        }
        assertThat(((Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) paths.get(BASIS + "/mappen/{id}/pdf"))
                .get("get")).get("responses")).keySet()).contains("404", "410");
        var mapper = new ObjectMapper();
        var dtos = Map.of(
                "EnergiemanagementMappeAnlegen", EnergiemanagementMappeDto.Anlegen.class,
                "EnergiemanagementMappe", EnergiemanagementMappeDto.Mappe.class,
                "EnergiemanagementMappen", EnergiemanagementMappeDto.Mappen.class);
        for (var dto : dtos.entrySet()) {
            var schema = (Map<String, Object>) schemas.get(dto.getKey());
            assertThat(schema).as(dto.getKey()).isNotNull();
            var namen = mapper.getSerializationConfig().introspect(mapper.constructType(dto.getValue()))
                    .findProperties().stream().map(p -> p.getName()).toList();
            assertThat(((Map<String, Object>) schema.get("properties")).keySet()).as(dto.getKey())
                    .containsExactlyInAnyOrderElementsOf(namen);
        }
        // Die Wörter sind die des Vertrags energiemanagement-vectors.json 1.6, zeilengleich.
        var anlegen = (Map<String, Object>) ((Map<String, Object>) schemas.get("EnergiemanagementMappeAnlegen"))
                .get("properties");
        assertThat((List<String>) ((Map<String, Object>) anlegen.get("anlass")).get("enum"))
                .containsExactlyElementsOf(EnergiemanagementRegeln.VOKABULARE.get("mappe_anlass"));
        assertThat((List<String>) ((Map<String, Object>) ((Map<String, Object>) anlegen.get("gruppen")).get("items"))
                .get("enum")).containsExactlyElementsOf(EnergiemanagementRegeln.VOKABULARE.get("verzeichnis_gruppe"));
        assertThat((List<String>) ((Map<String, Object>) ((Map<String, Object>) anlegen.get("offen")).get("items"))
                .get("enum")).containsExactlyElementsOf(EnergiemanagementRegeln.VOKABULARE.get("teil"));
        assertThat(EnergiemanagementRegeln.WOERTER.get("mappe_anlass").keySet())
                .containsExactlyElementsOf(EnergiemanagementRegeln.VOKABULARE.get("mappe_anlass"));
        assertThat(Arrays.stream(EnergiemanagementMappeController.class.getDeclaredMethods())
                .filter(m -> m.isAnnotationPresent(DeleteMapping.class) || m.isAnnotationPresent(PutMapping.class)
                        || m.isAnnotationPresent(PatchMapping.class)))
                .isEmpty();
    }

    /** Die CHECKs der Migration nennen genau die Wörter des Vertrags (späte Ankunft ohne energiemanagement_vokabular()). */
    @Test
    void dieMigrationNenntDieWoerterDesVertrags() throws Exception {
        String sql = Files.readString(Path.of("src/main/resources/db/migration/V20261007150000__uems_nachweisen_mappe.sql"));
        assertThat(sql).contains("anlass IN (" + String.join(", ", EnergiemanagementRegeln.VOKABULARE.get("mappe_anlass")
                .stream().map(w -> "'" + w + "'").toList()) + ")");
        String kompakt = sql.replaceAll("\\s+", " ");
        assertThat(kompakt).contains("ARRAY[" + String.join(", ", EnergiemanagementRegeln.VOKABULARE.get("verzeichnis_gruppe")
                .stream().map(w -> "'" + w + "'").toList()) + "]::TEXT[]");
        assertThat(kompakt).contains("ARRAY[" + String.join(", ", EnergiemanagementRegeln.VOKABULARE.get("teil")
                .stream().map(w -> "'" + w + "'").toList()) + "]::TEXT[]");
    }
}
