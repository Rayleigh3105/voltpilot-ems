package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.FeststellungController;
import com.voltpilot.api.web.dto.FeststellungDto;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.yaml.snakeyaml.Yaml;

/**
 * UEMS AP-19 IP-19: Routen, DTOs, Vokabular und der veröffentlichte Vertrag ({@code openapi.yaml}) laufen nicht
 * auseinander, die Kopie des Stands trifft die Prüfsumme des Vertrags {@code energiemanagement.md} (R11 F-2029-0001/1
 * {@code dbda6aff…}) und das Antwortfeld „Vier-Augen nicht erfüllbar“ spricht den Satz aus §5.8. Rein — liest
 * Quelltext-Klassen und Dateien, keine Datenbank.
 */
class FeststellungSchnittstelleVertragTest {

    private static final String BASIS = "/api/v1/energiemanagement/feststellungen";
    private static final Path VEKTOREN = Path.of("../../docs/contracts/v2/energiemanagement-vectors.json");

    @Test
    @SuppressWarnings("unchecked")
    void openapiNenntJedeRouteMitIhremRechtUndDieTatsaechlichenDtoFelder() throws Exception {
        Map<String, Object> api;
        try (var in = Files.newInputStream(Path.of("../../docs/contracts/openapi.yaml"))) {
            api = new Yaml().load(in);
        }
        var paths = (Map<String, Object>) api.get("paths");
        var schemas = (Map<String, Object>) ((Map<String, Object>) api.get("components")).get("schemas");
        var rechte = Map.of("", Map.of("get", "ansehen", "post", "verwalten"), "/{id}", Map.of("get", "ansehen"),
                "/{id}/eintraege", Map.of("post", "verwalten"), "/{id}/frist", Map.of("put", "verwalten"),
                "/{id}/verantwortlicher", Map.of("put", "verwalten"), "/{id}/wirksamkeit", Map.of("post", "freigeben"),
                "/{id}/wirksamkeit/beantragen", Map.of("post", "freigeben"),
                "/{id}/wirksamkeit/freigeben", Map.of("post", "freigeben"),
                "/{id}/wirksamkeit/ablehnen", Map.of("post", "freigeben"),
                "/{id}/abschliessen", Map.of("post", "freigeben"));
        for (var route : rechte.entrySet()) {
            var methoden = (Map<String, Object>) paths.get(BASIS + route.getKey());
            assertThat(methoden).as(route.getKey()).isNotNull()
                    .containsKeys(route.getValue().keySet().toArray(String[]::new));
            assertThat(methoden).as("keine Löschroute").doesNotContainKey("delete");
            for (var m : route.getValue().entrySet()) {
                var op = (Map<String, Object>) methoden.get(m.getKey());
                assertThat(op.get("description").toString()).as(m.getKey() + " " + route.getKey())
                        .contains("energiemanagement." + m.getValue());
                if (!m.getKey().equals("get")) {
                    assertThat(((Map<String, Object>) op.get("responses")).keySet()).contains("403", "422");
                }
            }
        }
        var mapper = new ObjectMapper();
        var dtos = Map.ofEntries(
                Map.entry("FeststellungQuelle", FeststellungDto.Quelle.class),
                Map.entry("FeststellungVorgabe", FeststellungDto.Vorgabe.class),
                Map.entry("FeststellungBezug", FeststellungDto.Bezug.class),
                Map.entry("FeststellungErfassen", FeststellungDto.Erfassen.class),
                Map.entry("FeststellungEintragFesthalten", FeststellungDto.EintragFesthalten.class),
                Map.entry("FeststellungFristAendern", FeststellungDto.FristAendern.class),
                Map.entry("FeststellungVerantwortlichAendern", FeststellungDto.VerantwortlichAendern.class),
                Map.entry("FeststellungStandFesthalten", FeststellungDto.StandFesthalten.class),
                Map.entry("FeststellungAblehnen", FeststellungDto.Ablehnen.class),
                Map.entry("FeststellungQuelleAus", FeststellungDto.QuelleAus.class),
                Map.entry("FeststellungVorgabeAus", FeststellungDto.VorgabeAus.class),
                Map.entry("FeststellungBezugAus", FeststellungDto.BezugAus.class),
                Map.entry("FeststellungFrist", FeststellungDto.Frist.class),
                Map.entry("Feststellung", FeststellungDto.Feststellung.class),
                Map.entry("FeststellungEintrag", FeststellungDto.Eintrag.class),
                Map.entry("FeststellungMassnahme", FeststellungDto.Massnahme.class),
                Map.entry("FeststellungStand", FeststellungDto.Stand.class),
                Map.entry("FeststellungVierAugen", FeststellungDto.VierAugen.class),
                Map.entry("FeststellungMitVerlauf", FeststellungDto.FeststellungMitVerlauf.class),
                Map.entry("FeststellungListe", FeststellungDto.Liste.class));
        for (var dto : dtos.entrySet()) {
            var schema = (Map<String, Object>) schemas.get(dto.getKey());
            assertThat(schema).as(dto.getKey()).isNotNull();
            var props = (Map<String, Object>) schema.get("properties");
            var namen = mapper.getSerializationConfig().introspect(mapper.constructType(dto.getValue()))
                    .findProperties().stream().map(p -> p.getName()).toList();
            assertThat(props.keySet()).as(dto.getKey()).containsExactlyInAnyOrderElementsOf(namen);
            if (schema.containsKey("required")) {
                assertThat((List<String>) schema.get("required")).as(dto.getKey() + " required")
                        .containsExactlyInAnyOrderElementsOf(namen);
            }
        }
        // Zustand, Quelle, Einträge, Ergebnis und Verlauf sprechen die Wörter des Vertrags (IP-2) und der Datenhaltung
        // (IP-16, §5.6).
        assertThat(aufzaehlung(schemas, "Feststellung", "zustand"))
                .containsExactlyElementsOf(EnergiemanagementRegeln.VOKABULARE.get("feststellung_zustand"));
        assertThat(aufzaehlung(schemas, "FeststellungQuelle", "art"))
                .containsExactlyElementsOf(EnergiemanagementRegeln.VOKABULARE.get("feststellung_quelle"));
        assertThat(aufzaehlung(schemas, "FeststellungEintrag", "art"))
                .containsExactlyElementsOf(EnergiemanagementRegeln.VOKABULARE.get("feststellung_eintrag"));
        assertThat(aufzaehlung(schemas, "FeststellungStand", "ergebnis"))
                .containsExactlyElementsOf(EnergiemanagementRegeln.VOKABULARE.get("wirksamkeit_ergebnis"));
        var art = aufzaehlung(schemas, "FeststellungAenderung", "art");
        assertThat(art).containsExactlyInAnyOrder("feststellung_erfasst", "eintrag", "feststellung_geaendert",
                "wirksamkeit_beantragt", "wirksamkeit_geprueft", "wirksamkeit_abgelehnt", "feststellung_abgeschlossen");
        String repo = Files.readString(Path.of("src/main/java/com/voltpilot/api/uems/FeststellungRepository.java"));
        for (String a : art) {
            assertThat(repo).as("Protokoll-Wort " + a).contains("\"" + a + "\"");
        }
        // Den Zustand `abgeschlossen` setzt der schließende Stand in der Datenbank — nie das Repository (IP-16).
        assertThat(repo).doesNotContain("zustand = 'abgeschlossen'", "SET zustand");
    }

    /** FS4: die Kopie des Stands F-2029-0001/1 ist byte-gleich mit dem Vektor — und damit ihre Prüfsumme. */
    @Test
    void dieKopieDesStandsTrifftDiePruefsummeDesVertrags() throws Exception {
        JsonNode vektor = vektor("R11 F-2029-0001 Wirksamkeit Stand Nr. 1: Prüfsumme der Kopie");
        JsonNode k = vektor.at("/eingang/kopie");
        List<FeststellungService.MassnahmeKopie> massnahmen = new ArrayList<>();
        for (JsonNode m : k.path("massnahmen")) {
            massnahmen.add(new FeststellungService.MassnahmeKopie(m.path("kennzeichen").asText(),
                    m.path("zustand").asText(), m.path("umgesetzt_am").asText()));
        }
        JsonNode a = k.path("aufgabe");
        var zuordnung = new FeststellungRepository.Zuordnung(a.path("aufgabe").asText(), a.path("person").asText(),
                a.path("vertretung").asText(), LocalDate.parse(a.path("gilt_ab").asText()),
                a.path("entschieden_von").asText());
        var summe = EnergiemanagementRegeln.pruefsumme(FeststellungService.kopie(k.path("feststellung").asText(),
                k.path("wortlaut").asText(), k.path("eintraege").asInt(), massnahmen, a.path("aufgabe").asText(),
                zuordnung, k.path("am").asText()));
        assertThat(summe.get("kanonisch")).isEqualTo(vektor.at("/erwartet/kanonisch").asText());
        assertThat(summe.get("pruefsumme"))
                .isEqualTo("sha256:dbda6affa5cfa0796bbdcc1ef1f2eb0d1725e7534b404ac9db5b706525f15b04");
        // Ohne Aufgabe im Bezug steht `aufgabe: null`; eine Aufgabe ohne laufende Zuordnung nennt niemanden.
        assertThat(FeststellungService.kopie("F-2029-0002", "x", 0, List.of(), null, null, "2029-04-15").toString())
                .isEqualTo("{\"feststellung\":\"F-2029-0002\",\"wortlaut\":\"x\",\"eintraege\":0,\"massnahmen\":[],"
                        + "\"aufgabe\":null,\"am\":\"2029-04-15\"}");
        assertThat(FeststellungService.kopie("F-2029-0002", "x", 0, List.of(), "bezugsbasen", null, "2029-04-15")
                .path("aufgabe").path("person").isNull()).isTrue();
    }

    /** FS6/W15: der Satz des Antwortfelds ist die Schablone aus §5.8 mit den Namen der Berechtigten. */
    @Test
    void vierAugenNichtErfuellbarSprichtDenSatzAusDemVertrag() throws Exception {
        JsonNode vektor = vektor("§5.8 vieraugen_nicht_erfuellbar");
        assertThat(FeststellungService.aufzaehlung(List.of("Ines Kaltenbach", "Jonas Wendlinger")))
                .isEqualTo(vektor.at("/eingang/werte/personen").asText());
        assertThat(FeststellungService.aufzaehlung(List.of("A", "B", "C"))).isEqualTo("A, B und C");
        assertThat(FeststellungService.aufzaehlung(List.of("A"))).isEqualTo("A");
        String service = Files.readString(Path.of("src/main/java/com/voltpilot/api/uems/FeststellungService.java"));
        assertThat(service).contains("\"vieraugen_nicht_erfuellbar\"", "\"beide\"");
    }

    /** Eine Feststellung wird nie gelöscht — der Controller hat keine Löschroute. */
    @Test
    void derControllerHatKeineLoeschroute() {
        List<Method> loeschen = Arrays.stream(FeststellungController.class.getDeclaredMethods())
                .filter(m -> m.isAnnotationPresent(DeleteMapping.class)).toList();
        assertThat(loeschen).isEmpty();
    }

    @SuppressWarnings("unchecked")
    private static List<String> aufzaehlung(Map<String, Object> schemas, String schema, String feld) {
        var props = (Map<String, Object>) ((Map<String, Object>) schemas.get(schema)).get("properties");
        return (List<String>) ((Map<String, Object>) props.get(feld)).get("enum");
    }

    private static JsonNode vektor(String name) throws Exception {
        for (JsonNode v : new ObjectMapper().readTree(Files.readString(VEKTOREN)).path("cases")) {
            if (v.path("name").asText().equals(name)) {
                return v;
            }
        }
        throw new AssertionError("kein Vektor " + name);
    }
}
