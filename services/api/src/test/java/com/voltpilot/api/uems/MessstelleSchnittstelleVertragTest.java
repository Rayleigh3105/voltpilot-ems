package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.web.dto.MessstelleDto;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.StreamSupport;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Rein, ohne Docker: die Messstellen-Schnittstelle sagt in drei Dateien DASSELBE — der
 * Messstellen-Vertrag ({@code messstelle.schema.json}), die Java-Form ({@link MessstelleDto})
 * und {@code docs/contracts/openapi.yaml}. Dazu die Akteur-Regel an ihrer EINEN Stelle.
 */
class MessstelleSchnittstelleVertragTest {

    private static final Path CONTRACTS = Path.of("..", "..", "docs", "contracts");
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final List<String> NUR_SCHNITTSTELLE = List.of("id", "fehlt", "angehalten_ab", "archiviert_am");

    private static Map<String, Object> schemas;
    private static JsonNode vertrag;

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void lade() throws IOException {
        try (InputStream in = Files.newInputStream(CONTRACTS.resolve("openapi.yaml"))) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
        }
        vertrag = MAPPER.readTree(CONTRACTS.resolve("v2").resolve("messstelle.schema.json").toFile());
    }

    @Test
    void dieFehlerCodesSindDieDesVertragsUndDieDerSchnittstelle() {
        List<String> openapi = liste(schema("MessstelleFehler"), "properties", "code", "enum");
        assertThat(openapi).containsExactlyElementsOf(MessstelleAbgelehnt.CODES);
        // Die Codes des Vertrags stehen vollzählig und vorn — in der Reihenfolge seiner Fehlertabelle.
        assertThat(MessstelleAbgelehnt.CODES.subList(0, MessstelleRegeln.Fehler.values().length))
                .containsExactlyElementsOf(Arrays.stream(MessstelleRegeln.Fehler.values())
                        .map(MessstelleRegeln.Fehler::code).toList());
        List<String> vertragsCodes = StreamSupport.stream(vertrag.at("/$defs/fehlerCode/enum").spliterator(), false)
                .map(JsonNode::asText).toList();
        assertThat(MessstelleAbgelehnt.CODES).containsAll(vertragsCodes);
        // Kein Code der Schnittstelle überdeckt einen des Vertrags.
        for (MessstelleAbgelehnt.Schnittstelle s : MessstelleAbgelehnt.Schnittstelle.values()) {
            assertThat(vertragsCodes).doesNotContain(s.code());
        }
    }

    @Test
    void dieAntwortIstDieMessstelleDesVertragsPlusVierFelderDerSchnittstelle() {
        Set<String> soll = new LinkedHashSet<>();
        vertrag.at("/$defs/messstelle/required").forEach(n -> soll.add(n.asText()));
        soll.addAll(NUR_SCHNITTSTELLE);

        Set<String> dto = new LinkedHashSet<>();
        PropertyNamingStrategies.SnakeCaseStrategy snake = new PropertyNamingStrategies.SnakeCaseStrategy();
        Arrays.stream(MessstelleDto.Messstelle.class.getRecordComponents())
                .forEach(c -> dto.add(snake.translate(c.getName())));
        assertThat(dto).containsExactlyInAnyOrderElementsOf(soll);

        Map<String, Object> messstelle = schema("Messstelle");
        assertThat(liste(messstelle, "required")).containsExactlyInAnyOrderElementsOf(soll);
        assertThat(map(messstelle, "properties").keySet()).containsExactlyInAnyOrderElementsOf(soll);

        Set<String> neben = new LinkedHashSet<>();
        vertrag.at("/$defs/nebengroesse/required").forEach(n -> neben.add(n.asText()));
        Set<String> nebenDto = new LinkedHashSet<>();
        Arrays.stream(MessstelleDto.Nebengroesse.class.getRecordComponents())
                .forEach(c -> nebenDto.add(snake.translate(c.getName())));
        assertThat(nebenDto).containsExactlyInAnyOrderElementsOf(neben);
    }

    @Test
    void dieAnfragenTragenGenauDieFelderDerOpenApi() {
        assertThat(map(schema("MessstelleAnlegen"), "properties").keySet()).containsExactlyInAnyOrderElementsOf(
                Arrays.stream(MessstelleDto.Anlegen.class.getRecordComponents()).map(c -> c.getName()).toList());
        assertThat(map(schema("MessstelleBearbeiten"), "properties").keySet()).containsExactlyInAnyOrderElementsOf(
                Arrays.stream(MessstelleDto.Bearbeiten.class.getRecordComponents()).map(c -> c.getName()).toList());
        assertThat(map(schema("MessstelleUebergang"), "properties").keySet()).containsExactlyInAnyOrderElementsOf(
                Arrays.stream(MessstelleDto.Uebergang.class.getRecordComponents()).map(c -> c.getName()).toList());
        // Der Größen-Katalog der OpenAPI benutzt dieselben Wörter wie der Vertrag.
        Map<String, Object> groesse = map(schema("MessGroesse"), "properties");
        for (String[] feld : new String[][] {{"groesse", "groesseName"}, {"richtung", "richtung"},
                {"einheit", "einheit"}, {"wertart", "wertart"}}) {
            List<String> woerter = StreamSupport.stream(vertrag.at("/$defs/" + feld[1] + "/enum").spliterator(), false)
                    .map(JsonNode::asText).toList();
            assertThat(liste(map(groesse, feld[0]), "enum")).as(feld[0]).containsExactlyElementsOf(woerter);
        }
    }

    /** AP-03 E12: jeder heutige Kundenbenutzer ist Kundenadministrator; der Plattform-Admin ist VoltPilot. */
    @Test
    void derUrheberKommtAusDerEinenStelle() {
        ProtokollAkteur kunde = ProtokollAkteur.fuer("sub-jonas", "Jonas Wendlinger", false);
        assertThat(kunde).isEqualTo(new ProtokollAkteur("sub-jonas", "Jonas Wendlinger",
                RechteAbleitung.Rolle.KUNDENADMINISTRATOR.code(), "kunde"));
        ProtokollAkteur betrieb = ProtokollAkteur.fuer("sub-admin", "  admin ", true);
        assertThat(betrieb).isEqualTo(new ProtokollAkteur("sub-admin", "admin",
                RechteAbleitung.Rolle.VOLTPILOT_BETRIEB.code(), "voltpilot"));
        // Ohne Anzeigenamen trägt der Eintrag das Subject — nie einen leeren Namen.
        assertThat(ProtokollAkteur.fuer("sub-ohne-namen", " ", false).name()).isEqualTo("sub-ohne-namen");
        assertThat(ProtokollAkteur.aus(null)).isEmpty();
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
