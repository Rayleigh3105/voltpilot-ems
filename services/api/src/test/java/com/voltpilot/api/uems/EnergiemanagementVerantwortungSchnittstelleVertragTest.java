package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.EnergiemanagementVerantwortungDto;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * UEMS AP-19 IP-10: der Leser „Wer ist wofür verantwortlich“ und die Verzeichnis-Quelle „Aufgaben“ laufen nicht vom
 * veröffentlichten Vertrag ({@code openapi.yaml}) weg und lesen nur über die Dienste (PA4, VZ1: gelesen, nie kopiert).
 * Rein — liest Quelltext und Dateien, keine Datenbank.
 */
class EnergiemanagementVerantwortungSchnittstelleVertragTest {

    private static final Path UEMS = Path.of("src/main/java/com/voltpilot/api/uems");

    @Test
    @SuppressWarnings("unchecked")
    void openapiNenntDieRouteMitIhremRechtDieDtoFelderUndDieArten() throws Exception {
        Map<String, Object> api;
        try (var in = Files.newInputStream(Path.of("../../docs/contracts/openapi.yaml"))) {
            api = new Yaml().load(in);
        }
        var paths = (Map<String, Object>) api.get("paths");
        var route = (Map<String, Object>) paths.get("/api/v1/energiemanagement/verantwortung");
        assertThat(route).as("GET …/verantwortung").containsOnlyKeys("get");
        assertThat(((Map<String, Object>) route.get("get")).get("description").toString())
                .contains("energiemanagement.ansehen");

        var schemas = (Map<String, Object>) ((Map<String, Object>) api.get("components")).get("schemas");
        var mapper = new ObjectMapper();
        var dtos = Map.of(
                "EnergiemanagementVerantwortlich", EnergiemanagementVerantwortungDto.Person.class,
                "EnergiemanagementVerantwortungObjekt", EnergiemanagementVerantwortungDto.Objekt.class,
                "EnergiemanagementBezugsbasisFreigabe", EnergiemanagementVerantwortungDto.Freigabe.class,
                "EnergiemanagementVerantwortung", EnergiemanagementVerantwortungDto.Verantwortung.class);
        for (var dto : dtos.entrySet()) {
            var schema = (Map<String, Object>) schemas.get(dto.getKey());
            assertThat(schema).as(dto.getKey()).isNotNull();
            var namen = mapper.getSerializationConfig().introspect(mapper.constructType(dto.getValue()))
                    .findProperties().stream().map(p -> p.getName()).toList();
            assertThat(((Map<String, Object>) schema.get("properties")).keySet()).as(dto.getKey())
                    .containsExactlyInAnyOrderElementsOf(namen);
            assertThat((List<String>) schema.get("required")).as(dto.getKey() + " required")
                    .containsExactlyInAnyOrderElementsOf(namen);
        }
        // Die Arten der Andockstelle: die des Bestands, dann das interne Audit (IP-18); IP-19 ergänzt die Feststellung.
        var art = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) schemas
                .get("EnergiemanagementVerantwortungObjekt")).get("properties")).get("art");
        var arten = new java.util.ArrayList<>(VerantwortungBestand.ARTEN);
        arten.addAll(AuditVerantwortung.ARTEN);
        assertThat((List<String>) art.get("enum")).containsExactlyElementsOf(arten);
    }

    /** PA4 und VZ1: der Leser, der Bestand und die Verzeichnis-Quelle halten keine eigene Abfrage — nur Dienste. */
    @Test
    void gelesenUeberDieDiensteNieUeberEigeneAbfragen() throws Exception {
        for (String klasse : List.of("EnergiemanagementVerantwortungService", "VerantwortungQuelle",
                "VerantwortungBestand", "VerzeichnisQuelle", "AufgabenVerzeichnis", "AuditVerzeichnis",
                "AuditVerantwortung")) {
            String text = Files.readString(UEMS.resolve(klasse + ".java"));
            assertThat(text).as(klasse).doesNotContain("JdbcTemplate", "SELECT ", "INSERT ", "UPDATE ", "Repository");
        }
        // Jede Art des Bestands steht im Bestand selbst als Objekt-Art (keine Art ohne Leser).
        String bestand = Files.readString(UEMS.resolve("VerantwortungBestand.java"));
        for (String a : VerantwortungBestand.ARTEN) {
            assertThat(bestand).as(a).contains("new Objekt(\"" + a + "\"");
        }
        String audits = Files.readString(UEMS.resolve("AuditVerantwortung.java"));
        for (String a : AuditVerantwortung.ARTEN) {
            assertThat(audits).as(a).contains("new Objekt(\"" + a + "\"");
        }
    }
}
