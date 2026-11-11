package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureTestRestTemplate;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.resttestclient.TestRestTemplate;
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
 * Die Freigabe der Werkstatt (Werkstatt-Automatik V1, WI-4 A und WI-9 A):
 * „Werkstatt freigeben“ und „Freigabe beenden“ nur für VoltPilot-Admins, Lesen
 * der laufenden Freigabe für den Werkstatt-Dienst in seinem eigenen Baum - und
 * dort nichts anderes. Echte Keycloak-Token, echte Migrationen.
 */
@Testcontainers(disabledWithoutDocker = true)
@AutoConfigureTestRestTemplate
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class WerkstattFreigabeApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    private static final String BASE = "/api/v1/admin/werkstatt/freigaben";
    private static final String DIENST = "/api/v1/werkstatt-dienst/freigabe";
    private static final String SHA = "0123456789abcdef".repeat(4);

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

    private static Map<String, Object> antrag() {
        Map<String, Object> a = new HashMap<>();
        a.put("boxArt", "mango");
        a.put("tage", 30);
        a.put("obergrenze", 20);
        a.put("openwrt", Map.of("fassung", "25.12.5",
                "datei", "openwrt-25.12.5-ramips-mt76x8-glinet_gl-mt300n-v2-squashfs-sysupgrade.bin",
                "sha256", SHA, "quelle", "https://downloads.openwrt.org/releases/25.12.5/targets/ramips/mt76x8/"));
        a.put("edgeLight", Map.of("fassung", "edge-light-2026.11.0",
                "quelle", "https://git.tecmaxx.de/mamotec/voltpilot-ems/releases/download/edge-light-2026.11.0/",
                "programmSha256", SHA, "skripteSha256", SHA));
        a.put("notiz", "erste Werkstatt-Freigabe");
        return a;
    }

    @Test
    @Order(1)
    void freigebenLesenBeenden() throws Exception {
        String admin = token("admin", "admin");
        String dienst = serviceToken("voltpilot-werkstatt-dienst", "voltpilot-werkstatt-dienst-dev-secret");

        // Ohne Freigabe: 404 für den Dienst, mit Satz.
        ResponseEntity<String> keine = send(HttpMethod.GET, DIENST, dienst, null);
        assertThat(keine.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(message(keine)).contains("nicht freigegeben");

        ResponseEntity<String> neu = send(HttpMethod.POST, BASE, admin, antrag());
        assertThat(neu.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        JsonNode f = json.readTree(neu.getBody());
        String kennung = f.get("kennung").asText();
        assertThat(kennung).matches("^20[0-9]{2}-[01][0-9]-mango-1$");
        assertThat(f.get("zustand").asText()).isEqualTo("laufend");
        assertThat(f.get("erteiltVon").asText()).isNotBlank();
        Instant ab = Instant.parse(f.get("gueltigAb").asText());
        Instant bis = Instant.parse(f.get("gueltigBis").asText());
        assertThat(java.time.Duration.between(ab, bis).toDays()).isEqualTo(30);

        // Eine zweite für dieselbe Box-Art läuft nicht daneben.
        ResponseEntity<String> zweite = send(HttpMethod.POST, BASE, admin, antrag());
        assertThat(zweite.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(zweite)).contains(kennung).contains("beenden");

        // Der Dienst liest sie im Format seiner Datei (Schema vp-werkstatt-freigabe.v1).
        JsonNode d = json.readTree(send(HttpMethod.GET, DIENST + "?boxArt=mango", dienst, null).getBody());
        assertThat(d.get("schema").asText()).isEqualTo("vp-werkstatt-freigabe.v1");
        assertThat(d.get("kennung").asText()).isEqualTo(kennung);
        assertThat(d.get("box_art").asText()).isEqualTo("mango");
        assertThat(Instant.parse(d.get("erteilt_am").asText())).isEqualTo(ab);
        assertThat(Instant.parse(d.get("gueltig_bis").asText())).isEqualTo(bis);
        assertThat(d.get("obergrenze").asInt()).isEqualTo(20);
        assertThat(d.get("openwrt").get("sha256").asText()).isEqualTo(SHA);
        assertThat(d.get("edge_light").get("fassung").asText()).isEqualTo("edge-light-2026.11.0");
        assertThat(d.get("edge_light").get("programm_sha256").asText()).isEqualTo(SHA);
        assertThat(d.has("beendet_am")).isFalse();
        assertThat(feldnamen(d)).containsExactlyInAnyOrder("schema", "kennung", "box_art", "erteilt_von",
                "erteilt_am", "gueltig_bis", "obergrenze", "openwrt", "edge_light");

        JsonNode liste = json.readTree(send(HttpMethod.GET, BASE, admin, null).getBody());
        assertThat(liste).hasSize(1);

        // Freigabe beenden
        ResponseEntity<String> ende = send(HttpMethod.POST, BASE + "/" + kennung + "/ende", admin, null);
        assertThat(ende.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(json.readTree(ende.getBody()).get("zustand").asText()).isEqualTo("beendet");
        assertThat(send(HttpMethod.POST, BASE + "/" + kennung + "/ende", admin, null).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT);
        assertThat(send(HttpMethod.POST, BASE + "/2026-01-mango-9/ende", admin, null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(send(HttpMethod.GET, DIENST, dienst, null).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // Danach eine neue: die nächste Nummer des Monats.
        ResponseEntity<String> neu2 = send(HttpMethod.POST, BASE, admin, antrag());
        assertThat(neu2.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(json.readTree(neu2.getBody()).get("kennung").asText()).endsWith("-mango-2");
        JsonNode d2 = json.readTree(send(HttpMethod.GET, DIENST, dienst, null).getBody());
        assertThat(d2.get("kennung").asText()).endsWith("-mango-2");
    }

    @Test
    @Order(2)
    void ungueltigeAntraege() {
        String admin = token("admin", "admin");
        record Fall(String name, String feld, Object wert, String grund) {
        }
        List<Fall> faelle = List.of(
                new Fall("pi", "boxArt", "pi", "V2"),
                new Fall("zu lang", "tage", 93, "tage"),
                new Fall("null Tage", "tage", 0, "tage"),
                new Fall("obergrenze", "obergrenze", 0, "obergrenze"),
                new Fall("factory", "openwrt", Map.of("fassung", "25.12.5", "datei", "openwrt-25.12.5-x-factory.bin",
                        "sha256", SHA, "quelle", "https://x.example/"), "sysupgrade"),
                new Fall("andere Fassung", "openwrt", Map.of("fassung", "25.12.5", "datei",
                        "openwrt-24.10.4-x-sysupgrade.bin", "sha256", SHA, "quelle", "https://x.example/"), "passt nicht"),
                new Fall("http", "edgeLight", Map.of("fassung", "edge-light-2026.11.0", "quelle", "http://x.example/",
                        "programmSha256", SHA, "skripteSha256", SHA), "https"),
                new Fall("alte Fassung", "edgeLight", Map.of("fassung", "edge-light-g70cc2059e", "quelle",
                        "https://x.example/", "programmSha256", SHA, "skripteSha256", SHA), "edge-light-JJJJ.MM.N"),
                new Fall("sha", "edgeLight", Map.of("fassung", "edge-light-2026.11.0", "quelle", "https://x.example/",
                        "programmSha256", "abc", "skripteSha256", SHA), "programmSha256"));
        for (Fall f : faelle) {
            Map<String, Object> a = antrag();
            a.put(f.feld(), f.wert());
            ResponseEntity<String> r = send(HttpMethod.POST, BASE, admin, a);
            assertThat(r.getStatusCode()).as(f.name()).isEqualTo(HttpStatus.UNPROCESSABLE_CONTENT);
            assertThat(message(r)).as(f.name()).contains(f.grund());
        }
    }

    @Test
    @Order(3)
    void nurAdminsFreigeben_nurDerDienstLiest() {
        String kunde = token("demo", "demo");
        String admin = token("admin", "admin");
        String dienst = serviceToken("voltpilot-werkstatt-dienst", "voltpilot-werkstatt-dienst-dev-secret");
        String tunnel = serviceToken("voltpilot-tunnel-dienst", "voltpilot-tunnel-dienst-dev-secret");
        String publisher = serviceToken("voltpilot-release-publisher", "voltpilot-release-publisher-dev-secret");
        // Freigeben und beenden: nie der Dienst, nie ein Kunde, nie ein anderes Dienstkonto.
        for (String t : List.of(kunde, dienst, tunnel, publisher)) {
            assertThat(send(HttpMethod.POST, BASE, t, antrag()).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
            assertThat(send(HttpMethod.GET, BASE, t, null).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
            assertThat(send(HttpMethod.POST, BASE + "/x/ende", t, null).getStatusCode())
                    .isEqualTo(HttpStatus.FORBIDDEN);
        }
        // Der Baum des Dienstes: nur der Dienst - kein Admin, kein Kunde, kein anderes Dienstkonto.
        for (String t : List.of(kunde, admin, tunnel, publisher)) {
            assertThat(send(HttpMethod.GET, DIENST, t, null).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        }
        assertThat(send(HttpMethod.GET, DIENST, null, null).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        // Der Dienst erreicht keine Admin-Route der Werkstatt oder der Fernwartung.
        for (String pfad : List.of("/api/v1/admin/werkstatt/boxen", "/api/v1/admin/fernwartung/boxen",
                "/api/v1/fernwartung/soll")) {
            assertThat(send(HttpMethod.GET, pfad, dienst, null).getStatusCode()).as(pfad)
                    .isEqualTo(HttpStatus.FORBIDDEN);
        }
    }

    @Test
    @Order(4)
    void tabelle_nurDasEndeAendertSich_undDieAppRolleLiestNichts() {
        String kennung = adminJdbc.queryForObject(
                "SELECT kennung FROM werkstatt_freigabe ORDER BY gueltig_ab LIMIT 1", String.class);
        assertThatThrownBy(() -> adminJdbc.update("UPDATE werkstatt_freigabe SET obergrenze = 3 WHERE kennung = ?",
                kennung)).rootCause().hasMessageContaining("schon beendet");
        String laufend = adminJdbc.queryForObject(
                "SELECT kennung FROM werkstatt_freigabe WHERE beendet_am IS NULL", String.class);
        assertThatThrownBy(() -> adminJdbc.update("UPDATE werkstatt_freigabe SET obergrenze = 3 WHERE kennung = ?",
                laufend)).rootCause().hasMessageContaining("nur ihr Ende");
        // Löschen: die Admin-Rolle hat kein DELETE (erster Riegel), und selbst der Eigentümer der Tabelle
        // scheitert am Trigger (zweiter Riegel).
        assertThatThrownBy(() -> adminJdbc.update("DELETE FROM werkstatt_freigabe WHERE kennung = ?", laufend))
                .rootCause().hasMessageContaining("permission denied");
        JdbcTemplate eigentuemer = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
        assertThatThrownBy(() -> eigentuemer.update("DELETE FROM werkstatt_freigabe WHERE kennung = ?", laufend))
                .rootCause().hasMessageContaining("nicht gelöscht");
        assertThat(eigentuemer.queryForObject("SELECT count(*) FROM werkstatt_freigabe", Long.class)).isEqualTo(2L);

        JdbcTemplate app = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), APP_USER, APP_PW));
        assertThatThrownBy(() -> app.queryForObject("SELECT count(*) FROM werkstatt_freigabe", Long.class))
                .rootCause().hasMessageContaining("permission denied");
    }

    @Test
    @Order(5)
    void dienstMeldetSeineAnsicht_nurAdminsLesenSie() throws Exception {
        String admin = token("admin", "admin");
        String dienst = serviceToken("voltpilot-werkstatt-dienst", "voltpilot-werkstatt-dienst-dev-secret");
        String vektor = java.nio.file.Files.readString(
                java.nio.file.Path.of("..", "..", "docs", "contracts", "werkstatt-ansicht-v1.example.json"));
        // Noch nie gemeldet: keine Ansicht, nicht aktuell.
        JsonNode leer = json.readTree(send(HttpMethod.GET, "/api/v1/admin/werkstatt/dienst", admin, null).getBody());
        assertThat(leer.get("ansicht").isNull()).isTrue();
        assertThat(leer.get("aktuell").asBoolean()).isFalse();

        assertThat(roh(HttpMethod.PUT, "/api/v1/werkstatt-dienst/ansicht", dienst, vektor).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);
        JsonNode d = json.readTree(send(HttpMethod.GET, "/api/v1/admin/werkstatt/dienst", admin, null).getBody());
        assertThat(d.get("aktuell").asBoolean()).isTrue();
        assertThat(d.get("alterSekunden").asLong()).isLessThan(60);
        assertThat(d.get("ansicht").get("schema").asText()).isEqualTo("vp-werkstatt-ansicht.v1");
        assertThat(d.get("ansicht").get("werkbank").get("status").get("werkstatt").get("kabel").asBoolean()).isTrue();
        assertThat(d.get("laeufe")).hasSize(1);
        assertThat(d.get("laeufe").get(0).get("zustand").asText()).isEqualTo("laeuft");

        // Derselbe Lauf, jetzt fertig: eine Zeile, neuer Stand.
        String fertig = vektor.replace("\"zustand\": \"laeuft\"", "\"zustand\": \"fertig\"");
        assertThat(roh(HttpMethod.PUT, "/api/v1/werkstatt-dienst/ansicht", dienst, fertig).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);
        d = json.readTree(send(HttpMethod.GET, "/api/v1/admin/werkstatt/dienst", admin, null).getBody());
        assertThat(d.get("laeufe")).hasSize(1);
        assertThat(d.get("laeufe").get(0).get("zustand").asText()).isEqualTo("fertig");

        // Form falsch: 422; Schlüsselmaterial: 422; nur der Dienst meldet, nur Admins lesen.
        assertThat(roh(HttpMethod.PUT, "/api/v1/werkstatt-dienst/ansicht", dienst, "{\"schema\":\"x\"}").getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_CONTENT);
        assertThat(roh(HttpMethod.PUT, "/api/v1/werkstatt-dienst/ansicht", dienst,
                vektor.replace("eine Mango mit frischem OpenWrt", "-----BEGIN OPENSSH PRIVATE KEY-----")).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_CONTENT);
        for (String t : List.of(admin, token("demo", "demo"))) {
            assertThat(roh(HttpMethod.PUT, "/api/v1/werkstatt-dienst/ansicht", t, vektor).getStatusCode())
                    .isEqualTo(HttpStatus.FORBIDDEN);
        }
        for (String t : List.of(dienst, token("demo", "demo"))) {
            assertThat(send(HttpMethod.GET, "/api/v1/admin/werkstatt/dienst", t, null).getStatusCode())
                    .isEqualTo(HttpStatus.FORBIDDEN);
        }
        JdbcTemplate app = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), APP_USER, APP_PW));
        for (String tabelle : List.of("werkstatt_dienst_ansicht", "werkstatt_lauf")) {
            assertThatThrownBy(() -> app.queryForObject("SELECT count(*) FROM " + tabelle, Long.class)).as(tabelle)
                    .rootCause().hasMessageContaining("permission denied");
        }
    }

    /**
     * Lauf-Seite (E1 A, E2 A): „Nochmal versuchen“ ist ein Auftrag, den der Dienst mit
     * {@code PUT /ansicht?auftraege=1} abholt, genau einmal. Angenommen nur für den
     * zuletzt gemeldeten, angehaltenen Lauf mit {@code nochmal_moeglich} (ein älterer
     * Dienst meldet das nicht: 409). Ohne Parameter bleibt die Meldung 204.
     * „Zur Seite“ hält Fall, Lösung und Grund fest, append-only.
     */
    @Test
    @Order(6)
    void laufSeite_nochmalUndZurSeite() throws Exception {
        String admin = token("admin", "admin");
        String dienst = serviceToken("voltpilot-werkstatt-dienst", "voltpilot-werkstatt-dienst-dev-secret");
        String vektor = java.nio.file.Files.readString(
                java.nio.file.Path.of("..", "..", "docs", "contracts", "werkstatt-ansicht-v1.example.json"));
        String kennung = json.readTree(vektor).get("lauf").get("kennung").asText();
        Map<String, String> nochmal = Map.of("lauf", kennung);

        // Ein Dienst, der Aufträge kennt: 200 mit Liste; ein älterer: 204 wie bisher.
        ResponseEntity<String> r = roh(HttpMethod.PUT, "/api/v1/werkstatt-dienst/ansicht?auftraege=1", dienst, vektor);
        assertThat(r.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(json.readTree(r.getBody()).get("auftraege")).isEmpty();
        // Läuft: kein Nochmal.
        assertThat(send(HttpMethod.POST, "/api/v1/admin/werkstatt/dienst/nochmal", admin, nochmal).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT);

        // Angehalten, aber ohne nochmal_moeglich (älterer Dienst oder Handgriff an der Box): 409.
        com.fasterxml.jackson.databind.node.ObjectNode a = (com.fasterxml.jackson.databind.node.ObjectNode) json.readTree(vektor);
        com.fasterxml.jackson.databind.node.ObjectNode l = (com.fasterxml.jackson.databind.node.ObjectNode) a.get("lauf");
        l.put("zustand", "angehalten").put("fall", "box_weg").put("grund", "dial tcp 192.168.1.1:22: i/o timeout");
        l.putObject("loesung").put("titel", "Die Mango war während des Laufs weg.").put("selbst", true).put("zur_seite", false)
                .putArray("schritte").add("Strom und Kabel der Mango prüfen.");
        assertThat(roh(HttpMethod.PUT, "/api/v1/werkstatt-dienst/ansicht", dienst, a.toString()).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);
        r = send(HttpMethod.POST, "/api/v1/admin/werkstatt/dienst/nochmal", admin, nochmal);
        assertThat(r.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(r)).contains("Handgriff");

        // Der Dienst bietet es an: 201, ein zweites Mal 200 mit demselben Auftrag.
        l.put("nochmal_moeglich", true);
        assertThat(roh(HttpMethod.PUT, "/api/v1/werkstatt-dienst/ansicht", dienst, a.toString()).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);
        r = send(HttpMethod.POST, "/api/v1/admin/werkstatt/dienst/nochmal", admin, nochmal);
        assertThat(r.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String id = json.readTree(r.getBody()).get("id").asText();
        r = send(HttpMethod.POST, "/api/v1/admin/werkstatt/dienst/nochmal", admin, nochmal);
        assertThat(r.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(json.readTree(r.getBody()).get("id").asText()).isEqualTo(id);
        // Form, anderer Lauf, falsche Rolle.
        assertThat(send(HttpMethod.POST, "/api/v1/admin/werkstatt/dienst/nochmal", admin, Map.of("lauf", "a b")).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_CONTENT);
        assertThat(send(HttpMethod.POST, "/api/v1/admin/werkstatt/dienst/nochmal", admin, Map.of("lauf", "2026-11-01-000000-abcd"))
                .getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        for (String t : List.of(dienst, token("demo", "demo"))) {
            assertThat(send(HttpMethod.POST, "/api/v1/admin/werkstatt/dienst/nochmal", t, nochmal).getStatusCode())
                    .isEqualTo(HttpStatus.FORBIDDEN);
        }

        // Der Dienst holt ihn mit der Meldung ab, genau einmal.
        r = roh(HttpMethod.PUT, "/api/v1/werkstatt-dienst/ansicht?auftraege=1", dienst, a.toString());
        assertThat(r.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode auftraege = json.readTree(r.getBody()).get("auftraege");
        assertThat(auftraege).hasSize(1);
        assertThat(auftraege.get(0).get("id").asText()).isEqualTo(id);
        assertThat(auftraege.get(0).get("art").asText()).isEqualTo("nochmal");
        assertThat(auftraege.get(0).get("lauf").asText()).isEqualTo(kennung);
        r = roh(HttpMethod.PUT, "/api/v1/werkstatt-dienst/ansicht?auftraege=1", dienst, a.toString());
        assertThat(json.readTree(r.getBody()).get("auftraege")).isEmpty();
        // Hat der Dienst angenommen (nochmal_seit), gibt es keinen zweiten.
        l.put("nochmal_seit", "2026-11-02T10:13:00Z");
        roh(HttpMethod.PUT, "/api/v1/werkstatt-dienst/ansicht", dienst, a.toString());
        assertThat(send(HttpMethod.POST, "/api/v1/admin/werkstatt/dienst/nochmal", admin, nochmal).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT);

        // Zur Seite: 201 mit Fall, Lösung, Grund; ein zweites Mal 200; in der Ansicht der Bildschirme.
        r = send(HttpMethod.POST, "/api/v1/admin/werkstatt/zur-seite", admin, nochmal);
        assertThat(r.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        JsonNode z = json.readTree(r.getBody());
        assertThat(z.get("fall").asText()).isEqualTo("box_weg");
        assertThat(z.get("loesungTitel").asText()).isEqualTo("Die Mango war während des Laufs weg.");
        assertThat(z.get("grund").asText()).contains("i/o timeout");
        assertThat(z.get("box").asText()).isEqualTo("edge-k7m2xq3");
        assertThat(send(HttpMethod.POST, "/api/v1/admin/werkstatt/zur-seite", admin, nochmal).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        JsonNode d = json.readTree(send(HttpMethod.GET, "/api/v1/admin/werkstatt/dienst", admin, null).getBody());
        assertThat(d.get("zurSeite")).hasSize(1);
        assertThat(d.get("zurSeite").get(0).get("lauf").asText()).isEqualTo(kennung);
        // Unbekannter Lauf 404, laufender 409, nur Admins.
        assertThat(send(HttpMethod.POST, "/api/v1/admin/werkstatt/zur-seite", admin, Map.of("lauf", "2026-11-01-000000-abcd"))
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        String zweiter = vektor.replace(kennung, "2026-11-02T10-09-00-mango");
        roh(HttpMethod.PUT, "/api/v1/werkstatt-dienst/ansicht", dienst, zweiter);
        assertThat(send(HttpMethod.POST, "/api/v1/admin/werkstatt/zur-seite", admin, Map.of("lauf", "2026-11-02T10-09-00-mango"))
                .getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(send(HttpMethod.POST, "/api/v1/admin/werkstatt/zur-seite", dienst, nochmal).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);

        // Die App-Rolle liest nichts; zur Seite ist append-only auch für die Admin-Rolle.
        JdbcTemplate app = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), APP_USER, APP_PW));
        for (String tabelle : List.of("werkstatt_auftrag", "werkstatt_zur_seite")) {
            assertThatThrownBy(() -> app.queryForObject("SELECT count(*) FROM " + tabelle, Long.class)).as(tabelle)
                    .rootCause().hasMessageContaining("permission denied");
        }
        assertThatThrownBy(() -> adminJdbc.update("UPDATE werkstatt_zur_seite SET grund = 'x'"))
                .rootCause().hasMessageContaining("permission denied");
        assertThatThrownBy(() -> adminJdbc.update("DELETE FROM werkstatt_auftrag"))
                .rootCause().hasMessageContaining("permission denied");
    }

    private ResponseEntity<String> roh(HttpMethod method, String pfad, String token, String body) {
        HttpHeaders h = new HttpHeaders();
        if (token != null) {
            h.setBearerAuth(token);
        }
        h.setContentType(MediaType.APPLICATION_JSON);
        return rest.exchange("http://localhost:" + port + pfad, method, new HttpEntity<>(body, h), String.class);
    }

    // ── Hilfen ────────────────────────────────────────────────────────────

    private static List<String> feldnamen(JsonNode n) {
        List<String> l = new java.util.ArrayList<>();
        n.fieldNames().forEachRemaining(l::add);
        return l;
    }

    private String message(ResponseEntity<String> r) {
        try {
            return json.readTree(r.getBody()).path("message").asText();
        } catch (Exception e) {
            return String.valueOf(r.getBody());
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
