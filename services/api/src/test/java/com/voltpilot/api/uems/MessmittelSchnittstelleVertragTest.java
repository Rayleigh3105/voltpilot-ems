package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.MessmittelDto;
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
 * Rein, ohne Docker (AP-16 IP-15/IP-16): die Messmittel-Schnittstelle sagt in vier Dateien DASSELBE — die Migration
 * {@code V20260922245000} (CHECK der Prüfungsarten), die Java-Form ({@link MessmittelDto},
 * {@link MessmittelService#PRUEFUNGSARTEN}), {@code docs/contracts/openapi.yaml} und das Vokabular der
 * Referenzdatei ({@code uems-referenzunternehmen.schema.json}, {@code messmittel_angaben.pruefungsart}).
 */
class MessmittelSchnittstelleVertragTest {
    private static final Path OPENAPI = Path.of("..", "..", "docs", "contracts", "openapi.yaml");
    private static final Path REFERENZ = Path.of("..", "..", "docs", "contracts", "v2",
            "uems-referenzunternehmen.schema.json");
    private static final String MIGRATION = "/db/migration/V20260922245000__uems_messmittel_angaben.sql";
    private static final PropertyNamingStrategies.SnakeCaseStrategy SNAKE =
            new PropertyNamingStrategies.SnakeCaseStrategy();

    private static Map<String, Object> schemas;
    private static String migration;

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void lade() throws IOException {
        try (InputStream in = Files.newInputStream(OPENAPI)) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
        }
        try (InputStream in = MessmittelSchnittstelleVertragTest.class.getResourceAsStream(MIGRATION)) {
            migration = new String(Objects.requireNonNull(in, MIGRATION).readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    @Test
    void jedeAntwortFormIstDieDerOpenApiUndJedesFeldIstPflicht() {
        for (Object[] paar : new Object[][] {{"MessmittelAngaben", MessmittelDto.Angaben.class},
                {"MessmittelBeleg", MessmittelDto.Beleg.class}, {"MessmittelWandler", MessmittelDto.Wandler.class},
                {"MessmittelHerstellerangabe", MessmittelDto.Herstellerangabe.class}}) {
            Map<String, Object> schema = map(schemas, (String) paar[0]);
            List<String> dto = felder((Class<?>) paar[1]);
            assertThat(map(schema, "properties").keySet()).as((String) paar[0]).containsExactlyElementsOf(dto);
            assertThat(liste(schema, "required")).as((String) paar[0]).containsExactlyElementsOf(dto);
        }
        Map<String, Object> eintrag = map(schemas, "MessmittelEintrag");
        assertThat(map(eintrag, "properties").keySet()).containsExactlyElementsOf(felder(MessmittelDto.Eintrag.class));
        assertThat(eintrag.get("required")).as("was fehlt, ist nicht erhoben").isNull();
    }

    @Test
    void pruefungsartenSindUeberallDieselben() throws IOException {
        List<String> mitNichtErhoben = new ArrayList<>(MessmittelService.PRUEFUNGSARTEN);
        mitNichtErhoben.add(MessmittelService.NICHT_ERHOBEN);
        assertThat(liste(map(map(schemas, "MessmittelAngaben"), "properties"), "pruefungsart", "enum"))
                .containsExactlyElementsOf(mitNichtErhoben);
        List<Object> eintrag = new ArrayList<>(mitNichtErhoben);
        eintrag.add(null);
        assertThat(liste(map(map(schemas, "MessmittelEintrag"), "properties"), "pruefungsart", "enum"))
                .containsExactlyElementsOf(eintrag);
        JsonNode referenz = new ObjectMapper().readTree(REFERENZ.toFile())
                .at("/properties/messmittel_angaben/items/properties/pruefungsart/enum");
        List<String> ref = new ArrayList<>();
        referenz.forEach(n -> ref.add(n.asText()));
        assertThat(ref).containsExactlyElementsOf(mitNichtErhoben);
        // In der Datenbank ist „nicht erhoben“ NULL — der CHECK kennt genau die übrigen Wörter.
        Matcher m = Pattern.compile("geraet_pruefungsart_chk CHECK \\(pruefungsart IS NULL OR pruefungsart IN\\s*"
                + "\\(([^)]*)\\)\\)").matcher(migration);
        assertThat(m.find()).isTrue();
        assertThat(Arrays.stream(m.group(1).split(",")).map(w -> w.strip().replace("'", "")).toList())
                .containsExactlyElementsOf(MessmittelService.PRUEFUNGSARTEN);
    }

    private static List<String> felder(Class<?> record) {
        return Arrays.stream(record.getRecordComponents()).map(c -> SNAKE.translate(c.getName())).toList();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Map<String, Object> m, String k) {
        return (Map<String, Object>) Objects.requireNonNull(m.get(k), k);
    }

    @SuppressWarnings("unchecked")
    private static List<Object> liste(Map<String, Object> m, String... pfad) {
        Map<String, Object> aktuell = m;
        for (int i = 0; i < pfad.length - 1; i++) {
            aktuell = map(aktuell, pfad[i]);
        }
        return (List<Object>) Objects.requireNonNull(aktuell.get(pfad[pfad.length - 1]), pfad[pfad.length - 1]);
    }
}
