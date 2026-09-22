package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.MessbedarfDto;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/** IP-19: Routen und Messbedarf-DTO bleiben deckungsgleich mit dem veröffentlichten Vertrag. */
class MessbedarfSchnittstelleVertragTest {
    @Test
    @SuppressWarnings("unchecked")
    void openapiNenntRoutenFelderUndZustaende() throws Exception {
        Map<String, Object> api;
        try (var in = Files.newInputStream(Path.of("../../docs/contracts/openapi.yaml"))) {
            api = new Yaml().load(in);
        }
        var paths = (Map<String, Object>) api.get("paths");
        var schemas = (Map<String, Object>) ((Map<String, Object>) api.get("components")).get("schemas");
        String base = "/api/v1/unternehmen/energieeinsaetze/{id}/messbedarf";
        for (var route : Map.of("", List.of("get", "post"), "/{messbedarfId}", List.of("put"),
                "/{messbedarfId}/einloesen", List.of("post"),
                "/{messbedarfId}/verwerfen", List.of("post"),
                "/{messbedarfId}/protokoll", List.of("get")).entrySet()) {
            var methoden = (Map<String, Object>) paths.get(base + route.getKey());
            assertThat(methoden).containsKeys(route.getValue().toArray(String[]::new));
            for (String methode : route.getValue()) {
                var operation = (Map<String, Object>) methoden.get(methode);
                assertThat(operation.get("description").toString()).contains("energieeinsatz."
                        + (methode.equals("get") ? "ansehen" : "verwalten"));
            }
        }
        assertFelder(schemas, "MessbedarfAnlegen", MessbedarfDto.Anlegen.class);
        assertFelder(schemas, "Messbedarf", MessbedarfDto.Bedarf.class);
        assertFelder(schemas, "MessbedarfListe", MessbedarfDto.Liste.class);
        var bedarf = (Map<String, Object>) schemas.get("Messbedarf");
        var zustand = (Map<String, Object>) ((Map<String, Object>) bedarf.get("properties")).get("zustand");
        assertThat((List<String>) zustand.get("enum")).containsExactly("offen", "eingeloest", "verworfen");
        var register = (Map<String, Object>) schemas.get("MessstelleRegisterZeile");
        assertThat((Map<String, Object>) register.get("properties")).containsKey("geplant_fuer_einsaetze");
    }

    @SuppressWarnings("unchecked")
    private static void assertFelder(Map<String, Object> schemas, String schema, Class<?> dto) {
        var props = (Map<String, Object>) ((Map<String, Object>) schemas.get(schema)).get("properties");
        var mapper = new ObjectMapper();
        var namen = mapper.getSerializationConfig().introspect(mapper.constructType(dto))
                .findProperties().stream().map(p -> p.getName()).toList();
        assertThat(props.keySet()).as(schema).containsExactlyInAnyOrderElementsOf(namen);
    }
}
