package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.KostenstelleEnergieDto;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Die Kostenstellen-Sicht (UEMS AP-10 IP-11) sagt an zwei Stellen dasselbe: in Java ({@link KostenstelleEnergieDto},
 * {@link KostenstelleEnergieRegeln}) und in {@code docs/contracts/openapi.yaml}. Das Portal ({@code api.ts}) kommt mit
 * der Fläche (IP-15) dazu. Rein — ohne Spring, ohne Datenbank.
 */
class KostenstelleEnergieSchnittstelleVertragTest {

    private static final Path OPENAPI = Path.of("..", "..", "docs", "contracts", "openapi.yaml");
    private static final String ROUTE = "/api/v1/unternehmen/kostenstellen/{id}/energie";
    private static Map<String, Object> schemas;
    private static Map<String, Object> pfade;

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void lies() throws Exception {
        try (InputStream in = Files.newInputStream(OPENAPI)) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
            pfade = (Map<String, Object>) openapi.get("paths");
        }
    }

    @Test
    void dieFormenSindZeichengleich() {
        Map<String, Class<? extends Record>> formen = new LinkedHashMap<>();
        formen.put("KostenstelleEnergie", KostenstelleEnergieDto.Energie.class);
        formen.put("KostenstelleEnergieKostenstelle", KostenstelleEnergieDto.Kostenstelle.class);
        formen.put("KostenstelleEnergieBlock", KostenstelleEnergieDto.Block.class);
        formen.put("KostenstelleEnergieSumme", KostenstelleEnergieDto.Summe.class);
        formen.put("KostenstelleEnergiePosten", KostenstelleEnergieDto.Posten.class);
        formen.put("KostenstelleEnergieMessstelle", KostenstelleEnergieDto.MessstelleRef.class);
        formen.put("KostenstelleEnergieTag", KostenstelleEnergieDto.Tag.class);
        formen.forEach((schema, dto) -> {
            List<String> felder = new ArrayList<>();
            Arrays.stream(dto.getRecordComponents()).forEach(c -> felder.add(
                    PropertyNamingStrategies.SnakeCaseStrategy.INSTANCE.translate(c.getName())));
            assertThat(new ArrayList<>(eigenschaften(schema).keySet())).as(schema).containsExactlyElementsOf(felder);
            assertThat(required(schema)).as(schema + " · jedes Feld steht immer da").containsExactlyElementsOf(felder);
        });
    }

    /** Die Gründe ohne Zahl sind die der Regel — ein neuer Grund braucht beide Stellen. */
    @Test
    @SuppressWarnings("unchecked")
    void dieGruendeSindDieDerRegel() {
        List<Object> block = new ArrayList<>(
                (List<Object>) ((Map<String, Object>) eigenschaften("KostenstelleEnergieBlock").get("grund")).get("enum"));
        List<Object> tag = new ArrayList<>(
                (List<Object>) ((Map<String, Object>) eigenschaften("KostenstelleEnergieTag").get("grund")).get("enum"));
        block.remove(null);
        tag.remove(null);
        List<Object> alle = new ArrayList<>(block);
        alle.addAll(tag);
        assertThat(alle).containsExactlyInAnyOrderElementsOf(KostenstelleEnergieRegeln.GRUENDE);
    }

    /** Die Perioden sind die des Dienstes; die Route nennt ihr Recht — eingetragen, nicht durchgesetzt. */
    @Test
    @SuppressWarnings("unchecked")
    void periodenUndRechtStehenAnDerRoute() {
        assertThat((List<String>) ((Map<String, Object>) eigenschaften("KostenstelleEnergie").get("periode")).get("enum"))
                .containsExactlyElementsOf(KostenstelleEnergieService.PERIODEN);
        Map<String, Object> route = (Map<String, Object>) pfade.get(ROUTE);
        assertThat(route).as(ROUTE).isNotNull();
        assertThat(route.keySet()).containsExactlyInAnyOrder("parameters", "get");
        Map<String, Object> get = (Map<String, Object>) route.get("get");
        assertThat(String.valueOf(get.get("description"))).contains("messstelle.ansehen").contains("nicht_verteilt");
        assertThat(((Map<String, Object>) get.get("responses")).keySet())
                .containsExactlyInAnyOrder("200", "400", "401", "404");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> eigenschaften(String schema) {
        Map<String, Object> s = (Map<String, Object>) schemas.get(schema);
        assertThat(s).as(schema).isNotNull();
        return (Map<String, Object>) s.get("properties");
    }

    @SuppressWarnings("unchecked")
    private static List<String> required(String schema) {
        return (List<String>) ((Map<String, Object>) schemas.get(schema)).get("required");
    }
}
