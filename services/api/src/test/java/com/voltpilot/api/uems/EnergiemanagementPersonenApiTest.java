package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
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
 * UEMS AP-19 IP-6 (NW-2): Personen und Aufgaben über die echte HTTP-, Rechte- und RLS-Kette mit der App-Rolle — R5 des
 * Konzepts mit den Personen der Referenzdatei 1.10 (Kunststoffwerk Ahrenberg): Robert Falk als Leitung ohne Konto,
 * zehn Zuordnungen am 22.01.2029, „Bezugsbasen pflegen und freigeben — keine Person festgelegt.“, ab 01.03.2029 Ines
 * Kaltenbach mit Vertretung Jonas Wendlinger.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class EnergiemanagementPersonenApiTest {
    private static final String PERSONEN = "/api/v1/energiemanagement/personen";
    private static final String AUFGABEN = "/api/v1/energiemanagement/aufgaben";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Map<String, String> NAMEN = Map.of("IK", "Ines Kaltenbach", "JW", "Jonas Wendlinger",
            "PH", "Peter Hollerbach", "CB", "Claudia Berger", "MD", "Murat Demirci", "RF", "Robert Falk");
    private static final Map<String, Object> BESTELLUNG = Map.of(
            "bezeichnung", "Bestellung Energiemanagement vom 28.09.2026, unterschrieben",
            "ablage", "Personalakte (Personalabteilung)");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "ip6_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "ip6_test_pw");
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> "http://127.0.0.1:9/realms/voltpilot");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri", () -> "http://127.0.0.1:9/certs");
    }

    @Autowired MockMvc mvc;
    static JdbcTemplate root;
    UUID tenant, unternehmen, s1, s2;

    @BeforeAll
    static void start() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void welt() {
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Ahrenberg IP-6') RETURNING id", UUID.class);
        unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name) VALUES (?,'Kunststoffwerk Ahrenberg') "
                + "RETURNING id", UUID.class, tenant);
        s1 = standort("ST-1");
        s2 = standort("ST-2");
        benutzer("IK", "energiemanager", null);
        benutzer("JW", "kundenadministrator", null);
        benutzer("PH", "bearbeiter", s2);
        benutzer("MD", "bedienberechtigt", s1);
        benutzer("CB", "leser", s1);
    }

    // ------------------------------------------------------------------ Robert Falk ohne Konto (PA1)

    @Test
    void robertFalkOhneKontoIstEinePersonUndDieLeitung() throws Exception {
        JsonNode rf = person("Robert Falk", "Geschäftsführer", "RF", null, "2026-10-01");
        assertThat(rf.at("/person/konto").isNull()).isTrue();
        assertThat(rf.at("/person/zustand").asText()).isEqualTo("aktiv");
        assertThat(rf.at("/verlauf/0/art").asText()).isEqualTo("person_erfasst");
        assertThat(rf.at("/verlauf/0/akteur/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(rf.at("/person/eingetragen/akteur/rolle").asText()).isEqualTo("energiemanager");

        // „Leitung des Unternehmens“ braucht kein „entschieden von“ (PA2).
        JsonNode leitung = zuordnen(Map.of("aufgabe", "unternehmensleitung", "person_id", id(rf),
                "gilt_ab", "2026-10-01", "begruendung", "Geschäftsführer laut Handelsregister"));
        assertThat(leitung.path("entschieden_von").isNull()).isTrue();
        assertThat(leitung.path("wort").asText()).isEqualTo("Leitung des Unternehmens");
        assertThat(leitung.at("/person/mit_konto").asBoolean()).isFalse();

        JsonNode am = ruf("GET", AUFGABEN + "?tag=2029-01-22", "IK", null, 200);
        assertThat(am.path("leitung")).hasSize(1);
        assertThat(am.at("/leitung/0/name").asText()).isEqualTo("Robert Falk");
        assertThat(am.at("/leitung/0/mit_konto").asBoolean()).isFalse();
        assertThat(werte(ruf("GET", PERSONEN, "IK", null, 200).path("personen"), "name"))
                .containsExactly("Robert Falk");
    }

    // ------------------------------------------------------------------ Aufgabe ohne „entschieden von“ 422 (PA2)

    @Test
    void aufgabeOhneEntschiedenVonIst422UndSchreibtNichts() throws Exception {
        JsonNode ik = person("Ines Kaltenbach", "Energiemanagement", "IK", "IK", "2026-10-01");
        int vorher = zeilen();
        Map<String, Object> ohne = new LinkedHashMap<>(Map.of("aufgabe", "energiemanagement_leiten",
                "person_id", id(ik), "gilt_ab", "2026-10-01", "begruendung", "Bestellung vom 28.09.2026"));
        JsonNode antwort = ruf("POST", AUFGABEN, "IK", ohne, 422);
        assertThat(antwort.path("code").asText()).isEqualTo("entschieden_von_fehlt");
        assertThat(antwort.path("feld").asText()).isEqualTo("entschieden_von");
        // Jede andere Aufgabe des Vokabulars ebenso — nur die Leitung nicht.
        for (String aufgabe : EnergiemanagementRegeln.VOKABULARE.get("aufgabe")) {
            if (aufgabe.equals("unternehmensleitung")) continue;
            Map<String, Object> a = new LinkedHashMap<>(ohne);
            a.put("aufgabe", aufgabe);
            if (aufgabe.equals("weitere")) a.put("aufgabe_wortlaut", "Energiebeauftragte Werk Lindach");
            assertThat(ruf("POST", AUFGABEN, "IK", a, 422).path("code").asText()).as(aufgabe)
                    .isEqualTo("entschieden_von_fehlt");
        }
        assertThat(zeilen()).as("keine Zuordnung, keine Protokoll-Zeile").isEqualTo(vorher);
    }

    // ------------------------------------------------------------------ R5 und die Leitung am Tag X (PA2, PA3)

    @Test
    void r5ZehnZuordnungenKeinePersonFuerBezugsbasenUndDieLeitungAmTagX() throws Exception {
        Map<String, JsonNode> p = r5Personen();
        String rf = id(p.get("RF"));
        zuordnen(Map.of("aufgabe", "unternehmensleitung", "person_id", rf, "gilt_ab", "2026-10-01",
                "begruendung", "Geschäftsführer laut Handelsregister"));
        zuordnen(entschieden("energiemanagement_leiten", p.get("IK"), "2026-10-01", rf, id(p.get("JW"))));
        for (String k : List.of("IK", "MD")) zuordnen(entschieden("energieteam", p.get(k), "2026-10-01", rf, null));
        zuordnen(entschieden("energieteam", p.get("PH"), "2026-10-15", rf, null));
        for (String a : List.of("energieziele_massnahmen", "bewertung_messplanung", "dokumente", "managementbewertung")) {
            zuordnen(entschieden(a, p.get("IK"), "2026-10-01", rf, null));
        }
        Map<String, Object> audits = entschieden("interne_audits", p.get("CB"), "2028-12-01", rf, null);
        audits.remove("beleg");
        zuordnen(audits);

        JsonNode am = ruf("GET", AUFGABEN + "?tag=2029-01-22", "IK", null, 200);
        assertThat(am.path("tag").asText()).isEqualTo("2029-01-22");
        assertThat(laufend(am)).isEqualTo(10);
        assertThat(ohnePerson(am)).containsExactly("bezugsbasen");
        assertThat(satz(am, "bezugsbasen")).isEqualTo("Bezugsbasen pflegen und freigeben — keine Person festgelegt.");
        assertThat(satz(am, "weitere")).as("„weitere“ hat nie den Satz").isNull();
        assertThat(inhaber(aufgabe(am, "energieteam"))).containsExactly("IK", "MD", "PH");
        JsonNode leiten = aufgabe(am, "energiemanagement_leiten").path("laufend").get(0);
        assertThat(leiten.at("/entschieden_von/name").asText()).isEqualTo("Robert Falk");
        assertThat(leiten.at("/vertretung/name").asText()).isEqualTo("Jonas Wendlinger");
        assertThat(leiten.at("/beleg/ablage").asText()).isEqualTo("Personalakte (Personalabteilung)");
        assertThat(werte(am.path("aufgaben"), "aufgabe"))
                .containsExactlyElementsOf(EnergiemanagementRegeln.VOKABULARE.get("aufgabe"));

        // Die Leitung am Tag X: vor dem 01.10.2026 niemand — und die Fläche sagt es als Satz.
        JsonNode davor = ruf("GET", AUFGABEN + "?tag=2026-09-30", "IK", null, 200);
        assertThat(davor.path("leitung")).isEmpty();
        assertThat(satz(davor, "unternehmensleitung"))
                .isEqualTo("Leitung des Unternehmens — keine Person festgelegt.");
        assertThat(ruf("GET", AUFGABEN + "?tag=2026-10-01", "IK", null, 200).at("/leitung/0/kuerzel").asText())
                .isEqualTo("RF");
        // PH ist erst ab dem 15.10.2026 im Energieteam.
        assertThat(inhaber(aufgabe(ruf("GET", AUFGABEN + "?tag=2026-10-14", "IK", null, 200), "energieteam")))
                .containsExactly("IK", "MD");

        // Beschluss B4 → ab 01.03.2029 Ines Kaltenbach, Vertretung Jonas Wendlinger (R5 Schritt 5).
        Map<String, Object> b4 = entschieden("bezugsbasen", p.get("IK"), "2029-03-01", rf, id(p.get("JW")));
        b4.put("beschluss_kennung", "BR-2029-0001/B9");
        assertThat(ruf("POST", AUFGABEN, "IK", b4, 422).path("code").asText()).as("MG6: den Beschluss gibt es nicht")
                .isEqualTo("beschluss_unbekannt");
        ManagementbewertungImStand.anlegen(root, tenant, unternehmen, UUID.fromString(rf), "BR-2029-0001", 6);
        b4.put("beschluss_kennung", "BR-2029-0001/B4");
        JsonNode bezugsbasen = zuordnen(b4);
        assertThat(bezugsbasen.path("beschluss_kennung").asText()).isEqualTo("BR-2029-0001/B4");
        assertThat(ohnePerson(ruf("GET", AUFGABEN + "?tag=2029-02-28", "IK", null, 200))).containsExactly("bezugsbasen");
        JsonNode maerz = ruf("GET", AUFGABEN + "?tag=2029-03-01", "IK", null, 200);
        assertThat(ohnePerson(maerz)).isEmpty();
        assertThat(laufend(maerz)).isEqualTo(11);

        // Übergabe der Leitung: RF bis 30.06.2029 (der letzte Tag zählt mit), ab 01.07.2029 eine neue Person.
        String leitungId = aufgabe(maerz, "unternehmensleitung").at("/laufend/0/id").asText();
        JsonNode beendet = ruf("POST", AUFGABEN + "/" + leitungId + "/beenden", "IK",
                Map.of("gilt_bis", "2029-06-30", "begruendung", "Ruhestand zum Halbjahr"), 200);
        assertThat(beendet.path("zustand").asText()).isEqualTo("beendet");
        JsonNode nl = person("Nora Lenz", "Geschäftsführerin", "NL", null, "2029-07-01");
        zuordnen(Map.of("aufgabe", "unternehmensleitung", "person_id", id(nl), "gilt_ab", "2029-07-01",
                "begruendung", "Bestellung durch die Gesellschafter"));
        assertThat(werte(ruf("GET", AUFGABEN + "?tag=2029-06-30", "IK", null, 200).path("leitung"), "kuerzel"))
                .containsExactly("RF");
        assertThat(werte(ruf("GET", AUFGABEN + "?tag=2029-07-01", "IK", null, 200).path("leitung"), "kuerzel"))
                .containsExactly("NL");
        // Alle Zuordnungen bleiben lesbar, auch die beendete.
        assertThat(ruf("GET", AUFGABEN + "?tag=2029-07-01", "IK", null, 200).path("zuordnungen")).hasSize(12);
        assertThat(protokoll("aufgabe_beendet")).isEqualTo(1);
    }

    // ------------------------------------------------------------------ Konto-Verknüpfung protokolliert

    @Test
    void kontoVerknuepfungBrauchtEineBegruendungUndStehtMitAltUndNeuImVerlauf() throws Exception {
        JsonNode rf = person("Robert Falk", "Geschäftsführer", "RF", null, "2026-10-01");
        String pfad = PERSONEN + "/" + id(rf);
        benutzerOhneZugriff("RF");
        Map<String, Object> stand = new LinkedHashMap<>(Map.of("name", "Robert Falk", "funktion", "Geschäftsführer",
                "kuerzel", "RF", "seit", "2026-10-01", "konto_sub", "RF"));
        assertThat(ruf("PUT", pfad, "IK", stand, 422).path("code").asText()).isEqualTo("begruendung_fehlt");
        assertThat(ruf("GET", pfad, "IK", null, 200).path("verlauf")).hasSize(1);

        stand.put("begruendung", "Konto für die Einsicht ab 01.02.2029");
        JsonNode nachher = ruf("PUT", pfad, "IK", stand, 200);
        assertThat(nachher.at("/person/konto/sub").asText()).isEqualTo("RF");
        assertThat(nachher.at("/person/konto/name").asText()).isEqualTo("Robert Falk");
        JsonNode v = nachher.path("verlauf");
        assertThat(werte(v, "art")).containsExactly("person_erfasst", "person_geaendert");
        assertThat(v.get(1).at("/alt/konto_sub").isNull()).isTrue();
        assertThat(v.get(1).at("/neu/konto_sub").asText()).isEqualTo("RF");
        assertThat(v.get(1).path("begruendung").asText()).isEqualTo("Konto für die Einsicht ab 01.02.2029");
        assertThat(v.get(1).at("/akteur/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(v.get(1).path("zeit").isTextual()).isTrue();

        // Ein Konto gehört höchstens einer Person; ein fremdes oder unbekanntes Konto gibt es nicht.
        JsonNode zweite = person("Robert Falk jun.", "Assistenz", null, null, null);
        Map<String, Object> doppelt = new LinkedHashMap<>(Map.of("name", "Robert Falk jun.", "funktion", "Assistenz",
                "konto_sub", "RF", "begruendung", "Versehentlich dasselbe Konto"));
        assertThat(ruf("PUT", PERSONEN + "/" + id(zweite), "IK", doppelt, 409).path("code").asText())
                .isEqualTo("konto_vergeben");
        doppelt.put("konto_sub", "gibt-es-nicht");
        assertThat(ruf("PUT", PERSONEN + "/" + id(zweite), "IK", doppelt, 422).path("code").asText())
                .isEqualTo("konto_unbekannt");
        assertThat(ruf("POST", PERSONEN, "IK", Map.of("name", "Doppel", "funktion", "x", "kuerzel", "RF"), 409)
                .path("code").asText()).isEqualTo("kuerzel_vergeben");
        // Ohne Konto-Änderung braucht eine Änderung keine Begründung.
        stand.remove("begruendung");
        stand.put("organisation", "Kunststoffwerk Ahrenberg GmbH");
        assertThat(ruf("PUT", pfad, "IK", stand, 200).path("verlauf")).hasSize(3);
    }

    // ------------------------------------------------------------------ Recht 403 (NW-2)

    @Test
    void ohneEnergiemanagementVerwaltenAmUnternehmenAuchEinsicht403UndNichtsGeschrieben() throws Exception {
        JsonNode rf = person("Robert Falk", "Geschäftsführer", "RF", null, "2026-10-01");
        JsonNode leitung = zuordnen(Map.of("aufgabe", "unternehmensleitung", "person_id", id(rf),
                "gilt_ab", "2026-10-01", "begruendung", "Geschäftsführer laut Handelsregister"));
        int vorher = zeilen();
        int personen = root.queryForObject("SELECT count(*) FROM energiemanagement_person WHERE tenant_id=?",
                Integer.class, tenant);
        List<Object[]> wege = new ArrayList<>();
        wege.add(new Object[] {"POST", PERSONEN, Map.of("name", "X", "funktion", "Y")});
        wege.add(new Object[] {"PUT", PERSONEN + "/" + id(rf), Map.of("name", "X", "funktion", "Y")});
        wege.add(new Object[] {"POST", AUFGABEN, Map.of("aufgabe", "energieteam")});
        wege.add(new Object[] {"POST", AUFGABEN + "/" + id(leitung) + "/beenden", Map.of("gilt_bis", "2029-01-01")});
        // R6: Robert Falk mit der Rolle „Einsicht“ (AP-19 IP-12) — unternehmensweit lesen, nie schreiben.
        benutzer("RF", "einsicht", null);
        for (String wer : List.of("PH", "MD", "CB", "RF")) {
            for (Object[] w : wege) {
                JsonNode a = ruf((String) w[0], (String) w[1], wer, w[2], 403);
                assertThat(a.path("code").asText()).as(wer + " " + w[0] + " " + w[1]).isEqualTo("recht_fehlt");
                assertThat(a.path("recht").asText()).isEqualTo("energiemanagement.verwalten");
            }
        }
        assertThat(zeilen()).isEqualTo(vorher);
        assertThat(root.queryForObject("SELECT count(*) FROM energiemanagement_person WHERE tenant_id=?",
                Integer.class, tenant)).isEqualTo(personen);
        // Lesen: Personen sieht auch der Standort-Bearbeiter (Name hinter „entschieden von“); Aufgaben nur
        // unternehmensweit — er bekommt keine Zeile und nie den Satz „keine Person festgelegt“.
        assertThat(ruf("GET", PERSONEN, "PH", null, 200).path("personen")).hasSize(1);
        JsonNode aufgaben = ruf("GET", AUFGABEN, "PH", null, 200);
        assertThat(aufgaben.path("aufgaben")).isEmpty();
        assertThat(aufgaben.path("leitung")).isEmpty();
        assertThat(aufgaben.path("zuordnungen")).isEmpty();
        // Einsicht liest die Aufgaben unternehmensweit — mit der Leitung und dem Satz.
        JsonNode einsicht = ruf("GET", AUFGABEN + "?tag=2029-01-22", "RF", null, 200);
        assertThat(werte(einsicht.path("leitung"), "kuerzel")).containsExactly("RF");
        assertThat(satz(einsicht, "bezugsbasen")).isEqualTo("Bezugsbasen pflegen und freigeben — keine Person festgelegt.");
        // Der Kundenadministrator darf (Zelle U).
        ruf("POST", PERSONEN, "JW", Map.of("name", "Jonas Wendlinger", "funktion", "IT-Leitung", "konto_sub", "JW"), 201);
    }

    // ------------------------------------------------------------------ nie gelöscht, „bis“ beendet (PA5)

    @Test
    void personMitZeilenIstNichtLoeschbarBisBeendetSieErstOhneLaufendeAufgaben() throws Exception {
        JsonNode rf = person("Robert Falk", "Geschäftsführer", "RF", null, "2026-10-01");
        JsonNode ik = person("Ines Kaltenbach", "Energiemanagement", "IK", "IK", "2026-10-01");
        JsonNode team = zuordnen(entschieden("energieteam", ik, "2026-10-01", id(rf), null));
        UUID rfId = UUID.fromString(id(rf));

        // Keine Löschroute; und die Datenbank hält die Person fest, solange eine Zeile sie nennt (RESTRICT).
        assertThat(mvc.perform(request(HttpMethod.DELETE, PERSONEN + "/" + rfId)
                .with(authentication(token("IK")))).andReturn().getResponse().getStatus()).isEqualTo(405);
        assertThatThrownBy(() -> root.update("DELETE FROM energiemanagement_person WHERE id = ?", rfId))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("energiemanagement_aufgabe_entschieden_von_fk");

        String ikPfad = PERSONEN + "/" + id(ik);
        Map<String, Object> ende = new LinkedHashMap<>(Map.of("name", "Ines Kaltenbach", "funktion",
                "Energiemanagement", "kuerzel", "IK", "konto_sub", "IK", "seit", "2026-10-01", "bis", "2029-12-31"));
        assertThat(ruf("PUT", ikPfad, "IK", ende, 422).path("code").asText()).isEqualTo("begruendung_fehlt");
        ende.put("begruendung", "Wechsel in ein anderes Werk");
        JsonNode laeuft = ruf("PUT", ikPfad, "IK", ende, 409);
        assertThat(laeuft.path("code").asText()).isEqualTo("aufgaben_laufen");
        assertThat(laeuft.path("zuordnungen").get(0).asText()).isEqualTo(id(team));
        ende.put("bis", "2026-09-01");
        assertThat(ruf("PUT", ikPfad, "IK", ende, 422).path("code").asText()).isEqualTo("zeitraum_ungueltig");

        ruf("POST", AUFGABEN + "/" + id(team) + "/beenden", "IK",
                Map.of("gilt_bis", "2029-12-31", "begruendung", "Wechsel in ein anderes Werk"), 200);
        ende.put("bis", "2029-12-31");
        JsonNode beendet = ruf("PUT", ikPfad, "IK", ende, 200);
        assertThat(beendet.at("/person/zustand").asText()).isEqualTo("beendet");
        assertThat(beendet.at("/person/bis").asText()).isEqualTo("2029-12-31");
        assertThat(werte(beendet.path("verlauf"), "art")).containsExactly("person_erfasst", "person_beendet");
        assertThat(ruf("PUT", ikPfad, "IK", ende, 409).path("code").asText()).isEqualTo("person_beendet");
        // Sie bleibt lesbar, und die Zuordnung nennt sie weiter.
        assertThat(werte(ruf("GET", PERSONEN, "IK", null, 200).path("personen"), "name"))
                .containsExactly("Robert Falk", "Ines Kaltenbach");
        assertThat(ruf("GET", AUFGABEN + "?tag=2027-01-01", "IK", null, 200).at("/zuordnungen/0/person/name").asText())
                .isEqualTo("Ines Kaltenbach");
        // Nach ihrem „bis“ bekommt sie keine neue Aufgabe.
        assertThat(ruf("POST", AUFGABEN, "IK", entschieden("dokumente", ik, "2030-01-01", id(rf), null), 422)
                .path("code").asText()).isEqualTo("person_beendet");
    }

    // ------------------------------------------------------------------ jede weitere Ablehnung

    @Test
    void jedeAblehnungDerZuordnungUndMandantNieAusDemKoerper() throws Exception {
        JsonNode rf = person("Robert Falk", "Geschäftsführer", "RF", null, "2026-10-01");
        JsonNode ik = person("Ines Kaltenbach", "Energiemanagement", "IK", "IK", "2026-10-01");
        Map<String, Object> gut = entschieden("energieteam", ik, "2026-10-01", id(rf), null);
        List<Object[]> faelle = List.of(
                new Object[] {"aufgabe", "sonstiges", "aufgabe_unbekannt"},
                new Object[] {"aufgabe", "weitere", "wortlaut_fehlt"},
                new Object[] {"aufgabe_wortlaut", "Nur bei weitere", "angabe_ungueltig"},
                new Object[] {"person_id", null, "person_fehlt"},
                new Object[] {"person_id", UUID.randomUUID().toString(), "person_unbekannt"},
                new Object[] {"entschieden_von", UUID.randomUUID().toString(), "person_unbekannt"},
                new Object[] {"vertretung_person_id", id(ik), "vertretung_gleich_person"},
                new Object[] {"gilt_ab", null, "gilt_ab_fehlt"},
                new Object[] {"begruendung", "zu kurz", "begruendung_fehlt"},
                new Object[] {"beleg", Map.of("bezeichnung", "Bestellung"), "beleg_ungueltig"},
                new Object[] {"beleg", Map.of("ablage", "Personalakte", "sha256", "ABC"), "beleg_ungueltig"},
                new Object[] {"beschluss_kennung", "B4", "beschluss_ungueltig"});
        int vorher = zeilen();
        for (Object[] f : faelle) {
            Map<String, Object> a = new LinkedHashMap<>(gut);
            a.put((String) f[0], f[1]);
            assertThat(ruf("POST", AUFGABEN, "IK", a, 422).path("code").asText()).as(f[0] + "=" + f[1])
                    .isEqualTo(f[2]);
        }
        assertThat(zeilen()).isEqualTo(vorher);
        Map<String, Object> mitMandant = new LinkedHashMap<>(gut);
        mitMandant.put("tenant_id", UUID.randomUUID().toString());
        assertThat(ruf("POST", AUFGABEN, "IK", mitMandant, 400).path("code").asText()).isEqualTo("anfrage_ungueltig");
        assertThat(ruf("GET", AUFGABEN + "?tag=gestern", "IK", null, 400).path("feld").asText()).isEqualTo("tag");

        JsonNode z = zuordnen(gut);
        assertThat(ruf("POST", AUFGABEN, "IK", gut, 409).path("code").asText()).isEqualTo("zuordnung_laeuft_bereits");
        String beenden = AUFGABEN + "/" + id(z) + "/beenden";
        assertThat(ruf("POST", beenden, "IK", Map.of("begruendung", "Ende der Bestellung"), 422).path("code").asText())
                .isEqualTo("gilt_bis_fehlt");
        assertThat(ruf("POST", beenden, "IK", Map.of("gilt_bis", "2026-09-30", "begruendung", "Ende der Bestellung"),
                422).path("code").asText()).isEqualTo("zeitraum_ungueltig");
        ruf("POST", beenden, "IK", Map.of("gilt_bis", "2027-09-30", "begruendung", "Ende der Bestellung"), 200);
        assertThat(ruf("POST", beenden, "IK", Map.of("gilt_bis", "2027-09-30", "begruendung", "Ende der Bestellung"),
                409).path("code").asText()).isEqualTo("aufgabe_beendet");
        // Übergabe ab dem Folgetag: dieselbe Aufgabe für dieselbe Person überschneidet sich nicht mehr.
        gut.put("gilt_ab", "2027-10-01");
        zuordnen(gut);
        assertThat(ruf("POST", AUFGABEN + "/" + UUID.randomUUID() + "/beenden", "IK",
                Map.of("gilt_bis", "2027-09-30", "begruendung", "Ende der Bestellung"), 404).path("code").asText())
                .isEqualTo("nicht_gefunden");
        assertThat(ruf("GET", PERSONEN + "/keine-id", "IK", null, 404).path("message").asText())
                .isEqualTo("Diese Person gibt es nicht.");

        // Eine Person eines anderen Kundenbereichs gibt es hier nicht.
        UUID fremd = root.queryForObject("INSERT INTO tenant(name) VALUES ('Fremd') RETURNING id", UUID.class);
        UUID fremdePerson = root.queryForObject("INSERT INTO energiemanagement_person(tenant_id,name,funktion,actor_name,"
                + "actor_art) VALUES (?,'Fremd','Fremd','VoltPilot','voltpilot') RETURNING id", UUID.class, fremd);
        ruf("GET", PERSONEN + "/" + fremdePerson, "IK", null, 404);
        Map<String, Object> fremdeZuordnung = new LinkedHashMap<>(gut);
        fremdeZuordnung.put("person_id", fremdePerson.toString());
        fremdeZuordnung.put("aufgabe", "dokumente");
        assertThat(ruf("POST", AUFGABEN, "IK", fremdeZuordnung, 422).path("code").asText()).isEqualTo("person_unbekannt");
    }

    // ------------------------------------------------------------------ Hilfen

    private Map<String, JsonNode> r5Personen() throws Exception {
        Map<String, JsonNode> p = new LinkedHashMap<>();
        p.put("RF", person("Robert Falk", "Geschäftsführer", "RF", null, "2026-10-01"));
        p.put("IK", person("Ines Kaltenbach", "Energiemanagement", "IK", "IK", "2026-10-01"));
        p.put("JW", person("Jonas Wendlinger", "IT-Leitung", "JW", "JW", "2026-10-01"));
        p.put("PH", person("Peter Hollerbach", "Standortleiter Werk Lindach", "PH", "PH", "2026-10-15"));
        p.put("MD", person("Murat Demirci", "Schichtführer Halle 1", "MD", "MD", "2026-10-01"));
        p.put("CB", person("Claudia Berger", "Controlling", "CB", "CB", "2028-12-01"));
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
        if (kuerzel != null) b.put("kuerzel", kuerzel);
        if (konto != null) b.put("konto_sub", konto);
        if (seit != null) b.put("seit", seit);
        return ruf("POST", PERSONEN, "IK", b, 201);
    }

    private JsonNode zuordnen(Map<String, Object> body) throws Exception {
        return ruf("POST", AUFGABEN, "IK", body, 201);
    }

    private static String id(JsonNode n) {
        return n.has("verlauf") ? n.at("/person/id").asText() : n.path("id").asText();
    }

    /** Das Feld je Element einer Liste — nie die gleichnamigen Felder darin (Akteur, Konto, Vertretung). */
    private static List<String> werte(JsonNode liste, String feld) {
        List<String> w = new ArrayList<>();
        liste.forEach(e -> w.add(e.path(feld).asText()));
        return w;
    }

    /** Die Kürzel der Personen, die eine Aufgabe am Tag tragen. */
    private static List<String> inhaber(JsonNode aufgabe) {
        List<String> w = new ArrayList<>();
        aufgabe.path("laufend").forEach(z -> w.add(z.at("/person/kuerzel").asText()));
        return w;
    }

    private static int laufend(JsonNode am) {
        int n = 0;
        for (JsonNode a : am.path("aufgaben")) n += a.path("laufend").size();
        return n;
    }

    private static List<String> ohnePerson(JsonNode am) {
        List<String> ohne = new ArrayList<>();
        for (JsonNode a : am.path("aufgaben")) {
            if (a.path("laufend").isEmpty() && !a.path("satz").isNull()) ohne.add(a.path("aufgabe").asText());
        }
        return ohne;
    }

    private static JsonNode aufgabe(JsonNode am, String aufgabe) {
        for (JsonNode a : am.path("aufgaben")) if (a.path("aufgabe").asText().equals(aufgabe)) return a;
        throw new AssertionError("keine Aufgabe " + aufgabe);
    }

    private static String satz(JsonNode am, String aufgabe) {
        JsonNode s = aufgabe(am, aufgabe).path("satz");
        return s.isNull() ? null : s.asText();
    }

    private int zeilen() {
        return root.queryForObject("SELECT (SELECT count(*) FROM energiemanagement_aufgabe WHERE tenant_id=?) "
                + "+ (SELECT count(*) FROM energiemanagement_aenderung WHERE tenant_id=?)", Integer.class, tenant, tenant);
    }

    private int protokoll(String art) {
        return root.queryForObject("SELECT count(*) FROM energiemanagement_aenderung WHERE tenant_id=? AND art=?",
                Integer.class, tenant, art);
    }

    private org.springframework.security.core.Authentication token(String sub) {
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
        benutzerOhneZugriff(sub);
        root.update("INSERT INTO zugriff(tenant_id,benutzer_sub,rolle,standort_id,gueltig_ab,zeitzone) "
                + "VALUES (?,?,?,?,'2024-01-01','Europe/Berlin')", tenant, sub, rolle, standort);
    }

    private void benutzerOhneZugriff(String sub) {
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,?,'benutzer',?,'aktiv')",
                tenant, sub, NAMEN.get(sub));
    }
}
