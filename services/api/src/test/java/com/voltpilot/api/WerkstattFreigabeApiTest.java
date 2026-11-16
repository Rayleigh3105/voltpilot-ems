package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.werkstatt.WerkstattOpenWrt;
import com.voltpilot.api.werkstatt.WerkstattRegel;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;
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
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * Die Werkstatt nimmt immer die neueste Fassung (vp-werkstatt-immer-neueste):
 * die Regel legt die Freigabe für den Dienst selbst an (neueste zuweisbare
 * signierte Edge-Light-Fassung, OpenWrt fest im Code), „Werkstatt anhalten“ und
 * „Werkstatt fortsetzen“ nur für VoltPilot-Admins mit Protokoll, Lesen der
 * geltenden Freigabe für den Werkstatt-Dienst in seinem eigenen Baum - und dort
 * nichts anderes. Echte Keycloak-Token, echte Migrationen.
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
    private static final String REGEL_BASE = "/api/v1/admin/werkstatt";
    private static final String REGEL = REGEL_BASE + "/regel";
    private static final String DIENST = "/api/v1/werkstatt-dienst/freigabe";
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final String SHA = "0123456789abcdef".repeat(4);

    @Container
    static final TestDatenbank POSTGRES = new TestDatenbank();

    @Container
    static final TestKeycloak KEYCLOAK = new TestKeycloak();

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

    private static final long SEQ = 900_001;

    @Test
    @Order(1)
    void dieRegelNimmtDieNeuesteSignierteFassung() throws Exception {
        String admin = token("admin", "admin");
        String dienst = serviceToken("voltpilot-werkstatt-dienst", "voltpilot-werkstatt-dienst-dev-secret");

        // Ohne signierte Fassung: 404 für den Dienst, mit Grund; die Seite sagt „wartet“.
        ResponseEntity<String> keine = send(HttpMethod.GET, DIENST, dienst, null);
        assertThat(keine.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(message(keine)).contains("keine signierte Edge-Light-Fassung");
        JsonNode r0 = json.readTree(send(HttpMethod.GET, REGEL, admin, null).getBody());
        assertThat(r0.get("zustand").asText()).isEqualTo("wartet");
        assertThat(r0.get("openwrt").get("sha256").asText()).isEqualTo(WerkstattOpenWrt.MANGO.sha256());
        assertThat(r0.get("tagesgrenze").asInt()).isEqualTo(40);

        // Eine Fassung ohne Skriptstand im Manifest nimmt die Werkstatt nicht.
        WerkstattTestFassung.anlegen(adminJdbc, "edge-light-2026.11.0", SEQ, false, true);
        assertThat(message(send(HttpMethod.GET, DIENST, dienst, null))).contains("Skriptstand");
        // Die neueste ist noch nicht zuweisbar (Programme fehlen im Portal): Sie wartet, nimmt nicht die vorige.
        WerkstattTestFassung.anlegen(adminJdbc, "edge-light-2026.11.1", SEQ + 1, true, false);
        ResponseEntity<String> wartet = send(HttpMethod.GET, DIENST, dienst, null);
        assertThat(wartet.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(message(wartet)).contains("edge-light-2026.11.1").contains("noch nicht zuweisbar");
        assertThat(adminJdbc.queryForObject("SELECT count(*) FROM werkstatt_freigabe", Long.class)).isZero();

        // Programme geprüft im Portal: Jetzt gilt sie, in der Form der Datei des Dienstes.
        adminJdbc.update("UPDATE edge_light_programm SET daten = ?, fertig_am = now() WHERE release_seq = ?",
                new byte[] {1, 2, 3, 4}, SEQ + 1);
        Instant vorher = Instant.now();
        JsonNode d = json.readTree(send(HttpMethod.GET, DIENST + "?boxArt=mango", dienst, null).getBody());
        assertThat(d.get("schema").asText()).isEqualTo("vp-werkstatt-freigabe.v1");
        String kennung = d.get("kennung").asText();
        assertThat(kennung).matches("^20[0-9]{2}-[01][0-9]-mango-1$");
        assertThat(d.get("box_art").asText()).isEqualTo("mango");
        assertThat(d.get("erteilt_von").asText()).isEqualTo(WerkstattRegel.AKTEUR_NAME);
        Instant erteilt = Instant.parse(d.get("erteilt_am").asText());
        assertThat(erteilt).isBetween(vorher.minusSeconds(5), Instant.now());
        // Gültig bis Mitternacht (Berlin) und eine Stunde Nachlauf.
        ZonedDateTime morgen = LocalDate.ofInstant(erteilt, BERLIN).plusDays(1).atStartOfDay(BERLIN);
        assertThat(Instant.parse(d.get("gueltig_bis").asText())).isEqualTo(morgen.plusHours(1).toInstant());
        assertThat(d.get("obergrenze").asInt()).isEqualTo(40);
        assertThat(d.get("openwrt").get("fassung").asText()).isEqualTo("25.12.5");
        assertThat(d.get("openwrt").get("datei").asText()).isEqualTo(WerkstattOpenWrt.MANGO.datei());
        assertThat(d.get("openwrt").get("sha256").asText())
                .isEqualTo("056235c21f55288544ca459bc0a61023d084ce788ca5508d49c235dc66a7686c");
        assertThat(d.get("edge_light").get("fassung").asText()).isEqualTo("edge-light-2026.11.1");
        assertThat(d.get("edge_light").get("quelle").asText())
                .isEqualTo("https://git.tecmaxx.de/mamotec/voltpilot-ems/releases/download/edge-light-2026.11.1/");
        assertThat(d.get("edge_light").get("programm_sha256").asText()).isEqualTo(WerkstattTestFassung.PROGRAMM_SHA);
        assertThat(d.get("edge_light").get("skripte_sha256").asText()).isEqualTo(WerkstattTestFassung.SKRIPTE_SHA);
        assertThat(feldnamen(d)).containsExactlyInAnyOrder("schema", "kennung", "box_art", "erteilt_von",
                "erteilt_am", "gueltig_bis", "obergrenze", "openwrt", "edge_light");
        // Jeder Takt des Dienstes bekommt dieselbe Zeile.
        assertThat(json.readTree(send(HttpMethod.GET, DIENST, dienst, null).getBody()).get("kennung").asText())
                .isEqualTo(kennung);

        // Ein neueres, aber unsigniertes Release zählt nie als „neueste“.
        adminJdbc.update("INSERT INTO edge_release (release_seq, version, target_commit, created_by) "
                + "VALUES (?, 'edge-light-2026.11.2', '5b28311b4c0d', 'test')", SEQ + 2);
        assertThat(json.readTree(send(HttpMethod.GET, DIENST, dienst, null).getBody()).get("kennung").asText())
                .isEqualTo(kennung);

        // Eine neuere signierte Fassung gilt ab der nächsten Box: eine neue Zeile; die alte bleibt gültig.
        WerkstattTestFassung.anlegen(adminJdbc, "edge-light-2026.11.3", SEQ + 3);
        JsonNode d2 = json.readTree(send(HttpMethod.GET, DIENST, dienst, null).getBody());
        assertThat(d2.get("kennung").asText()).endsWith("-mango-2");
        assertThat(d2.get("edge_light").get("fassung").asText()).isEqualTo("edge-light-2026.11.3");
        JsonNode liste = json.readTree(send(HttpMethod.GET, BASE, admin, null).getBody());
        assertThat(liste).hasSize(2);
        assertThat(liste.get(0).get("kennung").asText()).endsWith("-mango-2");
        assertThat(liste.get(0).get("quelle").asText()).isEqualTo("regel");
        assertThat(liste.get(0).get("edgeReleaseSeq").asLong()).isEqualTo(SEQ + 3);
        assertThat(liste.get(1).get("zustand").asText()).isEqualTo("laufend");

        JsonNode r = json.readTree(send(HttpMethod.GET, REGEL, admin, null).getBody());
        assertThat(r.get("zustand").asText()).isEqualTo("laeuft");
        assertThat(r.get("grund").isNull()).isTrue();
        assertThat(r.get("freigabe").asText()).isEqualTo(d2.get("kennung").asText());
        assertThat(r.get("edgeLight").get("fassung").asText()).isEqualTo("edge-light-2026.11.3");
        assertThat(r.get("releaseSeq").asLong()).isEqualTo(SEQ + 3);
        assertThat(r.get("vonHand").asBoolean()).isFalse();
        assertThat(r.get("heute").asInt()).isZero();
        assertThat(r.get("angehalten").isNull()).isTrue();
    }

    @Test
    @Order(2)
    void anhaltenUndFortsetzen_mitProtokoll() throws Exception {
        String admin = token("admin", "admin");
        String dienst = serviceToken("voltpilot-werkstatt-dienst", "voltpilot-werkstatt-dienst-dev-secret");
        String kennung = json.readTree(send(HttpMethod.GET, DIENST, dienst, null).getBody()).get("kennung").asText();

        ResponseEntity<String> halt = send(HttpMethod.POST, REGEL_BASE + "/anhalten", admin,
                Map.of("grund", "Probe: falsches Kabel"));
        assertThat(halt.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode h = json.readTree(halt.getBody());
        assertThat(h.get("zustand").asText()).isEqualTo("angehalten");
        assertThat(h.get("angehalten").get("grund").asText()).isEqualTo("Probe: falsches Kabel");
        assertThat(h.get("angehalten").get("von").asText()).isNotBlank();
        assertThat(h.get("freigabe").isNull()).isTrue();
        ResponseEntity<String> fuerDenDienst = send(HttpMethod.GET, DIENST, dienst, null);
        assertThat(fuerDenDienst.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(message(fuerDenDienst)).contains("angehalten");
        // Noch einmal anhalten ändert nichts: ein Eintrag im Protokoll.
        assertThat(send(HttpMethod.POST, REGEL_BASE + "/anhalten", admin, null).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(adminJdbc.queryForObject("SELECT count(*) FROM werkstatt_betrieb", Long.class)).isEqualTo(1L);

        JsonNode weiter = json.readTree(send(HttpMethod.POST, REGEL_BASE + "/fortsetzen", admin, null).getBody());
        assertThat(weiter.get("zustand").asText()).isEqualTo("laeuft");
        assertThat(weiter.get("verlauf")).hasSize(2);
        assertThat(weiter.get("verlauf").get(0).get("angehalten").asBoolean()).isFalse();
        assertThat(weiter.get("verlauf").get(1).get("angehalten").asBoolean()).isTrue();
        assertThat(weiter.get("verlauf").get(1).get("grund").asText()).isEqualTo("Probe: falsches Kabel");
        // Fortgesetzt: dieselbe Zeile wie vorher, keine neue.
        assertThat(json.readTree(send(HttpMethod.GET, DIENST, dienst, null).getBody()).get("kennung").asText())
                .isEqualTo(kennung);

        // Das Protokoll wird nur fortgeschrieben.
        assertThatThrownBy(() -> adminJdbc.update("UPDATE werkstatt_betrieb SET grund = 'x'")).rootCause()
                .hasMessageContaining("permission denied");
        assertThatThrownBy(() -> eigentuemer().update("DELETE FROM werkstatt_betrieb")).rootCause()
                .hasMessageContaining("nur fortgeschrieben");
        assertThat(send(HttpMethod.POST, REGEL_BASE + "/anhalten", admin, Map.of("grund", "x".repeat(501)))
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    @Test
    @Order(3)
    void nurAdminsHalten_nurDerDienstLiest() {
        String kunde = token("demo", "demo");
        String admin = token("admin", "admin");
        String dienst = serviceToken("voltpilot-werkstatt-dienst", "voltpilot-werkstatt-dienst-dev-secret");
        String tunnel = serviceToken("voltpilot-tunnel-dienst", "voltpilot-tunnel-dienst-dev-secret");
        String publisher = serviceToken("voltpilot-release-publisher", "voltpilot-release-publisher-dev-secret");
        // Anhalten, fortsetzen, lesen: nie der Dienst, nie ein Kunde, nie ein anderes Dienstkonto.
        for (String t : List.of(kunde, dienst, tunnel, publisher)) {
            assertThat(send(HttpMethod.POST, REGEL_BASE + "/anhalten", t, null).getStatusCode())
                    .isEqualTo(HttpStatus.FORBIDDEN);
            assertThat(send(HttpMethod.POST, REGEL_BASE + "/fortsetzen", t, null).getStatusCode())
                    .isEqualTo(HttpStatus.FORBIDDEN);
            assertThat(send(HttpMethod.GET, REGEL, t, null).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
            assertThat(send(HttpMethod.GET, BASE, t, null).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        }
        assertThat(adminJdbc.queryForObject("SELECT count(*) FROM werkstatt_betrieb", Long.class)).isEqualTo(2L);
        // Das Formular ist weg: Freigeben und Beenden gibt es nicht mehr.
        assertThat(send(HttpMethod.POST, BASE, admin, Map.of("tage", 30)).getStatusCode().is2xxSuccessful())
                .isFalse();
        assertThat(send(HttpMethod.POST, BASE + "/2026-11-mango-1/ende", admin, null).getStatusCode()
                .is2xxSuccessful()).isFalse();
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
    void uebergang_eineFreigabeVonHandGiltBisDieRegelPasst() throws Exception {
        String admin = token("admin", "admin");
        String dienst = serviceToken("voltpilot-werkstatt-dienst", "voltpilot-werkstatt-dienst-dev-secret");
        // Die laufende Freigabe von Hand aus der Zeit vor der Regel (wie 2026-11-mango-3).
        eigentuemer().update("INSERT INTO werkstatt_freigabe (kennung, box_art, gueltig_ab, gueltig_bis, obergrenze, "
                + "openwrt_fassung, openwrt_datei, openwrt_sha256, openwrt_quelle, edge_fassung, edge_quelle, "
                + "edge_programm_sha256, edge_skripte_sha256, erteilt_am, erteilt_von, erteilt_von_name) VALUES "
                + "('2026-10-mango-3', 'mango', now() - interval '1 day', now() + interval '10 days', 20, '25.12.5', "
                + "'openwrt-25.12.5-ramips-mt76x8-glinet_gl-mt300n-v2-squashfs-sysupgrade.bin', ?, "
                + "'https://downloads.openwrt.org/releases/25.12.5/targets/ramips/mt76x8/', 'edge-light-2026.10.9', "
                + "'https://git.tecmaxx.de/x/', ?, ?, now() - interval '1 day', 'sub-alex', 'Alex')",
                SHA, SHA, SHA);
        // Solange die Regel eine Fassung hat, gilt sie, nicht die von Hand.
        assertThat(json.readTree(send(HttpMethod.GET, DIENST, dienst, null).getBody()).get("edge_light")
                .get("fassung").asText()).isEqualTo("edge-light-2026.11.3");

        // Die neueste Fassung trägt keinen Skriptstand im Manifest: Die Freigabe von Hand gilt weiter.
        WerkstattTestFassung.anlegen(adminJdbc, "edge-light-2026.11.4", SEQ + 4, false, true);
        JsonNode d = json.readTree(send(HttpMethod.GET, DIENST, dienst, null).getBody());
        assertThat(d.get("kennung").asText()).isEqualTo("2026-10-mango-3");
        assertThat(d.get("erteilt_von").asText()).isEqualTo("Alex");
        JsonNode r = json.readTree(send(HttpMethod.GET, REGEL, admin, null).getBody());
        assertThat(r.get("zustand").asText()).isEqualTo("laeuft");
        assertThat(r.get("vonHand").asBoolean()).isTrue();
        assertThat(r.get("freigabe").asText()).isEqualTo("2026-10-mango-3");
        assertThat(r.get("neueste").asText()).isEqualTo("edge-light-2026.11.4");
        assertThat(r.get("grund").asText()).contains("Skriptstand");
        // Angehalten gilt auch sie nicht.
        send(HttpMethod.POST, REGEL_BASE + "/anhalten", admin, null);
        assertThat(send(HttpMethod.GET, DIENST, dienst, null).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        send(HttpMethod.POST, REGEL_BASE + "/fortsetzen", admin, null);

        // Mit der nächsten Fassung samt Skriptstand übernimmt wieder die Regel.
        WerkstattTestFassung.anlegen(adminJdbc, "edge-light-2026.11.5", SEQ + 5);
        JsonNode d2 = json.readTree(send(HttpMethod.GET, DIENST, dienst, null).getBody());
        assertThat(d2.get("edge_light").get("fassung").asText()).isEqualTo("edge-light-2026.11.5");
        assertThat(d2.get("kennung").asText()).endsWith("-mango-3");
    }

    @Test
    @Order(5)
    void tabelle_nurDasEndeAendertSich_undDieAppRolleLiestNichts() {
        String laufend = adminJdbc.queryForObject(
                "SELECT kennung FROM werkstatt_freigabe WHERE quelle = 'regel' ORDER BY gueltig_ab LIMIT 1",
                String.class);
        // Auch Herkunft und Release gehören zum Beleg.
        for (String spalte : List.of("obergrenze = 3", "quelle = 'formular'", "edge_release_seq = 1")) {
            assertThatThrownBy(() -> adminJdbc.update("UPDATE werkstatt_freigabe SET " + spalte + " WHERE kennung = ?",
                    laufend)).as(spalte).rootCause().hasMessageContaining("nur ihr Ende");
        }
        adminJdbc.update("UPDATE werkstatt_freigabe SET beendet_am = now(), beendet_von = 'test' WHERE kennung = ?",
                laufend);
        assertThatThrownBy(() -> adminJdbc.update("UPDATE werkstatt_freigabe SET obergrenze = 3 WHERE kennung = ?",
                laufend)).rootCause().hasMessageContaining("schon beendet");
        // Eine Zeile der Regel ohne Release ist keine.
        assertThatThrownBy(() -> eigentuemer().update("INSERT INTO werkstatt_freigabe (kennung, box_art, gueltig_ab, "
                + "gueltig_bis, obergrenze, openwrt_fassung, openwrt_datei, openwrt_sha256, openwrt_quelle, edge_fassung, "
                + "edge_quelle, edge_programm_sha256, edge_skripte_sha256, erteilt_von, quelle) VALUES ('2026-11-mango-9', "
                + "'mango', now(), now() + interval '1 day', 5, '25.12.5', 'openwrt-25.12.5-x-sysupgrade.bin', ?, "
                + "'https://x.example/', 'edge-light-2026.11.0', 'https://x.example/', ?, ?, 'x', 'regel')", SHA, SHA,
                SHA)).rootCause().hasMessageContaining("werkstatt_freigabe_quelle_chk");
        // Löschen: die Admin-Rolle hat kein DELETE (erster Riegel), und selbst der Eigentümer der Tabelle
        // scheitert am Trigger (zweiter Riegel).
        assertThatThrownBy(() -> adminJdbc.update("DELETE FROM werkstatt_freigabe WHERE kennung = ?", laufend))
                .rootCause().hasMessageContaining("permission denied");
        assertThatThrownBy(() -> eigentuemer().update("DELETE FROM werkstatt_freigabe WHERE kennung = ?", laufend))
                .rootCause().hasMessageContaining("nicht gelöscht");

        JdbcTemplate app = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), APP_USER, APP_PW));
        for (String t : List.of("werkstatt_freigabe", "werkstatt_betrieb")) {
            assertThatThrownBy(() -> app.queryForObject("SELECT count(*) FROM " + t, Long.class)).as(t)
                    .rootCause().hasMessageContaining("permission denied");
        }
    }

    private JdbcTemplate eigentuemer() {
        return new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @Test
    @Order(6)
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
    @Order(7)
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
