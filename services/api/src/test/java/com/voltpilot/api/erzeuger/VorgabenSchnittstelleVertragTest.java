package com.voltpilot.api.erzeuger;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.ErzeugerVorgabenDto;
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
 * Rein, ohne Docker: die Schnittstelle der Vorgaben (UEMS EZ-7) sagt in Java ({@link ErzeugerVorgabenDto}) und in
 * {@code docs/contracts/openapi.yaml} dasselbe — jedes Feld, und jedes Feld ist Pflicht („unbekannt“ ist null, nie
 * abwesend). Die Wörter von Urheber, Art, Methode und Kanal sind dieselben wie in der Ableitung und der Migration.
 */
class VorgabenSchnittstelleVertragTest {

    private static final Path OPENAPI = Path.of("..", "..", "docs", "contracts", "openapi.yaml");
    private static final Path MIGRATION = Path.of("src", "main", "resources", "db", "migration",
            "V20261022013700__erzeuger_vorgabe.sql");
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
                {"ErzeugerVorgabe", ErzeugerVorgabenDto.Vorgabe.class},
                {"ErzeugerVorgabeLuecke", ErzeugerVorgabenDto.Luecke.class},
                {"ErzeugerVorgabenChronik", ErzeugerVorgabenDto.Chronik.class},
                {"ErzeugerVorgabeRohwert", ErzeugerVorgabenDto.Rohwert.class},
                {"ErzeugerVorgabeSignal", ErzeugerVorgabenDto.Signal.class},
                {"ErzeugerVorgabeDetail", ErzeugerVorgabenDto.Detail.class},
                {"ErzeugerVorgabenGruppe", ErzeugerVorgabenDto.Gruppe.class},
                {"ErzeugerVorgabenJeUrheber", ErzeugerVorgabenDto.JeUrheber.class},
                {"ErzeugerVorgabenAbschnitt", ErzeugerVorgabenDto.Abschnitt.class},
                {"ErzeugerVorgabenZaehlung", ErzeugerVorgabenDto.Zaehlung.class},
                {"ErzeugerVorgabenHeute", ErzeugerVorgabenDto.Heute.class}}) {
            Map<String, Object> schema = schema((String) paar[0]);
            List<String> dto = felder((Class<?>) paar[1]);
            assertThat(map(schema, "properties").keySet()).as((String) paar[0])
                    .containsExactlyInAnyOrderElementsOf(dto);
            assertThat(liste(schema, "required")).as((String) paar[0]).containsExactlyInAnyOrderElementsOf(dto);
        }
        assertThat(paths).containsKeys("/api/v1/sites/{siteId}/erzeuger/vorgaben",
                "/api/v1/sites/{siteId}/erzeuger/vorgaben/zaehlung",
                "/api/v1/sites/{siteId}/erzeuger/vorgaben/heute",
                "/api/v1/sites/{siteId}/erzeuger/vorgaben/{vorgabeId}",
                "/api/v1/sites/{siteId}/erzeuger/vorgaben.csv");
    }

    @Test
    void dieWoerterSindInAbleitungOpenApiUndMigrationDieselben() throws IOException {
        Map<String, Object> vorgabe = map(schema("ErzeugerVorgabe"), "properties");
        assertThat(liste(map(vorgabe, "urheber"), "enum")).containsExactlyElementsOf(VorgabenAbleitung.URHEBER);
        assertThat(liste(map(vorgabe, "art"), "enum")).containsExactlyElementsOf(VorgabenAbleitung.ARTEN);
        assertThat(liste(map(vorgabe, "methode"), "enum")).filteredOn(java.util.Objects::nonNull)
                .containsExactlyElementsOf(VorgabenAbleitung.METHODEN);
        String sql = Files.readString(MIGRATION);
        for (String wort : VorgabenAbleitung.URHEBER) {
            assertThat(sql).contains("'" + wort + "'");
        }
        for (String wort : VorgabenAbleitung.ARTEN) {
            assertThat(sql).contains("'" + wort + "'");
        }
        for (String wort : VorgabenAbleitung.METHODEN) {
            assertThat(sql).contains("'" + wort + "'");
        }
        // Die Kanäle sind die Wörter von n_kanal und d_kanal im Vokabular des Bilds.
        for (String feld : List.of("erzeuger.nb.n_kanal", "erzeuger.dv.d_kanal")) {
            ErzeugerRegisterbild.feld(feld).orElseThrow().vokabular().forEach(w -> {
                assertThat(sql).contains("'" + w.wort() + "'");
                assertThat(liste(map(vorgabe, "kanal"), "enum")).contains(w.wort());
                assertThat(VorgabenCsv.KANAL).containsKey(w.wort());
            });
        }
        assertThat(VorgabenCsv.URHEBER).containsOnlyKeys(VorgabenAbleitung.URHEBER);
        assertThat(VorgabenCsv.ART).containsOnlyKeys(VorgabenAbleitung.ARTEN);
        assertThat(VorgabenCsv.METHODE).containsOnlyKeys(VorgabenAbleitung.METHODEN);
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
