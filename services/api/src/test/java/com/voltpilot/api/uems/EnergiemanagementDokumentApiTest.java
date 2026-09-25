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
import java.util.HashMap;
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
 * UEMS AP-19 IP-7 (NW-2): Dokumente über die echte HTTP-, Rechte- und RLS-Kette mit der App-Rolle — R1 (Energiepolitik
 * D-0001: Fassung 1 mit Prüfsumme, entschieden von Robert Falk ohne Konto, bekannt gemacht, „geprüft, bleibt“, am
 * 12.02.2029 seit 64 Tagen fällig) und R2 (Anwendungsbereich D-0002 deckungsgleich mit dem Betrachtungsumfang; Prüffall
 * nur Strom) mit den Personen und Wortlauten der Referenzdatei 1.10 und den Prüfsummen der Vektoren
 * ({@code energiemanagement-vectors.json}); dazu Leitungs-Pflicht (422), Vier-Augen (nicht der Urheber), Zaun über den
 * Bezug (404) und Recht (403). Die Uhr ist gestellt ({@code uhrStellen}).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class EnergiemanagementDokumentApiTest {
    private static final String DOKUMENTE = "/api/v1/energiemanagement/dokumente";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Map<String, String> NAMEN = Map.of("IK", "Ines Kaltenbach", "JW", "Jonas Wendlinger",
            "PH", "Peter Hollerbach", "CB", "Claudia Berger", "MD", "Murat Demirci", "RF", "Robert Falk");
    private static final Map<String, Object> ORIGINAL = Map.of(
            "bezeichnung", "Energiepolitik Fassung 1, unterschrieben",
            "ablage", "QM-Laufwerk, Ordner Energiemanagement/Politik", "kennung", "EP-2026",
            "sha256", "3f1f253d0c40224028a65d3cd9409b689463ff4feab3282db32f83252bf73b9b");
    private static final String FALK_SATZ = "Diese Fassung braucht eine Entscheidung der Leitung. Für die Aufgabe "
            + "‚Leitung des Unternehmens‘ ist keine Person festgelegt.";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "ip7_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "ip7_test_pw");
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> "http://127.0.0.1:9/realms/voltpilot");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri", () -> "http://127.0.0.1:9/certs");
    }

    @Autowired MockMvc mvc;
    @Autowired EnergiemanagementDokumentService dienst;
    @Autowired DokumentVerzeichnis verzeichnis;
    @Autowired ZugriffKontextLader lader;
    static JdbcTemplate root;
    static Map<String, JsonNode> kopien;
    UUID tenant, unternehmen, s1, s2;

    @BeforeAll
    static void start() throws Exception {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        // Die Kopien der Referenzdatei 1.10 mit ihren Prüfsummen — die Vektoren des Vertrags (IP-2).
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
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Ahrenberg IP-7') RETURNING id", UUID.class);
        unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name) VALUES (?,'Kunststoffwerk Ahrenberg') "
                + "RETURNING id", UUID.class, tenant);
        s1 = standort("ST-1", "Werk Ahrenberg");
        s2 = standort("ST-2", "Werk Lindach");
        benutzer("IK", "energiemanager", null);
        benutzer("JW", "kundenadministrator", null);
        benutzer("PH", "bearbeiter", s2);
        benutzer("MD", "bedienberechtigt", s1);
        benutzer("CB", "leser", s1);
        heute("2026-12-15");
    }

    @AfterEach
    void uhrZurueck() {
        dienst.uhrStellen(Clock.systemUTC());
    }

    // ------------------------------------------------------------------ R1

    @Test
    void r1EnergiepolitikFassungEinsMitPruefsummeGeprueftBleibtUndVierundsechzigTage() throws Exception {
        var p = personenMitLeitung();
        JsonNode d = ruf("POST", DOKUMENTE, "IK", Map.of("art", "energiepolitik", "titel", "Energiepolitik",
                "bezug", Map.of("art", "unternehmen"), "beleg", ORIGINAL), 201);
        String id = d.path("id").asText();
        assertThat(d.path("kennzeichen").asText()).isEqualTo("D-0001");
        assertThat(d.path("zustand").asText()).isEqualTo("entwurf");
        assertThat(d.path("ueberpruefung_monate").asInt()).isEqualTo(12);
        assertThat(d.at("/ueberpruefung/grund").asText()).isEqualTo("keine_fassung");
        assertThat(d.at("/beleg/ablage").asText()).isEqualTo("QM-Laufwerk, Ordner Energiemanagement/Politik");

        JsonNode vektor = kopien.get("D-0001");
        String wortlaut = vektor.at("/eingang/kopie/wortlaut").asText();
        d = ruf("POST", DOKUMENTE + "/" + id + "/fassungen", "IK", Map.of("form", "wortlaut", "wortlaut", wortlaut), 201);
        assertThat(d.at("/fassungen/0/status").asText()).isEqualTo("entwurf");
        assertThat(d.at("/fassungen/0/pruefsumme").isNull()).isTrue();

        d = ruf("POST", DOKUMENTE + "/" + id + "/fassungen/1/freigeben", "IK", Map.of("entschieden_von",
                id(p.get("RF")), "begruendung", "Erste Fassung zum Start des Energiemanagements (01.10.2026)."), 200);
        assertThat(d.path("zustand").asText()).isEqualTo("gueltig");
        assertThat(d.path("gueltige_fassung").asInt()).isEqualTo(1);
        JsonNode f1 = d.at("/fassungen/0");
        assertThat(f1.path("status").asText()).isEqualTo("freigegeben");
        assertThat(f1.path("pruefsumme").asText()).isEqualTo(vektor.at("/erwartet/pruefsumme").asText())
                .isEqualTo("sha256:163ae8360abb4f614f4fb4b37a7e983dff1f42e548b7f10c64890fdde68b09bb");
        assertThat(f1.at("/entschieden_von/kuerzel").asText()).isEqualTo("RF");
        assertThat(f1.at("/entschieden_von/mit_konto").asBoolean()).isFalse();
        assertThat(f1.path("entschieden_am").asText()).isEqualTo("2026-12-15");
        assertThat(f1.at("/freigabe/akteur/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(f1.path("vieraugen").asBoolean()).isFalse();
        assertThat(d.at("/saetze/kopf").asText()).isEqualTo("Energiepolitik D-0001 · Fassung 1 · freigegeben am "
                + "15.12.2026 · entschieden von Robert Falk (Geschäftsführer) · eingetragen von Ines Kaltenbach.");
        assertThat(d.at("/ueberpruefung/faellig_am").asText()).isEqualTo("2027-12-15");
        // Die Kopie ist die kanonische Form des Vertrags — die Datenbank hält dieselbe Prüfsumme (keine Datei).
        assertThat(root.queryForObject("SELECT kopie FROM energiemanagement_dokument_fassung WHERE tenant_id = ?",
                String.class, tenant)).isEqualTo(vektor.at("/erwartet/kanonisch").asText());

        // 18.12.2026: bekannt gemacht über Aushang und Intranet — ein Eintrag je Weg, die Person ist IK (ihr Konto).
        heute("2026-12-18");
        for (String weg : List.of("aushang", "intranet")) {
            ruf("POST", DOKUMENTE + "/" + id + "/bekanntmachungen", "IK",
                    Map.of("kreis", "alle Mitarbeitenden beider Werke", "weg", weg), 201);
        }
        heute("2027-12-09");
        d = ruf("GET", DOKUMENTE + "/" + id, "IK", null, 200);
        assertThat(werte(d.path("eintraege"), "art")).containsExactly("bekannt_gemacht", "bekannt_gemacht");
        assertThat(d.at("/eintraege/0/person/kuerzel").asText()).isEqualTo("IK");
        assertThat(d.at("/eintraege/0/am").asText()).isEqualTo("2026-12-18");
        assertThat(d.at("/ueberpruefung/tage").asInt()).isEqualTo(-6);
        assertThat(d.at("/ueberpruefung/satz").asText()).isEqualTo("fällig in 6 Tagen");

        // 10.12.2027: „geprüft, bleibt“ verschiebt die Überprüfung auf den 10.12.2028.
        heute("2027-12-10");
        d = ruf("POST", DOKUMENTE + "/" + id + "/geprueft", "IK", Map.of("entschieden_von", id(p.get("RF")),
                "begruendung", "Mit der Jahresplanung 2028 durchgesehen; die Politik gilt unverändert."), 200);
        assertThat(d.at("/ueberpruefung/faellig_am").asText()).isEqualTo("2028-12-10");
        assertThat(d.at("/ueberpruefung/basis").asText()).isEqualTo("2027-12-10");
        assertThat(d.at("/eintraege/2/satz").asText()).isEqualTo("Geprüft, bleibt — entschieden von Robert Falk am "
                + "10.12.2027: ‚Mit der Jahresplanung 2028 durchgesehen; die Politik gilt unverändert.‘");

        // 12.02.2029 (Datum gestellt): seit 64 Tagen fällig — beim Abruf, ohne Läufer.
        heute("2029-02-12");
        d = ruf("GET", DOKUMENTE + "/" + id, "IK", null, 200);
        assertThat(d.at("/ueberpruefung/tage").asInt()).isEqualTo(64);
        assertThat(d.at("/ueberpruefung/satz").asText()).isEqualTo("seit 64 Tagen fällig");
        assertThat(d.at("/saetze/ueberpruefung").asText()).isEqualTo("Überprüfung fällig seit 64 Tagen.");
        JsonNode liste = ruf("GET", DOKUMENTE, "IK", null, 200);
        assertThat(liste.at("/dokumente/0/ueberpruefung/tage").asInt()).isEqualTo(64);
        // Verzeichnis-Quelle (VZ1, R3): die Fassung mit Person, Tag, Prüfsumme und Ort; zwei Bekanntmachungen.
        List<Map<String, Object>> zeilen = als("IK", () -> verzeichnis.zeilen(LocalDate.parse("2029-02-12")));
        assertThat(zeilen).hasSize(3);
        assertThat(zeilen.get(0)).containsEntry("gruppe", "grundlagen").containsEntry("art", "energiepolitik")
                .containsEntry("kennzeichen", "D-0001").containsEntry("nr", 1)
                .containsEntry("entschieden_von", "Robert Falk").containsEntry("eingetragen_von", "Ines Kaltenbach")
                .containsEntry("tag", "2026-12-15").containsEntry("pruefsumme", f1.path("pruefsumme").asText())
                .containsEntry("ort_satz", "Wortlaut in VoltPilot, Original bei Ihnen: QM-Laufwerk, Ordner "
                        + "Energiemanagement/Politik");
        assertThat(zeilen.get(1)).containsEntry("gruppe", "kompetenz_kommunikation")
                .containsEntry("art", "bekanntmachung").containsEntry("eingetragen_von", "Ines Kaltenbach")
                .containsEntry("tag", "2026-12-18").containsEntry("ort_satz", "in VoltPilot")
                .containsEntry("titel", "Energiepolitik: bekannt gemacht an alle Mitarbeitenden beider Werke");
        assertThat(als("IK", () -> verzeichnis.zeilen(LocalDate.parse("2026-12-14")))).isEmpty();

        // Fassung 2 (B3, 20.03.2029) löst Fassung 1 ab; Fassung 1 bleibt mit ihrer Prüfsumme lesbar (DK4).
        heute("2029-03-20");
        JsonNode ohne = ruf("POST", DOKUMENTE + "/" + id + "/fassungen", "IK", Map.of("form", "wortlaut",
                "wortlaut", wortlaut + " Wir beziehen die Druckluft ein."), 422);
        assertThat(ohne.path("code").asText()).isEqualTo("begruendung_fehlt");
        ruf("POST", DOKUMENTE + "/" + id + "/fassungen", "IK", Map.of("form", "wortlaut", "wortlaut",
                wortlaut + " Wir beziehen die Druckluft ein.", "begruendung", "Beschluss B3 der Managementbewertung 2028.",
                "beschluss_kennung", "BR-2029-0001/B3"), 201);
        d = ruf("POST", DOKUMENTE + "/" + id + "/fassungen/2/freigeben", "IK", Map.of("entschieden_von",
                id(p.get("RF")), "begruendung", "Beschluss B3 der Managementbewertung 2028."), 200);
        assertThat(werte(d.path("fassungen"), "status")).containsExactly("abgeloest", "freigegeben");
        assertThat(d.at("/fassungen/0/pruefsumme").asText()).isEqualTo(f1.path("pruefsumme").asText());
        assertThat(d.path("gueltige_fassung").asInt()).isEqualTo(2);
        assertThat(d.at("/ueberpruefung/faellig_am").asText()).isEqualTo("2030-03-20");
        assertThat(werte(d.path("verlauf"), "art")).containsExactly("dokument_angelegt", "fassung_entworfen",
                "fassung_freigegeben", "dokument_gueltig", "bekannt_gemacht", "bekannt_gemacht", "geprueft_bleibt",
                "fassung_entworfen", "fassung_freigegeben", "fassung_abgeloest");
    }

    // ------------------------------------------------------------------ R2

    @Test
    void r2AnwendungsbereichDeckungsgleichMitDemBetrachtungsumfang() throws Exception {
        var p = personenMitLeitung();
        String id = anwendungsbereich(p);
        // Ohne Betrachtungsumfang: kein Vergleich, kein Satz.
        JsonNode v = ruf("GET", DOKUMENTE + "/" + id + "/vergleich", "IK", null, 200);
        assertThat(v.path("vergleich").isNull()).isTrue();
        assertThat(v.path("saetze")).isEmpty();
        assertThat(v.at("/anwendungsbereich/traeger").toString()).isEqualTo("[\"Strom\",\"Gas\"]");

        umfang("{Strom,Gas}");
        int umfaenge = root.queryForObject("SELECT count(*) FROM bewertung_umfang WHERE tenant_id = ?", Integer.class,
                tenant);
        v = ruf("GET", DOKUMENTE + "/" + id + "/vergleich", "IK", null, 200);
        assertThat(v.at("/vergleich/deckungsgleich").asBoolean()).isTrue();
        assertThat(v.at("/betrachtungsumfang/fassung").asInt()).isEqualTo(1);
        assertThat(werte(v.at("/betrachtungsumfang/standorte"), "kurzzeichen")).containsExactlyInAnyOrder("ST-1", "ST-2");
        assertThat(v.path("saetze")).hasSize(1);
        assertThat(v.at("/saetze/0").asText()).isEqualTo("Der Betrachtungsumfang der energetischen Bewertung "
                + "(Fassung 1, ab 04.11.2026) umfasst dieselben Standorte und Energieträger.");
        // Der Vergleich ist ein Leser: er ändert weder den Umfang noch den Anwendungsbereich (Invariante 1).
        assertThat(root.queryForObject("SELECT count(*) FROM bewertung_umfang WHERE tenant_id = ?", Integer.class,
                tenant)).isEqualTo(umfaenge);
        // Nur am Anwendungsbereich.
        JsonNode politik = ruf("POST", DOKUMENTE, "IK", Map.of("art", "energiepolitik", "titel", "Energiepolitik",
                "bezug", Map.of("art", "unternehmen")), 201);
        ruf("GET", DOKUMENTE + "/" + politik.path("id").asText() + "/vergleich", "IK", null, 404);
    }

    @Test
    void r2PrueffallNurStromGasGehoertZumAnwendungsbereichAberNichtZumBetrachtungsumfang() throws Exception {
        var p = personenMitLeitung();
        String id = anwendungsbereich(p);
        umfang("{Strom}");
        // Der Leser von Werk Ahrenberg sieht den Anwendungsbereich am Unternehmen nicht (Zaun über den Bezug).
        ruf("GET", DOKUMENTE + "/" + id + "/vergleich", "CB", null, 404);
        JsonNode v = ruf("GET", DOKUMENTE + "/" + id + "/vergleich", "IK", null, 200);
        assertThat(v.at("/vergleich/deckungsgleich").asBoolean()).isFalse();
        assertThat(v.at("/vergleich/traeger_nur_im_anwendungsbereich").toString()).isEqualTo("[\"Gas\"]");
        assertThat(v.at("/vergleich/traeger_nur_im_betrachtungsumfang")).isEmpty();
        assertThat(v.at("/vergleich/standorte_nur_im_anwendungsbereich")).isEmpty();
        assertThat(v.path("saetze")).hasSize(1);
        assertThat(v.at("/saetze/0").asText()).isEqualTo("Gas gehört zum Anwendungsbereich, aber nicht zum "
                + "Betrachtungsumfang der energetischen Bewertung (Fassung 1).");
    }

    // ------------------------------------------------------------------ Leitungs-Pflicht (DK3, PA3)

    @Test
    void ohneLeitung422LeitungFehltUndNichtsGeschrieben() throws Exception {
        JsonNode rf = person("Robert Falk", "Geschäftsführer", "RF", null);
        JsonNode ik = person("Ines Kaltenbach", "Energiemanagement", "IK", "IK");
        String id = ruf("POST", DOKUMENTE, "IK", Map.of("art", "energiepolitik", "titel", "Energiepolitik",
                "bezug", Map.of("art", "unternehmen")), 201).path("id").asText();
        ruf("POST", DOKUMENTE + "/" + id + "/fassungen", "IK", Map.of("form", "wortlaut", "wortlaut", "Wir sparen."), 201);
        assertThat(ruf("GET", DOKUMENTE + "/" + id, "IK", null, 200).at("/saetze/freigabe_gesperrt").asText())
                .isEqualTo(FALK_SATZ);
        int vorher = protokoll();
        JsonNode a = ruf("POST", DOKUMENTE + "/" + id + "/fassungen/1/freigeben", "IK", entscheid(rf), 422);
        assertThat(a.path("code").asText()).isEqualTo("leitung_fehlt");
        assertThat(a.path("message").asText()).isEqualTo(FALK_SATZ);
        assertThat(protokoll()).isEqualTo(vorher);
        assertThat(root.queryForObject("SELECT freigabe_status FROM energiemanagement_dokument_fassung "
                + "WHERE tenant_id = ?", String.class, tenant)).isEqualTo("entwurf");

        // Mit Leitung ab 01.10.2026: eine andere Person 422, ein Tag vor der Leitung 422, die Leitung am Tag 200.
        ruf("POST", "/api/v1/energiemanagement/aufgaben", "IK", Map.of("aufgabe", "unternehmensleitung",
                "person_id", id(rf), "gilt_ab", "2026-10-01", "begruendung", "Geschäftsführer laut Handelsregister"), 201);
        assertThat(ruf("GET", DOKUMENTE + "/" + id, "IK", null, 200).at("/saetze/freigabe_gesperrt").isNull()).isTrue();
        a = ruf("POST", DOKUMENTE + "/" + id + "/fassungen/1/freigeben", "IK", entscheid(ik), 422);
        assertThat(a.path("code").asText()).isEqualTo("leitung_fehlt");
        assertThat(a.path("message").asText()).isEqualTo("Über Energiepolitik entscheidet die Leitung des Unternehmens.");
        Map<String, Object> vorDerLeitung = new LinkedHashMap<>(entscheid(rf));
        vorDerLeitung.put("entschieden_am", "2026-09-30");
        assertThat(ruf("POST", DOKUMENTE + "/" + id + "/fassungen/1/freigeben", "IK", vorDerLeitung, 422)
                .path("message").asText()).isEqualTo(FALK_SATZ);
        assertThat(protokoll()).isEqualTo(vorher);
        ruf("POST", DOKUMENTE + "/" + id + "/fassungen/1/freigeben", "IK", entscheid(rf), 200);
        // Ein Tag in der Zukunft wird nicht festgehalten.
        Map<String, Object> morgen = new LinkedHashMap<>(entscheid(rf));
        morgen.put("am", "2026-12-16");
        morgen.remove("entschieden_am");
        assertThat(ruf("POST", DOKUMENTE + "/" + id + "/geprueft", "IK", morgen, 422).path("code").asText())
                .isEqualTo("tag_in_der_zukunft");
        // Ohne Leitungs-Pflicht (Vorgehen) entscheidet jede Person im Energiemanagement.
        String verfahren = ruf("POST", DOKUMENTE, "IK", Map.of("art", "verfahren", "titel", "Vorgehen Messplanung",
                "bezug", Map.of("art", "unternehmen")), 201).path("id").asText();
        ruf("POST", DOKUMENTE + "/" + verfahren + "/fassungen", "IK", Map.of("form", "wortlaut", "wortlaut", "So."), 201);
        ruf("POST", DOKUMENTE + "/" + verfahren + "/fassungen/1/freigeben", "IK", entscheid(ik), 200);
    }

    // ------------------------------------------------------------------ Vier-Augen (DK3)

    @Test
    void vierAugenBeantragtDieErstePersonUndEntscheidetNieDerUrheber() throws Exception {
        JsonNode ik = person("Ines Kaltenbach", "Energiemanagement", "IK", "IK");
        String id = ruf("POST", DOKUMENTE, "IK", Map.of("art", "verfahren", "titel", "Vorgehen Messplanung",
                "bezug", Map.of("art", "unternehmen")), 201).path("id").asText();
        ruf("POST", DOKUMENTE + "/" + id + "/fassungen", "IK", Map.of("form", "wortlaut", "wortlaut", "Fassung 1."), 201);
        assertThat(ruf("POST", DOKUMENTE + "/" + id + "/fassungen/1/beantragen", "IK", entscheid(ik), 409)
                .path("code").asText()).isEqualTo("vieraugen_aus");

        root.update("UPDATE unternehmen SET vieraugen_freigabe = true WHERE id = ?", unternehmen);
        assertThat(ruf("POST", DOKUMENTE + "/" + id + "/fassungen/1/freigeben", "IK", entscheid(ik), 409)
                .path("code").asText()).isEqualTo("vieraugen_beantragen");
        JsonNode d = ruf("POST", DOKUMENTE + "/" + id + "/fassungen/1/beantragen", "IK", entscheid(ik), 200);
        assertThat(d.at("/fassungen/0/status").asText()).isEqualTo("beantragt");
        assertThat(d.at("/fassungen/0/pruefsumme").asText()).startsWith("sha256:");
        assertThat(d.path("zustand").asText()).isEqualTo("entwurf");
        // Solange der Antrag offen ist, entsteht kein neuer Entwurf.
        assertThat(ruf("POST", DOKUMENTE + "/" + id + "/fassungen", "IK", Map.of("form", "wortlaut", "wortlaut", "X"),
                409).path("code").asText()).isEqualTo("fassung_beantragt");
        // Die Urheberin entscheidet nicht — weder freigeben noch ablehnen.
        int vorher = protokoll();
        assertThat(ruf("POST", DOKUMENTE + "/" + id + "/fassungen/1/freigeben", "IK", Map.of(), 422)
                .path("code").asText()).isEqualTo("vieraugen_urheber");
        assertThat(ruf("POST", DOKUMENTE + "/" + id + "/fassungen/1/ablehnen", "IK",
                Map.of("begruendung", "Bitte noch einmal durchsehen."), 422).path("code").asText())
                .isEqualTo("vieraugen_urheber");
        assertThat(protokoll()).isEqualTo(vorher);
        // Die zweite Person bestätigt; „entschieden von“ steht schon im Antrag.
        assertThat(ruf("POST", DOKUMENTE + "/" + id + "/fassungen/1/freigeben", "JW", entscheid(ik), 422)
                .path("code").asText()).isEqualTo("angabe_ungueltig");
        d = ruf("POST", DOKUMENTE + "/" + id + "/fassungen/1/freigeben", "JW", Map.of(), 200);
        assertThat(d.path("zustand").asText()).isEqualTo("gueltig");
        assertThat(d.at("/fassungen/0/status").asText()).isEqualTo("freigegeben");
        assertThat(d.at("/fassungen/0/vieraugen").asBoolean()).isTrue();
        assertThat(d.at("/fassungen/0/freigabe/akteur/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(d.at("/fassungen/0/zweite_person/akteur/name").asText()).isEqualTo("Jonas Wendlinger");
        assertThat(d.at("/fassungen/0/entschieden_von/kuerzel").asText()).isEqualTo("IK");

        // Fassung 2: die zweite Person lehnt ab (Begründung Pflicht); danach ist Fassung 3 möglich, 1 gilt weiter.
        ruf("POST", DOKUMENTE + "/" + id + "/fassungen", "IK", Map.of("form", "wortlaut", "wortlaut", "Fassung 2.",
                "begruendung", "Neue Messpunkte in Halle 2."), 201);
        ruf("POST", DOKUMENTE + "/" + id + "/fassungen/2/beantragen", "IK", entscheid(ik), 200);
        assertThat(ruf("POST", DOKUMENTE + "/" + id + "/fassungen/2/ablehnen", "JW", Map.of(), 422)
                .path("code").asText()).isEqualTo("begruendung_fehlt");
        d = ruf("POST", DOKUMENTE + "/" + id + "/fassungen/2/ablehnen", "JW",
                Map.of("begruendung", "Halle 2 ist noch nicht in Betrieb."), 200);
        assertThat(werte(d.path("fassungen"), "status")).containsExactly("freigegeben", "abgelehnt");
        assertThat(d.at("/fassungen/1/ablehnung_begruendung").asText()).isEqualTo("Halle 2 ist noch nicht in Betrieb.");
        assertThat(d.path("gueltige_fassung").asInt()).isEqualTo(1);
        assertThat(ruf("POST", DOKUMENTE + "/" + id + "/fassungen/2/freigeben", "JW", Map.of(), 409)
                .path("code").asText()).isEqualTo("fassung_abgelehnt");
        ruf("POST", DOKUMENTE + "/" + id + "/fassungen", "IK", Map.of("form", "wortlaut", "wortlaut", "Fassung 3.",
                "begruendung", "Halle 2 ab dem 01.03.2027 in Betrieb."), 201);
    }

    // ------------------------------------------------------------------ Zaun über den Bezug (404) und Recht (403)

    @Test
    void zaunUeberDenStandortDesBezugs404UndOhneRecht403UndNichtsGeschrieben() throws Exception {
        JsonNode ik = person("Ines Kaltenbach", "Energiemanagement", "IK", "IK");
        person("Peter Hollerbach", "Standortleiter Werk Lindach", "PH", "PH");
        String amUnternehmen = ruf("POST", DOKUMENTE, "IK", Map.of("art", "verfahren", "titel", "Vorgehen",
                "bezug", Map.of("art", "unternehmen")), 201).path("id").asText();
        String anSt1 = ruf("POST", DOKUMENTE, "IK", Map.of("art", "betrieb", "titel", "Betrieb Werk Ahrenberg",
                "bezug", Map.of("art", "standort", "standort_id", s1.toString())), 201).path("id").asText();
        // Der Bearbeiter von Werk Lindach legt an seinem Standort an (Zelle S) …
        JsonNode anSt2 = ruf("POST", DOKUMENTE, "PH", Map.of("art", "betrieb", "titel", "Betrieb Werk Lindach",
                "bezug", Map.of("art", "standort", "standort_id", s2.toString())), 201);
        assertThat(anSt2.at("/bezug/standort/name").asText()).isEqualTo("Werk Lindach");
        String st2 = anSt2.path("id").asText();
        ruf("POST", DOKUMENTE + "/" + st2 + "/fassungen", "PH", Map.of("form", "verweis", "verweis",
                Map.of("ablage", "Instandhaltungssystem Lindach")), 201);
        // … aber nicht am Unternehmen (403) und nicht an Werk Ahrenberg (unbekannt wie ein fremder Standort).
        assertThat(ruf("POST", DOKUMENTE, "PH", Map.of("art", "verfahren", "titel", "X",
                "bezug", Map.of("art", "unternehmen")), 403).path("code").asText()).isEqualTo("recht_fehlt");
        assertThat(ruf("POST", DOKUMENTE, "PH", Map.of("art", "betrieb", "titel", "X",
                "bezug", Map.of("art", "standort", "standort_id", s1.toString())), 422).path("code").asText())
                .isEqualTo("standort_unbekannt");
        // Er sieht nur Werk Lindach; alles andere ist 404 — lesend wie schreibend.
        assertThat(werte(ruf("GET", DOKUMENTE, "PH", null, 200).path("dokumente"), "kennzeichen"))
                .containsExactly("D-0003");
        int vorher = protokoll();
        for (String fremd : List.of(amUnternehmen, anSt1)) {
            ruf("GET", DOKUMENTE + "/" + fremd, "PH", null, 404);
            ruf("POST", DOKUMENTE + "/" + fremd + "/fassungen", "PH", Map.of("form", "wortlaut", "wortlaut", "X"), 404);
            ruf("POST", DOKUMENTE + "/" + fremd + "/bekanntmachungen", "PH", Map.of("kreis", "alle", "weg",
                    "aushang"), 404);
        }
        // Freigeben darf er auch an seinem Standort nicht (KA/EM); der Kundenadministrator schon.
        ruf("POST", DOKUMENTE + "/" + st2 + "/fassungen/1/freigeben", "PH", entscheid(ik), 403);
        assertThat(protokoll()).isEqualTo(vorher);
        ruf("POST", DOKUMENTE + "/" + st2 + "/fassungen/1/freigeben", "JW", entscheid(ik), 200);
        assertThat(werte(JSON.valueToTree(als("PH", () -> verzeichnis.zeilen(LocalDate.parse("2026-12-15")))),
                "kennzeichen")).containsExactly("D-0003");

        // Leser, Bedienberechtigter und „Einsicht“: jede Schreibroute 403 recht_fehlt, nichts geschrieben.
        benutzer("RF", "einsicht", null);
        vorher = protokoll();
        int dokumente = root.queryForObject("SELECT count(*) FROM energiemanagement_dokument WHERE tenant_id = ?",
                Integer.class, tenant);
        List<Object[]> wege = new ArrayList<>();
        wege.add(new Object[] {DOKUMENTE, "energiemanagement.verwalten"});
        wege.add(new Object[] {DOKUMENTE + "/" + st2 + "/fassungen", "energiemanagement.verwalten"});
        wege.add(new Object[] {DOKUMENTE + "/" + st2 + "/bekanntmachungen", "energiemanagement.verwalten"});
        for (String w : List.of("fassungen/1/beantragen", "fassungen/1/freigeben", "fassungen/1/ablehnen", "geprueft",
                "aufheben")) {
            wege.add(new Object[] {DOKUMENTE + "/" + st2 + "/" + w, "energiemanagement.freigeben"});
        }
        for (String wer : List.of("CB", "MD", "RF")) {
            for (Object[] w : wege) {
                JsonNode a = ruf("POST", (String) w[0], wer, Map.of(), 403);
                assertThat(a.path("code").asText()).as(wer + " " + w[0]).isEqualTo("recht_fehlt");
                assertThat(a.path("recht").asText()).as(wer + " " + w[0]).isEqualTo(w[1]);
            }
        }
        assertThat(protokoll()).isEqualTo(vorher);
        assertThat(root.queryForObject("SELECT count(*) FROM energiemanagement_dokument WHERE tenant_id = ?",
                Integer.class, tenant)).isEqualTo(dokumente);
        // „Einsicht“ liest unternehmensweit; der Leser von Werk Ahrenberg sieht nur dessen Dokument.
        assertThat(werte(ruf("GET", DOKUMENTE, "RF", null, 200).path("dokumente"), "kennzeichen"))
                .containsExactly("D-0001", "D-0002", "D-0003");
        ruf("GET", DOKUMENTE + "/" + amUnternehmen, "RF", null, 200);
        assertThat(werte(ruf("GET", DOKUMENTE, "CB", null, 200).path("dokumente"), "kennzeichen"))
                .containsExactly("D-0002");
    }

    // ------------------------------------------------------------------ Ablehnungen, Verweis, Aufheben (DK2, DK5, DK8)

    @Test
    void verweisMitPruefsummeJedeAblehnungUndAufhebenLaesstLesbar() throws Exception {
        JsonNode ik = person("Ines Kaltenbach", "Energiemanagement", "IK", "IK");
        // Mandant nie aus dem Körper; eine unbekannte Angabe ist 400.
        assertThat(ruf("POST", DOKUMENTE, "IK", Map.of("art", "betrieb", "titel", "X", "bezug",
                Map.of("art", "unternehmen"), "tenant_id", UUID.randomUUID().toString()), 400).path("feld").asText())
                .isEqualTo("tenant_id");
        assertThat(code(DOKUMENTE, Map.of("art", "sonstiges", "titel", "X", "bezug", Map.of("art", "unternehmen"))))
                .isEqualTo("art_unbekannt");
        assertThat(code(DOKUMENTE, Map.of("art", "betrieb", "titel", " ", "bezug", Map.of("art", "unternehmen"))))
                .isEqualTo("titel_fehlt");
        assertThat(code(DOKUMENTE, Map.of("art", "betrieb", "titel", "X", "bezug", Map.of("art", "energieeinsatz"))))
                .isEqualTo("bezug_nicht_verfuegbar");
        assertThat(code(DOKUMENTE, Map.of("art", "kompetenz", "titel", "X", "bezug", Map.of("art", "unternehmen"),
                "ueberpruefung_monate", 12))).isEqualTo("angabe_ungueltig");
        assertThat(code(DOKUMENTE, Map.of("art", "betrieb", "titel", "X", "bezug", Map.of("art", "unternehmen"),
                "ueberpruefung_monate", 61))).isEqualTo("angabe_ungueltig");

        // R7-Verweis (Arbeitsplan IH-SG-01) — Kopie mit allen sieben Teilen, Prüfsumme wie der Vektor D-0004/1.
        JsonNode vektor = kopien.get("D-0004");
        String id = ruf("POST", DOKUMENTE, "IK", Map.of("art", "betrieb", "titel", "Kriterien für Betrieb und "
                + "Instandhaltung — Spritzguss", "bezug", Map.of("art", "unternehmen")), 201).path("id").asText();
        String fassungen = DOKUMENTE + "/" + id + "/fassungen";
        assertThat(code(fassungen, Map.of("form", "wortlaut"))).isEqualTo("wortlaut_fehlt");
        assertThat(code(fassungen, Map.of("form", "verweis", "verweis", Map.of("kennung", "IH-SG-01"))))
                .isEqualTo("ablage_fehlt");
        assertThat(code(fassungen, Map.of("form", "datei"))).isEqualTo("form_unbekannt");
        assertThat(code(fassungen, Map.of("form", "wortlaut", "wortlaut", "X", "anwendungsbereich",
                Map.of("standort_ids", List.of(s1.toString()), "traeger", List.of("Strom"))))).isEqualTo("angabe_ungueltig");
        // Ein offener Entwurf wird überschrieben (200, dieselbe Nr.).
        ruf("POST", fassungen, "IK", Map.of("form", "wortlaut", "wortlaut", "Vorläufig."), 201);
        JsonNode d = ruf("POST", fassungen, "IK", Map.of("form", "verweis", "verweis",
                JSON.convertValue(vektor.at("/eingang/kopie/verweis"), Map.class)), 200);
        assertThat(d.path("fassungen")).hasSize(1);
        assertThat(d.at("/fassungen/0/verweis/kennung").asText()).isEqualTo("IH-SG-01");
        assertThat(ruf("POST", DOKUMENTE + "/" + id + "/geprueft", "IK", entscheid(ik), 409).path("code").asText())
                .isEqualTo("dokument_nicht_gueltig");
        d = ruf("POST", fassungen + "/1/freigeben", "IK", entscheid(ik), 200);
        assertThat(d.at("/fassungen/0/pruefsumme").asText()).isEqualTo(vektor.at("/erwartet/pruefsumme").asText());
        // Im Verzeichnis: der Ort ist das System des Kunden, die Prüfsumme die im Browser gebildete (R3, G1).
        var zeile = als("IK", () -> verzeichnis.zeilen(LocalDate.parse("2026-12-15"))).get(0);
        assertThat(zeile).containsEntry("gruppe", "betrieb_auslegung_beschaffung")
                .containsEntry("ort_satz", "Geführt in Ihrem System: Instandhaltungssystem, Arbeitspläne")
                .containsEntry("pruefsumme", vektor.at("/eingang/kopie/verweis/sha256").asText());
        assertThat(ruf("POST", fassungen + "/1/freigeben", "IK", entscheid(ik), 409).path("code").asText())
                .isEqualTo("fassung_freigegeben");
        ruf("POST", fassungen + "/9/freigeben", "IK", entscheid(ik), 404);
        assertThat(code(DOKUMENTE + "/" + id + "/bekanntmachungen", Map.of("kreis", "Schichtführer", "weg",
                "weiterer"))).isEqualTo("wortlaut_fehlt");
        assertThat(code(DOKUMENTE + "/" + id + "/bekanntmachungen", Map.of("kreis", "Schichtführer", "weg", "brief")))
                .isEqualTo("weg_unbekannt");

        // Ein Nachweis (Kompetenz) hat keine Überprüfung.
        String kompetenz = ruf("POST", DOKUMENTE, "IK", Map.of("art", "kompetenz", "titel", "Unterweisung "
                + "Zeitschaltung", "bezug", Map.of("art", "unternehmen")), 201).path("id").asText();
        ruf("POST", DOKUMENTE + "/" + kompetenz + "/fassungen", "IK", Map.of("form", "verweis", "verweis",
                Map.of("ablage", "Personalsystem", "kennung", "UW-2028-014")), 201);
        d = ruf("POST", DOKUMENTE + "/" + kompetenz + "/fassungen/1/freigeben", "IK", entscheid(ik), 200);
        assertThat(d.at("/ueberpruefung/grund").asText()).isEqualTo("nachweis");
        assertThat(d.path("ueberpruefung_monate").isNull()).isTrue();
        assertThat(code(DOKUMENTE + "/" + kompetenz + "/geprueft", entscheid(ik))).isEqualTo("keine_ueberpruefung");

        // Aufheben: Tag und Begründung; das Dokument bleibt mit Fassung und Prüfsumme lesbar, ändert sich nicht mehr.
        d = ruf("POST", DOKUMENTE + "/" + id + "/aufheben", "IK", entscheid(ik), 200);
        assertThat(d.path("zustand").asText()).isEqualTo("aufgehoben");
        assertThat(d.path("ueberpruefung").isNull()).isTrue();
        assertThat(d.at("/fassungen/0/pruefsumme").asText()).isEqualTo(vektor.at("/erwartet/pruefsumme").asText());
        assertThat(werte(d.path("eintraege"), "art")).containsExactly("aufgehoben");
        assertThat(ruf("POST", DOKUMENTE + "/" + id + "/aufheben", "IK", entscheid(ik), 409).path("code").asText())
                .isEqualTo("dokument_aufgehoben");
        assertThat(ruf("POST", fassungen, "IK", Map.of("form", "wortlaut", "wortlaut", "X", "begruendung",
                "Noch eine Fassung?"), 409).path("code").asText()).isEqualTo("dokument_aufgehoben");
        assertThat(werte(ruf("GET", DOKUMENTE, "IK", null, 200).path("dokumente"), "zustand"))
                .containsExactly("aufgehoben", "gueltig");
    }

    // ------------------------------------------------------------------ Hilfen

    /** Robert Falk (ohne Konto, Leitung ab 01.10.2026) und Ines Kaltenbach (mit Konto) — Referenzdatei 1.10. */
    private Map<String, JsonNode> personenMitLeitung() throws Exception {
        Map<String, JsonNode> p = new LinkedHashMap<>();
        p.put("RF", person("Robert Falk", "Geschäftsführer", "RF", null));
        p.put("IK", person("Ines Kaltenbach", "Energiemanagement", "IK", "IK"));
        ruf("POST", "/api/v1/energiemanagement/aufgaben", "IK", Map.of("aufgabe", "unternehmensleitung",
                "person_id", id(p.get("RF")), "gilt_ab", "2026-10-01", "begruendung",
                "Geschäftsführer laut Handelsregister"), 201);
        return p;
    }

    /** R2: D-0002 Fassung 1 — Werk Ahrenberg und Werk Lindach, Strom und Gas, keine Ausschlüsse; Prüfsumme 583a847c. */
    private String anwendungsbereich(Map<String, JsonNode> p) throws Exception {
        String id = ruf("POST", DOKUMENTE, "IK", Map.of("art", "anwendungsbereich", "titel",
                "Anwendungsbereich des Energiemanagements", "bezug", Map.of("art", "unternehmen")), 201)
                .path("id").asText();
        JsonNode vektor = kopien.get("D-0002");
        String wortlaut = vektor.at("/eingang/kopie/wortlaut").asText();
        assertThat(code(DOKUMENTE + "/" + id + "/fassungen", Map.of("form", "wortlaut", "wortlaut", wortlaut)))
                .isEqualTo("anwendungsbereich_fehlt");
        assertThat(code(DOKUMENTE + "/" + id + "/fassungen", Map.of("form", "wortlaut", "wortlaut", wortlaut,
                "anwendungsbereich", Map.of("standort_ids", List.of(s1.toString()), "traeger", List.of("Erdgas")))))
                .isEqualTo("traeger_unbekannt");
        ruf("POST", DOKUMENTE + "/" + id + "/fassungen", "IK", Map.of("form", "wortlaut", "wortlaut", wortlaut,
                "anwendungsbereich", Map.of("standort_ids", List.of(s1.toString(), s2.toString()),
                        "traeger", List.of("Strom", "Gas"), "ausschluesse", List.of())), 201);
        JsonNode d = ruf("POST", DOKUMENTE + "/" + id + "/fassungen/1/freigeben", "IK", Map.of("entschieden_von",
                id(p.get("RF")), "begruendung", "Erste Fassung zum Start des Energiemanagements."), 200);
        assertThat(d.path("kennzeichen").asText()).isEqualTo("D-0001");
        assertThat(d.at("/fassungen/0/pruefsumme").asText()).isEqualTo(vektor.at("/erwartet/pruefsumme").asText())
                .isEqualTo("sha256:583a847c7af4b4a29d4517d2acf77468413a95fa38778ba1159ed280c363ecf4");
        assertThat(werte(d.at("/fassungen/0/anwendungsbereich/standorte"), "name"))
                .containsExactly("Werk Ahrenberg", "Werk Lindach");
        return id;
    }

    /** AP-16 U1: der Betrachtungsumfang Fassung 1 ab 04.11.2026 an beiden Werken mit den genannten Trägern. */
    private void umfang(String traeger) {
        UUID u = root.queryForObject("INSERT INTO bewertung_umfang (tenant_id, unternehmen_id, fassung, gueltig_ab, "
                + "traeger, begruendung, actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, ?, 1, '2026-11-04', "
                + "?::text[], 'Erster Betrachtungsumfang der energetischen Bewertung.', 'IK', 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde') RETURNING id", UUID.class, tenant, unternehmen, traeger);
        for (UUID s : List.of(s1, s2)) {
            root.update("INSERT INTO bewertung_umfang_standort (tenant_id, umfang_id, standort_id) VALUES (?, ?, ?)",
                    tenant, u, s);
        }
    }

    private Map<String, Object> entscheid(JsonNode person) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("entschieden_von", id(person));
        e.put("begruendung", "In der Besprechung am selben Tag entschieden.");
        return e;
    }

    /** Der Ablehnungs-Code einer 422 (IK schreibt). */
    private String code(String pfad, Object body) throws Exception {
        var b = request(HttpMethod.POST, pfad).with(authentication(token("IK")))
                .contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(body));
        var r = mvc.perform(b).andReturn().getResponse();
        assertThat(r.getStatus()).as(pfad + " " + r.getContentAsString(StandardCharsets.UTF_8)).isEqualTo(422);
        return JSON.readTree(r.getContentAsString(StandardCharsets.UTF_8)).path("code").asText();
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

    /** Das Feld je Element einer Liste — nie die gleichnamigen Felder darin. */
    private static List<String> werte(JsonNode liste, String feld) {
        List<String> w = new ArrayList<>();
        liste.forEach(e -> w.add(e.path(feld).asText()));
        return w;
    }

    /** Protokoll-Zeilen und Einträge der Dokumente — ohne Person und Aufgabe. */
    private int protokoll() {
        return root.queryForObject("SELECT (SELECT count(*) FROM energiemanagement_aenderung WHERE tenant_id = ? "
                + "AND objekt = 'dokument') "
                + "+ (SELECT count(*) FROM energiemanagement_dokument_eintrag WHERE tenant_id = ?)", Integer.class,
                tenant, tenant);
    }

    private void heute(String tag) {
        dienst.uhrStellen(Clock.fixed(Instant.parse(tag + "T10:00:00Z"), ZoneOffset.UTC));
    }

    /**
     * Die Verzeichnis-Quelle direkt (ihr Leser ist IP-8) — im Kontext, den {@code ZugriffFilter} einer echten Anfrage
     * aufbaut: Anmeldung, Mandant, Zugriff (Muster {@code EnergiemanagementVerantwortungApiTest}).
     */
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

    private void benutzer(String sub, String rolle, UUID standort) {
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,?,'benutzer',?,'aktiv')",
                tenant, sub, NAMEN.get(sub));
        root.update("INSERT INTO zugriff(tenant_id,benutzer_sub,rolle,standort_id,gueltig_ab,zeitzone) "
                + "VALUES (?,?,?,?,'2024-01-01','Europe/Berlin')", tenant, sub, rolle, standort);
    }
}
