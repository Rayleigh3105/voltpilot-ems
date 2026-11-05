package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.enrollment.TestPki;
import com.voltpilot.api.werkstatt.EinloesenVertrag;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.cert.X509Certificate;
import java.time.Duration;
import java.time.Instant;
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
 * Einmal-Code, Einlösen und D2 (Werkstatt-Automatik V1, Konzept §7) über den
 * ganzen Weg, mit echten Migrationen, echtem Keycloak, echter Geräte-CA: Der
 * Dienst holt einen Code, eine fremde Zertifikatsanfrage kommt dazwischen, die
 * Box löst mit ihrem Geräteschlüssel ein, danach gilt nur noch ihr Schlüssel -
 * bis zum ausgestellten Zertifikat nach der Kopplung.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class WerkstattEinloesenApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";
    /** Erfundene Kennungen mit gültigem Prüfzeichen (edge-ref-vectors.json). */
    private static final String BOX = "edge-k7m2xq3";
    private static final String BOX2 = "edge-mnpqrsb";
    private static final String BOX3 = "edge-zz9988g";
    private static final UUID TECHNIKER = UUID.fromString("7e57ab1e-0000-4000-8000-00000000c0de");
    private static final String FASSUNG = "edge-light-2026.11.0";
    private static final String SHA = "0123456789abcdef".repeat(4);
    private static final String DIENST = "/api/v1/werkstatt-dienst";
    private static final String EINLOESEN = "/api/v1/werkstatt/einloesen";

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

    static final Path PKI_DIR = pki();

    private static Path pki() {
        try {
            Path dir = Files.createTempDirectory("voltpilot-werkstatt-einloesen");
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

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Autowired
    @Qualifier("adminJdbcTemplate")
    JdbcTemplate adminJdbc;

    private final ObjectMapper json = new ObjectMapper();

    /** Die neu aufgespielte BOX2 aus {@link #tauschUndObergrenze}; ihre Einlösung ist die letzte. */
    private static Box box2Neu;

    /** Eine Box: Geräteschlüssel, ihre Zertifikatsanfrage, Tunnel- und Host-Schlüssel. */
    private record Box(String ref, KeyPair key, String csr, String wg, String host) {
        static Box neu(String ref) throws Exception {
            KeyPair k = TestPki.ecKeyPair("secp256r1");
            byte[] roh = new byte[32];
            new SecureRandom().nextBytes(roh);
            byte[] host = MessageDigest.getInstance("SHA-256").digest(roh);
            new SecureRandom().nextBytes(roh);
            return new Box(ref, k, TestPki.csrPem(k, "CN=" + ref), Base64.getEncoder().encodeToString(roh),
                    "SHA256:" + Base64.getEncoder().withoutPadding().encodeToString(host));
        }

        String spki() {
            return Base64.getEncoder().encodeToString(key.getPublic().getEncoded());
        }
    }

    private static Map<String, Object> freigabe(int obergrenze) {
        Map<String, Object> a = new HashMap<>();
        a.put("tage", 7);
        a.put("obergrenze", obergrenze);
        a.put("openwrt", Map.of("fassung", "25.12.5",
                "datei", "openwrt-25.12.5-ramips-mt76x8-glinet_gl-mt300n-v2-squashfs-sysupgrade.bin",
                "sha256", SHA, "quelle", "https://downloads.openwrt.org/releases/25.12.5/targets/ramips/mt76x8/"));
        a.put("edgeLight", Map.of("fassung", FASSUNG, "quelle", "https://git.tecmaxx.de/x/", "programmSha256", SHA,
                "skripteSha256", SHA));
        return a;
    }

    @Test
    @Order(1)
    void vomCodeBisZumZertifikat() throws Exception {
        adminJdbc.update("INSERT INTO fernwartung_zugang (id, art, name, public_key, tunnel_adresse, angelegt_von, "
                + "geaendert_von) VALUES (?, 'techniker', 'Werkstatt-Dienst', ?, '10.10.32.50/32', 'test', 'test')",
                TECHNIKER, Box.neu("x").wg());
        String admin = token("admin", "admin");
        String dienst = dienstToken();

        // Ohne Freigabe: kein Code.
        ResponseEntity<String> ohne = send(HttpMethod.POST, DIENST + "/codes", dienst, Map.of("edgeRef", BOX));
        assertThat(ohne.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(ohne)).contains("nicht freigegeben");
        assertThat(send(HttpMethod.POST, "/api/v1/admin/werkstatt/freigaben", admin, freigabe(2)).getStatusCode())
                .isEqualTo(HttpStatus.CREATED);

        Box box = Box.neu(BOX);
        // Die Box schickt beim ersten Start ihre Zertifikatsanfrage; eine fremde kommt dazwischen.
        assertThat(postCsr(BOX, box.csr()).getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        KeyPair fremd = TestPki.ecKeyPair("secp256r1");
        assertThat(postCsr(BOX, TestPki.csrPem(fremd, "CN=" + BOX)).getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);

        // Ungültige Kennungen bekommen keinen Code.
        assertThat(send(HttpMethod.POST, DIENST + "/codes", dienst, Map.of("edgeRef", "edge-k7m2xqz"))
                .getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        JsonNode c1 = code(dienst, BOX, false);
        JsonNode c2 = code(dienst, BOX, false);
        assertThat(c2.get("code").asText()).matches("^wk-[a-z2-7]{26}$").isNotEqualTo(c1.get("code").asText());
        Instant bis = Instant.parse(c2.get("gueltigBis").asText());
        assertThat(Duration.between(Instant.now(), bis)).isBetween(Duration.ofMinutes(29), Duration.ofMinutes(31));
        // Die Box steht jetzt im Werkstatt-Register; der Code steht nirgends im Klartext.
        assertThat(send(HttpMethod.GET, "/api/v1/admin/werkstatt/boxen/" + BOX, admin, null).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(adminJdbc.queryForObject("SELECT count(*) FROM werkstatt_code WHERE code_sha256 = ?", Long.class,
                EinloesenVertrag.sha256Hex(c2.get("code").asText()))).isEqualTo(1L);
        assertThat(adminJdbc.queryForObject("SELECT count(*) FROM werkstatt_code WHERE row_to_json(werkstatt_code)::text"
                + " LIKE ?", Long.class, "%" + c2.get("code").asText() + "%")).isZero();

        // Jeder Code, der nicht gilt, und jede falsche Signatur: dieselbe Antwort.
        String code = c2.get("code").asText();
        ResponseEntity<String> ersetzt = einloesen(box, c1.get("code").asText(), FASSUNG, box.key());
        ResponseEntity<String> unbekannt = einloesen(box, "wk-" + "a".repeat(26), FASSUNG, box.key());
        ResponseEntity<String> falscheSignatur = einloesen(box, code, FASSUNG, fremd);
        ResponseEntity<String> andereBox = einloesen(Box.neu(BOX2), code, FASSUNG, null);
        for (ResponseEntity<String> r : List.of(ersetzt, unbekannt, falscheSignatur, andereBox)) {
            assertThat(r.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
            assertThat(r.getBody()).isEqualTo(ersetzt.getBody());
        }
        assertThat(message(ersetzt)).isEqualTo("Der Code gilt nicht.");
        // Fassung anders als die Freigabe: 409, der Code bleibt offen.
        ResponseEntity<String> alteFassung = einloesen(box, code, "edge-light-2026.10.4", box.key());
        assertThat(alteFassung.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(alteFassung)).contains(FASSUNG);

        ResponseEntity<String> ok = einloesen(box, code, FASSUNG, box.key());
        assertThat(ok.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(ok.getHeaders().getCacheControl()).contains("no-store");
        JsonNode e = json.readTree(ok.getBody());
        assertThat(e.get("schema").asText()).isEqualTo("vp-werkstatt-einloesung.v1");
        assertThat(e.get("edgeRef").asText()).isEqualTo(BOX);
        assertThat(e.get("tunnelErgebnis").asText()).isEqualTo("angelegt");
        assertThat(e.get("tunnel").get("adresse").asText()).startsWith("10.10.");
        assertThat(e.get("tunnel").get("serverPublicKey").asText()).isEqualTo("LnLMuBG+dDEeaEKlQrdTlPifX2fk0hOaB/NFc/BudjE=");
        assertThat(e.get("probe").get("technikerId").asText()).isEqualTo(TECHNIKER.toString());
        Instant beginn = Instant.parse(e.get("probe").get("beginn").asText());
        Instant ende = Instant.parse(e.get("probe").get("ende").asText());
        assertThat(Duration.between(beginn, ende)).isEqualTo(Duration.ofMinutes(30));
        assertThat(e.get("geraeteSchluessel").get("sha256").asText())
                .isEqualTo(EinloesenVertrag.sha256Hex(box.key().getPublic().getEncoded()));
        String fensterId = e.get("probe").get("fensterId").asText();

        // Ein zweites Einlösen: 409.
        assertThat(einloesen(box, code, FASSUNG, box.key()).getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        // Das Fernwartungsprotokoll nennt die Werkstatt als Urheber.
        assertThat(adminJdbc.queryForList("SELECT row_to_json(p)::text FROM fernwartung_protokoll p", String.class))
                .anyMatch(z -> z.contains("box_schluessel_hinterlegt") && z.contains("Werkstatt, Freigabe"))
                .anyMatch(z -> z.contains("fenster_geoeffnet") && z.contains("Werkstatt, Freigabe"));

        // D2: Eine fremde Zertifikatsanfrage gibt jetzt 409 schluessel_festgehalten, die eigene geht.
        ResponseEntity<String> fremdNachher = postCsr(BOX, TestPki.csrPem(fremd, "CN=" + BOX));
        assertThat(fremdNachher.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(json.readTree(fremdNachher.getBody()).get("code").asText()).isEqualTo("schluessel_festgehalten");
        assertThat(postCsr(BOX, box.csr()).getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);

        // Stünde trotzdem eine fremde Anfrage in der Tabelle: kein Zertifikat für sie.
        JdbcTemplate eigentuemer = eigentuemer();
        eigentuemer.update("UPDATE device_enrollment SET csr_pem = ? WHERE external_ref = ?",
                TestPki.csrPem(fremd, "CN=" + BOX), BOX);
        ResponseEntity<String> claim = send(HttpMethod.POST, "/api/v1/devices/claim", token("demo", "demo"),
                Map.of("siteId", BERLIN_SITE, "externalRef", BOX));
        assertThat(claim.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(getCertificate(BOX).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        // Die Box schickt ihre eigene wieder: jetzt kommt ihr Zertifikat, für ihren Schlüssel.
        assertThat(postCsr(BOX, box.csr()).getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        ResponseEntity<String> cert = getCertificate(BOX);
        assertThat(cert.getStatusCode()).isEqualTo(HttpStatus.OK);
        X509Certificate x = TestPki.parseCertificate(json.readTree(cert.getBody()).get("deviceCertPem").asText());
        assertThat(x.getPublicKey()).isEqualTo(box.key().getPublic());

        // Gekoppelt: kein Code mehr.
        ResponseEntity<String> gekoppelt = send(HttpMethod.POST, DIENST + "/codes", dienst, Map.of("edgeRef", BOX));
        assertThat(gekoppelt.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(gekoppelt)).contains("gekoppelt");

        // Der Dienst liest, was die Box gemeldet hat, und schließt das Probe-Fenster - nur dieses.
        JsonNode stand = json.readTree(send(HttpMethod.GET, DIENST + "/einloesungen/" + BOX, dienst, null).getBody());
        assertThat(stand.get("festgehalten").get("sha256").asText())
                .isEqualTo(e.get("geraeteSchluessel").get("sha256").asText());
        assertThat(stand.get("einloesungen")).hasSize(1);
        assertThat(stand.get("einloesungen").get(0).get("hostSchluessel").asText()).isEqualTo(box.host());
        // Gekoppelt, nicht abgenommen: der Dienst ließe sie nie zurücksetzen.
        assertThat(stand.get("gekoppelt").asBoolean()).isTrue();
        assertThat(stand.get("abgenommen").asBoolean()).isFalse();
        assertThat(stand.get("einloesungen").get(0).get("fensterId").asText()).isEqualTo(fensterId);
        assertThat(send(HttpMethod.POST, DIENST + "/fenster/" + UUID.randomUUID() + "/schliessen", dienst, null)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        ResponseEntity<String> zu = send(HttpMethod.POST, DIENST + "/fenster/" + fensterId + "/schliessen", dienst, null);
        assertThat(zu.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(json.readTree(zu.getBody()).get("geschlossenAm").isNull()).isFalse();
        assertThat(send(HttpMethod.POST, DIENST + "/fenster/" + fensterId + "/schliessen", dienst, null)
                .getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
    }

    @Test
    @Order(2)
    void tauschUndObergrenze() throws Exception {
        String dienst = dienstToken();
        Box erst = Box.neu(BOX2);
        assertThat(einloesen(erst, code(dienst, BOX2, false).get("code").asText(), FASSUNG, erst.key())
                .getStatusCode()).isEqualTo(HttpStatus.OK);
        // Neu aufgespielt: anderer Geräteschlüssel. Ohne Tausch 409 schluessel_festgehalten.
        Box neu = Box.neu(BOX2);
        box2Neu = neu;
        ResponseEntity<String> ohneTausch = einloesen(neu, code(dienst, BOX2, false).get("code").asText(), FASSUNG,
                neu.key());
        assertThat(ohneTausch.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(json.readTree(ohneTausch.getBody()).get("code").asText()).isEqualTo("schluessel_festgehalten");
        // Mit einem Code für den Tausch: neuer Schlüssel festgehalten, Tunnel-Schlüssel getauscht.
        ResponseEntity<String> tausch = einloesen(neu, code(dienst, BOX2, true).get("code").asText(), FASSUNG,
                neu.key());
        assertThat(tausch.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(json.readTree(tausch.getBody()).get("tunnelErgebnis").asText()).isEqualTo("getauscht");
        assertThat(adminJdbc.queryForObject("SELECT geraete_schluessel FROM werkstatt_geraeteschluessel WHERE edge_ref = ?",
                String.class, BOX2)).isEqualTo(neu.spki());
        assertThat(postCsr(BOX2, erst.csr()).getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

        // Obergrenze 2: BOX und BOX2 haben eingelöst, BOX3 bekommt keinen Code.
        ResponseEntity<String> dritte = send(HttpMethod.POST, DIENST + "/codes", dienst, Map.of("edgeRef", BOX3));
        assertThat(dritte.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(dritte)).contains("Obergrenze");
    }

    @Test
    @Order(3)
    void pruefzeichenAufDemCsrWeg() throws Exception {
        ResponseEntity<String> r = postCsr("edge-k7m2xqz", Box.neu("x").csr());
        assertThat(r.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
    }

    @Test
    @Order(4)
    void nurDerDienstHoltCodes() {
        String kunde = token("demo", "demo");
        String admin = token("admin", "admin");
        String tunnel = serviceToken("voltpilot-tunnel-dienst", "voltpilot-tunnel-dienst-dev-secret");
        for (String t : List.of(kunde, admin, tunnel)) {
            assertThat(send(HttpMethod.POST, DIENST + "/codes", t, Map.of("edgeRef", BOX3)).getStatusCode())
                    .isEqualTo(HttpStatus.FORBIDDEN);
            assertThat(send(HttpMethod.GET, DIENST + "/einloesungen/" + BOX, t, null).getStatusCode())
                    .isEqualTo(HttpStatus.FORBIDDEN);
            assertThat(send(HttpMethod.POST, DIENST + "/fenster/" + UUID.randomUUID() + "/schliessen", t, null)
                    .getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        }
        assertThat(send(HttpMethod.POST, DIENST + "/codes", null, Map.of("edgeRef", BOX3)).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        // Einlösen ist offen: ohne Token, ohne Inhalt eine Formantwort, kein 401.
        assertThat(send(HttpMethod.POST, EINLOESEN, null, Map.of()).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    @Test
    @Order(5)
    void ohneFreigabeGiltKeinCode() throws Exception {
        String dienst = dienstToken();
        String admin = token("admin", "admin");
        Box box = Box.neu(BOX3);
        // BOX3 liegt über der Obergrenze; eine neue Freigabe nach dem Ende der alten erlaubt sie.
        JsonNode liste = json.readTree(send(HttpMethod.GET, "/api/v1/admin/werkstatt/freigaben", admin, null).getBody());
        String kennung = liste.get(0).get("kennung").asText();
        send(HttpMethod.POST, "/api/v1/admin/werkstatt/freigaben/" + kennung + "/ende", admin, null);
        assertThat(send(HttpMethod.POST, "/api/v1/admin/werkstatt/freigaben", admin, freigabe(5)).getStatusCode())
                .isEqualTo(HttpStatus.CREATED);
        String code = code(dienst, BOX3, false).get("code").asText();
        liste = json.readTree(send(HttpMethod.GET, "/api/v1/admin/werkstatt/freigaben", admin, null).getBody());
        send(HttpMethod.POST, "/api/v1/admin/werkstatt/freigaben/" + liste.get(0).get("kennung").asText() + "/ende",
                admin, null);
        ResponseEntity<String> r = einloesen(box, code, FASSUNG, box.key());
        assertThat(r.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(message(r)).isEqualTo("Der Code gilt nicht.");
    }

    @Test
    @Order(6)
    void tabellen() {
        JdbcTemplate app = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), APP_USER, APP_PW));
        for (String t : List.of("werkstatt_code", "werkstatt_einloesung", "werkstatt_geraeteschluessel")) {
            assertThatThrownBy(() -> app.queryForObject("SELECT count(*) FROM " + t, Long.class)).as(t)
                    .rootCause().hasMessageContaining("permission denied");
        }
        assertThatThrownBy(() -> adminJdbc.update("DELETE FROM werkstatt_einloesung")).rootCause()
                .hasMessageContaining("permission denied");
        assertThatThrownBy(() -> eigentuemer().update("UPDATE werkstatt_einloesung SET fassung = 'x'")).rootCause()
                .hasMessageContaining("weder geändert noch gelöscht");
    }

    @Test
    @Order(7)
    void abnahmeMitBelegen() throws Exception {
        String dienst = dienstToken();
        String admin = token("admin", "admin");
        Box box = box2Neu;
        JsonNode stand = json.readTree(send(HttpMethod.GET, DIENST + "/einloesungen/" + BOX2, dienst, null).getBody());
        String fensterId = stand.get("einloesungen").get(0).get("fensterId").asText();
        String abnahme = DIENST + "/abnahmen/" + BOX2;
        assertThat(stand.get("abgenommen").asBoolean()).isFalse();
        assertThat(stand.get("gekoppelt").asBoolean()).isFalse();

        // Probe-Fenster noch offen: 409 (Werkstatt-Regel 6).
        ResponseEntity<String> offen = send(HttpMethod.POST, abnahme, dienst, abnahmeAntrag(box, Map.of()));
        assertThat(offen.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(offen)).contains("noch offen");
        assertThat(send(HttpMethod.POST, DIENST + "/fenster/" + fensterId + "/schliessen", dienst, null)
                .getStatusCode()).isEqualTo(HttpStatus.OK);

        record Fall(String name, Map<String, Object> aenderung, HttpStatus status, String grund) {
        }
        Map<String, String> ohneNeustart = new HashMap<>(belege());
        ohneNeustart.remove("neustart");
        Map<String, String> mitFremder = new HashMap<>(belege());
        mitFremder.put("kaffee", "gekocht");
        for (Fall f : List.of(
                new Fall("Beleg fehlt", Map.of("belege", ohneNeustart), HttpStatus.UNPROCESSABLE_ENTITY, "neustart"),
                new Fall("unbekannte Prüfung", Map.of("belege", mitFremder), HttpStatus.BAD_REQUEST, "kaffee"),
                new Fall("Passwort im Klartext", Map.of("passwortAge", "geheim123"), HttpStatus.UNPROCESSABLE_ENTITY, "age"),
                new Fall("Hülle ohne age-Kopf", Map.of("passwortAge", "-----BEGIN AGE ENCRYPTED FILE-----\n"
                        + Base64.getEncoder().encodeToString("geheim123".getBytes(StandardCharsets.UTF_8))
                        + "\n-----END AGE ENCRYPTED FILE-----"), HttpStatus.UNPROCESSABLE_ENTITY, "age-Kopf"),
                new Fall("anderer Host-Schlüssel", Map.of("hostSchluessel", Box.neu(BOX2).host()), HttpStatus.CONFLICT,
                        "Einlösen"),
                new Fall("andere Fassung", Map.of("fassung", "edge-light-2026.11.9"), HttpStatus.CONFLICT, "Einlösen"),
                new Fall("Heimnetz", Map.of("lanNetz", "192.168.1.1/24"), HttpStatus.UNPROCESSABLE_ENTITY, "übliches"))) {
            ResponseEntity<String> r = send(HttpMethod.POST, abnahme, dienst, abnahmeAntrag(box, f.aenderung()));
            assertThat(r.getStatusCode()).as(f.name()).isEqualTo(f.status());
            assertThat(message(r)).as(f.name()).contains(f.grund());
        }
        // Eine Box ohne Einlösung bekommt keine Abnahme des Dienstes.
        ResponseEntity<String> ohne = send(HttpMethod.POST, DIENST + "/abnahmen/" + BOX3, dienst, abnahmeAntrag(box, Map.of()));
        assertThat(ohne.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        // Nur der Dienst: Admin und Kunde 403.
        for (String t : List.of(admin, token("demo", "demo"))) {
            assertThat(send(HttpMethod.POST, abnahme, t, abnahmeAntrag(box, Map.of())).getStatusCode())
                    .isEqualTo(HttpStatus.FORBIDDEN);
        }

        ResponseEntity<String> ok = send(HttpMethod.POST, abnahme, dienst, abnahmeAntrag(box, Map.of()));
        assertThat(ok.getStatusCode()).as(ok.getBody()).isEqualTo(HttpStatus.CREATED);
        JsonNode a = json.readTree(ok.getBody());
        assertThat(a.get("lanNetz").asText()).isEqualTo("10.213.0.1/24");
        assertThat(a.has("passwortAge")).isFalse();
        assertThat(a.get("einloesungId").asText()).isEqualTo(stand.get("einloesungen").get(0).get("id").asText());
        JsonNode danach = json.readTree(send(HttpMethod.GET, DIENST + "/einloesungen/" + BOX2, dienst, null).getBody());
        assertThat(danach.get("abgenommen").asBoolean()).isTrue();
        assertThat(danach.get("gekoppelt").asBoolean()).isFalse();

        // Im Register: Quelle dienst, jede Prüfung mit ihrem Beleg, Freigabe, Einlösung, verschlüsseltes Passwort.
        JsonNode reg = json.readTree(send(HttpMethod.GET, "/api/v1/admin/werkstatt/boxen/" + BOX2, admin, null).getBody());
        assertThat(reg.get("lanNetz").asText()).isEqualTo("10.213.0.1/24");
        JsonNode erste = reg.get("abnahmen").get(0);
        assertThat(erste.get("quelle").asText()).isEqualTo("dienst");
        assertThat(erste.get("belege").get("anmeldeprobe").asText()).isEqualTo(belege().get("anmeldeprobe"));
        assertThat(erste.get("belege").size()).isEqualTo(9);
        assertThat(erste.get("passwortAge").asText()).isEqualTo(ageText());
        assertThat(erste.get("probe").get("fensterId").asText()).isEqualTo(fensterId);
        assertThat(erste.get("hostSchluessel").asText()).isEqualTo(box.host());
        // Die Tabelle bleibt append-only, und eine Abnahme von Hand trägt nichts davon.
        assertThatThrownBy(() -> eigentuemer().update(
                "INSERT INTO werkstatt_abnahme (box_id, edge_ref, host_schluessel, fassung, tunnel_adresse, lan_netz, "
                        + "pruefungen, probe, erfasst_von, quelle) SELECT box_id, edge_ref, host_schluessel, fassung, "
                        + "tunnel_adresse, lan_netz, pruefungen, probe, 'x', 'dienst' FROM werkstatt_abnahme LIMIT 1"))
                .rootCause().hasMessageContaining("werkstatt_abnahme_dienst_chk");
    }

    private static Map<String, String> belege() {
        Map<String, String> b = new java.util.LinkedHashMap<>();
        for (String p : List.of("root_passwort", "notfall_schluessel", "tunnel_status", "anmeldeprobe",
                "host_schluessel", "fenster_zu", "lan_netz", "neustart", "update_bereit")) {
            b.put(p, "Schritt " + p + ": belegt im Test");
        }
        return b;
    }

    /** Eine age-Hülle mit echtem Kopf (der Rumpf ist für den Test erfunden). */
    private static String ageText() {
        String roh = "age-encryption.org/v1\n-> X25519 testtesttesttesttesttesttesttesttesttesttes\n--- abc\n";
        return "-----BEGIN AGE ENCRYPTED FILE-----\n"
                + Base64.getMimeEncoder(64, "\n".getBytes(StandardCharsets.US_ASCII))
                        .encodeToString(roh.getBytes(StandardCharsets.US_ASCII))
                + "\n-----END AGE ENCRYPTED FILE-----";
    }

    private static Map<String, Object> abnahmeAntrag(Box box, Map<String, Object> aenderung) {
        Map<String, Object> a = new HashMap<>();
        a.put("fassung", FASSUNG);
        a.put("hostSchluessel", box.host());
        a.put("lanNetz", "10.213.0.1/24");
        a.put("belege", belege());
        a.put("passwortAge", ageText());
        a.putAll(aenderung);
        return a;
    }

    // ── Hilfen ────────────────────────────────────────────────────────────

    private JdbcTemplate eigentuemer() {
        return new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    private JsonNode code(String dienst, String ref, boolean tausch) throws Exception {
        ResponseEntity<String> r = send(HttpMethod.POST, DIENST + "/codes", dienst,
                Map.of("edgeRef", ref, "tausch", tausch));
        assertThat(r.getStatusCode()).as(r.getBody()).isEqualTo(HttpStatus.CREATED);
        return json.readTree(r.getBody());
    }

    /** Löst ein; {@code signierer} null heißt: mit dem Schlüssel der Box. */
    private ResponseEntity<String> einloesen(Box box, String code, String fassung, KeyPair signierer) throws Exception {
        EinloesenVertrag.Anfrage ohne = new EinloesenVertrag.Anfrage(box.ref(), code, fassung, box.spki(), box.wg(),
                box.host(), box.csr(), "AA==");
        Signature s = Signature.getInstance("SHA256withECDSA");
        s.initSign((signierer == null ? box.key() : signierer).getPrivate());
        s.update(EinloesenVertrag.kanonisch(ohne).getBytes(StandardCharsets.UTF_8));
        Map<String, Object> body = new HashMap<>();
        body.put("edgeRef", box.ref());
        body.put("code", code);
        body.put("fassung", fassung);
        body.put("geraeteSchluessel", box.spki());
        body.put("wireguardSchluessel", box.wg());
        body.put("hostSchluessel", box.host());
        body.put("csrPem", box.csr());
        body.put("signatur", Base64.getEncoder().encodeToString(s.sign()));
        return send(HttpMethod.POST, EINLOESEN, null, body);
    }

    private ResponseEntity<String> postCsr(String ref, String csrPem) {
        return send(HttpMethod.POST, "/api/v1/enrollment/" + ref + "/csr", null, Map.of("csrPem", csrPem));
    }

    private ResponseEntity<String> getCertificate(String ref) {
        return send(HttpMethod.GET, "/api/v1/enrollment/" + ref + "/certificate", null, null);
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

    private String dienstToken() {
        return serviceToken("voltpilot-werkstatt-dienst", "voltpilot-werkstatt-dienst-dev-secret");
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
