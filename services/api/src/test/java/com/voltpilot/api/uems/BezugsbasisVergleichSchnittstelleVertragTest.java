package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.BezugsbasisVergleichDto;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Der Vergleich-Leser (UEMS AP-17 IP-19): DTO und OpenAPI laufen nicht auseinander, die Vokabulare sind die der Regeln,
 * die Route ist eine Lese-Route mit {@code bezugsbasis.ansehen}. Rein — kein Spring, keine Datenbank.
 */
class BezugsbasisVergleichSchnittstelleVertragTest {

    private static final String PFAD = "/api/v1/kennzahlen/{id}/vergleich";

    @SuppressWarnings("unchecked")
    private static Map<String, Object> openapi() throws Exception {
        try (InputStream in = Files.newInputStream(Path.of("..", "..", "docs", "contracts", "openapi.yaml"))) {
            return new Yaml().load(in);
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> schema(Map<String, Object> api, String name) {
        return (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) api.get("components"))
                .get("schemas")).get(name);
    }

    @SuppressWarnings("unchecked")
    private static List<String> eigenschaften(Map<String, Object> api, String name) {
        Map<String, Object> s = schema(api, name);
        assertThat(s).as(name).isNotNull();
        assertThat((List<String>) s.get("required")).as(name + " required")
                .containsExactlyElementsOf(((Map<String, Object>) s.get("properties")).keySet());
        return new ArrayList<>(((Map<String, Object>) s.get("properties")).keySet());
    }

    @SuppressWarnings("unchecked")
    private static List<String> aufzaehlung(Map<String, Object> api, String name, String feld) {
        Map<String, Object> f = (Map<String, Object>) ((Map<String, Object>) schema(api, name).get("properties")).get(feld);
        return ((List<Object>) f.get("enum")).stream().filter(x -> x != null).map(String::valueOf).toList();
    }

    @Test
    void dieFormenSindDieDesDto() throws Exception {
        Map<String, Object> api = openapi();
        Map<String, Class<? extends Record>> formen = Map.of(
                "BezugsbasisVergleich", BezugsbasisVergleichDto.Vergleich.class,
                "BezugsbasisVergleichBasis", BezugsbasisVergleichDto.Basis.class,
                "BezugsbasisVergleichMonat", BezugsbasisVergleichDto.Monat.class,
                "BezugsbasisVergleichRoh", BezugsbasisVergleichDto.Roh.class,
                "BezugsbasisVergleichBereinigt", BezugsbasisVergleichDto.Bereinigt.class,
                "BezugsbasisVergleichFassung", BezugsbasisVergleichDto.Fassung.class,
                "BezugsbasisVergleichGemessen", BezugsbasisVergleichDto.Gemessen.class,
                "BezugsbasisVergleichBedingung", BezugsbasisVergleichDto.Bedingung.class,
                "BezugsbasisVergleichZeitraum", BezugsbasisVergleichDto.Zeitraum.class,
                "BezugsbasisVergleichStand", BezugsbasisVergleichDto.Stand.class);
        formen.forEach((name, dto) -> assertThat(eigenschaften(api, name)).as(name).containsExactlyElementsOf(
                Arrays.stream(dto.getRecordComponents())
                        .map(c -> PropertyNamingStrategies.SnakeCaseStrategy.INSTANCE.translate(c.getName()))
                        .toList()));
    }

    @Test
    void dieVokabulareSindDieDerRegeln() throws Exception {
        Map<String, Object> api = openapi();
        for (String name : List.of("BezugsbasisVergleichBereinigt", "BezugsbasisVergleichZeitraum")) {
            assertThat(aufzaehlung(api, name, "urteil")).containsExactlyElementsOf(BezugsbasisRegeln.URTEILE);
            assertThat(aufzaehlung(api, name, "grund")).containsExactlyElementsOf(BezugsbasisRegeln.GRUENDE);
            assertThat(aufzaehlung(api, name, "richtung")).containsExactlyElementsOf(BezugsbasisRegeln.RICHTUNGEN);
        }
        assertThat(aufzaehlung(api, "BezugsbasisVergleichRoh", "urteil")).containsExactly("ohne_urteil");
        assertThat(aufzaehlung(api, "BezugsbasisVergleichFassung", "methode"))
                .containsExactlyElementsOf(BezugsbasisRegeln.METHODEN);
        assertThat(aufzaehlung(api, "BezugsbasisVergleichFassung", "datenlage"))
                .containsExactlyElementsOf(BezugsbasisRegeln.DATENLAGE);
    }

    @Test
    @SuppressWarnings("unchecked")
    void nurLesenMitDerKennungDerBezugsbasis() throws Exception {
        Map<String, Object> pfad = (Map<String, Object>) ((Map<String, Object>) openapi().get("paths")).get(PFAD);
        assertThat(pfad.keySet()).containsExactlyInAnyOrder("parameters", "get");
        assertThat(((Map<String, Object>) pfad.get("get")).get("description").toString())
                .contains("bezugsbasis.ansehen").contains("404");
        String controller = Files.readString(Path.of("src", "main", "java", "com", "voltpilot", "api", "web",
                "BezugsbasisVergleichController.java"));
        assertThat(controller).contains("{@code bezugsbasis.ansehen}").doesNotContain("@PostMapping", "@PutMapping",
                "@PatchMapping", "@DeleteMapping", "@Recht(");
        assertThat(BezugsbasisVergleich.PARAMETER).containsExactlyInAnyOrder("basis", "von", "bis");
    }
}
