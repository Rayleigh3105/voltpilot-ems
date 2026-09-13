package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.VerteilungDto;
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
 * Die Verteilungs-Schnittstelle (UEMS AP-10 IP-8) sagt an drei Stellen dasselbe: in Java ({@link VerteilungAbgelehnt},
 * {@link VerteilungDto}), in {@code docs/contracts/openapi.yaml} und — für jedes Fehler-Wort der Regel — im
 * Vertrag {@code verteilung-vectors.json}. Rein — ohne Spring, ohne Datenbank.
 */
class VerteilungSchnittstelleVertragTest {

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
    @SuppressWarnings("unchecked")
    void derSatzDerAblehnungenIstInJavaOpenApiUndPortalDerselbe() throws Exception {
        Map<String, Object> code = (Map<String, Object>) eigenschaften("VerteilungFehler").get("code");
        assertThat((List<String>) code.get("enum")).containsExactlyElementsOf(VerteilungAbgelehnt.CODES);
        String ts = Files.readString(API_TS);
        String union = ts.substring(ts.indexOf("export type VerteilungFehlerCode ="), ts.indexOf(";",
                ts.indexOf("export type VerteilungFehlerCode =")));
        for (String c : VerteilungAbgelehnt.CODES) {
            assertThat(union).as("api.ts kennt " + c).contains("'" + c + "'");
        }
    }

    /** Jedes Fehler-Wort, das die Regel {@code satz_ab_tag} sprechen kann, hat genau eine Ablehnung — keine geratene. */
    @Test
    void jedesFehlerWortDerRegelHatSeineAblehnung() {
        for (String wort : List.of(VerteilungRegeln.FEHLER_ANTEIL, VerteilungRegeln.FEHLER_ZIEL,
                VerteilungRegeln.FEHLER_SUMME, VerteilungRegeln.FEHLER_UEBERLAPPT)) {
            assertThat(VerteilungAbgelehnt.Ablehnung.ausRegel(wort).status()).as(wort).isEqualTo(422);
        }
    }

    @Test
    void dieFormenSindZeichengleich() {
        Map<String, Class<? extends Record>> formen = new LinkedHashMap<>();
        formen.put("MessstelleVerteilungSetzen", VerteilungDto.Setzen.class);
        formen.put("MessstelleVerteilungZeile", VerteilungDto.ZeileEingabe.class);
        formen.put("VerteilungKostenstelle", VerteilungDto.Kostenstelle.class);
        formen.put("MessstelleVerteilungAnteil", VerteilungDto.Anteil.class);
        formen.put("MessstelleVerteilung", VerteilungDto.Verteilung.class);
        formen.forEach((schema, dto) -> {
            List<String> felder = new ArrayList<>();
            Arrays.stream(dto.getRecordComponents()).forEach(c -> felder.add(
                    PropertyNamingStrategies.SnakeCaseStrategy.INSTANCE.translate(c.getName())));
            assertThat(new ArrayList<>(eigenschaften(schema).keySet())).as(schema).containsExactlyElementsOf(felder);
        });
    }

    /** Beenden oder aufheben statt löschen: die Route kennt nur GET und PUT. */
    @Test
    @SuppressWarnings("unchecked")
    void keineRouteLoescht() {
        Map<String, Object> pfad = (Map<String, Object>) pfade.get("/api/v1/messstellen/{id}/verteilung");
        assertThat(pfad).isNotNull();
        assertThat(pfad.keySet()).containsExactlyInAnyOrder("parameters", "get", "put");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> eigenschaften(String schema) {
        Map<String, Object> s = (Map<String, Object>) schemas.get(schema);
        assertThat(s).as(schema).isNotNull();
        return (Map<String, Object>) s.get("properties");
    }
}
