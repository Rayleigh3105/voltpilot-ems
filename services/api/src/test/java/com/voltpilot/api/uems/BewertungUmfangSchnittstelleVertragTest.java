package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.BewertungUmfangDto;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/** API-DTOs, Rechte und der veröffentlichte Vertrag dürfen nicht auseinanderlaufen. */
class BewertungUmfangSchnittstelleVertragTest {
    @Test
    @SuppressWarnings("unchecked")
    void openapiNenntAlleRoutenUndDieTatsaechlichenDtoFelder() throws Exception {
        Map<String,Object> api;
        try (var in = Files.newInputStream(Path.of("../../docs/contracts/openapi.yaml"))) { api = new Yaml().load(in); }
        var paths = (Map<String,Object>) api.get("paths");
        var schemas = (Map<String,Object>) ((Map<String,Object>) api.get("components")).get("schemas");
        String base = "/api/v1/unternehmen/bewertung/umfang";
        for (var route : Map.of("", List.of("get","put"), "/fassungen", List.of("get")).entrySet()) {
            var methods = (Map<String,Object>) paths.get(base+route.getKey());
            for (String method : route.getValue()) {
                var op = (Map<String,Object>) methods.get(method);
                assertThat(op.get("description").toString()).contains("energieeinsatz." + (method.equals("get") ? "ansehen" : "verwalten"));
            }
        }
        var dtos = Map.ofEntries(Map.entry("BewertungUmfangSpeichern", BewertungUmfangDto.Speichern.class),
                Map.entry("BewertungUmfangAusschluss", BewertungUmfangDto.Ausschluss.class),
                Map.entry("BewertungUmfangTraeger", BewertungUmfangDto.Traeger.class),
                Map.entry("BewertungUmfangAnlage", BewertungUmfangDto.Anlage.class),
                Map.entry("BewertungUmfangStandort", BewertungUmfangDto.Standort.class),
                Map.entry("BewertungUmfang", BewertungUmfangDto.Umfang.class),
                Map.entry("BewertungUmfangHistorie", BewertungUmfangDto.Historie.class));
        var mapper = new ObjectMapper();
        for (var dto : dtos.entrySet()) {
            var props = (Map<String,Object>) ((Map<String,Object>) schemas.get(dto.getKey())).get("properties");
            var namen = mapper.getSerializationConfig().introspect(mapper.constructType(dto.getValue()))
                    .findProperties().stream().map(p -> p.getName()).toList();
            assertThat(props.keySet()).as(dto.getKey()).containsExactlyInAnyOrderElementsOf(namen);
        }
        // Der wiederverwendete Lese-Zaun hat exakt die Zellen der ausgewiesenen Kennung.
        var matrix = mapper.readTree(Path.of("../../docs/contracts/v2/rechte-matrix.json").toFile()).path("aktionen");
        com.fasterxml.jackson.databind.JsonNode einsatz = null, messwerte = null;
        for (var a : matrix) {
            if (a.path("kennung").asText().equals("energieeinsatz.ansehen")) einsatz = a.path("zellen");
            if (a.path("kennung").asText().equals("messwerte.ansehen")) messwerte = a.path("zellen");
        }
        assertThat(einsatz).isNotNull().isEqualTo(messwerte);
    }
}
