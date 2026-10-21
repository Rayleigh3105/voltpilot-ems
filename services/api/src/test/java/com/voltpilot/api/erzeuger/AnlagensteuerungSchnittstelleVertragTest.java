package com.voltpilot.api.erzeuger;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.AnlagensteuerungDto;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Rein, ohne Docker: die Schnittstelle der Anlagensteuerung (UEMS EZ-6) sagt in Java ({@link AnlagensteuerungDto})
 * und in {@code docs/contracts/openapi.yaml} dasselbe — jedes Feld, und in jeder Antwort ist jedes Feld Pflicht
 * („nicht erhoben“ ist null, nie abwesend).
 */
class AnlagensteuerungSchnittstelleVertragTest {

    private static final Path OPENAPI = Path.of("..", "..", "docs", "contracts", "openapi.yaml");
    private static final PropertyNamingStrategies.SnakeCaseStrategy SNAKE =
            new PropertyNamingStrategies.SnakeCaseStrategy();

    private static Map<String, Object> schemas;
    private static Map<String, Object> paths;

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void lade() throws IOException {
        try (InputStream in = Files.newInputStream(OPENAPI)) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
            paths = (Map<String, Object>) openapi.get("paths");
        }
    }

    @Test
    void jedeAntwortformIstDieDerOpenApiUndJedesFeldIstPflicht() {
        for (Object[] paar : new Object[][] {
                {"AnlagensteuerungListe", AnlagensteuerungDto.Liste.class},
                {"AnlagensteuerungEinrichtung", AnlagensteuerungDto.Einrichtung.class},
                {"AnlagensteuerungBox", AnlagensteuerungDto.Box.class},
                {"Anlagensteuerung", AnlagensteuerungDto.Anlagensteuerung.class},
                {"AnlagensteuerungDatenquelle", AnlagensteuerungDto.Datenquelle.class},
                {"RegisterbildFassung", AnlagensteuerungDto.Fassung.class},
                {"RseStufe", AnlagensteuerungDto.RseStufe.class},
                {"Programmstand", AnlagensteuerungDto.Programmstand.class},
                {"Erzeugungseinheit", AnlagensteuerungDto.Einheit.class},
                {"AnlagensteuerungWerte", AnlagensteuerungDto.Werte.class},
                {"AnlagensteuerungWert", AnlagensteuerungDto.Wert.class},
                {"AnlagensteuerungBit", AnlagensteuerungDto.Bit.class},
                {"NetzVermarktung", AnlagensteuerungDto.NetzVermarktung.class},
                {"NamenImBild", AnlagensteuerungDto.NamenImBild.class},
                {"NetzVermarktungHinweis", AnlagensteuerungDto.Hinweis.class}}) {
            Map<String, Object> schema = schema((String) paar[0]);
            List<String> dto = felder((Class<?>) paar[1]);
            assertThat(map(schema, "properties").keySet()).as((String) paar[0])
                    .containsExactlyInAnyOrderElementsOf(dto);
            assertThat(liste(schema, "required")).as((String) paar[0]).containsExactlyInAnyOrderElementsOf(dto);
        }
    }

    @Test
    void jedeAnfrageformIstDieDerOpenApi() {
        for (Object[] paar : new Object[][] {
                {"AnlagensteuerungAnlegen", AnlagensteuerungDto.Anlegen.class},
                {"ErzeugungseinheitNeu", AnlagensteuerungDto.NeueEinheit.class},
                {"ErzeugungseinheitAendern", AnlagensteuerungDto.EinheitAendern.class},
                {"ErzeugerNamenAusBild", AnlagensteuerungDto.NamenAusBild.class},
                {"NetzVermarktungAendern", AnlagensteuerungDto.NetzVermarktungAendern.class}}) {
            assertThat(map(schema((String) paar[0]), "properties").keySet()).as((String) paar[0])
                    .containsExactlyInAnyOrderElementsOf(felder((Class<?>) paar[1]));
        }
        assertThat(paths).containsKeys("/api/v1/sites/{siteId}/anlagensteuerungen",
                "/api/v1/sites/{siteId}/anlagensteuerungen/{geraetId}/werte",
                "/api/v1/geraete/{id}/anlagensteuerung/einheiten/{teNr}",
                "/api/v1/geraete/{id}/anlagensteuerung/namen",
                "/api/v1/sites/{siteId}/netz-vermarktung");
    }

    private static List<String> felder(Class<?> record) {
        return Arrays.stream(record.getRecordComponents()).map(c -> SNAKE.translate(c.getName())).toList();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> schema(String name) {
        Map<String, Object> schema = (Map<String, Object>) schemas.get(name);
        assertThat(schema).as(name).isNotNull();
        return schema;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Map<String, Object> m, String key) {
        return (Map<String, Object>) m.get(key);
    }

    @SuppressWarnings("unchecked")
    private static List<String> liste(Map<String, Object> m, String key) {
        return (List<String>) m.get(key);
    }
}
