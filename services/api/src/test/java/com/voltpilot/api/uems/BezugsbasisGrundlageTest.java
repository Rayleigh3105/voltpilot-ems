package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.BezugsbasisDto;
import java.io.InputStream;
import java.lang.reflect.RecordComponent;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Die Kanonisierung des Lesers ist die der Referenzdatei 1.8 (UEMS AP-17 IP-7, F3): jede Prüfsumme in
 * {@code bezugsbasen[]} entsteht aus {@link BezugsbasisGrundlage#kanonisch} über die Grundlage ihrer Fassung.
 */
class BezugsbasisGrundlageTest {

    private static final Path OPENAPI = Path.of("..", "..", "docs", "contracts", "openapi.yaml");
    private static final Path REFERENZ = Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");

    @Test
    void jedePruefsummeDerReferenzdateiEntstehtAusDerKanonischenGrundlage() throws Exception {
        JsonNode d = new ObjectMapper().readTree(REFERENZ.toFile());
        int geprueft = 0;
        for (JsonNode basis : d.get("bezugsbasen")) {
            for (JsonNode f : basis.get("fassungen")) {
                if (f.get("pruefsumme").isNull()) {
                    continue;
                }
                assertThat(BezugsbasisGrundlage.pruefsumme(BezugsbasisGrundlage.kanonisch(f.get("grundlage"))))
                        .as(basis.get("kennzeichen").asText() + " Fassung " + f.get("fassung").asInt())
                        .isEqualTo(f.get("pruefsumme").asText());
                geprueft++;
            }
        }
        assertThat(geprueft).isGreaterThanOrEqualTo(6);
    }

    /** Zahlen ohne nachgestellte Nullen, Schlüssel sortiert, kein Leerraum („2.0“ → „2“). */
    @Test
    void kanonischSortiertUndKuerzt() throws Exception {
        JsonNode n = new ObjectMapper().readTree("{\"b\": 2.0, \"a\": [1.50, \"x\"], \"c\": null}");
        assertThat(BezugsbasisGrundlage.kanonisch(n)).isEqualTo("{\"a\":[1.5,\"x\"],\"b\":2,\"c\":null}");
    }

    /** OpenAPI nennt die vier Routen (§13) und je Form genau die Felder der Antwort. */
    @Test
    @SuppressWarnings("unchecked")
    void openApiNenntDieRoutenUndDieFelder() throws Exception {
        Map<String, Object> openapi;
        try (InputStream in = Files.newInputStream(OPENAPI)) {
            openapi = new Yaml().load(in);
        }
        Map<String, Object> pfade = (Map<String, Object>) openapi.get("paths");
        String basis = "/api/v1/kennzahlen/{id}/bezugsbasen";
        assertThat(pfade.keySet().stream().filter(p -> p.contains("/bezugsbasen")).toList())
                .containsExactlyInAnyOrder(basis, basis + "/{bid}", basis + "/{bid}/fassungen",
                        basis + "/{bid}/fassungen/{n}", basis + "/{bid}/fassungen/{n}/beantragen",
                        basis + "/{bid}/fassungen/{n}/freigeben", basis + "/{bid}/fassungen/{n}/ablehnen",
                        basis + "/{bid}/verantwortlicher",
                        // IP-17 (§15): Pflege und Übersicht.
                        basis + "/{bid}/bleibt", basis + "/{bid}/beenden", "/api/v1/bezugsbasen/uebersicht");
        assertThat(((Map<String, Object>) pfade.get(basis)).keySet())
                .containsExactlyInAnyOrder("parameters", "get", "post");
        for (String schritt : List.of("beantragen", "freigeben", "ablehnen")) {
            assertThat(((Map<String, Object>) pfade.get(basis + "/{bid}/fassungen/{n}/" + schritt)).keySet())
                    .as(schritt).containsExactlyInAnyOrder("parameters", "post");
        }
        assertThat(((Map<String, Object>) pfade.get(basis + "/{bid}/verantwortlicher")).keySet())
                .containsExactlyInAnyOrder("parameters", "put");
        assertThat(((Map<String, Object>) pfade.get(basis + "/{bid}")).keySet()).containsExactlyInAnyOrder("parameters", "get");
        assertThat(((Map<String, Object>) pfade.get(basis + "/{bid}/fassungen")).keySet())
                .containsExactlyInAnyOrder("parameters", "post");
        assertThat(((Map<String, Object>) pfade.get(basis + "/{bid}/fassungen/{n}")).keySet())
                .containsExactlyInAnyOrder("parameters", "get");
        Map<String, Object> schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
        Map<String, Class<?>> formen = Map.ofEntries(Map.entry("BezugsbasisFassung", BezugsbasisDto.Fassung.class),
                Map.entry("Bezugsbasis", BezugsbasisDto.Bezugsbasis.class),
                Map.entry("BezugsbasisFassungKurz", BezugsbasisDto.FassungKurz.class),
                Map.entry("BezugsbasisVariable", BezugsbasisDto.Variable.class),
                Map.entry("BezugsbasisEntwurf", BezugsbasisDto.Entwurf.class),
                Map.entry("BezugsbasisAnlegen", BezugsbasisDto.Anlegen.class),
                Map.entry("BezugsbasisEntscheid", BezugsbasisDto.Entscheid.class),
                Map.entry("BezugsbasisVerantwortlicher", BezugsbasisDto.Verantwortlicher.class),
                Map.entry("BezugsbasisListe", BezugsbasisDto.Liste.class),
                Map.entry("BezugsbasisPerson", BezugsbasisDto.Person.class),
                Map.entry("BezugsbasisZustand", BezugsbasisPflegeService.Zustand.class),
                Map.entry("BezugsbasisUebersicht", BezugsbasisPflegeService.Uebersicht.class),
                // IP-16b (§17): statische Faktoren an der Fassung.
                Map.entry("BezugsbasisFaktorWahl", BezugsbasisDto.FaktorWahl.class),
                Map.entry("BezugsbasisFaktor", BezugsbasisDto.Faktor.class));
        formen.forEach((name, form) -> assertThat(((Map<String, Object>) ((Map<String, Object>) schemas.get(name))
                .get("properties")).keySet()).as(name).containsExactlyElementsOf(felder(form)));
    }

    private static List<String> felder(Class<?> form) {
        PropertyNamingStrategies.SnakeCaseStrategy snake = new PropertyNamingStrategies.SnakeCaseStrategy();
        return Arrays.stream(form.getRecordComponents()).map(RecordComponent::getName).map(snake::translate).toList();
    }
}
