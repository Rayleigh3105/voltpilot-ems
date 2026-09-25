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
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
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
 * UEMS AP-19 IP-18 (NW-2): das interne Audit über die echte HTTP-, Rechte- und RLS-Kette mit der App-Rolle — R9 des
 * Konzepts mit den Personen der Referenzdatei 1.10: AU-2029-0001, geplant am 10.01.2029 von Ines Kaltenbach,
 * durchgeführt am 22.01.2029 von Claudia Berger (Controlling, ohne Schreibrecht), ein Hinweis, die Feststellung
 * F-2029-0001, daraus M-2029-0002 (Herkunft {@code audit}, IP-17), abgeschlossen am 31.01.2029 mit dem unterschriebenen
 * Bericht als Verweis — die Kopie ist byte-gleich der Referenz ({@code 27a580b9…}); nächstes internes Audit fällig am
 * 22.01.2030.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class InternesAuditApiTest {
    private static final String AUDITS = "/api/v1/energiemanagement/audits";
    private static final String PERSONEN = "/api/v1/energiemanagement/personen";
    private static final String MASSNAHMEN = "/api/v1/massnahmen";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path VEKTOREN = Path.of("../../docs/contracts/v2/energiemanagement-vectors.json");
    private static final Map<String, String> NAMEN = Map.of("IK", "Ines Kaltenbach", "JW", "Jonas Wendlinger",
            "PH", "Peter Hollerbach", "CB", "Claudia Berger", "RF", "Robert Falk");
    private static final String HINWEIS = "Die Energiepolitik wurde im Dezember 2026 bekannt gemacht; wer seitdem "
            + "eingestellt wurde, lernt sie in der Einarbeitung nicht kennen.";
    private static final Map<String, Object> BERICHT = Map.of(
            "bezeichnung", "Bericht internes Audit 2029, unterschrieben",
            "ablage", "QM-Laufwerk, Ordner Energiemanagement/Audits", "kennung", "IA-2029",
            "sha256", "761d45606a2ed3511c91e2a61bf4ba3287dac583b70f43ead3f3d8716233fdeb");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "ip18_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "ip18_test_pw");
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> "http://127.0.0.1:9/realms/voltpilot");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri", () -> "http://127.0.0.1:9/certs");
    }

    @Autowired MockMvc mvc;
    @Autowired InternesAuditService dienst;
    @Autowired AuditVerzeichnis verzeichnis;
    @Autowired KennzahlService kennzahlen;
    @Autowired EnergiemanagementVerzeichnisService verzeichnisDienst;
    @Autowired ZugriffKontextLader lader;
    static JdbcTemplate root;
    UUID tenant, unternehmen, s1, s2;
    Map<String, String> person = new LinkedHashMap<>();

    @BeforeAll
    static void start() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void welt() throws Exception {
        uhr("2029-01-10T09:00:00Z");
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Ahrenberg IP-18') RETURNING id", UUID.class);
        unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name) VALUES (?,'Kunststoffwerk Ahrenberg') "
                + "RETURNING id", UUID.class, tenant);
        s1 = standort("ST-1");
        s2 = standort("ST-2");
        benutzer("IK", "energiemanager", null);
        benutzer("JW", "kundenadministrator", null);
        benutzer("PH", "bearbeiter", s2);
        benutzer("CB", "leser", s1);
        benutzer("RF", "einsicht", null);
        person.put("RF", personAnlegen("Robert Falk", "Geschäftsführer", "RF", null));
        person.put("IK", personAnlegen("Ines Kaltenbach", "Energiemanagement", "IK", "IK"));
        person.put("JW", personAnlegen("Jonas Wendlinger", "IT-Leitung", "JW", "JW"));
        person.put("CB", personAnlegen("Claudia Berger", "Controlling", "CB", "CB"));
    }

    @AfterEach
    void uhrZurueck() {
        dienst.uhrStellen(Clock.systemUTC());
        kennzahlen.uhrStellen(Clock.systemUTC());
        verzeichnisDienst.uhrStellen(Clock.systemUTC());
    }

    // ------------------------------------------------------------------ R9: geplant → durchgeführt → Hinweis → abgeschlossen

    @Test
    void r9GeplantDurchgefuehrtHinweisAbgeschlossenMitPruefsummeUndNaechstesAuditAm22012030() throws Exception {
        // Ohne Unabhängigkeit kein Audit (IA1) — und nichts geschrieben.
        Map<String, Object> ohne = plan();
        ohne.remove("unabhaengigkeit");
        JsonNode abgelehnt = ruf("POST", AUDITS, "IK", ohne, 422);
        assertThat(abgelehnt.path("code").asText()).isEqualTo("unabhaengigkeit_fehlt");
        assertThat(abgelehnt.path("feld").asText()).isEqualTo("unabhaengigkeit");
        assertThat(zeilen()).isZero();

        // Planen am 10.01.2029: AU-2029-0001, geplant, noch keine Frist (kein durchgeführtes Audit).
        JsonNode au = ruf("POST", AUDITS, "IK", plan(), 201);
        String id = au.at("/audit/id").asText();
        assertThat(au.at("/audit/kennzeichen").asText()).isEqualTo("AU-2029-0001");
        assertThat(au.at("/audit/zustand").asText()).isEqualTo("geplant");
        assertThat(au.at("/audit/auditoren/0/kuerzel").asText()).isEqualTo("CB");
        assertThat(au.at("/audit/verantwortlich/sub").asText()).isEqualTo("IK");
        assertThat(au.at("/verlauf/0/art").asText()).isEqualTo("audit_geplant");
        assertThat(au.at("/verlauf/0/akteur/name").asText()).isEqualTo("Ines Kaltenbach");
        JsonNode vorher = ruf("GET", AUDITS + "?tag=2029-01-10", "IK", null, 200);
        assertThat(vorher.at("/naechstes/grund").asText()).isEqualTo("kein_audit");
        assertThat(vorher.at("/naechstes/faellig_am").isNull()).isTrue();
        assertThat(ruf("POST", AUDITS + "/" + id + "/hinweise", "IK", hinweis(), 409).path("code").asText())
                .isEqualTo("audit_nicht_durchgefuehrt");

        // Durchgeführt am 22.01.2029 — nie in der Zukunft.
        uhr("2029-01-22T15:00:00Z");
        assertThat(ruf("POST", AUDITS + "/" + id + "/durchgefuehrt", "IK", Map.of("am", "2029-01-23"), 422)
                .path("code").asText()).isEqualTo("tag_in_zukunft");
        JsonNode durch = ruf("POST", AUDITS + "/" + id + "/durchgefuehrt", "IK", Map.of("am", "2029-01-22"), 200);
        assertThat(durch.at("/audit/zustand").asText()).isEqualTo("durchgefuehrt");
        assertThat(ruf("PUT", AUDITS + "/" + id, "IK", plan(), 409).path("code").asText())
                .isEqualTo("audit_nicht_geplant");

        // Hinweis 1: festgestellt von Claudia Berger (Leserin, schreibt nicht), eingetragen von Ines Kaltenbach.
        ruf("POST", AUDITS + "/" + id + "/hinweise", "CB", hinweis(), 403);
        JsonNode mitHinweis = ruf("POST", AUDITS + "/" + id + "/hinweise", "IK", hinweis(), 201);
        assertThat(mitHinweis.at("/hinweise/0/nr").asInt()).isEqualTo(1);
        assertThat(mitHinweis.at("/hinweise/0/am").asText()).isEqualTo("2029-01-22");
        assertThat(mitHinweis.at("/hinweise/0/festgestellt_von/name").asText()).isEqualTo("Claudia Berger");
        assertThat(mitHinweis.at("/hinweise/0/eingetragen/akteur/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(mitHinweis.at("/audit/hinweise").asInt()).isEqualTo(1);

        // F-2029-0001 mit Quelle „dieses Audit“ (ihre Routen baut IP-19) — hier als Zeile der Datenhaltung. Dann die
        // Maßnahmen über die AP-18-Route mit den Herkünften von IP-17: M-2029-0001 aus der Feststellung (R10),
        // M-2029-0002 aus dem Hinweis dieses Audits.
        feststellung(UUID.fromString(id));
        kennzahlen.uhrStellen(Clock.fixed(Instant.parse("2029-01-23T10:00:00Z"), ZoneOffset.UTC));
        assertThat(ruf("POST", MASSNAHMEN, "IK", massnahme("nichtkonformitaet", "F-2029-0001", "2029-04-22"), 201)
                .path("kennzeichen").asText()).isEqualTo("M-2029-0001");
        JsonNode ausHinweis = ruf("POST", MASSNAHMEN, "IK", massnahme("audit", "AU-2029-0001", "2029-06-30"), 201);
        assertThat(ausHinweis.path("kennzeichen").asText()).isEqualTo("M-2029-0002");
        assertThat(ausHinweis.at("/herkunft/kennung").asText()).isEqualTo("AU-2029-0001");
        uhr("2029-01-31T15:00:00Z");
        // Abschließen: Einsicht und Bearbeiter nie; ohne Bericht und Zusammenfassung 422; eine Maßnahme, die dieses
        // Audit nicht als Herkunft trägt (M-2029-0001 stammt aus der Feststellung), 422; ein unbekannter Hinweis 422.
        Map<String, Object> abschluss = new LinkedHashMap<>(Map.of("entschieden_von", person.get("IK"),
                "am", "2029-01-31", "bericht", BERICHT,
                "zusammenfassung", "Ein Hinweis, eine Feststellung; Bericht unterschrieben von Claudia Berger am 30.01.2029."));
        assertThat(ruf("POST", AUDITS + "/" + id + "/abschliessen", "RF", abschluss, 403).path("code").asText())
                .isEqualTo("recht_fehlt");
        ruf("POST", AUDITS + "/" + id + "/abschliessen", "PH", abschluss, 403);
        assertThat(ruf("POST", AUDITS + "/" + id + "/abschliessen", "IK",
                Map.of("entschieden_von", person.get("IK")), 422).path("code").asText())
                .isEqualTo("bericht_oder_zusammenfassung");
        Map<String, Object> falsch = new LinkedHashMap<>(abschluss);
        falsch.put("massnahmen", List.of(Map.of("hinweis", 1, "massnahme", "M-2029-0001")));
        assertThat(ruf("POST", AUDITS + "/" + id + "/abschliessen", "IK", falsch, 422).path("code").asText())
                .isEqualTo("massnahme_unbekannt");
        falsch.put("massnahmen", List.of(Map.of("hinweis", 2, "massnahme", "M-2029-0002")));
        assertThat(ruf("POST", AUDITS + "/" + id + "/abschliessen", "IK", falsch, 422).path("code").asText())
                .isEqualTo("hinweis_unbekannt");
        abschluss.put("massnahmen", List.of(Map.of("hinweis", 1, "massnahme", "M-2029-0002")));
        JsonNode zu = ruf("POST", AUDITS + "/" + id + "/abschliessen", "IK", abschluss, 200);
        assertThat(zu.at("/audit/zustand").asText()).isEqualTo("abgeschlossen");
        assertThat(zu.at("/audit/abschluss/entschieden_von/kuerzel").asText()).isEqualTo("IK");
        assertThat(zu.at("/audit/feststellungen/0").asText()).isEqualTo("F-2029-0001");

        // Die Kopie ist byte-gleich der Referenz und trägt die Prüfsumme des Vertrags (27a580b9…).
        JsonNode kopie = zu.at("/audit/abschluss/kopie");
        assertThat(kopie.at("/hinweise/0/festgestellt_von").asText()).isEqualTo("CB");
        assertThat(kopie.at("/hinweise/0/eingetragen_von").asText()).isEqualTo("IK");
        assertThat(kopie.at("/hinweise/0/massnahme").asText()).isEqualTo("M-2029-0002");
        JsonNode vektor = vektor("R9 AU-2029-0001 Abschluss: Prüfsumme der Kopie");
        String pruefsumme = zu.at("/audit/abschluss/pruefsumme").asText();
        assertThat(pruefsumme).isEqualTo(vektor.at("/erwartet/pruefsumme").asText())
                .isEqualTo("sha256:27a580b9761668e43f8cdc5afb66a4124f1394cb030a8629c8dc4f82a4d56701");
        assertThat(root.queryForObject("SELECT kopie FROM internes_audit WHERE id = ?", String.class, UUID.fromString(id)))
                .isEqualTo(vektor.at("/erwartet/kanonisch").asText());
        assertThat(root.queryForObject("SELECT pruefsumme = bericht_pruefsumme(kopie) FROM internes_audit WHERE id = ?",
                Boolean.class, UUID.fromString(id))).isTrue();

        // Danach unveränderlich: ein zweiter Abschluss, ein Hinweis, eine Absage — 409.
        assertThat(ruf("POST", AUDITS + "/" + id + "/abschliessen", "IK", abschluss, 409).path("code").asText())
                .isEqualTo("audit_nicht_durchgefuehrt");
        ruf("POST", AUDITS + "/" + id + "/hinweise", "IK", hinweis(), 409);
        ruf("POST", AUDITS + "/" + id + "/absagen", "IK", Map.of("begruendung", "Wird nicht mehr gebraucht."), 409);
        assertThat(werte(ruf("GET", AUDITS + "/" + id, "IK", null, 200).path("verlauf"), "art")).containsExactly(
                "audit_geplant", "audit_durchgefuehrt", "hinweis", "audit_abgeschlossen");

        // Auditprogramm am 12.02.2029: nächstes internes Audit fällig am 22.01.2030 (IA4, beim Abruf).
        JsonNode programm = ruf("GET", AUDITS + "?tag=2029-02-12", "IK", null, 200);
        assertThat(programm.at("/naechstes/faellig_am").asText()).isEqualTo("2030-01-22");
        assertThat(programm.at("/naechstes/basis").asText()).isEqualTo("2029-01-22");
        assertThat(programm.at("/naechstes/tage").asInt()).isEqualTo(-344);
        assertThat(programm.at("/naechstes/satz").asText()).isEqualTo("fällig in 344 Tagen");
        assertThat(programm.at("/naechstes/rhythmus_monate").asInt()).isEqualTo(12);

        // Einsicht liest das Programm unternehmensweit; die Leserin an ST-1 sieht ein Audit ohne Standort nicht.
        assertThat(ruf("GET", AUDITS, "RF", null, 200).path("audits")).hasSize(1);
        assertThat(ruf("GET", AUDITS, "CB", null, 200).path("audits")).isEmpty();
        ruf("GET", AUDITS + "/" + id, "CB", null, 404);

        // Verzeichnis-Quelle „Audits“: eine Zeile, Ort mit dem Bericht beim Kunden; vor dem Abschluss keine.
        List<Map<String, Object>> vz = alsIk(() -> verzeichnis.zeilen(java.time.LocalDate.parse("2029-02-12")));
        assertThat(vz).hasSize(1);
        assertThat(vz.get(0)).containsEntry("gruppe", "audits_feststellungen").containsEntry("art", "internes_audit")
                .containsEntry("kennzeichen", "AU-2029-0001").containsEntry("tag", "2029-01-31")
                .containsEntry("pruefsumme", pruefsumme).containsEntry("entschieden_von", "Ines Kaltenbach")
                .containsEntry("eingetragen_von", "Ines Kaltenbach")
                .containsEntry("gruppe_wort", "Interne Audits und Feststellungen")
                .containsEntry("ort_satz", "Wortlaut in VoltPilot, Original bei Ihnen: QM-Laufwerk, Ordner "
                        + "Energiemanagement/Audits");
        assertThat(alsIk(() -> verzeichnis.zeilen(java.time.LocalDate.parse("2029-01-30")))).isEmpty();
        // … und über den Leser von IP-8 (`GET …/verzeichnis`), der alle Quellen einsammelt.
        verzeichnisDienst.uhrStellen(Clock.fixed(Instant.parse("2029-02-12T08:00:00Z"), ZoneOffset.UTC));
        JsonNode gruppe = ruf("GET", "/api/v1/energiemanagement/verzeichnis?gruppe=audits_feststellungen", "IK", null,
                200).at("/gruppen/0");
        assertThat(gruppe.path("gruppe").asText()).isEqualTo("audits_feststellungen");
        assertThat(gruppe.path("satz").isNull()).isTrue();
        // Seit IP-19 steht auch die Feststellung F-2029-0001 in der Gruppe (R3: am 12.02.2029 zwei Zeilen).
        assertThat(werte(gruppe.path("zeilen"), "kennzeichen")).containsExactlyInAnyOrder("AU-2029-0001",
                "F-2029-0001");
        JsonNode auZeile = null;
        for (JsonNode z : gruppe.path("zeilen")) if (z.path("kennzeichen").asText().equals("AU-2029-0001")) auZeile = z;
        assertThat(auZeile.path("pruefsumme").asText()).isEqualTo(pruefsumme);
        assertThat(ruf("GET", "/api/v1/energiemanagement/verzeichnis?gruppe=audits_feststellungen", "CB", null, 200)
                .at("/gruppen/0/zeilen")).isEmpty();

        // „Wer ist wofür verantwortlich“: das Audit mit seinem Verantwortlichen (Konto) und Zustand.
        JsonNode verantwortung = ruf("GET", "/api/v1/energiemanagement/verantwortung?tag=2029-02-12", "IK", null, 200);
        JsonNode objekt = null;
        for (JsonNode o : verantwortung.path("objekte")) if (o.path("art").asText().equals("internes_audit")) objekt = o;
        assertThat(objekt).isNotNull();
        assertThat(objekt.path("kennzeichen").asText()).isEqualTo("AU-2029-0001");
        assertThat(objekt.at("/verantwortlich/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(objekt.path("zustand").asText()).isEqualTo("abgeschlossen");
    }

    // ------------------------------------------------------------------ Recht: 403 und nichts geschrieben

    @Test
    void ohneEnergiemanagementVerwaltenAmUnternehmen403AuchEinsichtUndNichtsGeschrieben() throws Exception {
        for (String wer : List.of("PH", "CB", "RF")) {
            assertThat(ruf("POST", AUDITS, wer, plan(), 403).path("code").asText()).as(wer).isEqualTo("recht_fehlt");
        }
        assertThat(zeilen()).isZero();
        String id = ruf("POST", AUDITS, "JW", plan(), 201).at("/audit/id").asText();
        int vorher = zeilen();
        for (String wer : List.of("PH", "CB", "RF")) {
            ruf("PUT", AUDITS + "/" + id, wer, plan(), 403);
            ruf("POST", AUDITS + "/" + id + "/durchgefuehrt", wer, Map.of("am", "2029-01-10"), 403);
            ruf("POST", AUDITS + "/" + id + "/hinweise", wer, hinweis(), 403);
            ruf("POST", AUDITS + "/" + id + "/abschliessen", wer, Map.of("entschieden_von", person.get("IK")), 403);
            ruf("POST", AUDITS + "/" + id + "/absagen", wer, Map.of("begruendung", "Termin fällt aus."), 403);
        }
        assertThat(zeilen()).isEqualTo(vorher);
    }

    // ------------------------------------------------------------------ Ändern, absagen, Ablehnungen

    @Test
    void geplantAendernMitBegruendungBeimTerminAbsagenEndgueltigUndAblehnungen() throws Exception {
        String id = ruf("POST", AUDITS, "IK", plan(), 201).at("/audit/id").asText();
        Map<String, Object> neu = plan();
        neu.put("termin", "2029-01-29");
        assertThat(ruf("PUT", AUDITS + "/" + id, "IK", neu, 422).path("code").asText()).isEqualTo("begruendung_fehlt");
        neu.put("begruendung", "Die Auditorin ist am 22.01. verhindert.");
        JsonNode geaendert = ruf("PUT", AUDITS + "/" + id, "IK", neu, 200);
        assertThat(geaendert.at("/audit/termin").asText()).isEqualTo("2029-01-29");
        assertThat(geaendert.at("/verlauf/1/art").asText()).isEqualTo("audit_geaendert");
        assertThat(geaendert.at("/verlauf/1/begruendung").asText()).isEqualTo("Die Auditorin ist am 22.01. verhindert.");
        // Unveränderter Stand schreibt nichts.
        neu.remove("begruendung");
        assertThat(ruf("PUT", AUDITS + "/" + id, "IK", neu, 200).path("verlauf")).hasSize(2);

        // Ablehnungen beim Planen.
        Map<String, Object> b = plan();
        b.put("auditor_ids", List.of());
        assertThat(ruf("POST", AUDITS, "IK", b, 422).path("code").asText()).isEqualTo("auditor_fehlt");
        b = plan();
        b.put("auditor_ids", List.of(UUID.randomUUID().toString()));
        assertThat(ruf("POST", AUDITS, "IK", b, 422).path("code").asText()).isEqualTo("person_unbekannt");
        b = plan();
        b.put("verantwortlich", "NIEMAND");
        assertThat(ruf("POST", AUDITS, "IK", b, 422).path("code").asText()).isEqualTo("konto_unbekannt");
        b = plan();
        b.remove("woran");
        assertThat(ruf("POST", AUDITS, "IK", b, 422).path("feld").asText()).isEqualTo("woran");
        b = plan();
        b.put("standort_ids", List.of(UUID.randomUUID().toString()));
        assertThat(ruf("POST", AUDITS, "IK", b, 422).path("code").asText()).isEqualTo("standort_unbekannt");
        b = plan();
        b.put("fremd", "x");
        assertThat(ruf("POST", AUDITS, "IK", b, 400).path("feld").asText()).isEqualTo("fremd");

        // Absagen: Begründung Pflicht, danach endgültig.
        assertThat(ruf("POST", AUDITS + "/" + id + "/absagen", "IK", Map.of("begruendung", "kurz"), 422)
                .path("code").asText()).isEqualTo("begruendung_fehlt");
        JsonNode abgesagt = ruf("POST", AUDITS + "/" + id + "/absagen", "IK",
                Map.of("begruendung", "Das Audit wird mit dem Herbsttermin zusammengelegt."), 200);
        assertThat(abgesagt.at("/audit/zustand").asText()).isEqualTo("abgesagt");
        ruf("POST", AUDITS + "/" + id + "/durchgefuehrt", "IK", Map.of("am", "2029-01-10"), 409);
        assertThat(ruf("GET", AUDITS + "/" + UUID.randomUUID(), "IK", null, 404).path("code").asText())
                .isEqualTo("nicht_gefunden");
        ruf("GET", AUDITS + "/keine-id", "IK", null, 404);
        // Ein abgesagtes Audit gibt keine Frist.
        assertThat(ruf("GET", AUDITS, "IK", null, 200).at("/naechstes/grund").asText()).isEqualTo("kein_audit");

        // Ein Audit an ST-1 sieht die Leserin dort; die Zeile ohne Standort nicht.
        Map<String, Object> amStandort = plan();
        amStandort.put("standort_ids", List.of(s1.toString()));
        ruf("POST", AUDITS, "IK", amStandort, 201);
        JsonNode cb = ruf("GET", AUDITS, "CB", null, 200);
        assertThat(werte(cb.path("audits"), "kennzeichen")).containsExactly("AU-2029-0002");
    }

    // ------------------------------------------------------------------ Hilfen

    private Map<String, Object> plan() {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("titel", "Internes Audit 2029: Bezugsbasen, Energieziele, Maßnahmen und Grundlagen");
        b.put("termin", "2029-01-22");
        b.put("auditor_ids", List.of(person.get("CB")));
        b.put("unabhaengigkeit", "Claudia Berger (Controlling) gehört nicht zum Energieteam und prüft keine eigene Arbeit.");
        b.put("was", "Bezugsbasen BB-0001 bis BB-0005, Energieziel EZ-2028-0001, Maßnahmen M-2028-0001 und M-2028-0002, "
                + "Energiepolitik D-0001, Anwendungsbereich D-0002, Aufgaben im Energiemanagement");
        b.put("woran", "Energiepolitik D-0001 Fassung 1, Anwendungsbereich D-0002 Fassung 1, Aufgaben im "
                + "Energiemanagement (Stand 22.01.2029)");
        b.put("verantwortlich", "IK");
        return b;
    }

    private static Map<String, Object> massnahme(String herkunft, String kennung, String termin) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("titel", "Einarbeitung um die Energiepolitik ergänzen");
        m.put("verantwortlich", "IK");
        m.put("termin", termin);
        m.put("herkunft", herkunft);
        m.put("herkunft_kennung", kennung);
        m.put("erwartete_wirkung_wortlaut", "Neue Mitarbeitende kennen die Energiepolitik.");
        return m;
    }

    private Map<String, Object> hinweis() {
        return Map.of("wortlaut", HINWEIS, "festgestellt_von", person.get("CB"));
    }

    private void feststellung(UUID audit) {
        root.update("INSERT INTO feststellung(tenant_id,quelle_art,audit_id,wortlaut,vorgabe_wortlaut,festgestellt_von,"
                + "festgestellt_am,verantwortlich_sub,verantwortlich_name,verantwortlich_konto,actor_sub,actor_name,"
                + "actor_rolle,actor_art,angelegt_am) VALUES (?,'internes_audit',?,'Wer die Bezugsbasen pflegt und "
                + "freigibt, ist nicht festgelegt.','Aufgaben im Energiemanagement',?::uuid,'2029-01-22','JW',"
                + "'Jonas Wendlinger','benutzer','IK','Ines Kaltenbach','energiemanager','kunde','2029-01-23 10:00+01')",
                tenant, audit, person.get("CB"));
    }

    private String personAnlegen(String name, String funktion, String kuerzel, String konto) throws Exception {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("name", name);
        b.put("funktion", funktion);
        b.put("kuerzel", kuerzel);
        if (konto != null) b.put("konto_sub", konto);
        return ruf("POST", PERSONEN, "IK", b, 201).at("/person/id").asText();
    }

    private void uhr(String instant) {
        dienst.uhrStellen(Clock.fixed(Instant.parse(instant), ZoneOffset.UTC));
    }

    private int zeilen() {
        return root.queryForObject("SELECT (SELECT count(*) FROM internes_audit WHERE tenant_id=?) + (SELECT count(*) "
                + "FROM internes_audit_eintrag WHERE tenant_id=?) + (SELECT count(*) FROM energiemanagement_aenderung "
                + "WHERE tenant_id=? AND objekt='internes_audit')", Integer.class, tenant, tenant, tenant);
    }

    private static List<String> werte(JsonNode liste, String feld) {
        List<String> w = new java.util.ArrayList<>();
        liste.forEach(e -> w.add(e.path(feld).asText()));
        return w;
    }

    private static JsonNode vektor(String name) throws Exception {
        for (JsonNode v : JSON.readTree(Files.readString(VEKTOREN)).path("cases")) {
            if (v.path("name").asText().equals(name)) return v;
        }
        throw new AssertionError("kein Vektor " + name);
    }

    /** Die Verzeichnis-Quelle direkt (ihr Leser ist IP-8) — im Kontext einer echten Anfrage von Ines Kaltenbach. */
    private <T> T alsIk(Supplier<T> lesen) {
        Authentication auth = token("IK");
        SecurityContextHolder.getContext().setAuthentication(auth);
        TenantContext.set(tenant);
        try {
            ZugriffKontextLader.Ergebnis e = lader.laden(auth, null);
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
        return JSON.readTree(r.getContentAsString(StandardCharsets.UTF_8));
    }

    private UUID standort(String k) {
        return root.queryForObject("INSERT INTO standort(tenant_id,unternehmen_id,name,kurzzeichen,zeitzone,zustand) "
                + "VALUES (?,?,?,?,'Europe/Berlin','aktiv') RETURNING id", UUID.class, tenant, unternehmen, k, k);
    }

    private void benutzer(String sub, String rolle, UUID standort) {
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,?,'benutzer',?,'aktiv')",
                tenant, sub, NAMEN.get(sub));
        root.update("INSERT INTO zugriff(tenant_id,benutzer_sub,rolle,standort_id,gueltig_ab,zeitzone) "
                + "VALUES (?,?,?,?,'2024-01-01','Europe/Berlin')", tenant, sub, rolle, standort);
    }
}
