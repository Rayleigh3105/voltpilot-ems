package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.EnergiemanagementNachweiseController;
import com.voltpilot.api.web.dto.EnergiemanagementDokumentDto;
import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto.PersonKurz;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.web.bind.annotation.GetMapping;
import org.yaml.snakeyaml.Yaml;

/**
 * UEMS AP-19 IP-14: Routen, DTOs und der veröffentlichte Vertrag ({@code openapi.yaml}) der Nachweise laufen nicht
 * auseinander; der Leser liest nur über die Dienste; Ort-Satz und Bekanntmachung sind die Sätze der Vektoren
 * ({@code energiemanagement-vectors.json}, §5.8). Rein — liest Quelltext-Klassen und Dateien, keine Datenbank.
 */
class EnergiemanagementNachweiseSchnittstelleVertragTest {

    private static final String BASIS = "/api/v1/energiemanagement";

    @Test
    @SuppressWarnings("unchecked")
    void openapiNenntJedeLeseRouteMitIhremRechtUndDieTatsaechlichenDtoFelder() throws Exception {
        Map<String, Object> api;
        try (var in = Files.newInputStream(Path.of("../../docs/contracts/openapi.yaml"))) {
            api = new Yaml().load(in);
        }
        var paths = (Map<String, Object>) api.get("paths");
        var schemas = (Map<String, Object>) ((Map<String, Object>) api.get("components")).get("schemas");
        for (String route : List.of("/energieeinsaetze/{id}/nachweise", "/personen/{id}/nachweise",
                "/bekanntmachungen")) {
            var methoden = (Map<String, Object>) paths.get(BASIS + route);
            assertThat(methoden).as(route).isNotNull();
            assertThat(methoden).as("nur lesen: festgehalten wird über POST …/dokumente")
                    .doesNotContainKeys("post", "put", "patch", "delete");
            var op = (Map<String, Object>) methoden.get("get");
            assertThat(op.get("description").toString()).as(route).contains("energiemanagement.ansehen");
        }
        // Der Controller hat genau diese drei Routen, alle lesend.
        List<String> routen = new ArrayList<>();
        for (Method m : EnergiemanagementNachweiseController.class.getDeclaredMethods()) {
            if (m.isAnnotationPresent(GetMapping.class)) {
                routen.addAll(Arrays.asList(m.getAnnotation(GetMapping.class).value()));
            }
        }
        assertThat(routen).containsExactlyInAnyOrder("/energieeinsaetze/{id}/nachweise", "/personen/{id}/nachweise",
                "/bekanntmachungen");

        var mapper = new ObjectMapper();
        var dtos = Map.ofEntries(
                Map.entry("EnergiemanagementDokumentBezug", EnergiemanagementDokumentDto.Bezug.class),
                Map.entry("EnergiemanagementDokumentBezugAus", EnergiemanagementDokumentDto.BezugAus.class),
                Map.entry("EnergiemanagementEinsatzKurz", EnergiemanagementDokumentDto.EinsatzKurz.class),
                Map.entry("EnergiemanagementAufgabeKurz", EnergiemanagementDokumentDto.AufgabeKurz.class),
                Map.entry("EnergiemanagementNachweisOrt", EnergiemanagementDokumentDto.NachweisOrt.class),
                Map.entry("EnergiemanagementKommunikationsnachweis",
                        EnergiemanagementDokumentDto.Kommunikationsnachweis.class),
                Map.entry("EnergiemanagementKommunikationsnachweise",
                        EnergiemanagementDokumentDto.Kommunikationsnachweise.class),
                Map.entry("EnergiemanagementNachweis", EnergiemanagementDokumentDto.Nachweis.class),
                Map.entry("EnergiemanagementNachweiseAmEinsatz", EnergiemanagementDokumentDto.NachweiseAmEinsatz.class),
                Map.entry("EnergiemanagementNachweiseDerPerson", EnergiemanagementDokumentDto.NachweiseDerPerson.class));
        for (var dto : dtos.entrySet()) {
            var schema = (Map<String, Object>) schemas.get(dto.getKey());
            assertThat(schema).as(dto.getKey()).isNotNull();
            var props = (Map<String, Object>) schema.get("properties");
            var namen = mapper.getSerializationConfig().introspect(mapper.constructType(dto.getValue()))
                    .findProperties().stream().map(p -> p.getName()).toList();
            assertThat(props.keySet()).as(dto.getKey()).containsExactlyInAnyOrderElementsOf(namen);
        }
        // Die Vokabulare sind die des Vertrags: Ort-Wörter des Verzeichnisses, Wege der Bekanntmachung.
        assertThat(aufzaehlung(schemas, "EnergiemanagementNachweisOrt", "ort"))
                .containsExactlyElementsOf(EnergiemanagementRegeln.WOERTER.get("verzeichnis_ort").keySet());
        var wege = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) schemas
                .get("EnergiemanagementKommunikationsnachweis")).get("properties")).get("wege")).get("items");
        assertThat((List<String>) wege.get("enum"))
                .containsExactlyElementsOf(EnergiemanagementRegeln.VOKABULARE.get("bekanntmachung_weg"));
        var ohneWeiteren = new ArrayList<>(EnergiemanagementRegeln.VOKABULARE.get("bekanntmachung_weg"));
        ohneWeiteren.remove("weiterer");
        assertThat(EnergiemanagementNachweise.WEG_WORT.keySet()).containsExactlyInAnyOrderElementsOf(ohneWeiteren);
    }

    /** VZ1-Muster: der Leser hält keine eigene Abfrage und kein Repository — er liest über die Dienste. */
    @Test
    void derLeserLiestNurUeberDieDienste() throws Exception {
        String text = Files.readString(Path.of("src/main/java/com/voltpilot/api/uems/EnergiemanagementNachweise.java"));
        assertThat(text).doesNotContain("JdbcTemplate", "SELECT ", "INSERT ", "UPDATE ", "DELETE ");
        assertThat(Arrays.stream(EnergiemanagementNachweise.class.getDeclaredFields())
                .map(f -> f.getType().getSimpleName()).filter(n -> n.endsWith("Repository")).toList()).isEmpty();
    }

    /** §5.8 {@code ort_verweis}: die Angaben „IH-SG-01, Rev. 4 vom 03.11.2028“ (R7) und „UW-2028-014 vom 24.01.2028“ (R8). */
    @Test
    void derOrtSatzIstDerSatzDesVertrags() throws Exception {
        assertThat(EnergiemanagementNachweise.angaben("IH-SG-01", "Rev. 4 vom 03.11.2028", LocalDate.parse("2028-11-03")))
                .isEqualTo(vektor("§5.8 ort_verweis").at("/eingang/werte/angaben").asText());
        assertThat(EnergiemanagementNachweise.angaben("UW-2028-014", null, LocalDate.parse("2028-01-24")))
                .isEqualTo("UW-2028-014 vom 24.01.2028");
        assertThat(EnergiemanagementNachweise.angaben(null, null, null)).isNull();
        assertThat(EnergiemanagementNachweise.angaben(null, null, LocalDate.parse("2028-01-24"))).isEqualTo("vom 24.01.2028");

        var verweis = new EnergiemanagementDokumentDto.Verweis("Arbeitsplan Spritzgussmaschinen, Rev. 4",
                "Instandhaltungssystem, Arbeitspläne", "IH-SG-01", "https://instandhaltung.ahrenberg.example/plan/IH-SG-01",
                "Rev. 4 vom 03.11.2028", LocalDate.parse("2028-11-03"), "f0570ce5f1d332e648fe404bfe958841213b08b91c17667c3b0cd28c6acd49f9");
        var ort = EnergiemanagementNachweise.ort(dokument("betrieb", verweis, List.of()));
        assertThat(ort.satz()).isEqualTo(vektor("§5.8 ort_verweis").at("/erwartet/satz").asText());
        assertThat(ort.ortSatz()).isEqualTo("Geführt in Ihrem System: Instandhaltungssystem, Arbeitspläne");
        assertThat(ort.adresseAlsVerweis()).isTrue();
        assertThat(ort.inhaltInVoltpilot()).isFalse();
        var ohneHttps = new EnergiemanagementDokumentDto.Verweis(null, "Personalsystem", null,
                "http://intranet/uw", null, null, null);
        assertThat(EnergiemanagementNachweise.ort(dokument("kompetenz", ohneHttps, List.of())).adresseAlsVerweis())
                .as("nur https: wird als Verweis gezeigt (KS1)").isFalse();
    }

    /** DK6, §5.8 {@code bekanntmachung}: zwei Einträge (Aushang, Intranet) am selben Tag sind eine Mitteilung. */
    @Test
    void eineMitteilungUeberZweiWegeIstEineBekanntmachung() throws Exception {
        var ik = new PersonKurz(UUID.randomUUID(), "Ines Kaltenbach", "Energiemanagement", "IK", true);
        var am = LocalDate.parse("2026-12-18");
        var kreis = "alle Mitarbeitenden beider Werke";
        var eintraege = List.of(eintrag(1, am, kreis, "aushang", null, ik), eintrag(2, am, kreis, "intranet", null, ik),
                eintrag(3, LocalDate.parse("2027-01-10"), kreis, "weiterer", "Betriebsversammlung", ik));
        var k = EnergiemanagementNachweise.kommunikation(dokument("energiepolitik", null, eintraege));
        assertThat(k).hasSize(2);
        assertThat(k.get(0).wege()).containsExactly("aushang", "intranet");
        assertThat(k.get(0).satz()).isEqualTo(vektor("§5.8 bekanntmachung").at("/erwartet/satz").asText());
        assertThat(k.get(1).wegeWort()).isEqualTo("Betriebsversammlung");
        assertThat(EnergiemanagementNachweise.aufzaehlung(List.of("Aushang", "Intranet", "Besprechung")))
                .isEqualTo("Aushang, Intranet und Besprechung");
    }

    private static EnergiemanagementDokumentDto.Dokument dokument(String art, EnergiemanagementDokumentDto.Verweis v,
            List<EnergiemanagementDokumentDto.Eintrag> eintraege) {
        var fassung = new EnergiemanagementDokumentDto.Fassung(1, v == null ? "wortlaut" : "verweis",
                v == null ? "Wortlaut" : null, v, null, "freigegeben", null, null, "sha256:x", false, null,
                LocalDate.parse("2028-11-10"), null, null, null, null, null, null);
        return new EnergiemanagementDokumentDto.Dokument(UUID.randomUUID(), "D-0004", art, art, "vorgabe", "Titel",
                null, "gueltig", 12, null, 1, List.of(fassung), eintraege, null, null, null, List.of());
    }

    private static EnergiemanagementDokumentDto.Eintrag eintrag(long id, LocalDate am, String kreis, String weg,
            String wortlaut, PersonKurz person) {
        return new EnergiemanagementDokumentDto.Eintrag(id, "bekannt_gemacht", 1, am, person, null, kreis, weg,
                wortlaut, null, null, null, null, null);
    }

    private static final Map<String, JsonNode> VEKTOREN = new HashMap<>();

    private static JsonNode vektor(String name) throws Exception {
        if (VEKTOREN.isEmpty()) {
            for (JsonNode c : new ObjectMapper().readTree(Path.of("../../docs/contracts/v2/energiemanagement-vectors.json")
                    .toFile()).path("cases")) {
                VEKTOREN.put(c.path("name").asText(), c);
            }
        }
        return VEKTOREN.get(name);
    }

    @SuppressWarnings("unchecked")
    private static List<String> aufzaehlung(Map<String, Object> schemas, String schema, String feld) {
        var props = (Map<String, Object>) ((Map<String, Object>) schemas.get(schema)).get("properties");
        return (List<String>) ((Map<String, Object>) props.get(feld)).get("enum");
    }
}
