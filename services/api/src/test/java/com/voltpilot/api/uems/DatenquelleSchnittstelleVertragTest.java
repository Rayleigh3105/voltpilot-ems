package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.DatenquelleDto;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.stream.StreamSupport;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Rein, ohne Docker: die Datenquellen-Schnittstelle sagt in drei Dateien DASSELBE — der
 * Datenquellen-Vertrag ({@code data-source-vectors.json}: Gründe, Protokolle), die Java-Form
 * ({@link DatenquelleDto}, {@link DatenquelleAbgelehnt}) und {@code docs/contracts/openapi.yaml}.
 */
class DatenquelleSchnittstelleVertragTest {

    private static final Path CONTRACTS = Path.of("..", "..", "docs", "contracts");
    private static final PropertyNamingStrategies.SnakeCaseStrategy SNAKE =
            new PropertyNamingStrategies.SnakeCaseStrategy();

    private static Map<String, Object> schemas;
    private static JsonNode vektoren;

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void lade() throws IOException {
        try (InputStream in = Files.newInputStream(CONTRACTS.resolve("openapi.yaml"))) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
        }
        vektoren = new ObjectMapper().readTree(CONTRACTS.resolve("v2").resolve("data-source-vectors.json").toFile());
    }

    @Test
    void dieFehlerCodesSindDieGruendeDesVertragsUndDieDerSchnittstelle() {
        List<String> gruende = StreamSupport.stream(vektoren.get("gruende").spliterator(), false)
                .map(g -> g.isTextual() ? g.asText() : g.get("code").asText()).toList();
        assertThat(Arrays.stream(DatenquelleRegeln.Grund.values()).map(DatenquelleRegeln.Grund::code).toList())
                .containsExactlyInAnyOrderElementsOf(gruende);

        List<String> soll = new ArrayList<>();
        Arrays.stream(DatenquelleRegeln.Grund.values()).forEach(g -> soll.add(g.code()));
        for (DatenquelleAbgelehnt.Schnittstelle s : DatenquelleAbgelehnt.Schnittstelle.values()) {
            assertThat(gruende).as("kein Code der Schnittstelle überdeckt einen Grund").doesNotContain(s.code());
            soll.add(s.code());
        }
        assertThat(liste(schema("DatenquelleFehler"), "properties", "code", "enum"))
                .containsExactlyInAnyOrderElementsOf(soll);
        assertThat(liste(schema("DatenquelleFehler"), "properties", "urteil", "enum"))
                .containsExactlyInAnyOrder("abgelehnt", "bestaetigung_noetig");
    }

    @Test
    void dasProtokollVokabularIstDasDesVertrags() {
        List<String> vertrag = StreamSupport.stream(vektoren.get("protokolle").spliterator(), false)
                .map(p -> p.isTextual() ? p.asText() : p.get("code").asText()).toList();
        List<String> regeln = Arrays.stream(DatenquelleRegeln.Protokoll.values())
                .map(DatenquelleRegeln.Protokoll::code).toList();
        assertThat(regeln).containsExactlyInAnyOrderElementsOf(vertrag);
        for (String s : List.of("Datenquelle", "DatenquelleAnlegen", "DatenquelleBearbeiten")) {
            assertThat(liste(schema(s), "properties", "protokoll", "enum")).as(s)
                    .containsExactlyInAnyOrderElementsOf(regeln);
        }
    }

    /** Die Vorschlagsliste (IP-4) nennt genau die Auslass-Gründe des Vertrags. */
    @Test
    void dieAuslassGruendeSindDieDesVertrags() {
        List<String> vertrag = StreamSupport.stream(vektoren.get("auslass_gruende").spliterator(), false)
                .map(g -> g.get("code").asText()).toList();
        assertThat(Arrays.stream(DatenquelleRegeln.AuslassGrund.values()).map(DatenquelleRegeln.AuslassGrund::code)
                .toList()).containsExactlyElementsOf(vertrag);
        assertThat(liste(schema("DatenquelleAusgelassen"), "properties", "grund", "enum"))
                .containsExactlyElementsOf(vertrag);
    }

    /** Jede Form der Schnittstelle trägt genau die Felder der OpenAPI — in der Schreibweise des Vertrags. */
    @Test
    void jedeFormTraegtGenauDieFelderDerOpenApi() {
        Map<String, Class<? extends Record>> formen = Map.ofEntries(
                Map.entry("DatenquelleBox", DatenquelleDto.Box.class),
                Map.entry("DatenquelleZeitraum", DatenquelleDto.Zeitraum.class),
                Map.entry("Datenquelle", DatenquelleDto.Datenquelle.class),
                Map.entry("DatenquelleRueckmeldung", DatenquelleDto.Rueckmeldung.class),
                Map.entry("DatenquelleListe", DatenquelleDto.Liste.class),
                Map.entry("DatenquelleAnlegen", DatenquelleDto.Anlegen.class),
                Map.entry("DatenquelleBearbeiten", DatenquelleDto.Bearbeiten.class),
                Map.entry("DatenquelleZuweisen", DatenquelleDto.Zuweisen.class),
                Map.entry("DatenquelleZugewiesen", DatenquelleDto.Zugewiesen.class),
                Map.entry("DatenquellePruefen", DatenquelleDto.Pruefen.class),
                Map.entry("DatenquelleUebergabe", DatenquelleDto.Uebergabe.class),
                Map.entry("DatenquellePruefergebnis", DatenquelleDto.Pruefergebnis.class),
                Map.entry("DatenquelleProtokollEintrag", DatenquelleDto.ProtokollEintrag.class),
                Map.entry("DatenquelleProtokoll", DatenquelleDto.Protokoll.class),
                Map.entry("DatenquelleVorschlagKomponente", DatenquelleDto.VorschlagKomponente.class),
                Map.entry("DatenquelleVorschlag", DatenquelleDto.Vorschlag.class),
                Map.entry("DatenquelleAusgelassen", DatenquelleDto.Ausgelassen.class),
                Map.entry("DatenquelleVorschlagsliste", DatenquelleDto.Vorschlagsliste.class),
                Map.entry("DatenquelleBestaetigt", DatenquelleDto.Bestaetigt.class),
                Map.entry("DatenquelleUebernehmen", DatenquelleDto.Uebernehmen.class),
                Map.entry("DatenquelleUebernommen", DatenquelleDto.Uebernommen.class));
        formen.forEach((name, form) -> {
            List<String> felder = Arrays.stream(form.getRecordComponents())
                    .map(c -> SNAKE.translate(c.getName())).toList();
            assertThat(map(schema(name), "properties").keySet()).as(name).containsExactlyInAnyOrderElementsOf(felder);
        });
        // Die Zuständigkeit spricht die Wörter des Antrags (Vertrag §5): effective_from, vergleich_bestaetigt.
        assertThat(map(schema("DatenquelleZuweisen"), "properties").keySet())
                .contains("effective_from", "vergleich_bestaetigt");
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
    private static List<String> liste(Map<String, Object> m, String... pfad) {
        Object o = m;
        for (String p : pfad) {
            o = ((Map<String, Object>) o).get(p);
        }
        return ((List<Object>) o).stream().map(String::valueOf).toList();
    }
}
