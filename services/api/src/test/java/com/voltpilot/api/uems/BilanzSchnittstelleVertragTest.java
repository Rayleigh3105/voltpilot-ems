package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.BilanzDto;
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
 * Die Bilanz-Schnittstelle (UEMS AP-10 IP-9) sagt an drei Stellen dasselbe: in Java ({@link BilanzDto},
 * {@link BilanzAbgelehnt}), in {@code docs/contracts/openapi.yaml} und in {@code api.ts}. Rein — ohne Spring,
 * ohne Datenbank.
 */
class BilanzSchnittstelleVertragTest {

    private static final Path OPENAPI = Path.of("..", "..", "docs", "contracts", "openapi.yaml");
    private static final Path API_TS = Path.of("..", "..", "frontend", "portal", "src", "api.ts");
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
        formen.put("Bilanz", BilanzDto.Bilanz.class);
        formen.put("BilanzAnlage", BilanzDto.Anlage.class);
        formen.put("BilanzMessstelleRef", BilanzDto.MessstelleRef.class);
        formen.put("BilanzHauptzaehler", BilanzDto.Hauptzaehler.class);
        formen.put("BilanzVorschlag", BilanzDto.Vorschlag.class);
        formen.put("BilanzAbschnitt", BilanzDto.Abschnitt.class);
        formen.put("BilanzTerm", BilanzDto.Term.class);
        formen.put("BilanzWerte", BilanzDto.Werte.class);
        formen.put("BilanzSumme", BilanzDto.Summe.class);
        formen.put("BilanzRest", BilanzDto.Rest.class);
        formen.put("BilanzEingang", BilanzDto.Eingang.class);
        formen.put("BilanzLive", BilanzDto.Live.class);
        formen.put("BilanzLiveFehlend", BilanzDto.Fehlender.class);
        formen.put("BilanzRestAnlegen", BilanzDto.RestAnlegen.class);
        formen.put("BilanzRestAngelegt", BilanzDto.RestAngelegt.class);
        String ts = lesen(API_TS);
        formen.forEach((schema, dto) -> {
            List<String> felder = new ArrayList<>();
            Arrays.stream(dto.getRecordComponents()).forEach(c -> felder.add(
                    PropertyNamingStrategies.SnakeCaseStrategy.INSTANCE.translate(c.getName())));
            assertThat(new ArrayList<>(eigenschaften(schema).keySet())).as(schema).containsExactlyElementsOf(felder);
        });
        // Das Portal liest dieselben Felder (snake_case — request() wandelt nichts um).
        for (String feld : List.of("rest_messstelle", "stellung_geaendert", "abschnitte", "hauptzaehler_id",
                "mit_werten", "kundensatz", "fehlende", "kennzeichen")) {
            assertThat(ts).as("api.ts kennt " + feld).contains(feld + ":");
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void derSatzDerAblehnungenIstInJavaOpenApiUndPortalDerselbe() {
        Map<String, Object> code = (Map<String, Object>) eigenschaften("BilanzFehler").get("code");
        assertThat((List<String>) code.get("enum")).containsExactlyElementsOf(BilanzAbgelehnt.CODES);
        String ts = lesen(API_TS);
        String union = ts.substring(ts.indexOf("export type BilanzFehlerCode ="),
                ts.indexOf(";", ts.indexOf("export type BilanzFehlerCode =")));
        for (String c : BilanzAbgelehnt.CODES) {
            assertThat(union).as("api.ts kennt " + c).contains("'" + c + "'");
        }
        // Der 422-Code ist der des Bilanz-Vertrags (fehler_neu), kein neues Wort.
        assertThat(BilanzAbgelehnt.CODES).contains(BilanzAbleitung.REST_OHNE_HAUPTZAEHLER);
    }

    /** Die Perioden und die Aktion des Vorschlags sind die des Dienstes. */
    @Test
    @SuppressWarnings("unchecked")
    void periodenUndVorschlagSindDieDesDienstes() {
        assertThat((List<String>) ((Map<String, Object>) eigenschaften("Bilanz").get("periode")).get("enum"))
                .containsExactlyElementsOf(BilanzService.PERIODEN);
        assertThat((List<String>) ((Map<String, Object>) eigenschaften("BilanzVorschlag").get("aktion")).get("enum"))
                .containsExactly(BilanzService.AKTION_REST_ANLEGEN);
    }

    /** Die Rechte stehen an den Routen, wie AP-10 §4.10 sie nennt — eingetragen, nicht durchgesetzt. */
    @Test
    @SuppressWarnings("unchecked")
    void dieRoutenNennenIhreRechte() {
        Map<String, Object> lesen = (Map<String, Object>) pfade.get("/api/v1/sites/{siteId}/bilanz");
        Map<String, Object> anlegen = (Map<String, Object>) pfade.get("/api/v1/sites/{siteId}/bilanz/rest");
        assertThat(lesen.keySet()).containsExactlyInAnyOrder("parameters", "get");
        assertThat(anlegen.keySet()).containsExactlyInAnyOrder("parameters", "post");
        assertThat(String.valueOf(lesen.get("get"))).contains("messstelle.ansehen");
        assertThat(String.valueOf(anlegen.get("post"))).contains("messstelle.formel");
        assertThat(((Map<String, Object>) ((Map<String, Object>) anlegen.get("post")).get("responses")).keySet())
                .containsExactlyInAnyOrder("200", "201", "400", "401", "404", "422");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> eigenschaften(String schema) {
        Map<String, Object> s = (Map<String, Object>) schemas.get(schema);
        assertThat(s).as(schema).isNotNull();
        return (Map<String, Object>) s.get("properties");
    }

    private static String lesen(Path p) {
        try {
            return Files.readString(p);
        } catch (java.io.IOException e) {
            throw new java.io.UncheckedIOException(e);
        }
    }
}
