package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.zugriff.ZugriffContext;
import com.voltpilot.api.zugriff.ZugriffKontextLader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
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
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
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
 * UEMS AP-19 IP-14 (NW-2): betriebliche Nachweise über die echte HTTP-, Rechte- und RLS-Kette mit der App-Rolle — R7
 * (D-0004 „Kriterien für Betrieb und Instandhaltung — Spritzguss“ am Energieeinsatz EE-1 als Verweis auf den Arbeitsplan
 * IH-SG-01: Ort-Satz, Prüfsumme aus dem Browser, Überprüfung 10.11.2029) und R8 (D-0005 Unterweisung von Murat Demirci
 * als Verweis ins Personalsystem ohne Überprüfung; am 12.02.2029 zwei Bekanntmachungen: D-0001 an alle Mitarbeitenden
 * über Aushang und Intranet, D-0004 an Schichtführer und Instandhaltung) mit den Werten der Referenzdatei 1.10; dazu der
 * Zaun über den Standort des Einsatzes (Messstellen an einem Standort → dessen Zaun, an zwei → Unternehmen), die
 * Verzeichnis-Gruppen „Kompetenz und Kommunikation“ und „Betrieb, Auslegung und Beschaffung“ (Katalog R3: drei und eine
 * Zeile), Bezug an einer Aufgabe und die Ablehnungen des Schreibwegs. Die Uhr ist gestellt ({@code uhrStellen}).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class EnergiemanagementNachweiseApiTest {
    private static final String DOKUMENTE = "/api/v1/energiemanagement/dokumente";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Map<String, String> NAMEN = Map.of("IK", "Ines Kaltenbach", "JW", "Jonas Wendlinger",
            "PH", "Peter Hollerbach", "CB", "Claudia Berger", "MD", "Murat Demirci", "RF", "Robert Falk");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "ip14_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "ip14_test_pw");
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> "http://127.0.0.1:9/realms/voltpilot");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri", () -> "http://127.0.0.1:9/certs");
    }

    @Autowired MockMvc mvc;
    @Autowired EnergiemanagementDokumentService dienst;
    @Autowired DokumentVerzeichnis verzeichnis;
    @Autowired ZugriffKontextLader lader;
    static JdbcTemplate root;
    static Map<String, JsonNode> referenz;
    static String wortlautD0001;
    UUID tenant, unternehmen, s1, s2, ee1, ee2;

    @BeforeAll
    static void start() throws Exception {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        // Die Dokumente der Referenzdatei 1.10 (IP-1) mit ihren Fassungen und Prüfsummen.
        referenz = new LinkedHashMap<>();
        for (JsonNode d : JSON.readTree(Path.of("../../docs/contracts/v2/uems-referenzunternehmen.json").toFile())
                .path("dokumente")) {
            referenz.put(d.path("kennzeichen").asText(), d);
        }
        for (JsonNode c : JSON.readTree(Path.of("../../docs/contracts/v2/energiemanagement-vectors.json").toFile())
                .path("cases")) {
            if (c.path("operation").asText().equals("pruefsumme") && c.path("name").asText().startsWith("R1 D-0001")) {
                wortlautD0001 = c.at("/eingang/kopie/wortlaut").asText();
            }
        }
    }

    @BeforeEach
    void welt() {
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Ahrenberg IP-14') RETURNING id", UUID.class);
        unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name) VALUES (?,'Kunststoffwerk Ahrenberg') "
                + "RETURNING id", UUID.class, tenant);
        s1 = standort("ST-1", "Werk Ahrenberg");
        s2 = standort("ST-2", "Werk Lindach");
        benutzer("IK", "energiemanager", null);
        benutzer("JW", "kundenadministrator", null);
        benutzer("PH", "bearbeiter", s2);
        benutzer("MD", "bedienberechtigt", s1);
        benutzer("CB", "leser", s1);
        // EE-1 Spritzguss: MS-06 direkt am Werk Ahrenberg, MS-11 in Halle 2 (Gebäude am Werk Ahrenberg) — ein Standort.
        // EE-2 Montage: MS-11 und MS-30 (Werk Lindach) — zwei Standorte, sein Zaun ist das Unternehmen.
        UUID halle2 = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, "
                + "'gebaeude', 'Halle 2', 'G-2', 'aktiv') RETURNING id", UUID.class, tenant);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2020-01-01')", tenant, halle2, s1);
        UUID ms06 = messstelle("MS-06", s1, null);
        UUID ms11 = messstelle("MS-11", null, halle2);
        UUID ms30 = messstelle("MS-30", s2, null);
        ee1 = einsatz("EE-1", "Spritzguss", ms06, ms11);
        ee2 = einsatz("EE-2", "Montage", ms11, ms30);
        heute("2026-12-15");
    }

    @AfterEach
    void uhrZurueck() {
        dienst.uhrStellen(Clock.systemUTC());
    }

    // ------------------------------------------------------------------ R7

    @Test
    void r7VerweisAmEinsatzMitOrtSatzPruefsummeUndUeberpruefungZehnterNovember2029() throws Exception {
        var p = personen();
        platzhalter();
        JsonNode ref = referenz.get("D-0004");
        heute("2028-11-10");
        JsonNode d = ruf("POST", DOKUMENTE, "IK", Map.of("art", "betrieb", "titel", ref.path("titel").asText(),
                "bezug", Map.of("art", "energieeinsatz", "energieeinsatz_id", ee1.toString())), 201);
        String id = d.path("id").asText();
        assertThat(d.path("kennzeichen").asText()).isEqualTo("D-0004");
        // Der Zaun ist der Standort des Einsatzes — abgeleitet aus seinen Messstellen, nie aus der Anfrage.
        assertThat(d.at("/bezug/art").asText()).isEqualTo("energieeinsatz");
        assertThat(d.at("/bezug/energieeinsatz/kennzeichen").asText()).isEqualTo("EE-1");
        assertThat(d.at("/bezug/energieeinsatz/name").asText()).isEqualTo("Spritzguss");
        assertThat(d.at("/bezug/standort/kurzzeichen").asText()).isEqualTo("ST-1");
        assertThat(root.queryForObject("SELECT standort_id FROM energiemanagement_dokument WHERE id = ?::uuid",
                UUID.class, id)).isEqualTo(s1);

        JsonNode f = ref.at("/fassungen/0");
        ruf("POST", DOKUMENTE + "/" + id + "/fassungen", "IK", Map.of("form", "verweis", "verweis",
                JSON.convertValue(f.path("verweis"), Map.class)), 201);
        d = ruf("POST", DOKUMENTE + "/" + id + "/fassungen/1/freigeben", "IK", Map.of("entschieden_von",
                id(p.get("IK")), "begruendung", f.path("begruendung").asText()), 200);
        assertThat(d.at("/fassungen/0/pruefsumme").asText()).isEqualTo(f.path("pruefsumme").asText())
                .isEqualTo("sha256:bd330fe410c905c8bf7be395ade7d5e93e4bc9140fbd25c3d69c93186d403398");
        heute("2028-11-12");
        ruf("POST", DOKUMENTE + "/" + id + "/bekanntmachungen", "IK",
                Map.of("kreis", "Schichtführer und Instandhaltung Halle 1", "weg", "unterweisung"), 201);

        // Energieeinsätze › EE-1 Spritzguss › Nachweise am 12.02.2029.
        heute("2029-02-12");
        JsonNode n = ruf("GET", "/api/v1/energiemanagement/energieeinsaetze/" + ee1 + "/nachweise", "IK", null, 200);
        assertThat(n.at("/energieeinsatz/kennzeichen").asText()).isEqualTo("EE-1");
        assertThat(n.path("abruf").asText()).isEqualTo("2029-02-12");
        assertThat(n.path("nachweise")).hasSize(1);
        JsonNode x = n.at("/nachweise/0");
        assertThat(x.path("kennzeichen").asText()).isEqualTo("D-0004");
        assertThat(x.path("art_wort").asText()).isEqualTo("Betrieb und Instandhaltung");
        assertThat(x.path("klasse").asText()).isEqualTo("vorgabe");
        JsonNode ort = x.path("ort");
        assertThat(ort.path("ort_satz").asText()).isEqualTo("Geführt in Ihrem System: Instandhaltungssystem, Arbeitspläne");
        assertThat(ort.path("satz").asText()).isEqualTo("Geführt in Ihrem System: Instandhaltungssystem, Arbeitspläne "
                + "(IH-SG-01, Rev. 4 vom 03.11.2028).");
        assertThat(ort.path("inhalt_in_voltpilot").asBoolean()).isFalse();
        assertThat(ort.path("adresse_als_verweis").asBoolean()).isTrue();
        assertThat(ort.path("sha256").asText())
                .isEqualTo("f0570ce5f1d332e648fe404bfe958841213b08b91c17667c3b0cd28c6acd49f9");
        assertThat(ort.path("festgehalten_am").asText()).isEqualTo("2028-11-10");
        assertThat(x.at("/ueberpruefung/faellig_am").asText()).isEqualTo("2029-11-10");
        assertThat(x.path("bekanntmachungen")).hasSize(1);
        assertThat(x.at("/bekanntmachungen/0/satz").asText()).isEqualTo("Bekannt gemacht am 12.11.2028 an "
                + "Schichtführer und Instandhaltung Halle 1 über Unterweisung — eingetragen von Ines Kaltenbach.");
        // VoltPilot hält nur den Verweis — kein Inhalt, keine Datei.
        assertThat(root.queryForObject("SELECT wortlaut IS NULL FROM energiemanagement_dokument_fassung "
                + "WHERE dokument_id = ?::uuid", Boolean.class, id)).isTrue();
        // Kein Nachweis am anderen Einsatz.
        assertThat(ruf("GET", "/api/v1/energiemanagement/energieeinsaetze/" + ee2 + "/nachweise", "IK", null, 200)
                .path("nachweise")).isEmpty();

        // Verzeichnis-Gruppe „Betrieb, Auslegung und Beschaffung“: eine Zeile mit Ort-Satz und Browser-Prüfsumme.
        List<Map<String, Object>> betrieb = als("IK", () -> verzeichnis.zeilen(LocalDate.parse("2029-02-12"))).stream()
                .filter(z -> "betrieb_auslegung_beschaffung".equals(z.get("gruppe"))).toList();
        assertThat(betrieb).hasSize(1);
        assertThat(betrieb.get(0)).containsEntry("kennzeichen", "D-0004").containsEntry("gruppe_wort",
                "Betrieb, Auslegung und Beschaffung").containsEntry("ort_satz",
                "Geführt in Ihrem System: Instandhaltungssystem, Arbeitspläne").containsEntry("pruefsumme",
                "f0570ce5f1d332e648fe404bfe958841213b08b91c17667c3b0cd28c6acd49f9")
                .containsEntry("entschieden_von", "Ines Kaltenbach").containsEntry("tag", "2028-11-10");
    }

    // ------------------------------------------------------------------ R8

    @Test
    void r8KompetenzOhneUeberpruefungUndZweiBekanntmachungenAmZwoelftenFebruar2029() throws Exception {
        var p = personen();
        // D-0001 Energiepolitik: freigegeben am 15.12.2026 (Leitung), bekannt gemacht am 18.12.2026 über zwei Wege.
        String d1 = ruf("POST", DOKUMENTE, "IK", Map.of("art", "energiepolitik", "titel", "Energiepolitik", "bezug",
                Map.of("art", "unternehmen")), 201).path("id").asText();
        ruf("POST", DOKUMENTE + "/" + d1 + "/fassungen", "IK", Map.of("form", "wortlaut", "wortlaut", wortlautD0001),
                201);
        ruf("POST", DOKUMENTE + "/" + d1 + "/fassungen/1/freigeben", "IK", Map.of("entschieden_von", id(p.get("RF")),
                "begruendung", "Erste Fassung zum Start des Energiemanagements (01.10.2026)."), 200);
        heute("2026-12-18");
        for (String weg : List.of("aushang", "intranet")) {
            ruf("POST", DOKUMENTE + "/" + d1 + "/bekanntmachungen", "IK",
                    Map.of("kreis", "alle Mitarbeitenden beider Werke", "weg", weg), 201);
        }
        platzhalterAb(2);
        // D-0004 am EE-1 (R7), bekannt gemacht am 12.11.2028.
        heute("2028-01-25");
        String d4 = ruf("POST", DOKUMENTE, "IK", Map.of("art", "betrieb", "titel",
                "Kriterien für Betrieb und Instandhaltung — Spritzguss", "bezug", Map.of("art", "energieeinsatz",
                        "energieeinsatz_id", ee1.toString())), 201).path("id").asText();

        // D-0005: Kompetenz an Murat Demirci — ein Nachweis, ohne Überprüfung (DK5).
        JsonNode ref = referenz.get("D-0005");
        assertThat(code(DOKUMENTE, Map.of("art", "kompetenz", "titel", "X", "bezug", Map.of("art", "person",
                "person_id", id(p.get("MD"))), "ueberpruefung_monate", 12))).isEqualTo("angabe_ungueltig");
        JsonNode d = ruf("POST", DOKUMENTE, "IK", Map.of("art", "kompetenz", "titel", ref.path("titel").asText(),
                "bezug", Map.of("art", "person", "person_id", id(p.get("MD")))), 201);
        String d5 = d.path("id").asText();
        assertThat(d.path("kennzeichen").asText()).isEqualTo("D-0005");
        assertThat(d.path("ueberpruefung_monate").isNull()).isTrue();
        assertThat(d.at("/bezug/person/name").asText()).isEqualTo("Murat Demirci");
        assertThat(d.at("/bezug/standort").isNull()).isTrue();
        JsonNode f = ref.at("/fassungen/0");
        ruf("POST", DOKUMENTE + "/" + d5 + "/fassungen", "IK", Map.of("form", "verweis", "verweis",
                JSON.convertValue(f.path("verweis"), Map.class)), 201);
        d = ruf("POST", DOKUMENTE + "/" + d5 + "/fassungen/1/freigeben", "IK", Map.of("entschieden_von",
                id(p.get("IK")), "begruendung", f.path("begruendung").asText()), 200);
        assertThat(d.at("/fassungen/0/pruefsumme").asText()).isEqualTo(f.path("pruefsumme").asText())
                .isEqualTo("sha256:cbe2ea06eb958c2f0051ad928a6a7df547171ddcbceaf37b4565f811d65e7c4a");

        heute("2028-11-10");
        JsonNode f4 = referenz.get("D-0004").at("/fassungen/0");
        ruf("POST", DOKUMENTE + "/" + d4 + "/fassungen", "IK", Map.of("form", "verweis", "verweis",
                JSON.convertValue(f4.path("verweis"), Map.class)), 201);
        ruf("POST", DOKUMENTE + "/" + d4 + "/fassungen/1/freigeben", "IK", Map.of("entschieden_von", id(p.get("IK")),
                "begruendung", f4.path("begruendung").asText()), 200);
        heute("2028-11-12");
        ruf("POST", DOKUMENTE + "/" + d4 + "/bekanntmachungen", "IK",
                Map.of("kreis", "Schichtführer und Instandhaltung Halle 1", "weg", "unterweisung"), 201);

        heute("2029-02-12");
        // Die Seite der Person: der Kompetenz-Nachweis, geführt im Personalsystem, ohne Überprüfung.
        JsonNode n = ruf("GET", "/api/v1/energiemanagement/personen/" + id(p.get("MD")) + "/nachweise", "IK", null, 200);
        assertThat(n.at("/person/name").asText()).isEqualTo("Murat Demirci");
        assertThat(n.path("nachweise")).hasSize(1);
        JsonNode k = n.at("/nachweise/0");
        assertThat(k.path("kennzeichen").asText()).isEqualTo("D-0005");
        assertThat(k.path("klasse").asText()).isEqualTo("nachweis");
        assertThat(k.at("/ort/ort_satz").asText()).isEqualTo("Geführt in Ihrem System: Personalsystem, Unterweisungen");
        assertThat(k.at("/ort/satz").asText())
                .isEqualTo("Geführt in Ihrem System: Personalsystem, Unterweisungen (UW-2028-014 vom 24.01.2028).");
        assertThat(k.at("/ort/adresse_als_verweis").asBoolean()).isFalse();
        assertThat(k.at("/ueberpruefung/faellig_am").isNull()).isTrue();
        assertThat(k.at("/ueberpruefung/grund").asText()).isEqualTo("nachweis");

        // Zwei Kommunikationsnachweise am 12.02.2029 — Aushang und Intranet sind EINE Mitteilung.
        JsonNode b = ruf("GET", "/api/v1/energiemanagement/bekanntmachungen", "IK", null, 200);
        assertThat(b.path("bekanntmachungen")).hasSize(2);
        assertThat(werte(b.path("bekanntmachungen"), "kennzeichen")).containsExactly("D-0001", "D-0004");
        assertThat(b.at("/bekanntmachungen/0/wege").toString()).isEqualTo("[\"aushang\",\"intranet\"]");
        assertThat(b.at("/bekanntmachungen/0/satz").asText()).isEqualTo("Bekannt gemacht am 18.12.2026 an alle "
                + "Mitarbeitenden beider Werke über Aushang und Intranet — eingetragen von Ines Kaltenbach.");
        assertThat(b.at("/bekanntmachungen/1/am").asText()).isEqualTo("2028-11-12");
        assertThat(b.at("/bekanntmachungen/1/wege_wort").asText()).isEqualTo("Unterweisung");
        // Die Einträge bleiben je Weg einer; die Tabelle hat keinen „gesendet“- oder „gelesen“-Zustand.
        assertThat(root.queryForObject("SELECT count(*) FROM energiemanagement_dokument_eintrag WHERE tenant_id = ? "
                + "AND art = 'bekannt_gemacht'", Integer.class, tenant)).isEqualTo(3);

        // Verzeichnis-Gruppe „Kompetenz und Kommunikation“ (Katalog R3): D-0005 und die zwei Bekanntmachungen.
        List<Map<String, Object>> kk = als("IK", () -> verzeichnis.zeilen(LocalDate.parse("2029-02-12"))).stream()
                .filter(z -> "kompetenz_kommunikation".equals(z.get("gruppe"))).toList();
        assertThat(kk).hasSize(3);
        assertThat(kk.get(0)).containsEntry("kennzeichen", "D-0005").containsEntry("art", "kompetenz")
                .containsEntry("ort_satz", "Geführt in Ihrem System: Personalsystem, Unterweisungen")
                .containsEntry("gruppe_wort", "Kompetenz und Kommunikation").containsEntry("tag", "2028-01-25");
        assertThat(kk.subList(1, 3)).extracting(z -> z.get("art") + " " + z.get("kennzeichen") + " " + z.get("tag"))
                .containsExactly("bekanntmachung D-0001 2026-12-18", "bekanntmachung D-0004 2028-11-12");
    }

    // ------------------------------------------------------------------ Zaun, Aufgabe, Ablehnungen

    @Test
    void zaunUeberDenStandortDesEinsatzesUndAnPersonUndAufgabeNurUnternehmensweit() throws Exception {
        var p = personen();
        String am1 = ruf("POST", DOKUMENTE, "IK", Map.of("art", "auslegung", "titel", "Planung Kühlwasser Halle 2",
                "bezug", Map.of("art", "energieeinsatz", "energieeinsatz_id", ee1.toString())), 201).path("id").asText();
        JsonNode zwei = ruf("POST", DOKUMENTE, "IK", Map.of("art", "beschaffung", "titel", "Vorgabe Einkauf Montage",
                "bezug", Map.of("art", "energieeinsatz", "energieeinsatz_id", ee2.toString())), 201);
        // EE-2 hängt an zwei Standorten: das Dokument gilt am Unternehmen.
        assertThat(zwei.at("/bezug/standort").isNull()).isTrue();
        assertThat(zwei.at("/bezug/energieeinsatz/kennzeichen").asText()).isEqualTo("EE-2");
        UUID zuordnung = UUID.fromString(ruf("POST", "/api/v1/energiemanagement/aufgaben", "IK", Map.of("aufgabe",
                "energieteam", "person_id", id(p.get("MD")), "gilt_ab", "2026-10-01", "entschieden_von",
                id(p.get("RF")), "begruendung", "Schichtführer Halle 1 im Energieteam"), 201).path("id").asText());
        JsonNode ta = ruf("POST", DOKUMENTE, "IK", Map.of("art", "kompetenz", "titel", "Schulung Energieteam",
                "bezug", Map.of("art", "aufgabe", "aufgabe_id", zuordnung.toString())), 201);
        assertThat(ta.at("/bezug/aufgabe/wort").asText()).isEqualTo("Mitglied im Energieteam");
        assertThat(ta.at("/bezug/aufgabe/person/kuerzel").asText()).isEqualTo("MD");

        // Die Person sieht ihre Nachweise auch an ihren Aufgaben.
        JsonNode md = ruf("GET", "/api/v1/energiemanagement/personen/" + id(p.get("MD")) + "/nachweise", "IK", null,
                200);
        assertThat(werte(md.path("nachweise"), "titel")).containsExactly("Schulung Energieteam");

        // Murat Demirci (Bedienberechtigt am Werk Ahrenberg) sieht EE-1 und dessen Nachweis, nicht den am Unternehmen.
        JsonNode n = ruf("GET", "/api/v1/energiemanagement/energieeinsaetze/" + ee1 + "/nachweise", "MD", null, 200);
        assertThat(werte(n.path("nachweise"), "id")).containsExactly(am1);
        assertThat(werte(ruf("GET", DOKUMENTE, "MD", null, 200).path("dokumente"), "id")).containsExactly(am1);
        assertThat(ruf("GET", "/api/v1/energiemanagement/energieeinsaetze/" + ee2 + "/nachweise", "MD", null, 200)
                .path("nachweise")).isEmpty();
        // An Person und Aufgabe: nur unternehmensweit sichtbar — die Person ja, ihre Nachweise nicht.
        assertThat(ruf("GET", "/api/v1/energiemanagement/personen/" + id(p.get("MD")) + "/nachweise", "MD", null, 200)
                .path("nachweise")).isEmpty();
        assertThat(ruf("GET", "/api/v1/energiemanagement/bekanntmachungen", "MD", null, 200).path("bekanntmachungen"))
                .isEmpty();
        // Peter Hollerbach (Bearbeiter am Werk Lindach) sieht EE-1 nicht: 404, beim Anlegen wie ein unbekannter Einsatz.
        assertThat(ruf("GET", "/api/v1/energiemanagement/energieeinsaetze/" + ee1 + "/nachweise", "PH", null, 404)
                .path("code").asText()).isEqualTo("nicht_gefunden");
        assertThat(ruf("GET", DOKUMENTE + "/" + am1, "PH", null, 404).path("code").asText()).isEqualTo("nicht_gefunden");
        int vorher = dokumente();
        assertThat(ruf("POST", DOKUMENTE, "PH", Map.of("art", "betrieb", "titel", "X", "bezug", Map.of("art",
                "energieeinsatz", "energieeinsatz_id", ee1.toString())), 422).path("code").asText())
                .isEqualTo("energieeinsatz_unbekannt");
        // Recht: Bedienberechtigt hält nichts fest (403), Bearbeiter nichts am Unternehmen, an Person oder Aufgabe.
        assertThat(ruf("POST", DOKUMENTE, "MD", Map.of("art", "betrieb", "titel", "X", "bezug", Map.of("art",
                "energieeinsatz", "energieeinsatz_id", ee1.toString())), 403).path("code").asText())
                .isEqualTo("recht_fehlt");
        assertThat(ruf("POST", DOKUMENTE, "PH", Map.of("art", "kompetenz", "titel", "X", "bezug", Map.of("art",
                "person", "person_id", id(p.get("MD")))), 403).path("code").asText()).isEqualTo("recht_fehlt");
        assertThat(ruf("POST", DOKUMENTE, "PH", Map.of("art", "beschaffung", "titel", "X", "bezug", Map.of("art",
                "energieeinsatz", "energieeinsatz_id", ee2.toString())), 403).path("code").asText())
                .isEqualTo("recht_fehlt");
        assertThat(dokumente()).isEqualTo(vorher);
    }

    @Test
    void derSchreibwegNenntGenauDieKennungDesBezugsUndKeineUnbekannte() throws Exception {
        var p = personen();
        int vorher = dokumente();
        assertThat(code(DOKUMENTE, Map.of("art", "betrieb", "titel", "X", "bezug", Map.of("art", "energieeinsatz"))))
                .isEqualTo("energieeinsatz_unbekannt");
        assertThat(code(DOKUMENTE, Map.of("art", "betrieb", "titel", "X", "bezug", Map.of("art", "energieeinsatz",
                "energieeinsatz_id", UUID.randomUUID().toString())))).isEqualTo("energieeinsatz_unbekannt");
        // Den Standort eines Einsatzes leitet der Dienst ab — er kommt nie aus der Anfrage.
        assertThat(code(DOKUMENTE, Map.of("art", "betrieb", "titel", "X", "bezug", Map.of("art", "energieeinsatz",
                "energieeinsatz_id", ee2.toString(), "standort_id", s1.toString())))).isEqualTo("angabe_ungueltig");
        assertThat(code(DOKUMENTE, Map.of("art", "kompetenz", "titel", "X", "bezug", Map.of("art", "person"))))
                .isEqualTo("person_unbekannt");
        assertThat(code(DOKUMENTE, Map.of("art", "kompetenz", "titel", "X", "bezug", Map.of("art", "person",
                "person_id", UUID.randomUUID().toString())))).isEqualTo("person_unbekannt");
        assertThat(code(DOKUMENTE, Map.of("art", "kompetenz", "titel", "X", "bezug", Map.of("art", "person",
                "person_id", id(p.get("MD")), "aufgabe_id", UUID.randomUUID().toString())))).isEqualTo("angabe_ungueltig");
        assertThat(code(DOKUMENTE, Map.of("art", "kompetenz", "titel", "X", "bezug", Map.of("art", "aufgabe",
                "aufgabe_id", UUID.randomUUID().toString())))).isEqualTo("aufgabe_unbekannt");
        assertThat(code(DOKUMENTE, Map.of("art", "betrieb", "titel", "X", "bezug", Map.of("art", "unternehmen",
                "person_id", id(p.get("MD")))))).isEqualTo("angabe_ungueltig");
        assertThat(dokumente()).isEqualTo(vorher);
        // Unbekannte Person bzw. Einsatz im Pfad: 404, keine ID: 404.
        ruf("GET", "/api/v1/energiemanagement/personen/" + UUID.randomUUID() + "/nachweise", "IK", null, 404);
        ruf("GET", "/api/v1/energiemanagement/energieeinsaetze/" + UUID.randomUUID() + "/nachweise", "IK", null, 404);
        ruf("GET", "/api/v1/energiemanagement/energieeinsaetze/EE-1/nachweise", "IK", null, 404);
    }

    // ------------------------------------------------------------------ Hilfen

    /** Robert Falk (Leitung, ohne Konto), Ines Kaltenbach und Murat Demirci — wie die Referenzdatei 1.10. */
    private Map<String, JsonNode> personen() throws Exception {
        Map<String, JsonNode> p = new LinkedHashMap<>();
        p.put("RF", person("Robert Falk", "Geschäftsführer", "RF", null));
        p.put("IK", person("Ines Kaltenbach", "Energiemanagement", "IK", "IK"));
        p.put("MD", person("Murat Demirci", "Schichtführer Halle 1", "MD", "MD"));
        ruf("POST", "/api/v1/energiemanagement/aufgaben", "IK", Map.of("aufgabe", "unternehmensleitung",
                "person_id", id(p.get("RF")), "gilt_ab", "2026-10-01", "begruendung",
                "Geschäftsführer laut Handelsregister"), 201);
        return p;
    }

    /** D-0001 bis D-0003 als Entwürfe am Unternehmen, damit die Kennzeichen die der Referenzdatei sind. */
    private void platzhalter() throws Exception {
        platzhalterAb(1);
    }

    private void platzhalterAb(int nr) throws Exception {
        for (int i = nr; i <= 3; i++) {
            ruf("POST", DOKUMENTE, "IK", Map.of("art", "kontext", "titel", "Platzhalter " + i, "bezug",
                    Map.of("art", "unternehmen")), 201);
        }
    }

    private JsonNode person(String name, String funktion, String kuerzel, String konto) throws Exception {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("name", name);
        b.put("funktion", funktion);
        b.put("kuerzel", kuerzel);
        if (konto != null) b.put("konto_sub", konto);
        b.put("seit", "2026-10-01");
        return ruf("POST", "/api/v1/energiemanagement/personen", "IK", b, 201);
    }

    private static String id(JsonNode n) {
        return n.has("verlauf") && n.has("person") ? n.at("/person/id").asText() : n.path("id").asText();
    }

    private static List<String> werte(JsonNode liste, String feld) {
        List<String> w = new ArrayList<>();
        liste.forEach(e -> w.add(e.path(feld).asText()));
        return w;
    }

    private int dokumente() {
        return root.queryForObject("SELECT count(*) FROM energiemanagement_dokument WHERE tenant_id = ?", Integer.class,
                tenant);
    }

    private String code(String pfad, Object body) throws Exception {
        return ruf("POST", pfad, "IK", body, 422).path("code").asText();
    }

    private void heute(String tag) {
        dienst.uhrStellen(Clock.fixed(Instant.parse(tag + "T10:00:00Z"), ZoneOffset.UTC));
    }

    /** Die Verzeichnis-Quelle direkt (ihr Leser ist IP-8) — im Kontext, den {@code ZugriffFilter} aufbaut. */
    private <T> T als(String sub, Supplier<T> lesen) {
        Authentication auth = token(sub);
        SecurityContextHolder.getContext().setAuthentication(auth);
        TenantContext.set(tenant);
        try {
            ZugriffKontextLader.Ergebnis e = lader.laden(auth, null);
            assertThat(e.zugriff()).isNotNull();
            ZugriffContext.set(e.zugriff());
            return lesen.get();
        } finally {
            ZugriffContext.clear();
            TenantContext.clear();
            SecurityContextHolder.clearContext();
        }
    }

    private Authentication token(String sub) {
        Jwt jwt = Jwt.withTokenValue("test").header("alg", "none").subject(sub).issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600)).claim("tenant_id", tenant.toString())
                .claim("realm_access", Map.of("roles", List.of())).claim("name", NAMEN.get(sub)).build();
        return new KeycloakRealmRoleConverter().convert(jwt);
    }

    private JsonNode ruf(String method, String path, String sub, Object body, int status) throws Exception {
        var b = request(HttpMethod.valueOf(method), path).with(authentication(token(sub)));
        if (body != null) b.contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(body));
        var r = mvc.perform(b).andReturn().getResponse();
        assertThat(r.getStatus()).as(method + " " + path + " " + r.getContentAsString(StandardCharsets.UTF_8))
                .isEqualTo(status);
        String text = r.getContentAsString(StandardCharsets.UTF_8);
        return text.isBlank() ? JSON.createObjectNode() : JSON.readTree(text);
    }

    private UUID standort(String kurz, String name) {
        return root.queryForObject("INSERT INTO standort(tenant_id,unternehmen_id,name,kurzzeichen,zeitzone,zustand) "
                + "VALUES (?,?,?,?,'Europe/Berlin','aktiv') RETURNING id", UUID.class, tenant, unternehmen, name, kurz);
    }

    private UUID messstelle(String kennzeichen, UUID standort, UUID ort) {
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                + "'Zählerstand') RETURNING id", UUID.class, tenant, kennzeichen, kennzeichen);
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, ort_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, ?, '2020-01-01')", tenant, ms, ort, standort);
        return ms;
    }

    private UUID einsatz(String kennzeichen, String name, UUID... messstellen) {
        UUID prozess = root.queryForObject("INSERT INTO prozess (tenant_id, unternehmen_id, kennzeichen, name, "
                + "gueltig_ab) VALUES (?, ?, ?, ?, '2024-01-01') RETURNING id", UUID.class, tenant, unternehmen,
                "P-" + kennzeichen.substring(3), name);
        for (UUID ms : messstellen) {
            root.update("INSERT INTO messstelle_prozess (tenant_id, messstelle_id, prozess_id, gueltig_ab) "
                    + "VALUES (?, ?, ?, '2024-01-01')", tenant, ms, prozess);
        }
        return root.queryForObject("INSERT INTO energieeinsatz (tenant_id, kennzeichen, prozess_id, traeger, name, "
                + "gueltig_ab, actor_sub, actor_name, actor_art) VALUES (?, ?, ?, 'Strom', ?, '2026-10-01', 'IK', "
                + "'Ines Kaltenbach', 'kunde') RETURNING id", UUID.class, tenant, kennzeichen, prozess, name);
    }

    private void benutzer(String sub, String rolle, UUID standort) {
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,?,'benutzer',?,'aktiv')",
                tenant, sub, NAMEN.get(sub));
        root.update("INSERT INTO zugriff(tenant_id,benutzer_sub,rolle,standort_id,gueltig_ab,zeitzone) "
                + "VALUES (?,?,?,?,'2024-01-01','Europe/Berlin')", tenant, sub, rolle, standort);
    }
}
