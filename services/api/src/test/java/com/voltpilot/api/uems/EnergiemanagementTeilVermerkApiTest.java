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
 * Konzept Nachweisen n1, Runde 2, Entscheid 5 (NW-2): „Trifft bei uns zurzeit nicht zu“ über die echte HTTP-, Rechte-
 * und RLS-Kette mit der App-Rolle, in der Welt des Kunststoffwerks Ahrenberg am 30.04.2029: Ines Kaltenbach vermerkt
 * „Risiken und Chancen“, entschieden von Robert Falk (ohne Konto); ein zweiter geltender Vermerk für denselben Teil ist
 * 409, aufgehoben wird einmal, danach ist der Teil wieder frei. Schreiben nur mit {@code energiemanagement.verwalten}
 * am Unternehmen (auch „Einsicht“ 403); lesen nur unternehmensweit, ein fremder Kundenbereich sieht nichts. Im
 * Verzeichnis steht jeder Vermerk in der Gruppe seines Teils, ein aufgehobener mit „· aufgehoben am …“.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class EnergiemanagementTeilVermerkApiTest {
    private static final String BASIS = "/api/v1/energiemanagement";
    private static final String VERMERKE = BASIS + "/teil-vermerke";
    private static final String VERZEICHNIS = BASIS + "/verzeichnis";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Map<String, String> NAMEN = Map.of("IK", "Ines Kaltenbach", "JW", "Jonas Wendlinger",
            "PH", "Peter Hollerbach", "CB", "Claudia Berger", "MD", "Murat Demirci", "RF", "Robert Falk",
            "FR", "Frieda Fremd");
    private static final String SATZ_RC = "Risiken und Chancen bewerten wir im Jahresgespräch der Geschäftsführung.";
    private static final String SATZ_KONTEXT = "Kontext und interessierte Parteien stehen im Handbuch der Gruppe.";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "n1_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "n1_test_pw");
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> "http://127.0.0.1:9/realms/voltpilot");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri", () -> "http://127.0.0.1:9/certs");
        r.add("voltpilot.uems.kennzahlen.enabled", () -> "false");
    }

    @Autowired MockMvc mvc;
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
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Ahrenberg n1') RETURNING id", UUID.class);
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
        fremd = root.queryForObject("INSERT INTO tenant(name) VALUES ('Fremd n1') RETURNING id", UUID.class);
        root.update("INSERT INTO unternehmen(tenant_id,name,zeitzone) VALUES (?,'Fremd GmbH','Europe/Berlin')", fremd);
        benutzer(fremd, "FR", "energiemanager", null);
        heute("2029-04-30T08:00:00Z");
        rf = id(person("Robert Falk", "Geschäftsführer", "RF", null));
        ik = id(person("Ines Kaltenbach", "Energiemanagement", "IK", "IK"));
    }

    @AfterEach
    void uhrZurueck() {
        vermerke.uhrStellen(Clock.systemUTC());
        verzeichnis.uhrStellen(Clock.systemUTC());
    }

    // ------------------------------------------------------------------ vermerken, lesen, doppelt, aufheben

    @Test
    void vermerkenLesenDoppelt409AufhebenEinmalUndDerTeilIstWiederFrei() throws Exception {
        JsonNode rc = ruf("POST", VERMERKE, "IK", Map.of("teil", "risiken_chancen", "satz", "  " + SATZ_RC + "  ",
                "entschieden_von", rf), 201);
        assertThat(felder(rc)).containsExactly("id", "teil", "teil_wort", "satz", "entschieden_von", "entschieden_am",
                "eingetragen", "aufgehoben");
        assertThat(rc.path("teil").asText()).isEqualTo("risiken_chancen");
        assertThat(rc.path("teil_wort").asText()).isEqualTo("Risiken und Chancen");
        assertThat(rc.path("satz").asText()).as("ohne Leerraum am Rand").isEqualTo(SATZ_RC);
        assertThat(rc.at("/entschieden_von/id").asText()).isEqualTo(rf);
        assertThat(rc.at("/entschieden_von/name").asText()).isEqualTo("Robert Falk");
        assertThat(rc.at("/entschieden_von/funktion").asText()).isEqualTo("Geschäftsführer");
        assertThat(rc.at("/entschieden_von/kuerzel").asText()).isEqualTo("RF");
        assertThat(rc.at("/entschieden_von/mit_konto").asBoolean()).isFalse();
        assertThat(rc.path("entschieden_am").asText()).as("ohne Tag: heute in der Zone des Unternehmens")
                .isEqualTo("2029-04-30");
        assertThat(rc.at("/eingetragen/akteur/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(rc.at("/eingetragen/akteur/sub").asText()).isEqualTo("IK");
        assertThat(rc.at("/eingetragen/akteur/rolle").asText()).isEqualTo("energiemanager");
        assertThat(rc.at("/eingetragen/akteur/art").asText()).isEqualTo("kunde");
        assertThat(Instant.parse(rc.at("/eingetragen/am").asText())).isEqualTo(Instant.parse("2029-04-30T08:00:00Z"));
        assertThat(rc.path("aufgehoben").isNull()).isTrue();

        // Höchstens ein geltender Vermerk je Teil.
        JsonNode doppelt = ruf("POST", VERMERKE, "JW", Map.of("teil", "risiken_chancen", "satz", SATZ_RC,
                "entschieden_von", rf), 409);
        assertThat(doppelt.path("code").asText()).isEqualTo("vermerk_besteht");
        assertThat(doppelt.path("teil").asText()).isEqualTo("risiken_chancen");
        JsonNode kontext = ruf("POST", VERMERKE, "JW", Map.of("teil", "kontext", "satz", SATZ_KONTEXT,
                "entschieden_von", ik, "entschieden_am", "2029-03-15"), 201);
        assertThat(kontext.path("entschieden_am").asText()).isEqualTo("2029-03-15");
        assertThat(kontext.at("/entschieden_von/mit_konto").asBoolean()).isTrue();
        assertThat(kontext.at("/eingetragen/akteur/rolle").asText()).isEqualTo("kundenadministrator");

        // Lesen: Stichtag in der Zone des Unternehmens; geltende in der Folge des Vokabulars (kontext vor risiken_chancen).
        JsonNode liste = ruf("GET", VERMERKE, "IK", null, 200);
        assertThat(felder(liste)).containsExactly("stichtag", "vermerke");
        assertThat(liste.path("stichtag").asText()).startsWith("2029-04-30T10:00");
        assertThat(texte(liste.path("vermerke"), "teil")).containsExactly("kontext", "risiken_chancen");

        // Aufheben: einmal, jetzt, mit dem Akteur; danach endgültig.
        heute("2029-05-02T07:30:00Z");
        JsonNode aufgehoben = ruf("POST", VERMERKE + "/" + id(rc) + "/aufheben", "JW", null, 200);
        assertThat(aufgehoben.at("/aufgehoben/akteur/name").asText()).isEqualTo("Jonas Wendlinger");
        assertThat(aufgehoben.at("/aufgehoben/akteur/rolle").asText()).isEqualTo("kundenadministrator");
        assertThat(Instant.parse(aufgehoben.at("/aufgehoben/am").asText()))
                .isEqualTo(Instant.parse("2029-05-02T07:30:00Z"));
        assertThat(aufgehoben.path("satz").asText()).isEqualTo(SATZ_RC);
        assertThat(aufgehoben.at("/eingetragen/akteur/name").asText()).as("das Eintragen bleibt").isEqualTo("Ines Kaltenbach");
        JsonNode zweimal = ruf("POST", VERMERKE + "/" + id(rc) + "/aufheben", "IK", Map.of(), 409);
        assertThat(zweimal.path("code").asText()).isEqualTo("vermerk_aufgehoben");
        assertThat(Instant.parse(zweimal.path("aufgehoben_am").asText())).isEqualTo(Instant.parse("2029-05-02T07:30:00Z"));

        // Der Teil ist wieder frei: ein neuer Vermerk, der alte bleibt daneben stehen.
        JsonNode neu = ruf("POST", VERMERKE, "IK", Map.of("teil", "risiken_chancen", "satz", SATZ_RC + " Neu gefasst.",
                "entschieden_von", rf), 201);
        assertThat(id(neu)).isNotEqualTo(id(rc));
        heute("2029-05-03T07:30:00Z");
        ruf("POST", VERMERKE + "/" + id(kontext) + "/aufheben", "IK", null, 200);
        JsonNode danach = ruf("GET", VERMERKE, "IK", null, 200);
        assertThat(texte(danach.path("vermerke"), "id")).as("geltend zuerst, dann die zuletzt aufgehobene zuerst")
                .containsExactly(id(neu), id(kontext), id(rc));
        assertThat(danach.path("vermerke").get(0).path("aufgehoben").isNull()).isTrue();
        assertThat(root.queryForObject("SELECT count(*) FROM energiemanagement_teil_vermerk WHERE tenant_id = ?",
                Integer.class, tenant)).isEqualTo(3);

        // Keine Löschroute.
        assertThat(roh("DELETE", VERMERKE, "IK", null).getStatus()).isEqualTo(405);
    }

    // ------------------------------------------------------------------ jede Ablehnung

    @Test
    void jedeAblehnungUndMandantNieAusDemKoerper() throws Exception {
        Map<String, Object> gut = new LinkedHashMap<>(Map.of("teil", "risiken_chancen", "satz", SATZ_RC,
                "entschieden_von", rf));
        List<Object[]> faelle = List.of(
                new Object[] {"teil", "sonstiges", 400, "anfrage_ungueltig", "teil"},
                new Object[] {"teil", null, 400, "anfrage_ungueltig", "teil"},
                new Object[] {"satz", "zu kurz", 400, "anfrage_ungueltig", "satz"},
                new Object[] {"satz", "   Neun Zei   ", 400, "anfrage_ungueltig", "satz"},
                new Object[] {"satz", "x".repeat(501), 400, "anfrage_ungueltig", "satz"},
                new Object[] {"satz", null, 400, "anfrage_ungueltig", "satz"},
                new Object[] {"entschieden_von", null, 422, "entschieden_von_fehlt", "entschieden_von"},
                new Object[] {"entschieden_von", UUID.randomUUID().toString(), 404, "nicht_gefunden", null},
                new Object[] {"entschieden_am", "2029-05-01", 422, "tag_in_zukunft", "entschieden_am"},
                new Object[] {"entschieden_am", "30.04.2029", 400, "anfrage_ungueltig", ""},
                new Object[] {"tenant_id", fremd.toString(), 400, "anfrage_ungueltig", "tenant_id"});
        for (Object[] f : faelle) {
            Map<String, Object> a = new LinkedHashMap<>(gut);
            a.put((String) f[0], f[1]);
            JsonNode antwort = ruf("POST", VERMERKE, "IK", a, (int) f[2]);
            assertThat(antwort.path("code").asText()).as(f[0] + "=" + f[1]).isEqualTo(f[3]);
            if (f[4] != null) {
                assertThat(antwort.path("feld").asText()).as(f[0] + "=" + f[1]).isEqualTo(f[4]);
            }
        }
        JsonNode kurz = ruf("POST", VERMERKE, "IK", Map.of("teil", "kontext", "satz", "zu kurz", "entschieden_von", rf),
                400);
        assertThat(kurz.path("min").asInt()).isEqualTo(10);
        assertThat(kurz.path("max").asInt()).isEqualTo(500);
        assertThat(ruf("POST", VERMERKE, "IK", List.of(gut), 400).path("code").asText()).isEqualTo("anfrage_ungueltig");

        // Genau 10 und genau 500 Zeichen tragen (die Grenzen zählen mit).
        ruf("POST", VERMERKE, "IK", Map.of("teil", "kontext", "satz", "Zehn Zeich", "entschieden_von", rf), 201);
        ruf("POST", VERMERKE, "IK", Map.of("teil", "berichte", "satz", "y".repeat(500), "entschieden_von", rf), 201);

        // Eine Person nach ihrem „bis“ entscheidet nichts mehr; der letzte Tag zählt mit.
        root.update("UPDATE energiemanagement_person SET bis = '2029-01-31', zustand = 'beendet', "
                + "beendet_begruendung = 'Wechsel in ein anderes Werk' WHERE id = ?::uuid", ik);
        JsonNode beendet = ruf("POST", VERMERKE, "IK", Map.of("teil", "aufgaben", "satz", SATZ_RC, "entschieden_von", ik,
                "entschieden_am", "2029-02-01"), 422);
        assertThat(beendet.path("code").asText()).isEqualTo("person_beendet");
        assertThat(beendet.path("bis").asText()).isEqualTo("2029-01-31");
        ruf("POST", VERMERKE, "IK", Map.of("teil", "aufgaben", "satz", SATZ_RC, "entschieden_von", ik,
                "entschieden_am", "2029-01-31"), 201);

        // Eine Person eines anderen Kundenbereichs gibt es hier nicht.
        UUID fremdePerson = root.queryForObject("INSERT INTO energiemanagement_person(tenant_id,name,funktion,actor_name,"
                + "actor_art) VALUES (?,'Fremd','Fremd','VoltPilot','voltpilot') RETURNING id", UUID.class, fremd);
        Map<String, Object> fremdeEntscheidung = new LinkedHashMap<>(gut);
        fremdeEntscheidung.put("entschieden_von", fremdePerson.toString());
        assertThat(ruf("POST", VERMERKE, "IK", fremdeEntscheidung, 404).path("message").asText())
                .isEqualTo("Diese Person gibt es nicht.");
        assertThat(texte(ruf("GET", VERMERKE, "IK", null, 200).path("vermerke"), "teil"))
                .containsExactly("kontext", "aufgaben", "berichte");

        // Aufheben: unbekannt oder keine ID 404.
        assertThat(ruf("POST", VERMERKE + "/" + UUID.randomUUID() + "/aufheben", "IK", null, 404).path("message").asText())
                .isEqualTo("Diesen Vermerk gibt es nicht.");
        assertThat(ruf("POST", VERMERKE + "/keine-id/aufheben", "IK", null, 404).path("code").asText())
                .isEqualTo("nicht_gefunden");
    }

    // ------------------------------------------------------------------ Rechte und Zaun

    @Test
    void ohneVerwaltenAmUnternehmenAuchEinsicht403UndLesenNurUnternehmensweitImEigenenMandanten() throws Exception {
        JsonNode rc = ruf("POST", VERMERKE, "IK", Map.of("teil", "risiken_chancen", "satz", SATZ_RC,
                "entschieden_von", rf), 201);
        for (String wer : List.of("PH", "MD", "CB", "RF")) {
            for (String[] weg : List.of(new String[] {VERMERKE, "{\"teil\":\"kontext\",\"satz\":\"" + SATZ_KONTEXT
                    + "\",\"entschieden_von\":\"" + rf + "\"}"}, new String[] {VERMERKE + "/" + id(rc) + "/aufheben", "{}"})) {
                MockHttpServletResponse r = mvc.perform(request(HttpMethod.POST, weg[0]).with(authentication(token(wer)))
                        .contentType(MediaType.APPLICATION_JSON).content(weg[1])).andReturn().getResponse();
                JsonNode a = JSON.readTree(r.getContentAsString(StandardCharsets.UTF_8));
                assertThat(r.getStatus()).as(wer + " " + weg[0]).isEqualTo(403);
                assertThat(a.path("code").asText()).as(wer + " " + weg[0]).isEqualTo("recht_fehlt");
                assertThat(a.path("recht").asText()).isEqualTo("energiemanagement.verwalten");
            }
        }
        assertThat(root.queryForObject("SELECT count(*) FROM energiemanagement_teil_vermerk WHERE tenant_id = ? "
                + "AND aufgehoben_am IS NULL", Integer.class, tenant)).as("nichts geschrieben, nichts aufgehoben").isOne();

        // Einsicht liest unternehmensweit; wer nur Standorte liest, bekommt keinen Vermerk, ohne Hinweis.
        assertThat(texte(ruf("GET", VERMERKE, "RF", null, 200).path("vermerke"), "teil")).containsExactly("risiken_chancen");
        for (String wer : List.of("PH", "CB")) {
            JsonNode eng = ruf("GET", VERMERKE, wer, null, 200);
            assertThat(eng.path("vermerke")).as(wer).isEmpty();
            assertThat(eng.path("stichtag").asText()).startsWith("2029-04-30T10:00");
        }
        // Ein fremder Kundenbereich sieht nichts und hebt nichts auf.
        assertThat(ruf("GET", VERMERKE, "FR", null, 200).path("vermerke")).isEmpty();
        assertThat(ruf("POST", VERMERKE + "/" + id(rc) + "/aufheben", "FR", null, 404).path("code").asText())
                .isEqualTo("nicht_gefunden");
        assertThat(root.queryForObject("SELECT aufgehoben_am IS NULL FROM energiemanagement_teil_vermerk WHERE id = ?::uuid",
                Boolean.class, id(rc))).isTrue();
    }

    // ------------------------------------------------------------------ im Verzeichnis

    @Test
    void imVerzeichnisInDerGruppeSeinesTeilsMitPersonenUndDemZusatzAufgehoben() throws Exception {
        heute("2029-03-15T09:00:00Z");
        JsonNode rc = ruf("POST", VERMERKE, "IK", Map.of("teil", "risiken_chancen", "satz", SATZ_RC,
                "entschieden_von", rf), 201);
        heute("2029-04-20T09:00:00Z");
        ruf("POST", VERMERKE + "/" + id(rc) + "/aufheben", "JW", null, 200);
        heute("2029-04-30T08:00:00Z");
        ruf("POST", VERMERKE, "IK", Map.of("teil", "aufgaben", "satz", SATZ_RC, "entschieden_von", rf), 201);
        ruf("POST", VERMERKE, "IK", Map.of("teil", "interne_audits", "satz", SATZ_RC, "entschieden_von", ik,
                "entschieden_am", "2029-04-01"), 201);

        abruf("2029-04-30T08:00:00Z");
        JsonNode v = ruf("GET", VERZEICHNIS, "IK", null, 200);
        JsonNode z = zeile(v, "risiken_chancen", "Risiken und Chancen");
        assertThat(z.path("titel").asText())
                .isEqualTo("Risiken und Chancen: trifft bei uns zurzeit nicht zu · aufgehoben am 20.04.2029");
        assertThat(z.path("gruppe_wort").asText()).isEqualTo("Risiken und Chancen");
        assertThat(z.path("nr").isNull()).isTrue();
        assertThat(z.path("entschieden_von").asText()).isEqualTo("Robert Falk");
        assertThat(z.path("eingetragen_von").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(z.path("tag").asText()).isEqualTo("2029-03-15");
        assertThat(z.path("pruefsumme").isNull()).isTrue();
        assertThat(z.path("ort").asText()).isEqualTo("in_voltpilot");
        assertThat(z.path("ort_satz").asText()).isEqualTo("in VoltPilot");
        assertThat(zeile(v, "verantwortung", "Aufgaben im Energiemanagement").path("titel").asText())
                .isEqualTo("Aufgaben im Energiemanagement: trifft bei uns zurzeit nicht zu");
        JsonNode audits = zeile(v, "audits_feststellungen", "Interne Audits");
        assertThat(audits.path("titel").asText()).isEqualTo("Interne Audits: trifft bei uns zurzeit nicht zu");
        assertThat(audits.path("entschieden_von").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(audits.path("tag").asText()).isEqualTo("2029-04-01");
        assertThat(alle(v).stream().filter(x -> x.path("art").asText().equals("teil_vermerk"))).hasSize(3);

        // „in meinem Namen festgehalten“: Robert Falk ist „entschieden von“ zweier Vermerke.
        JsonNode meine = ruf("GET", VERZEICHNIS + "?person=" + rf, "RF", null, 200);
        assertThat(alle(meine).stream().filter(x -> x.path("art").asText().equals("teil_vermerk"))
                .map(x -> x.path("kennzeichen").asText())).containsExactlyInAnyOrder("Risiken und Chancen",
                        "Aufgaben im Energiemanagement");

        // Am Stichtag 10.04.2029: noch nicht aufgehoben, und der Vermerk vom 30.04.2029 ist noch nicht festgehalten.
        abruf("2029-04-10T08:00:00Z");
        JsonNode april = ruf("GET", VERZEICHNIS, "IK", null, 200);
        assertThat(zeile(april, "risiken_chancen", "Risiken und Chancen").path("titel").asText())
                .isEqualTo("Risiken und Chancen: trifft bei uns zurzeit nicht zu");
        assertThat(alle(april).stream().filter(x -> x.path("art").asText().equals("teil_vermerk"))
                .map(x -> x.path("kennzeichen").asText())).containsExactlyInAnyOrder("Risiken und Chancen",
                        "Interne Audits");
        // Vor dem 15.03.2029 steht nichts da.
        abruf("2029-03-14T08:00:00Z");
        assertThat(alle(ruf("GET", VERZEICHNIS, "IK", null, 200)).stream()
                .filter(x -> x.path("art").asText().equals("teil_vermerk"))).isEmpty();

        // Der Zaun der Quelle: ein Standort-Konto sieht keinen Vermerk im Verzeichnis.
        abruf("2029-04-30T08:00:00Z");
        assertThat(alle(ruf("GET", VERZEICHNIS, "PH", null, 200)).stream()
                .filter(x -> x.path("art").asText().equals("teil_vermerk"))).isEmpty();
    }

    // ------------------------------------------------------------------ Hilfen

    private JsonNode person(String name, String funktion, String kuerzel, String konto) throws Exception {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("name", name);
        b.put("funktion", funktion);
        b.put("kuerzel", kuerzel);
        if (konto != null) b.put("konto_sub", konto);
        b.put("seit", "2026-10-01");
        return ruf("POST", BASIS + "/personen", "IK", b, 201);
    }

    private static String id(JsonNode n) {
        return n.has("verlauf") ? n.at("/person/id").asText() : n.path("id").asText();
    }

    private static List<JsonNode> alle(JsonNode v) {
        List<JsonNode> aus = new ArrayList<>();
        v.path("gruppen").forEach(g -> g.path("zeilen").forEach(aus::add));
        return aus;
    }

    private static JsonNode zeile(JsonNode v, String gruppe, String kennzeichen) {
        for (JsonNode g : v.path("gruppen")) {
            if (!g.path("gruppe").asText().equals(gruppe)) continue;
            for (JsonNode z : g.path("zeilen")) {
                if (z.path("art").asText().equals("teil_vermerk") && z.path("kennzeichen").asText().equals(kennzeichen)) {
                    return z;
                }
            }
        }
        throw new AssertionError("kein Vermerk " + kennzeichen + " in " + gruppe);
    }

    private static List<String> felder(JsonNode n) {
        List<String> aus = new ArrayList<>();
        n.fieldNames().forEachRemaining(aus::add);
        return aus;
    }

    private static List<String> texte(JsonNode liste, String feld) {
        List<String> aus = new ArrayList<>();
        liste.forEach(n -> aus.add(n.path(feld).asText()));
        return aus;
    }

    /** Die Uhr des Dienstes: „heute“, „nie in der Zukunft“, Eintragen und Aufheben. */
    private void heute(String jetzt) {
        vermerke.uhrStellen(Clock.fixed(Instant.parse(jetzt), ZoneOffset.UTC));
    }

    /** Die Uhr des Verzeichnisses: an ihr hängt der Stichtag. */
    private void abruf(String jetzt) {
        verzeichnis.uhrStellen(Clock.fixed(Instant.parse(jetzt), ZoneOffset.UTC));
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
        return JSON.readTree(r.getContentAsString(StandardCharsets.UTF_8));
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
