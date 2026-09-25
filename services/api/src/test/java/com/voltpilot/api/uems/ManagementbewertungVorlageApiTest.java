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
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.springframework.jdbc.core.ConnectionCallback;
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
 * UEMS AP-19 IP-22 (MG1–MG3, NW-2): die Vorlage {@code managementbewertung} über die echte HTTP-, Rechte- und RLS-Kette mit
 * der App-Rolle — R13 des Konzepts: am 12.02.2029 legt Ines Kaltenbach die Managementbewertung für 2028 an; der Entwurf
 * zitiert die Eingaben als Stände und Zustände aus der Referenzdatei (EZ-2028-0001 verfehlt −2,7 % in 11 von 12 Monaten,
 * M-2028-0001 belegt −2,4 %, M-2028-0002 nicht messbar, keine offene Abweichung, der Leistungsvergleich +12,9 % schlechter
 * mit offenem Anstoß K-2028-0001, die Bewertung seit 80 Tagen zur Überprüfung fällig, eine offene Feststellung, acht fällige
 * Zeilen der Wiedervorlage) — jede mit der Prüfsumme der Datei, keine Quelle mit Kennzahl-Werten. Dazu Rechte
 * {@code energiemanagement.*} („Einsicht“ liest und lädt das PDF, legt nicht an, bekommt keinen CSV), das PDF mit den
 * zwölf Abschnitten und die Probe mit der echten {@link BerichtKaskade}: eine Korrektur trifft den Leistungsvergleich,
 * nie die Managementbewertung. Die Welt ist die von IP-21 ({@link EnergiemanagementWiedervorlageApiTest}) plus die
 * Leistungs-Eingaben 1.9 der Referenzdatei, direkt geschrieben.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class ManagementbewertungVorlageApiTest {
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
        r.add("spring.datasource.password", () -> "ip22_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "ip22_test_pw");
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
    @Autowired BerichtService berichte;
    @Autowired BerichtAbzugBildung bildung;
    @Autowired EnergiemanagementVerzeichnisService verzeichnis;
    static JdbcTemplate root;
    static Map<String, JsonNode> kopien;
    static JsonNode referenz;
    UUID tenant, unternehmen, s1, s2, g2, bz1;
    Map<String, String> person = new LinkedHashMap<>();

    @BeforeAll
    static void start() throws Exception {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        referenz = JSON.readTree(Path.of("../../docs/contracts/v2/uems-referenzunternehmen.json").toFile());
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
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Ahrenberg IP-22') RETURNING id", UUID.class);
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
                audits::uhrStellen, feststellungen::uhrStellen, kennzahlen::uhrStellen, berichte::uhrStellen,
                verzeichnis::uhrStellen)) {
            dienst.accept(Clock.systemUTC());
        }
    }

    // ------------------------------------------------------------------ R13

    @Test
    void r13DieEingabenSindStaendeUndZustaendeDerReferenzdateiUndKeineKaskadeTrifftDieVorlage() throws Exception {
        r12Welt();
        r13Welt();
        abruf("2029-02-12T13:00:00Z");
        berichte.uhrStellen(Clock.fixed(Instant.parse("2029-02-12T13:00:00Z"), ZoneOffset.UTC));

        // MG1: „Einsicht“ legt nicht an; Ines legt an — Unternehmen × Jahr, BR-JJJJ-nnnn im Jahr des Anlegens.
        Map<String, Object> anlegen = Map.of("vorlage", "managementbewertung", "geltung_id", unternehmen.toString(),
                "zeitraum", "2028");
        assertThat(ruf("POST", "/api/v1/berichte", "RF", anlegen, 403).path("code").asText()).isEqualTo("recht_fehlt");
        JsonNode b = ruf("POST", "/api/v1/berichte", "IK", anlegen, 201);
        assertThat(b.path("kennung").asText()).isEqualTo("BR-2029-0001");
        assertThat(b.path("vorlage").asText()).isEqualTo("managementbewertung");
        assertThat(ruf("POST", "/api/v1/berichte", "IK", anlegen, 409).path("code").asText())
                .isEqualTo("bericht_gibt_es_schon");
        assertThat(ruf("POST", "/api/v1/berichte", "IK", Map.of("vorlage", "managementbewertung", "geltung_id",
                unternehmen.toString(), "zeitraum", "2028-12"), 400).path("code").asText()).isNotBlank();

        JsonNode entwurf = ruf("/api/v1/berichte/BR-2029-0001/entwurf", "IK", 200);
        JsonNode a = entwurf.path("abzug");
        JsonNode mb = referenz.at("/managementbewertungen/0/staende/0/abzug/eingaben");
        List<String> abschnitte = new ArrayList<>();
        a.fieldNames().forEachRemaining(abschnitte::add);
        // Der Abzug ist kanonisch (Schlüssel sortiert): er trägt genau Kopf und die zwölf Abschnitte der Vorlage (MG2).
        List<String> soll = new ArrayList<>(List.of("kopf"));
        soll.addAll(BerichtRegeln.vorlage("managementbewertung").abschnitte());
        assertThat(BerichtRegeln.vorlage("managementbewertung").abschnitte()).containsExactly("vorige_beschluesse",
                "grundlagen", "energieziele", "energieleistung", "massnahmen", "abweichungen", "audits_feststellungen",
                "bewertung_messplanung", "wiedervorlage", "beschluesse", "sitzung", "quellenverzeichnis");
        assertThat(abschnitte).containsExactlyInAnyOrderElementsOf(soll);
        assertThat(a.at("/kopf/vorlage").asText()).isEqualTo("managementbewertung");
        assertThat(a.at("/kopf/stichtag").asText()).isEqualTo("2029-02-12");
        assertThat(a.at("/kopf/verantwortung").asText()).startsWith("Inhalte und Entscheidungen Ihres Energiemanagements");

        // Keine frühere Managementbewertung — Sitzung und Beschlüsse trägt IP-23.
        assertThat(a.at("/vorige_beschluesse/satz").asText()).isEqualTo(mb.path("vorige_beschluesse").asText());
        assertThat(a.path("beschluesse")).isEmpty();
        assertThat(a.path("sitzung").isNull()).isTrue();

        // Grundlagen: D-0001/D-0002 mit Fassung, „entschieden von“ und Überprüfung; Risiken und Chancen leer.
        JsonNode politik = a.at("/grundlagen/energiepolitik/0");
        assertThat(politik.path("dokument").asText()).isEqualTo(mb.at("/grundlagen/energiepolitik/dokument").asText());
        assertThat(politik.path("fassung").asInt()).isEqualTo(mb.at("/grundlagen/energiepolitik/fassung").asInt());
        assertThat(politik.path("entschieden_am").asText())
                .isEqualTo(mb.at("/grundlagen/energiepolitik/freigegeben_am").asText());
        assertThat(politik.path("entschieden_von").asText()).isEqualTo("Robert Falk");
        assertThat(politik.at("/ueberpruefung/satz").asText())
                .isEqualTo(mb.at("/grundlagen/energiepolitik/ueberpruefung").asText());
        assertThat(politik.path("pruefsumme").asText()).startsWith("sha256:");
        assertThat(a.at("/grundlagen/anwendungsbereich/0/ueberpruefung/satz").asText()).isEqualTo("seit 64 Tagen fällig");
        assertThat(a.at("/grundlagen/risiken_chancen").asText()).isEqualTo(mb.at("/grundlagen/risiken_chancen").asText());

        // Energieziel: das Ergebnis und die Zahlen wie in der Bewertungs-Kopie festgehalten — mit IHRER Prüfsumme.
        JsonNode ez = a.at("/energieziele/0");
        JsonNode ezSoll = mb.at("/energieziele/0");
        assertThat(a.path("energieziele")).hasSize(1);
        for (String feld : List.of("kennzeichen", "zielperiode", "bewertet_am", "ergebnis", "pruefsumme")) {
            assertThat(ez.path(feld).asText()).as(feld).isEqualTo(ezSoll.path(feld).asText());
        }
        assertThat(ez.path("zielwert_prozent").decimalValue()).isEqualByComparingTo("-5.0");
        assertThat(ez.at("/stand/delta_prozent").decimalValue()).isEqualByComparingTo(ezSoll.at("/stand/delta_prozent")
                .decimalValue()).isEqualByComparingTo("-2.7");
        assertThat(ez.at("/stand/monate").asText()).isEqualTo("11 von 12");

        // Energieleistung: der Leistungsvergleich mit seinem Urteil wie im Stand und dem offenen Anstoß K-2028-0001.
        JsonNode vb = a.at("/energieleistung/leistungsvergleiche/0");
        assertThat(vb.path("kennung").asText()).isEqualTo("BR-2028-0001");
        assertThat(vb.path("stand").asInt()).isEqualTo(1);
        assertThat(vb.path("delta_prozent").decimalValue()).isEqualByComparingTo("12.9");
        assertThat(vb.path("urteil").asText()).isEqualTo("schlechter");
        assertThat(texte(vb.path("anstoesse_offen"), "anlass")).containsExactly("K-2028-0001");
        assertThat(texte(a.at("/energieleistung/bezugsbasen"), "kennzeichen")).containsExactlyInAnyOrder("BB-0001",
                "BB-0002", "BB-0003", "BB-0004", "BB-0005");

        // Maßnahmen: belegt · nicht_messbar · geplant · geplant — die Wirkung aus dem Stand, mit dessen Prüfsumme.
        assertThat(texte(a.path("massnahmen"), "kennzeichen")).containsExactly("M-2028-0001", "M-2028-0002",
                "M-2029-0001", "M-2029-0002");
        assertThat(texte(a.path("massnahmen"), "zustand")).containsExactly("bewertet", "bewertet", "geplant", "geplant");
        JsonNode m1 = a.at("/massnahmen/0/bewertung");
        JsonNode m1Soll = mb.at("/massnahmen/0");
        assertThat(m1.path("ergebnis").asText()).isEqualTo("belegt");
        assertThat(m1.path("am").asText()).isEqualTo(m1Soll.path("am").asText());
        assertThat(m1.path("wirkung_prozent").decimalValue()).isEqualByComparingTo(m1Soll.path("wirkung_prozent")
                .decimalValue());
        assertThat(m1.path("monate_bewertbar").asInt()).isEqualTo(m1Soll.path("monate_bewertbar").asInt());
        assertThat(m1.path("pruefsumme").asText()).isEqualTo(m1Soll.path("pruefsumme").asText());
        assertThat(a.at("/massnahmen/1/bewertung/ergebnis").asText()).isEqualTo("nicht_messbar");
        assertThat(a.at("/massnahmen/1/bewertung/pruefsumme").isNull()).isTrue();

        // Abweichungen: AW-2028-0001 abgeschlossen mit M-2028-0001, Juli zur Kenntnis, keine offene.
        assertThat(a.at("/abweichungen/offen").asInt()).isZero().isEqualTo(mb.at("/abweichungen/offen").asInt());
        assertThat(a.at("/abweichungen/im_jahr/0/kennzeichen").asText()).isEqualTo("AW-2028-0001");
        assertThat(a.at("/abweichungen/im_jahr/0/massnahme").asText()).isEqualTo("M-2028-0001");
        assertThat(a.at("/abweichungen/auffaelligkeiten/0/monat").asText()).isEqualTo("2028-07");
        assertThat(a.at("/abweichungen/auffaelligkeiten/0/antwort").asText()).isEqualTo("zur_kenntnis");

        // Audit und Feststellung: eine offene Feststellung mit Frist 22.04.2029.
        assertThat(a.at("/audits_feststellungen/audits/0/kennzeichen").asText()).isEqualTo("AU-2029-0001");
        assertThat(a.at("/audits_feststellungen/feststellungen/0/kennzeichen").asText()).isEqualTo("F-2029-0001");
        assertThat(a.at("/audits_feststellungen/feststellungen/0/zustand").asText()).isEqualTo("offen");
        assertThat(a.at("/audits_feststellungen/feststellungen/0/frist").asText())
                .isEqualTo(mb.at("/audits_feststellungen/feststellungen/0/frist").asText());
        assertThat(a.at("/audits_feststellungen/offen").asInt()).isEqualTo(1);

        // Bewertung: seit 80 Tagen zur Überprüfung fällig (dieselbe Frist wie die Wiedervorlage).
        assertThat(a.at("/bewertung_messplanung/bewertungen/0/kennung").asText()).isEqualTo("BR-2027-0001");
        assertThat(a.at("/bewertung_messplanung/bewertungen/0/ueberpruefung/satz").asText())
                .isEqualTo(mb.at("/bewertung_messplanung/bewertung/ueberpruefung").asText());

        // Wiedervorlage zum Stichtag: dieselben acht fälligen Zeilen und die eine Vorschau wie der Leser (R12).
        assertThat(a.at("/wiedervorlage/anzahl_faellig").asInt()).isEqualTo(8);
        assertThat(texte(a.at("/wiedervorlage/faellig"), "kennzeichen")).containsExactly("BB-0002", "BB-0005",
                "BB-0003", "BR-2028-0001", "BB-0004", "BR-2027-0001", "D-0001", "D-0002");
        assertThat(texte(a.at("/wiedervorlage/faellig"), "satz")).isEqualTo(texte(mb.path("wiedervorlage"), "satz")
                .subList(0, 8));
        assertThat(texte(a.at("/wiedervorlage/vorschau"), "kennzeichen")).containsExactly("M-2029-0001");

        // MG3: jede Quelle hat eine der acht Quellenarten — keine trägt Kennzahl-Werte.
        List<String> arten = root.queryForList("SELECT DISTINCT q.art FROM bericht_quelle q JOIN bericht b ON "
                + "b.id = q.bericht_id WHERE b.tenant_id = ? AND b.kennung = 'BR-2029-0001'", String.class, tenant);
        assertThat(arten).isNotEmpty().allMatch(BerichtManagementbewertung.QUELLE_ARTEN::contains)
                .contains("energieziel", "massnahme", "abweichung", "feststellung", "internes_audit", "dokument",
                        "berichtsstand");
        assertThat(texte(a.path("quellenverzeichnis"), "art")).allMatch(BerichtManagementbewertung.QUELLE_ARTEN::contains);

        // AP-19 IP-23 (MG4, MG5, PA3): Sitzung und Beschlüsse — ohne sie keine Freigabe.
        sitzungUndBeschluesse(entwurf.path("datenstand").asText());
        entwurf = ruf("/api/v1/berichte/BR-2029-0001/entwurf", "IK", 200);
        JsonNode a2 = entwurf.path("abzug");
        JsonNode rmb = referenz.at("/managementbewertungen/0");
        assertThat(a2.at("/sitzung/tag").asText()).isEqualTo(rmb.at("/sitzung/tag").asText());
        assertThat(a2.at("/sitzung/leitung").asText()).isEqualTo("Robert Falk");
        assertThat(texte(a2.at("/sitzung/teilnehmende"), null)).containsExactly("Ines Kaltenbach", "Jonas Wendlinger",
                "Peter Hollerbach", "Claudia Berger");
        assertThat(a2.path("beschluesse")).hasSize(6);
        assertThat(texte(a2.path("beschluesse"), "wortlaut")).isEqualTo(texte(rmb.path("beschluesse"), "wortlaut"));
        assertThat(texte(a2.path("beschluesse"), "art")).isEqualTo(texte(rmb.path("beschluesse"), "art"));
        assertThat(texte(a2.path("beschluesse"), "kennung")).containsExactly("BR-2029-0001/B1", "BR-2029-0001/B2",
                "BR-2029-0001/B3", "BR-2029-0001/B4", "BR-2029-0001/B5", "BR-2029-0001/B6");
        assertThat(texte(a2.path("beschluesse"), "entschieden_von")).containsOnly("Robert Falk");
        assertThat(texte(a2.path("beschluesse"), "eingetragen_von")).containsOnly("Ines Kaltenbach");

        // RE3/RE5: „Einsicht“ liest den Entwurf; Freigabe nur mit energiemanagement.freigeben — 14:10 durch Ines.
        assertThat(ruf("/api/v1/berichte/BR-2029-0001/entwurf", "RF", 200).at("/abzug/kopf/bericht").asText())
                .isEqualTo("BR-2029-0001");
        String datenstand = entwurf.path("datenstand").asText();
        berichte.uhrStellen(Clock.fixed(Instant.parse("2029-02-12T13:10:00Z"), ZoneOffset.UTC));
        ruf("POST", "/api/v1/berichte/BR-2029-0001/freigeben", "RF", Map.of("entwurf_datenstand", datenstand), 403);
        JsonNode stand = ruf("POST", "/api/v1/berichte/BR-2029-0001/freigeben", "IK",
                Map.of("entwurf_datenstand", datenstand), 201);
        assertThat(stand.path("nr").asInt()).isEqualTo(1);
        assertThat(stand.path("pruefsumme").asText()).matches("sha256:[0-9a-f]{64}");
        // MG7: im Stand stehen Sitzung und Beschlüsse — „entschieden von“ die Leitung, „freigegeben von“ das Konto.
        JsonNode nr1 = ruf("/api/v1/berichte/BR-2029-0001/staende/1", "RF", 200);
        assertThat(nr1.at("/abzug/sitzung/leitung").asText()).isEqualTo("Robert Falk");
        assertThat(nr1.at("/abzug/beschluesse")).hasSize(6);
        assertThat(nr1.path("pruefsumme").asText()).isEqualTo(stand.path("pruefsumme").asText());
        assertThat(root.queryForObject("SELECT freigeber_name FROM bericht_stand s JOIN bericht b ON b.id = s.bericht_id "
                + "WHERE b.tenant_id = ? AND b.kennung = 'BR-2029-0001'", String.class, tenant)).isEqualTo("Ines Kaltenbach");
        // Danach ändern sich Sitzung und Beschlüsse nicht mehr (409); der Beschluss ohne Folge sagt es.
        String mbPfad = BASIS + "/managementbewertungen/BR-2029-0001";
        assertThat(ruf("POST", mbPfad + "/beschluesse", "IK", beschluss(rmb.path("beschluesse").get(5)), 409)
                .path("code").asText()).isEqualTo("managementbewertung_freigegeben");
        assertThat(ruf("PUT", mbPfad + "/beschluesse/6", "IK", beschluss(rmb.path("beschluesse").get(5)), 409)
                .path("code").asText()).isEqualTo("managementbewertung_freigegeben");
        JsonNode mbSeite = ruf(mbPfad, "RF", 200);
        assertThat(mbSeite.path("freigegeben").asBoolean()).isTrue();
        assertThat(mbSeite.path("stand_nr").asInt()).isEqualTo(1);
        assertThat(mbSeite.at("/beschluesse/4/satz").asText())
                .isEqualTo("Keine Folge in VoltPilot — der Beschluss steht im Stand vom 12.02.2029.");
        // Verzeichnis-Quelle: der Stand in der Gruppe „Managementbewertung“, entschieden von der Leitung (R3, VZ2).
        verzeichnis.uhrStellen(Clock.fixed(Instant.parse("2029-02-12T13:30:00Z"), ZoneOffset.UTC));
        JsonNode vz = ruf(BASIS + "/verzeichnis?gruppe=managementbewertung", "RF", 200);
        JsonNode zeilen = null;
        for (JsonNode g : vz.path("gruppen")) {
            if (g.path("gruppe").asText().equals("managementbewertung")) zeilen = g.path("zeilen");
        }
        assertThat(zeilen).hasSize(1);
        assertThat(zeilen.at("/0/kennzeichen").asText()).isEqualTo("BR-2029-0001");
        assertThat(zeilen.at("/0/entschieden_von").asText()).isEqualTo("Robert Falk");
        assertThat(zeilen.at("/0/eingetragen_von").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(zeilen.at("/0/pruefsumme").asText()).isEqualTo(stand.path("pruefsumme").asText());
        // MG7: nächste Managementbewertung fällig = Sitzung + 12 Monate, beim Abruf — am 20.01.2030 in der Vorschau.
        wiedervorlage.uhrStellen(Clock.fixed(Instant.parse("2030-01-20T08:00:00Z"), ZoneOffset.UTC));
        List<JsonNode> mg7 = new ArrayList<>();
        ruf(WIEDERVORLAGE, "IK", 200).path("vorschau").forEach(z -> {
            if (z.path("art").asText().equals("managementbewertung")) mg7.add(z);
        });
        assertThat(mg7).singleElement().satisfies(z -> {
            assertThat(z.path("kennzeichen").asText()).isEqualTo("BR-2029-0001");
            assertThat(z.path("faellig_am").asText()).isEqualTo("2030-02-12");
        });
        wiedervorlage.uhrStellen(Clock.fixed(Instant.parse("2029-02-12T13:00:00Z"), ZoneOffset.UTC));

        // PDF-Abschnitte: die zwölf Überschriften, Grenz- und Verantwortungs-Satz — auch „Einsicht“ lädt es.
        MockHttpServletResponse pdf = roh("/api/v1/berichte/BR-2029-0001/staende/1/pdf", "RF");
        assertThat(pdf.getStatus()).isEqualTo(200);
        String text;
        try (PDDocument d = Loader.loadPDF(pdf.getContentAsByteArray())) {
            text = new PDFTextStripper().getText(d).replace('\u00A0', ' ').replaceAll("\\s+", " ");
        }
        assertThat(text).contains("Managementbewertung", "Beschlüsse der letzten Managementbewertung und ihre Folgen",
                "Grundlagen", "Energieziele", "Energieleistung", "Maßnahmen", "Abweichungen und Auffälligkeiten",
                "Interne Audits und Feststellungen", "Energetische Bewertung und Messplanung", "Wiedervorlage zum Stichtag",
                "Sitzung", "Quellenverzeichnis", "Robert Falk", "Druckluft: Leckagen jährlich orten", "EZ-2028-0001", "−2,7 %", "M-2028-0001", "+12,9 %", "F-2029-0001",
                "seit 80 Tagen fällig", "Keine frühere Managementbewertung festgehalten.",
                "Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden.",
                "Inhalte und Entscheidungen Ihres Energiemanagements verantwortet Ihr Unternehmen.");
        // Die Managementbewertung gibt es nur als PDF: „Einsicht“ 403, wer bearbeiten darf 422.
        assertThat(roh("/api/v1/berichte/BR-2029-0001/staende/1/csv", "RF").getStatus()).isEqualTo(403);
        assertThat(roh("/api/v1/berichte/BR-2029-0001/staende/1/csv", "IK").getStatus()).isEqualTo(422);

        // MG3, Probe mit K-2028-0001: die echte Berichts-Kaskade trifft den Leistungsvergleich, der BZ-1 zitiert — nie
        // die Managementbewertung, die keine Quelle mit Kennzahl-Werten hat.
        UUID vbStand = root.queryForObject("SELECT s.id FROM bericht_stand s JOIN bericht b ON b.id = s.bericht_id "
                + "WHERE b.tenant_id = ? AND b.kennung = 'BR-2028-0001'", UUID.class, tenant);
        UUID vbId = root.queryForObject("SELECT id FROM bericht WHERE tenant_id = ? AND kennung = 'BR-2028-0001'",
                UUID.class, tenant);
        root.update("INSERT INTO bericht_quelle (tenant_id, bericht_id, stand_nr, art, kennzeichen, objekt_id, bezug, "
                + "erster_tag, letzter_tag, fassung, name_zum_datenstand) VALUES (?, ?, 1, 'bezugsgroesse', 'BZ-1', ?, "
                + "'unmittelbar', '2027-12-01', '2027-12-31', 1, 'Produktionsmenge')", tenant, vbId, bz1);
        KorrekturKaskade.Betroffen k = new KorrekturKaskade.Betroffen(tenant, "K-2028-0001", 1,
                KorrekturKaskade.FREIGEGEBEN, List.of(), Instant.parse("2027-11-30T23:00:00Z"),
                Instant.parse("2029-01-01T00:00:00Z"), ZoneId.of("Europe/Berlin"), LocalDate.of(2027, 12, 1),
                LocalDate.of(2028, 12, 31), List.of("MS-20"), List.of(), 2, Instant.parse("2029-02-12T13:30:00Z"),
                List.of(new KorrekturKaskade.Bezugsgroesse(bz1, "BZ-1", LocalDate.of(2027, 12, 1),
                        LocalDate.of(2028, 12, 31), 2, "freigegeben")));
        BerichtKaskade kaskade = new BerichtKaskade(bildung);
        List<String> getroffen = root.execute((ConnectionCallback<List<String>>) con ->
                kaskade.betroffene(con, k).stream().map(BerichteNaht.Bericht::kennung).toList());
        assertThat(getroffen).contains("BR-2028-0001").doesNotContain("BR-2029-0001");
        String pruefsumme = stand.path("pruefsumme").asText();
        root.execute((ConnectionCallback<Void>) con -> {
            KorrekturKaskade.berichteBenachrichtigen(con, kaskade, k);
            return null;
        });
        assertThat(root.queryForObject("SELECT count(*) FROM bericht_revision_anstoss a JOIN bericht_stand s ON "
                + "s.id = a.stand_id JOIN bericht b ON b.id = s.bericht_id WHERE b.tenant_id = ? "
                + "AND b.kennung = 'BR-2029-0001'", Integer.class, tenant)).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM bericht_revision_anstoss WHERE tenant_id = ? "
                + "AND stand_id = ? AND anlass_kennung = 'K-2028-0001' AND art = 'bezugsgroesse_fassung'", Integer.class,
                tenant, vbStand)).isEqualTo(1);
        assertThat(root.queryForObject("SELECT s.pruefsumme FROM bericht_stand s JOIN bericht b ON b.id = s.bericht_id "
                + "WHERE b.tenant_id = ? AND b.kennung = 'BR-2029-0001' AND s.nr = 1", String.class, tenant))
                .isEqualTo(pruefsumme);
    }

    // ------------------------------------------------------------------ R14 (AP-19 IP-23)

    @Test
    void r14FolgenDerBeschluesseUndEinStandSeinesTagesOhneAnstoss() throws Exception {
        r12Welt();
        r13Welt();
        abruf("2029-02-12T13:00:00Z");
        berichte.uhrStellen(Clock.fixed(Instant.parse("2029-02-12T13:00:00Z"), ZoneOffset.UTC));
        ruf("POST", "/api/v1/berichte", "IK", Map.of("vorlage", "managementbewertung", "geltung_id",
                unternehmen.toString(), "zeitraum", "2028"), 201);
        String mb = BASIS + "/managementbewertungen/BR-2029-0001";
        // Vor der Freigabe gibt es keine Folge (409) und keine Maßnahme aus einem Beschluss (422).
        sitzungUndBeschluesse(ruf("/api/v1/berichte/BR-2029-0001/entwurf", "IK", 200).path("datenstand").asText());
        assertThat(ruf("POST", mb + "/beschluesse/1/folgen", "IK", Map.of("art", "audit", "objekt", "AU-2029-0001"), 409)
                .path("code").asText()).isEqualTo("managementbewertung_nicht_freigegeben");
        assertThat(ruf("POST", "/api/v1/massnahmen", "IK", massnahmeKoerper("Druckluft: Leckagen jährlich orten, 2029 "
                + "im zweiten Quartal", "IK", "2029-06-30", "managementbewertung", "BR-2029-0001/B2"), 422).path("code")
                .asText()).isEqualTo("managementbewertung_nicht_freigegeben");
        // MG6: auch eine Aufgabe nennt nur einen Beschluss im Stand — sonst wäre sie still keine Folge.
        assertThat(ruf("POST", BASIS + "/aufgaben", "JW", new LinkedHashMap<>(Map.of("aufgabe", "bezugsbasen",
                "person_id", person.get("IK"), "gilt_ab", "2029-03-01", "entschieden_von", person.get("RF"),
                "begruendung", "Beschluss B4 der Managementbewertung 2028", "beschluss_kennung", "BR-2029-0001/B4")),
                422).path("code").asText()).isEqualTo("managementbewertung_nicht_freigegeben");
        String datenstand = ruf("/api/v1/berichte/BR-2029-0001/entwurf", "IK", 200).path("datenstand").asText();
        berichte.uhrStellen(Clock.fixed(Instant.parse("2029-02-12T13:10:00Z"), ZoneOffset.UTC));
        ruf("POST", "/api/v1/berichte/BR-2029-0001/freigeben", "IK", Map.of("entwurf_datenstand", datenstand), 201);
        String abzugNr1 = root.queryForObject("SELECT s.abzug FROM bericht_stand s JOIN bericht b ON b.id = s.bericht_id "
                + "WHERE b.tenant_id = ? AND b.kennung = 'BR-2029-0001' AND s.nr = 1", String.class, tenant);
        String pruefsummeNr1 = root.queryForObject("SELECT s.pruefsumme FROM bericht_stand s JOIN bericht b "
                + "ON b.id = s.bericht_id WHERE b.tenant_id = ? AND b.kennung = 'BR-2029-0001' AND s.nr = 1", String.class,
                tenant);
        String d1 = root.queryForObject("SELECT id FROM energiemanagement_dokument WHERE tenant_id = ? "
                + "AND kennzeichen = 'D-0001'", UUID.class, tenant).toString();
        String d2 = root.queryForObject("SELECT id FROM energiemanagement_dokument WHERE tenant_id = ? "
                + "AND kennzeichen = 'D-0002'", UUID.class, tenant).toString();

        // B6 13.02.2029: „geprüft, bleibt“ an D-0002 nennt den Beschluss.
        heute("2029-02-13T10:00:00Z");
        assertThat(ruf("POST", BASIS + "/dokumente/" + d2 + "/geprueft", "IK", Map.of("entschieden_von",
                person.get("RF"), "am", "2029-02-13", "begruendung", "Beschluss B9 der Managementbewertung 2028: bleibt "
                + "unverändert.", "beschluss_kennung", "BR-2029-0001/B9"), 422).path("code").asText())
                .as("MG6: B9 gibt es nicht").isEqualTo("beschluss_unbekannt");
        ruf("POST", BASIS + "/dokumente/" + d2 + "/geprueft", "IK", Map.of("entschieden_von", person.get("RF"), "am",
                "2029-02-13", "begruendung", "Beschluss B6 der Managementbewertung 2028: bleibt unverändert.",
                "beschluss_kennung", "BR-2029-0001/B6"), 200);
        // B2 14.02.2029: die Maßnahme mit Herkunft `managementbewertung` verknüpft sich selbst — B9 gibt es nicht.
        kennzahlen.uhrStellen(Clock.fixed(Instant.parse("2029-02-14T10:00:00Z"), ZoneOffset.UTC));
        assertThat(ruf("POST", "/api/v1/massnahmen", "IK", massnahmeKoerper("Unbekannter Beschluss", "IK", "2029-06-30",
                "managementbewertung", "BR-2029-0001/B9"), 422).path("code").asText()).isEqualTo("herkunft_kennung");
        JsonNode m3 = ruf("POST", "/api/v1/massnahmen", "IK", massnahmeKoerper("Druckluft: Leckagen jährlich orten, 2029 "
                + "im zweiten Quartal", "IK", "2029-06-30", "managementbewertung", "BR-2029-0001/B2"), 201);
        assertThat(m3.path("kennzeichen").asText()).isEqualTo("M-2029-0003");
        assertThat(ruf("POST", mb + "/beschluesse/2/folgen", "IK", Map.of("art", "massnahme", "objekt", "M-2029-0003"),
                422).path("code").asText()).isEqualTo("folge_art");
        // B1 15.02.2029: das Energieziel hat keine Herkunft — von Hand verknüpft, ab März (AP-18 Z1), zweimal = einmal.
        berichte.uhrStellen(Clock.fixed(Instant.parse("2029-02-15T10:00:00Z"), ZoneOffset.UTC));
        JsonNode ez = referenz.at("/managementbewertungen/0/folgen/0");
        assertThat(ez.path("objekt").asText()).isEqualTo("EZ-2029-0001");
        root.update("INSERT INTO energieziel (tenant_id, kennzeichen, kennzahl_id, bezugsbasis_id, fassung, "
                + "zielwert_prozent, zielperiode, wortlaut, begruendung, verantwortlich_sub, verantwortlich_name, "
                + "verantwortlich_konto, standort_id, actor_sub, actor_name, actor_rolle, actor_art, angelegt_am) "
                + "SELECT tenant_id, 'EZ-2029-0001', kennzahl_id, bezugsbasis_id, fassung, -4.0, '2029-03/2029-12', "
                + "'Energieziel 2029 für den Spritzguss: 4 % weniger Strom, als die Bezugsbasis erwarten lässt.', "
                + "'Beschluss B1 der Managementbewertung vom 12.02.2029 (BR-2029-0001).', verantwortlich_sub, "
                + "verantwortlich_name, verantwortlich_konto, standort_id, actor_sub, actor_name, actor_rolle, actor_art, "
                + "'2029-02-15T09:00:00Z' FROM energieziel WHERE tenant_id = ? AND kennzeichen = 'EZ-2028-0001'", tenant);
        assertThat(ruf("POST", mb + "/beschluesse/1/folgen", "IK", Map.of("art", "energieziel", "objekt",
                "EZ-2029-0009"), 422).path("code").asText()).isEqualTo("objekt_unbekannt");
        ruf("POST", mb + "/beschluesse/1/folgen", "RF", Map.of("art", "energieziel", "objekt", "EZ-2029-0001"), 403);
        ruf("POST", mb + "/beschluesse/1/folgen", "IK", Map.of("art", "energieziel", "objekt", "EZ-2029-0001"), 201);
        ruf("POST", mb + "/beschluesse/1/folgen", "IK", Map.of("art", "energieziel", "objekt", "EZ-2029-0001"), 201);
        assertThat(root.queryForObject("SELECT count(*) FROM managementbewertung_folge WHERE tenant_id = ?",
                Integer.class, tenant)).isEqualTo(1);
        // B4 26.02.2029: die Aufgabe „Bezugsbasen“ ab 01.03.2029 — bei der Zuordnung verknüpft (Jonas Wendlinger).
        ruf("POST", BASIS + "/aufgaben", "JW", new LinkedHashMap<>(Map.of("aufgabe", "bezugsbasen", "person_id",
                person.get("IK"), "gilt_ab", "2029-03-01", "vertretung_person_id", person.get("JW"), "entschieden_von",
                person.get("RF"), "begruendung", "Beschluss B4 der Managementbewertung 2028", "beschluss_kennung",
                "BR-2029-0001/B4")), 201);
        // B3 10.03./20.03.2029: D-0001 Fassung 2 aus dem Beschluss, freigegeben, entschieden von Robert Falk.
        heute("2029-03-10T10:00:00Z");
        fassung(d1, Map.of("form", "wortlaut", "wortlaut", "Energiepolitik, ergänzt um Einkauf und Planung.",
                "begruendung", "Beschluss B3 der Managementbewertung 2028", "beschluss_kennung", "BR-2029-0001/B3"));
        heute("2029-03-20T10:00:00Z");
        ruf("POST", BASIS + "/dokumente/" + d1 + "/fassungen/2/freigeben", "IK", Map.of("entschieden_von",
                person.get("RF"), "begruendung", BEGRUENDUNG), 200);
        // 01.03./15.04.2029: M-2029-0001 umgesetzt, F-2029-0001 wirksam und abgeschlossen (R11).
        String m1 = root.queryForObject("SELECT id FROM massnahme WHERE tenant_id = ? AND kennzeichen = 'M-2029-0001'",
                UUID.class, tenant).toString();
        kennzahlen.uhrStellen(Clock.fixed(Instant.parse("2029-03-01T10:00:00Z"), ZoneOffset.UTC));
        ruf("POST", "/api/v1/massnahmen/" + m1 + "/umgesetzt", "JW", Map.of("am", "2029-03-01", "begruendung",
                "Aufgabe seit 01.03.2029 Ines Kaltenbach, Vertretung Jonas Wendlinger (Beschluss B4)."), 200);
        String f1 = root.queryForObject("SELECT id FROM feststellung WHERE tenant_id = ? AND kennzeichen = 'F-2029-0001'",
                UUID.class, tenant).toString();
        feststellungen.uhrStellen(Clock.fixed(Instant.parse("2029-04-15T10:00:00Z"), ZoneOffset.UTC));
        ruf("POST", BASIS + "/feststellungen/" + f1 + "/wirksamkeit", "IK", Map.of("ergebnis", "wirksam", "begruendung",
                "Die Zuständigkeit ist festgelegt und wird seit März gelebt.", "entschieden_von", person.get("IK")), 201);
        assertThat(root.queryForObject("SELECT zustand FROM feststellung WHERE id = ?::uuid", String.class, f1))
                .isEqualTo("abgeschlossen");

        // MG3/MG7: der Stand vom 12.02.2029 bleibt byte-gleich — kein Anstoß, keine neue Nr.; er sagt weiter „offen“.
        assertThat(root.queryForObject("SELECT s.abzug FROM bericht_stand s JOIN bericht b ON b.id = s.bericht_id "
                + "WHERE b.tenant_id = ? AND b.kennung = 'BR-2029-0001' AND s.nr = 1", String.class, tenant))
                .isEqualTo(abzugNr1);
        assertThat(root.queryForObject("SELECT count(*) FROM bericht_stand s JOIN bericht b ON b.id = s.bericht_id "
                + "WHERE b.tenant_id = ? AND b.kennung = 'BR-2029-0001'", Integer.class, tenant)).isEqualTo(1);
        assertThat(root.queryForObject("SELECT count(*) FROM bericht_revision_anstoss a JOIN bericht_stand s ON "
                + "s.id = a.stand_id JOIN bericht b ON b.id = s.bericht_id WHERE b.tenant_id = ? "
                + "AND b.kennung = 'BR-2029-0001'", Integer.class, tenant)).isZero();
        JsonNode nr1 = ruf("/api/v1/berichte/BR-2029-0001/staende/1", "RF", 200);
        assertThat(nr1.path("pruefsumme").asText()).isEqualTo(pruefsummeNr1);
        assertThat(nr1.at("/abzug/audits_feststellungen/feststellungen/0/zustand").asText()).isEqualTo("offen");

        // 30.04.2029: der Entwurf der nächsten Managementbewertung liest die Beschlüsse und ihre Folgen von heute.
        abruf("2029-04-30T08:00:00Z");
        berichte.uhrStellen(Clock.fixed(Instant.parse("2029-04-30T08:00:00Z"), ZoneOffset.UTC));
        JsonNode naechste = ruf("POST", "/api/v1/berichte", "IK", Map.of("vorlage", "managementbewertung", "geltung_id",
                unternehmen.toString(), "zeitraum", "2029"), 201);
        JsonNode v = ruf("/api/v1/berichte/" + naechste.path("kennung").asText() + "/entwurf", "IK", 200)
                .at("/abzug/vorige_beschluesse");
        assertThat(v.at("/managementbewertung/kennung").asText()).isEqualTo("BR-2029-0001");
        assertThat(v.at("/managementbewertung/pruefsumme").asText()).isEqualTo(pruefsummeNr1);
        JsonNode b = v.path("beschluesse");
        assertThat(texte(b, "kennung")).containsExactly("BR-2029-0001/B1", "BR-2029-0001/B2", "BR-2029-0001/B3",
                "BR-2029-0001/B4", "BR-2029-0001/B5", "BR-2029-0001/B6");
        assertThat(folge(b.get(0))).containsExactly("energieziel EZ-2029-0001 von_hand offen 2029-03/2029-12");
        assertThat(folge(b.get(1))).containsExactly("massnahme M-2029-0003 herkunft geplant 2029-06-30");
        assertThat(folge(b.get(2))).containsExactly("dokument D-0001/2 fassung freigegeben 2029-03-20");
        assertThat(folge(b.get(3))).containsExactly("aufgabe bezugsbasen zuordnung laufend 2029-03-01 Ines Kaltenbach");
        assertThat(b.get(4).path("folgen")).isEmpty();
        assertThat(b.get(4).path("satz").asText())
                .isEqualTo("Keine Folge in VoltPilot — der Beschluss steht im Stand vom 12.02.2029.");
        assertThat(folge(b.get(5))).containsExactly("dokument D-0002 geprueft_bleibt geprueft_bleibt 2029-02-13");
        assertThat(texte(b, "entschieden_von")).containsOnly("Robert Falk");
        // MG3: jeder vorige Beschluss ist eine Quelle der Art `beschluss` — keine trägt Kennzahl-Werte.
        List<String> beschlussQuellen = root.queryForList("SELECT q.kennzeichen FROM bericht_quelle q JOIN bericht r "
                + "ON r.id = q.bericht_id WHERE r.tenant_id = ? AND r.kennung = ? AND q.art = 'beschluss' "
                + "AND q.stand_nr IS NULL ORDER BY q.kennzeichen", String.class, tenant, naechste.path("kennung").asText());
        assertThat(beschlussQuellen).hasSize(6).first().isEqualTo("BR-2029-0001/B1");
        // Dieselben Folgen an der Route — „Einsicht“ liest.
        JsonNode seite = ruf(mb, "RF", 200);
        assertThat(texte(seite.at("/beschluesse/1/folgen"), "objekt")).containsExactly("M-2029-0003");
        assertThat(seite.at("/beschluesse/0/folgen/0/verknuepft_am").asText()).isEqualTo("2029-02-15");
        assertThat(seite.at("/beschluesse/0/folgen/0/eingetragen_von").asText()).isEqualTo("Ines Kaltenbach");
        // FS1: eine Feststellung aus einem Beschluss der freigegebenen Managementbewertung.
        feststellungen.uhrStellen(Clock.fixed(Instant.parse("2029-04-30T08:00:00Z"), ZoneOffset.UTC));
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("quelle", Map.of("art", "managementbewertung", "kennung", "BR-2029-0001/B9"));
        f.put("wortlaut", "Die Freigaben der Bezugsbasen hat die Leitung nicht durchgesehen.");
        f.put("vorgabe", Map.of("wortlaut", "Beschluss B4: die Leitung sieht die Freigaben durch."));
        f.put("festgestellt_von", person.get("RF"));
        f.put("festgestellt_am", "2029-04-30");
        f.put("verantwortlich", "IK");
        assertThat(ruf("POST", BASIS + "/feststellungen", "IK", f, 422).path("code").asText())
                .isEqualTo("quelle_unbekannt");
        f.put("quelle", Map.of("art", "managementbewertung", "kennung", "BR-2029-0001/B4"));
        assertThat(ruf("POST", BASIS + "/feststellungen", "IK", f, 201).at("/feststellung/kennzeichen").asText())
                .isEqualTo("F-2029-0002");
    }

    /** Die Folgen eines Beschlusses als „art objekt wie zustand [tag] [angabe]“. */
    private static List<String> folge(JsonNode beschluss) {
        List<String> aus = new ArrayList<>();
        for (JsonNode f : beschluss.path("folgen")) {
            StringBuilder z = new StringBuilder(f.path("art").asText() + " " + f.path("objekt").asText() + " "
                    + f.path("wie").asText() + " " + f.path("zustand").asText());
            if (f.hasNonNull("tag")) z.append(' ').append(f.path("tag").asText());
            if (f.hasNonNull("angabe")) z.append(' ').append(f.path("angabe").asText());
            aus.add(z.toString());
        }
        return aus;
    }

    // ------------------------------------------------------------------ IP-23: Sitzung und Beschlüsse

    /**
     * R13 Schritte 4 und 5 über die Routen von IP-23 (MG4, MG5): jede Lücke sperrt die Freigabe — ohne Sitzung
     * {@code sitzung_fehlt}, ohne Beschluss {@code beschluss_fehlt}; die Leitung ist die Person mit der laufenden Aufgabe
     * „Leitung des Unternehmens“ (PA3). Danach die Sitzung vom 12.02.2029 und die Beschlüsse B1–B6 der Referenzdatei.
     */
    private void sitzungUndBeschluesse(String datenstand) throws Exception {
        String mb = BASIS + "/managementbewertungen/BR-2029-0001";
        JsonNode rmb = referenz.at("/managementbewertungen/0");
        assertThat(ruf("POST", "/api/v1/berichte/BR-2029-0001/freigeben", "IK", Map.of("entwurf_datenstand",
                datenstand), 422).path("code").asText()).isEqualTo("sitzung_fehlt");
        assertThat(ruf("POST", mb + "/beschluesse", "IK", beschluss(rmb.path("beschluesse").get(0)), 422).path("code")
                .asText()).isEqualTo("sitzung_fehlt");
        assertThat(ruf(BASIS + "/managementbewertungen/BR-2028-0001", "IK", 404).path("code").asText())
                .isEqualTo("nicht_gefunden");
        if (!person.containsKey("PH")) person.put("PH", personAnlegen("Peter Hollerbach", "Instandhaltung", "PH", "PH"));
        Map<String, Object> sitzung = new LinkedHashMap<>();
        sitzung.put("tag", rmb.at("/sitzung/tag").asText());
        sitzung.put("leitung", person.get("IK"));
        List<String> teilnehmende = new ArrayList<>();
        rmb.at("/sitzung/teilnehmende").forEach(t -> teilnehmende.add(person.get(t.asText())));
        sitzung.put("teilnehmende", teilnehmende);
        sitzung.put("ort", rmb.at("/sitzung/ort").asText());
        ruf("PUT", mb + "/sitzung", "RF", sitzung, 403);
        assertThat(ruf("PUT", mb + "/sitzung", "IK", sitzung, 422).path("code").asText()).isEqualTo("leitung_fehlt");
        sitzung.put("leitung", person.get("RF"));
        JsonNode s = ruf("PUT", mb + "/sitzung", "IK", sitzung, 200);
        assertThat(s.at("/sitzung/leitung/name").asText()).isEqualTo("Robert Falk");
        assertThat(s.at("/sitzung/leitung_gilt").asBoolean()).isTrue();
        String neu = ruf("/api/v1/berichte/BR-2029-0001/entwurf", "IK", 200).path("datenstand").asText();
        assertThat(ruf("POST", "/api/v1/berichte/BR-2029-0001/freigeben", "IK", Map.of("entwurf_datenstand", neu), 422)
                .path("code").asText()).isEqualTo("beschluss_fehlt");
        Map<String, Object> nichtLeitung = beschluss(rmb.path("beschluesse").get(0));
        nichtLeitung.put("entschieden_von", person.get("IK"));
        assertThat(ruf("POST", mb + "/beschluesse", "IK", nichtLeitung, 422).path("code").asText())
                .isEqualTo("leitung_fehlt");
        JsonNode letzte = null;
        for (JsonNode b : rmb.path("beschluesse")) {
            letzte = ruf("POST", mb + "/beschluesse", "IK", beschluss(b), 201);
        }
        assertThat(texte(letzte.path("beschluesse"), "nr")).containsExactly("1", "2", "3", "4", "5", "6");
        // Bis zur Freigabe änderbar — die Nr. bleibt.
        JsonNode geaendert = ruf("PUT", mb + "/beschluesse/6", "IK", beschluss(rmb.path("beschluesse").get(5)), 200);
        assertThat(geaendert.at("/beschluesse/5/entschieden_von/name").asText()).isEqualTo("Robert Falk");
        assertThat(geaendert.at("/beschluesse/5/satz").isNull()).isTrue();
        ruf("PUT", mb + "/beschluesse/7", "IK", beschluss(rmb.path("beschluesse").get(5)), 404);
    }

    /** Ein Beschluss der Referenzdatei als Körper — ohne „entschieden von“ (Vorgabe: die Leitung der Sitzung). */
    private Map<String, Object> beschluss(JsonNode b) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("art", b.path("art").asText());
        m.put("wortlaut", b.path("wortlaut").asText());
        m.put("zustaendig", person.get(b.path("zustaendig").asText()));
        if (b.hasNonNull("termin")) m.put("termin", b.path("termin").asText());
        return m;
    }

    // ------------------------------------------------------------------ Welt R13

    /**
     * Die Leistungs-Eingaben 1.9 der Referenzdatei, direkt geschrieben: EZ-2028-0001 mit ihrer Bewertungs-Kopie,
     * M-2028-0001 (Stand Nr. 1 belegt mit Kopie) und M-2028-0002 (nicht messbar), AW-2028-0001 abgeschlossen mit
     * M-2028-0001, die Auffälligkeit Juli 2028 zur Kenntnis, das Urteil des Leistungsvergleichs im Stand. Jede
     * Prüfsumme bildet die Datenbank gegen den kanonischen Text — sie muss die der Referenzdatei sein.
     */
    private void r13Welt() throws Exception {
        UUID kz4 = root.queryForObject("SELECT id FROM kennzahl WHERE tenant_id = ? AND kennzeichen = 'KZ-0004'",
                UUID.class, tenant);
        UUID bb1 = root.queryForObject("SELECT id FROM bezugsbasis WHERE tenant_id = ? AND kennzeichen = 'BB-0001'",
                UUID.class, tenant);
        JsonNode ez = referenz.at("/energieziele/0");
        UUID ezId = root.queryForObject("INSERT INTO energieziel (tenant_id, kennzeichen, kennzahl_id, bezugsbasis_id, "
                + "fassung, zielwert_prozent, zielperiode, wortlaut, begruendung, verantwortlich_sub, verantwortlich_name, "
                + "verantwortlich_konto, standort_id, actor_sub, actor_name, actor_rolle, actor_art, angelegt_am) VALUES "
                + "(?, 'EZ-2028-0001', ?, ?, 1, -5.0, '2028-01/2028-12', ?, ?, 'IK', 'Ines Kaltenbach', 'benutzer', ?, "
                + "'IK', 'Ines Kaltenbach', 'energiemanager', 'kunde', '2027-12-20T09:00:00Z') RETURNING id", UUID.class,
                tenant, kz4, bb1, ez.path("wortlaut").asText(), ez.path("begruendung").asText(), s1);
        String ezKopie = BerichtRegeln.kanonisch(ez.at("/bewertung/kopie"));
        root.update("UPDATE energieziel SET zustand = 'bewertet', ergebnis = 'verfehlt', bewertung_status = 'bewertet', "
                + "bewertung_begruendung = ?, bewertung_kopie = ?, bewertung_pruefsumme = ?, freigabe_sub = 'IK', "
                + "freigabe_name = 'Ines Kaltenbach', freigabe_rolle = 'energiemanager', freigabe_art = 'kunde', "
                + "freigabe_am = '2029-01-15T09:00:00Z' WHERE id = ?", ez.at("/bewertung/begruendung").asText(), ezKopie,
                ez.at("/bewertung/pruefsumme").asText(), ezId);

        JsonNode m1 = referenz.at("/massnahmen/0");
        UUID m1Id = massnahmeDirekt("M-2028-0001", m1, "abweichung", "AW-2028-0001", kz4, bb1,
                BerichtRegeln.kanonisch(m1.at("/ausgangslage/kopie")), "2028-01-15T09:00:00Z", "2028-01-22");
        bewertungDirekt(m1Id, m1.at("/bewertungen/0"), kz4, bb1, "2028-11-15T10:00:00Z");
        JsonNode m2 = referenz.at("/massnahmen/1");
        UUID m2Id = massnahmeDirekt("M-2028-0002", m2, "von_hand", null, null, null, null, "2028-01-20T09:00:00Z",
                "2028-03-28");
        bewertungDirekt(m2Id, m2.at("/bewertungen/0"), null, null, "2028-11-20T10:00:00Z");

        JsonNode aw = null;
        for (JsonNode x : referenz.path("abweichungen")) {
            if (x.path("kennzeichen").asText().equals("AW-2028-0001")) aw = x;
        }
        String anlass = BerichtRegeln.kanonisch(aw.path("anlass"));
        UUID awId = root.queryForObject("INSERT INTO abweichung (tenant_id, kennzeichen, kennzahl_id, bezugsbasis_id, "
                + "fassung, monate, herkunft_art, anlass, anlass_pruefsumme, verantwortlich_sub, verantwortlich_name, "
                + "verantwortlich_konto, frist, actor_sub, actor_name, actor_art, eroeffnet_am) VALUES (?, 'AW-2028-0001', "
                + "?, ?, 1, '{2027-12}', 'auffaelligkeit', ?, ?, 'IK', 'Ines Kaltenbach', 'benutzer', '2028-01-31', 'IK', "
                + "'Ines Kaltenbach', 'kunde', '2028-01-12T09:00:00Z') RETURNING id", UUID.class, tenant, kz4, bb1, anlass,
                aw.path("pruefsumme").asText());
        root.update("UPDATE abweichung SET zustand = 'abgeschlossen', ergebnis = 'massnahme', massnahme_id = ?, "
                + "abschluss_begruendung = ?, abgeschlossen_am = '2028-01-15T10:00:00Z', abgeschlossen_sub = 'IK', "
                + "abgeschlossen_name = 'Ines Kaltenbach', abgeschlossen_rolle = 'energiemanager', "
                + "abgeschlossen_art = 'kunde' WHERE id = ?", m1Id, aw.at("/abschluss/begruendung").asText(), awId);

        JsonNode juli = null;
        for (JsonNode x : referenz.path("auffaelligkeiten")) {
            if (x.path("periode").asText().equals("2028-07")) juli = x;
        }
        UUID au = root.queryForObject("INSERT INTO auffaelligkeit (tenant_id, kennzahl_id, bezugsbasis_id, fassung, "
                + "periode, anlass, anlass_pruefsumme) VALUES (?, ?, ?, 1, '2028-07', ?, ?) RETURNING id", UUID.class,
                tenant, kz4, bb1, BerichtRegeln.kanonisch(juli.path("anlass")), juli.path("pruefsumme").asText());
        root.update("UPDATE auffaelligkeit SET zustand = 'beantwortet', antwort = 'zur_kenntnis', antwort_begruendung = ?, "
                + "beantwortet_am = '2028-08-10T09:00:00Z', beantwortet_sub = 'IK', beantwortet_name = 'Ines Kaltenbach', "
                + "beantwortet_rolle = 'energiemanager', beantwortet_art = 'kunde' WHERE id = ?",
                juli.at("/antwort/begruendung").asText("Einmaliger Effekt, zur Kenntnis genommen."), au);

    }

    private UUID massnahmeDirekt(String kennzeichen, JsonNode m, String herkunft, String herkunftKennung, UUID kennzahl,
            UUID basis, String ausgangslage, String angelegt, String umgesetzt) {
        UUID id = root.queryForObject("INSERT INTO massnahme (tenant_id, kennzeichen, titel, verantwortlich_sub, "
                + "verantwortlich_name, verantwortlich_konto, termin, standort_id, herkunft_art, herkunft_kennung, "
                + "kennzahl_id, bezugsbasis_id, fassung, ausgangslage, ausgangslage_pruefsumme, erwartete_wirkung_prozent, "
                + "erwartete_wirkung_wortlaut, actor_sub, actor_name, actor_rolle, actor_art, angelegt_am) VALUES (?, ?, ?, "
                + "'IK', 'Ines Kaltenbach', 'benutzer', ?::date, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'IK', 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde', ?::timestamptz) RETURNING id", UUID.class, tenant, kennzeichen,
                m.path("titel").asText(), m.path("termin").asText(), s1, herkunft, herkunftKennung, kennzahl, basis,
                kennzahl == null ? null : 1, ausgangslage, ausgangslage == null ? null : BerichtRegeln.pruefsumme(ausgangslage),
                m.at("/erwartete_wirkung/prozent").isNumber() ? m.at("/erwartete_wirkung/prozent").decimalValue() : null,
                m.at("/erwartete_wirkung/wortlaut").asText(), angelegt);
        root.update("UPDATE massnahme SET zustand = 'umgesetzt', umgesetzt_am = ?::date, umgesetzt_begruendung = "
                + "'Umgesetzt wie in der Referenzdatei.', umgesetzt_gemeldet_am = ?::timestamptz WHERE id = ?", umgesetzt,
                umgesetzt + "T12:00:00Z", id);
        return id;
    }

    private void bewertungDirekt(UUID massnahme, JsonNode b, UUID kennzahl, UUID basis, String am) {
        String wirkung = b.path("kopie").isObject() ? BerichtRegeln.kanonisch(b.path("kopie")) : null;
        String summe = wirkung == null ? null : b.path("pruefsumme").asText();
        root.update("INSERT INTO massnahme_bewertung (tenant_id, massnahme_id, kennzahl_id, bezugsbasis_id, fassung, "
                + "wirkung, pruefsumme, ergebnis, begruendung, status, freigabe_sub, freigabe_name, freigabe_rolle, "
                + "freigabe_art, freigabe_am) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'bewertet', 'IK', 'Ines Kaltenbach', "
                + "'energiemanager', 'kunde', ?::timestamptz)", tenant, massnahme, kennzahl, basis,
                kennzahl == null ? null : 1, wirkung, summe, b.path("ergebnis").asText(), b.path("begruendung").asText(), am);
        root.update("UPDATE massnahme SET zustand = 'bewertet' WHERE id = ?", massnahme);
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
        // IP-22: der Stand trägt das Urteil wie in der Referenzdatei (Ausgangslage von M-2028-0001: +12,9 %, schlechter).
        JsonNode urteil = referenz.at("/massnahmen/0/ausgangslage/kopie");
        UUID vbStand = stand(vb, "2028-01-20T10:00:00Z", "{\"kopf\":{\"bericht\":\"BR-2028-0001\"},\"urteil\":"
                + "{\"delta_prozent\":" + urteil.path("delta_prozent").asText() + ",\"urteil\":\""
                + urteil.path("urteil").asText() + "\"}}");
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
        ruf("POST", "/api/v1/massnahmen", "IK", massnahmeKoerper(titel, verantwortlich, termin, herkunft, kennung), 201);
    }

    private static Map<String, Object> massnahmeKoerper(String titel, String verantwortlich, String termin,
            String herkunft, String kennung) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("titel", titel);
        m.put("verantwortlich", verantwortlich);
        m.put("termin", termin);
        m.put("herkunft", herkunft);
        m.put("herkunft_kennung", kennung);
        m.put("erwartete_wirkung_wortlaut", "Zuständigkeit festgelegt; jede Freigabe nennt die zuständige Person.");
        return m;
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
        return stand(bericht, am, "{\"bericht\":\"" + bericht + "\",\"nr\":1}");
    }

    private UUID stand(UUID bericht, String am, String abzug) {
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
