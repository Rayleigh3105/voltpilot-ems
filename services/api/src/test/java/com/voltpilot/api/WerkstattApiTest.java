package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.fernwartung.SshTestSchluessel;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
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
 * Die Werkstatt (erster Schnitt aus dem Bericht voltpilot-box-einrichtung-portal)
 * gegen echtes TimescaleDB und Keycloak: Register, Schritte, LAN-Netz nach
 * Entscheid 6a, die Abnahme nach der Werkstatt-Regel mit dem Fenster der
 * Werkstatt-Probe - und die Grenzen: nur platform-admin, keine Zeile für die
 * App-Rolle, das Protokoll append-only.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
            "voltpilot.fernwartung.server-public-key=LnLMuBG+dDEeaEKlQrdTlPifX2fk0hOaB/NFc/BudjE=",
            "voltpilot.fernwartung.max-fenster-dauer=PT24H"
        })
@ActiveProfiles("local")
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class WerkstattApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    /** Erfundene Referenzen mit gültigem Prüfzeichen. */
    private static final String BOX = "edge-wrk7abg";
    private static final String DOCKER = "edge-wrk8cdb";
    private static final String TIPPFEHLER = "edge-wrk7abh";

    private static final String HOST = "SHA256:" + "Q".repeat(42) + "c";
    private static final String BASE = "/api/v1/admin/werkstatt";
    private static final String FW = "/api/v1/admin/fernwartung";

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
    void vomRegisterBisZurAbnahme() throws Exception {
        String admin = token("admin", "admin");

        JsonNode grundlagen = getJson(BASE + "/grundlagen", admin);
        assertThat(werte(grundlagen.get("pruefungen"))).hasSize(8).startsWith("root_passwort").endsWith("neustart");
        assertThat(grundlagen.get("lanNetzVorschlag").asText()).isEqualTo("10.213.0.1/24");

        // ── Aufnehmen: Schreibweise wie bei der Kopplung, ein zweites Mal ändert nichts.
        ResponseEntity<String> neu = send(HttpMethod.POST, BASE + "/boxen", admin,
                Map.of("edgeRef", BOX.toUpperCase(), "schritte", List.of("openwrt", "kabel", "openwrt")));
        assertThat(neu.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        JsonNode box = json.readTree(neu.getBody());
        assertThat(box.get("edgeRef").asText()).isEqualTo(BOX);
        assertThat(box.get("boxArt").asText()).isEqualTo("edge-light");
        assertThat(box.get("lanNetz").isNull()).isTrue();
        assertThat(feldnamen(box.get("schritte"))).containsExactlyInAnyOrder("openwrt", "kabel");
        assertThat(box.get("schritte").get("openwrt").get("von").asText()).isEqualTo("admin");
        assertThat(box.get("abnahmen")).isEmpty();

        ResponseEntity<String> nochmal = send(HttpMethod.POST, BASE + "/boxen", admin,
                Map.of("edgeRef", BOX, "schritte", List.of("passwort")));
        assertThat(nochmal.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(feldnamen(json.readTree(nochmal.getBody()).get("schritte"))).containsExactlyInAnyOrder("openwrt",
                "kabel");

        ResponseEntity<String> tippfehler = send(HttpMethod.POST, BASE + "/boxen", admin, Map.of("edgeRef", TIPPFEHLER));
        assertThat(tippfehler.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(message(tippfehler)).contains("Prüfzeichen");
        assertThat(send(HttpMethod.POST, BASE + "/boxen", admin, Map.of("edgeRef", "edge-irgendwas-01"))
                .getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(send(HttpMethod.POST, BASE + "/boxen", admin, Map.of("edgeRef", DOCKER, "boxArt", "raspi"))
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(send(HttpMethod.GET, BASE + "/boxen/" + DOCKER, admin, null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        // ── Schritte abhaken und zurücknehmen; die Kennung ist geprüft.
        JsonNode mit = json.readTree(send(HttpMethod.PUT, BASE + "/boxen/" + BOX + "/schritte/passwort", admin,
                Map.of("erledigt", true)).getBody());
        assertThat(feldnamen(mit.get("schritte"))).containsExactlyInAnyOrder("openwrt", "kabel", "passwort");
        assertThat(mit.get("schritte").get("passwort").get("am").asText()).matches("\\d{4}-\\d\\d-\\d\\dT.*Z");
        send(HttpMethod.PUT, BASE + "/boxen/" + BOX + "/schritte/passwort", admin, Map.of("erledigt", true));
        JsonNode ohne = json.readTree(send(HttpMethod.PUT, BASE + "/boxen/" + BOX + "/schritte/kabel", admin,
                Map.of("erledigt", false)).getBody());
        assertThat(feldnamen(ohne.get("schritte"))).containsExactlyInAnyOrder("openwrt", "passwort");
        assertThat(send(HttpMethod.PUT, BASE + "/boxen/" + BOX + "/schritte/Kabel-1", admin,
                Map.of("erledigt", true)).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        // ── LAN-Netz (Entscheid 6a): kein übliches Heimnetz, keins des Wartungsservers.
        ResponseEntity<String> ueblich = send(HttpMethod.PUT, BASE + "/boxen/" + BOX + "/lan-netz", admin,
                Map.of("lanNetz", "192.168.1.1/24"));
        assertThat(ueblich.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(message(ueblich)).contains("Heimroutern");
        assertThat(send(HttpMethod.PUT, BASE + "/boxen/" + BOX + "/lan-netz", admin,
                Map.of("lanNetz", "10.10.17.1/24")).getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        // ── Abnahme: ohne LAN-Netz und ohne Tunnel geht nichts.
        Map<String, Object> abnahme = new HashMap<>(Map.of("hostSchluessel", HOST, "fassung", "edge-light-g9c3368e3a",
                "pruefungen", List.of("root_passwort", "notfall_schluessel", "tunnel_status", "anmeldeprobe",
                        "host_schluessel", "fenster_zu", "lan_netz", "neustart"),
                "probeFensterId", UUID.randomUUID().toString()));
        ResponseEntity<String> ohneLan = send(HttpMethod.POST, BASE + "/boxen/" + BOX + "/abnahme", admin, abnahme);
        assertThat(ohneLan.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(ohneLan)).contains("LAN-Netz");
        JsonNode lan = json.readTree(send(HttpMethod.PUT, BASE + "/boxen/" + BOX + "/lan-netz", admin,
                Map.of("lanNetz", " 10.213.0.1/24")).getBody());
        assertThat(lan.get("lanNetz").asText()).isEqualTo("10.213.0.1/24");
        ResponseEntity<String> ohneTunnel = send(HttpMethod.POST, BASE + "/boxen/" + BOX + "/abnahme", admin,
                abnahme);
        assertThat(ohneTunnel.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(ohneTunnel)).contains("Tunnel-Schlüssel");

        // ── Tunnel und Werkstatt-Probe über die Routen der Fernwartung, wie die Seite.
        JsonNode tunnel = json.readTree(send(HttpMethod.PUT, FW + "/boxen/" + BOX + "/schluessel", admin,
                Map.of("publicKey", wireguardSchluessel())).getBody());
        String adresse = tunnel.get("box").get("adresse").asText();
        String technikerId = json.readTree(send(HttpMethod.POST, FW + "/techniker", admin,
                Map.of("name", "Werkstatt", "publicKey", wireguardSchluessel(), "sshPublicKey",
                        SshTestSchluessel.rsa(3072))).getBody()).get("techniker").get("id").asText();
        ResponseEntity<String> geoeffnet = send(HttpMethod.POST, FW + "/fenster", admin, Map.of("edgeRef", BOX,
                "technikerId", technikerId, "grund", "Werkstatt-Probe", "dauerMinuten", 30));
        assertThat(geoeffnet.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String fensterId = json.readTree(geoeffnet.getBody()).get("id").asText();

        ResponseEntity<String> fremd = send(HttpMethod.POST, BASE + "/boxen/" + BOX + "/abnahme", admin, abnahme);
        assertThat(fremd.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(message(fremd)).contains("gehört nicht zu");

        abnahme.put("probeFensterId", fensterId);
        ResponseEntity<String> offen = send(HttpMethod.POST, BASE + "/boxen/" + BOX + "/abnahme", admin, abnahme);
        assertThat(offen.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(offen)).contains("noch offen");

        Map<String, Object> unvollstaendig = new HashMap<>(abnahme);
        unvollstaendig.put("pruefungen", List.of("root_passwort", "anmeldeprobe"));
        ResponseEntity<String> fehlt = send(HttpMethod.POST, BASE + "/boxen/" + BOX + "/abnahme", admin,
                unvollstaendig);
        assertThat(fehlt.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(message(fehlt)).contains("notfall_schluessel").contains("neustart").doesNotContain("anmeldeprobe");
        unvollstaendig.put("pruefungen", List.of("root_passwort", "erfunden"));
        assertThat(send(HttpMethod.POST, BASE + "/boxen/" + BOX + "/abnahme", admin, unvollstaendig)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        Map<String, Object> falscherHost = new HashMap<>(abnahme);
        falscherHost.put("hostSchluessel", "MD5:aa:bb");
        assertThat(send(HttpMethod.POST, BASE + "/boxen/" + BOX + "/abnahme", admin, falscherHost)
                .getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        Map<String, Object> falscheFassung = new HashMap<>(abnahme);
        falscheFassung.put("fassung", "edge light; rm -rf");
        assertThat(send(HttpMethod.POST, BASE + "/boxen/" + BOX + "/abnahme", admin, falscheFassung)
                .getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        assertThat(send(HttpMethod.POST, FW + "/fenster/" + fensterId + "/schliessen", admin, null).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        ResponseEntity<String> angelegt = send(HttpMethod.POST, BASE + "/boxen/" + BOX + "/abnahme", admin, abnahme);
        assertThat(angelegt.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        JsonNode a = json.readTree(angelegt.getBody());
        assertThat(a.get("edgeRef").asText()).isEqualTo(BOX);
        assertThat(a.get("hostSchluessel").asText()).isEqualTo(HOST);
        assertThat(a.get("fassung").asText()).isEqualTo("edge-light-g9c3368e3a");
        assertThat(a.get("tunnelAdresse").asText()).isEqualTo(adresse);
        assertThat(a.get("lanNetz").asText()).isEqualTo("10.213.0.1/24");
        assertThat(werte(a.get("pruefungen"))).hasSize(8);
        assertThat(a.get("erfasstVon").asText()).isEqualTo("admin");
        JsonNode probe = a.get("probe");
        assertThat(probe.get("fensterId").asText()).isEqualTo(fensterId);
        assertThat(probe.get("technikerName").asText()).isEqualTo("Werkstatt");
        assertThat(probe.get("grund").asText()).isEqualTo("Werkstatt-Probe");
        assertThat(probe.get("geschlossenVon").asText()).isEqualTo("admin");
        // Der Tunnel-Dienst hat nichts gemeldet: unbekannt, nicht „nicht abgeholt".
        assertThat(probe.get("schluesselAbgeholtUm").isNull()).isTrue();
        assertThat(probe.get("gemeldetAm").isNull()).isTrue();

        JsonNode liste = getJson(BASE + "/boxen", admin);
        assertThat(werte(liste, "edgeRef")).containsExactly(BOX);
        assertThat(liste.get(0).get("abnahmen")).hasSize(1);
        assertThat(liste.get(0).get("abnahmen").get(0).get("id").asText()).isEqualTo(a.get("id").asText());

        // ── Ein Protokoll ändert niemand; eine neue Abnahme ist eine neue Zeile.
        JdbcTemplate eigner = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
        assertThatThrownBy(() -> eigner.update("UPDATE werkstatt_abnahme SET fassung = 'x'"))
                .rootCause().hasMessageContaining("append-only");
        assertThatThrownBy(() -> eigner.update("DELETE FROM werkstatt_abnahme"))
                .rootCause().hasMessageContaining("append-only");
        assertThatThrownBy(() -> adminJdbc.update("DELETE FROM werkstatt_box"))
                .rootCause().hasMessageContaining("permission denied");
    }

    /** Die Docker-Box kommt ins Register (Entscheid 9a), eine Abnahme gibt es für sie noch nicht. */
    @Test
    @Order(2)
    void dieDockerBoxStehtImRegisterOhneAbnahme() throws Exception {
        String admin = token("admin", "admin");
        ResponseEntity<String> neu = send(HttpMethod.POST, BASE + "/boxen", admin,
                Map.of("edgeRef", DOCKER, "boxArt", "edge-app", "notiz", "Raspberry Pi 5"));
        assertThat(neu.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(json.readTree(neu.getBody()).get("boxArt").asText()).isEqualTo("edge-app");
        send(HttpMethod.PUT, BASE + "/boxen/" + DOCKER + "/lan-netz", admin, Map.of("lanNetz", "10.213.0.1/24"));
        ResponseEntity<String> abnahme = send(HttpMethod.POST, BASE + "/boxen/" + DOCKER + "/abnahme", admin,
                Map.of("hostSchluessel", HOST, "fassung", "v1.2.3", "pruefungen", List.of("root_passwort",
                        "notfall_schluessel", "tunnel_status", "anmeldeprobe", "host_schluessel", "fenster_zu",
                        "lan_netz", "neustart"), "probeFensterId", UUID.randomUUID().toString()));
        assertThat(abnahme.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(message(abnahme)).contains("nur für das Edge Light");
    }

    @Test
    @Order(3)
    void nurPlattformAdmins() {
        String kunde = token("demo", "demo");
        String dienst = serviceToken("voltpilot-tunnel-dienst", "voltpilot-tunnel-dienst-dev-secret");
        String publisher = serviceToken("voltpilot-release-publisher", "voltpilot-release-publisher-dev-secret");
        for (String t : List.of(kunde, dienst, publisher)) {
            assertThat(send(HttpMethod.GET, BASE + "/boxen", t, null).getStatusCode())
                    .isEqualTo(HttpStatus.FORBIDDEN);
            assertThat(send(HttpMethod.POST, BASE + "/boxen", t, Map.of("edgeRef", BOX)).getStatusCode())
                    .isEqualTo(HttpStatus.FORBIDDEN);
            assertThat(send(HttpMethod.PUT, BASE + "/boxen/" + BOX + "/schritte/kabel", t,
                    Map.of("erledigt", true)).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
            assertThat(send(HttpMethod.POST, BASE + "/boxen/" + BOX + "/abnahme", t, Map.of()).getStatusCode())
                    .isEqualTo(HttpStatus.FORBIDDEN);
        }
        assertThat(send(HttpMethod.GET, BASE + "/boxen", null, null).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);

        // Die App-Rolle (der Kunden-Datenpfad) liest keine Werkstatt-Tabelle.
        JdbcTemplate app = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), APP_USER, APP_PW));
        for (String tabelle : List.of("werkstatt_box", "werkstatt_abnahme")) {
            assertThatThrownBy(() -> app.queryForObject("SELECT count(*) FROM " + tabelle, Long.class))
                    .as(tabelle).rootCause().hasMessageContaining("permission denied");
        }
    }

    // ── Hilfen ────────────────────────────────────────────────────────────

    private static String wireguardSchluessel() {
        byte[] roh = new byte[32];
        new java.security.SecureRandom().nextBytes(roh);
        return Base64.getEncoder().encodeToString(roh);
    }

    private static List<String> werte(JsonNode liste) {
        List<String> werte = new ArrayList<>();
        liste.forEach(e -> werte.add(e.asText()));
        return werte;
    }

    private static List<String> werte(JsonNode liste, String feld) {
        List<String> werte = new ArrayList<>();
        liste.forEach(e -> werte.add(e.get(feld).asText()));
        return werte;
    }

    private static List<String> feldnamen(JsonNode objekt) {
        List<String> namen = new ArrayList<>();
        objekt.fieldNames().forEachRemaining(namen::add);
        return namen;
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
