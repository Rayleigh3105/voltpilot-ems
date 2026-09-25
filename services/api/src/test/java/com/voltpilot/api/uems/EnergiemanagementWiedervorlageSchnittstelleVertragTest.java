package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.EnergiemanagementWiedervorlageDto;
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
 * UEMS AP-19 IP-21: die Wiedervorlage läuft nicht vom veröffentlichten Vertrag ({@code openapi.yaml},
 * {@code energiemanagement.md} §3) weg, liest nur über die Dienste und rechnet keine Frist nach (WV2), hat keine Uhr in
 * den Quellen und keinen Läufer, kein Ereignis, keine Nachricht (WV4); der Kalender-Abzug ist RFC 5545 mit Stand-Vermerk
 * (E10). Rein — liest Quelltext und Dateien, keine Datenbank.
 */
class EnergiemanagementWiedervorlageSchnittstelleVertragTest {

    private static final Path UEMS = Path.of("src/main/java/com/voltpilot/api/uems");
    private static final Path WEB = Path.of("src/main/java/com/voltpilot/api/web");
    private static final List<String> QUELLEN = List.of("WiedervorlageQuelle", "DokumentWiedervorlage",
            "AuditWiedervorlage", "FeststellungWiedervorlage", "WiedervorlageBestand");
    private static final String VERMERK = "Stand vom 12.02.2029 aus VoltPilot; maßgeblich ist die Wiedervorlage im Portal.";

    @Test
    @SuppressWarnings("unchecked")
    void openapiNenntDieRouteMitIhremRechtDemFormatUndDenDtoFeldern() throws Exception {
        Map<String, Object> api;
        try (var in = Files.newInputStream(Path.of("../../docs/contracts/openapi.yaml"))) {
            api = new Yaml().load(in);
        }
        var route = (Map<String, Object>) ((Map<String, Object>) api.get("paths"))
                .get("/api/v1/energiemanagement/wiedervorlage");
        assertThat(route).as("GET …/wiedervorlage").containsOnlyKeys("get");
        var get = (Map<String, Object>) route.get("get");
        assertThat(get.get("description").toString()).contains("energiemanagement.ansehen");
        var parameter = (List<Map<String, Object>>) get.get("parameters");
        assertThat(parameter.stream().map(p -> p.get("name")).toList()).containsExactly("format");
        assertThat((List<String>) ((Map<String, Object>) parameter.get(0).get("schema")).get("enum"))
                .containsExactly("json", "ics");

        var schemas = (Map<String, Object>) ((Map<String, Object>) api.get("components")).get("schemas");
        var mapper = new ObjectMapper();
        var dtos = Map.of(
                "EnergiemanagementWiedervorlageZeile", EnergiemanagementWiedervorlageDto.Zeile.class,
                "EnergiemanagementWiedervorlage", EnergiemanagementWiedervorlageDto.Wiedervorlage.class);
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
        var art = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) schemas
                .get("EnergiemanagementWiedervorlageZeile")).get("properties")).get("art");
        assertThat((List<String>) art.get("enum"))
                .containsExactlyElementsOf(EnergiemanagementRegeln.VOKABULARE.get("wiedervorlage_art"));
    }

    /** WV3: die Zeile trägt die Felder der Operation {@code wiedervorlage} und dazu genau den Sprung. */
    @Test
    @SuppressWarnings("unchecked")
    void dieZeileIstDieAusgabeDerVertragsOperationMitSprung() {
        Map<String, Object> aus = EnergiemanagementRegeln.wiedervorlage(new EnergiemanagementRegeln.WiedervorlageEingang(
                "2029-02-12", 30, List.of(new EnergiemanagementRegeln.WiedervorlageZeile("dokument_ueberpruefung",
                        "D-0001", "Energiepolitik — Überprüfung", "2028-12-10", null))));
        var zeile = ((List<Map<String, Object>>) aus.get("faellig")).get(0);
        var mapper = new ObjectMapper();
        var namen = mapper.getSerializationConfig()
                .introspect(mapper.constructType(EnergiemanagementWiedervorlageDto.Zeile.class)).findProperties().stream()
                .map(p -> p.getName()).toList();
        assertThat(namen).containsExactlyInAnyOrderElementsOf(
                java.util.stream.Stream.concat(zeile.keySet().stream(), java.util.stream.Stream.of("id", "kennzahl_id"))
                        .toList());
        var wv = mapper.getSerializationConfig()
                .introspect(mapper.constructType(EnergiemanagementWiedervorlageDto.Wiedervorlage.class)).findProperties()
                .stream().map(p -> p.getName()).toList();
        assertThat(wv).containsAll(aus.keySet());
    }

    /** WV1/WV2: der Leser und seine Quellen halten keine eigene Abfrage und keine Uhr — nur Dienste, Tag von außen. */
    @Test
    void gelesenUeberDieDiensteOhneEigeneAbfrageUndOhneUhr() throws Exception {
        for (String klasse : QUELLEN) {
            // Die Zeitzone des Unternehmens ist kein Nachweis — sie liest die Quelle wie jeder UEMS-Dienst.
            String text = ohneKommentare(Files.readString(UEMS.resolve(klasse + ".java")))
                    .replace("UnternehmenRepository", "");
            assertThat(text).as(klasse).doesNotContain("JdbcTemplate", "SELECT ", "INSERT ", "UPDATE ", "Repository",
                    ".now(", "Clock");
        }
        // Der Leser liest nur seine Einstellung (Vorschau-Fenster) selbst; die Fristen kommen aus den Quellen.
        String leser = ohneKommentare(Files.readString(UEMS.resolve("EnergiemanagementWiedervorlageService.java")))
                .replace("UnternehmenRepository", "").replace("EnergiemanagementEinstellungRepository", "");
        assertThat(leser).doesNotContain("JdbcTemplate", "SELECT ", "Repository", "plusMonths");
    }

    /** WV4 (E10 = A, AP-18 E5): kein Läufer, kein Ereignis, keine Nachricht — nur Abruf. */
    @Test
    void keinLaeuferKeinEreignisKeineNachricht() throws Exception {
        Pattern verboten = Pattern.compile("@Scheduled|KafkaTemplate|ApplicationEventPublisher|MailSender|"
                + "JavaMailSender|Ereignis|publish\\(|\\.send\\(");
        for (String klasse : List.of("EnergiemanagementWiedervorlageService", "DokumentWiedervorlage",
                "AuditWiedervorlage", "FeststellungWiedervorlage", "WiedervorlageBestand")) {
            String code = ohneKommentare(Files.readString(UEMS.resolve(klasse + ".java")));
            assertThat(verboten.matcher(code).results().map(m -> m.group()).toList()).as(klasse).isEmpty();
        }
        String controller = ohneKommentare(Files.readString(WEB.resolve("EnergiemanagementWiedervorlageController.java")));
        assertThat(controller).doesNotContain("@Recht(", "@PostMapping", "@PutMapping", "@DeleteMapping");
    }

    /** E10, WV4: der Kalender-Abzug — CRLF, gefaltet nach 75 Oktetten, maskiert, je Zeile ein Termin mit Vermerk. */
    @Test
    void kalenderAbzugNachRfc5545MitStandVermerk() {
        var faellig = new EnergiemanagementWiedervorlageDto.Zeile("bezugsbasis_ueberpruefung", "BB-0002",
                "Bezugsbasis BB-0002, Fassung 2 — Überprüfung (Freigabe 13.11.2026 + 12 Monate)",
                LocalDate.parse("2027-11-13"), 457, "seit 457 Tagen fällig", "Ines Kaltenbach", UUID.randomUUID(),
                UUID.randomUUID());
        var doppelt = new EnergiemanagementWiedervorlageDto.Zeile("bericht_anstoss", "BR-2028-0001", "Anstoß; zwei",
                LocalDate.parse("2028-04-03"), 315, "seit 315 Tagen fällig", null, null, null);
        var vorschau = new EnergiemanagementWiedervorlageDto.Zeile("massnahme_termin", "M-2029-0001",
                "Aufgabe „Bezugsbasen pflegen und freigeben“ festlegen und über die zweite Prüfung entscheiden",
                LocalDate.parse("2029-02-28"), -16, "fällig in 16 Tagen", "Jonas Wendlinger", UUID.randomUUID(), null);
        var w = new EnergiemanagementWiedervorlageDto.Wiedervorlage(OffsetDateTime.parse("2029-02-12T08:00:00+01:00"),
                30, List.of(faellig, doppelt, doppelt), List.of(vorschau), 3, 1, List.of(),
                EnergiemanagementRegeln.SAETZE.get("verantwortung"));
        String text = new String(EnergiemanagementWiedervorlageService.ics(w), StandardCharsets.UTF_8);

        assertThat(EnergiemanagementWiedervorlageService.vermerk(LocalDate.parse("2029-02-12"))).isEqualTo(VERMERK);
        assertThat(text).startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n").endsWith("END:VCALENDAR\r\n");
        assertThat(text.replace("\r\n", "")).doesNotContain("\n", "\r");
        for (String zeile : text.split("\r\n")) {
            assertThat(zeile.getBytes(StandardCharsets.UTF_8).length).as(zeile).isLessThanOrEqualTo(75);
        }
        String entfaltet = text.replace("\r\n ", "");
        assertThat(entfaltet.split("BEGIN:VEVENT", -1)).hasSize(5);
        assertThat(entfaltet).contains(
                "X-WR-CALDESC:Stand vom 12.02.2029 aus VoltPilot\\; maßgeblich ist die Wiedervorlage im Portal.\r\n",
                "DTSTAMP:20290212T070000Z\r\n",
                "DTSTART;VALUE=DATE:20271113\r\nDTEND;VALUE=DATE:20271114\r\n",
                "SUMMARY:BB-0002: Bezugsbasis BB-0002\\, Fassung 2 — Überprüfung (Freigabe 13.11.2026 + 12 Monate)\r\n",
                "SUMMARY:BR-2028-0001: Anstoß\\; zwei\r\n",
                "DTSTART;VALUE=DATE:20290228\r\n",
                "UID:bericht_anstoss-BR-2028-0001-20280403@wiedervorlage.voltpilot\r\n",
                "UID:bericht_anstoss-BR-2028-0001-20280403-2@wiedervorlage.voltpilot\r\n");
        assertThat(entfaltet.split("DESCRIPTION:Stand vom 12.02.2029 aus VoltPilot\\\\; maßgeblich", -1)).hasSize(5);
        // Ein gefaltetes UTF-8-Zeichen bleibt ganz: jede Zeile ist für sich gültiges UTF-8.
        for (String zeile : text.split("\r\n")) {
            assertThat(new String(zeile.getBytes(StandardCharsets.UTF_8), StandardCharsets.UTF_8)).doesNotContain("�");
        }
    }

    private static String ohneKommentare(String code) {
        return code.replaceAll("(?s)/\\*.*?\\*/", "").replaceAll("//[^\n]*", "");
    }
}
