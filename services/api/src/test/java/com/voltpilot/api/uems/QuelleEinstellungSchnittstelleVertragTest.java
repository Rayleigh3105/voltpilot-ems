package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.EinstellungDto;
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
 * Rein, ohne Docker: die Einstellungs-Schnittstelle sagt in vier Dateien DASSELBE — die Migration
 * {@code V20260911280000} (die geschlossenen Wörter der CHECKs), die Regeln
 * ({@link QuelleEinstellungRegeln}), die Java-Form ({@link EinstellungDto}) und
 * {@code docs/contracts/openapi.yaml}.
 */
class QuelleEinstellungSchnittstelleVertragTest {

    private static final Path OPENAPI = Path.of("..", "..", "docs", "contracts", "openapi.yaml");
    private static final String MIGRATION = "/db/migration/V20260911280000__uems_quelle_einstellung.sql";
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
        try (InputStream in = QuelleEinstellungSchnittstelleVertragTest.class.getResourceAsStream(MIGRATION)) {
            migration = new String(Objects.requireNonNull(in, MIGRATION).readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    @Test
    void jedeFormDerSchnittstelleIstDieDerOpenApi() {
        for (Object[] paar : new Object[][] {{"Einstellungen", EinstellungDto.Einstellungen.class},
                {"EinstellungFassung", EinstellungDto.Fassung.class},
                {"EinstellungEintrag", EinstellungDto.Eintrag.class},
                {"EinstellungEingetragen", EinstellungDto.Eingetragen.class}}) {
            Map<String, Object> schema = schema((String) paar[0]);
            List<String> dto = felder((Class<?>) paar[1]);
            assertThat(map(schema, "properties").keySet()).as((String) paar[0]).containsExactlyInAnyOrderElementsOf(dto);
            // Ein Feld fehlt nie — „keins" ist null, nicht abwesend.
            assertThat(liste(schema, "required")).as((String) paar[0]).containsExactlyInAnyOrderElementsOf(dto);
        }
        Map<String, Object> neu = schema("EinstellungNeu");
        assertThat(map(neu, "properties").keySet()).containsExactlyInAnyOrderElementsOf(felder(EinstellungDto.Neu.class));
        assertThat(liste(neu, "required")).containsExactlyInAnyOrder("art", "wert", "anwendung", "gueltig_ab");
        assertThat(neu.get("additionalProperties")).isEqualTo(false);

        @SuppressWarnings("unchecked")
        Map<String, Object> route = (Map<String, Object>) paths.get("/api/v1/geraete/{id}/einstellungen");
        assertThat(route).containsKeys("get", "post");
    }

    @Test
    void dieGeschlossenenWoerterSindDieDerRegelnUndDerMigration() {
        List<String> arten = Arrays.stream(QuelleEinstellungRegeln.Art.values()).map(QuelleEinstellungRegeln.Art::code)
                .toList();
        assertThat(checkWoerter("quelle_einstellung_art_chk", "art")).containsExactlyElementsOf(arten);
        assertThat(checkWoerter("quelle_einstellung_anwendung_chk", "anwendung"))
                .containsExactlyElementsOf(QuelleEinstellungRegeln.ANWENDUNGEN);
        assertThat(checkWoerter("quelle_einstellung_herkunft_chk", "herkunft"))
                .containsExactlyElementsOf(QuelleEinstellungRegeln.HERKUENFTE);

        Map<String, Object> fassung = map(schema("EinstellungFassung"), "properties");
        assertThat(liste(map(fassung, "art"), "enum")).containsExactlyElementsOf(arten);
        assertThat(liste(map(map(schema("EinstellungNeu"), "properties"), "art"), "enum")).containsExactlyElementsOf(arten);
        assertThat(liste(map(fassung, "anwendung"), "enum")).containsExactlyElementsOf(QuelleEinstellungRegeln.ANWENDUNGEN);
        assertThat(liste(map(fassung, "herkunft"), "enum")).containsExactlyElementsOf(QuelleEinstellungRegeln.HERKUENFTE);
        assertThat(liste(map(fassung, "zustellung"), "enum"))
                .containsExactlyElementsOf(QuelleEinstellungRegeln.ZUSTELLUNGEN);
        assertThat(liste(map(fassung, "status"), "enum")).containsExactlyElementsOf(QuelleEinstellungRegeln.STATUS);
        assertThat(liste(map(map(schema("EinstellungFehler"), "properties"), "code"), "enum"))
                .containsExactlyElementsOf(EinstellungAbgelehnt.CODES);
    }

    private static List<String> felder(Class<?> record) {
        return Arrays.stream(record.getRecordComponents()).map(c -> SNAKE.translate(c.getName())).toList();
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
