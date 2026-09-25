package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Date;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
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
 * UEMS AP-19 IP-8 (NW-2): das Verzeichnis {@code GET /api/v1/energiemanagement/verzeichnis} über die echte HTTP-,
 * Rechte- und RLS-Kette mit der App-Rolle — R3 des Konzepts für die Quellen bis hier: Dokument-Fassungen und
 * Bekanntmachungen (IP-7), laufende Aufgaben (IP-10) und der Bestand (Betrachtungsumfang, Kennzahl- und
 * Bezugsbasis-Fassungen). Am 12.02.2029, 08:00: elf Gruppen, jede Zeile mit Person, Tag und Ort; leere Gruppen sagen
 * „Hier ist noch nichts festgehalten.“; keine Zahl über das Ganze; „in meinem Namen festgehalten“ zeigt Robert Falk
 * (Einsicht) seine 11 Zeilen, auch als CSV mit Stichtag und Verantwortungs-Satz; der Zaun ist der jeder Quelle.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class EnergiemanagementVerzeichnisApiTest {
    private static final String BASIS = "/api/v1/energiemanagement";
    private static final String VERZEICHNIS = BASIS + "/verzeichnis";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Map<String, String> NAMEN = Map.of("IK", "Ines Kaltenbach", "JW", "Jonas Wendlinger",
            "PH", "Peter Hollerbach", "CB", "Claudia Berger", "MD", "Murat Demirci", "RF", "Robert Falk");
    private static final Map<String, Object> BESTELLUNG = Map.of(
            "bezeichnung", "Bestellung Energiemanagement vom 28.09.2026, unterschrieben",
            "ablage", "Personalakte (Personalabteilung)");
    private static final Map<String, Object> ORIGINAL = Map.of(
            "bezeichnung", "Energiepolitik Fassung 1, unterschrieben",
            "ablage", "QM-Laufwerk, Ordner Energiemanagement/Politik", "kennung", "EP-2026",
            "sha256", "3f1f253d0c40224028a65d3cd9409b689463ff4feab3282db32f83252bf73b9b");
    private static final String SHA_GR2 = "3b1f4d86f164c8e54eaa3a9c335975dd54dcbd68b42bbb9c7b24d2195e2a9a2e";
    private static final String SHA_Z5B = "c07dd7a33d2b17df6fece484ec4e08bb50c93326653576cfb1b8dd8dcf8a41f0";
    private static final String SHA_GR9 = "9d4e1c2b7a5f3e8d6c0b4a2f1e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d";
    private static final String SHA_FREMD = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";
    private static final String LEER = "Hier ist noch nichts festgehalten.";
    private static final String VERANTWORTUNG = "Inhalte und Entscheidungen Ihres Energiemanagements verantwortet Ihr "
            + "Unternehmen. VoltPilot hält fest, wer was wann entschieden hat, und beurteilt nicht, ob Ihr "
            + "Energiemanagement genügt.";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "ip8_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "ip8_test_pw");
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> "http://127.0.0.1:9/realms/voltpilot");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri", () -> "http://127.0.0.1:9/certs");
        r.add("voltpilot.uems.kennzahlen.enabled", () -> "false");
    }

    @Autowired MockMvc mvc;
    @Autowired EnergiemanagementDokumentService dokumente;
    @Autowired EnergiemanagementVerzeichnisService verzeichnis;
    static JdbcTemplate root;
    static Map<String, JsonNode> kopien;
    UUID tenant, unternehmen, s1, s2, g2, bz1;

    @BeforeAll
    static void start() throws Exception {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        kopien = new HashMap<>();
        for (JsonNode c : JSON.readTree(Path.of("../../docs/contracts/v2/energiemanagement-vectors.json").toFile())
                .path("cases")) {
            if (c.path("operation").asText().equals("pruefsumme") && c.path("name").asText().contains("Fassung 1")) {
                kopien.put(c.path("name").asText().substring(3, 9), c);
            }
        }
    }

    @BeforeEach
    void welt() {
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Ahrenberg IP-8') RETURNING id", UUID.class);
        unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name,zeitzone) VALUES (?,"
                + "'Kunststoffwerk Ahrenberg GmbH','Europe/Berlin') RETURNING id", UUID.class, tenant);
        s1 = standort("ST-1", "Werk Ahrenberg");
        s2 = standort("ST-2", "Werk Lindach");
        benutzer("IK", "energiemanager", null);
        benutzer("JW", "kundenadministrator", null);
        benutzer("PH", "bearbeiter", s2);
        benutzer("MD", "bedienberechtigt", s1);
        benutzer("CB", "leser", s1);
        benutzer("RF", "einsicht", null);
        g2 = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, 'gebaeude', "
                + "'Halle 2', 'G-2', 'aktiv') RETURNING id", UUID.class, tenant);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2020-01-01')", tenant, g2, s1);
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-20', 'Spritzguss', 'gemessen', 'Strom', 'Wirkenergie', "
                + "'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, tenant);
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, ort_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, NULL, '2020-01-01')", tenant, ms, g2);
        bz1 = root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, "
                + "periode_art, geltung_art, ort_id) VALUES (?, 'BZ-1', 'Produktionsmenge', 'periodenwert', 'kg', "
                + "'monat', 'gebaeude', ?) RETURNING id", UUID.class, tenant, g2);
    }

    @AfterEach
    void uhrZurueck() {
        dokumente.uhrStellen(Clock.systemUTC());
        verzeichnis.uhrStellen(Clock.systemUTC());
    }

    // ------------------------------------------------------------------ R3

    @Test
    void r3ElfGruppenJedeZeileMitPersonTagUndOrtKeineZahlUeberDasGanzeUndRobertFalksElfZeilen() throws Exception {
        r3Welt();
        abruf("2029-02-12T07:00:00Z");
        JsonNode v = ruf(VERZEICHNIS, "IK", 200);

        // Kopf: Stichtag in der Zeitzone des Unternehmens, Verantwortungs-Satz — und keine Zahl über das Ganze.
        assertThat(v.path("stichtag").asText()).startsWith("2029-02-12T08:00");
        assertThat(v.path("verantwortung").asText()).isEqualTo(VERANTWORTUNG);
        assertThat(felder(v)).containsExactly("stichtag", "verantwortung", "filter", "gruppen");
        assertThat(texte(v.path("gruppen"), "gruppe")).containsExactly("grundlagen", "verantwortung", "risiken_chancen",
                "kompetenz_kommunikation", "betrieb_auslegung_beschaffung", "bewertung_messplanung",
                "kennzahlen_bezugsbasen", "ziele_massnahmen_abweichungen", "audits_feststellungen", "managementbewertung",
                "berichte");
        v.path("gruppen").forEach(g -> assertThat(felder(g)).containsExactly("gruppe", "gruppe_wort", "zuschnitt", "satz",
                "zeilen"));

        Map<String, Integer> je = new LinkedHashMap<>();
        v.path("gruppen").forEach(g -> je.put(g.path("gruppe").asText(), g.path("zeilen").size()));
        assertThat(je).containsExactly(Map.entry("grundlagen", 4), Map.entry("verantwortung", 10),
                // Aushang und Intranet am 18.12.2026 sind EINE Bekanntmachung (IP-14, Katalog R3).
                Map.entry("risiken_chancen", 0), Map.entry("kompetenz_kommunikation", 1),
                Map.entry("betrieb_auslegung_beschaffung", 1), Map.entry("bewertung_messplanung", 0),
                Map.entry("kennzahlen_bezugsbasen", 13), Map.entry("ziele_massnahmen_abweichungen", 0),
                Map.entry("audits_feststellungen", 0), Map.entry("managementbewertung", 0), Map.entry("berichte", 0));

        // Eine Gruppe ohne Zeile: der Satz und ihre Zeile des Zuschnitts — nie „fehlt“.
        JsonNode rc = gruppe(v, "risiken_chancen");
        assertThat(rc.path("satz").asText()).isEqualTo(LEER);
        assertThat(rc.path("gruppe_wort").asText()).isEqualTo("Risiken und Chancen");
        assertThat(rc.at("/zuschnitt/0/teil").asText()).isEqualTo("Risiken und Chancen");
        assertThat(rc.at("/zuschnitt/0/stufe").asText()).isEqualTo("Verweis auf Ihr System");
        assertThat(gruppe(v, "managementbewertung").path("satz").asText()).isEqualTo(LEER);
        assertThat(gruppe(v, "grundlagen").path("satz").isNull()).isTrue();

        // Jede Zeile mit Person, Tag und Ort (VZ2, G1, G2).
        List<JsonNode> zeilen = alle(v);
        assertThat(zeilen).hasSize(29).allSatisfy(z -> {
            assertThat(z.path("eingetragen_von").isNull() && z.path("entschieden_von").isNull()).as(z.toString())
                    .isFalse();
            assertThat(z.path("tag").isNull()).as(z.toString()).isFalse();
            assertThat(z.path("ort_satz").asText()).as(z.toString()).isNotBlank();
        });
        {
            JsonNode z = zeile(v, "energiepolitik", "D-0001");
            assertThat(z.path("nr").asInt()).isEqualTo(1);
            assertThat(z.path("entschieden_von").asText()).isEqualTo("Robert Falk");
            assertThat(z.path("eingetragen_von").asText()).isEqualTo("Ines Kaltenbach");
            assertThat(z.path("tag").asText()).isEqualTo("2026-12-15");
            assertThat(z.path("pruefsumme").asText())
                    .isEqualTo("sha256:163ae8360abb4f614f4fb4b37a7e983dff1f42e548b7f10c64890fdde68b09bb");
            assertThat(z.path("ort_satz").asText()).isEqualTo("Wortlaut in VoltPilot, Original bei Ihnen: QM-Laufwerk, "
                    + "Ordner Energiemanagement/Politik");
        }
        assertThat(zeile(v, "rechtliche_anforderungen", "D-0003").path("ort_satz").asText())
                .isEqualTo("Geführt in Ihrem System: Rechtskataster-Dienst");
        {
            JsonNode z = zeile(v, "betrachtungsumfang", "Betrachtungsumfang");
            assertThat(z.path("gruppe").asText()).isEqualTo("grundlagen");
            assertThat(z.path("eingetragen_von").asText()).isEqualTo("Ines Kaltenbach");
            assertThat(z.path("tag").asText()).isEqualTo("2026-11-04");
            assertThat(z.path("ort_satz").asText()).isEqualTo("in VoltPilot");
        }
        {
            JsonNode z = zeile(v, "bezugsbasis_fassung", "BB-0001");
            assertThat(z.path("titel").asText()).isEqualTo("Bezugsbasis BB-0001 (KZ-0004)");
            assertThat(z.path("nr").asInt()).isEqualTo(1);
            assertThat(z.path("eingetragen_von").asText()).isEqualTo("Ines Kaltenbach");
            assertThat(z.path("entschieden_von").isNull()).as("ohne Vier-Augen steht einer da (G2)").isTrue();
        }
        assertThat(zeilen.stream().filter(z -> z.path("art").asText().equals("kennzahl_fassung"))).hasSize(5)
                .allSatisfy(z -> assertThat(z.path("eingetragen_von").asText()).isEqualTo("Ines Kaltenbach"));
        assertThat(zeilen.stream().filter(z -> z.path("art").asText().equals("bezugsbasis_fassung"))).hasSize(8);

        // „in meinem Namen festgehalten“: Robert Falk (Einsicht) sieht seine 11 Zeilen — D-0001, D-0002, 9 Aufgaben.
        String rf = personId("RF");
        JsonNode meine = ruf(VERZEICHNIS + "?person=" + rf, "RF", 200);
        assertThat(meine.at("/filter/person_name").asText()).isEqualTo("Robert Falk");
        List<JsonNode> rfZeilen = alle(meine);
        assertThat(rfZeilen).hasSize(11).allSatisfy(z -> assertThat(z.path("entschieden_von").asText())
                .isEqualTo("Robert Falk"));
        assertThat(texte(rfZeilen, "kennzeichen")).contains("D-0001", "D-0002");
        assertThat(meine.path("gruppen")).hasSize(11);
        assertThat(gruppe(meine, "kennzahlen_bezugsbasen").path("satz").asText()).isEqualTo(LEER);

        // Die CSV für das System des Kunden (VZ4, KS2): dieselben 11 Zeilen, Kopf mit Stichtag und Verantwortungs-Satz.
        MockHttpServletResponse csv = roh(VERZEICHNIS + "?person=" + rf + "&format=csv", "RF");
        assertThat(csv.getStatus()).isEqualTo(200);
        assertThat(csv.getContentType()).startsWith("text/csv");
        assertThat(csv.getHeader("Content-Disposition")).isEqualTo("attachment; filename=verzeichnis-2029-02-12.csv");
        String text = csv.getContentAsString(StandardCharsets.UTF_8);
        assertThat(text).startsWith(BerichtCsv.BOM);
        List<String> csvZeilen = List.of(text.substring(1).split("\r\n"));
        assertThat(csvZeilen.subList(0, 4)).containsExactly("# Stichtag 12.02.2029 08:00", "# " + VERANTWORTUNG,
                "# Person: Robert Falk",
                "Gruppe;Art;Kennzeichen;Titel;Fassung oder Nr.;entschieden von;eingetragen von;Tag;Prüfsumme;Ort");
        assertThat(csvZeilen).hasSize(4 + 11);
        assertThat(csvZeilen.get(4)).startsWith("Anwendungsbereich, Kontext und Energiepolitik;energiepolitik;D-0001;"
                + "Energiepolitik;1;Robert Falk;Ines Kaltenbach;2026-12-15;sha256:163ae836");

        // Filter Gruppe und Zeitraum (beide Tage eingeschlossen).
        JsonNode nurRc = ruf(VERZEICHNIS + "?gruppe=risiken_chancen", "IK", 200);
        assertThat(texte(nurRc.path("gruppen"), "gruppe")).containsExactly("risiken_chancen");
        JsonNode dezember = ruf(VERZEICHNIS + "?von=2026-12-15&bis=2026-12-18", "IK", 200);
        assertThat(texte(alle(dezember), "art")).containsExactlyInAnyOrder("energiepolitik", "anwendungsbereich",
                "rechtliche_anforderungen", "bekanntmachung");

        // Stichtag: am 14.12.2026 ist noch keine Dokument-Fassung festgehalten.
        abruf("2026-12-14T09:00:00Z");
        assertThat(texte(alle(ruf(VERZEICHNIS, "IK", 200)), "art")).doesNotContain("energiepolitik", "bekanntmachung");
    }

    // ------------------------------------------------------------------ Zaun je Quelle, Ablehnungen

    @Test
    void zaunJeQuelleUndAblehnungen() throws Exception {
        r3Welt();
        abruf("2029-02-12T07:00:00Z");
        // Ein Standort-Konto (Werk Lindach): keine Aufgabe, kein Dokument am Unternehmen, keine Kennzahl in Halle 2 —
        // aber den Betrachtungsumfang, den AP-16 ihm an seinem Standort zeigt. Ohne Hinweis auf den Rest.
        JsonNode ph = ruf(VERZEICHNIS, "PH", 200);
        assertThat(texte(alle(ph), "art")).containsExactly("betrachtungsumfang");
        assertThat(gruppe(ph, "verantwortung").path("satz").asText()).isEqualTo(LEER);
        // Einsicht liest unternehmensweit, wie die Leitung am Morgen der Sitzung.
        assertThat(alle(ruf(VERZEICHNIS, "RF", 200))).hasSize(29);

        assertThat(ruf(VERZEICHNIS + "?gruppe=alles", "IK", 400).path("feld").asText()).isEqualTo("gruppe");
        assertThat(ruf(VERZEICHNIS + "?von=12.02.2029", "IK", 400).path("feld").asText()).isEqualTo("von");
        assertThat(ruf(VERZEICHNIS + "?von=2029-02-12&bis=2029-02-01", "IK", 400).path("feld").asText())
                .isEqualTo("bis");
        assertThat(ruf(VERZEICHNIS + "?format=pdf", "IK", 400).path("feld").asText()).isEqualTo("format");
        assertThat(ruf(VERZEICHNIS + "?person=" + UUID.randomUUID(), "IK", 404).path("code").asText())
                .isEqualTo("nicht_gefunden");
        assertThat(ruf(VERZEICHNIS + "?person=kein-name", "IK", 404).path("code").asText()).isEqualTo("nicht_gefunden");
    }

    // ------------------------------------------------------------------ Messmittel-Belege (AP-16) im Zaun des Geräts

    /**
     * R3 Schritt 2 (Folgepunkt aus IP-8): die Messmittel-Belege von AP-16 sind schon Verweise — je Einbau mit Beleg eine
     * Zeile in „bewertung_messplanung“ mit Person und Tag des Eintragens, der im Browser gebildeten Prüfsumme und
     * „Geführt in Ihrem System: <Ablage>“. Eine Angabe ohne Beleg trägt keine Zeile. Zaun des Geräts: ein Standort-Konto
     * sieht die Einbauten seines Standorts, ein fremder Kundenbereich keinen — ohne Hinweis.
     */
    @Test
    void messmittelBelegeAlsVerweisInDerMessplanungImZaunDesGeraets() throws Exception {
        UUID an1 = anlage("AN-1", s1);
        UUID gr2 = geraet(tenant, an1, "GR-2", "GR-2");
        UUID z5b = geraet(tenant, an1, "GR-4", "Z-5b");
        UUID gr5 = geraet(tenant, an1, "GR-5", "GR-5");
        UUID gr9 = geraet(tenant, anlage("AN-2", s2), "GR-9", "GR-9");
        ruf("PUT", messmittel(gr2), "IK", Map.of("pruefungsart", "eichung", "beleg", Map.of("bezeichnung",
                "Zählerstandsmitteilung 10/2026, Netzgesellschaft Ahrental", "ablage", "beim Kunden (Netzrechnung)",
                "sha256", SHA_GR2)), 200);
        ruf("PUT", messmittel(z5b), "IK", Map.of("genauigkeitsklasse", "1", "beleg", Map.of("bezeichnung",
                "Werksprüfprotokoll Seriennr. 88231", "ablage", "beim Kunden", "sha256", SHA_Z5B)), 200);
        ruf("PUT", messmittel(gr5), "IK", Map.of("genauigkeitsklasse", "1"), 200);
        ruf("PUT", messmittel(gr9), "PH", Map.of("pruefungsart", "kalibrierung", "beleg", Map.of("bezeichnung",
                "Kalibrierschein 2026-117", "sha256", SHA_GR9)), 200);
        LocalDate heute = LocalDate.now(ZoneId.of("Europe/Berlin"));
        // Ein fremder Kundenbereich mit eigenem Beleg.
        UUID fremd = root.queryForObject("INSERT INTO tenant(name) VALUES ('Fremd IP-8') RETURNING id", UUID.class);
        root.update("INSERT INTO unternehmen(tenant_id,name,zeitzone) VALUES (?,'Fremd GmbH','Europe/Berlin')", fremd);
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,'JW','benutzer',"
                + "'Jonas Wendlinger','aktiv')", fremd);
        root.update("INSERT INTO zugriff(tenant_id,benutzer_sub,rolle,standort_id,gueltig_ab,zeitzone) "
                + "VALUES (?,'JW','energiemanager',NULL,'2024-01-01','Europe/Berlin')", fremd);
        UUID fremdeAnlage = root.queryForObject("INSERT INTO site(tenant_id,name) VALUES (?,'Fremd') RETURNING id",
                UUID.class, fremd);
        root.update("UPDATE geraet SET beleg_bezeichnung='Fremder Eichschein', beleg_ablage='Fremdes Archiv', "
                + "beleg_sha256=?, beleg_actor_sub='JW', beleg_actor_name='Jonas Wendlinger', beleg_actor_rolle="
                + "'energiemanager', beleg_actor_art='kunde', beleg_am=now() WHERE id=?", SHA_FREMD,
                geraet(fremd, fremdeAnlage, "GR-2", "GR-2"));
        abruf(Instant.now().plusSeconds(3600).toString());

        JsonNode v = ruf(VERZEICHNIS, "IK", 200);
        List<JsonNode> mm = messmittelZeilen(v);
        assertThat(texte(mm, "kennzeichen")).containsExactly("GR-2", "GR-9", "Z-5b");
        assertThat(texte(gruppe(v, "bewertung_messplanung").path("zeilen"), "kennzeichen"))
                .containsExactly("GR-2", "GR-9", "Z-5b");
        {
            JsonNode z = zeile(v, "messmittel_angabe", "GR-2");
            assertThat(z.path("titel").asText())
                    .isEqualTo("Messmittel GR-2: Zählerstandsmitteilung 10/2026, Netzgesellschaft Ahrental");
            assertThat(z.path("nr").isNull()).isTrue();
            assertThat(z.path("entschieden_von").isNull()).as("niemand sonst hat entschieden (G2)").isTrue();
            assertThat(z.path("eingetragen_von").asText()).isEqualTo("Ines Kaltenbach");
            assertThat(z.path("tag").asText()).isEqualTo(heute.toString());
            assertThat(z.path("pruefsumme").asText()).isEqualTo(SHA_GR2);
            assertThat(z.path("ort").asText()).isEqualTo("verweis");
            assertThat(z.path("ort_satz").asText()).isEqualTo("Geführt in Ihrem System: beim Kunden (Netzrechnung)");
        }
        // Die Angabe hängt am Einbau: Z-5b ist der Einbau von GR-4 (AP-16 R8).
        assertThat(zeile(v, "messmittel_angabe", "Z-5b").path("titel").asText())
                .isEqualTo("Messmittel Z-5b (GR-4): Werksprüfprotokoll Seriennr. 88231");
        {
            JsonNode z = zeile(v, "messmittel_angabe", "GR-9");
            assertThat(z.path("eingetragen_von").asText()).isEqualTo("Peter Hollerbach");
            assertThat(z.path("pruefsumme").asText()).isEqualTo(SHA_GR9);
            // Ohne Ablage nennt der Ort die Bezeichnung des Belegs.
            assertThat(z.path("ort_satz").asText()).isEqualTo("Geführt in Ihrem System: Kalibrierschein 2026-117");
        }
        assertThat(texte(mm, "pruefsumme")).doesNotContain(SHA_FREMD);

        // Zaun des Geräts: je Standort nur seine Einbauten; Einsicht liest unternehmensweit; der fremde Kundenbereich
        // sieht nur seinen eigenen Beleg.
        assertThat(texte(messmittelZeilen(ruf(VERZEICHNIS, "PH", 200)), "kennzeichen")).containsExactly("GR-9");
        assertThat(texte(messmittelZeilen(ruf(VERZEICHNIS, "CB", 200)), "kennzeichen")).containsExactly("GR-2", "Z-5b");
        assertThat(texte(messmittelZeilen(ruf(VERZEICHNIS, "RF", 200)), "kennzeichen"))
                .containsExactly("GR-2", "GR-9", "Z-5b");
        UUID eigen = tenant;
        tenant = fremd;
        try {
            assertThat(texte(messmittelZeilen(ruf(VERZEICHNIS, "JW", 200)), "pruefsumme")).containsExactly(SHA_FREMD);
        } finally {
            tenant = eigen;
        }

        // Stichtag: vor dem Eintragen ist kein Beleg festgehalten.
        abruf(heute.minusDays(1) + "T12:00:00Z");
        assertThat(messmittelZeilen(ruf(VERZEICHNIS, "IK", 200))).isEmpty();
    }

    private static List<JsonNode> messmittelZeilen(JsonNode v) {
        return alle(v).stream().filter(z -> z.path("art").asText().equals("messmittel_angabe")).toList();
    }

    private static String messmittel(UUID geraet) {
        return "/api/v1/geraete/" + geraet + "/messmittel";
    }

    private UUID anlage(String name, UUID standort) {
        UUID id = root.queryForObject("INSERT INTO site(tenant_id,name) VALUES (?,?) RETURNING id", UUID.class,
                tenant, name);
        root.update("INSERT INTO anlage_standort(tenant_id,site_id,standort_id,gueltig_ab) VALUES (?,?,?,'2024-01-01')",
                tenant, id, standort);
        return id;
    }

    private static UUID geraet(UUID mandant, UUID site, String kennzeichen, String einbau) {
        return root.queryForObject("INSERT INTO geraet(tenant_id,site_id,kennzeichen,einbau_kennzeichen,geraeteart,"
                + "eingebaut_am) VALUES (?,?,?,?,'zaehler','2024-01-01T00:00:00Z') RETURNING id", UUID.class, mandant,
                site, kennzeichen, einbau);
    }

    // ------------------------------------------------------------------ Welt

    /**
     * R3 für die Quellen bis hier: D-0001 Energiepolitik (Wortlaut, Original beim Kunden, bekannt gemacht über zwei Wege),
     * D-0002 Anwendungsbereich, D-0003 Rechtliche Anforderungen und D-0004 Betrieb als Verweis; zehn Aufgaben (neun
     * „entschieden von Robert Falk“); Betrachtungsumfang; fünf Kennzahlen mit acht Bezugsbasis-Fassungen.
     */
    private void r3Welt() throws Exception {
        Map<String, JsonNode> p = r5Aufgaben();
        heute("2026-11-04");
        umfang();
        heute("2026-12-15");
        String d1 = dokument("energiepolitik", "Energiepolitik", ORIGINAL);
        fassung(d1, Map.of("form", "wortlaut", "wortlaut", kopien.get("D-0001").at("/eingang/kopie/wortlaut").asText()));
        freigeben(d1, p.get("RF"));
        String d2 = dokument("anwendungsbereich", "Anwendungsbereich des Energiemanagements", null);
        fassung(d2, Map.of("form", "wortlaut", "wortlaut", kopien.get("D-0002").at("/eingang/kopie/wortlaut").asText(),
                "anwendungsbereich", Map.of("standort_ids", List.of(s1.toString(), s2.toString()),
                        "traeger", List.of("Strom", "Gas"), "ausschluesse", List.of())));
        freigeben(d2, p.get("RF"));
        Map<String, Object> kataster = new LinkedHashMap<>(JSON.convertValue(kopien.get("D-0004")
                .at("/eingang/kopie/verweis"), Map.class));
        kataster.put("ablage", "Rechtskataster-Dienst");
        kataster.put("kennung", "RK-2026");
        String d3 = dokument("rechtliche_anforderungen", "Rechtskataster", null);
        fassung(d3, Map.of("form", "verweis", "verweis", kataster));
        freigeben(d3, p.get("IK"));
        heute("2026-12-18");
        for (String weg : List.of("aushang", "intranet")) {
            ruf("POST", BASIS + "/dokumente/" + d1 + "/bekanntmachungen", "IK",
                    Map.of("kreis", "alle Mitarbeitenden beider Werke", "weg", weg), 201);
        }
        heute("2028-11-10");
        String d4 = dokument("betrieb", "Kriterien für Betrieb und Instandhaltung — Spritzguss", null);
        fassung(d4, Map.of("form", "verweis", "verweis", JSON.convertValue(kopien.get("D-0004")
                .at("/eingang/kopie/verweis"), Map.class)));
        freigeben(d4, p.get("IK"));

        String[][] kz = {{"KZ-0004", "Stromeinsatz Spritzguss je kg"}, {"KZ-0001", "Stromeinsatz Montage je Stück"},
            {"KZ-0005", "Netzbezug je m²"}, {"KZ-0006", "Gasbezug Verwaltung je Gradtag"},
            {"KZ-0002", "Stromeinsatz Montage Lindach"}};
        Map<String, UUID> basis = new LinkedHashMap<>();
        for (String[] k : kz) {
            UUID id = kennzahl(k[0], k[1]);
            JsonNode b = ruf("POST", "/api/v1/kennzahlen/" + id + "/bezugsbasen", "IK", null, 201);
            basis.put(b.path("kennzeichen").asText(), UUID.fromString(b.path("id").asText()));
        }
        bezugsbasisFassung(basis.get("BB-0001"), 1, "2026-11-01", "2027-10-31");
        bezugsbasisFassung(basis.get("BB-0001"), 2, "2027-11-01", null);
        bezugsbasisFassung(basis.get("BB-0002"), 1, "2026-11-01", "2026-11-30");
        bezugsbasisFassung(basis.get("BB-0002"), 2, "2026-12-01", null);
        bezugsbasisFassung(basis.get("BB-0003"), 1, "2026-11-01", "2027-02-28");
        bezugsbasisFassung(basis.get("BB-0003"), 2, "2027-03-01", null);
        bezugsbasisFassung(basis.get("BB-0004"), 1, "2027-11-01", null);
        bezugsbasisFassung(basis.get("BB-0005"), 1, "2026-11-01", null);
    }

    /** R5 „gegeben“ (Muster {@code EnergiemanagementVerantwortungApiTest}): sechs Personen, zehn Zuordnungen. */
    private Map<String, JsonNode> r5Aufgaben() throws Exception {
        Map<String, JsonNode> p = new LinkedHashMap<>();
        p.put("RF", person("Robert Falk", "Geschäftsführer", "RF", "RF", "2026-10-01"));
        p.put("IK", person("Ines Kaltenbach", "Energiemanagement", "IK", "IK", "2026-10-01"));
        p.put("JW", person("Jonas Wendlinger", "IT-Leitung", "JW", "JW", "2026-10-01"));
        p.put("PH", person("Peter Hollerbach", "Standortleiter Werk Lindach", "PH", "PH", "2026-10-15"));
        p.put("MD", person("Murat Demirci", "Schichtführer Halle 1", "MD", "MD", "2026-10-01"));
        p.put("CB", person("Claudia Berger", "Controlling", "CB", "CB", "2028-12-01"));
        String rf = id(p.get("RF"));
        ruf("POST", BASIS + "/aufgaben", "IK", Map.of("aufgabe", "unternehmensleitung", "person_id", rf,
                "gilt_ab", "2026-10-01", "begruendung", "Geschäftsführer laut Handelsregister"), 201);
        ruf("POST", BASIS + "/aufgaben", "IK",
                entschieden("energiemanagement_leiten", p.get("IK"), "2026-10-01", rf, id(p.get("JW"))), 201);
        for (String k : List.of("IK", "MD")) {
            ruf("POST", BASIS + "/aufgaben", "IK", entschieden("energieteam", p.get(k), "2026-10-01", rf, null), 201);
        }
        ruf("POST", BASIS + "/aufgaben", "IK", entschieden("energieteam", p.get("PH"), "2026-10-15", rf, null), 201);
        for (String a : List.of("energieziele_massnahmen", "bewertung_messplanung", "dokumente", "managementbewertung")) {
            ruf("POST", BASIS + "/aufgaben", "IK", entschieden(a, p.get("IK"), "2026-10-01", rf, null), 201);
        }
        Map<String, Object> audits = entschieden("interne_audits", p.get("CB"), "2028-12-01", rf, null);
        audits.remove("beleg");
        ruf("POST", BASIS + "/aufgaben", "IK", audits, 201);
        return p;
    }

    private Map<String, Object> entschieden(String aufgabe, JsonNode person, String ab, String von, String vertretung) {
        Map<String, Object> a = new LinkedHashMap<>(Map.of("aufgabe", aufgabe, "person_id", id(person),
                "gilt_ab", ab, "entschieden_von", von, "begruendung", "Bestellung vom 28.09.2026",
                "beleg", BESTELLUNG));
        if (vertretung != null) a.put("vertretung_person_id", vertretung);
        return a;
    }

    private JsonNode person(String name, String funktion, String kuerzel, String konto, String seit) throws Exception {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("name", name);
        b.put("funktion", funktion);
        b.put("kuerzel", kuerzel);
        if (konto != null) b.put("konto_sub", konto);
        b.put("seit", seit);
        return ruf("POST", BASIS + "/personen", "IK", b, 201);
    }

    private String personId(String kuerzel) throws Exception {
        for (JsonNode p : ruf(BASIS + "/personen", "IK", 200).path("personen")) {
            if (kuerzel.equals(p.path("kuerzel").asText())) return p.path("id").asText();
        }
        throw new AssertionError(kuerzel + " fehlt");
    }

    private String dokument(String art, String titel, Map<String, Object> beleg) throws Exception {
        Map<String, Object> b = new LinkedHashMap<>(Map.of("art", art, "titel", titel, "bezug",
                Map.of("art", "unternehmen")));
        if (beleg != null) b.put("beleg", beleg);
        return ruf("POST", BASIS + "/dokumente", "IK", b, 201).path("id").asText();
    }

    private void fassung(String dokument, Map<String, Object> fassung) throws Exception {
        ruf("POST", BASIS + "/dokumente/" + dokument + "/fassungen", "IK", fassung, 201);
    }

    private void freigeben(String dokument, JsonNode person) throws Exception {
        ruf("POST", BASIS + "/dokumente/" + dokument + "/fassungen/1/freigeben", "IK", Map.of("entschieden_von",
                id(person), "begruendung", "In der Besprechung am selben Tag entschieden."), 200);
    }

    /** AP-16 U1: der Betrachtungsumfang Fassung 1 ab 04.11.2026 an beiden Werken (Muster IP-7). */
    private void umfang() {
        UUID u = root.queryForObject("INSERT INTO bewertung_umfang (tenant_id, unternehmen_id, fassung, gueltig_ab, "
                + "traeger, begruendung, actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, ?, 1, '2026-11-04', "
                + "'{Strom,Gas}'::text[], 'Erster Betrachtungsumfang der energetischen Bewertung.', 'IK', "
                + "'Ines Kaltenbach', 'energiemanager', 'kunde') RETURNING id", UUID.class, tenant, unternehmen);
        for (UUID s : List.of(s1, s2)) {
            root.update("INSERT INTO bewertung_umfang_standort (tenant_id, umfang_id, standort_id) VALUES (?, ?, ?)",
                    tenant, u, s);
        }
    }

    private UUID kennzahl(String kennzeichen, String name) throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", kennzeichen);
        m.put("name", name);
        m.put("rechenform", "quotient");
        m.put("geltung_art", "gebaeude");
        m.put("geltung_id", g2.toString());
        m.put("verantwortlich_name", "Ines Kaltenbach");
        m.put("eingaenge", List.of(Map.of("rolle", "zaehler", "art", "messstelle", "kennzeichen", "MS-20"),
                Map.of("rolle", "nenner", "art", "bezugsgroesse", "kennzeichen", "BZ-1")));
        return UUID.fromString(ruf("POST", "/api/v1/kennzahlen", "IK", m, 201).path("id").asText());
    }

    /** Eine freigegebene Fassung, direkt geschrieben (Muster IP-10): Ines Kaltenbach, ohne Vier-Augen. */
    private void bezugsbasisFassung(UUID basis, int nummer, String giltAb, String giltBis) {
        UUID f = root.queryForObject("INSERT INTO bezugsbasis_fassung (tenant_id, bezugsbasis_id, fassung, "
                + "referenzperiode, methode, datenlage, gilt_ab, gilt_bis, beendet_am, beendet_grund, toleranz_prozent, "
                + "anpassungsgruende, begruendung, basiswert, actor_sub, actor_name, actor_rolle, actor_art, "
                + "freigabe_status, freigabe_sub, freigabe_name, freigabe_rolle, freigabe_art, freigabe_am, "
                + "freigegeben_am) VALUES (?, ?, ?, '2026-10/2026-10', 'verhaeltnis', 'vorlaeufig', ?, ?, ?, ?, 2.0, "
                + "?::text[], 'Freigabe im Verzeichnis-Test.', 0.2837, 'IK', 'Ines Kaltenbach', 'energiemanager', "
                + "'kunde', 'freigegeben', 'IK', 'Ines Kaltenbach', 'energiemanager', 'kunde', now(), now()) "
                + "RETURNING id", UUID.class, tenant, basis, nummer, Date.valueOf(giltAb),
                giltBis == null ? null : Date.valueOf(giltBis), giltBis == null ? null : Timestamp.from(Instant.now()),
                giltBis == null ? null : "Die nächste Fassung ersetzt diese.",
                nummer > 1 ? "{referenzperiode_vervollstaendigt}" : "{}");
        root.update("INSERT INTO bezugsbasis_variable (tenant_id, fassung_id, position, bezugsgroesse_id, "
                + "bezugsgroesse_fassung) VALUES (?, ?, 1, ?, 1)", tenant, f, bz1);
    }

    // ------------------------------------------------------------------ Lesen

    private static JsonNode gruppe(JsonNode v, String gruppe) {
        for (JsonNode g : v.path("gruppen")) {
            if (g.path("gruppe").asText().equals(gruppe)) return g;
        }
        throw new AssertionError(gruppe + " fehlt");
    }

    private static List<JsonNode> alle(JsonNode v) {
        List<JsonNode> aus = new ArrayList<>();
        v.path("gruppen").forEach(g -> g.path("zeilen").forEach(aus::add));
        return aus;
    }

    private static JsonNode zeile(JsonNode v, String art, String kennzeichen) {
        return alle(v).stream().filter(z -> z.path("art").asText().equals(art)
                && z.path("kennzeichen").asText().equals(kennzeichen)).findFirst()
                .orElseThrow(() -> new AssertionError(art + " " + kennzeichen + " fehlt"));
    }

    private static List<String> felder(JsonNode n) {
        List<String> aus = new ArrayList<>();
        n.fieldNames().forEachRemaining(aus::add);
        return aus;
    }

    private static List<String> texte(Iterable<JsonNode> liste, String feld) {
        List<String> aus = new ArrayList<>();
        liste.forEach(n -> aus.add(n.path(feld).asText()));
        return aus;
    }

    private static String id(JsonNode n) {
        return n.has("verlauf") ? n.at("/person/id").asText() : n.path("id").asText();
    }

    private void heute(String tag) {
        dokumente.uhrStellen(Clock.fixed(Instant.parse(tag + "T10:00:00Z"), ZoneOffset.UTC));
    }

    private void abruf(String jetzt) {
        verzeichnis.uhrStellen(Clock.fixed(Instant.parse(jetzt), ZoneOffset.UTC));
    }

    private Authentication token(String sub) {
        Jwt jwt = Jwt.withTokenValue("test").header("alg", "none").subject(sub).issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600)).claim("tenant_id", tenant.toString())
                .claim("realm_access", Map.of("roles", List.of())).claim("name", NAMEN.get(sub))
                .claim("preferred_username", NAMEN.get(sub)).build();
        return new KeycloakRealmRoleConverter().convert(jwt);
    }

    private JsonNode ruf(String path, String sub, int status) throws Exception {
        return ruf("GET", path, sub, null, status);
    }

    private MockHttpServletResponse roh(String path, String sub) throws Exception {
        return mvc.perform(request(HttpMethod.GET, path).with(authentication(token(sub)))).andReturn().getResponse();
    }

    private JsonNode ruf(String method, String path, String sub, Object body, int status) throws Exception {
        var b = request(HttpMethod.valueOf(method), path).with(authentication(token(sub)));
        if (body != null) b.contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(body));
        var r = mvc.perform(b).andReturn().getResponse();
        assertThat(r.getStatus()).as(method + " " + path + " " + r.getContentAsString(StandardCharsets.UTF_8))
                .isEqualTo(status);
        return JSON.readTree(r.getContentAsString(StandardCharsets.UTF_8));
    }

    private UUID standort(String k, String name) {
        return root.queryForObject("INSERT INTO standort(tenant_id,unternehmen_id,name,kurzzeichen,zeitzone,zustand) "
                + "VALUES (?,?,?,?,'Europe/Berlin','aktiv') RETURNING id", UUID.class, tenant, unternehmen, name, k);
    }

    private void benutzer(String sub, String rolle, UUID standort) {
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,?,'benutzer',?,'aktiv')",
                tenant, sub, NAMEN.get(sub));
        root.update("INSERT INTO zugriff(tenant_id,benutzer_sub,rolle,standort_id,gueltig_ab,zeitzone) "
                + "VALUES (?,?,?,?,'2024-01-01','Europe/Berlin')", tenant, sub, rolle, standort);
    }
}
