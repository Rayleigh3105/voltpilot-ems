package com.voltpilot.api.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.voltpilot.api.werkstatt.FreigabeRepository;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Rein, ohne Docker: Die Freigabe, die der Werkstatt-Dienst aus
 * {@code GET /api/v1/werkstatt-dienst/freigabe} liest, hat an drei Stellen
 * dieselben Felder - die Java-Form ({@link WerkstattDienstController.FreigabeDto}),
 * die Go-Struktur des Dienstes ({@code services/werkstatt-dienst/internal/
 * freigabe/freigabe.go}, liest mit DisallowUnknownFields: ein Feld zu viel legt
 * die Werkstatt still) und {@code docs/contracts/openapi.yaml}.
 */
class WerkstattDienstVertragTest {

    private static final Path OPENAPI = Path.of("..", "..", "docs", "contracts", "openapi.yaml");
    private static final Path GO = Path.of("..", "werkstatt-dienst", "internal", "freigabe", "freigabe.go");
    private static final Pattern TAG = Pattern.compile("json:\"([a-z0-9_]+)");

    private static String go;
    private static Map<String, Object> antwort;

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void lade() throws IOException {
        go = Files.readString(GO);
        try (InputStream in = Files.newInputStream(OPENAPI)) {
            Map<String, Object> openapi = new Yaml().load(in);
            Map<String, Object> pfad = (Map<String, Object>) ((Map<String, Object>) openapi.get("paths"))
                    .get("/api/v1/werkstatt-dienst/freigabe");
            Map<String, Object> ok = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) pfad
                    .get("get")).get("responses")).get("200");
            antwort = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) ok
                    .get("content")).get("application/json"))).get("schema");
        }
    }

    /** Alle Felder gesetzt: was Jackson schreibt, ist die volle Form. */
    private static JsonNode javaVoll() {
        String sha = "a".repeat(64);
        Instant t = Instant.parse("2026-11-02T10:00:00Z");
        FreigabeRepository.Freigabe f = new FreigabeRepository.Freigabe(UUID.randomUUID(), "2026-11-mango-1", "mango",
                t, t.plusSeconds(86400), 5,
                new FreigabeRepository.Abbild("25.12.5", "openwrt-25.12.5-x-sysupgrade.bin", sha, "https://x.example/"),
                new FreigabeRepository.Programm("edge-light-2026.11.0", "https://x.example/", sha, sha),
                "notiz", t, "sub", "Admin", t.plusSeconds(60), "sub", "Admin");
        ObjectMapper m = new ObjectMapper().registerModule(new JavaTimeModule())
                .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
        return m.valueToTree(WerkstattDienstController.FreigabeDto.of(f));
    }

    private static Set<String> felder(JsonNode n) {
        Set<String> s = new TreeSet<>();
        n.fieldNames().forEachRemaining(s::add);
        return s;
    }

    private static Set<String> goFelder(String typ) {
        Matcher block = Pattern.compile("type " + typ + " struct \\{(.*?)\\n}", Pattern.DOTALL).matcher(go);
        assertThat(block.find()).as("type %s struct in %s", typ, GO).isTrue();
        Set<String> s = new TreeSet<>();
        Matcher m = TAG.matcher(block.group(1));
        while (m.find()) {
            s.add(m.group(1));
        }
        return s;
    }

    @SuppressWarnings("unchecked")
    private static Set<String> openapiFelder(Map<String, Object> schema) {
        return new TreeSet<>(((Map<String, Object>) schema.get("properties")).keySet());
    }

    @Test
    void javaUndGoHabenDieselbenFelder() {
        JsonNode j = javaVoll();
        assertThat(felder(j)).isEqualTo(goFelder("Freigabe"));
        assertThat(felder(j.get("openwrt"))).isEqualTo(goFelder("Abbild"));
        assertThat(felder(j.get("edge_light"))).isEqualTo(goFelder("Programm"));
        assertThat(j.get("schema").asText()).isEqualTo(WerkstattDienstController.SCHEMA)
                .isEqualTo(goSchema());
    }

    @Test
    @SuppressWarnings("unchecked")
    void openapiNenntDieselbenFelder() {
        JsonNode j = javaVoll();
        assertThat(openapiFelder(antwort)).isEqualTo(felder(j));
        Map<String, Object> props = (Map<String, Object>) antwort.get("properties");
        assertThat(openapiFelder((Map<String, Object>) props.get("edge_light"))).isEqualTo(felder(j.get("edge_light")));
        // Pflicht ist alles außer beendet_am (die Route liefert nur eine laufende Freigabe).
        Set<String> pflicht = new TreeSet<>(felder(j));
        pflicht.remove("beendet_am");
        assertThat(new TreeSet<>((java.util.List<String>) antwort.get("required"))).isEqualTo(pflicht);
    }

    @Test
    void abnahmeDesDienstes_javaUndGoHabenDieselbenFelder() throws IOException {
        String portal = Files.readString(Path.of("..", "werkstatt-dienst", "internal", "portal", "portal.go"));
        Matcher block = Pattern.compile("type Abnahme struct \\{(.*?)\\n}", Pattern.DOTALL).matcher(portal);
        assertThat(block.find()).isTrue();
        Set<String> go = new TreeSet<>();
        Matcher m = Pattern.compile("json:\"([A-Za-z0-9_]+)").matcher(block.group(1));
        while (m.find()) {
            go.add(m.group(1));
        }
        Set<String> java = new TreeSet<>();
        for (var c : WerkstattDienstController.AbnahmeRequest.class.getRecordComponents()) {
            java.add(c.getName());
        }
        assertThat(go).isEqualTo(java);
    }

    private static String goSchema() {
        Matcher m = Pattern.compile("Schema\\s*=\\s*\"([^\"]+)\"").matcher(go);
        assertThat(m.find()).isTrue();
        return m.group(1);
    }
}
