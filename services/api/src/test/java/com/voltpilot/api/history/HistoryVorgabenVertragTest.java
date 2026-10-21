package com.voltpilot.api.history;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.erzeuger.VorgabenAbleitung;
import com.voltpilot.api.web.dto.HistoryDto;
import com.voltpilot.api.web.dto.HistoryEventDto;
import com.voltpilot.api.web.dto.HistoryVorgabenDto;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Rein, ohne Docker: die Historie sagt in Java und in {@code docs/contracts/openapi.yaml} dasselbe über die
 * Vorgaben einer Erzeugeranlage (UEMS EZ-9) - die neuen Ereignisarten, das Feld {@code vorgabe} je Ereignis und
 * die Zählung {@code vorgaben}. Das Portal liest denselben Vertrag ({@code historieEreignisse.test.ts}): eine Art,
 * die der Server schickt und der Client nicht kennt, verwürfe er still.
 */
class HistoryVorgabenVertragTest {

    private static final Path OPENAPI = Path.of("..", "..", "docs", "contracts", "openapi.yaml");

    private static Map<String, Object> history;

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void lade() throws IOException {
        try (InputStream in = Files.newInputStream(OPENAPI)) {
            Map<String, Object> openapi = new Yaml().load(in);
            Map<String, Object> schemas =
                    (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
            history = map(schemas, "History");
        }
    }

    @Test
    void jedesFeldDerHistorieUndIhrerEreignisseStehtImVertrag() {
        Map<String, Object> props = map(history, "properties");
        assertThat(props.keySet()).containsExactlyInAnyOrderElementsOf(felder(HistoryDto.class));
        Map<String, Object> ereignis = map(map(props, "events"), "items");
        assertThat(map(ereignis, "properties").keySet())
                .containsExactlyInAnyOrderElementsOf(felder(HistoryEventDto.class));
        assertThat(map(map(map(ereignis, "properties"), "vorgabe"), "properties").keySet())
                .containsExactlyInAnyOrderElementsOf(felder(HistoryEventDto.Vorgabe.class));
        Map<String, Object> vorgaben = map(map(props, "vorgaben"), "properties");
        assertThat(vorgaben.keySet()).containsExactlyInAnyOrderElementsOf(felder(HistoryVorgabenDto.class));
        assertThat(map(map(map(vorgaben, "zaehlung"), "items"), "properties").keySet())
                .containsExactlyInAnyOrderElementsOf(felder(HistoryVorgabenDto.Zaehlung.class));
    }

    @Test
    void dieWoerterDerVorgabenSindDieDerAbleitung() {
        Map<String, Object> ereignis = map(map(map(history, "properties"), "events"), "items");
        List<String> arten = liste(map(map(ereignis, "properties"), "type"), "enum");
        assertThat(arten.subList(arten.size() - Ereignisse.VORGABEN_ARTEN.size(), arten.size()))
                .containsExactlyElementsOf(Ereignisse.VORGABEN_ARTEN);
        Map<String, Object> vorgabe = map(map(map(ereignis, "properties"), "vorgabe"), "properties");
        assertThat(VorgabenAbleitung.ARTEN).containsAll(liste(map(vorgabe, "art"), "enum"));
        assertThat(VorgabenAbleitung.URHEBER).containsAll(liste(map(vorgabe, "urheber"), "enum"));
        Map<String, Object> zaehlung = map(map(map(map(map(history, "properties"), "vorgaben"), "properties"),
                "zaehlung"), "items");
        assertThat(liste(map(map(zaehlung, "properties"), "type"), "enum"))
                .containsExactlyElementsOf(Ereignisse.VORGABEN_ARTEN);
    }

    private static List<String> felder(Class<?> record) {
        return Arrays.stream(record.getRecordComponents()).map(c -> c.getName()).toList();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Map<String, Object> m, String key) {
        Map<String, Object> out = (Map<String, Object>) m.get(key);
        assertThat(out).as(key).isNotNull();
        return out;
    }

    @SuppressWarnings("unchecked")
    private static List<String> liste(Map<String, Object> m, String key) {
        return (List<String>) m.get(key);
    }
}
