package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.BewertungMessabdeckungDto;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/** Reiner Abgleich: GET-Route und jede Java-Antwortform stehen vollständig in OpenAPI. */
class BewertungMessabdeckungSchnittstelleVertragTest {
    @Test @SuppressWarnings("unchecked")
    void openapiBeschreibtRouteUndDtoVollstaendig() throws Exception {
        Map<String, Object> api;
        try (var in = Files.newInputStream(Path.of("../../docs/contracts/openapi.yaml"))) {
            api = new Yaml().load(in);
        }
        var paths = (Map<String, Object>) api.get("paths");
        var route = (Map<String, Object>) paths.get("/api/v1/unternehmen/bewertung/messabdeckung");
        assertThat(route.keySet()).containsExactly("get");
        assertThat(((Map<String, Object>) route.get("get")).get("description").toString())
                .contains("energieeinsatz.ansehen", "teilansicht", "berechnete", "IP-19");

        var schemas = (Map<String, Object>) ((Map<String, Object>) api.get("components")).get("schemas");
        var dtos = new LinkedHashMap<String, Class<?>>();
        dtos.put("BewertungMessabdeckung", BewertungMessabdeckungDto.Messabdeckung.class);
        dtos.put("BewertungMessabdeckungSumme", BewertungMessabdeckungDto.Summe.class);
        dtos.put("BewertungMessabdeckungEinsatz", BewertungMessabdeckungDto.Einsatz.class);
        dtos.put("BewertungMessabdeckungOrt", BewertungMessabdeckungDto.Ort.class);
        dtos.put("BewertungMessabdeckungMesswert", BewertungMessabdeckungDto.Messwert.class);
        dtos.put("BewertungMessabdeckungPlan", BewertungMessabdeckungDto.Plan.class);
        dtos.put("BewertungMessabdeckungRest", BewertungMessabdeckungDto.Rest.class);
        var mapper = new ObjectMapper();
        for (var dto : dtos.entrySet()) {
            var props = (Map<String, Object>) ((Map<String, Object>) schemas.get(dto.getKey())).get("properties");
            var namen = mapper.getSerializationConfig().introspect(mapper.constructType(dto.getValue()))
                    .findProperties().stream().map(p -> p.getName()).toList();
            assertThat(props.keySet()).as(dto.getKey()).containsExactlyInAnyOrderElementsOf(namen);
        }
    }
}
