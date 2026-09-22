package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.BerichtDto;
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
 * Die Berichts-Schnittstelle (UEMS AP-12 IP-7) sagt an drei Stellen dasselbe: in Java ({@link BerichtAbgelehnt},
 * {@link BerichtDto}, {@link BerichtService#STAND_ZEICHEN}), in {@code docs/contracts/openapi.yaml} und — für die Codes des
 * Vertrags — in {@link BerichtRegeln#FEHLER_STATUS}. Rein — ohne Spring, ohne Datenbank.
 */
class BerichtSchnittstelleVertragTest {

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
        Map<String, Object> code = (Map<String, Object>) eigenschaften("BerichtFehler").get("code");
        assertThat((List<String>) code.get("enum")).containsExactlyElementsOf(BerichtAbgelehnt.CODES);
    }

    /** Jeder Code des Vertrags ist ein Code der Routen — mit dem Status des Vertrags (§5.8), außer dem Belegschutz (IP-12). */
    @Test
    void dieCodesDesVertragsTragenIhrenStatus() {
        BerichtRegeln.FEHLER_STATUS.forEach((code, status) -> {
            if (BerichtRegeln.BERICHTS_BELEGE.equals(code) || BerichtRegeln.WERT_NICHT_MEHR_GESPEICHERT.equals(code)) {
                assertThat(BerichtAbgelehnt.CODES).as(code + " gehört den Löschwegen bzw. den Werten").doesNotContain(code);
                return;
            }
            BerichtAbgelehnt.Ablehnung a = BerichtAbgelehnt.Ablehnung.valueOf(code.toUpperCase());
            assertThat(a.status()).as(code).isEqualTo(status);
        });
    }

    @Test
    void dieFormenSindZeichengleich() {
        Map<String, Class<? extends Record>> formen = new LinkedHashMap<>();
        formen.put("BerichtAnlegen", BerichtDto.Anlegen.class);
        formen.put("BerichtFreigeben", BerichtDto.Freigeben.class);
        formen.put("BerichtWiedervorlage", BerichtDto.Wiedervorlage.class);
        formen.put("BerichtAnstossVerwerfen", BerichtDto.Verwerfen.class);
        formen.put("BerichtPerson", BerichtDto.Person.class);
        formen.put("Bericht", BerichtDto.Bericht.class);
        formen.put("BerichtListe", BerichtDto.Liste.class);
        formen.put("BerichtStandKurz", BerichtDto.StandKurz.class);
        formen.put("BerichtAnstoss", BerichtDto.Anstoss.class);
        formen.put("BerichtDetail", BerichtDto.Detail.class);
        formen.put("BerichtEntwurf", BerichtDto.Entwurf.class);
        formen.put("BerichtAbweichung", BerichtDto.Abweichung.class);
        formen.put("BerichtVergleich", BerichtDto.Vergleich.class);
        formen.put("BerichtStand", BerichtDto.Stand.class);
        formen.put("BerichtStandRef", BerichtDto.StandRef.class);
        formen.put("BerichteBetroffen", BerichtDto.Betroffen.class);
        formen.forEach((schema, dto) -> {
            List<String> felder = new ArrayList<>();
            Arrays.stream(dto.getRecordComponents()).forEach(c -> felder.add(
                    PropertyNamingStrategies.SnakeCaseStrategy.INSTANCE.translate(c.getName())));
            assertThat(new ArrayList<>(eigenschaften(schema).keySet())).as(schema).containsExactlyElementsOf(felder);
        });
    }

    @Test
    @SuppressWarnings("unchecked")
    void derVermerkIstInJavaUndOpenApiDerselbe() {
        Map<String, Object> zeichen = (Map<String, Object>) eigenschaften("Bericht").get("stand_zeichen");
        assertThat((List<String>) zeichen.get("enum")).containsExactlyElementsOf(BerichtService.STAND_ZEICHEN);
        Map<String, Object> art = (Map<String, Object>) eigenschaften("BerichtAnstoss").get("art");
        assertThat((List<String>) art.get("enum")).containsExactlyElementsOf(BerichtRegeln.ANSTOSS_ARTEN);
    }

    /**
     * Elf Pfade, zwölf Routen — keine löscht (F6: eine Freigabe wird nie zurückgenommen, ein Stand nie gelöscht): die neun
     * aus IP-7, seit AP-12 IP-9 die lesende Folgen-Zeile {@code /berichte/betroffen}, seit AP-12 IP-10 der Berichts-CSV und
     * seit AP-12 IP-11 das PDF eines Stands.
     */
    @Test
    @SuppressWarnings("unchecked")
    void dieRoutenSindDieZwoelfDerPakete() {
        Map<String, List<String>> soll = new LinkedHashMap<>();
        soll.put("/api/v1/berichte", List.of("get", "post"));
        soll.put("/api/v1/berichte/betroffen", List.of("get"));
        soll.put("/api/v1/berichte/{kennung}", List.of("parameters", "get"));
        soll.put("/api/v1/berichte/{kennung}/wiedervorlage", List.of("parameters", "put"));
        soll.put("/api/v1/berichte/{kennung}/entwurf", List.of("parameters", "get"));
        soll.put("/api/v1/berichte/{kennung}/entwurf/vergleich", List.of("parameters", "get"));
        soll.put("/api/v1/berichte/{kennung}/freigeben", List.of("parameters", "post"));
        soll.put("/api/v1/berichte/{kennung}/staende/{nr}", List.of("parameters", "get"));
        soll.put("/api/v1/berichte/{kennung}/staende/{nr}/csv", List.of("parameters", "get"));
        soll.put("/api/v1/berichte/{kennung}/staende/{nr}/pdf", List.of("parameters", "get"));
        soll.put("/api/v1/berichte/{kennung}/anstoesse/{id}/verwerfen", List.of("parameters", "post"));
        soll.put("/api/v1/berichte/{kennung}/archivieren", List.of("parameters", "post"));
        soll.forEach((p, methoden) -> assertThat(((Map<String, Object>) pfade.get(p)).keySet()).as(p)
                .containsExactlyInAnyOrderElementsOf(methoden));
        assertThat(pfade.keySet().stream().filter(p -> p.startsWith("/api/v1/berichte"))).hasSize(soll.size());
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> eigenschaften(String schema) {
        Map<String, Object> s = (Map<String, Object>) schemas.get(schema);
        assertThat(s).as(schema).isNotNull();
        return (Map<String, Object>) s.get("properties");
    }
}
