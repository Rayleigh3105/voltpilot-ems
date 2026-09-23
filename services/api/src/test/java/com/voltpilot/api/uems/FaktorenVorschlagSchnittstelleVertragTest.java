package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.FaktorenVorschlagDto;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Reiner Abgleich (AP-17 IP-16a): die Lese-Route des Faktoren-Vorschlags und jede Java-Antwortform stehen vollständig in
 * OpenAPI, der Abschnitt im Vertrag nennt dieselben Felder, und das Vokabular der Kandidaten ist {@code faktor_art} ohne
 * {@code wortlaut}.
 */
class FaktorenVorschlagSchnittstelleVertragTest {

    private static final Path OPENAPI = Path.of("../../docs/contracts/openapi.yaml");
    private static final Path VERTRAG = Path.of("../../docs/contracts/v2/bezugsbasis.md");

    @Test @SuppressWarnings("unchecked")
    void openapiBeschreibtRouteUndDtoVollstaendig() throws Exception {
        Map<String, Object> api;
        try (var in = Files.newInputStream(OPENAPI)) {
            api = new Yaml().load(in);
        }
        var paths = (Map<String, Object>) api.get("paths");
        var route = (Map<String, Object>) paths.get("/api/v1/kennzahlen/{id}/faktoren-vorschlag");
        assertThat(route.keySet()).containsExactly("parameters", "get");
        assertThat(((Map<String, Object>) route.get("get")).get("description").toString())
                .contains("messwerte.ansehen", "Zaun über die Kennzahl", "IP-16a", "nie 0", "keine Zeile wird geschrieben");

        var schemas = (Map<String, Object>) ((Map<String, Object>) api.get("components")).get("schemas");
        var dtos = new LinkedHashMap<String, Class<?>>();
        dtos.put("FaktorenVorschlag", FaktorenVorschlagDto.Vorschlag.class);
        dtos.put("FaktorenVorschlagFaktor", FaktorenVorschlagDto.Faktor.class);
        dtos.put("FaktorenVorschlagFlaeche", FaktorenVorschlagDto.FlaecheDerGeltung.class);
        var mapper = new ObjectMapper();
        String vertrag = Files.readString(VERTRAG);
        for (var dto : dtos.entrySet()) {
            var schema = (Map<String, Object>) schemas.get(dto.getKey());
            var props = (Map<String, Object>) schema.get("properties");
            var namen = mapper.getSerializationConfig().introspect(mapper.constructType(dto.getValue()))
                    .findProperties().stream().map(p -> p.getName()).toList();
            assertThat(props.keySet()).as(dto.getKey()).containsExactlyInAnyOrderElementsOf(namen);
            assertThat((List<String>) schema.get("required")).as(dto.getKey()).containsExactlyInAnyOrderElementsOf(namen);
            namen.forEach(n -> assertThat(vertrag).as("Vertrag nennt " + n).contains("`" + n + "`"));
        }
        var art = (Map<String, Object>) ((Map<String, Object>) schemas.get("FaktorenVorschlagFaktor")).get("properties");
        assertThat((List<String>) ((Map<String, Object>) art.get("art")).get("enum"))
                .containsExactly("flaeche", "standort", "anlage", "prozess", "kostenstelle");
        assertThat(vertrag).contains("`faktor_art` | `flaeche · standort · anlage · prozess · kostenstelle · wortlaut`");
    }
}
