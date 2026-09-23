package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.UUID;
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
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/** AP-16 IP-28 (NW-6): der Plan-Abnahmesatz als ein Ablauf durch Einstufung, Bericht und Kaskade. */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class UemsEinstufungAbnahmeTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String EINSAETZE = "/api/v1/unternehmen/energieeinsaetze";
    private static final String RANGLISTE = "/api/v1/unternehmen/bewertung/rangliste"
            + "?von=2026-10-01&bis=2026-10-31";
    private static final String ABLESUNGEN = "/api/v1/messstellen/MS-01/ablesungen";
    private static final String ENDE = "2026-11-02T07:40:00+01:00";
    private static final Instant JETZT = Instant.parse("2026-12-10T12:00:00Z");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "ip28_app_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "ip28_app_pw");
        r.add("spring.flyway.placeholders.adminDbPassword", () -> "ip28_admin_pw");
        r.add("voltpilot.admin-datasource.password", () -> "ip28_admin_pw");
        r.add("voltpilot.uems.kaskade.enabled", () -> "false");
        r.add("voltpilot.uems.berichte.enabled", () -> "true");
        r.add("voltpilot.uems.berichte.struktur.enabled", () -> "false");
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri", () -> "http://127.0.0.1:9/certs");
    }

    @Autowired MockMvc mvc;
    @Autowired AblesungService ablesungen;
    @Autowired MessstelleWerteService werte;
    @Autowired BilanzService bilanz;
    @Autowired BerichtService berichte;
    @Autowired BerichtKaskade berichtKaskade;

    static JdbcTemplate root;
    UUID tenant;
    UUID unternehmen;
    UUID standort;
    UUID einsatz;

    @BeforeAll
    static void verbinden() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void ahrenberg() {
        uhr(JETZT);

        tenant = uuid("INSERT INTO tenant(name) VALUES ('Kunststoffwerk Ahrenberg GmbH') RETURNING id");
        unternehmen = uuid("INSERT INTO unternehmen(tenant_id,name,zeitzone) "
                + "VALUES (?,'Kunststoffwerk Ahrenberg GmbH','Europe/Berlin') RETURNING id", tenant);
        standort = uuid("INSERT INTO standort(tenant_id,unternehmen_id,name,kurzzeichen,zeitzone,zustand) "
                + "VALUES (?,?,'Werk Ahrenberg','ST-1','Europe/Berlin','aktiv') RETURNING id", tenant, unternehmen);
        UUID anlage = uuid("INSERT INTO site(tenant_id,name) VALUES (?,'AN-1 Halle 1') RETURNING id", tenant);
        root.update("INSERT INTO anlage_standort(tenant_id,site_id,standort_id,gueltig_ab) "
                + "VALUES (?,?,?,'2024-03-12')", tenant, anlage, standort);
        UUID prozess = uuid("INSERT INTO prozess(tenant_id,unternehmen_id,kennzeichen,name,gueltig_ab) "
                + "VALUES (?,?,'P-1','Spritzguss','2024-03-12') RETURNING id", tenant, unternehmen);
        UUID messstelle = uuid("INSERT INTO messstelle(tenant_id,kennzeichen,name,art,medium,groesse,richtung,einheit,"
                + "wertart) VALUES (?,'MS-01','Netzbezug Halle 1','gemessen','Strom','Wirkenergie','Bezug','kWh',"
                + "'Zählerstand') RETURNING id", tenant);
        root.update("INSERT INTO messstelle_ort(tenant_id,messstelle_id,standort_id,gueltig_ab) "
                + "VALUES (?,?,?,'2024-03-12')", tenant, messstelle, standort);
        root.update("INSERT INTO messstelle_stellung(tenant_id,messstelle_id,site_id,stellung,gueltig_ab) "
                + "VALUES (?,?,?,'Hauptzähler','2024-03-12')", tenant, messstelle, anlage);
        root.update("INSERT INTO messstelle_prozess(tenant_id,messstelle_id,prozess_id,gueltig_ab) "
                + "VALUES (?,?,?,'2024-03-12')", tenant, messstelle, prozess);
        einsatz = uuid("INSERT INTO energieeinsatz(tenant_id,prozess_id,traeger,name,gueltig_ab,actor_sub,actor_name,"
                + "actor_rolle,actor_art) VALUES (?,?,'Strom','Spritzguss','2024-03-12','IK','Ines Kaltenbach',"
                + "'energiemanager','kunde') RETURNING id", tenant, prozess);
        benutzer("IK", "Ines Kaltenbach", "energiemanager");
        benutzer("JW", "Jonas Wendlinger", "kundenadministrator");
    }

    @Test
    void derPlanIstBegruendetVersioniertUndMitDenVerwendetenDatenVerbunden() throws Exception {
        ruf("POST", ABLESUNGEN, "IK", Map.of("zeitpunkt", "2026-10-01T07:15:00+02:00", "stand", "0"),
                200, "Bühne: Anfangsstand");
        ruf("POST", ABLESUNGEN, "IK", Map.of("zeitpunkt", ENDE, "stand", "128.400",
                "zuordnung_monat", "2026-10"), 200, "Bühne: Monatsendstand");
        ruf("PUT", "/api/v1/unternehmen/bewertung/umfang", "IK", Map.of("gueltig_ab", "2024-03-12",
                "standort_ids", List.of(standort), "traeger", List.of("Strom"), "ausschluesse", List.of()),
                200, "Bühne: Bewertungsumfang Ahrenberg");
        JsonNode ee1 = einsatz(ruf("GET", RANGLISTE, "IK", null, 200, "Bühne: Herkunft aus der Rangliste"));
        ObjectNode fassung = einstufung(ee1.path("herkunft"), "wesentlich", "K1", "2026-09-20",
                "41,8 % des Stromeinsatzes; größter Einsatz an beiden Hallen.");

        ObjectNode ohneBegruendung = fassung.deepCopy();
        ohneBegruendung.remove("begruendung");
        JsonNode abgelehnt = ruf("PUT", einstufungsPfad(), "IK", ohneBegruendung, 422,
                "R3 begründet: ohne Begründung");
        assertThat(abgelehnt.path("code").asText()).as("R3 begründet: Fehlerkennung")
                .isEqualTo("begruendung_fehlt");

        JsonNode erste = ruf("PUT", einstufungsPfad(), "IK", fassung, 200,
                "R3 begründet: Fassung 1 durch Ines");
        assertThat(erste.path("fassung").asInt()).as("R3 versioniert: erste Fassung").isEqualTo(1);
        assertThat(erste.at("/akteur/name").asText()).as("R3 begründet: Person an der Fassung")
                .isEqualTo("Ines Kaltenbach");
        assertHerkunft(erste.path("herkunft"), 1, "R3 verbunden: vollständiger Herkunftssatz");

        JsonNode zweite = ruf("PUT", einstufungsPfad(), "IK",
                einstufung(ee1.path("herkunft"), "nicht_wesentlich", "K4", "2026-09-21",
                        "Nach erneuter Prüfung bleibt kein erhebliches Einsparpotenzial."),
                200, "R6 versioniert: Fassung 2");
        assertThat(zweite.path("fassung").asInt()).as("R6 versioniert: zweite Fassung").isEqualTo(2);
        JsonNode historie = ruf("GET", einstufungenPfad(), "IK", null, 200,
                "R6 versioniert: beide Fassungen lesen").path("fassungen");
        assertThat(historie.findValuesAsText("fassung")).as("R6 versioniert: Fassung 2 neben Fassung 1")
                .containsExactly("2", "1");
        assertThat(historie.get(1).path("begruendung").asText()).as("R6 begründet: alte Fassung bleibt lesbar")
                .contains("41,8 %");

        JsonNode bericht = ruf("POST", "/api/v1/berichte", "IK", Map.of("vorlage", "energetische_bewertung",
                "geltung_id", unternehmen.toString(), "zeitraum", "2026-10"), 201,
                "R7 Bühne: Bewertung anlegen");
        String kennung = bericht.path("kennung").asText();
        JsonNode entwurf1 = ruf("GET", berichtPfad(kennung, "/entwurf"), "IK", null, 200,
                "R7 Bühne: Entwurf mit Version 1");
        assertThat(entwurf1.path("abzug").findValuesAsText("version")).as("R7 Stand 1 zitiert Version 1")
                .contains("1").doesNotContain("2");
        ruf("POST", berichtPfad(kennung, "/freigeben"), "IK",
                Map.of("entwurf_datenstand", entwurf1.path("datenstand").asText()), 201,
                "R7 Bühne: Stand Nummer 1 freigeben");
        String stand1Pfad = berichtPfad(kennung, "/staende/1");
        JsonNode stand1Vorher = ruf("GET", stand1Pfad, "IK", null, 200, "R7 Stand 1 vor Korrektur");
        String abzug1Vorher = stand1Vorher.path("abzug").toString();
        String pruefsumme1Vorher = stand1Vorher.path("pruefsumme").asText();

        Instant korrekturZeit = JETZT.plusSeconds(86400);
        uhr(korrekturZeit);
        JsonNode korrektur = ruf("POST", ABLESUNGEN + "/" + ENDE + "/berichtigung", "IK",
                Map.of("stand", "128.340", "begruendung", "Ablesefehler um 60 kWh berichtigt."), 200,
                "R7 Korrektur: Monatswert berichtigen");
        String korrekturKennung = korrektur.path("korrektur").asText();
        KorrekturKaskade.Betroffen betroffen = new KorrekturKaskade.Betroffen(tenant, korrekturKennung, 2,
                KorrekturKaskade.FREIGEGEBEN, List.of(), Instant.parse("2026-09-30T22:00:00Z"),
                Instant.parse("2026-10-31T23:00:00Z"), ZoneId.of("Europe/Berlin"), LocalDate.parse("2026-10-01"),
                LocalDate.parse("2026-10-31"), List.of("MS-01"), List.of(), 1, korrekturZeit.plusSeconds(60));
        try (Connection con = root.getDataSource().getConnection()) {
            con.setAutoCommit(false);
            KorrekturKaskade.berichteBenachrichtigen(con, berichtKaskade, betroffen);
            con.commit();
        }
        uhr(korrekturZeit.plusSeconds(120));

        JsonNode detail = ruf("GET", berichtPfad(kennung, ""), "IK", null, 200,
                "R7 Anstoß: Bericht nennt die Korrektur");
        assertThat(detail.at("/anstoesse/0/anlass_kennung").asText()).as("R7 Anstoß-Vermerk mit Kennung")
                .isEqualTo(korrekturKennung);
        assertThat(detail.at("/anstoesse/0/nr").asInt()).as("R7 Anstoß hängt an Stand 1").isEqualTo(1);
        JsonNode stand1NachKorrektur = ruf("GET", stand1Pfad, "IK", null, 200, "R7 Stand 1 nach Korrektur");
        assertThat(stand1NachKorrektur.path("abzug").toString()).as("R7 Stand 1 bleibt byte-gleich")
                .isEqualTo(abzug1Vorher);
        assertThat(stand1NachKorrektur.path("pruefsumme").asText()).as("R7 Prüfsumme von Stand 1 bleibt gleich")
                .isEqualTo(pruefsumme1Vorher);

        JsonNode entwurf2 = ruf("GET", berichtPfad(kennung, "/entwurf"), "IK", null, 200,
                "R7 Bühne: Entwurf nach Korrektur");
        assertThat(entwurf2.path("abzug").findValuesAsText("version")).as("R7 neuer Entwurf zeigt Version 2")
                .contains("2");
        JsonNode stand2 = ruf("POST", berichtPfad(kennung, "/freigeben"), "IK",
                Map.of("entwurf_datenstand", entwurf2.path("datenstand").asText()), 201,
                "R7 Stand 2 freigeben");
        assertThat(stand2.path("nr").asInt()).as("R7 versioniert: neuer Stand Nummer 2").isEqualTo(2);
        assertThat(stand2.path("abzug").findValuesAsText("version")).as("R7 Stand 2 zitiert Version 2")
                .contains("2");
        JsonNode stand1NebenStand2 = ruf("GET", stand1Pfad, "IK", null, 200, "R7 Stand 1 nach Stand 2");
        assertThat(stand1NebenStand2.path("abzug").toString()).as("R7 Stand 1 bleibt neben Stand 2 byte-gleich")
                .isEqualTo(abzug1Vorher);
        assertThat(stand1NebenStand2.path("pruefsumme").asText()).as("R7 Prüfsumme bleibt neben Stand 2 gleich")
                .isEqualTo(pruefsumme1Vorher);
        assertThat(stand1NebenStand2.path("ersetzt_durch_nr").asInt()).as("R7 Stand 1 verweist auf Stand 2")
                .isEqualTo(2);

        JsonNode dritte = ruf("PUT", einstufungsPfad(), "IK",
                einstufung(ee1.path("herkunft"), "nicht_wesentlich", "K4", "2026-09-22",
                        "Leckagen beseitigt; der Einsatz wird begründet zurückgestuft."),
                200, "R13 Rückstufung: Fassung 3");
        assertThat(dritte.path("fassung").asInt()).as("R13 Rückstufung ist Fassung 3").isEqualTo(3);
        assertThat(dritte.path("einstufung").asText()).as("R13 Rückstufung bleibt eine Einstufung")
                .isEqualTo("nicht_wesentlich");
        assertThat(ruf("GET", einstufungenPfad(), "IK", null, 200, "R13 Historie lesen")
                .path("fassungen").findValuesAsText("fassung")).as("R13 alle drei Fassungen bleiben lesbar")
                .containsExactly("3", "2", "1");

        root.update("UPDATE unternehmen SET vieraugen_freigabe=true WHERE id=?", unternehmen);
        JsonNode vorgeschlagen = ruf("PUT", einstufungsPfad(), "IK",
                einstufung(ee1.path("herkunft"), "wesentlich", "K4", "2026-09-23",
                        "Sommerbetrieb und Einsparpotenzial werden erneut bewertet."),
                200, "R17 Vier-Augen: Ines schlägt vor");
        assertThat(vorgeschlagen.path("freigabe_status").asText()).as("R17 Vorschlag ist noch nicht wirksam")
                .isEqualTo("beantragt");
        assertThat(vorgeschlagen.path("gueltig_ab").isNull())
                .as("R17 Vorschlag hat noch keinen Geltungsbeginn").isTrue();
        assertThat(ruf("POST", bestaetigenPfad(), "IK", null, 403, "R17 Vier-Augen: Urheber ausgeschlossen")
                .path("code").asText()).as("R17 dieselbe Person darf nicht bestätigen")
                .isEqualTo("zweite_person_noetig");
        JsonNode bestaetigt = ruf("POST", bestaetigenPfad(), "JW", null, 200,
                "R17 Vier-Augen: Jonas bestätigt");
        assertThat(bestaetigt.path("freigabe_status").asText()).as("R17 zweite Person macht die Fassung wirksam")
                .isEqualTo("freigegeben");
        assertThat(bestaetigt.at("/entschieden_von/name").asText()).as("R17 Bestätigung nennt Jonas Wendlinger")
                .isEqualTo("Jonas Wendlinger");
    }

    private static void assertHerkunft(JsonNode herkunft, int version, String stufe) {
        assertThat(herkunft.path("kriterien_fassung").asInt()).as(stufe + " · Kriterien-Fassung").isEqualTo(1);
        assertThat(herkunft.path("eingaenge").findValuesAsText("version")).as(stufe + " · jede Eingangs-Version")
                .isNotEmpty().containsOnly(String.valueOf(version));
        assertThat(herkunft.at("/nenner/bilanzwerte").findValuesAsText("version"))
                .as(stufe + " · jede Bilanz-Version").isNotEmpty().containsOnly(String.valueOf(version));
    }

    private static ObjectNode einstufung(JsonNode herkunft, String wert, String grund, String tag, String begruendung) {
        ObjectNode anfrage = JSON.createObjectNode();
        anfrage.put("einstufung", wert).put("begruendung", begruendung).put("gueltig_ab", tag);
        anfrage.putArray("grund").add(grund);
        anfrage.set("herkunft", herkunft.deepCopy());
        return anfrage;
    }

    private static JsonNode einsatz(JsonNode rangliste) {
        return java.util.stream.StreamSupport.stream(rangliste.path("einsaetze").spliterator(), false)
                .filter(e -> "EE-1".equals(e.path("kennzeichen").asText())).findFirst()
                .orElseThrow(() -> new AssertionError("EE-1 fehlt in der Ahrenberg-Rangliste"));
    }

    private void uhr(Instant zeitpunkt) {
        Clock uhr = Clock.fixed(zeitpunkt, ZoneOffset.UTC);
        ablesungen.uhrStellen(uhr);
        werte.uhrStellen(uhr);
        bilanz.uhrStellen(uhr);
        berichte.uhrStellen(uhr);
    }

    private String einstufungsPfad() {
        return EINSAETZE + "/" + einsatz + "/einstufung";
    }

    private String einstufungenPfad() {
        return EINSAETZE + "/" + einsatz + "/einstufungen";
    }

    private String bestaetigenPfad() {
        return EINSAETZE + "/" + einsatz + "/einstufung/bestaetigen";
    }

    private static String berichtPfad(String kennung, String suffix) {
        return "/api/v1/berichte/" + kennung + suffix;
    }

    private UUID uuid(String sql, Object... args) {
        return root.queryForObject(sql, UUID.class, args);
    }

    private void benutzer(String sub, String name, String rolle) {
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,?,'benutzer',?,'aktiv')",
                tenant, sub, name);
        root.update("INSERT INTO zugriff(tenant_id,benutzer_sub,rolle,standort_id,gueltig_ab,zeitzone) "
                + "VALUES (?,?,?,NULL,'2024-01-01','Europe/Berlin')", tenant, sub, rolle);
    }

    private JsonNode ruf(String method, String path, String sub, Object body, int status, String stufe)
            throws Exception {
        String text = rufText(method, path, sub, body, status, stufe);
        return text.isBlank() ? JSON.createObjectNode() : JSON.readTree(text);
    }

    private String rufText(String method, String path, String sub, Object body, int status, String stufe)
            throws Exception {
        String name = "IK".equals(sub) ? "Ines Kaltenbach" : "Jonas Wendlinger";
        Jwt token = Jwt.withTokenValue("test").header("alg", "none").subject(sub).issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600)).claim("tenant_id", tenant.toString())
                .claim("realm_access", Map.of("roles", List.of())).claim("name", name).build();
        var anfrage = request(HttpMethod.valueOf(method), path)
                .with(authentication(new KeycloakRealmRoleConverter().convert(token)));
        if (body != null) {
            anfrage.contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(body));
        }
        var antwort = mvc.perform(anfrage).andReturn().getResponse();
        assertThat(antwort.getStatus()).as(stufe + " · " + method + " " + path + " · "
                + antwort.getContentAsString()).isEqualTo(status);
        return antwort.getContentAsString(StandardCharsets.UTF_8);
    }
}
