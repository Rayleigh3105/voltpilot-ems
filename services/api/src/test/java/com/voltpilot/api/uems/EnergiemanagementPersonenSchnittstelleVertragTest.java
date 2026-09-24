package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.EnergiemanagementPersonenController;
import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.yaml.snakeyaml.Yaml;

/**
 * UEMS AP-19 IP-6: Routen, DTOs, Vokabular und der veröffentlichte Vertrag ({@code openapi.yaml}) laufen nicht
 * auseinander. Rein — liest Quelltext-Klassen und Dateien, keine Datenbank.
 */
class EnergiemanagementPersonenSchnittstelleVertragTest {

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
        for (var route : Map.of("/personen", List.of("get", "post"), "/personen/{id}", List.of("get", "put"),
                "/aufgaben", List.of("get", "post"), "/aufgaben/{id}/beenden", List.of("post")).entrySet()) {
            var methoden = (Map<String, Object>) paths.get(BASIS + route.getKey());
            assertThat(methoden).as(route.getKey()).containsKeys(route.getValue().toArray(String[]::new));
            assertThat(methoden).as("keine Löschroute (PA5)").doesNotContainKey("delete");
            for (String m : route.getValue()) {
                var op = (Map<String, Object>) methoden.get(m);
                assertThat(op.get("description").toString()).as(m + " " + route.getKey())
                        .contains("energiemanagement." + (m.equals("get") ? "ansehen" : "verwalten"));
                if (!m.equals("get")) {
                    assertThat(((Map<String, Object>) op.get("responses")).keySet()).contains("403", "422");
                }
            }
        }
        var mapper = new ObjectMapper();
        var dtos = Map.ofEntries(
                Map.entry("EnergiemanagementPersonAnlegen", EnergiemanagementPersonenDto.PersonAnlegen.class),
                Map.entry("EnergiemanagementPersonAendern", EnergiemanagementPersonenDto.PersonAendern.class),
                Map.entry("EnergiemanagementPerson", EnergiemanagementPersonenDto.Person.class),
                Map.entry("EnergiemanagementEingetragen", EnergiemanagementPersonenDto.Eingetragen.class),
                Map.entry("EnergiemanagementPersonen", EnergiemanagementPersonenDto.Personen.class),
                Map.entry("EnergiemanagementAenderung", EnergiemanagementPersonenDto.Aenderung.class),
                Map.entry("EnergiemanagementPersonMitVerlauf", EnergiemanagementPersonenDto.PersonMitVerlauf.class),
                Map.entry("EnergiemanagementPersonKurz", EnergiemanagementPersonenDto.PersonKurz.class),
                Map.entry("EnergiemanagementBeleg", EnergiemanagementPersonenDto.Beleg.class),
                Map.entry("EnergiemanagementAufgabeZuordnen", EnergiemanagementPersonenDto.AufgabeZuordnen.class),
                Map.entry("EnergiemanagementAufgabeBeenden", EnergiemanagementPersonenDto.AufgabeBeenden.class),
                Map.entry("EnergiemanagementZuordnung", EnergiemanagementPersonenDto.Zuordnung.class),
                Map.entry("EnergiemanagementAufgabe", EnergiemanagementPersonenDto.Aufgabe.class),
                Map.entry("EnergiemanagementAufgaben", EnergiemanagementPersonenDto.Aufgaben.class));
        for (var dto : dtos.entrySet()) {
            var schema = (Map<String, Object>) schemas.get(dto.getKey());
            assertThat(schema).as(dto.getKey()).isNotNull();
            var props = (Map<String, Object>) schema.get("properties");
            var namen = mapper.getSerializationConfig().introspect(mapper.constructType(dto.getValue()))
                    .findProperties().stream().map(p -> p.getName()).toList();
            assertThat(props.keySet()).as(dto.getKey()).containsExactlyInAnyOrderElementsOf(namen);
        }
        // Das Vokabular der Aufgaben ist das des Vertrags energiemanagement-vectors.json (IP-2), zeilengleich.
        var aufgabe = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) schemas
                .get("EnergiemanagementAufgabeZuordnen")).get("properties")).get("aufgabe");
        assertThat((List<String>) aufgabe.get("enum"))
                .containsExactlyElementsOf(EnergiemanagementRegeln.VOKABULARE.get("aufgabe"));
        var art = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) schemas
                .get("EnergiemanagementAenderung")).get("properties")).get("art");
        assertThat((List<String>) art.get("enum")).containsExactly("person_erfasst", "person_geaendert",
                "person_beendet", "aufgabe_zugeordnet", "aufgabe_beendet");
    }

    /** PA5: eine Person wird nie gelöscht — der Controller hat keine Löschroute. */
    @Test
    void derControllerHatKeineLoeschroute() {
        List<Method> loeschen = Arrays.stream(EnergiemanagementPersonenController.class.getDeclaredMethods())
                .filter(m -> m.isAnnotationPresent(DeleteMapping.class)).toList();
        assertThat(loeschen).isEmpty();
    }
}
