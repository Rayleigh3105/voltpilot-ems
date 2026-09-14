package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.FunktionDto;
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
 * Die Funktions-Schnittstelle (UEMS AP-01 IP-3) sagt an drei Stellen dasselbe: in Java ({@link FunktionDto},
 * {@link FunktionAbgelehnt}), in {@code docs/contracts/openapi.yaml} und in {@code api.ts} — und ihre Wörter sind
 * die des Vertrags {@link FunktionZustandAbleitung}. Rein — ohne Spring, ohne Datenbank.
 */
class FunktionSchnittstelleVertragTest {

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
    void dieFormenSindZeichengleich() throws Exception {
        Map<String, Class<? extends Record>> formen = new LinkedHashMap<>();
        formen.put("Funktionen", FunktionDto.Funktionen.class);
        formen.put("FunktionUnternehmen", FunktionDto.Unternehmen.class);
        formen.put("FunktionVerbreitung", FunktionDto.Verbreitung.class);
        formen.put("FunktionStandort", FunktionDto.Standort.class);
        formen.put("FunktionMessen", FunktionDto.Messen.class);
        formen.put("FunktionSteuern", FunktionDto.Steuern.class);
        formen.put("FunktionAnlage", FunktionDto.Anlage.class);
        formen.put("FunktionTeilnahme", FunktionDto.Teilnahme.class);
        formen.put("FunktionPruefZeile", FunktionDto.PruefZeile.class);
        formen.put("FunktionWeg", FunktionDto.Weg.class);
        formen.put("FunktionSteuernAnfrage", FunktionDto.SteuernAnfrage.class);
        formen.put("FunktionSteuernErgebnis", FunktionDto.SteuernErgebnis.class);
        formen.put("FunktionAnlageRef", FunktionDto.AnlageRef.class);
        String ts = Files.readString(API_TS);
        formen.forEach((schema, dto) -> {
            List<String> felder = new ArrayList<>();
            Arrays.stream(dto.getRecordComponents()).forEach(c -> felder.add(
                    PropertyNamingStrategies.SnakeCaseStrategy.INSTANCE.translate(c.getName())));
            assertThat(new ArrayList<>(eigenschaften(schema).keySet())).as(schema).containsExactlyElementsOf(felder);
            // Das Portal hat dieselbe Form unter demselben Namen, Feld für Feld.
            int beginn = ts.indexOf("export interface " + schema + " {");
            assertThat(beginn).as("api.ts kennt " + schema).isPositive();
            String koerper = ts.substring(beginn, ts.indexOf("\n}", beginn));
            felder.forEach(f -> assertThat(koerper).as(schema + "." + f).contains("  " + f + ":"));
        });
    }

    @Test
    @SuppressWarnings("unchecked")
    void dieWoerterSindDieDesVertrags() {
        List<String> zustaende = Arrays.stream(FunktionZustandAbleitung.Zustand.values())
                .map(FunktionZustandAbleitung.Zustand::code).toList();
        assertThat((List<String>) feld("FunktionTeilnahme", "zustand").get("enum")).containsExactlyElementsOf(zustaende);
        assertThat((List<String>) feld("FunktionSteuern", "zustand").get("enum")).containsExactlyElementsOf(zustaende);
        assertThat((List<String>) feld("FunktionPruefZeile", "pruefung").get("enum")).containsExactlyElementsOf(
                Arrays.stream(FunktionZustandAbleitung.Pruefung.values()).map(FunktionZustandAbleitung.Pruefung::code)
                        .toList());
        assertThat((List<String>) items("FunktionTeilnahme", "aktionen").get("enum")).containsExactlyElementsOf(
                FunktionService.ANLAGEN_AKTIONEN.stream().map(FunktionZustandAbleitung.Aktion::code).toList());
        assertThat((List<String>) items("FunktionSteuern", "aktionen").get("enum")).containsExactlyElementsOf(
                FunktionService.STANDORT_AKTIONEN.stream().map(FunktionZustandAbleitung.Aktion::code).toList());
        assertThat((List<String>) feld("FunktionSteuernAnfrage", "aktion").get("enum")).containsExactlyElementsOf(
                FunktionService.ANLAGEN_AKTIONEN.stream().map(FunktionZustandAbleitung.Aktion::code).toList());
    }

    @Test
    @SuppressWarnings("unchecked")
    void derSatzDerAblehnungenIstInJavaOpenApiUndPortalDerselbe() throws Exception {
        assertThat((List<String>) feld("FunktionFehler", "code").get("enum"))
                .containsExactlyElementsOf(FunktionAbgelehnt.CODES);
        String ts = Files.readString(API_TS);
        String union = ts.substring(ts.indexOf("export type FunktionFehlerCode ="),
                ts.indexOf(";", ts.indexOf("export type FunktionFehlerCode =")));
        for (String c : FunktionAbgelehnt.CODES) {
            assertThat(union).as("api.ts kennt " + c).contains("'" + c + "'");
        }
    }

    /** Die Rechte stehen an den Routen, wie die Rechte-Matrix sie nennt — eingetragen, nicht durchgesetzt. */
    @Test
    @SuppressWarnings("unchecked")
    void dieRoutenNennenIhreRechte() {
        Map<String, Object> lesen = (Map<String, Object>) pfade.get("/api/v1/funktionen");
        Map<String, Object> anlage = (Map<String, Object>) pfade.get("/api/v1/sites/{siteId}/funktionen/steuern");
        Map<String, Object> standort = (Map<String, Object>) pfade.get("/api/v1/standorte/{standortId}/funktionen/steuern");
        assertThat(lesen.keySet()).containsExactly("get");
        assertThat(anlage.keySet()).containsExactlyInAnyOrder("parameters", "put");
        assertThat(standort.keySet()).containsExactlyInAnyOrder("parameters", "put");
        assertThat(String.valueOf(lesen.get("get"))).contains("keine eigene Kennung");
        for (Map<String, Object> p : List.of(anlage, standort)) {
            assertThat(String.valueOf(p.get("put"))).contains("steuerung.starten_beenden", "steuerung.anhalten_fortsetzen");
            assertThat(((Map<String, Object>) ((Map<String, Object>) p.get("put")).get("responses")).keySet())
                    .containsExactlyInAnyOrder("200", "400", "401", "404", "409");
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> eigenschaften(String schema) {
        Map<String, Object> s = (Map<String, Object>) schemas.get(schema);
        assertThat(s).as(schema).isNotNull();
        return (Map<String, Object>) s.get("properties");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> feld(String schema, String feld) {
        return (Map<String, Object>) eigenschaften(schema).get(feld);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> items(String schema, String feld) {
        return (Map<String, Object>) feld(schema, feld).get("items");
    }
}
