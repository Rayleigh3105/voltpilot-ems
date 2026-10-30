package com.voltpilot.api.geraetesuche;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.GeraetesucheDto;
import java.io.InputStream;
import java.lang.reflect.RecordComponent;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Rein, ohne Docker: die Antworten der Routen ({@link GeraetesucheDto}) tragen genau die Felder der OpenAPI-Schemas des
 * Tags {@code geraetesuche} - in derselben Folge, keins mehr, keins weniger. Das Portal-Paket baut gegen diese Form.
 */
class GeraetesucheAntwortFormTest {

    private static JsonNode schemas;

    @BeforeAll
    static void lade() throws Exception {
        try (InputStream in = Files.newInputStream(Path.of("..", "..", "docs", "contracts", "openapi.yaml"))) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = new ObjectMapper().valueToTree(openapi).path("components").path("schemas");
        }
    }

    private static List<String> felder(String schema) {
        List<String> out = new ArrayList<>();
        schemas.path(schema).path("properties").fieldNames().forEachRemaining(out::add);
        assertThat(out).as(schema).isNotEmpty();
        return out;
    }

    private static List<String> komponenten(Class<?> record) {
        return Arrays.stream(record.getRecordComponents()).map(RecordComponent::getName).toList();
    }

    @Test
    void jedeAntwortTraegtGenauDieFelderIhresSchemas() {
        Map<Class<?>, String> paare = Map.of(
                GeraetesucheDto.Suche.class, "Geraetesuche",
                GeraetesucheDto.Netz.class, "GeraetesucheNetz",
                GeraetesucheDto.Gruppe.class, "GeraetesucheGruppe",
                GeraetesucheDto.Fund.class, "GeraetesucheFund",
                GeraetesucheDto.Weitere.class, "GeraetesucheWeitere",
                GeraetesucheDto.LadesaeuleKlopftAn.class, "GeraetesucheLadesaeuleKlopftAn",
                GeraetesucheDto.Verlauf.class, "GeraetesucheVerlauf",
                GeraetesucheDto.VerlaufEintrag.class, "GeraetesucheVerlaufEintrag",
                GeraetesucheDto.Fehler.class, "GeraetesucheFehler",
                GeraetesucheDto.Urheber.class, "ProtokollUrheber");
        paare.forEach((record, schema) -> assertThat(komponenten(record)).as(schema)
                .containsExactlyElementsOf(felder(schema)));
        List<String> komponente = new ArrayList<>();
        schemas.at("/GeraetesucheFund/properties/komponente/properties").fieldNames().forEachRemaining(komponente::add);
        assertThat(komponenten(GeraetesucheDto.Komponente.class)).containsExactlyElementsOf(komponente);
    }

    @Test
    void dieZaehlerDesVerlaufsSindDieGruppenDesVertrags() {
        assertThat(GeraetesucheDienst.zaehler(List.of(), List.of()).keySet())
                .containsExactlyElementsOf(GeraetesucheVertrag.GRUPPEN);
        List<String> imSchema = new ArrayList<>();
        schemas.at("/GeraetesucheVerlaufEintrag/properties/zaehler/properties").fieldNames()
                .forEachRemaining(imSchema::add);
        assertThat(imSchema).containsExactlyElementsOf(GeraetesucheVertrag.GRUPPEN);
    }
}
