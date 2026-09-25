package com.voltpilot.api.zugriff;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.SelbstauskunftDto;
import java.io.InputStream;
import java.lang.reflect.RecordComponent;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Die Selbstauskunft (UEMS AP-03 IP-4) sagt in Java ({@link SelbstauskunftDto}) und in {@code docs/contracts/openapi.yaml}
 * dasselbe: jedes Feld jeder Form, der Kopf {@code X-Kundenbereich} und die Route. Rein — ohne Spring, ohne Datenbank.
 * Die Typen im Portal ({@code api.ts}) folgen der OpenAPI-Form.
 */
class SelbstauskunftSchnittstelleVertragTest {

    private static final Path OPENAPI = Path.of("..", "..", "docs", "contracts", "openapi.yaml");
    private static final PropertyNamingStrategies.SnakeCaseStrategy SNAKE =
            new PropertyNamingStrategies.SnakeCaseStrategy();

    private static final Map<Class<?>, String> FORMEN = formen();

    private static Map<String, Object> schemas;
    private static Map<String, Object> parameter;
    private static Map<String, Object> pfade;

    private static Map<Class<?>, String> formen() {
        Map<Class<?>, String> m = new LinkedHashMap<>();
        m.put(SelbstauskunftDto.class, "Selbstauskunft");
        m.put(SelbstauskunftDto.Kundenbereich.class, "SelbstauskunftKundenbereich");
        m.put(SelbstauskunftDto.Beendet.class, "SelbstauskunftKundenbereichBeendet");
        m.put(SelbstauskunftDto.Standort.class, "SelbstauskunftStandort");
        m.put(SelbstauskunftDto.Kuenftig.class, "SelbstauskunftKuenftig");
        m.put(SelbstauskunftDto.Teilansicht.class, "SelbstauskunftTeilansicht");
        m.put(SelbstauskunftDto.Unterstuetzungen.class, "SelbstauskunftUnterstuetzungen");
        m.put(SelbstauskunftDto.Unterstuetzung.class, "SelbstauskunftUnterstuetzung");
        m.put(SelbstauskunftDto.Person.class, "SelbstauskunftPerson");
        return m;
    }

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void lies() throws Exception {
        try (InputStream in = Files.newInputStream(OPENAPI)) {
            Map<String, Object> openapi = new Yaml().load(in);
            Map<String, Object> components = (Map<String, Object>) openapi.get("components");
            schemas = (Map<String, Object>) components.get("schemas");
            parameter = (Map<String, Object>) components.get("parameters");
            pfade = (Map<String, Object>) openapi.get("paths");
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void jedesFeldJederFormStehtInJavaUndOpenApiUndIstPflicht() {
        FORMEN.forEach((typ, name) -> {
            Map<String, Object> schema = (Map<String, Object>) schemas.get(name);
            assertThat(schema).as(name).isNotNull();
            Set<String> java = Arrays.stream(typ.getRecordComponents()).map(RecordComponent::getName)
                    .map(SNAKE::translate).collect(Collectors.toCollection(TreeSet::new));
            Set<String> yaml = new TreeSet<>(((Map<String, Object>) schema.get("properties")).keySet());
            assertThat(yaml).as(name).isEqualTo(java);
            assertThat(new TreeSet<>((List<String>) schema.get("required"))).as(name + " required").isEqualTo(java);
        });
    }

    @Test
    @SuppressWarnings("unchecked")
    void dieRouteAntwortetMitDerSelbstauskunftUndNenntDenKopf() {
        Map<String, Object> get = (Map<String, Object>) ((Map<String, Object>) pfade.get("/api/v1/me")).get("get");
        Map<String, Object> ok = (Map<String, Object>) ((Map<String, Object>) get.get("responses")).get("200");
        Map<String, Object> schema = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>)
                ok.get("content")).get("application/json")).get("schema");
        assertThat(schema.get("$ref")).isEqualTo("#/components/schemas/Selbstauskunft");
        assertThat((List<Map<String, Object>>) get.get("parameters"))
                .anySatisfy(p -> assertThat(p.get("$ref")).isEqualTo("#/components/parameters/Kundenbereich"));

        Map<String, Object> kopf = (Map<String, Object>) parameter.get("Kundenbereich");
        assertThat(kopf.get("name")).isEqualTo(ZugriffKontextLader.KUNDENBEREICH_HEADER);
        assertThat(kopf.get("in")).isEqualTo("header");
    }
}
