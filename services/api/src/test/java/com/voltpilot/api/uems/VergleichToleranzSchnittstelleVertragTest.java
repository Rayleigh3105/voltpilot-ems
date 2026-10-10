package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.VergleichToleranzDto;
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
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Rein, ohne Docker (AP-16 IP-17): die Toleranz-Schnittstelle sagt in fünf Dateien DASSELBE — die Java-Form
 * ({@link VergleichToleranzDto}), {@code openapi.yaml}, das Vektor-Schema der Regel {@code monatsvergleich}
 * ({@code bewertung.schema.json}), der Vertrag ({@code bewertung.md}: Startwert 2 %) und die Migration
 * {@code V20260922251700} (Fassung 1 nie gespeichert, Prozent über 0 bis 100).
 */
class VergleichToleranzSchnittstelleVertragTest {
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final Path OPENAPI = Path.of("..", "..", "docs", "contracts", "openapi.yaml");
    private static final String MIGRATION = "/db/migration/V20260922251700__uems_vergleich_toleranz.sql";
    private static final PropertyNamingStrategies.SnakeCaseStrategy SNAKE =
            new PropertyNamingStrategies.SnakeCaseStrategy();

    private static Map<String, Object> schemas;
    private static String migration;
    private static JsonNode regel;

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void lade() throws IOException {
        try (InputStream in = Files.newInputStream(OPENAPI)) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
        }
        try (InputStream in = VergleichToleranzSchnittstelleVertragTest.class.getResourceAsStream(MIGRATION)) {
            migration = new String(Objects.requireNonNull(in, MIGRATION).readAllBytes(), StandardCharsets.UTF_8);
        }
        for (JsonNode zweig : new ObjectMapper().readTree(V2.resolve("bewertung.schema.json").toFile())
                .at("/properties/cases/items/anyOf")) {
            if ("monatsvergleich".equals(zweig.at("/properties/operation/const").asText())) regel = zweig;
        }
    }

    @Test
    void jedeAntwortFormIstDieDerOpenApiUndJedesFeldIstPflicht() {
        for (Object[] paar : new Object[][] {{"VergleichToleranzVergleich", VergleichToleranzDto.Vergleich.class},
                {"VergleichToleranzQuelle", VergleichToleranzDto.Vergleichsquelle.class},
                {"VergleichToleranzMonat", VergleichToleranzDto.Monat.class},
                {"VergleichToleranzBefund", VergleichToleranzDto.Befund.class},
                {"VergleichToleranzFassung", VergleichToleranzDto.Toleranz.class},
                {"VergleichToleranzEintrag", VergleichToleranzDto.Eintrag.class}}) {
            Map<String, Object> schema = map(schemas, (String) paar[0]);
            List<String> dto = felder((Class<?>) paar[1]);
            assertThat(map(schema, "properties").keySet()).as((String) paar[0]).containsExactlyElementsOf(dto);
            assertThat(liste(schema, "required")).as((String) paar[0]).containsExactlyElementsOf(dto);
        }
    }

    @Test
    void zustandUndGrundSindDieDerRegel() {
        List<Object> zustand = liste(map(map(schemas, "VergleichToleranzMonat"), "properties"), "zustand", "enum");
        assertThat(zustand).containsExactly(BewertungRegeln.PASST, BewertungRegeln.ABWEICHUNG,
                BewertungRegeln.NICHT_VERGLEICHBAR);
        assertThat(woerter(regel.at("/properties/erwartet/properties/zustand/enum"))).isEqualTo(zustand);
        List<Object> grund = new ArrayList<>(liste(map(map(schemas, "VergleichToleranzMonat"), "properties"),
                "grund", "enum"));
        assertThat(grund.remove(null)).as("grund ist nullable").isTrue();
        assertThat(woerter(regel.at("/properties/erwartet/properties/grund/anyOf/0/enum"))).isEqualTo(grund);
        assertThat(liste(map(map(schemas, "VergleichToleranzBefund"), "properties"), "art", "enum"))
                .containsExactly(VergleichToleranzService.BEFUND);
        assertThat(liste(map(map(schemas, "VergleichToleranzQuelle"), "properties"), "monatsvergleich", "enum"))
                .containsExactly(VergleichToleranzService.MIT_MONATSVERGLEICH, VergleichToleranzService.OHNE_MONATSMENGE);
    }

    @Test
    void startwertUndSchrankenStehenInVertragUndMigration() throws IOException {
        String vertrag = Files.readString(V2.resolve("bewertung.md"));
        assertThat(VergleichToleranzService.STARTWERT_PROZENT).isEqualTo("2");
        assertThat(vertrag).contains("Toleranz je Vergleichsquelle 2 % pro Monat")
                .contains("V20260922251700");
        assertThat(migration).contains("CHECK (fassung >= 2)").contains("CHECK (prozent > 0 AND prozent <= 100)")
                .contains("FORCE ROW LEVEL SECURITY").contains("GRANT SELECT, INSERT ON vergleich_toleranz TO ${appDbUser}");
    }

    private static List<Object> woerter(JsonNode n) {
        List<Object> aus = new ArrayList<>();
        n.forEach(x -> aus.add(x.asText()));
        return aus;
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
