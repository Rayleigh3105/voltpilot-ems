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
        assertThat(werte(grundlagen.get("pruefungen"))).hasSize(9).startsWith("root_passwort").endsWith("update_bereit");
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
                        "host_schluessel", "fenster_zu", "lan_netz", "neustart", "update_bereit"),
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
        assertThat(werte(a.get("pruefungen"))).hasSize(9);
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
        // Löschen darf die Admin-Rolle seit V20261105170000 - aber nie eine abgenommene Box.
        assertThatThrownBy(() -> adminJdbc.update("DELETE FROM werkstatt_box"))
                .rootCause().hasMessageContaining("foreign key");
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
                        "lan_netz", "neustart", "update_bereit"), "probeFensterId", UUID.randomUUID().toString()));
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
            assertThat(send(HttpMethod.DELETE, BASE + "/boxen/" + DOCKER, t, null).getStatusCode())
                    .isEqualTo(HttpStatus.FORBIDDEN);
        }
        assertThat(send(HttpMethod.DELETE, BASE + "/boxen/" + DOCKER, null, null).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(send(HttpMethod.GET, BASE + "/boxen", null, null).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);

        // Die App-Rolle (der Kunden-Datenpfad) liest keine Werkstatt-Tabelle.
        JdbcTemplate app = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), APP_USER, APP_PW));
        for (String tabelle : List.of("werkstatt_box", "werkstatt_abnahme")) {
            assertThatThrownBy(() -> app.queryForObject("SELECT count(*) FROM " + tabelle, Long.class))
                    .as(tabelle).rootCause().hasMessageContaining("permission denied");
        }
    }

    /**
     * Löschen (Wunsch des Kapitäns: „nenn es wirklich löschen“): jede Box, die weder abgenommen noch gekoppelt
     * ist. Ein Fehlversuch nimmt seinen Tunnel-Schlüssel, offene Fenster, nicht eingelöste Codes, den
     * festgehaltenen Geräteschlüssel und die offene Zertifikatsanfrage mit; Läufe und Einlösungen bleiben. Die
     * ganze Lage steht in {@code werkstatt_box_entfernt}. Abnahme, Zertifikat, Kunde und Vorab-Registrierung
     * sperren.
     */
    @Test
    @Order(4)
    void einFehlversuchLaesstSichLoeschen() throws Exception {
        String admin = token("admin", "admin");
        JdbcTemplate eigner = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));

        // ── Unbenutzt: die Docker-Box aus Order(2) hat nur LAN-Netz und Notiz, nichts geht mit.
        JsonNode docker = getJson(BASE + "/boxen/" + DOCKER, admin);
        assertThat(docker.get("inGebrauch")).isEmpty();
        assertThat(docker.get("loeschtMit")).isEmpty();
        assertThat(send(HttpMethod.DELETE, BASE + "/boxen/" + DOCKER.toUpperCase(), admin, null).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(send(HttpMethod.GET, BASE + "/boxen/" + DOCKER, admin, null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(werte(getJson(BASE + "/boxen", admin), "edgeRef")).doesNotContain(DOCKER);
        Map<String, Object> spur = eigner.queryForMap("SELECT box_id::text AS box_id, box_art, lan_netz, notiz, "
                + "angelegt_von_name, entfernt_von, entfernt_von_name, mitgeloescht::text AS mit "
                + "FROM werkstatt_box_entfernt WHERE edge_ref = ?", DOCKER);
        assertThat(spur.get("box_id")).isEqualTo(docker.get("id").asText());
        assertThat(spur.get("box_art")).isEqualTo("edge-app");
        assertThat(spur.get("lan_netz")).isEqualTo("10.213.0.1/24");
        assertThat(spur.get("notiz")).isEqualTo("Raspberry Pi 5");
        assertThat(spur.get("entfernt_von")).isNotNull();
        assertThat(spur.get("entfernt_von_name")).isEqualTo("admin");
        JsonNode nichts = json.readTree((String) spur.get("mit"));
        assertThat(nichts.get("tunnelZugang").isNull()).isTrue();
        assertThat(nichts.get("codes")).isEmpty();
        assertThat(nichts.get("geraeteschluessel").isNull()).isTrue();
        assertThat(nichts.get("zertifikatsanfrage").isNull()).isTrue();
        // Die Spur ändert niemand.
        assertThatThrownBy(() -> eigner.update("DELETE FROM werkstatt_box_entfernt"))
                .rootCause().hasMessageContaining("append-only");
        ResponseEntity<String> nochmal = send(HttpMethod.DELETE, BASE + "/boxen/" + DOCKER, admin, null);
        assertThat(nochmal.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(message(nochmal)).contains("nicht im Werkstatt-Register");

        // ── Falsches Prüfzeichen: 422 wie überall in der Werkstatt.
        assertThat(send(HttpMethod.DELETE, BASE + "/boxen/" + TIPPFEHLER, admin, null).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        // ── Der Fehlversuch: eingelöst, Tunnel-Schlüssel, offenes Probe-Fenster, ein Lauf, ein offener Code,
        //    festgehaltener Geräteschlüssel, offene Zertifikatsanfrage - aber nie abgenommen, nie gekoppelt.
        String fehl = aufnehmen(admin, "wrkfeh");
        String alterSchluessel = wireguardSchluessel();
        ResponseEntity<String> hinterlegt = send(HttpMethod.PUT, FW + "/boxen/" + fehl + "/schluessel", admin,
                Map.of("publicKey", alterSchluessel));
        assertThat(hinterlegt.getStatusCode().is2xxSuccessful()).isTrue();
        String adresse = json.readTree(hinterlegt.getBody()).get("box").get("adresse").asText();
        String technikerId = json.readTree(send(HttpMethod.POST, FW + "/techniker", admin,
                Map.of("name", "Werkstatt-Dienst (Fehlversuch)", "publicKey", wireguardSchluessel())).getBody())
                .get("techniker").get("id").asText();
        ResponseEntity<String> geoeffnet = send(HttpMethod.POST, FW + "/fenster", admin, Map.of("edgeRef", fehl,
                "technikerId", technikerId, "grund", "Werkstatt-Probe", "dauerMinuten", 30));
        assertThat(geoeffnet.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String fensterId = json.readTree(geoeffnet.getBody()).get("id").asText();
        assertThat(send(HttpMethod.POST, BASE + "/freigaben", admin, freigabe()).getStatusCode())
                .isEqualTo(HttpStatus.CREATED);
        UUID freigabe = eigner.queryForObject("SELECT id FROM werkstatt_freigabe LIMIT 1", UUID.class);
        UUID eingeloesterCode = eigner.queryForObject("INSERT INTO werkstatt_code (freigabe_id, edge_ref, "
                + "code_sha256, gueltig_bis, ausgegeben_von, eingeloest_am) VALUES (?, ?, ?, "
                + "now() + interval '10 minutes', 'test', now()) RETURNING id", UUID.class, freigabe, fehl,
                "ab".repeat(32));
        UUID einloesung = eigner.queryForObject("INSERT INTO werkstatt_einloesung (code_id, freigabe_id, edge_ref, "
                + "fassung, geraete_schluessel, geraete_schluessel_sha256, wireguard_schluessel, host_schluessel, "
                + "tunnel_adresse, fenster_id, tausch) VALUES (?, ?, ?, 'edge-light-2026.11.0', 'geraet', ?, ?, ?, ?, "
                + "?::uuid, false) RETURNING id", UUID.class, eingeloesterCode, freigabe, fehl, "ef".repeat(32),
                alterSchluessel, HOST, adresse, fensterId);
        eigner.update("INSERT INTO werkstatt_geraeteschluessel (edge_ref, geraete_schluessel, "
                + "geraete_schluessel_sha256, einloesung_id) VALUES (?, 'geraet', ?, ?)", fehl, "ef".repeat(32),
                einloesung);
        eigner.update("INSERT INTO werkstatt_code (freigabe_id, edge_ref, code_sha256, gueltig_bis, ausgegeben_von) "
                + "VALUES (?, ?, ?, now() + interval '10 minutes', 'test')", freigabe, fehl, "cd".repeat(32));
        eigner.update("INSERT INTO device_enrollment (external_ref, csr_pem) VALUES (?, 'csr')", fehl);
        eigner.update("INSERT INTO werkstatt_lauf (kennung, zustand, beginn, stand) VALUES (?, 'angehalten', now(), "
                + "jsonb_build_object('kennung', ?::text, 'box', ?::text))", "test-" + fehl, "test-" + fehl, fehl);

        JsonNode vorher = getJson(BASE + "/boxen/" + fehl, admin);
        assertThat(vorher.get("inGebrauch")).isEmpty();
        assertThat(werte(vorher.get("loeschtMit"))).containsExactly("der Tunnel-Schlüssel (Adresse " + adresse + ")",
                "1 offenes Fernwartungs-Fenster", "1 Code des Werkstatt-Dienstes", "der festgehaltene Geräteschlüssel",
                "die offene Zertifikatsanfrage");

        assertThat(send(HttpMethod.DELETE, BASE + "/boxen/" + fehl, admin, null).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);

        // Weg aus dem Register und aus der Fernwartung; der Zugang bleibt als „geloescht“ (Adresse vergeben).
        assertThat(send(HttpMethod.GET, BASE + "/boxen/" + fehl, admin, null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(send(HttpMethod.GET, FW + "/boxen/" + fehl, admin, null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(eigner.queryForObject("SELECT status FROM fernwartung_zugang WHERE edge_ref = ?", String.class,
                fehl)).isEqualTo("geloescht");
        assertThat(eigner.queryForObject("SELECT geschlossen_am IS NOT NULL FROM fernwartung_fenster WHERE id = ?::uuid",
                Boolean.class, fensterId)).isTrue();
        assertThat(eigner.queryForList("SELECT p.aktion || coalesce(':' || (p.details->>'anlass'), '') "
                + "FROM fernwartung_protokoll p JOIN fernwartung_zugang z ON z.id = p.box_id WHERE z.edge_ref = ? "
                + "ORDER BY p.zeit", String.class, fehl))
                .containsSubsequence("fenster_geschlossen:box_geloescht", "box_geloescht");
        // Mitgegangen: offener Code, Geräteschlüssel, Zertifikatsanfrage. Geblieben: Lauf, Einlösung, ihr Code.
        assertThat(eigner.queryForList("SELECT code_sha256 FROM werkstatt_code WHERE edge_ref = ?", String.class,
                fehl)).containsExactly("ab".repeat(32));
        assertThat(eigner.queryForObject("SELECT count(*) FROM werkstatt_einloesung WHERE edge_ref = ?", Long.class,
                fehl)).isEqualTo(1L);
        assertThat(eigner.queryForObject("SELECT count(*) FROM werkstatt_lauf WHERE stand->>'box' = ?", Long.class,
                fehl)).isEqualTo(1L);
        assertThat(eigner.queryForObject("SELECT count(*) FROM werkstatt_geraeteschluessel WHERE edge_ref = ?",
                Long.class, fehl)).isZero();
        assertThat(eigner.queryForObject("SELECT count(*) FROM device_enrollment WHERE external_ref = ?", Long.class,
                fehl)).isZero();
        // Die Spur trägt die ganze gelöschte Lage.
        JsonNode mit = json.readTree(eigner.queryForObject("SELECT mitgeloescht::text FROM werkstatt_box_entfernt "
                + "WHERE edge_ref = ?", String.class, fehl));
        assertThat(mit.get("tunnelZugang").get("adresse").asText()).isEqualTo(adresse);
        assertThat(mit.get("tunnelZugang").get("publicKey").asText()).isEqualTo(alterSchluessel);
        assertThat(mit.get("tunnelZugang").get("statusVorher").asText()).isEqualTo("aktiv");
        assertThat(werte(mit.get("tunnelZugang").get("geschlosseneFenster"))).containsExactly(fensterId);
        assertThat(werte(mit.get("codes"), "code_sha256")).containsExactly("cd".repeat(32));
        assertThat(mit.get("geraeteschluessel").get("einloesung_id").asText()).isEqualTo(einloesung.toString());
        assertThat(mit.get("zertifikatsanfrage").get("csr_pem").asText()).isEqualTo("csr");

        // Dieselbe Referenz kann wieder kommen: neuer Zugang, neue Adresse; der alte Schlüssel bleibt vergeben.
        assertThat(send(HttpMethod.POST, BASE + "/boxen", admin, Map.of("edgeRef", fehl)).getStatusCode())
                .isEqualTo(HttpStatus.CREATED);
        ResponseEntity<String> alt = send(HttpMethod.PUT, FW + "/boxen/" + fehl + "/schluessel", admin,
                Map.of("publicKey", alterSchluessel));
        assertThat(alt.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(alt)).contains("gelöschten Box " + fehl, "zurücksetzen");
        ResponseEntity<String> neu = send(HttpMethod.PUT, FW + "/boxen/" + fehl + "/schluessel", admin,
                Map.of("publicKey", wireguardSchluessel()));
        assertThat(neu.getStatusCode().is2xxSuccessful()).isTrue();
        assertThat(json.readTree(neu.getBody()).get("box").get("adresse").asText()).isNotEqualTo(adresse);

        // ── Gesperrt: abgenommen (BOX aus Order(1)), Zertifikat ausgestellt, beim Kunden, vorab registriert.
        abgelehnt(admin, BOX, "sie ist abgenommen");

        String zertifikat = aufnehmen(admin, "wrkzrt");
        eigner.update("INSERT INTO device_enrollment (external_ref, csr_pem, cert_pem) VALUES (?, 'csr', 'cert')",
                zertifikat);
        abgelehnt(admin, zertifikat, "Zertifikat");

        String kunde = aufnehmen(admin, "wrkkdb");
        UUID tenant = UUID.randomUUID();
        UUID site = UUID.randomUUID();
        eigner.update("INSERT INTO tenant (id, name) VALUES (?, 'Kunde Löschen')", tenant);
        eigner.update("INSERT INTO site (id, tenant_id, name) VALUES (?, ?, 'Halle')", site, tenant);
        eigner.update("INSERT INTO device (tenant_id, site_id, external_ref, kind, status) VALUES (?,?,?,?,?)",
                tenant, site, kunde, "gateway", "claimed");
        abgelehnt(admin, kunde, "Kunde");

        String vorab = aufnehmen(admin, "wrkgrt");
        eigner.update("INSERT INTO provisioned_device (external_ref) VALUES (?)", vorab);
        abgelehnt(admin, vorab, "Vorab-Registrierung");

        // ── Nicht im Register: 404.
        assertThat(send(HttpMethod.DELETE, BASE + "/boxen/" + ref("wrkxyz"), admin, null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    /**
     * Ob der Kunde die Box schon eingerichtet hat: erst der Claim (Zeile in {@code device}) setzt
     * {@code kunde}; die Vorab-Registrierung allein nicht.
     */
    @Test
    @Order(5)
    void kundeErstNachDemClaim() throws Exception {
        String admin = token("admin", "admin");
        String ref = aufnehmen(admin, "wrkkun");
        assertThat(getJson(BASE + "/boxen/" + ref, admin).get("kunde").isNull()).isTrue();

        JdbcTemplate eigner = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
        eigner.update("INSERT INTO provisioned_device (external_ref) VALUES (?)", ref);
        assertThat(getJson(BASE + "/boxen/" + ref, admin).get("kunde").isNull()).as("nur vorab registriert").isTrue();

        UUID tenant = UUID.randomUUID();
        UUID site = UUID.randomUUID();
        eigner.update("INSERT INTO tenant (id, name) VALUES (?, 'Kunde Werkstatt')", tenant);
        eigner.update("INSERT INTO site (id, tenant_id, name) VALUES (?, ?, 'Dach Süd')", site, tenant);
        eigner.update("INSERT INTO device (tenant_id, site_id, external_ref, kind, status) VALUES (?,?,?,?,?)",
                tenant, site, ref, "gateway", "claimed");

        JsonNode kunde = getJson(BASE + "/boxen/" + ref, admin).get("kunde");
        assertThat(kunde.get("mandant").asText()).isEqualTo("Kunde Werkstatt");
        assertThat(kunde.get("anlage").asText()).isEqualTo("Dach Süd");
        assertThat(kunde.get("seit").asText()).isNotBlank();
        JsonNode inListe = null;
        for (JsonNode b : getJson(BASE + "/boxen", admin)) {
            if (ref.equals(b.get("edgeRef").asText())) inListe = b;
        }
        assertThat(inListe).isNotNull();
        assertThat(inListe.get("kunde").get("mandant").asText()).isEqualTo("Kunde Werkstatt");
    }

    /** 409 mit Grund, die Box bleibt, und die Seite liest denselben Grund in {@code inGebrauch}. */
    private void abgelehnt(String admin, String ref, String... gruende) throws Exception {
        ResponseEntity<String> r = send(HttpMethod.DELETE, BASE + "/boxen/" + ref, admin, null);
        assertThat(r.getStatusCode()).as(ref).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(r)).as(ref).startsWith(ref + " lässt sich nicht löschen: ")
                .contains(gruende);
        JsonNode box = getJson(BASE + "/boxen/" + ref, admin);
        assertThat(String.join("; ", werte(box.get("inGebrauch")))).as(ref).contains(gruende);
        Long spur = adminJdbc.queryForObject("SELECT count(*) FROM werkstatt_box_entfernt WHERE edge_ref = ?",
                Long.class, ref);
        assertThat(spur).as(ref).isZero();
    }

    private String aufnehmen(String admin, String rumpf) {
        String ref = ref(rumpf);
        assertThat(send(HttpMethod.POST, BASE + "/boxen", admin, Map.of("edgeRef", ref)).getStatusCode())
                .as(ref).isEqualTo(HttpStatus.CREATED);
        return ref;
    }

    /** Eine erfundene Referenz mit gültigem Prüfzeichen zum Rumpf aus sechs Zeichen. */
    private static String ref(String rumpf) {
        for (char c : "abcdefghjkmnpqrstuvwxyz23456789".toCharArray()) {
            String ref = "edge-" + rumpf + c;
            if (com.voltpilot.api.web.EdgeRef.isValid(ref)) {
                return ref;
            }
        }
        throw new IllegalArgumentException(rumpf);
    }

    private static Map<String, Object> freigabe() {
        String sha = "0123456789abcdef".repeat(4);
        Map<String, Object> a = new HashMap<>();
        a.put("tage", 7);
        a.put("obergrenze", 2);
        a.put("openwrt", Map.of("fassung", "25.12.5",
                "datei", "openwrt-25.12.5-ramips-mt76x8-glinet_gl-mt300n-v2-squashfs-sysupgrade.bin",
                "sha256", sha, "quelle", "https://downloads.openwrt.org/releases/25.12.5/targets/ramips/mt76x8/"));
        a.put("edgeLight", Map.of("fassung", "edge-light-2026.11.0", "quelle", "https://git.tecmaxx.de/x/",
                "programmSha256", sha, "skripteSha256", sha));
        return a;
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
