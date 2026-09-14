package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.AnlageUmzugDto;
import com.voltpilot.api.web.dto.OrtDto;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.stream.StreamSupport;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Rein, ohne Docker: die Gebäude/Bereich-Schnittstelle (UEMS AP-02 IP-5) sagt in drei Dateien
 * DASSELBE — der Ortsbaum-Vertrag ({@code ortsbaum-vectors.json}: die Gründe, die der Schreibweg
 * weiterreicht), die Java-Form ({@link OrtDto}, {@link OrtsbaumLesemodell}, {@link OrtAbgelehnt},
 * {@link OrtFelder}) und {@code docs/contracts/openapi.yaml}.
 */
class OrtSchnittstelleVertragTest {

    private static final Path CONTRACTS = Path.of("..", "..", "docs", "contracts");

    private static Map<String, Object> schemas;
    private static JsonNode vektoren;

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void lade() throws IOException {
        try (InputStream in = Files.newInputStream(CONTRACTS.resolve("openapi.yaml"))) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
        }
        vektoren = new ObjectMapper().readTree(CONTRACTS.resolve("v2").resolve("ortsbaum-vectors.json").toFile());
    }

    @Test
    void jederCodeDerAblehnungStehtInDerSchnittstelleUndNurDer() {
        assertThat(liste(schema("OrtFehler"), "properties", "code", "enum"))
                .containsExactlyInAnyOrderElementsOf(OrtAbgelehnt.CODES);
    }

    /**
     * Der Schreibweg reicht die Vertragsgründe als Code weiter: jeder Grund der Fläche, und
     * die drei, die beim Anlegen eintreten können (ein neuer Ort hat noch kein Intervall).
     */
    @Test
    void dieGruendeDesVertragsSindCodesDerAblehnung() {
        List<String> flaeche = StreamSupport.stream(vektoren.get("gruende_flaeche").spliterator(), false)
                .map(JsonNode::asText).toList();
        assertThat(OrtAbgelehnt.CODES).containsAll(flaeche);
        assertThat(OrtAbgelehnt.CODES)
                .contains("ziel_art_unzulaessig", "ziel_gab_es_noch_nicht", "ziel_archiviert");
    }

    @Test
    void dieNutzungIstDasselbeVokabular() {
        assertThat(liste(schema("Nutzung"), "enum")).containsExactlyElementsOf(OrtFelder.NUTZUNGEN);
    }

    @Test
    void dieFormenSindDieDerSchnittstelle() {
        Map<String, Class<?>> formen = Map.ofEntries(
                Map.entry("OrtAnlegen", OrtDto.Anlegen.class),
                Map.entry("OrtBearbeiten", OrtDto.Bearbeiten.class),
                Map.entry("OrtFlaeche", OrtDto.Flaeche.class),
                Map.entry("Ort", OrtDto.Ort.class),
                Map.entry("OrtZuordnung", OrtDto.Zuordnung.class),
                Map.entry("OrtFlaechenStand", OrtDto.FlaechenStand.class),
                Map.entry("OrtRueckwirkung", OrtDto.Rueckwirkung.class),
                Map.entry("OrtsbaumAmStichtag", OrtsbaumLesemodell.OrtsbaumAmStichtag.class),
                Map.entry("OrtsbaumGebaeude", OrtsbaumLesemodell.Gebaeude.class),
                Map.entry("OrtsbaumBereich", OrtsbaumLesemodell.Bereich.class),
                // IP-15: der Grabstein und die Aktionen je Knoten
                Map.entry("OrtsbaumArchivierterOrt", OrtsbaumLesemodell.ArchivierterOrt.class),
                Map.entry("OrtAktionen", OrtAktionen.Aktionen.class),
                Map.entry("OrtArchivierenAktion", OrtAktionen.Archivieren.class),
                Map.entry("OrtMitarchiviert", OrtAktionen.Mitarchiviert.class),
                Map.entry("OrtWiederherstellenAktion", OrtAktionen.Wiederherstellen.class),
                Map.entry("OrtLoeschenAktion", OrtAktionen.Loeschen.class));
        formen.forEach((name, form) -> {
            List<String> felder = Arrays.stream(form.getRecordComponents()).map(c -> c.getName()).toList();
            assertThat(map(schema(name), "properties").keySet()).as(name).containsExactlyInAnyOrderElementsOf(felder);
        });
        assertThat(map(schema("OrtsbaumDirektAmStandort"), "properties").keySet()).containsExactlyInAnyOrderElementsOf(
                Arrays.stream(OrtsbaumLesemodell.DirektAmStandort.class.getRecordComponents())
                        .map(c -> c.getName()).toList());
    }

    /** Anlage zuordnen/umziehen (IP-11): Rumpf und Antwort sind die Formen der Schnittstelle. */
    @Test
    void dieFormenDesUmzugsSindDieDerSchnittstelle() {
        Map<String, Class<?>> formen = Map.of(
                "AnlageUmzugAnfrage", AnlageUmzugDto.Anfrage.class,
                "AnlageUmzug", AnlageUmzugDto.Umzug.class,
                "AnlageUmzugStandort", AnlageUmzugDto.StandortRef.class,
                "AnlageUmzugZuordnung", AnlageUmzugDto.Zuordnung.class);
        formen.forEach((name, form) -> {
            List<String> felder = Arrays.stream(form.getRecordComponents()).map(c -> c.getName()).toList();
            assertThat(map(schema(name), "properties").keySet()).as(name).containsExactlyInAnyOrderElementsOf(felder);
        });
        assertThat(liste(schema("AnlageUmzug"), "properties", "bleibt", "items", "enum"))
                .containsExactlyElementsOf(AnlageUmzugService.BLEIBT);
        assertThat(OrtAbgelehnt.CODES).contains("vor_dem_ersten_intervall", "objekt_archiviert", "gleicher_tag",
                "ziel_ist_bisheriger_eltern");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> schema(String name) {
        Map<String, Object> s = (Map<String, Object>) schemas.get(name);
        assertThat(s).as("Schema %s", name).isNotNull();
        return s;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Map<String, Object> m, String key) {
        return (Map<String, Object>) m.get(key);
    }

    @SuppressWarnings("unchecked")
    private static List<String> liste(Map<String, Object> m, String... pfad) {
        Object o = m;
        for (String k : pfad) {
            o = ((Map<String, Object>) o).get(k);
        }
        return (List<String>) o;
    }
}
