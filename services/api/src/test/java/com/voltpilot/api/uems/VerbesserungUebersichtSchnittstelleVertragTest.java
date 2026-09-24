package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.web.VerbesserungUebersichtController;
import com.voltpilot.api.web.dto.VerbesserungUebersichtDto;
import com.voltpilot.api.zugriff.Recht;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.lang.reflect.RecordComponent;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.web.bind.annotation.GetMapping;
import org.yaml.snakeyaml.Yaml;

/**
 * Die Übersicht „Ziele und Maßnahmen“ (UEMS AP-18 IP-19): DTO und OpenAPI laufen nicht auseinander, die Wörter sind die
 * des Vertrags {@code verbesserung.md} (Vokabulare von {@link VerbesserungRegeln}), die Lese-Route trägt kein
 * {@link Recht}. Rein — kein Spring, keine Datenbank.
 */
class VerbesserungUebersichtSchnittstelleVertragTest {

    @SuppressWarnings("unchecked")
    private static Map<String, Object> api() throws Exception {
        try (InputStream in = Files.newInputStream(Path.of("..", "..", "docs", "contracts", "openapi.yaml"))) {
            return new Yaml().load(in);
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> schema(String name) throws Exception {
        return (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) api().get("components"))
                .get("schemas")).get(name);
    }

    private static String snake(String name) {
        return name.replaceAll("([a-z0-9])([A-Z])", "$1_$2").toLowerCase();
    }

    @SuppressWarnings("unchecked")
    private static List<Object> aufzaehlung(Map<String, Object> s, String feld) {
        return (List<Object>) ((Map<String, Object>) ((Map<String, Object>) s.get("properties")).get(feld)).get("enum");
    }

    @Test
    @SuppressWarnings("unchecked")
    void dieFormenSindDieDesDto() throws Exception {
        Map<String, Class<? extends Record>> formen = Map.of("VerbesserungUebersicht",
                VerbesserungUebersichtDto.Uebersicht.class, "VerbesserungUebersichtZaehler",
                VerbesserungUebersichtDto.Zaehler.class, "VerbesserungUebersichtZeile",
                VerbesserungUebersichtDto.Zeile.class);
        for (var f : formen.entrySet()) {
            Map<String, Object> s = schema(f.getKey());
            assertThat(s).as(f.getKey()).isNotNull();
            List<String> dto = Arrays.stream(f.getValue().getRecordComponents()).map(RecordComponent::getName)
                    .map(VerbesserungUebersichtSchnittstelleVertragTest::snake).toList();
            assertThat(((Map<String, Object>) s.get("properties")).keySet()).as(f.getKey())
                    .containsExactlyElementsOf(dto);
            assertThat((List<String>) s.get("required")).as(f.getKey() + " required").containsExactlyElementsOf(dto);
        }
        Map<String, Object> pfad = (Map<String, Object>) ((Map<String, Object>) api().get("paths"))
                .get("/api/v1/verbesserung/uebersicht");
        assertThat(pfad).containsOnlyKeys("get");
    }

    /** Die Art einer Zeile ist genau {@code frist_art}, das Wort der Fälligkeit genau {@code frist_faellig}. */
    @Test
    void dieWoerterSindDieDesVertrags() throws Exception {
        Map<String, Object> zeile = schema("VerbesserungUebersichtZeile");
        assertThat(aufzaehlung(zeile, "art")).isEqualTo(VerbesserungRegeln.VOKABULARE.get("frist_art"));
        assertThat(aufzaehlung(zeile, "faellig")).isEqualTo(VerbesserungRegeln.VOKABULARE.get("frist_faellig"));
    }

    @Test
    void leseRouteTraegtKeinRecht() {
        for (Method m : VerbesserungUebersichtController.class.getDeclaredMethods()) {
            if (m.isAnnotationPresent(GetMapping.class)) {
                assertThat(m.isAnnotationPresent(Recht.class)).as(m.getName()).isFalse();
            }
        }
    }
}
