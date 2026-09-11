package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.GeraetDto;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Rein, ohne Docker: die Geräte-Schnittstelle sagt in drei Dateien DASSELBE — die Migration
 * {@code V20260911200000} (die geschlossenen Wörter der CHECKs), die Java-Form
 * ({@link GeraetDto}) und {@code docs/contracts/openapi.yaml}.
 */
class GeraetSchnittstelleVertragTest {

    private static final Path OPENAPI = Path.of("..", "..", "docs", "contracts", "openapi.yaml");
    private static final String MIGRATION = "/db/migration/V20260911200000__uems_geraet.sql";
    private static final PropertyNamingStrategies.SnakeCaseStrategy SNAKE =
            new PropertyNamingStrategies.SnakeCaseStrategy();

    private static Map<String, Object> schemas;
    private static Map<String, Object> paths;
    private static String migration;

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void lade() throws IOException {
        try (InputStream in = Files.newInputStream(OPENAPI)) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
            paths = (Map<String, Object>) openapi.get("paths");
        }
        try (InputStream in = GeraetSchnittstelleVertragTest.class.getResourceAsStream(MIGRATION)) {
            migration = new String(Objects.requireNonNull(in, MIGRATION).readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    @Test
    void jedeFormDerSchnittstelleIstDieDerOpenApiUndJedesFeldIstPflicht() {
        for (Object[] paar : new Object[][] {{"Geraet", GeraetDto.Geraet.class},
                {"GeraetKomponente", GeraetDto.Komponente.class}, {"GeraetTeil", GeraetDto.Teil.class},
                {"GeraetVorgaenger", GeraetDto.Vorgaenger.class}}) {
            Map<String, Object> schema = schema((String) paar[0]);
            List<String> dto = Arrays.stream(((Class<?>) paar[1]).getRecordComponents())
                    .map(c -> SNAKE.translate(c.getName())).toList();
            assertThat(map(schema, "properties").keySet()).as((String) paar[0])
                    .containsExactlyInAnyOrderElementsOf(dto);
            // Ein Feld fehlt nie — „nicht erhoben" ist null, nicht abwesend.
            assertThat(liste(schema, "required")).as((String) paar[0]).containsExactlyInAnyOrderElementsOf(dto);
        }
        assertThat(map(schema("GeraetListe"), "properties").keySet()).containsExactly("geraete");
        assertThat(Arrays.stream(GeraetDto.Liste.class.getRecordComponents()).map(c -> c.getName()))
                .containsExactly("geraete");
        assertThat(paths).containsKeys("/api/v1/sites/{siteId}/geraete", "/api/v1/geraete/{id}");
    }

    @Test
    void dieGeschlossenenWoerterSindDieDerMigration() {
        assertThat(liste(map(map(schema("Geraet"), "properties"), "geraeteart"), "enum"))
                .containsExactlyElementsOf(checkWoerter("geraet_geraeteart_chk", "geraeteart"));
        assertThat(liste(map(map(schema("GeraetTeil"), "properties"), "teilart"), "enum"))
                .containsExactlyElementsOf(checkWoerter("geraet_teil_teilart_chk", "teilart"));
    }

    /** Die Wörter aus {@code CONSTRAINT <name> CHECK (<spalte> IN ('a', 'b', …))} der Migration. */
    private static List<String> checkWoerter(String constraint, String spalte) {
        Matcher m = Pattern.compile("CONSTRAINT " + constraint + "\\s+CHECK\\s*\\(" + spalte
                + "\\s+IN\\s*\\(([^)]*)\\)").matcher(migration);
        assertThat(m.find()).as(constraint).isTrue();
        List<String> woerter = new ArrayList<>();
        Matcher w = Pattern.compile("'([^']*)'").matcher(m.group(1));
        while (w.find()) {
            woerter.add(w.group(1));
        }
        return woerter;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> schema(String name) {
        Map<String, Object> s = (Map<String, Object>) schemas.get(name);
        assertThat(s).as("components.schemas." + name).isNotNull();
        return s;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Map<String, Object> m, String key) {
        return (Map<String, Object>) m.get(key);
    }

    @SuppressWarnings("unchecked")
    private static List<String> liste(Map<String, Object> m, String key) {
        return ((List<Object>) m.get(key)).stream().map(String::valueOf).toList();
    }
}
