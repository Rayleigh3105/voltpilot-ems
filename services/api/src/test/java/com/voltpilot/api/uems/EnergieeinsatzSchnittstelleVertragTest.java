package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.EnergieeinsatzDto;
import com.voltpilot.api.web.dto.EnergieeinsatzEinstufungDto;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/** API-DTOs, Rechte und der veröffentlichte Vertrag dürfen nicht auseinanderlaufen. */
class EnergieeinsatzSchnittstelleVertragTest {
    @Test
    @SuppressWarnings("unchecked")
    void openapiNenntAlleRoutenUndDieTatsaechlichenDtoFelder() throws Exception {
        Map<String,Object> api;
        try (var in = Files.newInputStream(Path.of("../../docs/contracts/openapi.yaml"))) { api = new Yaml().load(in); }
        var paths = (Map<String,Object>) api.get("paths");
        var schemas = (Map<String,Object>) ((Map<String,Object>) api.get("components")).get("schemas");
        String base = "/api/v1/unternehmen/energieeinsaetze";
        for (var route : Map.of("", List.of("get","post"), "/{id}", List.of("get","put"),
                "/vorschlaege", List.of("get"), "/{id}/beenden", List.of("post"),
                "/{id}/verantwortlicher", List.of("put"), "/{id}/einflussgroessen", List.of("put"),
                "/{id}/protokoll", List.of("get")).entrySet()) {
            var methods = (Map<String,Object>) paths.get(base + route.getKey());
            assertThat(methods).containsKeys(route.getValue().toArray(String[]::new));
            for (String method : route.getValue()) {
                var op = (Map<String,Object>) methods.get(method);
                assertThat(op.get("description").toString()).contains("energieeinsatz." + (method.equals("get") ? "ansehen" : "verwalten"));
            }
        }
        assertThat(paths).containsKeys(base + "/{id}/einstufung", base + "/{id}/einstufung/bestaetigen",
                base + "/{id}/einstufungen");
        assertThat(((Map<String,Object>) paths.get(base + "/{id}/einstufung")).get("put").toString())
                .contains("energieeinsatz.einstufen");
        assertThat(((Map<String,Object>) paths.get(base + "/{id}/einstufung/bestaetigen")).get("post").toString())
                .contains("energieeinsatz.einstufen");
        assertThat(((Map<String,Object>) paths.get(base + "/{id}/einstufungen")).get("get").toString())
                .contains("energieeinsatz.ansehen");
        var dtos = Map.ofEntries(Map.entry("EnergieeinsatzAnlegen", EnergieeinsatzDto.Anlegen.class),
                Map.entry("EnergieeinsatzBearbeiten", EnergieeinsatzDto.Bearbeiten.class),
                Map.entry("EnergieeinsatzBeenden", EnergieeinsatzDto.Beenden.class),
                Map.entry("EnergieeinsatzVerantwortlicherSetzen", EnergieeinsatzDto.VerantwortlicherSetzen.class),
                Map.entry("EnergieeinsatzEinfluesseSetzen", EnergieeinsatzDto.EinfluesseSetzen.class),
                Map.entry("EnergieeinsatzEinfluss", EnergieeinsatzDto.Einfluss.class),
                Map.entry("Energieeinsatz", EnergieeinsatzDto.Einsatz.class),
                Map.entry("EnergieeinsatzVerantwortlicher", EnergieeinsatzDto.Verantwortlicher.class),
                Map.entry("EnergieeinsatzMessstelle", EnergieeinsatzDto.Messstelle.class));
        var mapper = new ObjectMapper();
        for (var dto : dtos.entrySet()) {
            var props = (Map<String,Object>) ((Map<String,Object>) schemas.get(dto.getKey())).get("properties");
            var namen = mapper.getSerializationConfig().introspect(mapper.constructType(dto.getValue()))
                    .findProperties().stream().map(p -> p.getName()).toList();
            assertThat(props.keySet()).as(dto.getKey()).containsExactlyInAnyOrderElementsOf(namen);
        }
        for (var dto : Map.of("EnergieeinsatzEinstufungSpeichern", EnergieeinsatzEinstufungDto.Speichern.class,
                "EnergieeinsatzEinstufungFassung", EnergieeinsatzEinstufungDto.Fassung.class).entrySet()) {
            var props = (Map<String,Object>) ((Map<String,Object>) schemas.get(dto.getKey())).get("properties");
            var namen = mapper.getSerializationConfig().introspect(mapper.constructType(dto.getValue()))
                    .findProperties().stream().map(p -> p.getName()).toList();
            assertThat(props.keySet()).as(dto.getKey()).containsExactlyInAnyOrderElementsOf(namen);
        }
        var loeschen = (Map<String,Object>) ((Map<String,Object>) paths.get("/api/v1/bezugsgroessen/{id}")).get("delete");
        assertThat(loeschen.get("description").toString()).contains("bezugsgroesse_in_verwendung", "energieeinsaetze");
        // Die Lese-Zellen sind dieselben wie im bestehenden Messstellen-Zaun, einschließlich Auftrag für Unterstützung.
        var matrix = mapper.readTree(Path.of("../../docs/contracts/v2/rechte-matrix.json").toFile()).path("aktionen");
        com.fasterxml.jackson.databind.JsonNode einsatz = null, messwerte = null;
        for (var a : matrix) {
            if (a.path("kennung").asText().equals("energieeinsatz.ansehen")) einsatz = a.path("zellen");
            if (a.path("kennung").asText().equals("messwerte.ansehen")) messwerte = a.path("zellen");
        }
        assertThat(einsatz).isNotNull().isEqualTo(messwerte);
    }
}
