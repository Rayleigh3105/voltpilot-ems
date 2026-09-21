package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Ablehnung;
import com.voltpilot.api.web.dto.GemeinsameSteuerungDto;
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
 * Die Schnittstelle der Gemeinsamen Steuerung (UEMS AP-15 IP-5) sagt in Java ({@link GemeinsameSteuerungDto},
 * {@link GemeinsameSteuerungAbgelehnt}) und in {@code docs/contracts/openapi.yaml} dasselbe, und ihre Wörter sind die
 * des Vokabulars {@link SteuerungsverbundVokabular.Ablehnung}. Rein — ohne Spring, ohne Datenbank. Das Portal kennt
 * die Formen erst mit IP-23/IP-24.
 */
class GemeinsameSteuerungSchnittstelleVertragTest {

    private static final Path OPENAPI = Path.of("..", "..", "docs", "contracts", "openapi.yaml");
    private static final String KUNDE = "/api/v1/sites/{siteId}/gemeinsame-steuerung";
    private static final String ADMIN = "/api/v1/admin/sites/{siteId}/gemeinsame-steuerung";
    private static Map<String, Object> schemas;
    private static Map<String, Object> pfade;
    private static String text;

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void lies() throws Exception {
        text = Files.readString(OPENAPI);
        try (InputStream in = Files.newInputStream(OPENAPI)) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
            pfade = (Map<String, Object>) openapi.get("paths");
        }
    }

    @Test
    void dieFormenSindZeichengleich() {
        Map<String, Class<? extends Record>> formen = new LinkedHashMap<>();
        formen.put("GemeinsameSteuerung", GemeinsameSteuerungDto.Zustand.class);
        formen.put("GemeinsameSteuerungMitglied", GemeinsameSteuerungDto.Mitglied.class);
        formen.put("GemeinsameSteuerungBefund", GemeinsameSteuerungDto.Befund.class);
        formen.put("GemeinsameSteuerungWarnungFuehrung", GemeinsameSteuerungDto.WarnungFuehrung.class);
        formen.forEach((schema, dto) -> {
            List<String> felder = new ArrayList<>();
            Arrays.stream(dto.getRecordComponents()).forEach(c -> felder.add(
                    PropertyNamingStrategies.SnakeCaseStrategy.INSTANCE.translate(c.getName())));
            assertThat(new ArrayList<>(eigenschaften(schema).keySet())).as(schema).containsExactlyElementsOf(felder);
        });
        List<String> wunsch = new ArrayList<>();
        Arrays.stream(GemeinsameSteuerungDto.MitgliedWunsch.class.getRecordComponents()).forEach(c -> wunsch.add(
                PropertyNamingStrategies.SnakeCaseStrategy.INSTANCE.translate(c.getName())));
        assertThat(text).contains("required: [box_id, rolle]");
        assertThat(wunsch).containsExactly("box_id", "rolle", "messpunkt_id");
    }

    @Test
    @SuppressWarnings("unchecked")
    void dieWoerterSindDieDesVokabulars() {
        Map<String, Object> wort = (Map<String, Object>) eigenschaften("GemeinsameSteuerungBefund").get("wort");
        assertThat((List<String>) wort.get("enum")).containsExactlyElementsOf(
                Arrays.stream(Ablehnung.values()).map(Ablehnung::code).toList());
        GemeinsameSteuerungAbgelehnt.UEBERGANG.forEach(code -> assertThat(text).as(code).contains("`" + code + "`"));
    }

    @Test
    @SuppressWarnings("unchecked")
    void dieRoutenNennenIhreRechte() {
        Map<String, String> recht = Map.of(
                KUNDE + "|put", "funktion.steuern_einrichten",
                KUNDE + "/anhalten|post", "steuerung.starten_beenden",
                KUNDE + "/fortsetzen|post", "steuerung.starten_beenden",
                KUNDE + "/aufloesen|post", "steuerung.starten_beenden",
                ADMIN + "/scharfschalten|post", "plattform.betrieb",
                ADMIN + "/mitglieder/{boxId}/bestaetigen|post", "plattform.betrieb");
        recht.forEach((schluessel, kennung) -> {
            String[] t = schluessel.split("\\|");
            Map<String, Object> op = (Map<String, Object>) ((Map<String, Object>) pfade.get(t[0])).get(t[1]);
            assertThat(op).as(schluessel).isNotNull();
            assertThat((String) op.get("description")).as(schluessel).contains("`" + kennung + "`");
            assertThat(((Map<String, Object>) op.get("responses")).keySet()).as(schluessel)
                    .containsExactlyInAnyOrder("200", "400", "401", "403", "404", "409");
        });
        Map<String, Object> lesen = (Map<String, Object>) ((Map<String, Object>) pfade.get(KUNDE)).get("get");
        assertThat(((Map<String, Object>) lesen.get("responses")).keySet()).containsExactlyInAnyOrder("200", "401",
                "404");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> eigenschaften(String schema) {
        Map<String, Object> s = (Map<String, Object>) schemas.get(schema);
        assertThat(s).as(schema).isNotNull();
        return (Map<String, Object>) s.get("properties");
    }
}
