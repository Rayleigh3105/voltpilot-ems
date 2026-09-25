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
 * UEMS AP-19 IP-19 (NW-2): Feststellung und Wirksamkeit über die echte HTTP-, Rechte- und RLS-Kette mit der App-Rolle —
 * R10 und R11 des Konzepts mit den Personen der Referenzdatei 1.10: F-2029-0001 aus AU-2029-0001, festgestellt von
 * Claudia Berger (Controlling, ohne Schreibrecht), verantwortlich Jonas Wendlinger, Frist 22.04.2029; sofortige
 * Behebung, Ursache — Aussage von Ines Kaltenbach — und ähnliche Fälle; M-2029-0001 mit Herkunft
 * {@code nichtkonformitaet}; am 15.04.2029 Stand Nr. 1 {@code wirksam} mit der Prüfsumme der Referenz
 * ({@code dbda6aff…}). Dazu {@code nicht_wirksam} hält offen, Vier-Augen nie die Urheberin, nie der Verantwortliche —
 * und bei zwei Berechtigten „Vier-Augen nicht erfüllbar“ als Antwortfeld (FS6, W15).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class FeststellungApiTest {
    private static final String FESTSTELLUNGEN = "/api/v1/energiemanagement/feststellungen";
    private static final String AUDITS = "/api/v1/energiemanagement/audits";
    private static final String PERSONEN = "/api/v1/energiemanagement/personen";
    private static final String MASSNAHMEN = "/api/v1/massnahmen";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path VEKTOREN = Path.of("../../docs/contracts/v2/energiemanagement-vectors.json");
    private static final Map<String, String> NAMEN = Map.of("IK", "Ines Kaltenbach", "JW", "Jonas Wendlinger",
            "PH", "Peter Hollerbach", "CB", "Claudia Berger", "RF", "Robert Falk", "TB", "Tobias Brandt");
    private static final String WORTLAUT = "Wer die Bezugsbasen pflegt und freigibt und wer vertritt, ist nicht "
            + "festgelegt: an den Bezugsbasen stehen als Verantwortliche die der Kennzahlen (Vorgabe), freigegeben hat "
            + "alle fünf dieselbe Person ohne zweite Prüfung.";
    private static final String BEHEBUNG = "Bis zur Festlegung gibt Ines Kaltenbach keine Bezugsbasis ohne Rücksprache "
            + "mit Jonas Wendlinger frei.";
    private static final String URSACHE = "Die Aufgabenliste entstand zum Start am 01.10.2026, bevor es Bezugsbasen gab "
            + "(ab November 2026); sie wurde nicht nachgeführt. Eine zweite Prüfung ist aus, weil nur zwei Personen "
            + "freigeben dürfen.";
    private static final String AEHNLICH = "Geprüft: Energieziele, Maßnahmen, Bewertung und Messplanung haben eine Person "
            + "in der Aufgabenliste; die Kennzahlen tragen ihre Verantwortlichen. Kein weiterer Fall.";
    private static final String WIRKSAM = "Aufgabe seit 01.03.2029 festgelegt (Ines Kaltenbach, Vertretung Jonas "
            + "Wendlinger, entschieden von Robert Falk); seither keine Freigabe ohne die zuständige Person; die zweite "
            + "Prüfung hat die Leitung am 12.02.2029 entschieden (B4).";
    private static final String NICHT_ERFUELLBAR = "Vier-Augen nicht erfüllbar: außer Ines Kaltenbach und Jonas "
            + "Wendlinger darf niemand freigeben, und beide sind hier beteiligt.";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "ip19_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "ip19_test_pw");
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> "http://127.0.0.1:9/realms/voltpilot");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri", () -> "http://127.0.0.1:9/certs");
    }

    @Autowired MockMvc mvc;
    @Autowired FeststellungService dienst;
    @Autowired InternesAuditService audits;
    @Autowired KennzahlService kennzahlen;
    @Autowired FeststellungVerzeichnis verzeichnis;
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
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Ahrenberg IP-19') RETURNING id", UUID.class);
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
        audits.uhrStellen(Clock.systemUTC());
        kennzahlen.uhrStellen(Clock.systemUTC());
    }

    // ------------------------------------------------------------------ R10: erfassen, Einträge, Maßnahme

    @Test
    void r10ErfassenMitEintraegenUrsacheNurMitPersonUndMassnahmeMitHerkunftFeststellung() throws Exception {
        String au = auditDurchgefuehrt();
        uhr("2029-01-23T10:00:00Z");
        // Ohne „festgestellt von“ keine Feststellung; eine Managementbewertung gibt es vor IP-23 nicht; eine Leserin
        // und „Einsicht“ erfassen nie — und nichts ist geschrieben.
        Map<String, Object> ohne = erfassen(au);
        ohne.remove("festgestellt_von");
        assertThat(ruf("POST", FESTSTELLUNGEN, "IK", ohne, 422).path("code").asText()).isEqualTo("festgestellt_von_fehlt");
        Map<String, Object> mb = erfassen(au);
        mb.put("quelle", Map.of("art", "managementbewertung", "kennung", "BR-2029-0001/B1"));
        assertThat(ruf("POST", FESTSTELLUNGEN, "IK", mb, 422).path("code").asText()).isEqualTo("quelle_unbekannt");
        Map<String, Object> ohneVorgabe = erfassen(au);
        ohneVorgabe.remove("vorgabe");
        assertThat(ruf("POST", FESTSTELLUNGEN, "IK", ohneVorgabe, 422).path("code").asText()).isEqualTo("vorgabe_fehlt");
        for (String wer : List.of("CB", "RF")) {
            assertThat(ruf("POST", FESTSTELLUNGEN, wer, erfassen(au), 403).path("code").asText()).as(wer)
                    .isEqualTo("recht_fehlt");
        }
        assertThat(zeilen()).isZero();

        // F-2029-0001: Quelle „dieses Audit“, festgestellt von Claudia Berger am 22.01.2029, eingetragen von Ines
        // Kaltenbach, verantwortlich Jonas Wendlinger, Frist 22.04.2029 (Vorgabe 90 Tage).
        JsonNode f = ruf("POST", FESTSTELLUNGEN, "IK", erfassen(au), 201);
        String id = f.at("/feststellung/id").asText();
        assertThat(f.at("/feststellung/kennzeichen").asText()).isEqualTo("F-2029-0001");
        assertThat(f.at("/feststellung/quelle/art").asText()).isEqualTo("internes_audit");
        assertThat(f.at("/feststellung/quelle/kennung").asText()).isEqualTo("AU-2029-0001");
        assertThat(f.at("/feststellung/festgestellt_von/kuerzel").asText()).isEqualTo("CB");
        assertThat(f.at("/feststellung/festgestellt_am").asText()).isEqualTo("2029-01-22");
        assertThat(f.at("/feststellung/verantwortlich/sub").asText()).isEqualTo("JW");
        assertThat(f.at("/feststellung/frist").asText()).isEqualTo("2029-04-22");
        assertThat(f.at("/feststellung/zustand").asText()).isEqualTo("offen");
        assertThat(f.at("/feststellung/lage/satz").asText()).isEqualTo("fällig in 89 Tagen");
        assertThat(f.at("/feststellung/bezug/aufgabe").asText()).isEqualTo("bezugsbasen");
        assertThat(werte(f.at("/feststellung/bezug/objekte"))).containsExactly("BB-0001", "BB-0002", "BB-0003",
                "BB-0004", "BB-0005");
        assertThat(f.at("/feststellung/eingetragen/akteur/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(f.at("/verlauf/0/art").asText()).isEqualTo("feststellung_erfasst");
        // Am Audit steht sie als Feststellung (IA2).
        assertThat(werte(ruf("GET", AUDITS + "/" + au, "IK", null, 200).at("/audit/feststellungen")))
                .containsExactly("F-2029-0001");

        // Einträge (FS2): die Ursache ist die Aussage einer Person — ohne Person 422, und nie ein Satz des Systems.
        ruf("POST", FESTSTELLUNGEN + "/" + id + "/eintraege", "IK", eintrag("behebung", BEHEBUNG, "2029-01-23"), 201);
        uhr("2029-01-25T10:00:00Z");
        Map<String, Object> ohnePerson = eintrag("ursache_aussage", URSACHE, "2029-01-25");
        ohnePerson.remove("person_id");
        assertThat(ruf("POST", FESTSTELLUNGEN + "/" + id + "/eintraege", "IK", ohnePerson, 422).path("code").asText())
                .isEqualTo("person_fehlt");
        assertThat(ruf("POST", FESTSTELLUNGEN + "/" + id + "/eintraege", "IK",
                eintrag("ursache_aussage", URSACHE, "2029-01-26"), 422).path("code").asText()).isEqualTo("tag_in_zukunft");
        ruf("POST", FESTSTELLUNGEN + "/" + id + "/eintraege", "IK", eintrag("ursache_aussage", URSACHE, "2029-01-25"), 201);
        JsonNode mitEintraegen = ruf("POST", FESTSTELLUNGEN + "/" + id + "/eintraege", "IK",
                eintrag("aehnliche_faelle", AEHNLICH, "2029-01-25"), 201);
        assertThat(werte(mitEintraegen.path("eintraege"), "art")).containsExactly("behebung", "ursache_aussage",
                "aehnliche_faelle");
        assertThat(mitEintraegen.at("/eintraege/1/person/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(mitEintraegen.at("/eintraege/1/wortlaut").asText()).isEqualTo(URSACHE);
        assertThat(root.queryForObject("SELECT count(*) FROM feststellung_eintrag WHERE tenant_id = ? AND person_id IS NULL",
                Integer.class, tenant)).isZero();

        // Die Maßnahme M-2029-0001 über die AP-18-Route mit Herkunft `nichtkonformitaet` (IP-17); vorher lässt sich
        // die Wirksamkeit nicht prüfen (FS4).
        JsonNode m = massnahme(id, "2029-01-26T10:00:00Z");
        assertThat(m.path("kennzeichen").asText()).isEqualTo("M-2029-0001");
        assertThat(m.at("/herkunft/kennung").asText()).isEqualTo("F-2029-0001");
        JsonNode seite = ruf("GET", FESTSTELLUNGEN + "/" + id, "IK", null, 200);
        assertThat(seite.at("/massnahmen/0/kennzeichen").asText()).isEqualTo("M-2029-0001");
        assertThat(seite.at("/massnahmen/0/zustand").asText()).isEqualTo("geplant");
        assertThat(werte(seite.at("/feststellung/massnahmen"))).containsExactly("M-2029-0001");
        assertThat(seite.at("/feststellung/eintraege").asInt()).isEqualTo(3);
        assertThat(werte(seite.path("verlauf"), "art")).containsExactly("feststellung_erfasst", "eintrag", "eintrag",
                "eintrag");
        uhr("2029-02-12T10:00:00Z");
        JsonNode zuFrueh = ruf("POST", FESTSTELLUNGEN + "/" + id + "/wirksamkeit", "IK", stand("wirksam", WIRKSAM, "IK"), 409);
        assertThat(zuFrueh.path("code").asText()).isEqualTo("wirksamkeit_noch_nicht");
        assertThat(zuFrueh.path("message").asText())
                .isEqualTo("Die Wirksamkeit lässt sich prüfen, sobald jede Maßnahme umgesetzt, bewertet oder verworfen ist.");

        // Liste am 12.02.2029: offen, fällig in 69 Tagen; die Leserin an ST-1 sieht eine Feststellung am Unternehmen nicht.
        JsonNode liste = ruf("GET", FESTSTELLUNGEN + "?tag=2029-02-12", "IK", null, 200);
        assertThat(liste.at("/feststellungen/0/lage/satz").asText()).isEqualTo("fällig in 69 Tagen");
        assertThat(ruf("GET", FESTSTELLUNGEN, "RF", null, 200).path("feststellungen")).hasSize(1);
        assertThat(ruf("GET", FESTSTELLUNGEN, "CB", null, 200).path("feststellungen")).isEmpty();
        ruf("GET", FESTSTELLUNGEN + "/" + id, "CB", null, 404);

        // Verzeichnis-Quelle: F-2029-0001 als Zeile der Gruppe „Interne Audits und Feststellungen“ (R3: am 12.02.2029
        // zählt sie mit), noch ohne Stand; „Wer ist wofür verantwortlich“ nennt Jonas Wendlinger.
        List<Map<String, Object>> vz = alsIk(() -> verzeichnis.zeilen(LocalDate.parse("2029-02-12")));
        assertThat(vz).hasSize(1);
        assertThat(vz.get(0)).containsEntry("gruppe", "audits_feststellungen").containsEntry("art", "feststellung")
                .containsEntry("kennzeichen", "F-2029-0001").containsEntry("tag", "2029-01-22")
                .containsEntry("entschieden_von", "Claudia Berger").containsEntry("eingetragen_von", "Ines Kaltenbach")
                .containsEntry("ort_satz", "in VoltPilot");
        assertThat(alsIk(() -> verzeichnis.zeilen(LocalDate.parse("2029-01-21")))).isEmpty();
        JsonNode verantwortung = ruf("GET", "/api/v1/energiemanagement/verantwortung?tag=2029-02-12", "IK", null, 200);
        JsonNode objekt = null;
        for (JsonNode o : verantwortung.path("objekte")) if (o.path("art").asText().equals("feststellung")) objekt = o;
        assertThat(objekt).isNotNull();
        assertThat(objekt.path("kennzeichen").asText()).isEqualTo("F-2029-0001");
        assertThat(objekt.at("/verantwortlich/name").asText()).isEqualTo("Jonas Wendlinger");
        assertThat(objekt.path("zustand").asText()).isEqualTo("offen");
    }

    // ------------------------------------------------------------------ R11: Wirksamkeit durch eine Person

    @Test
    void r11StandNr1WirksamMitPruefsummeDerReferenzSchliesstAbUndNichtWirksamHaeltOffen() throws Exception {
        String id = r10();
        String massnahme = massnahme(id, "2029-01-26T10:00:00Z").path("id").asText();
        // Umgesetzt am 01.03.2029; die Aufgabe „Bezugsbasen“ ab 01.03.2029 (Ines Kaltenbach, Vertretung Jonas
        // Wendlinger, entschieden von Robert Falk — Beschluss B4).
        kennzahlen.uhrStellen(Clock.fixed(Instant.parse("2029-03-01T10:00:00Z"), ZoneOffset.UTC));
        ruf("POST", MASSNAHMEN + "/" + massnahme + "/umgesetzt", "JW", Map.of("am", "2029-03-01", "begruendung",
                "Aufgabe seit 01.03.2029 Ines Kaltenbach, Vertretung Jonas Wendlinger (entschieden von Robert Falk, "
                        + "Beschluss B4)."), 200);
        Map<String, Object> b4 = new LinkedHashMap<>(Map.of("aufgabe", "bezugsbasen", "person_id", person.get("IK"),
                "gilt_ab", "2029-03-01", "vertretung_person_id", person.get("JW"), "entschieden_von", person.get("RF"),
                "begruendung", "Beschluss B4 der Managementbewertung 2028", "beschluss_kennung", "BR-2029-0001/B4"));
        ManagementbewertungImStand.anlegen(root, tenant, unternehmen, UUID.fromString(person.get("RF")), "BR-2029-0001", 6);
        ruf("POST", "/api/v1/energiemanagement/aufgaben", "JW", b4, 201);

        // 15.04.2029: Stand Nr. 1 `wirksam`, festgehalten von Ines Kaltenbach (nicht der Verantwortliche) — die Kopie
        // ist byte-gleich der Referenz und trägt die Prüfsumme des Vertrags; die Feststellung ist abgeschlossen.
        uhr("2029-04-15T10:00:00Z");
        for (String wer : List.of("PH", "CB", "RF")) {
            ruf("POST", FESTSTELLUNGEN + "/" + id + "/wirksamkeit", wer, stand("wirksam", WIRKSAM, "IK"), 403);
        }
        assertThat(ruf("POST", FESTSTELLUNGEN + "/" + id + "/wirksamkeit", "IK", stand("wirksam", "zu kurz", "IK"), 422)
                .path("code").asText()).isEqualTo("begruendung_fehlt");
        assertThat(ruf("POST", FESTSTELLUNGEN + "/" + id + "/abschliessen", "IK", stand("wirksam", WIRKSAM, "IK"), 422)
                .path("code").asText()).isEqualTo("ergebnis_ungueltig");
        JsonNode zu = ruf("POST", FESTSTELLUNGEN + "/" + id + "/wirksamkeit", "IK", stand("wirksam", WIRKSAM, "IK"), 201);
        JsonNode vektor = vektor("R11 F-2029-0001 Wirksamkeit Stand Nr. 1: Prüfsumme der Kopie");
        assertThat(zu.at("/wirksamkeit/0/nr").asInt()).isEqualTo(1);
        assertThat(zu.at("/wirksamkeit/0/ergebnis").asText()).isEqualTo("wirksam");
        assertThat(zu.at("/wirksamkeit/0/status").asText()).isEqualTo("freigegeben");
        assertThat(zu.at("/wirksamkeit/0/entschieden_von/kuerzel").asText()).isEqualTo("IK");
        assertThat(zu.at("/wirksamkeit/0/pruefsumme").asText()).isEqualTo(vektor.at("/erwartet/pruefsumme").asText())
                .isEqualTo("sha256:dbda6affa5cfa0796bbdcc1ef1f2eb0d1725e7534b404ac9db5b706525f15b04");
        assertThat(root.queryForObject("SELECT kopie FROM feststellung_wirksamkeit WHERE feststellung_id = ?", String.class,
                UUID.fromString(id))).isEqualTo(vektor.at("/erwartet/kanonisch").asText());
        assertThat(zu.at("/feststellung/zustand").asText()).isEqualTo("abgeschlossen");
        assertThat(zu.at("/feststellung/ergebnis").asText()).isEqualTo("wirksam");
        assertThat(zu.at("/feststellung/lage/grund").asText()).isEqualTo("abgeschlossen");
        assertThat(zu.at("/vieraugen/an").asBoolean()).isFalse();
        assertThat(werte(zu.path("verlauf"), "art")).endsWith("feststellung_abgeschlossen");
        // Die Maßnahme behält ihr Vokabular: sie ist „umgesetzt“, nicht „wirksam“ (zwei Träger, W2).
        assertThat(ruf("GET", MASSNAHMEN + "/" + massnahme, "IK", null, 200).path("zustand").asText())
                .isEqualTo("umgesetzt");

        // Ein Stand wird nie zurückgenommen; danach nur noch ein Kommentar (FS7).
        assertThat(ruf("POST", FESTSTELLUNGEN + "/" + id + "/wirksamkeit", "IK", stand("nicht_wirksam", WIRKSAM, "IK"), 409)
                .path("code").asText()).isEqualTo("feststellung_abgeschlossen");
        ruf("POST", FESTSTELLUNGEN + "/" + id + "/abschliessen", "IK", stand("zurueckgenommen", WIRKSAM, "IK"), 409);
        ruf("POST", FESTSTELLUNGEN + "/" + id + "/eintraege", "IK", eintrag("behebung", BEHEBUNG, "2029-04-15"), 409);
        ruf("PUT", FESTSTELLUNGEN + "/" + id + "/frist", "IK", Map.of("frist", "2029-05-31", "begruendung",
                "Frist verlängert wegen Urlaub."), 409);
        ruf("POST", FESTSTELLUNGEN + "/" + id + "/eintraege", "IK", eintrag("kommentar", "Abgeschlossen im Audit 2030 "
                + "nachsehen.", "2029-04-15"), 201);

        // Verzeichnis: dazu der Stand Nr. 1 mit Prüfsumme.
        List<Map<String, Object>> vz = alsIk(() -> verzeichnis.zeilen(LocalDate.parse("2029-04-15")));
        assertThat(vz).hasSize(2);
        assertThat(vz.get(1)).containsEntry("art", "wirksamkeit").containsEntry("nr", 1)
                .containsEntry("tag", "2029-04-15").containsEntry("entschieden_von", "Ines Kaltenbach")
                .containsEntry("pruefsumme", "sha256:dbda6affa5cfa0796bbdcc1ef1f2eb0d1725e7534b404ac9db5b706525f15b04");

        // `nicht_wirksam` hält offen (eine eigene Feststellung mit eigener, umgesetzter Maßnahme), ein zweiter Stand
        // `wirksam` schließt dann ab — Nr. 2.
        String zweite = eigene("Die Unterweisung Zeitschaltung ist bei der Spätschicht nicht angekommen.");
        String m2 = massnahme(zweite, "2029-04-15T10:00:00Z").path("id").asText();
        kennzahlen.uhrStellen(Clock.fixed(Instant.parse("2029-04-15T10:00:00Z"), ZoneOffset.UTC));
        ruf("POST", MASSNAHMEN + "/" + m2 + "/umgesetzt", "JW", Map.of("am", "2029-04-15", "begruendung",
                "Unterweisung am 15.04.2029 nachgeholt."), 200);
        JsonNode offen = ruf("POST", FESTSTELLUNGEN + "/" + zweite + "/wirksamkeit", "IK",
                stand("nicht_wirksam", "Stichprobe: zwei von fünf kennen die Zeitschaltung nicht.", "IK"), 201);
        assertThat(offen.at("/feststellung/zustand").asText()).isEqualTo("offen");
        assertThat(offen.at("/feststellung/ergebnis").isNull()).isTrue();
        assertThat(offen.at("/wirksamkeit/0/ergebnis").asText()).isEqualTo("nicht_wirksam");
        assertThat(werte(offen.path("verlauf"), "art")).endsWith("wirksamkeit_geprueft");
        JsonNode dann = ruf("POST", FESTSTELLUNGEN + "/" + zweite + "/wirksamkeit", "IK",
                stand("wirksam", "Stichprobe: alle fünf kennen die Zeitschaltung.", "IK"), 201);
        assertThat(dann.at("/wirksamkeit/1/nr").asInt()).isEqualTo(2);
        assertThat(dann.at("/feststellung/zustand").asText()).isEqualTo("abgeschlossen");
    }

    // ------------------------------------------------------------------ W15: Vier-Augen

    @Test
    void vierAugenNieUrheberinNieVerantwortlicherUndBeiZweiBerechtigtenNichtErfuellbar() throws Exception {
        String id = r10();
        String massnahme = massnahme(id, "2029-01-26T10:00:00Z").path("id").asText();
        kennzahlen.uhrStellen(Clock.fixed(Instant.parse("2029-03-01T10:00:00Z"), ZoneOffset.UTC));
        ruf("POST", MASSNAHMEN + "/" + massnahme + "/umgesetzt", "JW", Map.of("am", "2029-03-01", "begruendung",
                "Aufgabe seit 01.03.2029 festgelegt."), 200);
        root.update("UPDATE unternehmen SET vieraugen_freigabe = true WHERE tenant_id = ?", tenant);
        uhr("2029-04-15T10:00:00Z");

        // Bei Ahrenberg dürfen nur Ines Kaltenbach und Jonas Wendlinger freigeben: IK prüft (Urheberin), JW ist
        // verantwortlich — niemand bleibt. Die Seite sagt es als Antwortfeld und sperrt nicht still.
        JsonNode seite = ruf("GET", FESTSTELLUNGEN + "/" + id, "IK", null, 200);
        assertThat(seite.at("/vieraugen/an").asBoolean()).isTrue();
        assertThat(seite.at("/vieraugen/erfuellbar").asBoolean()).isFalse();
        assertThat(werte(seite.at("/vieraugen/berechtigte"), "name")).containsExactly("Ines Kaltenbach",
                "Jonas Wendlinger");
        assertThat(seite.at("/vieraugen/zweite_person")).isEmpty();
        assertThat(seite.at("/vieraugen/satz").asText()).isEqualTo(NICHT_ERFUELLBAR)
                .isEqualTo(vektor("§5.8 vieraugen_nicht_erfuellbar").at("/erwartet/satz").asText());
        // Direkt festhalten geht mit Vier-Augen nicht; der Antrag scheitert laut, mit Satz und Personen.
        assertThat(ruf("POST", FESTSTELLUNGEN + "/" + id + "/wirksamkeit", "IK", stand("wirksam", WIRKSAM, "IK"), 409)
                .path("code").asText()).isEqualTo("vieraugen_beantragen");
        JsonNode nicht = ruf("POST", FESTSTELLUNGEN + "/" + id + "/wirksamkeit/beantragen", "IK",
                stand("wirksam", WIRKSAM, "IK"), 409);
        assertThat(nicht.path("code").asText()).isEqualTo("vieraugen_nicht_erfuellbar");
        assertThat(nicht.path("satz").asText()).isEqualTo(NICHT_ERFUELLBAR);
        assertThat(werte(nicht.path("berechtigte"))).containsExactly("Ines Kaltenbach", "Jonas Wendlinger");
        assertThat(root.queryForObject("SELECT count(*) FROM feststellung_wirksamkeit WHERE tenant_id = ?", Integer.class,
                tenant)).isZero();

        // Eine dritte Energiemanagerin (Tobias Brandt) macht es erfüllbar: IK beantragt, TB kann zweite Person sein.
        benutzer("TB", "energiemanager", null);
        JsonNode jetzt = ruf("GET", FESTSTELLUNGEN + "/" + id, "IK", null, 200);
        assertThat(jetzt.at("/vieraugen/erfuellbar").asBoolean()).isTrue();
        assertThat(werte(jetzt.at("/vieraugen/zweite_person"), "sub")).containsExactly("TB");
        assertThat(jetzt.at("/vieraugen/satz").isNull()).isTrue();
        JsonNode antrag = ruf("POST", FESTSTELLUNGEN + "/" + id + "/wirksamkeit/beantragen", "IK",
                stand("wirksam", WIRKSAM, "IK"), 201);
        assertThat(antrag.at("/wirksamkeit/0/status").asText()).isEqualTo("beantragt");
        assertThat(antrag.at("/wirksamkeit/0/vieraugen").asBoolean()).isTrue();
        assertThat(antrag.at("/feststellung/zustand").asText()).isEqualTo("offen");
        // Aus Sicht von JW (verantwortlich) bleibt TB zweite Person — die Urheberin ist die des Antrags.
        assertThat(werte(ruf("GET", FESTSTELLUNGEN + "/" + id, "JW", null, 200).at("/vieraugen/zweite_person"), "sub"))
                .containsExactly("TB");
        // Ein zweiter Antrag wartet; nie die Urheberin, nie der Verantwortliche.
        assertThat(ruf("POST", FESTSTELLUNGEN + "/" + id + "/wirksamkeit/beantragen", "IK",
                stand("wirksam", WIRKSAM, "IK"), 409).path("code").asText()).isEqualTo("wirksamkeit_beantragt");
        assertThat(ruf("POST", FESTSTELLUNGEN + "/" + id + "/wirksamkeit/freigeben", "IK", null, 422).path("code").asText())
                .isEqualTo("vieraugen_urheber");
        assertThat(ruf("POST", FESTSTELLUNGEN + "/" + id + "/wirksamkeit/freigeben", "JW", null, 422).path("code").asText())
                .isEqualTo("vieraugen_verantwortlich");
        ruf("POST", FESTSTELLUNGEN + "/" + id + "/wirksamkeit/freigeben", "RF", null, 403);
        // TB lehnt ab (Nr. 1 bleibt abgelehnt), IK beantragt erneut (Nr. 2), TB gibt frei — abgeschlossen.
        ruf("POST", FESTSTELLUNGEN + "/" + id + "/wirksamkeit/ablehnen", "TB", Map.of("begruendung", "kurz"), 422);
        JsonNode abgelehnt = ruf("POST", FESTSTELLUNGEN + "/" + id + "/wirksamkeit/ablehnen", "TB",
                Map.of("begruendung", "Die Vertretung ist in der Aufgabe noch nicht eingetragen."), 200);
        assertThat(abgelehnt.at("/wirksamkeit/0/status").asText()).isEqualTo("abgelehnt");
        assertThat(abgelehnt.at("/wirksamkeit/0/zweite_person/akteur/name").asText()).isEqualTo("Tobias Brandt");
        ruf("POST", FESTSTELLUNGEN + "/" + id + "/wirksamkeit/freigeben", "TB", null, 409);
        ruf("POST", FESTSTELLUNGEN + "/" + id + "/wirksamkeit/beantragen", "IK", stand("wirksam", WIRKSAM, "IK"), 201);
        JsonNode frei = ruf("POST", FESTSTELLUNGEN + "/" + id + "/wirksamkeit/freigeben", "TB", null, 200);
        assertThat(frei.at("/wirksamkeit/1/nr").asInt()).isEqualTo(2);
        assertThat(frei.at("/wirksamkeit/1/status").asText()).isEqualTo("freigegeben");
        assertThat(frei.at("/feststellung/zustand").asText()).isEqualTo("abgeschlossen");
        assertThat(werte(frei.path("verlauf"), "art")).containsSubsequence("wirksamkeit_beantragt",
                "wirksamkeit_abgelehnt", "wirksamkeit_beantragt", "feststellung_abgeschlossen");
    }

    // ------------------------------------------------------------------ Recht, Einsicht, Frist, Abschluss ohne Maßnahme

    @Test
    void schreibroutenOhneRecht403AuchEinsichtFristVerantwortlichUndAbschlussOhneMassnahme() throws Exception {
        String id = r10();
        int vorher = zeilen();
        uhr("2029-02-12T10:00:00Z");
        // Leserin und „Einsicht“ haben kein energiemanagement.verwalten (403); der Bearbeiter an ST-2 hat es dort und
        // kommt bis zum Dienst — eine Feststellung am Unternehmen gibt es für ihn nicht (404, der Zaun vor dem Recht).
        for (String wer : List.of("PH", "CB", "RF")) {
            int verwalten = wer.equals("PH") ? 404 : 403;
            ruf("POST", FESTSTELLUNGEN + "/" + id + "/eintraege", wer, eintrag("kommentar", "Gelesen.", "2029-02-12"),
                    verwalten);
            ruf("PUT", FESTSTELLUNGEN + "/" + id + "/frist", wer, Map.of("frist", "2029-05-31", "begruendung",
                    "Frist verlängert wegen Urlaub."), verwalten);
            ruf("PUT", FESTSTELLUNGEN + "/" + id + "/verantwortlicher", wer, Map.of("verantwortlich", "IK",
                    "begruendung", "Übergabe an Ines Kaltenbach."), verwalten);
            for (String weg : List.of("wirksamkeit", "wirksamkeit/beantragen", "abschliessen")) {
                ruf("POST", FESTSTELLUNGEN + "/" + id + "/" + weg, wer, stand("ohne_massnahme", WIRKSAM, "IK"), 403);
            }
            ruf("POST", FESTSTELLUNGEN + "/" + id + "/wirksamkeit/freigeben", wer, null, 403);
            ruf("POST", FESTSTELLUNGEN + "/" + id + "/wirksamkeit/ablehnen", wer, Map.of("begruendung",
                    "Nicht nachvollziehbar."), 403);
        }
        assertThat(zeilen()).isEqualTo(vorher);

        // Am Standort des Bezugs (RE1): der Bearbeiter erfasst an ST-2 und hält dort einen Eintrag fest, an ST-1 nicht.
        Map<String, Object> st2 = new LinkedHashMap<>(Map.of("quelle", Map.of("art", "eigene"), "wortlaut",
                "Die Druckluft-Leckageliste an ST-2 ist seit März nicht nachgeführt.", "vorgabe",
                Map.of("wortlaut", "Kriterien für Betrieb und Instandhaltung"), "bezug", Map.of("standort_id",
                        s2.toString()), "festgestellt_von", person.get("JW"), "verantwortlich", "PH"));
        String amStandort = ruf("POST", FESTSTELLUNGEN, "PH", st2, 201).at("/feststellung/id").asText();
        ruf("POST", FESTSTELLUNGEN + "/" + amStandort + "/eintraege", "PH", eintrag("behebung",
                "Liste am 12.02.2029 nachgeführt.", "2029-02-12"), 201);
        st2.put("bezug", Map.of("standort_id", s1.toString()));
        assertThat(ruf("POST", FESTSTELLUNGEN, "PH", st2, 422).path("code").asText()).isEqualTo("standort_unbekannt");
        assertThat(ruf("GET", FESTSTELLUNGEN, "PH", null, 200).path("feststellungen")).hasSize(1);

        // Frist und Verantwortlich ändern sich offen nur mit Begründung; eine Frist vor dem Tag der Feststellung nie.
        assertThat(ruf("PUT", FESTSTELLUNGEN + "/" + id + "/frist", "IK", Map.of("frist", "2029-05-31"), 422)
                .path("code").asText()).isEqualTo("begruendung_fehlt");
        assertThat(ruf("PUT", FESTSTELLUNGEN + "/" + id + "/frist", "IK", Map.of("frist", "2029-01-01", "begruendung",
                "Frist verlängert wegen Urlaub."), 422).path("code").asText()).isEqualTo("frist_ungueltig");
        JsonNode frist = ruf("PUT", FESTSTELLUNGEN + "/" + id + "/frist", "IK", Map.of("frist", "2029-05-31",
                "begruendung", "Frist verlängert wegen Urlaub."), 200);
        assertThat(frist.at("/feststellung/frist").asText()).isEqualTo("2029-05-31");
        JsonNode geaendert = ruf("PUT", FESTSTELLUNGEN + "/" + id + "/verantwortlicher", "JW", Map.of("verantwortlich",
                "IK", "begruendung", "Übergabe an Ines Kaltenbach."), 200);
        assertThat(geaendert.at("/feststellung/verantwortlich/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(werte(geaendert.path("verlauf"), "art")).endsWith("feststellung_geaendert", "feststellung_geaendert");
        assertThat(geaendert.at("/verlauf/5/begruendung").asText()).isEqualTo("Übergabe an Ines Kaltenbach.");

        // Abschluss ohne Maßnahme: ohne Begründung nie, `wirksam` hier nie; `ohne_massnahme` schließt ab, ein Stand
        // mit Kopie und Prüfsumme.
        assertThat(ruf("POST", FESTSTELLUNGEN + "/" + id + "/abschliessen", "JW", stand("wirksam", WIRKSAM, "JW"), 422)
                .path("code").asText()).isEqualTo("ergebnis_ungueltig");
        JsonNode ohne = ruf("POST", FESTSTELLUNGEN + "/" + id + "/abschliessen", "JW", stand("ohne_massnahme",
                "Die sofortige Behebung genügt; die Aufgabe ist seither festgelegt.", "JW"), 201);
        assertThat(ohne.at("/feststellung/zustand").asText()).isEqualTo("abgeschlossen");
        assertThat(ohne.at("/feststellung/ergebnis").asText()).isEqualTo("ohne_massnahme");
        assertThat(ohne.at("/wirksamkeit/0/pruefsumme").asText()).startsWith("sha256:");
        assertThat(ohne.at("/wirksamkeit/0/kopie/aufgabe/person").isNull()).isTrue();
        assertThat(root.queryForObject("SELECT pruefsumme = bericht_pruefsumme(kopie) FROM feststellung_wirksamkeit "
                + "WHERE feststellung_id = ?", Boolean.class, UUID.fromString(id))).isTrue();
        // Eine neue Nichterfüllung ist eine neue Feststellung (FS7); `zurueckgenommen` schließt sie ebenso.
        String neu = eigene("Die Feststellung F-2029-0001 ist erneut aufgetreten: BB-0003 ohne zweite Prüfung.");
        JsonNode zurueck = ruf("POST", FESTSTELLUNGEN + "/" + neu + "/abschliessen", "IK", stand("zurueckgenommen",
                "Irrtum: die zweite Prüfung stand im Protokoll der Bezugsbasis.", "IK"), 201);
        assertThat(zurueck.at("/feststellung/kennzeichen").asText()).isEqualTo("F-2029-0003");
        assertThat(zurueck.at("/feststellung/ergebnis").asText()).isEqualTo("zurueckgenommen");
    }

    // ------------------------------------------------------------------ Hilfen

    /** R10 bis zu den drei Einträgen — die Feststellung F-2029-0001 (ohne Maßnahme). */
    private String r10() throws Exception {
        String au = auditDurchgefuehrt();
        uhr("2029-01-23T10:00:00Z");
        String id = ruf("POST", FESTSTELLUNGEN, "IK", erfassen(au), 201).at("/feststellung/id").asText();
        ruf("POST", FESTSTELLUNGEN + "/" + id + "/eintraege", "IK", eintrag("behebung", BEHEBUNG, "2029-01-23"), 201);
        uhr("2029-01-25T10:00:00Z");
        ruf("POST", FESTSTELLUNGEN + "/" + id + "/eintraege", "IK", eintrag("ursache_aussage", URSACHE, "2029-01-25"), 201);
        ruf("POST", FESTSTELLUNGEN + "/" + id + "/eintraege", "IK", eintrag("aehnliche_faelle", AEHNLICH, "2029-01-25"), 201);
        return id;
    }

    /** AU-2029-0001, geplant am 10.01.2029, durchgeführt am 22.01.2029 (IP-18). */
    private String auditDurchgefuehrt() throws Exception {
        audits.uhrStellen(Clock.fixed(Instant.parse("2029-01-10T09:00:00Z"), ZoneOffset.UTC));
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("titel", "Internes Audit 2029: Bezugsbasen, Energieziele, Maßnahmen und Grundlagen");
        b.put("termin", "2029-01-22");
        b.put("auditor_ids", List.of(person.get("CB")));
        b.put("unabhaengigkeit", "Claudia Berger (Controlling) gehört nicht zum Energieteam und prüft keine eigene Arbeit.");
        b.put("was", "Bezugsbasen, Energieziel, Maßnahmen und Grundlagen");
        b.put("woran", "Energiepolitik D-0001 Fassung 1, Aufgaben im Energiemanagement");
        b.put("verantwortlich", "IK");
        String id = ruf("POST", AUDITS, "IK", b, 201).at("/audit/id").asText();
        audits.uhrStellen(Clock.fixed(Instant.parse("2029-01-22T15:00:00Z"), ZoneOffset.UTC));
        ruf("POST", AUDITS + "/" + id + "/durchgefuehrt", "IK", Map.of("am", "2029-01-22"), 200);
        return id;
    }

    private Map<String, Object> erfassen(String audit) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("quelle", Map.of("art", "internes_audit", "audit_id", audit));
        b.put("wortlaut", WORTLAUT);
        b.put("vorgabe", Map.of("wortlaut", "„Wir legen fest, wer im Energiemanagement wofür zuständig ist.“"));
        b.put("bezug", Map.of("aufgabe", "bezugsbasen", "objekte", List.of("BB-0001", "BB-0002", "BB-0003", "BB-0004",
                "BB-0005")));
        b.put("festgestellt_von", person.get("CB"));
        b.put("festgestellt_am", "2029-01-22");
        b.put("verantwortlich", "JW");
        return b;
    }

    /** Eine eigene Feststellung am Tag der Uhr, festgestellt von Ines Kaltenbach, verantwortlich Jonas Wendlinger. */
    private String eigene(String wortlaut) throws Exception {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("quelle", Map.of("art", "eigene"));
        b.put("wortlaut", wortlaut);
        b.put("vorgabe", Map.of("wortlaut", "Aufgaben im Energiemanagement"));
        b.put("festgestellt_von", person.get("IK"));
        b.put("verantwortlich", "JW");
        return ruf("POST", FESTSTELLUNGEN, "IK", b, 201).at("/feststellung/id").asText();
    }

    private Map<String, Object> eintrag(String art, String wortlaut, String am) {
        return new LinkedHashMap<>(Map.of("art", art, "wortlaut", wortlaut, "person_id", person.get("IK"), "am", am));
    }

    private Map<String, Object> stand(String ergebnis, String begruendung, String von) {
        Map<String, Object> b = new LinkedHashMap<>(Map.of("ergebnis", ergebnis, "begruendung", begruendung));
        if (von != null) b.put("entschieden_von", person.get(von));
        return b;
    }

    /** Eine AP-18-Maßnahme mit Herkunft dieser Feststellung (IP-17), verantwortlich Jonas Wendlinger. */
    private JsonNode massnahme(String feststellung, String jetzt) throws Exception {
        String kennung = ruf("GET", FESTSTELLUNGEN + "/" + feststellung, "IK", null, 200).at("/feststellung/kennzeichen")
                .asText();
        kennzahlen.uhrStellen(Clock.fixed(Instant.parse(jetzt), ZoneOffset.UTC));
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("titel", "Aufgabe „Bezugsbasen pflegen und freigeben“ festlegen und über die zweite Prüfung entscheiden");
        m.put("verantwortlich", "JW");
        m.put("termin", "2029-04-30");
        m.put("herkunft", "nichtkonformitaet");
        m.put("herkunft_kennung", kennung);
        m.put("erwartete_wirkung_wortlaut", "Zuständigkeit festgelegt; jede Freigabe einer Bezugsbasis nennt die "
                + "zuständige Person und ihre Vertretung.");
        return ruf("POST", MASSNAHMEN, "IK", m, 201);
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
        return root.queryForObject("SELECT (SELECT count(*) FROM feststellung WHERE tenant_id=?) + (SELECT count(*) "
                + "FROM feststellung_eintrag WHERE tenant_id=?) + (SELECT count(*) FROM feststellung_wirksamkeit WHERE "
                + "tenant_id=?) + (SELECT count(*) FROM energiemanagement_aenderung WHERE tenant_id=? AND "
                + "objekt='feststellung')", Integer.class, tenant, tenant, tenant, tenant);
    }

    private static List<String> werte(JsonNode liste, String feld) {
        List<String> w = new ArrayList<>();
        liste.forEach(e -> w.add(e.path(feld).asText()));
        return w;
    }

    private static List<String> werte(JsonNode liste) {
        List<String> w = new ArrayList<>();
        liste.forEach(e -> w.add(e.asText()));
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
        String text = r.getContentAsString(StandardCharsets.UTF_8);
        return text.isEmpty() ? JSON.nullNode() : JSON.readTree(text);
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
