package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Konzept Nachweisen n1, Runde 2, Entscheid 7 (PR 6): „Unterlagen zusammenstellen“ über die echte HTTP-, Rechte- und
 * RLS-Kette mit der App-Rolle, in einer kleinen Welt des Kunststoffwerks Ahrenberg am 30.04.2029: Energiepolitik in zwei
 * Fassungen, Leitung und Energiemanagement als Aufgaben, „Risiken und Chancen“ trifft nicht zu. Ines Kaltenbach stellt
 * die Mappe für ein Audit von außen seit dem 01.05.2028 zusammen; „Was am 30.04.2029 gilt“ trägt die geltende Fassung,
 * die Aufgaben und den Vermerk, der Zeitraum nur, was darin entschieden wurde. Robert Falk („Einsicht“) liest und ruft
 * ab, legt aber keine an; jeder Abruf steht im Protokoll; nach 30 Tagen ist die Mappe abgelaufen (410). Wer nur
 * Standorte liest oder zu einem anderen Kundenbereich gehört, sieht nichts.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class EnergiemanagementMappeApiTest {
    private static final String BASIS = "/api/v1/energiemanagement";
    private static final String MAPPEN = BASIS + "/mappen";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Map<String, String> NAMEN = Map.of("IK", "Ines Kaltenbach", "JW", "Jonas Wendlinger",
            "PH", "Peter Hollerbach", "CB", "Claudia Berger", "MD", "Murat Demirci", "RF", "Robert Falk",
            "FR", "Frieda Fremd");
    private static final String SATZ_RC = "Risiken und Chancen bewerten wir im Jahresgespräch der Geschäftsführung.";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "n3b_mappe_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "n3b_mappe_pw");
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> "http://127.0.0.1:9/realms/voltpilot");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri", () -> "http://127.0.0.1:9/certs");
        r.add("voltpilot.uems.kennzahlen.enabled", () -> "false");
    }

    @Autowired MockMvc mvc;
    @Autowired EnergiemanagementDokumentService dokumente;
    @Autowired EnergiemanagementPersonenService personen;
    @Autowired EnergiemanagementTeilVermerkService vermerke;
    @Autowired EnergiemanagementVerzeichnisService verzeichnis;
    static JdbcTemplate root;
    UUID tenant, fremd, unternehmen, s1, s2;
    String rf, ik;

    @BeforeAll
    static void start() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void welt() throws Exception {
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Ahrenberg n3b') RETURNING id", UUID.class);
        unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name,zeitzone) VALUES (?,"
                + "'Kunststoffwerk Ahrenberg GmbH','Europe/Berlin') RETURNING id", UUID.class, tenant);
        s1 = standort("ST-1", "Werk Ahrenberg");
        s2 = standort("ST-2", "Werk Lindach");
        benutzer(tenant, "IK", "energiemanager", null);
        benutzer(tenant, "JW", "kundenadministrator", null);
        benutzer(tenant, "PH", "bearbeiter", s2);
        benutzer(tenant, "MD", "bedienberechtigt", s1);
        benutzer(tenant, "CB", "leser", s1);
        benutzer(tenant, "RF", "einsicht", null);
        fremd = root.queryForObject("INSERT INTO tenant(name) VALUES ('Fremd n3b') RETURNING id", UUID.class);
        root.update("INSERT INTO unternehmen(tenant_id,name,zeitzone) VALUES (?,'Fremd GmbH','Europe/Berlin')", fremd);
        benutzer(fremd, "FR", "energiemanager", null);

        heute("2026-10-01T08:00:00Z");
        rf = person("Robert Falk", "Geschäftsführer", "RF", null);
        ik = person("Ines Kaltenbach", "Energiemanagement", "IK", "IK");
        ruf("POST", BASIS + "/aufgaben", "IK", Map.of("aufgabe", "unternehmensleitung", "person_id", rf,
                "gilt_ab", "2026-10-01", "begruendung", "Geschäftsführer laut Handelsregister"), 201);
        ruf("POST", BASIS + "/aufgaben", "IK", Map.of("aufgabe", "energiemanagement_leiten", "person_id", ik,
                "gilt_ab", "2026-10-01", "entschieden_von", rf, "begruendung", "Bestellung vom 28.09.2026"), 201);
        heute("2026-12-15T09:00:00Z");
        String politik = ruf("POST", BASIS + "/dokumente", "IK", Map.of("art", "energiepolitik", "titel", "Energiepolitik",
                "bezug", Map.of("art", "unternehmen")), 201).path("id").asText();
        fassung(politik, 1, "Wir senken den Energieeinsatz je Kilogramm Kunststoff in jedem Jahr.");
        heute("2029-03-20T09:00:00Z");
        fassung(politik, 2, "Wir senken den Energieeinsatz je Kilogramm Kunststoff in jedem Jahr; beim Kauf von "
                + "Maschinen zählt der Energieeinsatz über die Nutzungsdauer.");
        heute("2029-04-30T08:00:00Z");
        ruf("POST", BASIS + "/teil-vermerke", "IK", Map.of("teil", "risiken_chancen", "satz", SATZ_RC,
                "entschieden_von", rf), 201);
        verzeichnis.uhrStellen(Clock.fixed(Instant.parse("2029-04-30T08:20:00Z"), ZoneOffset.UTC));
    }

    @AfterEach
    void uhrZurueck() {
        heute(null);
        verzeichnis.uhrStellen(Clock.systemUTC());
    }

    // ------------------------------------------------------------------ zusammenstellen, lesen, abrufen

    @Test
    void zusammenstellenLesenUndAbrufenJederAbrufImProtokoll() throws Exception {
        JsonNode m = ruf("POST", MAPPEN, "IK", Map.of("anlass", "audit_von_aussen", "von", "2028-05-01",
                "gruppen", List.of("risiken_chancen", "grundlagen", "verantwortung", "grundlagen"),
                "offen", List.of("kontext", "beschaffung")), 201);
        assertThat(felder(m)).containsExactly("id", "titel", "anlass", "anlass_wort", "von", "bis", "stichtag", "gruppen",
                "gruppen_woerter", "offen", "offen_woerter", "eintraege", "gilt", "datei_titel", "datei_name",
                "pdf_pruefsumme", "csv_pruefsumme", "abrufbar", "abrufbar_tage", "aufbewahrung_tage", "abrufe", "erstellt");
        assertThat(m.path("titel").asText()).isEqualTo("Unterlagen für das Audit");
        assertThat(m.path("anlass_wort").asText()).isEqualTo("Audit von außen");
        assertThat(m.path("von").asText()).isEqualTo("2028-05-01");
        assertThat(m.path("bis").asText()).as("der Stichtag des Verzeichnisses").isEqualTo("2029-04-30");
        assertThat(texte(m.path("gruppen"))).as("eindeutig, in der Folge des Vokabulars")
                .containsExactly("grundlagen", "verantwortung", "risiken_chancen");
        assertThat(texte(m.path("offen_woerter"))).containsExactly("Kontext und interessierte Parteien", "Beschaffung");
        // Gilt: Fassung 2 der Energiepolitik, zwei Aufgaben, der Vermerk. Im Zeitraum: Fassung 2 und der Vermerk.
        assertThat(m.path("gilt").asInt()).isEqualTo(4);
        assertThat(m.path("eintraege").asInt()).isEqualTo(2);
        assertThat(m.path("datei_titel").asText()).isEqualTo("Nachweise Kunststoffwerk Ahrenberg GmbH, 30.04.2029");
        assertThat(m.path("datei_name").asText()).isEqualTo("nachweise-2029-04-30");
        assertThat(m.path("abrufbar").asBoolean()).isTrue();
        assertThat(m.path("abrufbar_tage").asInt()).isEqualTo(30);
        assertThat(m.path("aufbewahrung_tage").asInt()).isEqualTo(30);
        assertThat(m.path("abrufe").asInt()).isZero();
        assertThat(m.at("/erstellt/name").asText()).isEqualTo("Ines Kaltenbach");
        String id = m.path("id").asText();

        // „Einsicht“ liest die Liste und ruft das PDF ab; IK die CSV.
        assertThat(texte(ruf("GET", MAPPEN, "RF", null, 200).path("mappen"), "id")).containsExactly(id);
        MockHttpServletResponse pdf = roh("GET", MAPPEN + "/" + id + "/pdf", "RF", null);
        assertThat(pdf.getStatus()).isEqualTo(200);
        assertThat(pdf.getContentType()).isEqualTo("application/pdf");
        assertThat(pdf.getHeader("Content-Disposition")).isEqualTo("attachment; filename=nachweise-2029-04-30.pdf");
        assertThat(pdf.getHeader("Cache-Control")).contains("no-store");
        assertThat(EnergiemanagementMappeService.sha256(pdf.getContentAsByteArray())).isEqualTo(m.path("pdf_pruefsumme").asText());
        String text = text(pdf.getContentAsByteArray());
        assertThat(text).contains("Nachweise Kunststoffwerk Ahrenberg GmbH, 30.04.2029", "Unterlagen für das Audit",
                "Inhalt", "Was am 30.04.2029 gilt", "Was vom 01.05.2028 bis 30.04.2029 festgehalten wurde",
                "Was beim Zusammenstellen offen war", "Kontext und interessierte Parteien", "Beschaffung",
                "Verantwortung und Grenze", "Konformität mit einer Norm",
                "Robert Falk", "Seite 1 von");
        assertThat(text).as("das Inhaltsverzeichnis trägt echte Seitenzahlen").doesNotContain("Seite 99")
                .contains("4  Verantwortung und Grenze Seite 2");
        MockHttpServletResponse csv = roh("GET", MAPPEN + "/" + id + "/csv", "IK", null);
        assertThat(csv.getStatus()).isEqualTo(200);
        assertThat(csv.getContentType()).isEqualTo("text/csv;charset=UTF-8");
        assertThat(EnergiemanagementMappeService.sha256(csv.getContentAsByteArray())).isEqualTo(m.path("csv_pruefsumme").asText());
        String csvText = csv.getContentAsString(StandardCharsets.UTF_8);
        assertThat(csvText).startsWith("﻿# Unterlagen für das Audit (Audit von außen), zusammengestellt von Ines Kaltenbach\r\n");
        assertThat(csvText).contains("# Zeitraum: ab 01.05.2028 bis 30.04.2029", "Energiepolitik;2;")
                .as("Fassung 1 liegt vor dem Zeitraum").doesNotContain("Energiepolitik;1;");
        assertThat(ruf("GET", MAPPEN + "/" + id, "IK", null, 200).path("abrufe").asInt()).isEqualTo(2);
        assertThat(root.queryForList("SELECT format || ':' || actor_name FROM energiemanagement_mappe_abruf "
                + "WHERE mappe_id = ? ORDER BY created_at", String.class, UUID.fromString(id)))
                .containsExactly("pdf:Robert Falk", "csv:Ines Kaltenbach");
    }

    @Test
    void ohneVonAllesBisZumStichtag() throws Exception {
        JsonNode m = ruf("POST", MAPPEN, "JW", Map.of("anlass", "eigene_ablage", "gruppen", List.of("grundlagen")), 201);
        assertThat(m.path("von").isNull()).isTrue();
        assertThat(m.path("eintraege").asInt()).as("beide Fassungen").isEqualTo(2);
        assertThat(m.path("gilt").asInt()).as("nur die geltende").isOne();
        assertThat(texte(m.path("offen"))).isEmpty();
        assertThat(text(roh("GET", MAPPEN + "/" + m.path("id").asText() + "/pdf", "JW", null).getContentAsByteArray()))
                .contains("Was bis 30.04.2029 festgehalten wurde", "Kein Teil war offen.");
    }

    // ------------------------------------------------------------------ Rechte und Zaun

    @Test
    void anlegenNurMitVerwaltenLesenNurUnternehmensweitUndNieFremd() throws Exception {
        Map<String, Object> body = Map.of("anlass", "anfrage_behoerde", "gruppen", List.of("berichte"));
        for (String wer : List.of("RF", "PH", "MD", "CB")) {
            assertThat(roh("POST", MAPPEN, wer, body).getStatus()).as(wer).isEqualTo(403);
        }
        String id = ruf("POST", MAPPEN, "IK", body, 201).path("id").asText();
        for (String wer : List.of("PH", "MD", "CB", "FR")) {
            assertThat(texte(ruf("GET", MAPPEN, wer, null, 200).path("mappen"))).as(wer + " sieht keine").isEmpty();
            ruf("GET", MAPPEN + "/" + id, wer, null, 404);
            ruf("GET", MAPPEN + "/" + id + "/pdf", wer, null, 404);
            ruf("GET", MAPPEN + "/" + id + "/csv", wer, null, 404);
        }
        assertThat(root.queryForObject("SELECT count(*) FROM energiemanagement_mappe_abruf WHERE tenant_id = ?",
                Integer.class, tenant)).as("ein verwehrter Abruf steht nicht im Protokoll").isZero();
        ruf("GET", MAPPEN + "/kein-uuid", "IK", null, 404);
        ruf("GET", MAPPEN + "/" + UUID.randomUUID(), "IK", null, 404);
    }

    @Test
    void ablehnungenNennenIhrFeld() throws Exception {
        assertThat(ruf("POST", MAPPEN, "IK", Map.of("anlass", "zertifizierung", "gruppen", List.of("berichte")), 400)
                .path("feld").asText()).isEqualTo("anlass");
        assertThat(ruf("POST", MAPPEN, "IK", Map.of("anlass", "eigene_ablage", "gruppen", List.of()), 400)
                .path("feld").asText()).isEqualTo("gruppen");
        assertThat(ruf("POST", MAPPEN, "IK", Map.of("anlass", "eigene_ablage", "gruppen", List.of("sonstiges")), 400)
                .path("feld").asText()).isEqualTo("gruppen");
        assertThat(ruf("POST", MAPPEN, "IK", Map.of("anlass", "eigene_ablage", "gruppen", List.of("berichte"),
                "offen", List.of("Kontext")), 400).path("feld").asText()).isEqualTo("offen");
        assertThat(ruf("POST", MAPPEN, "IK", Map.of("anlass", "eigene_ablage", "gruppen", List.of("berichte"),
                "von", "2029-05-01"), 400).path("feld").asText()).isEqualTo("von");
        assertThat(ruf("POST", MAPPEN, "IK", Map.of("anlass", "eigene_ablage", "gruppen", List.of("berichte"),
                "von", "gestern"), 400).path("feld").asText()).isEqualTo("von");
        assertThat(ruf("POST", MAPPEN, "IK", Map.of("anlass", "eigene_ablage", "gruppen", List.of("berichte"),
                "tenant_id", fremd.toString()), 400).path("feld").asText()).as("der Mandant kommt nie aus dem Körper")
                .isEqualTo("tenant_id");
        assertThat(root.queryForObject("SELECT count(*) FROM energiemanagement_mappe WHERE tenant_id = ?", Integer.class,
                tenant)).isZero();
    }

    // ------------------------------------------------------------------ Aufbewahrung 30 Tage

    @Test
    void nachDreissigTagenAbgelaufenDieDateienGehenDieAngabenBleiben() throws Exception {
        String id = ruf("POST", MAPPEN, "IK", Map.of("anlass", "audit_von_aussen", "gruppen", List.of("grundlagen")), 201)
                .path("id").asText();
        root.execute("BEGIN; SET LOCAL session_replication_role = replica; UPDATE energiemanagement_mappe SET "
                + "abrufbar_bis = now() - interval '1 minute' WHERE id = '" + id + "'; COMMIT;");
        JsonNode m = ruf("GET", MAPPEN + "/" + id, "RF", null, 200);
        assertThat(m.path("abrufbar").asBoolean()).isFalse();
        assertThat(m.path("abrufbar_tage").asInt()).isZero();
        JsonNode weg = ruf("GET", MAPPEN + "/" + id + "/pdf", "RF", null, 410);
        assertThat(weg.path("code").asText()).isEqualTo("mappe_abgelaufen");
        assertThat(weg.path("message").asText()).contains("30 Tage");
        ruf("GET", MAPPEN + "/" + id + "/csv", "IK", null, 410);
        assertThat(root.queryForObject("SELECT count(*) FROM energiemanagement_mappe_abruf WHERE tenant_id = ?",
                Integer.class, tenant)).isZero();
        // Die Liste leert die Dateien abgelaufener Mappen; die Angaben bleiben.
        assertThat(texte(ruf("GET", MAPPEN, "IK", null, 200).path("mappen"), "id")).containsExactly(id);
        assertThat(root.queryForObject("SELECT pdf IS NULL AND csv IS NULL AND pdf_sha256 IS NOT NULL "
                + "FROM energiemanagement_mappe WHERE id = ?", Boolean.class, UUID.fromString(id))).isTrue();
    }

    // ------------------------------------------------------------------ Gerüst

    private void heute(String jetzt) {
        Clock uhr = jetzt == null ? Clock.systemUTC() : Clock.fixed(Instant.parse(jetzt), ZoneOffset.UTC);
        dokumente.uhrStellen(uhr);
        personen.uhrStellen(uhr);
        vermerke.uhrStellen(uhr);
    }

    private String person(String name, String funktion, String kuerzel, String konto) throws Exception {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("name", name);
        b.put("funktion", funktion);
        b.put("kuerzel", kuerzel);
        if (konto != null) b.put("konto_sub", konto);
        b.put("seit", "2026-10-01");
        JsonNode n = ruf("POST", BASIS + "/personen", "IK", b, 201);
        // Die Personen-Route antwortet mit der Person und ihrem Verlauf.
        return n.has("verlauf") ? n.at("/person/id").asText() : n.path("id").asText();
    }

    private void fassung(String dokument, int nr, String wortlaut) throws Exception {
        Map<String, Object> f = new LinkedHashMap<>(Map.of("form", "wortlaut", "wortlaut", wortlaut));
        if (nr > 1) f.put("begruendung", "Ergänzt um Einkauf und Planung, Beschluss der Managementbewertung.");
        ruf("POST", BASIS + "/dokumente/" + dokument + "/fassungen", "IK", f, 201);
        ruf("POST", BASIS + "/dokumente/" + dokument + "/fassungen/" + nr + "/freigeben", "IK", Map.of("entschieden_von", rf,
                "begruendung", "In der Besprechung am selben Tag entschieden."), 200);
    }

    private static String text(byte[] pdf) throws Exception {
        try (PDDocument d = Loader.loadPDF(pdf)) {
            return new PDFTextStripper().getText(d).replace(' ', ' ');
        }
    }

    private static List<String> felder(JsonNode n) {
        List<String> f = new ArrayList<>();
        n.fieldNames().forEachRemaining(f::add);
        return f;
    }

    private static List<String> texte(JsonNode liste) {
        List<String> t = new ArrayList<>();
        liste.forEach(x -> t.add(x.asText()));
        return t;
    }

    private static List<String> texte(JsonNode liste, String feld) {
        List<String> t = new ArrayList<>();
        liste.forEach(x -> t.add(x.path(feld).asText()));
        return t;
    }

    private Authentication token(String sub) {
        Jwt jwt = Jwt.withTokenValue("test").header("alg", "none").subject(sub).issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600)).claim("tenant_id", ("FR".equals(sub) ? fremd : tenant)
                        .toString())
                .claim("realm_access", Map.of("roles", List.of())).claim("name", NAMEN.get(sub))
                .claim("preferred_username", NAMEN.get(sub)).build();
        return new KeycloakRealmRoleConverter().convert(jwt);
    }

    private MockHttpServletResponse roh(String method, String path, String sub, Object body) throws Exception {
        var b = request(HttpMethod.valueOf(method), path).with(authentication(token(sub)));
        if (body != null) b.contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(body));
        return mvc.perform(b).andReturn().getResponse();
    }

    private JsonNode ruf(String method, String path, String sub, Object body, int status) throws Exception {
        var r = roh(method, path, sub, body);
        assertThat(r.getStatus()).as(method + " " + path + " " + r.getContentAsString(StandardCharsets.UTF_8))
                .isEqualTo(status);
        String inhalt = r.getContentAsString(StandardCharsets.UTF_8);
        return inhalt.isEmpty() ? JSON.createObjectNode() : JSON.readTree(inhalt);
    }

    private UUID standort(String k, String name) {
        return root.queryForObject("INSERT INTO standort(tenant_id,unternehmen_id,name,kurzzeichen,zeitzone,zustand) "
                + "VALUES (?,?,?,?,'Europe/Berlin','aktiv') RETURNING id", UUID.class, tenant, unternehmen, name, k);
    }

    private void benutzer(UUID mandant, String sub, String rolle, UUID standort) {
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,?,'benutzer',?,'aktiv')",
                mandant, sub, NAMEN.get(sub));
        root.update("INSERT INTO zugriff(tenant_id,benutzer_sub,rolle,standort_id,gueltig_ab,zeitzone) "
                + "VALUES (?,?,?,?,'2024-01-01','Europe/Berlin')", mandant, sub, rolle, standort);
    }
}
