package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.EnergiemanagementDokumentController;
import com.voltpilot.api.web.dto.EnergiemanagementDokumentDto;
import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.yaml.snakeyaml.Yaml;

/**
 * UEMS AP-19 IP-7: Routen, DTOs, Vokabulare und der veröffentlichte Vertrag ({@code openapi.yaml}) der Dokumente laufen
 * nicht auseinander. Rein — liest Quelltext-Klassen und Dateien, keine Datenbank.
 */
class EnergiemanagementDokumentSchnittstelleVertragTest {

    private static final String BASIS = "/api/v1/energiemanagement/dokumente";

    @Test
    @SuppressWarnings("unchecked")
    void openapiNenntJedeRouteMitIhremRechtUndDieTatsaechlichenDtoFelder() throws Exception {
        Map<String, Object> api;
        try (var in = Files.newInputStream(Path.of("../../docs/contracts/openapi.yaml"))) {
            api = new Yaml().load(in);
        }
        var paths = (Map<String, Object>) api.get("paths");
        var schemas = (Map<String, Object>) ((Map<String, Object>) api.get("components")).get("schemas");
        // Schreibrouten: welches Recht; Leserouten „ansehen“.
        Map<String, Map<String, String>> routen = Map.of(
                "", Map.of("get", "ansehen", "post", "verwalten"),
                "/{id}", Map.of("get", "ansehen"),
                "/{id}/vergleich", Map.of("get", "ansehen"),
                "/{id}/fassungen", Map.of("post", "verwalten"),
                "/{id}/fassungen/{nr}/beantragen", Map.of("post", "freigeben"),
                "/{id}/fassungen/{nr}/freigeben", Map.of("post", "freigeben"),
                "/{id}/fassungen/{nr}/ablehnen", Map.of("post", "freigeben"),
                "/{id}/geprueft", Map.of("post", "freigeben"),
                "/{id}/bekanntmachungen", Map.of("post", "verwalten"),
                "/{id}/aufheben", Map.of("post", "freigeben"));
        for (var route : routen.entrySet()) {
            var methoden = (Map<String, Object>) paths.get(BASIS + route.getKey());
            assertThat(methoden).as(route.getKey()).isNotNull();
            assertThat(methoden).as("keine Löschroute, kein Überschreiben (DK8, Invariante 6)")
                    .doesNotContainKeys("delete", "put", "patch");
            for (var m : route.getValue().entrySet()) {
                var op = (Map<String, Object>) methoden.get(m.getKey());
                assertThat(op).as(m.getKey() + " " + route.getKey()).isNotNull();
                assertThat(op.get("description").toString()).as(m.getKey() + " " + route.getKey())
                        .contains("energiemanagement." + m.getValue());
                if (!m.getKey().equals("get")) {
                    assertThat(((Map<String, Object>) op.get("responses")).keySet()).contains("403", "422");
                }
            }
        }
        assertThat(paths.keySet().stream().filter(p -> p.startsWith(BASIS)).toList())
                .as("jede Dokument-Route steht oben").hasSize(routen.size());

        var mapper = new ObjectMapper();
        var dtos = Map.ofEntries(
                Map.entry("EnergiemanagementDokumentBezug", EnergiemanagementDokumentDto.Bezug.class),
                Map.entry("EnergiemanagementDokumentAnlegen", EnergiemanagementDokumentDto.DokumentAnlegen.class),
                Map.entry("EnergiemanagementVerweis", EnergiemanagementDokumentDto.Verweis.class),
                Map.entry("EnergiemanagementAusschluss", EnergiemanagementDokumentDto.Ausschluss.class),
                Map.entry("EnergiemanagementAnwendungsbereichEingang",
                        EnergiemanagementDokumentDto.AnwendungsbereichEingang.class),
                Map.entry("EnergiemanagementFassungEntwerfen", EnergiemanagementDokumentDto.FassungEntwerfen.class),
                Map.entry("EnergiemanagementEntscheid", EnergiemanagementDokumentDto.Entscheid.class),
                Map.entry("EnergiemanagementAblehnen", EnergiemanagementDokumentDto.Ablehnen.class),
                Map.entry("EnergiemanagementGeprueft", EnergiemanagementDokumentDto.Geprueft.class),
                Map.entry("EnergiemanagementBekanntmachen", EnergiemanagementDokumentDto.Bekanntmachen.class),
                Map.entry("EnergiemanagementAufheben", EnergiemanagementDokumentDto.Aufheben.class),
                Map.entry("EnergiemanagementStandortKurz", EnergiemanagementDokumentDto.StandortKurz.class),
                Map.entry("EnergiemanagementDokumentBezugAus", EnergiemanagementDokumentDto.BezugAus.class),
                Map.entry("EnergiemanagementAnwendungsbereich", EnergiemanagementDokumentDto.Anwendungsbereich.class),
                Map.entry("EnergiemanagementFassung", EnergiemanagementDokumentDto.Fassung.class),
                Map.entry("EnergiemanagementDokumentEintrag", EnergiemanagementDokumentDto.Eintrag.class),
                Map.entry("EnergiemanagementUeberpruefung", EnergiemanagementDokumentDto.Ueberpruefung.class),
                Map.entry("EnergiemanagementDokumentSaetze", EnergiemanagementDokumentDto.Saetze.class),
                Map.entry("EnergiemanagementDokumentKurz", EnergiemanagementDokumentDto.DokumentKurz.class),
                Map.entry("EnergiemanagementDokumente", EnergiemanagementDokumentDto.Dokumente.class),
                Map.entry("EnergiemanagementDokumentAenderung", EnergiemanagementPersonenDto.Aenderung.class),
                Map.entry("EnergiemanagementDokument", EnergiemanagementDokumentDto.Dokument.class),
                Map.entry("EnergiemanagementBetrachtungsumfang", EnergiemanagementDokumentDto.Betrachtungsumfang.class),
                Map.entry("EnergiemanagementVergleichErgebnis", EnergiemanagementDokumentDto.VergleichErgebnis.class),
                Map.entry("EnergiemanagementVergleich", EnergiemanagementDokumentDto.Vergleich.class));
        for (var dto : dtos.entrySet()) {
            var schema = (Map<String, Object>) schemas.get(dto.getKey());
            assertThat(schema).as(dto.getKey()).isNotNull();
            var props = (Map<String, Object>) schema.get("properties");
            var namen = mapper.getSerializationConfig().introspect(mapper.constructType(dto.getValue()))
                    .findProperties().stream().map(p -> p.getName()).toList();
            assertThat(props.keySet()).as(dto.getKey()).containsExactlyInAnyOrderElementsOf(namen);
        }
        // Die Vokabulare sind die des Vertrags energiemanagement-vectors.json (IP-2), zeilengleich.
        assertThat(aufzaehlung(schemas, "EnergiemanagementDokumentAnlegen", "art"))
                .containsExactlyElementsOf(EnergiemanagementRegeln.VOKABULARE.get("dokument_art"));
        assertThat(aufzaehlung(schemas, "EnergiemanagementDokumentBezug", "art"))
                .containsExactlyElementsOf(EnergiemanagementRegeln.VOKABULARE.get("dokument_bezug"));
        assertThat(aufzaehlung(schemas, "EnergiemanagementFassungEntwerfen", "form"))
                .containsExactlyElementsOf(EnergiemanagementRegeln.VOKABULARE.get("fassung_form"));
        assertThat(aufzaehlung(schemas, "EnergiemanagementFassung", "status"))
                .containsExactlyElementsOf(EnergiemanagementRegeln.VOKABULARE.get("fassung_status"));
        assertThat(aufzaehlung(schemas, "EnergiemanagementDokumentKurz", "zustand"))
                .containsExactlyElementsOf(EnergiemanagementRegeln.VOKABULARE.get("dokument_zustand"));
        assertThat(aufzaehlung(schemas, "EnergiemanagementDokumentEintrag", "art"))
                .containsExactlyElementsOf(EnergiemanagementRegeln.VOKABULARE.get("dokument_eintrag"));
        assertThat(aufzaehlung(schemas, "EnergiemanagementBekanntmachen", "weg"))
                .containsExactlyElementsOf(EnergiemanagementRegeln.VOKABULARE.get("bekanntmachung_weg"));
        var traeger = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) schemas
                .get("EnergiemanagementAnwendungsbereichEingang")).get("properties")).get("traeger")).get("items");
        assertThat((List<String>) traeger.get("enum")).containsExactlyElementsOf(BewertungRegeln.TRAEGER);
        // Das Protokoll der Dokumente: §5.6, Wörter von energiemanagement_protokoll (IP-5) ohne Person, Aufgabe,
        // Einstellung.
        assertThat(aufzaehlung(schemas, "EnergiemanagementDokumentAenderung", "art")).containsExactly(
                "dokument_angelegt", "fassung_entworfen", "fassung_beantragt", "fassung_freigegeben",
                "fassung_abgelehnt", "dokument_gueltig", "fassung_abgeloest", "geprueft_bleibt", "bekannt_gemacht",
                "dokument_aufgehoben");
    }

    /**
     * VZ1: die Verzeichnis-Quelle ordnet jede Art einer Gruppe des Vertrags zu und liest nur über den Dienst — keine
     * eigene Abfrage (Muster {@code AufgabenVerzeichnis}).
     */
    @Test
    void dieVerzeichnisQuelleKenntJedeArtUndHaeltKeineEigeneAbfrage() throws Exception {
        assertThat(DokumentVerzeichnis.GRUPPE.keySet())
                .containsExactlyInAnyOrderElementsOf(EnergiemanagementRegeln.VOKABULARE.get("dokument_art"));
        assertThat(EnergiemanagementRegeln.VOKABULARE.get("verzeichnis_gruppe"))
                .containsAll(DokumentVerzeichnis.GRUPPE.values()).contains(DokumentVerzeichnis.BEKANNTMACHUNG);
        String text = Files.readString(Path.of("src/main/java/com/voltpilot/api/uems/DokumentVerzeichnis.java"));
        assertThat(text).doesNotContain("JdbcTemplate", "SELECT ", "INSERT ", "UPDATE ", "Repository");
    }

    /** DK8, Invariante 6: ein Dokument wird nie gelöscht und nie überschrieben — nur angehängt. */
    @Test
    void derControllerHatKeineLoeschOderUeberschreibroute() {
        List<Method> weg = Arrays.stream(EnergiemanagementDokumentController.class.getDeclaredMethods())
                .filter(m -> m.isAnnotationPresent(DeleteMapping.class) || m.isAnnotationPresent(PutMapping.class))
                .toList();
        assertThat(weg).isEmpty();
    }

    @SuppressWarnings("unchecked")
    private static List<String> aufzaehlung(Map<String, Object> schemas, String schema, String feld) {
        var props = (Map<String, Object>) ((Map<String, Object>) schemas.get(schema)).get("properties");
        return (List<String>) ((Map<String, Object>) props.get(feld)).get("enum");
    }
}
