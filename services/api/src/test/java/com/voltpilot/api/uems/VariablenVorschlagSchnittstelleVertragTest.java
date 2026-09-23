package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.VariablenVorschlagDto;
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
 * Der Variablen-Vorschlag (UEMS AP-17 IP-11a): DTO, OpenAPI und Vokabulare laufen nicht auseinander; die Route ist
 * eine Lese-Route mit der Kennung der Kennzahl. Rein — kein Spring, keine Datenbank.
 */
class VariablenVorschlagSchnittstelleVertragTest {

    private static final String PFAD = "/api/v1/kennzahlen/{id}/variablen-vorschlag";

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
                "KennzahlVariablenVorschlag", VariablenVorschlagDto.Vorschlag.class,
                "KennzahlVariablenEinsatz", VariablenVorschlagDto.Einsatz.class,
                "KennzahlVariable", VariablenVorschlagDto.Variable.class,
                "KennzahlVariablenKandidat", VariablenVorschlagDto.Kandidat.class,
                "KennzahlVariablenAbhaengigkeit", VariablenVorschlagDto.Abhaengigkeit.class,
                "KennzahlVariablenOhneZahl", VariablenVorschlagDto.OhneZahl.class);
        formen.forEach((name, dto) -> assertThat(eigenschaften(api, name)).as(name).containsExactlyElementsOf(
                Arrays.stream(dto.getRecordComponents())
                        .map(c -> c.getAccessor().isAnnotationPresent(JsonProperty.class)
                                ? c.getAccessor().getAnnotation(JsonProperty.class).value()
                                : PropertyNamingStrategies.SnakeCaseStrategy.INSTANCE.translate(c.getName()))
                        .toList()));
    }

    /** Das JSON-Schema des Vertrags nennt dieselben Felder in derselben Folge wie OpenAPI. */
    @Test
    void dasVertragsschemaIstDasDerSchnittstelle() throws Exception {
        Map<String, Object> api = openapi();
        com.fasterxml.jackson.databind.JsonNode schema = new com.fasterxml.jackson.databind.ObjectMapper().readTree(
                Files.readString(Path.of("..", "..", "docs", "contracts", "v2", "kennzahl-variablen-vorschlag.schema.json")));
        Map<String, com.fasterxml.jackson.databind.JsonNode> teile = Map.of(
                "KennzahlVariablenVorschlag", schema,
                "KennzahlVariablenEinsatz", schema.at("/$defs/einsatz"),
                "KennzahlVariable", schema.at("/$defs/variable"),
                "KennzahlVariablenKandidat", schema.at("/$defs/kandidat"),
                "KennzahlVariablenAbhaengigkeit", schema.at("/$defs/abhaengigkeit"),
                "KennzahlVariablenOhneZahl", schema.at("/$defs/ohne_zahl"));
        teile.forEach((name, teil) -> {
            List<String> felder = new ArrayList<>();
            teil.path("properties").fieldNames().forEachRemaining(felder::add);
            assertThat(felder).as(name).containsExactlyElementsOf(eigenschaften(api, name));
        });
        assertThat(schema.at("/$defs/ohne_zahl/properties/satz/const").asText()).isEqualTo(VariablenVorschlag.OHNE_ZAHL);
    }

    @Test
    void dieVokabulareSindDieDesCodes() throws Exception {
        Map<String, Object> api = openapi();
        assertThat(aufzaehlung(api, "KennzahlVariablenVorschlag", "bezug")).containsExactlyElementsOf(VariablenVorschlag.BEZUEGE);
        assertThat(aufzaehlung(api, "KennzahlVariablenKandidat", "vorschlag"))
                .containsExactlyElementsOf(VariablenVorschlag.VORSCHLAEGE);
        assertThat(aufzaehlung(api, "KennzahlVariablenAbhaengigkeit", "ergebnis"))
                .containsExactlyElementsOf(VariablenAbhaengigkeit.ERGEBNISSE);
        assertThat(aufzaehlung(api, "KennzahlVariablenAbhaengigkeit", "grund"))
                .containsExactlyElementsOf(VariablenAbhaengigkeit.GRUENDE);
        assertThat(aufzaehlung(api, "KennzahlVariablenOhneZahl", "satz")).containsExactly(VariablenVorschlag.OHNE_ZAHL);
        // Die Arten am Einsatz sind die der Einflussgröße (V20260922210000, energieeinsatz_einflussgroesse.art).
        assertThat(aufzaehlung(api, "KennzahlVariablenOhneZahl", "einfluss_art"))
                .containsExactly("produktion", "betriebszeit", "wetter", "sonstige");
        assertThat(aufzaehlung(api, "KennzahlVariablenKandidat", "einfluss_art"))
                .containsExactly("produktion", "betriebszeit", "wetter", "sonstige");
    }

    @Test
    @SuppressWarnings("unchecked")
    void nurLesenMitDerKennungDerKennzahl() throws Exception {
        Map<String, Object> pfad = (Map<String, Object>) ((Map<String, Object>) openapi().get("paths")).get(PFAD);
        assertThat(pfad.keySet()).containsExactlyInAnyOrder("parameters", "get");
        assertThat(((Map<String, Object>) pfad.get("get")).get("description").toString())
                .contains("messwerte.ansehen").contains("404");
        String controller = Files.readString(Path.of("src", "main", "java", "com", "voltpilot", "api", "web",
                "KennzahlVariablenVorschlagController.java"));
        assertThat(controller).contains("{@code messwerte.ansehen}").doesNotContain("@PostMapping", "@PutMapping",
                "@PatchMapping", "@DeleteMapping", "@Recht");
        assertThat(KennzahlRegeln.ANSEHEN).isEqualTo("messwerte.ansehen");
    }
}
