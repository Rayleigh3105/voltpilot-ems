package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.fernwartung.SshTestSchluessel;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Fernwartung über das Portal (Entscheid E5, O3) gegen echtes TimescaleDB und
 * Keycloak: Schlüssel hinterlegen, Techniker-Zugang, Fenster öffnen und
 * schließen, der Soll-Stand für den Tunnel-Dienst, das Protokoll, das Löschen
 * eines gesperrten Techniker-Zugangs, der SSH-Schlüssel am Zugang - und die
 * Rollen-Grenzen auf jeder Route.
 *
 * <p>Die Fälle teilen sich EINE Datenbank. Der ganze Weg läuft zuerst, weil er
 * feste Adressen ab der ersten freien erwartet; das Löschen baut darauf auf
 * und prüft nur relativ zu dem, was es selbst anlegt.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
            "voltpilot.fernwartung.server-public-key=LnLMuBG+dDEeaEKlQrdTlPifX2fk0hOaB/NFc/BudjE=",
            "voltpilot.fernwartung.max-fenster-dauer=PT24H"
        })
@ActiveProfiles("local")
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class FernwartungApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    /** Gültige Referenzen mit Prüfzeichen (Anhang B des Konzepts). */
    private static final String PILOT = "edge-zay5sdd";
    private static final String ZWEITE = "edge-k7m2xq3";

    private static final String KEY_A = "jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM=";
    private static final String KEY_B = "SBsk0U9z6BgB/U8nb+L9PdK/46p7mBvWRQe8I0Vg3C0=";
    private static final String KEY_C = "FY4LLXFaOvh8LPZu/gA4AeS2WJjXkuOUPB4hlxBI8/Y=";
    private static final String KEY_D = "Pgf4aS+67rz4HdSHuy8KKgm5e/UP3xnrMWJskXaZB9c=";
    private static final String KEY_E = "dTkajHaCSCVbnmtc9YaXOW4Fvi51HANh0Fg2KTFV3kk=";
    private static final String KEY_F = "Skrz6Rjblq/I8mcs2kl+0mvkp3bs2IjY3us7VFInf/g=";
    private static final String KEY_G = "J6rNG4CFG4rBxl+z8To/r1PyuoEkEGjeXHqlbzGGwZ8=";

    private static final String BASE = "/api/v1/admin/fernwartung";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Container
    static final KeycloakContainer KEYCLOAK = new KeycloakContainer("quay.io/keycloak/keycloak:26.0.5")
            .withRealmImportFile("keycloak/voltpilot-realm.json");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", () -> APP_USER);
        registry.add("spring.datasource.password", () -> APP_PW);
        registry.add("voltpilot.admin-datasource.url", POSTGRES::getJdbcUrl);
        registry.add("voltpilot.admin-datasource.username", () -> ADMIN_USER);
        registry.add("voltpilot.admin-datasource.password", () -> ADMIN_PW);
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
        registry.add("spring.flyway.placeholders.appDbUser", () -> APP_USER);
        registry.add("spring.flyway.placeholders.appDbPassword", () -> APP_PW);
        registry.add("spring.flyway.placeholders.adminDbUser", () -> ADMIN_USER);
        registry.add("spring.flyway.placeholders.adminDbPassword", () -> ADMIN_PW);

        String realm = KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot";
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> realm);
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> realm + "/protocol/openid-connect/certs");
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Autowired
    @Qualifier("adminJdbcTemplate")
    JdbcTemplate adminJdbc;

    private final ObjectMapper json = new ObjectMapper();

    @Test
    @Order(1)
    void derGanzeWegVomSchluesselBisZumGeschlossenenFenster() throws Exception {
        String admin = token("admin", "admin");
        String dienst = serviceToken("voltpilot-tunnel-dienst", "voltpilot-tunnel-dienst-dev-secret");

        // ── Box-Schlüssel hinterlegen (Übergang bis D2) ───────────────────
        ResponseEntity<String> neu = send(HttpMethod.PUT, BASE + "/boxen/" + PILOT.toUpperCase() + "/schluessel",
                admin, Map.of("publicKey", KEY_A, "notiz", "Pilot Dirolf"));
        assertThat(neu.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        JsonNode antwort = json.readTree(neu.getBody());
        assertThat(antwort.get("ergebnis").asText()).isEqualTo("angelegt");
        assertThat(antwort.at("/box/edgeRef").asText()).as("Referenz kanonisch klein").isEqualTo(PILOT);
        assertThat(antwort.at("/box/adresse").asText()).isEqualTo("10.10.16.2");
        assertThat(antwort.at("/box/status").asText()).isEqualTo("aktiv");
        // Alles, was service-tunnel.sh für die Box braucht, steht in der Antwort.
        assertThat(antwort.at("/server/endpunkt").asText()).isEqualTo("wartung.voltpilot.de");
        assertThat(antwort.at("/server/port").asInt()).isEqualTo(51820);
        assertThat(antwort.at("/server/eingerichtet").asBoolean()).isTrue();
        assertThat(antwort.at("/server/technikerNetz").asText()).isEqualTo("10.10.32.0/24");

        // Ein wiederholter Werkstatt-Lauf ist kein Fehler und ändert nichts.
        ResponseEntity<String> nochmal = send(HttpMethod.PUT, BASE + "/boxen/" + PILOT + "/schluessel", admin,
                Map.of("publicKey", KEY_A));
        assertThat(nochmal.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(json.readTree(nochmal.getBody()).get("ergebnis").asText()).isEqualTo("unveraendert");

        // Ein ANDERER Schlüssel nur mit ausdrücklicher Markierung.
        ResponseEntity<String> ohneMarke = send(HttpMethod.PUT, BASE + "/boxen/" + PILOT + "/schluessel", admin,
                Map.of("publicKey", KEY_B));
        assertThat(ohneMarke.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(ohneMarke)).contains("Schlüsseltausch");
        ResponseEntity<String> getauscht = send(HttpMethod.PUT, BASE + "/boxen/" + PILOT + "/schluessel", admin,
                Map.of("publicKey", KEY_B, "schluesselTausch", true));
        assertThat(getauscht.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode nachTausch = json.readTree(getauscht.getBody());
        assertThat(nachTausch.get("ergebnis").asText()).isEqualTo("getauscht");
        assertThat(nachTausch.at("/box/adresse").asText()).as("die Adresse bleibt der Box").isEqualTo("10.10.16.2");

        // Zweite Box: nächste Adresse; ein schon vergebener Schlüssel nie doppelt.
        ResponseEntity<String> doppelt = send(HttpMethod.PUT, BASE + "/boxen/" + ZWEITE + "/schluessel", admin,
                Map.of("publicKey", KEY_B));
        assertThat(doppelt.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(doppelt)).contains(PILOT);
        ResponseEntity<String> zweite = send(HttpMethod.PUT, BASE + "/boxen/" + ZWEITE + "/schluessel", admin,
                Map.of("publicKey", KEY_A));
        assertThat(zweite.getStatusCode()).as("der alte Pilot-Schlüssel ist wieder frei").isEqualTo(HttpStatus.CREATED);
        assertThat(json.readTree(zweite.getBody()).at("/box/adresse").asText()).isEqualTo("10.10.16.3");

        // Tippfehler und Unsinn fallen vor jeder Zeile auf.
        assertThat(send(HttpMethod.PUT, BASE + "/boxen/edge-zay5sdp/schluessel", admin,
                Map.of("publicKey", KEY_C)).getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(send(HttpMethod.PUT, BASE + "/boxen/irgendwas/schluessel", admin,
                Map.of("publicKey", KEY_C)).getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(send(HttpMethod.PUT, BASE + "/boxen/edge-q2w3e4u/schluessel", admin,
                Map.of("publicKey", "kein-schluessel")).getStatusCode()).isIn(HttpStatus.BAD_REQUEST,
                HttpStatus.UNPROCESSABLE_ENTITY);

        // ── Techniker-Zugang ──────────────────────────────────────────────
        ResponseEntity<String> technikerNeu = send(HttpMethod.POST, BASE + "/techniker", admin,
                Map.of("name", "Max (Laptop)", "publicKey", KEY_C));
        assertThat(technikerNeu.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        JsonNode techniker = json.readTree(technikerNeu.getBody());
        String technikerId = techniker.at("/techniker/id").asText();
        assertThat(techniker.at("/techniker/adresse").asText()).isEqualTo("10.10.32.2");
        assertThat(techniker.at("/server/boxNetz").asText()).isEqualTo("10.10.16.0/20");
        // Ein Box-Schlüssel kann kein Techniker-Zugang werden.
        assertThat(send(HttpMethod.POST, BASE + "/techniker", admin,
                Map.of("name", "Doppelt", "publicKey", KEY_B)).getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

        // ── Ohne Fenster: Peers ja, Weg nein ──────────────────────────────
        JsonNode soll = getJson("/api/v1/fernwartung/soll", dienst);
        assertThat(soll.get("version").asInt()).isEqualTo(1);
        assertThat(soll.get("boxNetz").asText()).isEqualTo("10.10.16.0/20");
        assertThat(soll.get("peers")).hasSize(3);
        assertThat(soll.get("fenster")).isEmpty();

        // ── Fenster öffnen ────────────────────────────────────────────────
        ResponseEntity<String> ohneGrund = send(HttpMethod.POST, BASE + "/fenster", admin,
                Map.of("edgeRef", PILOT, "technikerId", technikerId, "grund", " ", "dauerMinuten", 60));
        assertThat(ohneGrund.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        ResponseEntity<String> zuLang = send(HttpMethod.POST, BASE + "/fenster", admin,
                Map.of("edgeRef", PILOT, "technikerId", technikerId, "grund", "Update", "dauerMinuten", 25 * 60));
        assertThat(zuLang.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(message(zuLang)).contains("24 Stunden");

        ResponseEntity<String> offen = send(HttpMethod.POST, BASE + "/fenster", admin,
                Map.of("edgeRef", PILOT, "technikerId", technikerId, "grund", "Update auf Stufe 2",
                        "dauerMinuten", 60));
        assertThat(offen.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        JsonNode fenster = json.readTree(offen.getBody());
        String fensterId = fenster.get("id").asText();
        assertThat(fenster.get("zustand").asText()).isEqualTo("offen");
        assertThat(fenster.get("geoeffnetVon").asText()).isEqualTo("admin");
        assertThat(Duration.between(Instant.parse(fenster.get("beginn").asText()),
                Instant.parse(fenster.get("ende").asText()))).isEqualTo(Duration.ofHours(1));

        ResponseEntity<String> ueberlappt = send(HttpMethod.POST, BASE + "/fenster", admin,
                Map.of("edgeRef", PILOT, "technikerId", technikerId, "grund", "Noch eins", "dauerMinuten", 30));
        assertThat(ueberlappt.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

        // Ein geplantes Fenster steht NICHT im Soll-Stand.
        ResponseEntity<String> geplant = send(HttpMethod.POST, BASE + "/fenster", admin,
                Map.of("edgeRef", ZWEITE, "technikerId", technikerId, "grund", "Termin morgen",
                        "dauerMinuten", 120, "beginn", Instant.now().plus(Duration.ofHours(20)).toString()));
        assertThat(geplant.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(json.readTree(geplant.getBody()).get("zustand").asText()).isEqualTo("geplant");

        soll = getJson("/api/v1/fernwartung/soll", dienst);
        assertThat(soll.get("fenster")).hasSize(1);
        JsonNode sollFenster = soll.get("fenster").get(0);
        assertThat(sollFenster.get("id").asText()).isEqualTo(fensterId);
        String pilotId = peer(soll, PILOT).get("id").asText();
        assertThat(sollFenster.get("boxId").asText()).isEqualTo(pilotId);
        assertThat(sollFenster.get("technikerId").asText()).isEqualTo(technikerId);
        assertThat(peer(soll, PILOT).get("publicKey").asText()).isEqualTo(KEY_B);
        assertThat(peer(soll, PILOT).get("adresse").asText()).isEqualTo("10.10.16.2");

        // Die Übersicht weiß, DASS abgeholt wurde - nicht, ob es wirkt.
        JsonNode uebersicht = getJson(BASE, admin);
        assertThat(uebersicht.get("abrufe")).hasSize(1);
        assertThat(uebersicht.at("/abrufe/0/dienst").asText()).isEqualTo("voltpilot-tunnel-dienst");
        assertThat(uebersicht.at("/abrufe/0/fenster").asInt()).isEqualTo(1);
        assertThat(uebersicht.get("fensterOffen").asLong()).isEqualTo(1);
        assertThat(uebersicht.get("fensterGeplant").asLong()).isEqualTo(1);
        assertThat(uebersicht.get("maxFensterMinuten").asLong()).isEqualTo(24 * 60);

        JsonNode boxen = getJson(BASE + "/boxen", admin);
        assertThat(boxen).hasSize(2);
        assertThat(boxen.get(0).get("laufendeFenster")).hasSize(1);

        // ── Vorzeitig schließen ───────────────────────────────────────────
        ResponseEntity<String> zu = send(HttpMethod.POST, BASE + "/fenster/" + fensterId + "/schliessen", admin, null);
        assertThat(zu.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(json.readTree(zu.getBody()).get("zustand").asText()).isEqualTo("geschlossen");
        assertThat(getJson("/api/v1/fernwartung/soll", dienst).get("fenster")).isEmpty();
        assertThat(send(HttpMethod.POST, BASE + "/fenster/" + fensterId + "/schliessen", admin, null)
                .getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

        // ── Sperren: Peer raus, geplantes Fenster abgesagt ────────────────
        ResponseEntity<String> gesperrt = send(HttpMethod.POST, BASE + "/techniker/" + technikerId + "/sperren",
                admin, Map.of("grund", "Laptop verloren"));
        assertThat(gesperrt.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(json.readTree(gesperrt.getBody()).get("status").asText()).isEqualTo("gesperrt");
        soll = getJson("/api/v1/fernwartung/soll", dienst);
        assertThat(soll.get("peers")).hasSize(2);
        JsonNode liste = getJson(BASE + "/fenster?box=" + ZWEITE, admin);
        assertThat(liste.get(0).get("zustand").asText()).isEqualTo("abgesagt");
        assertThat(send(HttpMethod.POST, BASE + "/fenster", admin,
                Map.of("edgeRef", PILOT, "technikerId", technikerId, "grund", "Gesperrt?", "dauerMinuten", 10))
                .getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(send(HttpMethod.POST, BASE + "/techniker/" + technikerId + "/entsperren", admin, null)
                .getStatusCode()).isEqualTo(HttpStatus.OK);

        ResponseEntity<String> boxGesperrt = send(HttpMethod.POST, BASE + "/boxen/" + ZWEITE + "/sperren", admin,
                null);
        assertThat(json.readTree(boxGesperrt.getBody()).get("status").asText()).isEqualTo("gesperrt");
        assertThat(getJson("/api/v1/fernwartung/soll", dienst).get("peers")).hasSize(2);

        // ── Das Protokoll ─────────────────────────────────────────────────
        JsonNode protokoll = getJson(BASE + "/protokoll?box=" + PILOT, admin);
        List<String> aktionen = new ArrayList<>();
        protokoll.forEach(e -> aktionen.add(e.get("aktion").asText()));
        assertThat(aktionen).containsExactly("fenster_geschlossen", "fenster_geoeffnet",
                "box_schluessel_getauscht", "box_schluessel_hinterlegt");
        JsonNode geoeffnet = protokoll.get(1);
        assertThat(geoeffnet.get("akteur").asText()).isEqualTo("admin");
        assertThat(geoeffnet.at("/details/grund").asText()).isEqualTo("Update auf Stufe 2");
        assertThat(geoeffnet.at("/details/techniker").asText()).isEqualTo("Max (Laptop)");
        assertThat(geoeffnet.get("technikerName").asText()).isEqualTo("Max (Laptop)");
        assertThat(protokoll.get(0).at("/details/anlass").asText()).isEqualTo("vorzeitig");

        JsonNode alles = getJson(BASE + "/protokoll", admin);
        List<String> alleAktionen = new ArrayList<>();
        alles.forEach(e -> alleAktionen.add(e.get("aktion").asText()));
        assertThat(alleAktionen).contains("techniker_angelegt", "techniker_gesperrt", "techniker_entsperrt",
                "box_gesperrt");

        // Append-only an der Datenbankgrenze, auch für die Admin-Rolle.
        assertThatThrownBy(() -> adminJdbc.update("DELETE FROM fernwartung_protokoll"))
                .rootCause().hasMessageContaining("permission denied");
        assertThatThrownBy(() -> adminJdbc.update("DELETE FROM fernwartung_zugang"))
                .rootCause().hasMessageContaining("permission denied");
    }

    /**
     * Der Fall des Kapitäns (08.10.2026): ein Zugang mit falschem Schlüssel
     * wird gesperrt, unter demselben Namen neu angelegt - und der alte soll
     * weg. „Löschen" nimmt ihn aus jeder Liste, lässt aber stehen, was die
     * Regel „nichts wird gelöscht" schützt: Adresse und Schlüssel bleiben
     * vergeben, Fenster und Protokoll nennen ihn weiter, und für den
     * Tunnel-Dienst ändert sich nichts.
     */
    @Test
    @Order(2)
    void einGesperrterZugangLaesstSichLoeschenUndBleibtVergeben() throws Exception {
        String admin = token("admin", "admin");
        String dienst = serviceToken("voltpilot-tunnel-dienst", "voltpilot-tunnel-dienst-dev-secret");
        String name = "Kapitän (Laptop)";
        Instant vorher = Instant.now().minusSeconds(5);

        // Eine aktive Box mit KEY_B, gleich ob der ganze Weg schon gelaufen ist.
        assertThat(send(HttpMethod.PUT, BASE + "/boxen/" + PILOT + "/schluessel", admin,
                Map.of("publicKey", KEY_B, "schluesselTausch", true)).getStatusCode().is2xxSuccessful()).isTrue();

        // ── Der Zugang mit dem falschen Schlüssel, einmal benutzt ─────────
        ResponseEntity<String> angelegt = send(HttpMethod.POST, BASE + "/techniker", admin,
                Map.of("name", name, "publicKey", KEY_D));
        assertThat(angelegt.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        JsonNode falsch = json.readTree(angelegt.getBody()).get("techniker");
        String falschId = falsch.get("id").asText();
        String falschAdresse = falsch.get("adresse").asText();
        assertThat(send(HttpMethod.POST, BASE + "/fenster", admin, Map.of("edgeRef", PILOT, "technikerId", falschId,
                "grund", "Erster Einsatz", "dauerMinuten", 30)).getStatusCode()).isEqualTo(HttpStatus.CREATED);

        // ── Ein AKTIVER Zugang lässt sich nicht löschen ───────────────────
        ResponseEntity<String> zuFrueh = send(HttpMethod.DELETE, BASE + "/techniker/" + falschId, admin, null);
        assertThat(zuFrueh.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(zuFrueh)).contains("Erst sperren");
        assertThat(werte(getJson(BASE + "/techniker", admin), "id")).contains(falschId);

        // ── Sperren, denselben Namen mit dem richtigen Schlüssel anlegen ──
        assertThat(send(HttpMethod.POST, BASE + "/techniker/" + falschId + "/sperren", admin,
                Map.of("grund", "falscher Schlüssel")).getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode richtig = json.readTree(send(HttpMethod.POST, BASE + "/techniker", admin,
                Map.of("name", name, "publicKey", KEY_E)).getBody()).get("techniker");
        String richtigId = richtig.get("id").asText();
        assertThat(werte(getJson(BASE + "/techniker", admin), "name")).as("zwei Einträge, ein Name")
                .filteredOn(name::equals).hasSize(2);
        long gesperrtVorher = getJson(BASE, admin).get("technikerGesperrt").asLong();
        JsonNode sollVorher = getJson("/api/v1/fernwartung/soll", dienst);

        // ── Löschen ───────────────────────────────────────────────────────
        ResponseEntity<String> geloescht = send(HttpMethod.DELETE, BASE + "/techniker/" + falschId, admin, null);
        assertThat(geloescht.getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);

        // Weg aus der Liste (aus ihr speist sich jede Auswahl) und aus den Zählern.
        JsonNode liste = getJson(BASE + "/techniker", admin);
        assertThat(werte(liste, "id")).doesNotContain(falschId).contains(richtigId);
        assertThat(werte(liste, "name")).filteredOn(name::equals).hasSize(1);
        assertThat(werte(liste, "status")).as("der dritte Zustand verlässt die API nie")
                .isSubsetOf("aktiv", "gesperrt");
        assertThat(getJson(BASE, admin).get("technikerGesperrt").asLong()).isEqualTo(gesperrtVorher - 1);

        // Der Soll-Stand ist derselbe wie vor dem Löschen: der gesperrte Zugang
        // stand schon nicht darin, der Tunnel-Dienst merkt vom Löschen nichts.
        JsonNode soll = getJson("/api/v1/fernwartung/soll", dienst);
        assertThat(soll.get("peers")).isEqualTo(sollVorher.get("peers"));
        assertThat(soll.get("fenster")).isEqualTo(sollVorher.get("fenster"));
        assertThat(werte(soll.get("peers"), "id")).doesNotContain(falschId).contains(richtigId);
        assertThat(werte(soll.get("peers"), "publicKey")).doesNotContain(KEY_D);
        assertThat(werte(soll.get("peers"), "adresse")).doesNotContain(falschAdresse);

        // ── Für jede Regel weg: kein Entsperren, kein zweites Löschen ─────
        assertThat(send(HttpMethod.POST, BASE + "/techniker/" + falschId + "/entsperren", admin, null)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(send(HttpMethod.POST, BASE + "/techniker/" + falschId + "/sperren", admin, null)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(send(HttpMethod.DELETE, BASE + "/techniker/" + falschId, admin, null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(send(HttpMethod.POST, BASE + "/fenster", admin, Map.of("edgeRef", PILOT, "technikerId", falschId,
                "grund", "Gelöscht?", "dauerMinuten", 10)).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(werte(getJson(BASE + "/techniker", admin), "id")).doesNotContain(falschId);

        // ── Schlüssel und Adresse bleiben vergeben ────────────────────────
        ResponseEntity<String> selberSchluessel = send(HttpMethod.POST, BASE + "/techniker", admin,
                Map.of("name", "Zweitgerät", "publicKey", KEY_D));
        assertThat(selberSchluessel.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(selberSchluessel)).contains("gelöschten Zugang").contains("nicht wieder vergeben");
        ResponseEntity<String> alsBox = send(HttpMethod.PUT, BASE + "/boxen/" + PILOT + "/schluessel", admin,
                Map.of("publicKey", KEY_D, "schluesselTausch", true));
        assertThat(alsBox.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(alsBox)).contains("gelöschten Zugang");

        JsonNode dritter = json.readTree(send(HttpMethod.POST, BASE + "/techniker", admin,
                Map.of("name", "Werkstatt-Tablet", "publicKey", KEY_F)).getBody()).get("techniker");
        assertThat(dritter.get("adresse").asText()).as("die freigewordene Adresse wird NICHT neu vergeben")
                .isNotEqualTo(falschAdresse).isNotEqualTo(richtig.get("adresse").asText());
        assertThat(werte(getJson(BASE + "/techniker", admin), "adresse")).doesNotContain(falschAdresse);
        Map<String, Object> zeile = adminJdbc.queryForMap("SELECT status, name, public_key, "
                + "host(tunnel_adresse) AS adresse FROM fernwartung_zugang WHERE id = ?::uuid", falschId);
        assertThat(zeile).containsEntry("status", "geloescht").containsEntry("name", name)
                .containsEntry("public_key", KEY_D).containsEntry("adresse", falschAdresse);

        // ── Das Protokoll trägt den Eintrag, die älteren bleiben lesbar ───
        JsonNode protokoll = getJson(BASE + "/protokoll?techniker=" + falschId, admin);
        assertThat(werte(protokoll, "aktion")).containsExactly("techniker_geloescht", "techniker_gesperrt",
                "fenster_geschlossen", "fenster_geoeffnet", "techniker_angelegt");
        assertThat(werte(protokoll, "technikerName")).as("jeder Eintrag nennt ihn weiter beim Namen")
                .containsOnly(name);
        JsonNode eintrag = protokoll.get(0);
        assertThat(eintrag.get("akteur").asText()).isEqualTo("admin");
        assertThat(Instant.parse(eintrag.get("zeit").asText())).isBetween(vorher, Instant.now().plusSeconds(5));
        assertThat(eintrag.at("/details/name").asText()).isEqualTo(name);
        assertThat(eintrag.at("/details/adresse").asText()).isEqualTo(falschAdresse);
        assertThat(werte(getJson(BASE + "/protokoll", admin), "aktion")).contains("techniker_geloescht");

        JsonNode fenster = getJson(BASE + "/fenster?techniker=" + falschId, admin);
        assertThat(fenster).hasSize(1);
        assertThat(fenster.get(0).get("technikerName").asText()).isEqualTo(name);
        assertThat(fenster.get(0).get("grund").asText()).isEqualTo("Erster Einsatz");
        assertThat(fenster.get(0).get("zustand").asText()).isEqualTo("geschlossen");
        assertThat(werte(getJson(BASE + "/fenster?box=" + PILOT, admin), "technikerId")).contains(falschId);

        // ── Endgültig an der Datenbankgrenze ──────────────────────────────
        assertThatThrownBy(() -> adminJdbc.update(
                "UPDATE fernwartung_zugang SET status = 'gesperrt' WHERE id = ?::uuid", falschId))
                .rootCause().hasMessageContaining("endgueltig");
        assertThatThrownBy(() -> adminJdbc.update(
                "UPDATE fernwartung_zugang SET public_key = ? WHERE id = ?::uuid", KEY_G, falschId))
                .rootCause().hasMessageContaining("endgueltig");
        assertThatThrownBy(() -> adminJdbc.update(
                "UPDATE fernwartung_zugang SET status = 'geloescht' WHERE id = ?::uuid", richtigId))
                .as("nie direkt aus aktiv").rootCause().hasMessageContaining("nur ein gesperrter");
        assertThatThrownBy(() -> adminJdbc.update("DELETE FROM fernwartung_zugang WHERE id = ?::uuid", falschId))
                .rootCause().hasMessageContaining("permission denied");

        // Das Protokoll bleibt unveränderbar: der Admin-Rolle fehlt das Recht,
        // und selbst der Schema-Eigentümer scheitert am Trigger - auch daran,
        // die Zeile des gelöschten Zugangs physisch zu entfernen.
        assertThatThrownBy(() -> adminJdbc.update(
                "UPDATE fernwartung_protokoll SET aktion = 'techniker_entsperrt' WHERE techniker_id = ?::uuid",
                falschId)).rootCause().hasMessageContaining("permission denied");
        JdbcTemplate eigner = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
        assertThatThrownBy(() -> eigner.update(
                "UPDATE fernwartung_protokoll SET akteur = 'niemand' WHERE techniker_id = ?::uuid", falschId))
                .rootCause().hasMessageContaining("append-only");
        assertThatThrownBy(() -> eigner.update(
                "DELETE FROM fernwartung_protokoll WHERE techniker_id = ?::uuid", falschId))
                .rootCause().hasMessageContaining("append-only");
        assertThatThrownBy(() -> eigner.update("DELETE FROM fernwartung_zugang WHERE id = ?::uuid", falschId))
                .rootCause().hasMessageContaining("foreign key");
        assertThat(werte(getJson(BASE + "/protokoll?techniker=" + falschId, admin), "aktion")).hasSize(5);
    }

    /**
     * Fenster-Schlüssel, Schritt 1 (Entscheid vom 09.10.2026): der Techniker
     * hinterlegt seinen öffentlichen SSH-Schlüssel am Zugang, das Portal zeigt
     * den Fingerabdruck, und der Soll-Stand gibt ihn dem Tunnel-Dienst mit.
     * Die Schlüssel entstehen zur Laufzeit; nur ihr öffentlicher Teil.
     */
    @Test
    @Order(3)
    void derSshSchluesselStehtAmZugangImSollStandUndImProtokoll() throws Exception {
        String admin = token("admin", "admin");
        String dienst = serviceToken("voltpilot-tunnel-dienst", "voltpilot-tunnel-dienst-dev-secret");
        String rsa3072 = SshTestSchluessel.rsa(3072);
        String rsa2048 = SshTestSchluessel.rsa(2048);
        String rsa4096 = SshTestSchluessel.rsa(4096);
        String wgMit = wireguardSchluessel();
        String wgOhne = wireguardSchluessel();

        assertThat(send(HttpMethod.PUT, BASE + "/boxen/" + PILOT + "/schluessel", admin,
                Map.of("publicKey", KEY_B, "schluesselTausch", true)).getStatusCode().is2xxSuccessful()).isTrue();

        // ── Anlegen: Ed25519 wird mit dem passenden Befehl abgelehnt ──────
        ResponseEntity<String> ed = send(HttpMethod.POST, BASE + "/techniker", admin, Map.of("name", "Mit SSH",
                "publicKey", wgMit, "sshPublicKey", SshTestSchluessel.ed25519() + " max@laptop"));
        assertThat(ed.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(message(ed)).contains("Ed25519").contains("nur RSA").contains("ssh-keygen -t rsa -b 3072");
        assertThat(werte(getJson(BASE + "/techniker", admin), "name")).as("nichts angelegt")
                .doesNotContain("Mit SSH");

        // ── Anlegen mit Schlüssel: Kommentar weg, Fingerabdruck zurück ────
        ResponseEntity<String> neu = send(HttpMethod.POST, BASE + "/techniker", admin, Map.of("name", "Mit SSH",
                "publicKey", wgMit, "sshPublicKey", "  " + rsa3072 + "   max@laptop\n"));
        assertThat(neu.getStatusCode()).as("derselbe WireGuard-Schlüssel war nach der Ablehnung noch frei")
                .isEqualTo(HttpStatus.CREATED);
        JsonNode mit = json.readTree(neu.getBody()).get("techniker");
        String mitId = mit.get("id").asText();
        assertThat(mit.get("sshPublicKey").asText()).isEqualTo(rsa3072);
        assertThat(mit.get("sshFingerabdruck").asText()).isEqualTo(SshTestSchluessel.fingerabdruck(rsa3072));
        assertThat(mit.get("sshBits").asInt()).isEqualTo(3072);
        assertThat(adminJdbc.queryForObject("SELECT ssh_public_key FROM fernwartung_zugang WHERE id = ?::uuid",
                String.class, mitId)).as("gespeichert wird die Normalform").isEqualTo(rsa3072);

        // ── Anlegen ohne Schlüssel bleibt möglich: der Zugang ist reiner Netzweg ──
        JsonNode ohne = json.readTree(send(HttpMethod.POST, BASE + "/techniker", admin,
                Map.of("name", "Ohne SSH", "publicKey", wgOhne)).getBody()).get("techniker");
        String ohneId = ohne.get("id").asText();
        for (String feld : List.of("sshPublicKey", "sshFingerabdruck", "sshBits")) {
            assertThat(ohne.get(feld).isNull()).as(feld).isTrue();
        }
        assertThat(send(HttpMethod.POST, BASE + "/fenster", admin, Map.of("edgeRef", PILOT, "technikerId", ohneId,
                "grund", "Nur Netzweg", "dauerMinuten", 10)).getStatusCode())
                .as("ein Fenster hängt nicht am SSH-Schlüssel").isEqualTo(HttpStatus.CREATED);

        // ── Soll-Stand: Zusatzfeld nur am Techniker-Peer mit Schlüssel, Version 1 ──
        JsonNode soll = getJson("/api/v1/fernwartung/soll", dienst);
        assertThat(soll.get("version").asInt()).isEqualTo(1);
        assertThat(peerMitId(soll, mitId).get("sshPublicKey").asText()).isEqualTo(rsa3072);
        assertThat(peerMitId(soll, ohneId).has("sshPublicKey")).as("ohne Schlüssel fehlt das Feld").isFalse();
        for (JsonNode p : soll.get("peers")) {
            if ("box".equals(p.get("art").asText())) {
                assertThat(p.has("sshPublicKey")).as("eine Box trägt nie einen SSH-Schlüssel").isFalse();
            }
        }
        assertThat(werte(soll.get("fenster"), "technikerId")).contains(ohneId);

        // ── Später setzen, unverändert wiederholen, ersetzen ──────────────
        String route = BASE + "/techniker/" + ohneId + "/ssh-schluessel";
        ResponseEntity<String> gesetzt = send(HttpMethod.PUT, route, admin,
                Map.of("sshPublicKey", rsa2048 + " kapitaen@laptop"));
        assertThat(gesetzt.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode nachSetzen = json.readTree(gesetzt.getBody());
        assertThat(nachSetzen.get("sshPublicKey").asText()).isEqualTo(rsa2048);
        assertThat(nachSetzen.get("sshFingerabdruck").asText()).isEqualTo(SshTestSchluessel.fingerabdruck(rsa2048));
        assertThat(nachSetzen.get("sshBits").asInt()).isEqualTo(2048);
        assertThat(peerMitId(getJson("/api/v1/fernwartung/soll", dienst), ohneId).get("sshPublicKey").asText())
                .isEqualTo(rsa2048);

        assertThat(send(HttpMethod.PUT, route, admin, Map.of("sshPublicKey", rsa2048)).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(werte(getJson(BASE + "/protokoll?techniker=" + ohneId, admin), "aktion"))
                .as("derselbe Schlüssel noch einmal steht nicht im Protokoll")
                .filteredOn("techniker_ssh_schluessel_gesetzt"::equals).hasSize(1);

        assertThat(send(HttpMethod.PUT, route, admin, Map.of("sshPublicKey", rsa4096)).getStatusCode())
                .isEqualTo(HttpStatus.OK);

        // ── Schlechte Eingaben ändern nichts ──────────────────────────────
        Map<String, String> schlecht = new HashMap<>();
        schlecht.put(SshTestSchluessel.rsa(1024), "nur 1024 Bit");
        schlecht.put(SshTestSchluessel.ed25519(), "ssh-keygen -t rsa -b 3072");
        schlecht.put(rsa2048 + "\n" + rsa3072, "genau eine Zeile");
        schlecht.put("command=\"/bin/sh\" " + rsa2048, "keine Optionen");
        schlecht.put("das ist kein schluessel", "kein öffentlicher SSH-Schlüssel");
        schlecht.put(rsa2048.substring(0, 200), "beschädigt");
        schlecht.put("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END OPENSSH PRIVATE KEY-----",
                "privater Schlüssel");
        schlecht.put(" ", "fehlt");
        for (Map.Entry<String, String> fall : schlecht.entrySet()) {
            ResponseEntity<String> res = send(HttpMethod.PUT, route, admin, Map.of("sshPublicKey", fall.getKey()));
            assertThat(res.getStatusCode()).as(fall.getValue()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(message(res)).contains(fall.getValue());
        }
        ResponseEntity<String> leer = send(HttpMethod.PUT, route, admin, Map.of());
        assertThat(leer.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(message(leer)).contains("fehlt");
        assertThat(werte(getJson(BASE + "/techniker", admin), "sshFingerabdruck"))
                .contains(SshTestSchluessel.fingerabdruck(rsa4096), SshTestSchluessel.fingerabdruck(rsa3072));

        // ── Gesperrt: der Schlüssel lässt sich pflegen, steht aber nicht im Soll ──
        assertThat(send(HttpMethod.POST, BASE + "/techniker/" + mitId + "/sperren", admin, null).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(werte(getJson("/api/v1/fernwartung/soll", dienst).get("peers"), "id")).doesNotContain(mitId);
        assertThat(send(HttpMethod.PUT, BASE + "/techniker/" + mitId + "/ssh-schluessel", admin,
                Map.of("sshPublicKey", rsa4096)).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(send(HttpMethod.POST, BASE + "/techniker/" + mitId + "/entsperren", admin, null).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        JsonNode beide = getJson("/api/v1/fernwartung/soll", dienst);
        assertThat(peerMitId(beide, mitId).get("sshPublicKey").asText())
                .as("zwei Zugänge dürfen denselben SSH-Schlüssel tragen").isEqualTo(rsa4096)
                .isEqualTo(peerMitId(beide, ohneId).get("sshPublicKey").asText());

        // ── Entfernen: zurück zum reinen Netzweg ──────────────────────────
        ResponseEntity<String> entfernt = send(HttpMethod.DELETE, route, admin, null);
        assertThat(entfernt.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(json.readTree(entfernt.getBody()).get("sshFingerabdruck").isNull()).isTrue();
        assertThat(json.readTree(entfernt.getBody()).get("status").asText()).isEqualTo("aktiv");
        assertThat(peerMitId(getJson("/api/v1/fernwartung/soll", dienst), ohneId).has("sshPublicKey")).isFalse();
        assertThat(send(HttpMethod.DELETE, route, admin, null).getStatusCode()).as("idempotent")
                .isEqualTo(HttpStatus.OK);

        // ── Das Protokoll ─────────────────────────────────────────────────
        JsonNode protokoll = getJson(BASE + "/protokoll?techniker=" + ohneId, admin);
        assertThat(werte(protokoll, "aktion")).containsExactly("techniker_ssh_schluessel_entfernt",
                "techniker_ssh_schluessel_gesetzt", "techniker_ssh_schluessel_gesetzt", "fenster_geoeffnet",
                "techniker_angelegt");
        assertThat(protokoll.get(0).at("/details/fingerabdruck").asText())
                .isEqualTo(SshTestSchluessel.fingerabdruck(rsa4096));
        assertThat(protokoll.get(0).get("akteur").asText()).isEqualTo("admin");
        assertThat(protokoll.get(1).at("/details/fingerabdruck").asText())
                .isEqualTo(SshTestSchluessel.fingerabdruck(rsa4096));
        assertThat(protokoll.get(1).at("/details/vorher").asText())
                .isEqualTo(SshTestSchluessel.fingerabdruck(rsa2048));
        assertThat(protokoll.get(1).at("/details/bits").asText()).isEqualTo("4096");
        assertThat(protokoll.get(2).at("/details/fingerabdruck").asText())
                .isEqualTo(SshTestSchluessel.fingerabdruck(rsa2048));
        assertThat(protokoll.get(2).get("details").has("vorher")).as("vorher gab es keinen").isFalse();
        assertThat(protokoll.get(4).get("details").has("sshFingerabdruck")).isFalse();
        JsonNode angelegtMit = getJson(BASE + "/protokoll?techniker=" + mitId, admin);
        assertThat(angelegtMit.get(angelegtMit.size() - 1).at("/details/sshFingerabdruck").asText())
                .isEqualTo(SshTestSchluessel.fingerabdruck(rsa3072));
        assertThat(protokoll.toString() + angelegtMit).as("im Protokoll steht nur der Fingerabdruck")
                .doesNotContain(rsa2048.substring(8, 60)).doesNotContain(rsa3072.substring(8, 60));

        // ── Unbekannt oder gelöscht: 404 ──────────────────────────────────
        String niemand = BASE + "/techniker/00000000-0000-0000-0000-000000000000/ssh-schluessel";
        assertThat(send(HttpMethod.PUT, niemand, admin, Map.of("sshPublicKey", rsa2048)).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(send(HttpMethod.DELETE, niemand, admin, null).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(send(HttpMethod.POST, BASE + "/techniker/" + mitId + "/sperren", admin, null).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(send(HttpMethod.DELETE, BASE + "/techniker/" + mitId, admin, null).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(send(HttpMethod.PUT, BASE + "/techniker/" + mitId + "/ssh-schluessel", admin,
                Map.of("sshPublicKey", rsa3072)).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(send(HttpMethod.DELETE, BASE + "/techniker/" + mitId + "/ssh-schluessel", admin, null)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(adminJdbc.queryForObject("SELECT ssh_public_key FROM fernwartung_zugang WHERE id = ?::uuid",
                String.class, mitId)).as("die gelöschte Zeile bleibt, wie sie war").isEqualTo(rsa4096);

        // ── Die Datenbank hält die grobe Form selbst ──────────────────────
        assertThatThrownBy(() -> adminJdbc.update(
                "UPDATE fernwartung_zugang SET ssh_public_key = ? WHERE edge_ref = ?", rsa2048, PILOT))
                .as("eine Box trägt keinen SSH-Schlüssel").rootCause()
                .hasMessageContaining("fernwartung_zugang_ssh_art_chk");
        for (String unform : List.of(rsa2048 + " max@laptop", SshTestSchluessel.ed25519(),
                SshTestSchluessel.rsa(1024), rsa2048 + "\n" + rsa2048, "")) {
            assertThatThrownBy(() -> adminJdbc.update(
                    "UPDATE fernwartung_zugang SET ssh_public_key = ? WHERE id = ?::uuid", unform, ohneId))
                    .rootCause().hasMessageContaining("fernwartung_zugang_ssh_form_chk");
        }
    }

    /**
     * O3 und die Rollen-Grenze: der Kunde sieht nichts, das Dienstkonto liest
     * nur seinen Soll-Stand, der Release-Publisher erreicht hier nichts.
     */
    @Test
    void nurAdminsVerwaltenUndDerDienstLiestNur() {
        String admin = token("admin", "admin");
        String kunde = token("demo", "demo");
        String dienst = serviceToken("voltpilot-tunnel-dienst", "voltpilot-tunnel-dienst-dev-secret");
        String publisher = serviceToken("voltpilot-release-publisher", "voltpilot-release-publisher-dev-secret");

        List<Object[]> adminRouten = List.of(
                new Object[] {HttpMethod.GET, BASE, null},
                new Object[] {HttpMethod.GET, BASE + "/boxen", null},
                new Object[] {HttpMethod.GET, BASE + "/boxen/" + PILOT, null},
                new Object[] {HttpMethod.PUT, BASE + "/boxen/" + PILOT + "/schluessel", Map.of("publicKey", KEY_D)},
                new Object[] {HttpMethod.POST, BASE + "/boxen/" + PILOT + "/sperren", null},
                new Object[] {HttpMethod.POST, BASE + "/boxen/" + PILOT + "/entsperren", null},
                new Object[] {HttpMethod.GET, BASE + "/techniker", null},
                new Object[] {HttpMethod.POST, BASE + "/techniker", Map.of("name", "x", "publicKey", KEY_D)},
                new Object[] {HttpMethod.DELETE, BASE + "/techniker/00000000-0000-0000-0000-000000000000", null},
                new Object[] {HttpMethod.PUT,
                        BASE + "/techniker/00000000-0000-0000-0000-000000000000/ssh-schluessel",
                        Map.of("sshPublicKey", "ssh-rsa AAAA")},
                new Object[] {HttpMethod.DELETE,
                        BASE + "/techniker/00000000-0000-0000-0000-000000000000/ssh-schluessel", null},
                new Object[] {HttpMethod.GET, BASE + "/fenster", null},
                new Object[] {HttpMethod.POST, BASE + "/fenster", Map.of("edgeRef", PILOT,
                        "technikerId", "00000000-0000-0000-0000-000000000000", "grund", "x", "dauerMinuten", 5)},
                new Object[] {HttpMethod.POST, BASE + "/fenster/00000000-0000-0000-0000-000000000000/schliessen",
                        null},
                new Object[] {HttpMethod.GET, BASE + "/protokoll", null});
        for (Object[] r : adminRouten) {
            HttpMethod m = (HttpMethod) r[0];
            String pfad = (String) r[1];
            for (String fremd : List.of(kunde, dienst, publisher)) {
                assertThat(send(m, pfad, fremd, r[2]).getStatusCode()).as(m + " " + pfad)
                        .isEqualTo(HttpStatus.FORBIDDEN);
            }
            assertThat(send(m, pfad, null, r[2]).getStatusCode()).as("anonym " + m + " " + pfad)
                    .isEqualTo(HttpStatus.UNAUTHORIZED);
        }

        // Die Leseroute: nur das Dienstkonto, auch kein Admin.
        for (String fremd : List.of(admin, kunde, publisher)) {
            assertThat(send(HttpMethod.GET, "/api/v1/fernwartung/soll", fremd, null).getStatusCode())
                    .isEqualTo(HttpStatus.FORBIDDEN);
        }
        assertThat(send(HttpMethod.GET, "/api/v1/fernwartung/soll", null, null).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        ResponseEntity<String> soll = send(HttpMethod.GET, "/api/v1/fernwartung/soll", dienst, null);
        assertThat(soll.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(soll.getHeaders().getCacheControl()).contains("no-store");
        // Nur Leserecht: es gibt keine schreibende Methode auf dem Pfad.
        assertThat(send(HttpMethod.POST, "/api/v1/fernwartung/soll", dienst, Map.of()).getStatusCode())
                .isIn(HttpStatus.METHOD_NOT_ALLOWED, HttpStatus.FORBIDDEN);

        // O3 an der Datenbankgrenze: die App-Rolle (der Kunden-Datenpfad)
        // liest keine einzige Fernwartungs-Tabelle.
        JdbcTemplate app = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), APP_USER, APP_PW));
        for (String tabelle : List.of("fernwartung_zugang", "fernwartung_fenster", "fernwartung_protokoll",
                "fernwartung_dienst_abruf")) {
            assertThatThrownBy(() -> app.queryForObject("SELECT count(*) FROM " + tabelle, Long.class))
                    .as(tabelle).rootCause().hasMessageContaining("permission denied");
        }
    }

    // ── Hilfen ────────────────────────────────────────────────────────────

    private JsonNode peer(JsonNode soll, String kennung) {
        for (JsonNode p : soll.get("peers")) {
            if (kennung.equals(p.get("kennung").asText())) {
                return p;
            }
        }
        throw new AssertionError("kein Peer " + kennung + " in " + soll);
    }

    private JsonNode peerMitId(JsonNode soll, String id) {
        for (JsonNode p : soll.get("peers")) {
            if (id.equals(p.get("id").asText())) {
                return p;
            }
        }
        throw new AssertionError("kein Peer " + id + " in " + soll);
    }

    /** Ein frischer öffentlicher WireGuard-Schlüssel: 32 zufällige Byte. */
    private static String wireguardSchluessel() {
        byte[] roh = new byte[32];
        new java.security.SecureRandom().nextBytes(roh);
        return Base64.getEncoder().encodeToString(roh);
    }

    /** Die Werte eines Feldes über alle Einträge einer Liste. */
    private static List<String> werte(JsonNode liste, String feld) {
        List<String> werte = new ArrayList<>();
        liste.forEach(e -> werte.add(e.get(feld).asText()));
        return werte;
    }

    private String message(ResponseEntity<String> res) throws Exception {
        return json.readTree(res.getBody()).get("message").asText();
    }

    private JsonNode getJson(String pfad, String token) {
        ResponseEntity<String> res = send(HttpMethod.GET, pfad, token, null);
        assertThat(res.getStatusCode()).as("GET " + pfad).isEqualTo(HttpStatus.OK);
        try {
            return json.readTree(res.getBody());
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    private ResponseEntity<String> send(HttpMethod method, String pfad, String token, Object body) {
        HttpHeaders h = new HttpHeaders();
        if (token != null) {
            h.setBearerAuth(token);
        }
        h.setContentType(MediaType.APPLICATION_JSON);
        return rest.exchange("http://localhost:" + port + pfad, method, new HttpEntity<>(body, h), String.class);
    }

    private String token(String username, String password) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", "voltpilot-api");
        form.add("client_secret", "voltpilot-api-dev-secret");
        form.add("username", username);
        form.add("password", password);
        form.add("scope", "openid");
        return tokenAnfrage(form);
    }

    private String serviceToken(String clientId, String clientSecret) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "client_credentials");
        form.add("client_id", clientId);
        form.add("client_secret", clientSecret);
        return tokenAnfrage(form);
    }

    @SuppressWarnings("unchecked")
    private String tokenAnfrage(MultiValueMap<String, String> form) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        TestRestTemplate keycloak = new TestRestTemplate();
        keycloak.getRestTemplate().setRequestFactory(new JdkClientHttpRequestFactory());
        Map<String, Object> body = keycloak.postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).containsKey("access_token");
        return (String) body.get("access_token");
    }
}
