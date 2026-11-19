package com.voltpilot.api.werkstatt;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.TestDatenbank;
import com.voltpilot.api.TestKeycloak;
import com.voltpilot.api.WerkstattTestFassung;
import com.voltpilot.api.enrollment.TestPki;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.stream.StreamSupport;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
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
 * Der Takt „nachts von selbst" (S4, §11.2) mit echter Datenbank: Schalter (ab Werk an, dauerhaft, nur
 * Plattform-Admin), am Tag nichts, in der Nacht je Takt ein Auftrag „aufspielen" mit dem Akteur „Automatik · nachts"
 * am Fenster, am Auftrag und im Fernwartungs-Protokoll, Warten auf sein Ende, Halt nach einer Rücknahme, kein Auftrag
 * ohne frische Rückmeldung, und nur ein Takt zur Zeit (die Sperre, die auf mehreren Replikaten führt).
 *
 * <p>Die Uhr der Datenbank und der Dienste ist echt; deshalb legt der Test das Nachtfenster um die echte Zeit
 * ({@link NachtlaufService#setzeNacht}). Das Fenster selbst prüft {@link NachtlaufTest} rein.
 */
@Testcontainers(disabledWithoutDocker = true)
@AutoConfigureTestRestTemplate
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class NachtlaufTaktApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    /** Gültige Kennungen aus edge-ref-vectors.json ({@code gueltig}), nach Kennung sortiert. */
    private static final String ERSTE = "edge-h4n7wp7";
    private static final String ZWEITE = "edge-k7m2xq3";
    private static final String STUMM = "edge-mnpqrsb";
    private static final UUID TECHNIKER = UUID.fromString("7e57ab1e-0001-4000-8000-00000000f1a6");
    private static final String ALT = "edge-light-2026.11.5";
    private static final String NEU = "edge-light-2026.11.15";
    private static final String HOST = "SHA256:" + "c".repeat(43);
    private static final String LISTE = "/api/v1/admin/geraete/ohne-kundenkonto";
    private static final String SCHALTER = LISTE + "/nachtlauf";
    private static final String DIENST = "/api/v1/werkstatt-dienst";

    @Container
    static final TestDatenbank POSTGRES = new TestDatenbank();

    @Container
    static final TestKeycloak KEYCLOAK = new TestKeycloak();

    static final Path PKI_DIR = pki();

    private static Path pki() {
        try {
            Path dir = Files.createTempDirectory("voltpilot-werkstatt-nachtlauf");
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

    @Autowired
    NachtlaufService nachtlauf;

    private final ObjectMapper json = new ObjectMapper();

    @AfterEach
    void echteNacht() {
        nachtlauf.setzeNacht(Nachtlauf::nacht);
    }

    @Test
    void taktLegtNachtsEinenAuftragNachDemAnderenAnUndHaeltNachEinerRuecknahme() throws Exception {
        String admin = token("admin", "admin");
        String dienst = dienstToken();

        WerkstattTestFassung.anlegen(adminJdbc, ALT, 930_005);
        WerkstattTestFassung.anlegen(adminJdbc, NEU, 930_015);
        adminJdbc.update("INSERT INTO fernwartung_zugang (id, art, name, public_key, tunnel_adresse, angelegt_von, "
                + "geaendert_von) VALUES (?, 'techniker', 'Werkstatt-Dienst', ?, '10.10.34.50/32', 'test', 'test')",
                TECHNIKER, zugangsSchluessel("techniker-werkstatt-dienst-nachtlauf"));
        send(HttpMethod.PUT, DIENST + "/ansicht", dienst, ansicht());
        KeyPair k = TestPki.ecKeyPair("secp256r1");
        anlegenUndMelden(ERSTE, "10.10.19.1", k);
        anlegenUndMelden(ZWEITE, "10.10.19.2", k);
        anlegenUndMelden(STUMM, "10.10.19.3", k);
        frisch(ERSTE);
        frisch(ZWEITE);
        // STUMM: ihr Tunnel-Dienst hat seit Minuten nichts gemeldet.
        rueckmeldung(zugangDer(STUMM), Instant.now().minusSeconds(600));

        // ── Schalter: ab Werk an, nur Plattform-Admin ─────────────────────
        assertThat(send(HttpMethod.GET, SCHALTER, null, null).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(send(HttpMethod.GET, SCHALTER, dienst, null).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(send(HttpMethod.POST, SCHALTER, dienst, Map.of("an", false)).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        JsonNode s = lies(send(HttpMethod.GET, SCHALTER, admin, null));
        assertThat(s.get("an").asBoolean()).isTrue();
        assertThat(s.get("geaendertVon").isNull()).isTrue();
        assertThat(s.get("grenze").asInt()).isEqualTo(20);
        assertThat(s.get("angelegt").asInt()).isZero();
        assertThat(send(HttpMethod.POST, SCHALTER, admin, Map.of()).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        // Die Karte: wer in der nächsten Nacht dran ist - die stumme Box nicht.
        Map<String, JsonNode> karte = karte(admin);
        assertThat(karte.get(ERSTE).get("nachtlauf").get("dran").asBoolean()).as(karte.get(ERSTE).toString()).isTrue();
        assertThat(karte.get(ZWEITE).get("nachtlauf").get("dran").asBoolean()).isTrue();
        assertThat(karte.get(STUMM).get("nachtlauf").get("dran").asBoolean()).isFalse();
        assertThat(karte.get(STUMM).get("nachtlauf").get("grund").asText()).isEqualTo(Nachtlauf.GRUND_RUECKMELDUNG);
        // Die Akte sagt dasselbe für ihre Box.
        assertThat(lies(send(HttpMethod.GET, akte(ERSTE), admin, null)).get("nachtlauf").get("dran").asBoolean())
                .isTrue();

        // ── Am Tag: nichts ────────────────────────────────────────────────
        nachtlauf.setzeNacht(t -> new Nachtlauf.Nacht(t.plus(Duration.ofHours(5)), t.plus(Duration.ofHours(8))));
        assertThat(nachtlauf.takt().art()).isEqualTo(Nachtlauf.Art.TAG);
        assertThat(auftraege()).isZero();

        // ── In der Nacht, angehalten: nichts; dauerhaft mit dem Menschen, der umgelegt hat ──
        nachtlauf.setzeNacht(t -> new Nachtlauf.Nacht(t.minus(Duration.ofHours(1)), t.plus(Duration.ofHours(2))));
        JsonNode aus = lies(send(HttpMethod.POST, SCHALTER, admin, Map.of("an", false)));
        assertThat(aus.get("an").asBoolean()).isFalse();
        assertThat(aus.get("geaendertVon").asText()).isEqualTo("admin");
        assertThat(aus.get("imFenster").asBoolean()).isTrue();
        lies(send(HttpMethod.POST, SCHALTER, admin, Map.of("an", false)));
        assertThat(adminJdbc.queryForObject("SELECT count(*) FROM werkstatt_nachtlauf_schalter", Integer.class))
                .isEqualTo(1);
        assertThat(nachtlauf.takt().art()).isEqualTo(Nachtlauf.Art.AUS);
        assertThat(auftraege()).isZero();
        assertThat(karte(admin).get(ERSTE).get("nachtlauf").get("grund").asText()).isEqualTo(Nachtlauf.GRUND_AUS);
        // Angehalten bleibt der Knopf.
        assertThat(karte(admin).get(ERSTE).get("moeglich").asBoolean()).isTrue();
        // Eine Umstellung wird weder geändert noch gelöscht (Rechte und Trigger).
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> adminJdbc.update(
                "DELETE FROM werkstatt_nachtlauf_schalter")).isInstanceOf(org.springframework.dao.DataAccessException.class);

        // ── Eingeschaltet: ein Auftrag je Takt, die erste Box nach Kennung ───
        assertThat(lies(send(HttpMethod.POST, SCHALTER, admin, Map.of("an", true))).get("an").asBoolean()).isTrue();
        Nachtlauf.Urteil u = nachtlauf.takt();
        assertThat(u.art()).as(u.toString()).isEqualTo(Nachtlauf.Art.ANLEGEN);
        assertThat(u.edgeRef()).isEqualTo(ERSTE);
        assertThat(auftraege()).isEqualTo(1);
        UUID id = adminJdbc.queryForObject("SELECT id FROM werkstatt_fernlauf WHERE edge_ref = ?", UUID.class, ERSTE);
        // Derselbe Auftrag wie der Knopf, Akteur „Automatik · nachts" am Auftrag, am Fenster und im Protokoll.
        Map<String, Object> f = adminJdbc.queryForMap("SELECT art, fassung_vorher, fassung_ziel, akteur_sub, "
                + "akteur_name FROM werkstatt_fernlauf WHERE id = ?", id);
        assertThat(f).containsEntry("art", "aufspielen").containsEntry("fassung_vorher", ALT)
                .containsEntry("fassung_ziel", NEU).containsEntry("akteur_sub", "nachtlauf")
                .containsEntry("akteur_name", "Automatik · nachts");
        Map<String, Object> fenster = adminJdbc.queryForMap("SELECT techniker_id, geoeffnet_von, geoeffnet_von_name "
                + "FROM fernwartung_fenster WHERE id = (SELECT fenster_id FROM werkstatt_fernlauf WHERE id = ?)", id);
        assertThat(fenster).containsEntry("techniker_id", TECHNIKER).containsEntry("geoeffnet_von", "nachtlauf")
                .containsEntry("geoeffnet_von_name", "Automatik · nachts");
        assertThat(adminJdbc.queryForList("SELECT akteur_name FROM fernwartung_protokoll WHERE akteur = 'nachtlauf' "
                + "AND aktion = 'fenster_geoeffnet'", String.class)).containsExactly("Automatik · nachts");
        JsonNode inDerAkte = lies(send(HttpMethod.GET, akte(ERSTE), admin, null)).get("verlauf").get(0);
        assertThat(inDerAkte.get("nachts").asBoolean()).isTrue();
        assertThat(inDerAkte.get("akteurName").asText()).isEqualTo("Automatik · nachts");
        assertThat(lies(send(HttpMethod.GET, SCHALTER, admin, null)).get("angelegt").asInt()).isEqualTo(1);

        // ── Einer nach dem anderen: solange er offen ist, wartet der Takt ───
        Nachtlauf.Urteil warten = nachtlauf.takt();
        assertThat(warten.art()).isEqualTo(Nachtlauf.Art.WARTEN);
        assertThat(auftraege()).isEqualTo(1);

        // ── Nur ein Takt zur Zeit: hält ein anderer (Replikat) die Sperre, tut dieser nichts ───
        try (Connection anderes = ((DataSource) adminJdbc.getDataSource()).getConnection()) {
            try (PreparedStatement st = anderes.prepareStatement(
                    "SELECT pg_try_advisory_lock(hashtextextended(?, 0))")) {
                st.setString(1, FernlaufRepository.SPERRE_NACHTLAUF);
                try (ResultSet rs = st.executeQuery()) {
                    assertThat(rs.next() && rs.getBoolean(1)).isTrue();
                }
            }
            assertThat(nachtlauf.takt()).isNull();
            try (PreparedStatement st = anderes.prepareStatement("SELECT pg_advisory_unlock(hashtextextended(?, 0))")) {
                st.setString(1, FernlaufRepository.SPERRE_NACHTLAUF);
                st.execute();
            }
        }
        assertThat(nachtlauf.takt()).isNotNull();

        // ── Der Dienst nimmt an und meldet eine Rücknahme ────────────────
        frisch(ERSTE);
        frisch(ZWEITE);
        assertThat(send(HttpMethod.POST, DIENST + "/fernlaeufe/" + id + "/beginnen", dienst, null).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        Map<String, Object> erg = new HashMap<>();
        erg.put("ergebnis", "zurueck");
        erg.put("schritt", "meldet_sich");
        erg.put("grund", "Die Box meldet sich nach dem Neustart nicht mit der neuen Fassung.");
        erg.put("fassungNachher", ALT);
        assertThat(send(HttpMethod.POST, DIENST + "/fernlaeufe/" + id + "/ergebnis", dienst, erg).getStatusCode())
                .isEqualTo(HttpStatus.CREATED);
        send(HttpMethod.POST, DIENST + "/fernlaeufe/" + id + "/fenster/schliessen", dienst, null);

        // Halt: dieselbe Fassung bekommt in dieser Nacht keine weitere Box; die gescheiterte nie wieder von selbst.
        Nachtlauf.Urteil halt = nachtlauf.takt();
        assertThat(halt.art()).as(halt.toString()).isEqualTo(Nachtlauf.Art.NICHTS);
        assertThat(auftraege()).isEqualTo(1);
        karte = karte(admin);
        assertThat(karte.get(ZWEITE).get("nachtlauf").get("dran").asBoolean()).isFalse();
        assertThat(karte.get(ZWEITE).get("nachtlauf").get("grund").asText()).contains("2026.11.15", "angehalten");
        assertThat(karte.get(ERSTE).get("nachtlauf").get("grund").asText()).contains("nicht noch einmal");
        // Der Knopf bleibt: „Noch einmal" von Hand geht.
        assertThat(karte.get(ERSTE).get("moeglich").asBoolean()).isTrue();
        JsonNode zurueck = karte.get(ERSTE).get("verlauf").get(0);
        assertThat(zurueck.get("zustand").asText()).isEqualTo("zurueck");
        assertThat(zurueck.get("nachts").asBoolean()).isTrue();
    }

    // ── Hilfen ────────────────────────────────────────────────────────────

    private int auftraege() {
        return adminJdbc.queryForObject("SELECT count(*) FROM werkstatt_fernlauf", Integer.class);
    }

    private Map<String, JsonNode> karte(String admin) throws Exception {
        JsonNode liste = lies(send(HttpMethod.GET, LISTE, admin, null));
        Map<String, JsonNode> out = new HashMap<>();
        StreamSupport.stream(liste.spliterator(), false).forEach(n -> out.put(n.get("edgeRef").asText(), n));
        assertThat(out.keySet()).containsExactlyInAnyOrder(ERSTE, ZWEITE, STUMM);
        return out;
    }

    private static String akte(String ref) {
        return "/api/v1/admin/geraete/" + ref + "/fernlauf";
    }

    private void anlegenUndMelden(String ref, String adresse, KeyPair k) throws Exception {
        UUID boxId = werkstatt.boxAnlegen(ref, "edge-light", "{}", null, "test", "Test");
        werkstatt.abnahmeAnlegen(boxId, ref, HOST, ALT, adresse, "10.213.0.1/24", "[]", "{}", null, "test", "Test");
        send(HttpMethod.POST, "/api/v1/enrollment/" + ref + "/csr", null, Map.of("csrPem",
                TestPki.csrPem(k, "CN=" + ref), "deviceInfo", "vp-edge-core " + ALT));
        adminJdbc.update("INSERT INTO fernwartung_zugang (id, art, edge_ref, public_key, tunnel_adresse, "
                + "angelegt_von, geaendert_von) VALUES (?, 'box', ?, ?, ?::inet, 'test', 'test')", UUID.randomUUID(),
                ref, zugangsSchluessel(ref), adresse + "/32");
    }

    private UUID zugangDer(String ref) {
        return adminJdbc.queryForObject("SELECT id FROM fernwartung_zugang WHERE art = 'box' AND edge_ref = ?",
                UUID.class, ref);
    }

    private void frisch(String ref) {
        rueckmeldung(zugangDer(ref), Instant.now());
    }

    /** Eine Meldung des Tunnel-Dienstes: angenommen {@code am}, verbunden, gerade nach Schlüsseln gefragt. */
    private void rueckmeldung(UUID box, Instant am) {
        adminJdbc.update("INSERT INTO fernwartung_rueckmeldung_box (box_id, dienst, angenommen_am, verbunden_seit, "
                + "zuletzt_gefragt_um) VALUES (?, 'test-tunnel', ?, ?, ?) ON CONFLICT (box_id) DO UPDATE SET "
                + "angenommen_am = excluded.angenommen_am, verbunden_seit = excluded.verbunden_seit, "
                + "zuletzt_gefragt_um = excluded.zuletzt_gefragt_um", box, java.sql.Timestamp.from(am),
                java.sql.Timestamp.from(am.minusSeconds(60)), java.sql.Timestamp.from(am.minusSeconds(5)));
    }

    /** Ein erfundener, aber FORMGÜLTIGER Zugangs-Schlüssel (Base64 von genau 32 Bytes). */
    private static String zugangsSchluessel(String seed) {
        byte[] s = seed.getBytes(StandardCharsets.UTF_8);
        byte[] b = new byte[32];
        for (int i = 0; i < b.length; i++) {
            b[i] = s[i % s.length];
        }
        return java.util.Base64.getEncoder().encodeToString(b);
    }

    private String ansicht() throws Exception {
        Map<String, Object> a = new HashMap<>();
        a.put("schema", "vp-werkstatt-ansicht.v1");
        a.put("zeit", Instant.now().toString());
        a.put("werkbank", Map.of("adresse", "192.168.178.50", "bereit", true, "fassung_soll", "3"));
        a.put("freigabe", Map.of("laufend", false, "boxen", 0));
        a.put("fernlauf", Map.of("bereit", true));
        return json.writeValueAsString(a);
    }

    private JsonNode lies(ResponseEntity<String> r) throws Exception {
        assertThat(r.getStatusCode().is2xxSuccessful()).as(r.getStatusCode() + " " + r.getBody()).isTrue();
        return json.readTree(r.getBody());
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
