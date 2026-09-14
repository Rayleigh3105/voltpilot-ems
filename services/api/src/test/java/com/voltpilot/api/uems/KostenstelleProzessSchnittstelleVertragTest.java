package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.KostenstelleProzessDto;
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
 * Die Kostenstellen- und Prozess-Schnittstelle (UEMS AP-10 IP-7) sagt an zwei Stellen dasselbe: in
 * Java ({@link KostenstelleProzessAbgelehnt}, {@link KostenstelleProzessDto}) und in
 * {@code docs/contracts/openapi.yaml}. Rein — ohne Spring, ohne Datenbank.
 */
class KostenstelleProzessSchnittstelleVertragTest {

    private static final Path OPENAPI = Path.of("..", "..", "docs", "contracts", "openapi.yaml");
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
    @SuppressWarnings("unchecked")
    void derSatzDerAblehnungenIstInJavaUndOpenApiDerselbe() {
        Map<String, Object> code = (Map<String, Object>) eigenschaften("KostenstelleProzessFehler").get("code");
        assertThat((List<String>) code.get("enum")).containsExactlyElementsOf(KostenstelleProzessAbgelehnt.CODES);
    }

    @Test
    void dieFormenSindZeichengleich() {
        Map<String, Class<? extends Record>> formen = new LinkedHashMap<>();
        formen.put("KostenstelleProzessAnlegen", KostenstelleProzessDto.Anlegen.class);
        formen.put("KostenstelleProzessUmbenennen", KostenstelleProzessDto.Umbenennen.class);
        formen.put("KostenstelleProzessBeenden", KostenstelleProzessDto.Beenden.class);
        formen.put("Kostenstelle", KostenstelleProzessDto.Kostenstelle.class);
        formen.put("KostenstelleListe", KostenstelleProzessDto.Kostenstellen.class);
        formen.put("Prozess", KostenstelleProzessDto.Prozess.class);
        formen.put("ProzessListe", KostenstelleProzessDto.Prozesse.class);
        formen.put("KostenstelleProzessVerweis", KostenstelleProzessDto.Verweis.class);
        formen.put("MessstelleProzesseSetzen", KostenstelleProzessDto.ProzesseSetzen.class);
        formen.put("MessstelleProzessZuordnung", KostenstelleProzessDto.Zuordnung.class);
        formen.put("MessstelleProzesse", KostenstelleProzessDto.MessstelleProzesse.class);
        formen.forEach((schema, dto) -> {
            List<String> felder = new ArrayList<>();
            Arrays.stream(dto.getRecordComponents()).forEach(c -> felder.add(
                    PropertyNamingStrategies.SnakeCaseStrategy.INSTANCE.translate(c.getName())));
            assertThat(new ArrayList<>(eigenschaften(schema).keySet())).as(schema).containsExactlyElementsOf(felder);
        });
    }

    /** Beenden statt löschen: keine Route der Schnittstelle kennt DELETE. */
    @Test
    @SuppressWarnings("unchecked")
    void keineRouteLoescht() {
        List<String> eigene = pfade.keySet().stream().filter(p -> p.startsWith("/api/v1/unternehmen/kostenstellen")
                || p.startsWith("/api/v1/unternehmen/prozesse") || p.equals("/api/v1/messstellen/{id}/prozesse")).toList();
        // Sieben aus AP-10 IP-7, die achte ist die Kostenstellen-Sicht (AP-10 IP-11, GET …/{id}/energie).
        assertThat(eigene).hasSize(8);
        for (String p : eigene) {
            assertThat(((Map<String, Object>) pfade.get(p)).keySet()).as(p).doesNotContain("delete");
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> eigenschaften(String schema) {
        Map<String, Object> s = (Map<String, Object>) schemas.get(schema);
        assertThat(s).as(schema).isNotNull();
        return (Map<String, Object>) s.get("properties");
    }
}
