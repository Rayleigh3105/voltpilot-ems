package com.voltpilot.api.grundlast;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.grundlast.GrundlastRegel.RestGrund;
import com.voltpilot.api.grundlast.GrundlastRegel.Status;
import com.voltpilot.api.grundlast.GrundlastService.Zeitraum;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Rein, ohne Docker: {@link GrundlastDto} und {@code docs/contracts/openapi.yaml} → {@code Grundlast} nennen
 * dieselben Felder und Wörter. Das Portal liest denselben Vertrag ({@code api.ts} {@code Grundlast}).
 */
class GrundlastVertragTest {

    private static final Path OPENAPI = Path.of("..", "..", "docs", "contracts", "openapi.yaml");

    private static Map<String, Object> schema;
    private static Map<String, Object> pfad;

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void lade() throws IOException {
        try (InputStream in = Files.newInputStream(OPENAPI)) {
            Map<String, Object> openapi = new Yaml().load(in);
            schema = map(map(map(openapi, "components"), "schemas"), "Grundlast");
            pfad = map(map(openapi, "paths"), "/api/v1/sites/{siteId}/grundlast");
        }
    }

    @Test
    void jedesFeldStehtImVertrag() {
        Map<String, Object> props = map(schema, "properties");
        assertThat(props.keySet()).containsExactlyInAnyOrderElementsOf(felder(GrundlastDto.class));
        assertThat(map(map(map(props, "naechte"), "items"), "properties").keySet())
                .containsExactlyInAnyOrderElementsOf(felder(GrundlastDto.NachtDto.class));
        assertThat(map(map(map(props, "monate"), "items"), "properties").keySet())
                .containsExactlyInAnyOrderElementsOf(felder(GrundlastDto.MonatDto.class));
        assertThat(map(map(props, "stufe"), "properties").keySet())
                .containsExactlyInAnyOrderElementsOf(felder(GrundlastDto.StufeDto.class));
        assertThat(map(map(map(props, "teile"), "items"), "properties").keySet())
                .containsExactlyInAnyOrderElementsOf(felder(GrundlastDto.TeilDto.class));
        assertThat(map(map(props, "rest"), "properties").keySet())
                .containsExactlyInAnyOrderElementsOf(felder(GrundlastDto.RestDto.class));
    }

    @Test
    void dieWoerterSindDieDerRegel() {
        Map<String, Object> props = map(schema, "properties");
        assertThat(woerter(map(map(map(map(props, "naechte"), "items"), "properties"), "status")))
                .containsExactlyInAnyOrderElementsOf(klein(Status.values()));
        assertThat(woerter(map(map(map(props, "rest"), "properties"), "grund")))
                .containsExactlyInAnyOrderElementsOf(klein(RestGrund.values()));
        assertThat(woerter(map(props, "z"))).containsExactlyInAnyOrderElementsOf(klein(Zeitraum.values()));
    }

    @Test
    @SuppressWarnings("unchecked")
    void derZeitraumParameterKenntDieselbenWoerter() {
        List<Map<String, Object>> params = (List<Map<String, Object>>) map(pfad, "get").get("parameters");
        Map<String, Object> z = params.stream().filter(p -> "z".equals(p.get("name"))).findFirst().orElseThrow();
        assertThat(woerter(map(z, "schema"))).containsExactlyInAnyOrderElementsOf(klein(Zeitraum.values()));
    }

    private static List<String> felder(Class<? extends Record> typ) {
        return Arrays.stream(typ.getRecordComponents()).map(c -> c.getName()).toList();
    }

    private static List<String> klein(Enum<?>[] werte) {
        return Arrays.stream(werte).map(e -> e.name().toLowerCase(Locale.ROOT)).toList();
    }

    @SuppressWarnings("unchecked")
    private static List<String> woerter(Map<String, Object> m) {
        return (List<String>) m.get("enum");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Map<String, Object> m, String key) {
        Object v = m.get(key);
        assertThat(v).as(key).isInstanceOf(Map.class);
        return (Map<String, Object>) v;
    }
}
