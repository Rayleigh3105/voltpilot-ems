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
 * UEMS AP-19 IP-21 (NW-2): die Wiedervorlage {@code GET /api/v1/energiemanagement/wiedervorlage} über die echte HTTP-,
 * Rechte- und RLS-Kette mit der App-Rolle — R12 des Konzepts: am 12.02.2029 acht fällige Zeilen (vier Bezugsbasen, der
 * Revisions-Anstoß des Leistungsvergleichs, die energetische Bewertung, Energiepolitik und Anwendungsbereich), am
 * längsten fällig zuerst, und eine Vorschau-Zeile (M-2029-0001 in 16 Tagen); Audit, Feststellung, BB-0001 („geprüft,
 * bleibt“), D-0003, D-0004 und M-2029-0002 liegen außerhalb der Vorschau. Der Tag ist gestellt (keine Uhr). Dazu der
 * Kalender-Abzug mit denselben neun Zeilen und dem Stand-Vermerk — auch für „Einsicht“.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class EnergiemanagementWiedervorlageApiTest {
    private static final String BASIS = "/api/v1/energiemanagement";
    private static final String WIEDERVORLAGE = BASIS + "/wiedervorlage";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Map<String, String> NAMEN = Map.of("IK", "Ines Kaltenbach", "JW", "Jonas Wendlinger",
            "PH", "Peter Hollerbach", "CB", "Claudia Berger", "RF", "Robert Falk");
    private static final String VERMERK = "Stand vom 12.02.2029 aus VoltPilot; maßgeblich ist die Wiedervorlage im Portal.";
    private static final String BEGRUENDUNG = "In der Besprechung am selben Tag entschieden.";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "ip21_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "ip21_test_pw");
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> "http://127.0.0.1:9/realms/voltpilot");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri", () -> "http://127.0.0.1:9/certs");
        r.add("voltpilot.uems.kennzahlen.enabled", () -> "false");
    }

    @Autowired MockMvc mvc;
    @Autowired EnergiemanagementWiedervorlageService wiedervorlage;
    @Autowired EnergiemanagementDokumentService dokumente;
    @Autowired InternesAuditService audits;
    @Autowired FeststellungService feststellungen;
    @Autowired KennzahlService kennzahlen;
    static JdbcTemplate root;
    static Map<String, JsonNode> kopien;
    UUID tenant, unternehmen, s1, s2, g2, bz1;
    Map<String, String> person = new LinkedHashMap<>();

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
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Ahrenberg IP-21') RETURNING id", UUID.class);
        unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name,zeitzone) VALUES (?,"
                + "'Kunststoffwerk Ahrenberg GmbH','Europe/Berlin') RETURNING id", UUID.class, tenant);
        s1 = standort("ST-1", "Werk Ahrenberg");
        s2 = standort("ST-2", "Werk Lindach");
        benutzer("IK", "energiemanager", null);
        benutzer("JW", "kundenadministrator", null);
        benutzer("PH", "bearbeiter", s2);
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
        for (var dienst : List.<java.util.function.Consumer<Clock>>of(wiedervorlage::uhrStellen, dokumente::uhrStellen,
                audits::uhrStellen, feststellungen::uhrStellen, kennzahlen::uhrStellen)) {
            dienst.accept(Clock.systemUTC());
        }
    }

    // ------------------------------------------------------------------ R12

    @Test
    void r12AchtFaelligEineVorschauAmLaengstenFaelligZuerstUndDerKalenderAbzugMitStandVermerk() throws Exception {
        r12Welt();
        abruf("2029-02-12T07:00:00Z");
        JsonNode w = ruf(WIEDERVORLAGE, "IK", 200);

        assertThat(w.path("stichtag").asText()).startsWith("2029-02-12T08:00");
        assertThat(w.path("vorschau_tage").asInt()).isEqualTo(30);
        assertThat(w.path("verantwortung").asText()).startsWith("Inhalte und Entscheidungen Ihres Energiemanagements");

        // WV3: am längsten fällig zuerst, bei gleichem Tag nach Kennzeichen (BB-0004 vor BR-2027-0001, beide 24.11.2028).
        assertThat(texte(w.path("faellig"), "kennzeichen")).containsExactly("BB-0002", "BB-0005", "BB-0003",
                "BR-2028-0001", "BB-0004", "BR-2027-0001", "D-0001", "D-0002");
        assertThat(texte(w.path("faellig"), "tage")).containsExactly("457", "450", "344", "315", "80", "80", "64", "64");
        assertThat(texte(w.path("faellig"), "faellig_am")).containsExactly("2027-11-13", "2027-11-20", "2028-03-05",
                "2028-04-03", "2028-11-24", "2028-11-24", "2028-12-10", "2028-12-10");
        assertThat(texte(w.path("faellig"), "art")).containsExactly("bezugsbasis_ueberpruefung",
                "bezugsbasis_ueberpruefung", "bezugsbasis_ueberpruefung", "bericht_anstoss", "bezugsbasis_ueberpruefung",
                "bewertung_ueberpruefung", "dokument_ueberpruefung", "dokument_ueberpruefung");
        assertThat(w.at("/faellig/0/satz").asText()).isEqualTo("seit 457 Tagen fällig");
        assertThat(w.at("/faellig/0/titel").asText())
                .isEqualTo("Bezugsbasis BB-0002, Fassung 2 — Überprüfung (Freigabe 13.11.2026 + 12 Monate)");
        assertThat(w.at("/faellig/3/titel").asText())
                .isEqualTo("Kunststoffwerk Ahrenberg GmbH · 2027-12 — Revision angestoßen (K-2028-0001)");
        assertThat(w.at("/faellig/6/titel").asText()).isEqualTo("Energiepolitik — Überprüfung");
        // Der Sprung: die Bezugsbasis mit ihrer Kennzahl, das Dokument mit seiner ID; Berichte haben ihr Kennzeichen.
        assertThat(w.at("/faellig/0/id").isNull()).isFalse();
        assertThat(w.at("/faellig/0/kennzahl_id").isNull()).isFalse();
        assertThat(w.at("/faellig/6/id").isNull()).isFalse();
        assertThat(w.at("/faellig/5/id").isNull()).isTrue();

        // Vorschau (30 Tage): M-2029-0001 aus ihrem Register — der Übersichts-Leser nennt sie (noch) nicht.
        assertThat(texte(w.path("vorschau"), "kennzeichen")).containsExactly("M-2029-0001");
        assertThat(w.at("/vorschau/0/satz").asText()).isEqualTo("fällig in 16 Tagen");
        assertThat(w.at("/vorschau/0/faellig_am").asText()).isEqualTo("2029-02-28");
        assertThat(w.at("/vorschau/0/verantwortlich").asText()).isEqualTo("Jonas Wendlinger");
        assertThat(w.path("anzahl_faellig").asInt()).isEqualTo(8);
        assertThat(w.path("anzahl_vorschau").asInt()).isEqualTo(1);
        // Außerhalb: das nächste Audit (22.01.2030), BB-0001 („geprüft, bleibt“ 25.11.2028), D-0003, D-0004, die
        // Frist der Feststellung (22.04.2029), M-2029-0002 (30.06.2029).
        assertThat(texte(w.path("nicht_in_liste"), null)).containsExactly("AU-2029-0001", "BB-0001", "D-0003",
                "D-0004", "F-2029-0001", "M-2029-0002");

        // WV4, E10: der Kalender-Abzug — dieselben neun Zeilen als ganztägige Termine, jeder mit dem Stand-Vermerk.
        MockHttpServletResponse ics = roh(WIEDERVORLAGE + "?format=ics", "IK");
        assertThat(ics.getStatus()).isEqualTo(200);
        assertThat(ics.getContentType()).startsWith("text/calendar");
        assertThat(ics.getHeader("Content-Disposition")).contains("wiedervorlage-2029-02-12.ics");
        String text = ics.getContentAsString(StandardCharsets.UTF_8);
        String entfaltet = text.replace("\r\n ", "");
        assertThat(text).startsWith("BEGIN:VCALENDAR\r\n").endsWith("END:VCALENDAR\r\n");
        assertThat(entfaltet.split("BEGIN:VEVENT", -1)).hasSize(10);
        assertThat(entfaltet).contains("X-WR-CALDESC:" + VERMERK.replace(";", "\\;"));
        assertThat(entfaltet.split(java.util.regex.Pattern.quote("DESCRIPTION:" + VERMERK.replace(";", "\\;")), -1))
                .hasSize(10);
        assertThat(entfaltet).contains("DTSTART;VALUE=DATE:20271113\r\n", "DTSTART;VALUE=DATE:20290228\r\n",
                "SUMMARY:BB-0002: Bezugsbasis BB-0002\\, Fassung 2 — Überprüfung (Freigabe 13.11.2026 + 12 Monate)",
                "SUMMARY:M-2029-0001: Aufgabe „Bezugsbasen pflegen und freigeben“ festlegen");
        for (String zeile : text.split("\r\n")) {
            assertThat(zeile.getBytes(StandardCharsets.UTF_8).length).as(zeile).isLessThanOrEqualTo(75);
        }

        // R6, Z4: „Einsicht“ sieht dieselbe Liste und lädt den Kalender-Abzug — nichts wird verschickt.
        JsonNode einsicht = ruf(WIEDERVORLAGE, "RF", 200);
        assertThat(texte(einsicht.path("faellig"), "kennzeichen")).isEqualTo(texte(w.path("faellig"), "kennzeichen"));
        assertThat(roh(WIEDERVORLAGE + "?format=ics", "RF").getStatus()).isEqualTo(200);
        assertThat(ruf(WIEDERVORLAGE + "?format=pdf", "IK", 400).path("code").asText()).isNotBlank();
    }

    /** Ohne Frist keine Zeile: ein Unternehmen ohne Energiemanagement bekommt eine leere Wiedervorlage (R15). */
    @Test
    void ohneFristLeerUndOhneZahlenDieNichtDaSind() throws Exception {
        abruf("2029-02-12T07:00:00Z");
        JsonNode w = ruf(WIEDERVORLAGE, "IK", 200);
        assertThat(w.path("faellig").size()).isZero();
        assertThat(w.path("vorschau").size()).isZero();
        assertThat(w.path("anzahl_faellig").asInt()).isZero();
        assertThat(w.path("nicht_in_liste").size()).isZero();
        String ics = roh(WIEDERVORLAGE + "?format=ics", "IK").getContentAsString(StandardCharsets.UTF_8);
        assertThat(ics).doesNotContain("BEGIN:VEVENT").contains("X-WR-CALDESC:Stand vom 12.02.2029");
    }

    // ------------------------------------------------------------------ Welt R12

    private void r12Welt() throws Exception {
        heute("2026-10-01T10:00:00Z");
        person.put("RF", personAnlegen("Robert Falk", "Geschäftsführer", "RF", "RF"));
        person.put("IK", personAnlegen("Ines Kaltenbach", "Energiemanagement", "IK", "IK"));
        person.put("JW", personAnlegen("Jonas Wendlinger", "IT-Leitung", "JW", "JW"));
        person.put("CB", personAnlegen("Claudia Berger", "Controlling", "CB", "CB"));
        ruf("POST", BASIS + "/aufgaben", "IK", Map.of("aufgabe", "unternehmensleitung", "person_id", person.get("RF"),
                "gilt_ab", "2026-10-01", "begruendung", "Geschäftsführer laut Handelsregister"), 201);

        // DK5: D-0001/D-0002 freigegeben am 15.12.2026, „geprüft, bleibt“ am 10.12.2027 → fällig am 10.12.2028.
        heute("2026-12-15T10:00:00Z");
        String d1 = dokument("energiepolitik", "Energiepolitik");
        fassung(d1, Map.of("form", "wortlaut", "wortlaut", kopien.get("D-0001").at("/eingang/kopie/wortlaut").asText()));
        freigeben(d1, "RF");
        String d2 = dokument("anwendungsbereich", "Anwendungsbereich");
        fassung(d2, Map.of("form", "wortlaut", "wortlaut", kopien.get("D-0002").at("/eingang/kopie/wortlaut").asText(),
                "anwendungsbereich", Map.of("standort_ids", List.of(s1.toString(), s2.toString()),
                        "traeger", List.of("Strom", "Gas"), "ausschluesse", List.of())));
        freigeben(d2, "RF");
        heute("2027-12-10T10:00:00Z");
        for (String d : List.of(d1, d2)) {
            ruf("POST", BASIS + "/dokumente/" + d + "/geprueft", "IK", Map.of("entschieden_von", person.get("RF"), "am",
                    "2027-12-10", "begruendung", "Mit der Jahresplanung 2028 durchgesehen; gilt unverändert."), 200);
        }
        // D-0003 (fällig 01.06.2029) und D-0004 (fällig 10.11.2029) liegen nach der Vorschau.
        heute("2028-06-01T10:00:00Z");
        String d3 = dokument("rechtliche_anforderungen", "Rechtliche Anforderungen");
        fassung(d3, Map.of("form", "wortlaut", "wortlaut", "Rechtskataster: Stand 01.06.2028, geprüft im Rechtsdienst."));
        freigeben(d3, "IK");
        heute("2028-11-10T10:00:00Z");
        String d4 = dokument("betrieb", "Betrieb und Instandhaltung Spritzguss");
        fassung(d4, Map.of("form", "wortlaut", "wortlaut", "Kriterien für Betrieb und Instandhaltung der Spritzgussanlagen."));
        freigeben(d4, "IK");

        // AP-17 F5: fünf Bezugsbasen — Freigabe + 12 Monate, BB-0001 nach „geprüft, bleibt“ am 25.11.2028.
        String[][] kz = {{"KZ-0004", "Stromeinsatz Spritzguss je kg"}, {"KZ-0001", "Stromeinsatz Montage je Stück"},
            {"KZ-0005", "Netzbezug je m²"}, {"KZ-0006", "Gasbezug Verwaltung je Gradtag"},
            {"KZ-0002", "Stromeinsatz Montage Lindach"}};
        Map<String, UUID> basis = new LinkedHashMap<>();
        Map<String, UUID> kennzahl = new LinkedHashMap<>();
        for (String[] k : kz) {
            UUID id = kennzahlAnlegen(k[0], k[1]);
            JsonNode b = ruf("POST", "/api/v1/kennzahlen/" + id + "/bezugsbasen", "IK", null, 201);
            basis.put(b.path("kennzeichen").asText(), UUID.fromString(b.path("id").asText()));
            kennzahl.put(b.path("kennzeichen").asText(), id);
        }
        bezugsbasisFassung(basis.get("BB-0001"), 1, "2026-11-01", null, "2027-11-25T10:00:00Z");
        bezugsbasisFassung(basis.get("BB-0002"), 1, "2026-11-01", "2026-11-30", "2026-11-02T10:00:00Z");
        bezugsbasisFassung(basis.get("BB-0002"), 2, "2026-12-01", null, "2026-11-13T10:00:00Z");
        bezugsbasisFassung(basis.get("BB-0003"), 1, "2026-11-01", "2027-02-28", "2026-11-02T10:00:00Z");
        bezugsbasisFassung(basis.get("BB-0003"), 2, "2027-03-01", null, "2027-03-05T10:00:00Z");
        bezugsbasisFassung(basis.get("BB-0004"), 1, "2027-11-01", null, "2027-11-24T10:00:00Z");
        bezugsbasisFassung(basis.get("BB-0005"), 1, "2026-11-01", null, "2026-11-20T10:00:00Z");
        kennzahlen.uhrStellen(Clock.fixed(Instant.parse("2028-11-25T10:00:00Z"), ZoneOffset.UTC));
        ruf("POST", "/api/v1/kennzahlen/" + kennzahl.get("BB-0001") + "/bezugsbasen/" + basis.get("BB-0001") + "/bleibt",
                "IK", Map.of("begruendung", "Jahresdurchsicht: Produktmix unverändert, die Basis gilt weiter."), 200);

        // AP-16 S5: die energetische Bewertung, Stand Nr. 1 freigegeben am 24.11.2027 → fällig am 24.11.2028.
        UUID bw = bericht("BR-2027-0001", "energetische_bewertung", "datengrundlage", "2027-10", null);
        stand(bw, "2027-11-24T10:00:00Z");
        // AP-12 E7: ein Leistungsvergleich mit offenem Revisions-Anstoß seit 03.04.2028 (Kaskade nach K-2028-0001).
        UUID vb = bericht("BR-2028-0001", "leistungsvergleich", "monat", "2027-12", kennzahl.get("BB-0001"));
        UUID vbStand = stand(vb, "2028-01-20T10:00:00Z");
        root.update("INSERT INTO bericht_revision_anstoss (tenant_id, stand_id, art, anlass_kennung, anlass_fassung, "
                + "anlass_status, erkannt_am) VALUES (?, ?, 'korrektur_freigegeben', 'K-2028-0001', 1, 'freigegeben', ?)",
                tenant, vbStand, Timestamp.from(Instant.parse("2028-04-03T08:00:00Z")));

        // IA4: AU-2029-0001 durchgeführt am 22.01.2029 → nächstes am 22.01.2030; FS1: F-2029-0001 bis 22.04.2029.
        audits.uhrStellen(Clock.fixed(Instant.parse("2029-01-10T09:00:00Z"), ZoneOffset.UTC));
        Map<String, Object> a = new LinkedHashMap<>();
        a.put("titel", "Internes Audit 2029: Bezugsbasen, Energieziele, Maßnahmen und Grundlagen");
        a.put("termin", "2029-01-22");
        a.put("auditor_ids", List.of(person.get("CB")));
        a.put("unabhaengigkeit", "Claudia Berger (Controlling) gehört nicht zum Energieteam und prüft keine eigene Arbeit.");
        a.put("was", "Bezugsbasen, Energieziel, Maßnahmen und Grundlagen");
        a.put("woran", "Energiepolitik D-0001 Fassung 1, Aufgaben im Energiemanagement");
        a.put("verantwortlich", "IK");
        String au = ruf("POST", BASIS + "/audits", "IK", a, 201).at("/audit/id").asText();
        audits.uhrStellen(Clock.fixed(Instant.parse("2029-01-22T15:00:00Z"), ZoneOffset.UTC));
        ruf("POST", BASIS + "/audits/" + au + "/durchgefuehrt", "IK", Map.of("am", "2029-01-22"), 200);
        feststellungen.uhrStellen(Clock.fixed(Instant.parse("2029-01-23T10:00:00Z"), ZoneOffset.UTC));
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("quelle", Map.of("art", "internes_audit", "audit_id", au));
        f.put("wortlaut", "Wer die Bezugsbasen pflegt und freigibt und wer vertritt, ist nicht festgelegt.");
        f.put("vorgabe", Map.of("wortlaut", "„Wir legen fest, wer im Energiemanagement wofür zuständig ist.“"));
        f.put("festgestellt_von", person.get("CB"));
        f.put("festgestellt_am", "2029-01-22");
        f.put("verantwortlich", "JW");
        String fs = ruf("POST", BASIS + "/feststellungen", "IK", f, 201).at("/feststellung/kennzeichen").asText();

        // AP-18 F2: M-2029-0001 (Termin 28.02.2029, Vorschau) und M-2029-0002 (Termin 30.06.2029, außerhalb).
        kennzahlen.uhrStellen(Clock.fixed(Instant.parse("2029-02-01T10:00:00Z"), ZoneOffset.UTC));
        massnahme("Aufgabe „Bezugsbasen pflegen und freigeben“ festlegen und über die zweite Prüfung entscheiden", "JW",
                "2029-02-28", "nichtkonformitaet", fs);
        massnahme("Hinweis aus dem internen Audit: Bekanntmachung der Energiepolitik im Werk Lindach wiederholen", "IK",
                "2029-06-30", "audit", "AU-2029-0001");
    }

    private String personAnlegen(String name, String funktion, String kuerzel, String konto) throws Exception {
        Map<String, Object> b = new LinkedHashMap<>(Map.of("name", name, "funktion", funktion, "kuerzel", kuerzel,
                "seit", "2026-10-01"));
        if (konto != null) b.put("konto_sub", konto);
        JsonNode p = ruf("POST", BASIS + "/personen", "IK", b, 201);
        return p.has("verlauf") ? p.at("/person/id").asText() : p.path("id").asText();
    }

    private String dokument(String art, String titel) throws Exception {
        return ruf("POST", BASIS + "/dokumente", "IK", Map.of("art", art, "titel", titel, "bezug",
                Map.of("art", "unternehmen")), 201).path("id").asText();
    }

    private void fassung(String dokument, Map<String, Object> fassung) throws Exception {
        ruf("POST", BASIS + "/dokumente/" + dokument + "/fassungen", "IK", fassung, 201);
    }

    private void freigeben(String dokument, String von) throws Exception {
        ruf("POST", BASIS + "/dokumente/" + dokument + "/fassungen/1/freigeben", "IK", Map.of("entschieden_von",
                person.get(von), "begruendung", BEGRUENDUNG), 200);
    }

    private void massnahme(String titel, String verantwortlich, String termin, String herkunft, String kennung)
            throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("titel", titel);
        m.put("verantwortlich", verantwortlich);
        m.put("termin", termin);
        m.put("herkunft", herkunft);
        m.put("herkunft_kennung", kennung);
        m.put("erwartete_wirkung_wortlaut", "Zuständigkeit festgelegt; jede Freigabe nennt die zuständige Person.");
        ruf("POST", "/api/v1/massnahmen", "IK", m, 201);
    }

    private UUID kennzahlAnlegen(String kennzeichen, String name) throws Exception {
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

    /** Eine freigegebene Fassung, direkt geschrieben (Muster IP-8/IP-10) — mit dem Tag ihrer Freigabe. */
    private void bezugsbasisFassung(UUID basis, int nummer, String giltAb, String giltBis, String freigegeben) {
        Timestamp am = Timestamp.from(Instant.parse(freigegeben));
        UUID f = root.queryForObject("INSERT INTO bezugsbasis_fassung (tenant_id, bezugsbasis_id, fassung, "
                + "referenzperiode, methode, datenlage, gilt_ab, gilt_bis, beendet_am, beendet_grund, toleranz_prozent, "
                + "anpassungsgruende, begruendung, basiswert, actor_sub, actor_name, actor_rolle, actor_art, "
                + "freigabe_status, freigabe_sub, freigabe_name, freigabe_rolle, freigabe_art, freigabe_am, "
                + "freigegeben_am) VALUES (?, ?, ?, '2026-10/2026-10', 'verhaeltnis', 'vorlaeufig', ?, ?, ?, ?, 2.0, "
                + "?::text[], 'Freigabe im Wiedervorlage-Test.', 0.2837, 'IK', 'Ines Kaltenbach', 'energiemanager', "
                + "'kunde', 'freigegeben', 'IK', 'Ines Kaltenbach', 'energiemanager', 'kunde', ?, ?) "
                + "RETURNING id", UUID.class, tenant, basis, nummer, Date.valueOf(giltAb),
                giltBis == null ? null : Date.valueOf(giltBis), giltBis == null ? null : am,
                giltBis == null ? null : "Die nächste Fassung ersetzt diese.",
                nummer > 1 ? "{referenzperiode_vervollstaendigt}" : "{}", am, am);
        root.update("INSERT INTO bezugsbasis_variable (tenant_id, fassung_id, position, bezugsgroesse_id, "
                + "bezugsgroesse_fassung) VALUES (?, ?, 1, ?, 1)", tenant, f, bz1);
    }

    /** Ein Bericht, wie ihn das Anlegen schreibt — am Unternehmen (Muster {@code UemsStrukturAenderungTest}). */
    private UUID bericht(String kennung, String vorlage, String zeitraumArt, String schluessel, UUID kennzahl) {
        return root.queryForObject("INSERT INTO bericht (tenant_id, kennung, vorlage, vorlage_fassung, geltung_art, "
                + "unternehmen_id, zeitraum_art, zeitraum_schluessel, zeitzone, angelegt_von_name, kennzahl_id) "
                + "VALUES (?, ?, ?, 1, 'unternehmen', ?, ?, ?, 'Europe/Berlin', 'Ines Kaltenbach', ?) RETURNING id",
                UUID.class, tenant, kennung, vorlage, unternehmen, zeitraumArt, schluessel, kennzahl);
    }

    /** Stand Nr. 1, freigegeben am {@code am} (Muster {@code UemsBelegschutzApiTest}). */
    private UUID stand(UUID bericht, String am) {
        String abzug = "{\"bericht\":\"" + bericht + "\",\"nr\":1}";
        Timestamp t = Timestamp.from(Instant.parse(am));
        return root.queryForObject("INSERT INTO bericht_stand (tenant_id, bericht_id, nr, abzug, pruefsumme, datenstand, "
                + "freigegeben_am, freigeber_sub, freigeber_name, freigeber_rolle, darstellung, regelwerk, "
                + "vorlage_fassung) VALUES (?, ?, 1, ?, ?, ?, ?, 'IK', 'Ines Kaltenbach', 'energiemanager', "
                + "'{}'::jsonb, '{}'::jsonb, 1) RETURNING id", UUID.class, tenant, bericht, abzug,
                BerichtRegeln.pruefsumme(abzug), t, t);
    }

    // ------------------------------------------------------------------ Lesen

    private static List<String> texte(JsonNode liste, String feld) {
        List<String> aus = new ArrayList<>();
        liste.forEach(n -> aus.add(feld == null ? n.asText() : n.path(feld).asText()));
        return aus;
    }

    private void heute(String jetzt) {
        dokumente.uhrStellen(Clock.fixed(Instant.parse(jetzt), ZoneOffset.UTC));
    }

    /** Der Abruf: alle Uhren, an denen eine Quelle „heute“ misst, auf denselben Augenblick. */
    private void abruf(String jetzt) {
        Clock uhr = Clock.fixed(Instant.parse(jetzt), ZoneOffset.UTC);
        wiedervorlage.uhrStellen(uhr);
        dokumente.uhrStellen(uhr);
        audits.uhrStellen(uhr);
        feststellungen.uhrStellen(uhr);
        kennzahlen.uhrStellen(uhr);
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
