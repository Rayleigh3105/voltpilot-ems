package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.InternesAuditController;
import com.voltpilot.api.web.dto.InternesAuditDto;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.yaml.snakeyaml.Yaml;

/**
 * UEMS AP-19 IP-18: Routen, DTOs, Vokabular und der veröffentlichte Vertrag ({@code openapi.yaml}) laufen nicht
 * auseinander, und die Kopie des Abschlusses trifft die Prüfsumme des Vertrags {@code energiemanagement.md} (R9
 * AU-2029-0001 {@code 27a580b9…}). Rein — liest Quelltext-Klassen und Dateien, keine Datenbank.
 */
class InternesAuditSchnittstelleVertragTest {

    private static final String BASIS = "/api/v1/energiemanagement/audits";
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
        var rechte = Map.of("", Map.of("get", "ansehen", "post", "verwalten"), "/{id}",
                Map.of("get", "ansehen", "put", "verwalten"), "/{id}/durchgefuehrt", Map.of("post", "verwalten"),
                "/{id}/hinweise", Map.of("post", "verwalten"), "/{id}/abschliessen", Map.of("post", "freigeben"),
                "/{id}/absagen", Map.of("post", "verwalten"));
        for (var route : rechte.entrySet()) {
            var methoden = (Map<String, Object>) paths.get(BASIS + route.getKey());
            assertThat(methoden).as(route.getKey()).containsKeys(route.getValue().keySet().toArray(String[]::new));
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
                Map.entry("InternesAuditStand", InternesAuditDto.AuditStand.class),
                Map.entry("InternesAuditDurchgefuehrt", InternesAuditDto.Durchgefuehrt.class),
                Map.entry("InternesAuditHinweisFesthalten", InternesAuditDto.HinweisFesthalten.class),
                Map.entry("InternesAuditHinweisMassnahme", InternesAuditDto.HinweisMassnahme.class),
                Map.entry("InternesAuditBericht", InternesAuditDto.Bericht.class),
                Map.entry("InternesAuditAbschliessen", InternesAuditDto.Abschliessen.class),
                Map.entry("InternesAuditAbsagen", InternesAuditDto.Absagen.class),
                Map.entry("InternesAuditHinweis", InternesAuditDto.Hinweis.class),
                Map.entry("InternesAuditAbschluss", InternesAuditDto.Abschluss.class),
                Map.entry("InternesAudit", InternesAuditDto.Audit.class),
                Map.entry("InternesAuditMitVerlauf", InternesAuditDto.AuditMitVerlauf.class),
                Map.entry("InternesAuditNaechstes", InternesAuditDto.Naechstes.class),
                Map.entry("InternesAuditprogramm", InternesAuditDto.Auditprogramm.class));
        for (var dto : dtos.entrySet()) {
            var schema = (Map<String, Object>) schemas.get(dto.getKey());
            assertThat(schema).as(dto.getKey()).isNotNull();
            var props = (Map<String, Object>) schema.get("properties");
            var namen = mapper.getSerializationConfig().introspect(mapper.constructType(dto.getValue()))
                    .findProperties().stream().map(p -> p.getName()).toList();
            assertThat(props.keySet()).as(dto.getKey()).containsExactlyInAnyOrderElementsOf(namen);
        }
        // Zustand und Verlauf sprechen die Wörter des Vertrags (IP-2) und der Datenhaltung (IP-16, §5.6).
        var zustand = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) schemas
                .get("InternesAudit")).get("properties")).get("zustand");
        assertThat((List<String>) zustand.get("enum"))
                .containsExactlyElementsOf(EnergiemanagementRegeln.VOKABULARE.get("audit_zustand"));
        var art = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) schemas
                .get("InternesAuditAenderung")).get("properties")).get("art");
        assertThat((List<String>) art.get("enum")).containsExactlyInAnyOrder("audit_geplant", "audit_geaendert",
                "audit_durchgefuehrt", "hinweis", "audit_abgeschlossen", "audit_abgesagt");
        String repo = Files.readString(Path.of("src/main/java/com/voltpilot/api/uems/InternesAuditRepository.java"));
        for (String a : (List<String>) art.get("enum")) {
            assertThat(repo).as("Protokoll-Wort " + a).contains("\"" + a + "\"");
        }
    }

    /** IA3: die Kopie des Abschlusses AU-2029-0001 ist byte-gleich mit dem Vektor — und damit ihre Prüfsumme. */
    @Test
    void dieKopieDesAbschlussesTrifftDiePruefsummeDesVertrags() throws Exception {
        JsonNode vektor = vektor("R9 AU-2029-0001 Abschluss: Prüfsumme der Kopie");
        JsonNode k = vektor.at("/eingang/kopie");
        List<InternesAuditService.HinweisKopie> hinweise = new ArrayList<>();
        for (JsonNode h : k.path("hinweise")) {
            hinweise.add(new InternesAuditService.HinweisKopie(h.path("nr").asInt(), h.path("am").asText(),
                    h.path("festgestellt_von").asText(), h.path("eingetragen_von").asText(), h.path("wortlaut").asText(),
                    h.path("massnahme").asText()));
        }
        JsonNode b = k.path("bericht");
        var bericht = new InternesAuditDto.Bericht(b.path("bezeichnung").asText(), b.path("ablage").asText(),
                b.path("kennung").asText(), b.path("adresse").isNull() ? null : b.path("adresse").asText(),
                b.path("sha256").asText());
        List<String> feststellungen = new ArrayList<>();
        k.path("feststellungen").forEach(f -> feststellungen.add(f.asText()));
        var summe = EnergiemanagementRegeln.pruefsumme(InternesAuditService.kopie(k.path("kennzeichen").asText(),
                hinweise, feststellungen, bericht));
        assertThat(summe.get("kanonisch")).isEqualTo(vektor.at("/erwartet/kanonisch").asText());
        assertThat(summe.get("pruefsumme"))
                .isEqualTo("sha256:27a580b9761668e43f8cdc5afb66a4124f1394cb030a8629c8dc4f82a4d56701");
        // Ohne Bericht steht `bericht: null` in der Kopie — der Trigger verlangt genau das.
        assertThat(InternesAuditService.kopie("AU-2029-0002", List.of(), List.of(), null).toString())
                .isEqualTo("{\"kennzeichen\":\"AU-2029-0002\",\"hinweise\":[],\"feststellungen\":[],\"bericht\":null}");
    }

    /** Ein Audit wird nie gelöscht — der Controller hat keine Löschroute. */
    @Test
    void derControllerHatKeineLoeschroute() {
        List<Method> loeschen = Arrays.stream(InternesAuditController.class.getDeclaredMethods())
                .filter(m -> m.isAnnotationPresent(DeleteMapping.class)).toList();
        assertThat(loeschen).isEmpty();
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
