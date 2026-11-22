package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.enrollment.TestPki;
import com.voltpilot.api.werkstatt.WerkstattRepository;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
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
import org.springframework.boot.resttestclient.TestRestTemplate;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureTestRestTemplate;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * Der Fernlauf durch den Wartungstunnel (Konzept vp-update-vor-zuordnung, S1) über die echten Routen, mit echten
 * Migrationen und echtem Keycloak: die Vorprüfung beim Klick (Gründe, Haken, nur aufwärts, kein zweiter Auftrag),
 * das Fenster für den Techniker-Zugang des Dienstes mit dem Admin als Akteur, der Weg des Dienstes (abholen,
 * annehmen, Schritte, Meldung der Box, Ergebnis, eigenes Fenster schließen), die Rechte beider Bäume und das nur
 * anhängende Ergebnis.
 */
@Testcontainers(disabledWithoutDocker = true)
@AutoConfigureTestRestTemplate
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class WerkstattFernlaufApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    /** Erfundene Kennungen mit gültigem Prüfzeichen (edge-ref-vectors.json). */
    private static final String BOX = "edge-k7m2xq3";
    private static final String BOX2 = "edge-mnpqrsb";
    private static final UUID TECHNIKER = UUID.fromString("7e57ab1e-0000-4000-8000-00000000f1a5");
    private static final String ALT = "edge-light-2026.11.5";
    private static final String NEU = "edge-light-2026.11.15";
    private static final String HOST = "SHA256:" + "a".repeat(43);
    /** Ein WAGO PFC200 (Edge Industrie) aus der Werkstatt, und eine Box, deren Meldung dem Register widerspricht. */
    private static final String PFC = "edge-zz9988g";
    private static final String WIDERSPRUCH = "edge-h4n7wp7";
    private static final String ALT_I = "edge-industrie-2026.11.5";
    private static final String NEU_I = "edge-industrie-2026.11.15";
    private static final String DIENST = "/api/v1/werkstatt-dienst";

    @Container
    static final TestDatenbank POSTGRES = new TestDatenbank();

    @Container
    static final TestKeycloak KEYCLOAK = new TestKeycloak();

    static final Path PKI_DIR = pki();

    private static Path pki() {
        try {
            Path dir = Files.createTempDirectory("voltpilot-werkstatt-fernlauf");
            TestPki.writeCa(dir.resolve("ca"));
            Files.writeString(dir.resolve("acl.conf"), """
                    {allow, {username, "vp-internal"}, all, ["#"]}.
                    %%<<BEGIN GENERATED DEVICE GRANTS>>
                    %%<<END GENERATED DEVICE GRANTS>>
                    {allow, all}.
                    """, StandardCharsets.UTF_8);
            return dir;
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

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

        registry.add("voltpilot.enrollment.enabled", () -> "true");
        registry.add("voltpilot.enrollment.ca-dir", () -> PKI_DIR.resolve("ca").toString());
        registry.add("voltpilot.enrollment.acl-file", () -> PKI_DIR.resolve("acl.conf").toString());
        registry.add("voltpilot.enrollment.mqtt-host", () -> "mqtt.example.com");
        registry.add("voltpilot.enrollment.mqtt-port", () -> "8883");
        registry.add("voltpilot.fernwartung.server-public-key", () -> "LnLMuBG+dDEeaEKlQrdTlPifX2fk0hOaB/NFc/BudjE=");
        registry.add("voltpilot.werkstatt.techniker-zugang", TECHNIKER::toString);
    }

    @Autowired
    TestRestTemplate rest;

    @Autowired
    @Qualifier("adminJdbcTemplate")
    JdbcTemplate adminJdbc;

    @Autowired
    WerkstattRepository werkstatt;

    private final ObjectMapper json = new ObjectMapper();

    @Test
    @Order(1)
    void vomKlickBisZumErgebnis() throws Exception {
        String admin = token("admin", "admin");
        String dienst = dienstToken();

        // Nichts bekannt: kein Knopf, und jeder Grund steht da (unbekannt ist nie „ja“).
        JsonNode leer = lies(send(HttpMethod.GET, akte(BOX), admin, null));
        assertThat(leer.get("moeglich").asBoolean()).isFalse();
        assertThat(codes(leer)).contains("fassung_unbekannt", "keine_neueste", "kein_tunnel",
                "kein_techniker_zugang", "dienst_stumm", "kein_host_schluessel");

        // Die wartende Box: aus der Werkstatt mit 2026.11.5, meldet sich, hängt im Tunnel, fragt nach Schlüsseln.
        WerkstattTestFassung.anlegen(adminJdbc, ALT, 910_005);
        WerkstattTestFassung.anlegen(adminJdbc, NEU, 910_015);
        UUID boxId = werkstatt.boxAnlegen(BOX, "edge-light", "{}", null, "test", "Test");
        werkstatt.abnahmeAnlegen(boxId, BOX, HOST, ALT, "10.10.16.5", "10.213.0.1/24", "[]", "{}", null, "test",
                "Test");
        KeyPair k = TestPki.ecKeyPair("secp256r1");
        assertThat(send(HttpMethod.POST, "/api/v1/enrollment/" + BOX + "/csr", null, Map.of("csrPem",
                TestPki.csrPem(k, "CN=" + BOX), "deviceInfo", "vp-edge-core " + ALT)).getStatusCode())
                .isEqualTo(HttpStatus.ACCEPTED);
        adminJdbc.update("INSERT INTO fernwartung_zugang (id, art, name, public_key, tunnel_adresse, angelegt_von, "
                + "geaendert_von) VALUES (?, 'techniker', 'Werkstatt-Dienst', ?, '10.10.32.50/32', 'test', 'test')",
                TECHNIKER, "dGVjaG5pa2VyLXdlcmtzdGF0dC1kaWVuc3QtZmVybmw=");
        UUID zugang = UUID.randomUUID();
        adminJdbc.update("INSERT INTO fernwartung_zugang (id, art, edge_ref, public_key, tunnel_adresse, angelegt_von, "
                + "geaendert_von) VALUES (?, 'box', ?, ?, '10.10.16.5/32', 'test', 'test')", zugang, BOX,
                "Ym94LXdhcnRldC1hdWYtemlubm9yZG51bmctZmVybmw=");
        rueckmeldung(zugang, Instant.now().minusSeconds(120), Instant.now().minusSeconds(20));

        // Der Dienst meldet sich noch ohne Fernlauf (älteres Bild): kein Knopf.
        assertThat(send(HttpMethod.PUT, DIENST + "/ansicht", dienst, ansicht(null)).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(codes(lies(send(HttpMethod.GET, akte(BOX), admin, null)))).containsExactly("dienst_alt");
        assertThat(send(HttpMethod.PUT, DIENST + "/ansicht", dienst, ansicht(false)).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(codes(lies(send(HttpMethod.GET, akte(BOX), admin, null)))).containsExactly("dienst_nicht_bereit");
        assertThat(send(HttpMethod.PUT, DIENST + "/ansicht", dienst, ansicht(true)).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);

        JsonNode s = lies(send(HttpMethod.GET, akte(BOX), admin, null));
        assertThat(s.get("moeglich").asBoolean()).as(s.toString()).isTrue();
        assertThat(s.get("laeuft").asText()).isEqualTo(ALT);
        assertThat(s.get("neueste").asText()).isEqualTo(NEU);
        assertThat(s.get("werkstattFassung").asText()).isEqualTo(ALT);
        assertThat(s.hasNonNull("laeuftGemeldetAm")).isTrue();
        assertThat(s.get("haken").get("tunnelVerbunden").asBoolean()).isTrue();
        assertThat(s.get("haken").get("fragtNachSchluesseln").asBoolean()).isTrue();
        assertThat(s.get("haken").get("keinKundenkonto").asBoolean()).isTrue();

        // Bestätigt ist eine andere Fassung als die neueste: nichts passiert.
        ResponseEntity<String> anders = send(HttpMethod.POST, akte(BOX), admin, Map.of("fassung", ALT));
        assertThat(anders.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(anders)).contains("Inzwischen ist " + NEU);
        assertThat(adminJdbc.queryForObject("SELECT count(*) FROM werkstatt_fernlauf", Integer.class)).isZero();

        ResponseEntity<String> an = send(HttpMethod.POST, akte(BOX), admin, Map.of("fassung", NEU));
        assertThat(an.getStatusCode()).as(an.getBody()).isEqualTo(HttpStatus.CREATED);
        JsonNode auftrag = lies(an);
        UUID id = UUID.fromString(auftrag.get("id").asText());
        assertThat(auftrag.get("zustand").asText()).isEqualTo("erteilt");
        assertThat(auftrag.get("fassungVorher").asText()).isEqualTo(ALT);
        assertThat(auftrag.get("fassungZiel").asText()).isEqualTo(NEU);
        // Das Fenster: 30 Minuten für den Zugang des Dienstes, Grund mit Fassung und Auftrag, geöffnet vom Admin.
        Map<String, Object> fenster = adminJdbc.queryForMap("SELECT techniker_id, grund, beginn, ende, geoeffnet_von, "
                + "geoeffnet_von_name FROM fernwartung_fenster WHERE id = (SELECT fenster_id FROM werkstatt_fernlauf "
                + "WHERE id = ?)", id);
        assertThat(fenster.get("techniker_id")).isEqualTo(TECHNIKER);
        assertThat((String) fenster.get("grund")).isEqualTo("Software aufspielen " + NEU + " (Auftrag "
                + id.toString().substring(0, 8) + ")");
        assertThat(Duration.between(((Timestamp) fenster.get("beginn")).toInstant(),
                ((Timestamp) fenster.get("ende")).toInstant())).isEqualTo(Duration.ofMinutes(30));
        assertThat(fenster.get("geoeffnet_von_name")).isEqualTo("admin");
        assertThat(adminJdbc.queryForObject("SELECT akteur_name FROM werkstatt_fernlauf WHERE id = ?", String.class,
                id)).isEqualTo("admin");

        // Einer zur Zeit.
        ResponseEntity<String> zweiter = send(HttpMethod.POST, akte(BOX), admin, Map.of("fassung", NEU));
        assertThat(zweiter.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(zweiter)).contains("läuft schon ein Fernlauf");

        // Der Dienst sieht den Auftrag mit seiner Meldung, bis er ihn annimmt.
        for (int i = 0; i < 2; i++) {
            JsonNode a = lies(send(HttpMethod.PUT, DIENST + "/ansicht?auftraege=1", dienst, ansicht(true)));
            assertThat(a.get("auftraege").toString()).contains("\"id\":\"" + id + "\"", "\"art\":\"aufspielen\"",
                    "\"lauf\":\"" + BOX + "\"");
        }
        ResponseEntity<String> schrittVorher = send(HttpMethod.POST, DIENST + "/fernlaeufe/" + id + "/schritt", dienst,
                Map.of("schritt", "anmelden", "zustand", "laeuft"));
        assertThat(schrittVorher.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

        ResponseEntity<String> begonnen = send(HttpMethod.POST, DIENST + "/fernlaeufe/" + id + "/beginnen", dienst,
                null);
        assertThat(begonnen.getStatusCode()).as(begonnen.getBody()).isEqualTo(HttpStatus.OK);
        JsonNode b = lies(begonnen);
        assertThat(b.get("edgeRef").asText()).isEqualTo(BOX);
        assertThat(b.get("tunnelAdresse").asText()).startsWith("10.10.16.5");
        assertThat(b.get("hostSchluessel").asText()).isEqualTo(HOST);
        assertThat(b.get("ziel").get("fassung").asText()).isEqualTo(NEU);
        assertThat(b.get("ziel").get("programm_sha256").asText()).isEqualTo(WerkstattTestFassung.PROGRAMM_SHA);
        assertThat(b.get("ziel").get("skripte_sha256").asText()).isEqualTo(WerkstattTestFassung.SKRIPTE_SHA);
        assertThat(b.get("ziel").get("release_seq").asLong()).isEqualTo(910_015);
        assertThat(b.get("ziel").get("quelle").asText()).endsWith("/" + NEU + "/");
        assertThat(b.get("server").get("publicKey").asText()).isEqualTo("LnLMuBG+dDEeaEKlQrdTlPifX2fk0hOaB/NFc/BudjE=");
        assertThat(b.get("server").get("endpunkt").asText()).isEqualTo("wartung.voltpilot.de:51820");
        assertThat(b.toString()).doesNotContain("PRIVATE", "passwort");
        assertThat(send(HttpMethod.POST, DIENST + "/fernlaeufe/" + id + "/beginnen", dienst, null).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT);
        assertThat(lies(send(HttpMethod.PUT, DIENST + "/ansicht?auftraege=1", dienst, ansicht(true)))
                .get("auftraege").toString()).doesNotContain(id.toString());

        // Schritte: geschlossenes Vokabular, kein Schlüsselmaterial.
        for (Map<String, String> m : List.of(Map.of("schritt", "anmelden", "zustand", "laeuft"),
                Map.of("schritt", "anmelden", "zustand", "belegt", "zeile", "Host-Schlüssel " + HOST + " (gleich)"),
                Map.of("schritt", "sichern", "zustand", "laeuft"))) {
            assertThat(send(HttpMethod.POST, DIENST + "/fernlaeufe/" + id + "/schritt", dienst, m).getStatusCode())
                    .isEqualTo(HttpStatus.NO_CONTENT);
        }
        assertThat(send(HttpMethod.POST, DIENST + "/fernlaeufe/" + id + "/schritt", dienst,
                Map.of("schritt", "shell", "zustand", "laeuft")).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_CONTENT);
        assertThat(send(HttpMethod.POST, DIENST + "/fernlaeufe/" + id + "/schritt", dienst,
                Map.of("schritt", "sichern", "zustand", "belegt", "zeile", "-----BEGIN OPENSSH PRIVATE KEY-----"))
                .getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_CONTENT);
        JsonNode laufend = lies(send(HttpMethod.GET, akte(BOX), admin, null)).get("verlauf").get(0);
        assertThat(laufend.get("zustand").asText()).isEqualTo("laeuft");
        assertThat(laufend.get("schritt").asText()).isEqualTo("sichern");
        assertThat(laufend.get("schritte")).hasSize(1);
        assertThat(laufend.get("schritte").get(0).get("zeile").asText()).contains(HOST);

        // Was die Plattform von der Box hört (für meldet_sich): die neue Zertifikatsanfrage nach dem Neustart.
        assertThat(send(HttpMethod.POST, "/api/v1/enrollment/" + BOX + "/csr", null, Map.of("csrPem",
                TestPki.csrPem(k, "CN=" + BOX), "deviceInfo", "vp-edge-core " + NEU)).getStatusCode())
                .isEqualTo(HttpStatus.ACCEPTED);
        JsonNode m = lies(send(HttpMethod.GET, DIENST + "/fernlaeufe/" + id + "/meldung", dienst, null));
        assertThat(m.get("deviceInfo").asText()).isEqualTo("vp-edge-core " + NEU);
        assertThat(m.get("zertifikat").asBoolean()).isFalse();

        Map<String, Object> erg = new HashMap<>();
        erg.put("ergebnis", "fertig");
        erg.put("schritt", "tunnel");
        erg.put("fassungNachher", NEU);
        erg.put("belege", Map.of("neustart", "/health: " + NEU + ", Stand 910015", "tunnel", "latest handshake: 4 s"));
        ResponseEntity<String> e1 = send(HttpMethod.POST, DIENST + "/fernlaeufe/" + id + "/ergebnis", dienst, erg);
        assertThat(e1.getStatusCode()).as(e1.getBody()).isEqualTo(HttpStatus.CREATED);
        assertThat(send(HttpMethod.POST, DIENST + "/fernlaeufe/" + id + "/ergebnis", dienst, erg).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT);
        assertThat(send(HttpMethod.POST, DIENST + "/fernlaeufe/" + id + "/schritt", dienst,
                Map.of("schritt", "tunnel", "zustand", "belegt")).getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(send(HttpMethod.POST, DIENST + "/fernlaeufe/" + id + "/fenster/schliessen", dienst, null)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(send(HttpMethod.POST, DIENST + "/fernlaeufe/" + id + "/fenster/schliessen", dienst, null)
                .getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

        JsonNode fertig = lies(send(HttpMethod.GET, akte(BOX), admin, null));
        JsonNode f = fertig.get("verlauf").get(0);
        assertThat(f.get("zustand").asText()).isEqualTo("fertig");
        assertThat(f.get("ergebnis").get("fassungNachher").asText()).isEqualTo(NEU);
        assertThat(f.get("ergebnis").get("quelle").asText()).isEqualTo("dienst");
        assertThat(f.get("ergebnis").get("belege").get("tunnel").asText()).contains("handshake");
        // Jetzt läuft sie die neueste: nur aufwärts.
        assertThat(codes(fertig)).containsExactly("schon_neueste");

        // Das Ergebnis ist nur angehängt: die Admin-Rolle darf weder ändern noch löschen, und selbst der
        // Eigentümer der Tabelle scheitert am Trigger.
        assertThatThrownBy(() -> adminJdbc.update("UPDATE werkstatt_fernlauf_ergebnis SET ergebnis = 'offen'"))
                .hasStackTraceContaining("permission denied");
        assertThatThrownBy(() -> adminJdbc.update("DELETE FROM werkstatt_fernlauf_ergebnis"))
                .hasStackTraceContaining("permission denied");
        JdbcTemplate eigentuemer = new JdbcTemplate(new org.springframework.jdbc.datasource.DriverManagerDataSource(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword()));
        assertThatThrownBy(() -> eigentuemer.update("UPDATE werkstatt_fernlauf_ergebnis SET ergebnis = 'offen'"))
                .hasStackTraceContaining("weder geändert noch gelöscht");
        assertThatThrownBy(() -> eigentuemer.update("DELETE FROM werkstatt_fernlauf_ergebnis"))
                .hasStackTraceContaining("weder geändert noch gelöscht");
    }

    @Test
    @Order(2)
    void nichtAbgeholtUndInzwischenVerbunden() throws Exception {
        String admin = token("admin", "admin");
        String dienst = dienstToken();
        UUID boxId = werkstatt.boxAnlegen(BOX2, "edge-light", "{}", null, "test", "Test");
        werkstatt.abnahmeAnlegen(boxId, BOX2, HOST, ALT, "10.10.16.6", "10.213.0.1/24", "[]", "{}", null, "test",
                "Test");
        KeyPair k = TestPki.ecKeyPair("secp256r1");
        send(HttpMethod.POST, "/api/v1/enrollment/" + BOX2 + "/csr", null, Map.of("csrPem",
                TestPki.csrPem(k, "CN=" + BOX2), "deviceInfo", "vp-edge-core " + ALT));
        UUID zugang = UUID.randomUUID();
        adminJdbc.update("INSERT INTO fernwartung_zugang (id, art, edge_ref, public_key, tunnel_adresse, angelegt_von, "
                + "geaendert_von) VALUES (?, 'box', ?, ?, '10.10.16.6/32', 'test', 'test')", zugang, BOX2,
                "Ym94LXp3ZWktd2FydGV0LWF1Zi16aW5ub3JkbnVuZ2Y=");
        rueckmeldung(zugang, Instant.now().minusSeconds(120), Instant.now().minusSeconds(20));
        send(HttpMethod.PUT, DIENST + "/ansicht", dienst, ansicht(true));

        UUID alt = UUID.fromString(lies(send(HttpMethod.POST, akte(BOX2), admin, Map.of("fassung", NEU)))
                .get("id").asText());
        // Elf Minuten ohne Abholung: nicht abgeholt, kein offener Auftrag mehr, nicht mehr annehmbar.
        adminJdbc.update("UPDATE werkstatt_fernlauf SET erteilt_am = now() - interval '11 minutes' WHERE id = ?", alt);
        JsonNode s = lies(send(HttpMethod.GET, akte(BOX2), admin, null));
        assertThat(s.get("verlauf").get(0).get("zustand").asText()).isEqualTo("nicht_abgeholt");
        assertThat(s.get("moeglich").asBoolean()).isTrue();
        assertThat(send(HttpMethod.POST, DIENST + "/fernlaeufe/" + alt + "/beginnen", dienst, null).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT);

        // Der neue Auftrag schließt den alten ab (Ergebnis der Plattform) und dessen noch offenes Fenster.
        UUID neu = UUID.fromString(lies(send(HttpMethod.POST, akte(BOX2), admin, Map.of("fassung", NEU)))
                .get("id").asText());
        Map<String, Object> e = adminJdbc.queryForMap("SELECT ergebnis, quelle, grund FROM werkstatt_fernlauf_ergebnis "
                + "WHERE fernlauf_id = ?", alt);
        assertThat(e.get("ergebnis")).isEqualTo("unveraendert");
        assertThat(e.get("quelle")).isEqualTo("portal");
        assertThat((String) e.get("grund")).contains("nicht abgeholt");
        assertThat(adminJdbc.queryForObject("SELECT geschlossen_am IS NOT NULL FROM fernwartung_fenster WHERE id = "
                + "(SELECT fenster_id FROM werkstatt_fernlauf WHERE id = ?)", Boolean.class, alt)).isTrue();

        // Bis der Dienst annimmt, hat die Box ein Zertifikat bekommen: der Auftrag endet ohne Änderung.
        adminJdbc.update("UPDATE device_enrollment SET cert_pem = 'test', issued_at = now() WHERE external_ref = ?",
                BOX2);
        ResponseEntity<String> b = send(HttpMethod.POST, DIENST + "/fernlaeufe/" + neu + "/beginnen", dienst, null);
        assertThat(b.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(b)).contains("Inzwischen verbunden");
        JsonNode nach = lies(send(HttpMethod.GET, akte(BOX2), admin, null));
        assertThat(nach.get("verlauf").get(0).get("zustand").asText()).isEqualTo("unveraendert");
        assertThat(codes(nach)).contains("zertifikat");
        assertThat(nach.get("haken").get("keinKundenkonto").asBoolean()).isFalse();
    }

    @Test
    @Order(3)
    void rechteBeiderBaeume() throws Exception {
        String admin = token("admin", "admin");
        String dienst = dienstToken();
        UUID id = adminJdbc.queryForObject("SELECT id FROM werkstatt_fernlauf ORDER BY erteilt_am LIMIT 1", UUID.class);
        // Der Dienst erreicht die Admin-Routen nicht, der Admin nicht die des Dienstes; ohne Token niemand.
        assertThat(send(HttpMethod.GET, akte(BOX), dienst, null).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(send(HttpMethod.POST, akte(BOX), dienst, Map.of()).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        for (String pfad : List.of("/beginnen", "/ergebnis", "/fenster/schliessen", "/schritt")) {
            assertThat(send(HttpMethod.POST, DIENST + "/fernlaeufe/" + id + pfad, admin, Map.of()).getStatusCode())
                    .as(pfad).isEqualTo(HttpStatus.FORBIDDEN);
            assertThat(send(HttpMethod.POST, DIENST + "/fernlaeufe/" + id + pfad, null, Map.of()).getStatusCode())
                    .as(pfad).isEqualTo(HttpStatus.UNAUTHORIZED);
        }
        assertThat(send(HttpMethod.GET, DIENST + "/fernlaeufe/" + id + "/meldung", admin, null).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(send(HttpMethod.GET, akte(BOX), null, null).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(send(HttpMethod.GET, akte("edge-k7m2xqz"), admin, null).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_CONTENT);
        assertThat(send(HttpMethod.POST, DIENST + "/fernlaeufe/" + UUID.randomUUID() + "/beginnen", dienst, null)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    /**
     * Ein PFC200 ohne Kundenkonto bekommt die neueste Fassung SEINER Linie (Edge Industrie), eine Mango weiter nur
     * Edge Light - auch wenn die andere Linie den höheren Stand hat. Widersprechen sich Werkstatt-Register und
     * gemeldete Fassung, gibt es keinen Knopf.
     */
    @Test
    @Order(4)
    void pfc200BekommtNurEdgeIndustrie() throws Exception {
        String admin = token("admin", "admin");
        String dienst = dienstToken();
        // Beide Fassungen von Edge Industrie haben einen höheren Stand als jede von Edge Light.
        WerkstattTestFassung.anlegenIndustrie(adminJdbc, ALT_I, 910_105, true);
        WerkstattTestFassung.anlegenIndustrie(adminJdbc, NEU_I, 910_115, true);
        send(HttpMethod.PUT, DIENST + "/ansicht", dienst, ansicht(true));

        UUID boxId = werkstatt.boxAnlegen(PFC, "edge-industrie", "{}", null, "test", "Test");
        werkstatt.abnahmeAnlegen(boxId, PFC, HOST, ALT_I, "10.10.16.7", "192.168.1.0/24", "[]", "{}", null, "test",
                "Test");
        KeyPair k = TestPki.ecKeyPair("secp256r1");
        assertThat(send(HttpMethod.POST, "/api/v1/enrollment/" + PFC + "/csr", null, Map.of("csrPem",
                TestPki.csrPem(k, "CN=" + PFC), "deviceInfo", "vp-edge-core " + ALT_I)).getStatusCode())
                .isEqualTo(HttpStatus.ACCEPTED);
        UUID zugang = UUID.randomUUID();
        adminJdbc.update("INSERT INTO fernwartung_zugang (id, art, edge_ref, public_key, tunnel_adresse, angelegt_von, "
                + "geaendert_von) VALUES (?, 'box', ?, ?, '10.10.16.7/32', 'test', 'test')", zugang, PFC,
                "cGZjMjAwLXdhcnRldC1hdWYtemlubm9yZG51bmctZmw=");
        rueckmeldung(zugang, Instant.now().minusSeconds(120), Instant.now().minusSeconds(20));

        JsonNode s = lies(send(HttpMethod.GET, akte(PFC), admin, null));
        assertThat(s.get("moeglich").asBoolean()).as(s.toString()).isTrue();
        assertThat(s.get("laeuft").asText()).isEqualTo(ALT_I);
        assertThat(s.get("neueste").asText()).isEqualTo(NEU_I);

        // Eine Edge-Light-Fassung kommt nie auf den PFC200, auch nicht auf Zuruf.
        ResponseEntity<String> light = send(HttpMethod.POST, akte(PFC), admin, Map.of("fassung", NEU));
        assertThat(light.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(light)).contains("Inzwischen ist " + NEU_I);

        UUID id = UUID.fromString(lies(send(HttpMethod.POST, akte(PFC), admin, Map.of("fassung", NEU_I)))
                .get("id").asText());
        JsonNode b = lies(send(HttpMethod.POST, DIENST + "/fernlaeufe/" + id + "/beginnen", dienst, null));
        assertThat(b.get("edgeRef").asText()).isEqualTo(PFC);
        assertThat(b.get("tunnelAdresse").asText()).startsWith("10.10.16.7");
        assertThat(b.get("hostSchluessel").asText()).isEqualTo(HOST);
        // Der Dienst erkennt das Gerät an der Linie dieser Fassung (internal/fernlauf: IstIndustrie).
        assertThat(b.get("ziel").get("fassung").asText()).isEqualTo(NEU_I);
        assertThat(b.get("ziel").get("programm_sha256").asText()).isEqualTo(WerkstattTestFassung.INDUSTRIE_PROGRAMM_SHA);
        assertThat(b.get("ziel").get("skripte_sha256").asText()).isEqualTo(WerkstattTestFassung.INDUSTRIE_SKRIPTE_SHA);
        assertThat(b.get("ziel").get("release_seq").asLong()).isEqualTo(910_115);
        assertThat(b.get("ziel").get("quelle").asText()).endsWith("/" + NEU_I + "/");

        // Die Mango aus dem ersten Test läuft die neueste Edge-Light-Fassung: Für sie ist weiter nichts neuer.
        JsonNode mango = lies(send(HttpMethod.GET, akte(BOX), admin, null));
        assertThat(mango.get("neueste").asText()).isEqualTo(NEU);
        assertThat(codes(mango)).containsExactly("schon_neueste");

        // Im Register eine Mango, gemeldet wird Edge Industrie: Die API rät nicht, welche Linie auf das Gerät gehört.
        UUID fremdId = werkstatt.boxAnlegen(WIDERSPRUCH, "edge-light", "{}", null, "test", "Test");
        werkstatt.abnahmeAnlegen(fremdId, WIDERSPRUCH, HOST, ALT, "10.10.16.8", "10.213.0.1/24", "[]", "{}", null,
                "test", "Test");
        send(HttpMethod.POST, "/api/v1/enrollment/" + WIDERSPRUCH + "/csr", null, Map.of("csrPem",
                TestPki.csrPem(TestPki.ecKeyPair("secp256r1"), "CN=" + WIDERSPRUCH), "deviceInfo",
                "vp-edge-core " + ALT_I));
        UUID zugang2 = UUID.randomUUID();
        adminJdbc.update("INSERT INTO fernwartung_zugang (id, art, edge_ref, public_key, tunnel_adresse, angelegt_von, "
                + "geaendert_von) VALUES (?, 'box', ?, ?, '10.10.16.8/32', 'test', 'test')", zugang2, WIDERSPRUCH,
                "d2lkZXJzcHJ1Y2gtd2FydGV0LWF1Zi1lbnRzY2hlaWQ=");
        rueckmeldung(zugang2, Instant.now().minusSeconds(120), Instant.now().minusSeconds(20));
        JsonNode w = lies(send(HttpMethod.GET, akte(WIDERSPRUCH), admin, null));
        assertThat(w.get("moeglich").asBoolean()).isFalse();
        assertThat(codes(w)).contains("keine_edge_light");
        assertThat(send(HttpMethod.POST, akte(WIDERSPRUCH), admin, Map.of("fassung", NEU_I)).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT);
        assertThat(send(HttpMethod.POST, akte(WIDERSPRUCH), admin, Map.of("fassung", NEU)).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT);
    }

    // ── Hilfen ────────────────────────────────────────────────────────────

    private static String akte(String ref) {
        return "/api/v1/admin/geraete/" + ref + "/fernlauf";
    }

    private void rueckmeldung(UUID box, Instant verbundenSeit, Instant gefragt) {
        adminJdbc.update("INSERT INTO fernwartung_rueckmeldung_box (box_id, dienst, angenommen_am, verbunden_seit, "
                + "zuletzt_gefragt_um) VALUES (?, 'test-tunnel', now(), ?, ?) ON CONFLICT (box_id) DO UPDATE SET "
                + "angenommen_am = excluded.angenommen_am, verbunden_seit = excluded.verbunden_seit, "
                + "zuletzt_gefragt_um = excluded.zuletzt_gefragt_um", box, Timestamp.from(verbundenSeit),
                Timestamp.from(gefragt));
    }

    /** Eine Ansicht des Dienstes; {@code fernlauf} null = das Feld fehlt (älteres Bild). */
    private String ansicht(Boolean fernlauf) throws Exception {
        Map<String, Object> a = new HashMap<>();
        a.put("schema", "vp-werkstatt-ansicht.v1");
        a.put("zeit", Instant.now().toString());
        a.put("werkbank", Map.of("adresse", "192.168.178.50", "bereit", true, "fassung_soll", "3"));
        a.put("freigabe", Map.of("laufend", false, "boxen", 0));
        if (fernlauf != null) {
            a.put("fernlauf", fernlauf ? Map.of("bereit", true) : Map.of("bereit", false, "grund",
                    "kein Techniker-Zugang"));
        }
        return json.writeValueAsString(a);
    }

    private List<String> codes(JsonNode stand) {
        List<String> out = new ArrayList<>();
        stand.get("gruende").forEach(g -> out.add(g.get("code").asText()));
        return out;
    }

    private JsonNode lies(ResponseEntity<String> r) throws Exception {
        assertThat(r.getStatusCode().is2xxSuccessful()).as(r.getStatusCode() + " " + r.getBody()).isTrue();
        return json.readTree(r.getBody());
    }

    private String message(ResponseEntity<String> r) throws Exception {
        return json.readTree(r.getBody()).path("message").asText();
    }

    private ResponseEntity<String> send(HttpMethod method, String pfad, String token, Object body) {
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.APPLICATION_JSON);
        if (token != null) {
            h.setBearerAuth(token);
        }
        Object rumpf = body;
        if (body != null && !(body instanceof String)) {
            try {
                rumpf = json.writeValueAsString(body);
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        }
        return rest.exchange(pfad, method, new HttpEntity<>(rumpf, h), String.class);
    }

    private String dienstToken() {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "client_credentials");
        form.add("client_id", "voltpilot-werkstatt-dienst");
        form.add("client_secret", "voltpilot-werkstatt-dienst-dev-secret");
        return tokenAnfrage(form);
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
