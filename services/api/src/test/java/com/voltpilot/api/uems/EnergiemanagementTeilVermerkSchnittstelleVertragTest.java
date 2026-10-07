package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.EnergiemanagementTeilVermerkController;
import com.voltpilot.api.web.dto.EnergiemanagementTeilVermerkDto;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.yaml.snakeyaml.Yaml;

/**
 * Konzept Nachweisen n1, Entscheid 5: Routen, DTOs, das Vokabular {@code teil} und der veröffentlichte Vertrag
 * ({@code openapi.yaml}) laufen nicht auseinander, und jeder der 18 Teile hat seine Gruppe im Verzeichnis. Rein: liest
 * Quelltext-Klassen und Dateien, keine Datenbank.
 */
class EnergiemanagementTeilVermerkSchnittstelleVertragTest {

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
        for (var route : Map.of("/teil-vermerke", List.of("get", "post"), "/teil-vermerke/{id}/aufheben",
                List.of("post")).entrySet()) {
            var methoden = (Map<String, Object>) paths.get(BASIS + route.getKey());
            assertThat(methoden).as(route.getKey()).containsKeys(route.getValue().toArray(String[]::new));
            assertThat(methoden).as("keine Löschroute").doesNotContainKeys("delete", "put", "patch");
            for (String m : route.getValue()) {
                var op = (Map<String, Object>) methoden.get(m);
                assertThat(op.get("description").toString()).as(m + " " + route.getKey())
                        .contains("energiemanagement." + (m.equals("get") ? "ansehen" : "verwalten"));
                if (!m.equals("get")) {
                    assertThat(((Map<String, Object>) op.get("responses")).keySet()).contains("403", "404", "409");
                }
            }
        }
        var mapper = new ObjectMapper();
        var dtos = Map.of(
                "EnergiemanagementTeilVermerkAnlegen", EnergiemanagementTeilVermerkDto.Anlegen.class,
                "EnergiemanagementTeilVermerk", EnergiemanagementTeilVermerkDto.Vermerk.class,
                "EnergiemanagementTeilVermerke", EnergiemanagementTeilVermerkDto.Vermerke.class);
        for (var dto : dtos.entrySet()) {
            var schema = (Map<String, Object>) schemas.get(dto.getKey());
            assertThat(schema).as(dto.getKey()).isNotNull();
            var namen = mapper.getSerializationConfig().introspect(mapper.constructType(dto.getValue()))
                    .findProperties().stream().map(p -> p.getName()).toList();
            assertThat(((Map<String, Object>) schema.get("properties")).keySet()).as(dto.getKey())
                    .containsExactlyInAnyOrderElementsOf(namen);
        }
        // Die Teile sind die des Vertrags energiemanagement-vectors.json 1.3, zeilengleich.
        var teil = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) schemas
                .get("EnergiemanagementTeilVermerkAnlegen")).get("properties")).get("teil");
        assertThat((List<String>) teil.get("enum")).containsExactlyElementsOf(EnergiemanagementRegeln.VOKABULARE.get("teil"));
        // Keine Lösch- und keine Änderungsroute am Controller.
        assertThat(Arrays.stream(EnergiemanagementTeilVermerkController.class.getDeclaredMethods())
                .filter(m -> m.isAnnotationPresent(DeleteMapping.class) || m.isAnnotationPresent(PutMapping.class)))
                .isEmpty();
    }

    /** Jeder Teil hat genau eine Gruppe des Verzeichnisses, jede genannte Gruppe gibt es, und der Teil hat ein Wort. */
    @Test
    void jederTeilHatSeineGruppeImVerzeichnisUndSeinWort() {
        List<String> teile = EnergiemanagementRegeln.VOKABULARE.get("teil");
        assertThat(TeilVermerkVerzeichnis.GRUPPE.keySet()).containsExactlyInAnyOrderElementsOf(teile);
        assertThat(EnergiemanagementVerzeichnisService.GRUPPEN).containsAll(TeilVermerkVerzeichnis.GRUPPE.values());
        assertThat(EnergiemanagementRegeln.WOERTER.get("teil").keySet()).containsExactlyElementsOf(teile);
        assertThat(TeilVermerkVerzeichnis.GRUPPE).contains(Map.entry("kontext", "grundlagen"),
                Map.entry("aufgaben", "verantwortung"), Map.entry("energetische_bewertung", "bewertung_messplanung"),
                Map.entry("bezugsbasen", "kennzahlen_bezugsbasen"), Map.entry("massnahmen", "ziele_massnahmen_abweichungen"),
                Map.entry("feststellungen", "audits_feststellungen"));
    }
}
