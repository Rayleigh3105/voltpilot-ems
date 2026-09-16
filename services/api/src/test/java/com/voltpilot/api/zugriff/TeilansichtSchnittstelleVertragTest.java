package com.voltpilot.api.zugriff;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.web.dto.TeilansichtDto;
import java.io.InputStream;
import java.lang.reflect.RecordComponent;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Die Teilansicht (UEMS AP-03 IP-10) sagt in Java ({@link TeilansichtDto}) und in
 * {@code docs/contracts/openapi.yaml} dasselbe, und die Routen des Pakets tragen sie. Rein — ohne Spring,
 * ohne Datenbank.
 */
class TeilansichtSchnittstelleVertragTest {

    private static final Path OPENAPI = Path.of("..", "..", "docs", "contracts", "openapi.yaml");

    /** Die Antwortformen, die das Feld im Körper tragen. */
    private static final List<String> FORMEN_MIT_FELD = List.of("Overview", "Earnings", "StandorteAmStichtag");

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
    void dasFeldHeisstInJavaUndOpenApiGleichUndIstPflicht() {
        Map<String, Object> schema = (Map<String, Object>) schemas.get("Teilansicht");
        assertThat(schema).as("components.schemas.Teilansicht").isNotNull();
        Set<String> java = Arrays.stream(TeilansichtDto.class.getRecordComponents())
                .map(RecordComponent::getName).collect(Collectors.toCollection(TreeSet::new));
        assertThat(java).as("die beiden Zahlen").containsExactly("gesamt", "sichtbar");
        assertThat(new TreeSet<>(((Map<String, Object>) schema.get("properties")).keySet())).isEqualTo(java);
        assertThat(new TreeSet<>((List<String>) schema.get("required"))).isEqualTo(java);
    }

    @Test
    @SuppressWarnings("unchecked")
    void jedeAntwortformDesPaketsTraegtDasFeld() {
        for (String form : FORMEN_MIT_FELD) {
            Map<String, Object> schema = (Map<String, Object>) schemas.get(form);
            assertThat(schema).as(form).isNotNull();
            Map<String, Object> feld =
                    (Map<String, Object>) ((Map<String, Object>) schema.get("properties")).get("teilansicht");
            assertThat(feld).as(form + ".teilansicht").isNotNull();
            assertThat(feld.get("allOf").toString()).as(form + ".teilansicht verweist auf das gemeinsame Schema")
                    .contains("#/components/schemas/Teilansicht");
        }
    }

    /**
     * Die BENANNTE LÜCKE: {@code /sites}, {@code /devices} und {@code /edge-versions} antworten mit einer
     * nackten Liste und tragen {@code teilansicht} darum NICHT. Das ist eine bewusste Abweichung von der
     * Abnahmezeile „in allen sechs Antworten belegt" (firstmate-Entscheid 16.09.2026, Option C): ein Umschlag
     * {@code {eintraege, teilansicht}} wäre ein Bruch des Vertrags an drei Kernrouten.
     *
     * <p>Dieser Test hält beides fest — dass die Form eine Liste GEBLIEBEN ist (kein stiller Umschlag) und
     * dass der Vertrag die Adresse der Einlösung nennt. Wer den Umschlag mit <b>AP-03 IP-12</b> baut, macht
     * diesen Test rot und liest hier, warum er rot ist.
     */
    @Test
    @SuppressWarnings("unchecked")
    void dieDreiListenRoutenTragenDasFeldNichtUndNennenIhreAdresse() {
        for (String route : List.of("/api/v1/sites", "/api/v1/devices", "/api/v1/edge-versions")) {
            Map<String, Object> get = (Map<String, Object>) ((Map<String, Object>) pfade.get(route)).get("get");
            Map<String, Object> schema = (Map<String, Object>) ((Map<String, Object>)
                    ((Map<String, Object>) ((Map<String, Object>) get.get("responses")).get("200"))
                            .get("content")).get("application/json");
            assertThat(((Map<String, Object>) schema.get("schema")).get("type"))
                    .as(route + " antwortet mit einer nackten Liste — kein stiller Umschlag").isEqualTo("array");
            assertThat((String) get.get("description"))
                    .as(route + " nennt die Lücke und ihre Adresse")
                    .contains("teilansicht").contains("AP-03 IP-12");
        }
    }

    /**
     * Die Standort-MENGE an {@code /earnings} (IP-10, „eine Standort-Menge statt eine oder alle"): ein
     * wiederholbarer Abfrageparameter aus Standort-Kennungen, dazu die 404-Antwort für einen Standort
     * außerhalb des Zugriffs (A14 — nie 403).
     */
    @Test
    @SuppressWarnings("unchecked")
    void earningsNenntDieStandortMengeUndIhre404() {
        Map<String, Object> get = (Map<String, Object>)
                ((Map<String, Object>) pfade.get("/api/v1/earnings")).get("get");
        List<Map<String, Object>> parameter = (List<Map<String, Object>>) get.get("parameters");
        Map<String, Object> standort = parameter.stream()
                .filter(p -> "standort".equals(p.get("name"))).findFirst().orElse(null);
        assertThat(standort).as("Parameter standort").isNotNull();
        assertThat(standort.get("in")).isEqualTo("query");
        assertThat(standort.get("explode")).as("wiederholbar, nicht kommagetrennt").isEqualTo(true);
        Map<String, Object> schema = (Map<String, Object>) standort.get("schema");
        assertThat(schema.get("type")).isEqualTo("array");
        assertThat(((Map<String, Object>) schema.get("items")).get("format")).isEqualTo("uuid");
        assertThat(((Map<String, Object>) get.get("responses"))).containsKey("404");
    }
}
