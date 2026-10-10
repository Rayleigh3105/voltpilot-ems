package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.BewertungKriterienDto;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

class BewertungKriterienSchnittstelleVertragTest {
    @Test
    @SuppressWarnings("unchecked")
    void routenDtoUndRechteEntsprechenOpenapi() throws Exception {
        Map<String,Object> api;
        try (var in=Files.newInputStream(Path.of("../../docs/contracts/openapi.yaml"))) { api=new Yaml().load(in); }
        var paths=(Map<String,Object>) api.get("paths");
        var schemas=(Map<String,Object>) ((Map<String,Object>) api.get("components")).get("schemas");
        String base="/api/v1/unternehmen/bewertung/kriterien";
        for (var route : Map.of("",List.of("get","put"),"/fassungen",List.of("get"),
                "/{nummer}/freigeben",List.of("post"),"/{nummer}/ablehnen",List.of("post")).entrySet()) {
            var methods=(Map<String,Object>) paths.get(base+route.getKey());
            for (String method : route.getValue()) {
                var op=(Map<String,Object>) methods.get(method);
                assertThat(op.get("description").toString()).contains(method.equals("get") ? "energieeinsatz.ansehen" : "bewertung.kriterien");
            }
        }
        var json=new ObjectMapper();
        for (var dto : Map.of("BewertungKriterienFassung",BewertungKriterienDto.Fassung.class,
                "BewertungKriterienSpeichern",BewertungKriterienDto.Speichern.class).entrySet()) {
            var props=(Map<String,Object>) ((Map<String,Object>) schemas.get(dto.getKey())).get("properties");
            var namen=json.getSerializationConfig().introspect(json.constructType(dto.getValue()))
                    .findProperties().stream().map(p -> p.getName()).toList();
            assertThat(props.keySet()).containsExactlyInAnyOrderElementsOf(namen);
        }
        var matrix=json.readTree(Path.of("../../docs/contracts/v2/rechte-matrix.json").toFile()).path("aktionen");
        var zellen=java.util.stream.StreamSupport.stream(matrix.spliterator(),false)
                .filter(a -> a.path("kennung").asText().equals("bewertung.kriterien")).findFirst().orElseThrow().path("zellen");
        assertThat(zellen.path("kundenadministrator").asText()).isEqualTo("U");
        assertThat(zellen.path("energiemanager").asText()).isEqualTo("U");
        for (String rolle : List.of("bearbeiter","bedienberechtigt","leser","unterstuetzer","voltpilot_betrieb"))
            assertThat(zellen.path(rolle).asText()).isEqualTo("-");
    }
}
