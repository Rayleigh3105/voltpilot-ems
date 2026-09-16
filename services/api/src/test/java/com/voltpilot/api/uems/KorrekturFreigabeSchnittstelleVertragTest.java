package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.KorrekturFreigabeDto;
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
 * Die Vier-Augen-Schnittstelle (UEMS AP-08 IP-15) sagt an zwei Stellen dasselbe: in Java
 * ({@link KorrekturFreigabeAbgelehnt}, {@link KorrekturFreigabeDto}) und in {@code docs/contracts/openapi.yaml}.
 * Rein — ohne Spring, ohne Datenbank.
 */
class KorrekturFreigabeSchnittstelleVertragTest {

    private static final Path OPENAPI = Path.of("..", "..", "docs", "contracts", "openapi.yaml");
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
        Map<String, Object> code = (Map<String, Object>) eigenschaften("KorrekturFreigabeFehler").get("code");
        assertThat((List<String>) code.get("enum")).containsExactlyElementsOf(KorrekturFreigabeAbgelehnt.CODES);
    }

    @Test
    void dieFormenSindZeichengleich() {
        Map<String, Class<? extends Record>> formen = new LinkedHashMap<>();
        formen.put("VierAugen", KorrekturFreigabeDto.VierAugen.class);
        formen.put("VierAugenSetzen", KorrekturFreigabeDto.VierAugenSetzen.class);
        formen.put("KorrekturFreigeben", KorrekturFreigabeDto.Freigeben.class);
        formen.put("KorrekturZuruecknehmen", KorrekturFreigabeDto.Zuruecknehmen.class);
        formen.put("KorrekturUrheber", KorrekturFreigabeDto.Urheber.class);
        formen.put("KorrekturEntscheidung", KorrekturFreigabeDto.Entscheidung.class);
        formen.put("ErsatzwertLuecke", KorrekturPortalService.Luecke.class);
        formen.put("ErsatzwertEingabe", KorrekturPortalService.Eingabe.class);
        formen.put("KorrekturPortalDetail", KorrekturPortalService.Detail.class);
        formen.put("KorrekturPortalAktion", KorrekturPortalService.Aktion.class);
        formen.put("KorrekturAuswirkungen", KorrekturPortalService.Auswirkungen.class);
        formen.put("ErsatzwertVorschau", KorrekturPortalService.Vorschau.class);
        formen.put("ErsatzwertStand", KorrekturPortalService.ErsatzwertStand.class);
        formen.forEach((schema, dto) -> {
            List<String> felder = new ArrayList<>();
            Arrays.stream(dto.getRecordComponents()).forEach(c -> felder.add(
                    PropertyNamingStrategies.SnakeCaseStrategy.INSTANCE.translate(c.getName())));
            assertThat(new ArrayList<>(eigenschaften(schema).keySet())).as(schema).containsExactlyElementsOf(felder);
        });
    }

    /** Drei Pfade, vier Routen — keine löscht, keine legt eine Korrektur an (das ist AP-08 IP-16). */
    @Test
    @SuppressWarnings("unchecked")
    void dieRoutenSindDieVierDesPakets() {
        assertThat(((Map<String, Object>) pfade.get("/api/v1/unternehmen/vieraugen")).keySet())
                .containsExactlyInAnyOrder("get", "put");
        for (String p : List.of("/api/v1/korrekturen/{kennung}/freigeben", "/api/v1/korrekturen/{kennung}/zuruecknehmen")) {
            assertThat(((Map<String, Object>) pfade.get(p)).keySet()).as(p).containsExactlyInAnyOrder("parameters", "post");
        }
        assertThat(pfade.keySet().stream().filter(p -> p.startsWith("/api/v1/korrekturen"))).containsExactlyInAnyOrder(
                "/api/v1/korrekturen/{kennung}", "/api/v1/korrekturen/{kennung}/freigeben",
                "/api/v1/korrekturen/{kennung}/zuruecknehmen", "/api/v1/korrekturen/{kennung}/ablehnen");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> eigenschaften(String schema) {
        Map<String, Object> s = (Map<String, Object>) schemas.get(schema);
        assertThat(s).as(schema).isNotNull();
        return (Map<String, Object>) s.get("properties");
    }
}
