package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.enrollment.TestPki;
import com.voltpilot.api.werkstatt.WerkstattRepository;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.StreamSupport;
import org.junit.jupiter.api.Test;
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
 * Die Karte „Ohne Kundenkonto" (Konzept vp-update-vor-zuordnung, S2): {@code GET
 * /api/v1/admin/geraete/ohne-kundenkonto} zeigt jede Edge-Light-Box mit Tunnel-Zugang ohne Kundenkonto - mit
 * Vorprüfung, Grund, wenn nicht möglich - und lässt eine Box mit Kundenkonto oder Zertifikat aus. Die Vorprüfung
 * selbst prüft {@link WerkstattFernlaufApiTest}; hier geht es nur um die Liste und ihre Rechte.
 */
@Testcontainers(disabledWithoutDocker = true)
@AutoConfigureTestRestTemplate
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class WerkstattFernlaufUebersichtApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    /** Gültige Kennungen aus edge-ref-vectors.json ({@code gueltig}). */
    private static final String BEREIT = "edge-k7m2xq3";
    private static final String GESPERRT = "edge-mnpqrsb";
    private static final String MIT_KONTO = "edge-zz9988g";
    private static final String MIT_ZERTIFIKAT = "edge-h4n7wp7";
    private static final UUID TECHNIKER = UUID.fromString("7e57ab1e-0001-4000-8000-00000000f1a5");
    private static final String ALT = "edge-light-2026.11.5";
    private static final String NEU = "edge-light-2026.11.15";
    private static final String HOST = "SHA256:" + "b".repeat(43);
    private static final String LISTE = "/api/v1/admin/geraete/ohne-kundenkonto";

    @Container
    static final TestDatenbank POSTGRES = new TestDatenbank();

    @Container
    static final TestKeycloak KEYCLOAK = new TestKeycloak();

    static final Path PKI_DIR = pki();

    private static Path pki() {
        try {
            Path dir = Files.createTempDirectory("voltpilot-werkstatt-fernlauf-uebersicht");
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
    void listeZeigtNurBoxenOhneKundenkontoUndRechteNurPlattformAdmin() throws Exception {
        String admin = token("admin", "admin");
        String dienst = dienstToken();

        WerkstattTestFassung.anlegen(adminJdbc, ALT, 920_005);
        WerkstattTestFassung.anlegen(adminJdbc, NEU, 920_015);
        adminJdbc.update("INSERT INTO fernwartung_zugang (id, art, name, public_key, tunnel_adresse, angelegt_von, "
                + "geaendert_von) VALUES (?, 'techniker', 'Werkstatt-Dienst', ?, '10.10.33.50/32', 'test', 'test')",
                TECHNIKER, zugangsSchluessel("techniker-werkstatt-dienst-uebersicht"));
        send(HttpMethod.PUT, "/api/v1/werkstatt-dienst/ansicht", dienst, ansicht());

        // BEREIT: aus der Werkstatt, meldet 2026.11.5, hängt im Tunnel, fragt gerade nach Schlüsseln - der Knopf geht.
        anlegenUndMelden(BEREIT, "10.10.18.1");
        rueckmeldung(zugangDer(BEREIT), Instant.now().minusSeconds(60), Instant.now().minusSeconds(10));

        // GESPERRT: dieselbe Lage, aber ihr Tunnel-Dienst hat seit mehr als drei Minuten nichts gemeldet - keine
        // Rückmeldung in der Fernwartung, keine `rueckmeldung()` hier (sonst wäre die Meldung gerade erst
        // angenommen, nur mit alten Werten drin).
        anlegenUndMelden(GESPERRT, "10.10.18.2");

        // UNLESBAR: eine freie Kennung ohne gültiges Prüfzeichen (wie {@code edge-fresh-01} aus
        // edge-ref-vectors.json - kein Tippfehler, sondern ein echtes, freies Format). Die Vorprüfung einer
        // einzelnen Box lehnt das mit 422 ab; die Liste darf das nicht in einen 422 für alle verwandeln, sondern
        // zeigt diese eine Box mit Grund.
        String unlesbar = "edge-fresh-01";
        adminJdbc.update("INSERT INTO fernwartung_zugang (id, art, edge_ref, public_key, tunnel_adresse, "
                + "angelegt_von, geaendert_von) VALUES (?, 'box', ?, ?, ?::inet, 'test', 'test')",
                UUID.randomUUID(), unlesbar, zugangsSchluessel(unlesbar), "10.10.18.9/32");

        // MIT_KONTO: hat längst ein Kundenkonto (Gerätezeile) - ihr Update läuft über die Updates im Portal.
        anlegenUndMelden(MIT_KONTO, "10.10.18.3");
        rueckmeldung(zugangDer(MIT_KONTO), Instant.now().minusSeconds(60), Instant.now().minusSeconds(10));
        UUID tenant = UUID.randomUUID();
        UUID site = UUID.randomUUID();
        adminJdbc.update("INSERT INTO tenant (id, name) VALUES (?, 'Kunde Fernlauf-Übersicht')", tenant);
        adminJdbc.update("INSERT INTO site (id, tenant_id, name) VALUES (?, ?, 'Halle')", site, tenant);
        adminJdbc.update("INSERT INTO device (tenant_id, site_id, external_ref, kind, status) VALUES (?,?,?,?,?)",
                tenant, site, MIT_KONTO, "gateway", "claimed");

        // MIT_ZERTIFIKAT: schon ein Zertifikat, aber (noch) keine Gerätezeile - holt ihr Update über das erste Verbinden.
        anlegenUndMelden(MIT_ZERTIFIKAT, "10.10.18.4");
        rueckmeldung(zugangDer(MIT_ZERTIFIKAT), Instant.now().minusSeconds(60), Instant.now().minusSeconds(10));
        adminJdbc.update("UPDATE device_enrollment SET cert_pem = 'test', issued_at = now() WHERE external_ref = ?",
                MIT_ZERTIFIKAT);

        // Ohne Token: 401; der Dienst (keine platform-admin-Rolle): 403.
        assertThat(send(HttpMethod.GET, LISTE, null, null).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(send(HttpMethod.GET, LISTE, dienst, null).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);

        ResponseEntity<String> r = send(HttpMethod.GET, LISTE, admin, null);
        assertThat(r.getStatusCode()).as(r.getBody()).isEqualTo(HttpStatus.OK);
        JsonNode liste = json.readTree(r.getBody());
        List<String> refs = StreamSupport.stream(liste.spliterator(), false).map(n -> n.get("edgeRef").asText())
                .toList();
        // Die drei Boxen ohne Kundenkonto und ohne Zertifikat; alphabetisch, nie die anderen zwei.
        // "edge-fresh-01" vor "edge-k7m2xq3" vor "edge-mnpqrsb" ('f' < 'k' < 'm').
        assertThat(refs).containsExactly(unlesbar, BEREIT, GESPERRT);

        JsonNode kaputt = liste.get(0);
        assertThat(kaputt.get("moeglich").asBoolean()).as(kaputt.toString()).isFalse();
        assertThat(kaputt.get("laeuft").isNull()).isTrue();
        assertThat(StreamSupport.stream(kaputt.get("gruende").spliterator(), false).map(g -> g.get("code").asText())
                .toList()).containsExactly("stand_unlesbar");

        JsonNode bereit = liste.get(1);
        assertThat(bereit.get("edgeRef").asText()).isEqualTo(BEREIT);
        assertThat(bereit.get("moeglich").asBoolean()).as(bereit.toString()).isTrue();
        assertThat(bereit.get("laeuft").asText()).isEqualTo(ALT);
        assertThat(bereit.get("neueste").asText()).isEqualTo(NEU);
        assertThat(bereit.get("haken").get("keinKundenkonto").asBoolean()).isTrue();
        assertThat(bereit.get("verlauf").isArray()).isTrue();

        JsonNode gesperrt = liste.get(2);
        assertThat(gesperrt.get("edgeRef").asText()).isEqualTo(GESPERRT);
        assertThat(gesperrt.get("moeglich").asBoolean()).isFalse();
        List<String> codes = StreamSupport.stream(gesperrt.get("gruende").spliterator(), false)
                .map(g -> g.get("code").asText()).toList();
        assertThat(codes).contains("keine_rueckmeldung");

        // Dieselbe Vorprüfung wie die Akte der Box selbst - keine zweite Logik.
        JsonNode akte = json.readTree(send(HttpMethod.GET, "/api/v1/admin/geraete/" + BEREIT + "/fernlauf", admin,
                null).getBody());
        assertThat(bereit.get("gruende")).isEqualTo(akte.get("gruende"));
    }

    // ── Hilfen ────────────────────────────────────────────────────────────

    private void anlegenUndMelden(String ref, String adresse) throws Exception {
        UUID boxId = werkstatt.boxAnlegen(ref, "edge-light", "{}", null, "test", "Test");
        werkstatt.abnahmeAnlegen(boxId, ref, HOST, ALT, adresse, "10.213.0.1/24", "[]", "{}", null, "test", "Test");
        KeyPair k = TestPki.ecKeyPair("secp256r1");
        send(HttpMethod.POST, "/api/v1/enrollment/" + ref + "/csr", null, Map.of("csrPem",
                TestPki.csrPem(k, "CN=" + ref), "deviceInfo", "vp-edge-core " + ALT));
        UUID zugang = UUID.randomUUID();
        adminJdbc.update("INSERT INTO fernwartung_zugang (id, art, edge_ref, public_key, tunnel_adresse, "
                + "angelegt_von, geaendert_von) VALUES (?, 'box', ?, ?, ?::inet, 'test', 'test')", zugang, ref,
                zugangsSchluessel(ref), adresse + "/32");
    }

    private UUID zugangDer(String ref) {
        return adminJdbc.queryForObject("SELECT id FROM fernwartung_zugang WHERE art = 'box' AND edge_ref = ?",
                UUID.class, ref);
    }

    /** Ein erfundener, aber FORMGÜLTIGER Zugangs-Schlüssel: Base64 von genau 32 Bytes endet immer in der von der
     * Datenbank verlangten Teilmenge (letztes Sextett ist ein Vielfaches von 4). */
    private static String zugangsSchluessel(String seed) {
        byte[] s = seed.getBytes(StandardCharsets.UTF_8);
        byte[] b = new byte[32];
        for (int i = 0; i < b.length; i++) {
            b[i] = s[i % s.length];
        }
        return java.util.Base64.getEncoder().encodeToString(b);
    }

    private void rueckmeldung(UUID box, Instant verbundenSeit, Instant gefragt) {
        adminJdbc.update("INSERT INTO fernwartung_rueckmeldung_box (box_id, dienst, angenommen_am, verbunden_seit, "
                + "zuletzt_gefragt_um) VALUES (?, 'test-tunnel', now(), ?, ?) ON CONFLICT (box_id) DO UPDATE SET "
                + "angenommen_am = excluded.angenommen_am, verbunden_seit = excluded.verbunden_seit, "
                + "zuletzt_gefragt_um = excluded.zuletzt_gefragt_um", box, java.sql.Timestamp.from(verbundenSeit),
                java.sql.Timestamp.from(gefragt));
    }

    private String ansicht() throws Exception {
        Map<String, Object> a = new java.util.HashMap<>();
        a.put("schema", "vp-werkstatt-ansicht.v1");
        a.put("zeit", Instant.now().toString());
        a.put("werkbank", Map.of("adresse", "192.168.178.50", "bereit", true, "fassung_soll", "3"));
        a.put("freigabe", Map.of("laufend", false, "boxen", 0));
        a.put("fernlauf", Map.of("bereit", true));
        return json.writeValueAsString(a);
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
