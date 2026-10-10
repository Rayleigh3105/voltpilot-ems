package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.BezugsdatenVorlageDto;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/** Reiner Leser: Java-Vertragsformen und OpenAPI der Vorlagen bleiben zeichengleich. */
class BezugsdatenVorlageSchnittstelleVertragTest {

    private static Map<String, Object> schemas;
    private static Map<String, Object> pfade;

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void lies() throws Exception {
        Path vertrag = Path.of("..", "..", "docs", "contracts", "openapi.yaml");
        try (InputStream in = Files.newInputStream(vertrag)) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
            pfade = (Map<String, Object>) openapi.get("paths");
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void getUndPostSindDerEntschiedeneVertrag() {
        Map<String, Object> route = (Map<String, Object>) pfade.get("/api/v1/bezugsdaten/vorlagen");
        assertThat(route.keySet()).containsExactly("get", "post");
        assertThat((String) ((Map<String, Object>) route.get("get")).get("description"))
                .contains("keine eigene Kennung");
        assertThat((String) ((Map<String, Object>) route.get("post")).get("description"))
                .contains("bezugsgroesse.importieren").contains("Keine Fassung wird überschrieben");
    }

    @Test
    void dieFormenSindZeichengleich() {
        Map<String, Class<? extends Record>> formen = Map.of(
                "BezugsdatenVorlageAnfrage", BezugsdatenVorlageDto.Anfrage.class,
                "BezugsdatenVorlageUrheber", BezugsdatenVorlageDto.Urheber.class,
                "BezugsdatenVorlage", BezugsdatenVorlageDto.Vorlage.class,
                "BezugsdatenVorlageListe", BezugsdatenVorlageDto.Liste.class,
                "BezugsdatenVorlageVerweis", BezugsdatenVorlageDto.Verweis.class);
        formen.forEach((schema, dto) -> assertThat(eigenschaften(schema)).as(schema)
                .containsExactlyElementsOf(felder(dto)));
    }

    private static List<String> felder(Class<? extends Record> dto) {
        List<String> aus = new ArrayList<>();
        for (var c : dto.getRecordComponents()) {
            JsonProperty p = c.getAccessor().getAnnotation(JsonProperty.class);
            aus.add(p != null ? p.value() : PropertyNamingStrategies.SnakeCaseStrategy.INSTANCE.translate(c.getName()));
        }
        return aus;
    }

    @SuppressWarnings("unchecked")
    private static List<String> eigenschaften(String schema) {
        return new ArrayList<>(((Map<String, Object>) ((Map<String, Object>) schemas.get(schema)).get("properties")).keySet());
    }
}
