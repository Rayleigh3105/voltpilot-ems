package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.NetzanschlussDto;
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
 * Die Netzanschluss-Schnittstelle (UEMS AP-10 IP-6) sagt an drei Stellen dasselbe: in Java
 * ({@link NetzanschlussAbgelehnt}, {@link NetzanschlussDto}), in {@code docs/contracts/openapi.yaml} und —
 * für die Codes der Regeln — im Vertrag {@code netzanschluss-vectors.json}. Rein: ohne Spring, ohne Datenbank.
 */
class NetzanschlussSchnittstelleVertragTest {

    private static final Path OPENAPI = Path.of("..", "..", "docs", "contracts", "openapi.yaml");
    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2", "netzanschluss-vectors.json");
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
    void derSatzDerAblehnungenIstInJavaUndOpenApiDerselbe() {
        Map<String, Object> code = (Map<String, Object>) eigenschaften("NetzanschlussFehler").get("code");
        assertThat((List<String>) code.get("enum")).containsExactlyElementsOf(NetzanschlussAbgelehnt.CODES);
    }

    /** Jeder Fehler-Code des Vertrags hat seine Ablehnung — die Schnittstelle erfindet für ihn kein anderes Wort. */
    @Test
    void jederFehlerDesVertragsIstEineAblehnungDerSchnittstelle() throws Exception {
        JsonNode v = new ObjectMapper().readTree(Files.readString(VEKTOREN));
        List<String> vertrag = new ArrayList<>();
        v.path("vokabulare").path("fehler").forEach(f -> vertrag.add(f.asText()));
        assertThat(vertrag).isNotEmpty();
        assertThat(NetzanschlussAbgelehnt.CODES).containsAll(vertrag);
    }

    @Test
    void dieFormenSindZeichengleich() {
        Map<String, Class<? extends Record>> formen = new LinkedHashMap<>();
        formen.put("NetzanschlussVorschlag", NetzanschlussDto.Vorschlag.class);
        formen.put("NetzanschlussUebernehmen", NetzanschlussDto.Uebernehmen.class);
        formen.put("NetzanschlussAnschluss", NetzanschlussDto.Anschluss.class);
        formen.put("NetzanschlussBinden", NetzanschlussDto.Binden.class);
        formen.put("NetzanschlussStandort", NetzanschlussDto.Standort.class);
        formen.put("NetzanschlussAnlage", NetzanschlussDto.Anlage.class);
        formen.put("NetzanschlussBindung", NetzanschlussDto.Bindung.class);
        formen.put("Netzanschluss", NetzanschlussDto.Netzanschluss.class);
        formen.put("NetzanschlussListe", NetzanschlussDto.Netzanschluesse.class);
        formen.forEach((schema, dto) -> {
            List<String> felder = new ArrayList<>();
            Arrays.stream(dto.getRecordComponents()).forEach(c -> felder.add(
                    PropertyNamingStrategies.SnakeCaseStrategy.INSTANCE.translate(c.getName())));
            assertThat(new ArrayList<>(eigenschaften(schema).keySet())).as(schema).containsExactlyElementsOf(felder);
        });
    }

    /** Das additive Feld am Standort-Lesemodell (camelCase wie der Rest dieser Antwort). */
    @Test
    @SuppressWarnings("unchecked")
    void dieAnlageAmStandortNenntIhrenNetzanschluss() {
        List<String> anlage = new ArrayList<>(eigenschaften("StandortAnlage").keySet());
        List<String> java = Arrays.stream(StandortLesemodell.ZugeordneteAnlage.class.getRecordComponents())
                .map(c -> c.getName()).toList();
        assertThat(anlage).containsExactlyElementsOf(java);
        Map<String, Object> na = (Map<String, Object>) eigenschaften("StandortAnlage").get("netzanschluss");
        List<String> bezug = Arrays.stream(StandortLesemodell.NetzanschlussBezug.class.getRecordComponents())
                .map(c -> c.getName()).toList();
        assertThat(new ArrayList<>(((Map<String, Object>) na.get("properties")).keySet())).containsExactlyElementsOf(bezug);
    }

    /** Beenden statt löschen: keine Route der Schnittstelle kennt DELETE. */
    @Test
    @SuppressWarnings("unchecked")
    void keineRouteLoescht() {
        List<String> eigene = pfade.keySet().stream()
                .filter(p -> p.startsWith("/api/v1/standorte/{standortId}/netzanschluesse")).toList();
        assertThat(eigene).as("sechs Pfade aus AP-10, dazu Grenzblatt (AP-15 IP-3) und Grenz-Nachweis (IP-31)").hasSize(8);
        for (String p : eigene) {
            assertThat(((Map<String, Object>) pfade.get(p)).keySet()).as(p).doesNotContain("delete");
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> eigenschaften(String schema) {
        Map<String, Object> s = (Map<String, Object>) schemas.get(schema);
        assertThat(s).as(schema).isNotNull();
        return (Map<String, Object>) s.get("properties");
    }
}
