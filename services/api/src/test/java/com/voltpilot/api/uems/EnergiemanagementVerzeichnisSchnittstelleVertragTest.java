package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.EnergiemanagementVerzeichnisDto;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * UEMS AP-19 IP-8: das Verzeichnis läuft nicht vom veröffentlichten Vertrag ({@code openapi.yaml},
 * {@code energiemanagement.md}) weg, liest nur über die Dienste (VZ1: gelesen, nie kopiert) und nennt keine Zahl über
 * das Ganze (G4, Quelltext-Probe). Rein — liest Quelltext und Dateien, keine Datenbank.
 */
class EnergiemanagementVerzeichnisSchnittstelleVertragTest {

    private static final Path UEMS = Path.of("src/main/java/com/voltpilot/api/uems");
    private static final Path WEB = Path.of("src/main/java/com/voltpilot/api/web");
    private static final List<String> LESER = List.of("EnergiemanagementVerzeichnisService", "VerzeichnisQuelle",
            "DokumentVerzeichnis", "AufgabenVerzeichnis", "VerzeichnisBestand", "AuditVerzeichnis");

    @Test
    @SuppressWarnings("unchecked")
    void openapiNenntDieRouteMitIhremRechtDenFilternUndDenDtoFeldern() throws Exception {
        Map<String, Object> api;
        try (var in = Files.newInputStream(Path.of("../../docs/contracts/openapi.yaml"))) {
            api = new Yaml().load(in);
        }
        var route = (Map<String, Object>) ((Map<String, Object>) api.get("paths"))
                .get("/api/v1/energiemanagement/verzeichnis");
        assertThat(route).as("GET …/verzeichnis").containsOnlyKeys("get");
        var get = (Map<String, Object>) route.get("get");
        assertThat(get.get("description").toString()).contains("energiemanagement.ansehen");
        var parameter = ((List<Map<String, Object>>) get.get("parameters")).stream().map(p -> p.get("name")).toList();
        assertThat(parameter).containsExactly("gruppe", "von", "bis", "person", "format");
        var gruppe = (Map<String, Object>) ((List<Map<String, Object>>) get.get("parameters")).get(0).get("schema");
        assertThat((List<String>) gruppe.get("enum")).containsExactlyElementsOf(EnergiemanagementVerzeichnisService.GRUPPEN);

        var schemas = (Map<String, Object>) ((Map<String, Object>) api.get("components")).get("schemas");
        var mapper = new ObjectMapper();
        var dtos = Map.of(
                "EnergiemanagementVerzeichnisZeile", EnergiemanagementVerzeichnisDto.Zeile.class,
                "EnergiemanagementVerzeichnisZuschnitt", EnergiemanagementVerzeichnisDto.Zuschnitt.class,
                "EnergiemanagementVerzeichnisGruppe", EnergiemanagementVerzeichnisDto.Gruppe.class,
                "EnergiemanagementVerzeichnisFilter", EnergiemanagementVerzeichnisDto.Filter.class,
                "EnergiemanagementVerzeichnis", EnergiemanagementVerzeichnisDto.Verzeichnis.class);
        for (var dto : dtos.entrySet()) {
            var schema = (Map<String, Object>) schemas.get(dto.getKey());
            assertThat(schema).as(dto.getKey()).isNotNull();
            var namen = mapper.getSerializationConfig().introspect(mapper.constructType(dto.getValue()))
                    .findProperties().stream().map(p -> p.getName()).toList();
            assertThat(((Map<String, Object>) schema.get("properties")).keySet()).as(dto.getKey())
                    .containsExactlyInAnyOrderElementsOf(namen);
            assertThat((List<String>) schema.get("required")).as(dto.getKey() + " required")
                    .containsExactlyInAnyOrderElementsOf(namen);
        }
    }

    /** VZ2: die Zeile trägt genau die Felder der Operation {@code verzeichnis_zeile} — keins mehr, keins weniger. */
    @Test
    void dieZeileIstDieAusgabeDerVertragsOperation() {
        Map<String, Object> aus = EnergiemanagementRegeln.verzeichnisZeile(new EnergiemanagementRegeln.VerzeichnisEingang(
                "grundlagen", "energiepolitik", "D-0001", "Energiepolitik", 1, "Robert Falk", "Ines Kaltenbach",
                "2027-01-15", "sha256:163a", "wortlaut_original_beim_kunden", "Ordner Geschäftsführung"));
        var mapper = new ObjectMapper();
        var namen = mapper.getSerializationConfig()
                .introspect(mapper.constructType(EnergiemanagementVerzeichnisDto.Zeile.class)).findProperties().stream()
                .map(p -> p.getName()).toList();
        assertThat(namen).containsExactlyInAnyOrderElementsOf(aus.keySet());
        // Jede Gruppe des Vokabulars nennt ihre Zeilen des Zuschnitts, jede mit einer Stufe aus G1.
        assertThat(EnergiemanagementVerzeichnisService.ZUSCHNITT.keySet())
                .containsExactlyInAnyOrderElementsOf(EnergiemanagementVerzeichnisService.GRUPPEN);
        EnergiemanagementVerzeichnisService.ZUSCHNITT.values().forEach(z -> assertThat(z).isNotEmpty()
                .allSatisfy(t -> assertThat(t.stufe()).isIn("in VoltPilot geführt",
                        "Wortlaut in VoltPilot, Original bei Ihnen", "Verweis auf Ihr System")));
    }

    /** VZ1: der Leser und seine Quellen halten keine eigene Abfrage — nur Dienste. */
    @Test
    void gelesenUeberDieDiensteNieUeberEigeneAbfragen() throws Exception {
        for (String klasse : LESER) {
            // Die Zeitzone des Unternehmens (Stichtag) ist kein Nachweis — sie liest der Leser wie jeder UEMS-Dienst.
            String text = Files.readString(UEMS.resolve(klasse + ".java")).replace("UnternehmenRepository", "");
            assertThat(text).as(klasse).doesNotContain("JdbcTemplate", "SELECT ", "INSERT ", "UPDATE ", "Repository");
        }
    }

    /**
     * G4, VZ3 (Quelltext-Probe): kein Leser und keine Route des Verzeichnisses rechnet eine Zahl über das Ganze oder
     * spricht ein Vollständigkeits- oder Prozent-Wort — keine Anzahl, kein Erfüllungsgrad, keine Ampel, kein „fehlt“.
     */
    @Test
    void keineZahlUeberDasGanzeUndKeinUrteilswort() throws Exception {
        Pattern verboten = Pattern.compile("(?i)vollst[aä]ndig|prozent|%|erf[uü]llungsgrad|ampel|anzahl|\\.count\\(|"
                + "\\.size\\(\\)|fehlt\"|konform|auditfest|zertifiz|bereit f[uü]r das audit");
        for (Path datei : List.of(UEMS.resolve("EnergiemanagementVerzeichnisService.java"),
                UEMS.resolve("VerzeichnisBestand.java"), UEMS.resolve("AuditVerzeichnis.java"), WEB.resolve("EnergiemanagementVerzeichnisController.java"),
                WEB.resolve("dto/EnergiemanagementVerzeichnisDto.java"))) {
            String code = ohneKommentare(Files.readString(datei));
            assertThat(verboten.matcher(code).results().map(m -> m.group()).toList()).as(datei.toString()).isEmpty();
        }
    }

    /** VZ4: die CSV — BOM, Kopfzeilen mit Stichtag und Verantwortungs-Satz, die Spalten, eine Zeile je Nachweis. */
    @Test
    void csvKopfMitStichtagUndVerantwortungsSatz() {
        var zeile = new EnergiemanagementVerzeichnisDto.Zeile("grundlagen", "energiepolitik", "D-0001",
                "Energiepolitik; Fassung \"neu\"", 1, "Robert Falk", "Ines Kaltenbach", LocalDate.parse("2027-01-15"),
                "sha256:163a", "wortlaut_original_beim_kunden", "Anwendungsbereich, Kontext und Energiepolitik",
                "Wortlaut in VoltPilot, Original bei Ihnen: Ordner Geschäftsführung");
        var formel = new EnergiemanagementVerzeichnisDto.Zeile("berichte", "berichtsstand", "B-1", "=HYPERLINK(1)",
                null, null, null, null, null, "in_voltpilot", "Berichte", "in VoltPilot");
        var v = new EnergiemanagementVerzeichnisDto.Verzeichnis(OffsetDateTime.parse("2029-02-12T08:00:00+01:00"),
                EnergiemanagementRegeln.SAETZE.get("verantwortung"),
                new EnergiemanagementVerzeichnisDto.Filter(null, null, LocalDate.parse("2029-02-12"),
                        UUID.randomUUID(), "Robert Falk"),
                List.of(new EnergiemanagementVerzeichnisDto.Gruppe("grundlagen", "G", List.of(), null, List.of(zeile)),
                        new EnergiemanagementVerzeichnisDto.Gruppe("berichte", "B", List.of(), null, List.of(formel))));
        String text = new String(EnergiemanagementVerzeichnisService.csv(v), StandardCharsets.UTF_8);
        assertThat(text).startsWith(BerichtCsv.BOM);
        List<String> zeilen = List.of(text.substring(1).split("\r\n"));
        assertThat(zeilen).containsExactly(
                "# Stichtag 12.02.2029 08:00",
                "# Inhalte und Entscheidungen Ihres Energiemanagements verantwortet Ihr Unternehmen. VoltPilot hält "
                        + "fest, wer was wann entschieden hat, und beurteilt nicht, ob Ihr Energiemanagement genügt.",
                "# Zeitraum: bis 12.02.2029",
                "# Person: Robert Falk",
                "Gruppe;Art;Kennzeichen;Titel;Fassung oder Nr.;entschieden von;eingetragen von;Tag;Prüfsumme;Ort",
                "Anwendungsbereich, Kontext und Energiepolitik;energiepolitik;D-0001;\"Energiepolitik; Fassung "
                        + "\"\"neu\"\"\";1;Robert Falk;Ines Kaltenbach;2027-01-15;sha256:163a;Wortlaut in VoltPilot, "
                        + "Original bei Ihnen: Ordner Geschäftsführung",
                "Berichte;berichtsstand;B-1;'=HYPERLINK(1);;;;;;in VoltPilot");
        assertThat(text).endsWith("\r\n");
    }

    private static String ohneKommentare(String code) {
        return code.replaceAll("(?s)/\\*.*?\\*/", "").replaceAll("//[^\n]*", "");
    }
}
