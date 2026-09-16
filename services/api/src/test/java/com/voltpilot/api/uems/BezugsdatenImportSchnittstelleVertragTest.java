package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.BezugsdatenImportDto;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Die Import-Vorschau (UEMS AP-09 IP-12) sagt an drei Stellen dasselbe: im Vertrag
 * ({@code bezugsdaten-vectors.json} + {@code bezugsdaten.schema.json}, Form {@code vorschau_zuordnung}), in Java
 * ({@link BezugsdatenImportDto}) und in {@code docs/contracts/openapi.yaml}. Rein — ohne Spring, ohne Datenbank.
 */
class BezugsdatenImportSchnittstelleVertragTest {

    private static final Path CONTRACTS = Path.of("..", "..", "docs", "contracts");
    private static Map<String, Object> schemas;
    private static Map<String, Object> pfade;
    private static JsonNode vertrag;
    private static JsonNode vertragsSchema;

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void lies() throws Exception {
        try (InputStream in = Files.newInputStream(CONTRACTS.resolve("openapi.yaml"))) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
            pfade = (Map<String, Object>) openapi.get("paths");
        }
        ObjectMapper m = new ObjectMapper();
        vertrag = m.readTree(CONTRACTS.resolve("v2").resolve("bezugsdaten-vectors.json").toFile());
        vertragsSchema = m.readTree(CONTRACTS.resolve("v2").resolve("bezugsdaten.schema.json").toFile());
    }

    @Test
    @SuppressWarnings("unchecked")
    void dieRouteIstEinMultipartPostOhneSchreibweg() {
        Map<String, Object> pfad = (Map<String, Object>) pfade.get("/api/v1/bezugsdaten/importe/vorschau");
        assertThat(pfad.keySet()).containsExactly("post");
        Map<String, Object> post = (Map<String, Object>) pfad.get("post");
        assertThat((String) post.get("description")).contains("bezugsgroesse.importieren").contains("SCHREIBT NICHTS")
                .contains("30 Minuten");
        Map<String, Object> inhalt = (Map<String, Object>) ((Map<String, Object>) post.get("requestBody")).get("content");
        assertThat(inhalt.keySet()).containsExactly("multipart/form-data");
        assertThat(((Map<String, Object>) post.get("responses")).keySet()).contains("200", "400", "413");
    }

    @Test
    @SuppressWarnings("unchecked")
    void uebernahmeRuecknahmeStatusUndFreigabeSindBeschrieben() {
        assertThat(pfade).containsKeys("/api/v1/bezugsdaten/importe",
                "/api/v1/bezugsdaten/importe/{kennung}",
                "/api/v1/bezugsdaten/importe/{kennung}/ruecknahme",
                "/api/v1/bezugsdaten/importe/{kennung}/freigeben");
        Map<String,Object> bestaetigung=(Map<String,Object>)schemas.get("BezugsdatenImportBestaetigung");
        assertThat((Map<String,Object>)bestaetigung.get("properties"))
                .containsOnlyKeys("vorschau","entscheidungen","begruendung","teiluebernahme");
        assertThat(bestaetigung.get("additionalProperties")).isEqualTo(false);
        Map<String,Object> ergebnis=(Map<String,Object>)schemas.get("BezugsdatenImportErgebnis");
        assertThat((Map<String,Object>)ergebnis.get("properties"))
                .containsOnlyKeys("kennung","status","aenderungen","vorschlaege","zaehler");
    }

    /** Die Wörter der Antwort sind die Vokabulare des Vertrags. */
    @Test
    void dieWoerterSindDieDesVertrags() {
        JsonNode vok = vertrag.path("vokabulare");
        assertThat(liste(eigenschaft("BezugsdatenVorschauZeile", "urteil"), "enum")).containsExactlyElementsOf(texte(vok.path("zeilen_urteil")));
        assertThat(liste(eigenschaft("BezugsdatenBefund", "befund"), "enum")).containsExactlyElementsOf(texte(vok.path("befunde")));
        assertThat(liste(eigenschaft("BezugsdatenZuordnung", "deutung"), "enum")).containsExactlyElementsOf(texte(vok.path("deutung")))
                .containsExactlyElementsOf(ImportVorschau.DEUTUNGEN);
        assertThat(liste(eigenschaft("BezugsdatenZuordnung", "zahlformat"), "enum")).containsExactlyElementsOf(ImportVorschau.ZAHLFORMATE);
        assertThat(texte(vok.path("import_status"))).contains(ImportVorschau.VORSCHAU);
    }

    /** Jede Form hat in OpenAPI genau die Felder des DTO (snake_case) — und die Zuordnung die des Vertrags. */
    @Test
    void dieFormenSindZeichengleich() {
        Map<String, Class<? extends Record>> formen = Map.of(
                "BezugsdatenZuordnung", BezugsdatenImportDto.Zuordnung.class,
                "BezugsdatenBefund", BezugsdatenImportDto.Befund.class,
                "BezugsdatenImportVorschau", BezugsdatenImportDto.Vorschau.class,
                "BezugsdatenVorschauZeile", BezugsdatenImportDto.Zeile.class);
        formen.forEach((schema, dto) -> assertThat(eigenschaften(schema)).as(schema).containsExactlyElementsOf(felder(dto)));
        List<String> imVertrag = new ArrayList<>();
        vertragsSchema.at("/$defs/vorschau_zuordnung/properties").fieldNames().forEachRemaining(imVertrag::add);
        assertThat(felder(BezugsdatenImportDto.Zuordnung.class)).containsExactlyElementsOf(imVertrag);
        List<String> spalten = new ArrayList<>();
        vertragsSchema.at("/$defs/vorschau_zuordnung/properties/spalten/properties").fieldNames().forEachRemaining(spalten::add);
        assertThat(felder(BezugsdatenImportDto.Spalten.class)).containsExactlyElementsOf(spalten).containsExactlyElementsOf(ImportVorschau.ROLLEN);
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

    @SuppressWarnings("unchecked")
    private static Map<String, Object> eigenschaft(String schema, String feld) {
        Map<String, Object> s = (Map<String, Object>) schemas.get(schema);
        assertThat(s).as(schema).isNotNull();
        return (Map<String, Object>) ((Map<String, Object>) s.get("properties")).get(feld);
    }

    @SuppressWarnings("unchecked")
    private static List<String> liste(Map<String, Object> knoten, String... pfad) {
        Object o = knoten;
        for (String schritt : pfad) {
            o = ((Map<String, Object>) o).get(schritt);
        }
        return ((List<Object>) o).stream().map(String::valueOf).toList();
    }

    private static List<String> texte(JsonNode array) {
        List<String> aus = new ArrayList<>();
        array.forEach(x -> aus.add(x.asText()));
        return aus;
    }
}
