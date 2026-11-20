package com.voltpilot.api.erzeuger;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.KoppelbildDto;
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
 * Rein, ohne Docker: die Schnittstelle des Koppelbilds (PFC200 Stufe 4) sagt in Java ({@link KoppelbildDto}) und in
 * {@code docs/contracts/openapi.yaml} dasselbe - jedes Feld, und in jeder Antwort ist jedes Feld Pflicht (unbekannt
 * ist null, nie abwesend).
 */
class KoppelbildSchnittstelleVertragTest {

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
        Map<String, Object> stellplatz = schema("KoppelbildStellplatz");
        Map<String, Object> props = map(stellplatz, "properties");
        Map<String, Object> freigabe = map(props, "freigabe");
        for (Object[] paar : new Object[][] {
                {"Koppelbild", schema("Koppelbild"), KoppelbildDto.Koppelbild.class},
                {"KoppelbildStand", schema("KoppelbildStand"), KoppelbildDto.Stand.class},
                {"KoppelbildStellplatz", stellplatz, KoppelbildDto.Stellplatz.class},
                {"KoppelbildStellplatz.angebot", map(props, "angebot"), KoppelbildDto.Angebot.class},
                {"KoppelbildStellplatz.wunsch", map(props, "wunsch"), KoppelbildDto.Wunsch.class},
                {"KoppelbildStellplatz.freigabe", freigabe, KoppelbildDto.Freigabe.class},
                {"KoppelbildStellplatz.freigabe.test", map(map(freigabe, "properties"), "test"), KoppelbildDto.Test.class},
                {"KoppelbildTestErgebnis", schema("KoppelbildTestErgebnis"), KoppelbildDto.TestErgebnis.class}}) {
            @SuppressWarnings("unchecked")
            Map<String, Object> schema = (Map<String, Object>) paar[1];
            List<String> dto = felder((Class<?>) paar[2]);
            assertThat(map(schema, "properties").keySet()).as((String) paar[0]).containsExactlyInAnyOrderElementsOf(dto);
            assertThat(liste(schema, "required")).as((String) paar[0]).containsExactlyInAnyOrderElementsOf(dto);
        }
    }

    @Test
    void jedeAnfrageformUndJedeRouteStehtInDerOpenApi() {
        assertThat(map(schema("KoppelbildTestAnfrage"), "properties").keySet())
                .containsExactlyInAnyOrderElementsOf(felder(KoppelbildDto.TestAnfrage.class));
        assertThat(paths).containsKeys("/api/v1/sites/{siteId}/anlagensteuerungen/{geraetId}/koppelbild",
                "/api/v1/geraete/{id}/koppelbild/stellplaetze/{platz}/test",
                "/api/v1/geraete/{id}/koppelbild/stellplaetze/{platz}/freigabe");
    }

    @Test
    void dieWoerterDerOpenApiSindDieDesVertrags() {
        Map<String, Object> stand = map(schema("KoppelbildStand"), "properties");
        assertThat(liste(map(stand, "lage"), "enum")).containsExactlyElementsOf(Koppelbild.LAGEN);
        Map<String, Object> angebot = map(map(map(schema("KoppelbildStellplatz"), "properties"), "angebot"),
                "properties");
        assertThat(liste(map(angebot, "art"), "enum")).containsExactlyElementsOf(Koppelbild.KOMMANDO.keySet());
        assertThat(liste(map(angebot, "ziel"), "enum")).containsExactlyElementsOf(Koppelbild.ZIELE);
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
