package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.enrollment.TestPki;
import com.voltpilot.api.werkstatt.EinloesenVertrag;
import com.voltpilot.api.werkstatt.WerkstattPruefungen;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.Signature;
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
 * Die Werkstatt richtet neben der Mango den WAGO PFC200 (Edge Industrie) ein
 * (PFC200-Konzept Stufe 3, Teilstufe 2b): eigene Regel-Zeile aus der neuesten
 * Edge-Industrie-Fassung, Code für das Gerät, Einlösen, Abnahme mit der
 * Prüfliste des PFC200 und seinen Angaben. Die Mango läuft daneben wie bisher.
 */
@Testcontainers(disabledWithoutDocker = true)
@AutoConfigureTestRestTemplate
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class WerkstattPfc200ApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    /** Erfundene Kennungen mit gültigem Prüfzeichen (edge-ref-vectors.json). */
    private static final String BOX = "edge-k7m2xq3";
    private static final String BOX2 = "edge-mnpqrsb";
    private static final UUID TECHNIKER = UUID.fromString("7e57ab1e-0000-4000-8000-00000000c0de");
    private static final String FASSUNG = "edge-light-2026.11.0";
    private static final String DIENST = "/api/v1/werkstatt-dienst";
    private static final String EINLOESEN = "/api/v1/werkstatt/einloesen";

    @Container
    static final TestDatenbank POSTGRES = new TestDatenbank();

    @Container
    static final TestKeycloak KEYCLOAK = new TestKeycloak();

    static final Path PKI_DIR = pki();

    private static Path pki() {
        try {
            Path dir = Files.createTempDirectory("voltpilot-werkstatt-pfc200");
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
        registry.add("voltpilot.werkstatt.tagesgrenze", () -> "5");
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Autowired
    @Qualifier("adminJdbcTemplate")
    JdbcTemplate adminJdbc;

    private final ObjectMapper json = new ObjectMapper();

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

    private static final String INDUSTRIE = "edge-industrie-2026.11.0";
    private static final String PFC_BOX = BOX2;
    private static final String ADMIN = "/api/v1/admin/werkstatt";

    @Test
    @Order(1)
    void freigabeJeGeraet() throws Exception {
        adminJdbc.update("INSERT INTO fernwartung_zugang (id, art, name, public_key, tunnel_adresse, angelegt_von, "
                + "geaendert_von) VALUES (?, 'techniker', 'Werkstatt-Dienst', ?, '10.10.32.50/32', 'test', 'test')",
                TECHNIKER, Box.neu("x").wg());
        String dienst = dienstToken();
        String admin = token("admin", "admin");
        WerkstattTestFassung.anlegen(adminJdbc, FASSUNG, 900_001);

        // Ohne Edge-Industrie-Fassung: keine Freigabe für den PFC200, mit Grund. Die Mango läuft.
        ResponseEntity<String> ohne = send(HttpMethod.GET, DIENST + "/freigabe?boxArt=pfc200", dienst, null);
        assertThat(ohne.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(message(ohne)).contains("keine signierte Edge-Industrie-Fassung");
        assertThat(send(HttpMethod.GET, DIENST + "/freigabe", dienst, null).getStatusCode()).isEqualTo(HttpStatus.OK);
        ResponseEntity<String> keinCode = send(HttpMethod.POST, DIENST + "/codes", dienst,
                Map.of("edgeRef", PFC_BOX, "boxArt", "pfc200"));
        assertThat(keinCode.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(keinCode)).contains("Edge-Industrie-Fassung");
        // Ein unbekanntes Gerät: 404 an der Freigabe, 400 am Code. Nichts davon legt die Box an.
        assertThat(send(HttpMethod.GET, DIENST + "/freigabe?boxArt=pi", dienst, null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(send(HttpMethod.POST, DIENST + "/codes", dienst, Map.of("edgeRef", PFC_BOX, "boxArt", "pi"))
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(adminJdbc.queryForObject("SELECT count(*) FROM werkstatt_box WHERE edge_ref = ?", Integer.class,
                PFC_BOX)).isZero();

        // Eine Fassung ohne Skriptstand und Tunnel-Programm im Manifest: Die Werkstatt wartet für dieses Gerät.
        WerkstattTestFassung.anlegenIndustrie(adminJdbc, "edge-industrie-2026.10.9", 900_010, false);
        ResponseEntity<String> alt = send(HttpMethod.GET, DIENST + "/freigabe?boxArt=pfc200", dienst, null);
        assertThat(alt.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(message(alt)).contains("Skriptstand und Tunnel-Programm");
        assertThat(adminJdbc.queryForObject("SELECT count(*) FROM werkstatt_freigabe WHERE box_art = 'pfc200'",
                Integer.class)).isZero();

        WerkstattTestFassung.anlegenIndustrie(adminJdbc, INDUSTRIE, 900_011, true);
        ResponseEntity<String> r = send(HttpMethod.GET, DIENST + "/freigabe?boxArt=pfc200", dienst, null);
        assertThat(r.getStatusCode()).as(r.getBody()).isEqualTo(HttpStatus.OK);
        JsonNode f = json.readTree(r.getBody());
        assertThat(f.get("schema").asText()).isEqualTo("vp-werkstatt-freigabe.v1");
        assertThat(f.get("box_art").asText()).isEqualTo("pfc200");
        assertThat(f.get("kennung").asText()).matches("^[0-9]{4}-[0-9]{2}-pfc200-1$");
        // Kein OpenWrt, kein Edge Light: Der Dienst liest die Freigabe streng.
        assertThat(f.has("openwrt")).isFalse();
        assertThat(f.has("edge_light")).isFalse();
        JsonNode e = f.get("edge_industrie");
        assertThat(e.get("fassung").asText()).isEqualTo(INDUSTRIE);
        assertThat(e.get("quelle").asText()).startsWith("https://").contains(INDUSTRIE);
        assertThat(e.get("programm_sha256").asText()).isEqualTo(WerkstattTestFassung.INDUSTRIE_PROGRAMM_SHA);
        assertThat(e.get("skripte_sha256").asText()).isEqualTo(WerkstattTestFassung.INDUSTRIE_SKRIPTE_SHA);
        assertThat(e.get("wartung_sha256").asText()).isEqualTo(WerkstattTestFassung.INDUSTRIE_WARTUNG_SHA);
        // Dieselbe Zeile beim zweiten Mal.
        assertThat(json.readTree(send(HttpMethod.GET, DIENST + "/freigabe?boxArt=pfc200", dienst, null).getBody())
                .get("kennung").asText()).isEqualTo(f.get("kennung").asText());

        // Die Mango bekommt weiter ihre eigene Zeile, mit OpenWrt und Edge Light und ohne Tunnel-Programm.
        JsonNode m = json.readTree(send(HttpMethod.GET, DIENST + "/freigabe", dienst, null).getBody());
        assertThat(m.get("box_art").asText()).isEqualTo("mango");
        assertThat(m.get("kennung").asText()).contains("-mango-");
        assertThat(m.get("openwrt").get("fassung").asText()).isNotBlank();
        assertThat(m.get("edge_light").get("fassung").asText()).isEqualTo(FASSUNG);
        assertThat(m.get("edge_light").has("wartung_sha256")).isFalse();
        assertThat(m.has("edge_industrie")).isFalse();

        // Verwaltung: die Regel je Gerät; ohne Gerät bleibt alles bei der Mango, wie das Portal es heute liest.
        JsonNode regel = json.readTree(send(HttpMethod.GET, ADMIN + "/regel?geraet=pfc200", admin, null).getBody());
        assertThat(regel.get("zustand").asText()).isEqualTo("laeuft");
        assertThat(regel.get("neueste").asText()).isEqualTo(INDUSTRIE);
        assertThat(regel.get("openwrt").isNull()).isTrue();
        assertThat(regel.get("edgeLight").get("fassung").asText()).isEqualTo(INDUSTRIE);
        assertThat(regel.get("edgeLight").get("wartungSha256").asText())
                .isEqualTo(WerkstattTestFassung.INDUSTRIE_WARTUNG_SHA);
        assertThat(regel.get("freigabe").asText()).isEqualTo(f.get("kennung").asText());
        JsonNode regelMango = json.readTree(send(HttpMethod.GET, ADMIN + "/regel", admin, null).getBody());
        assertThat(regelMango.get("neueste").asText()).isEqualTo(FASSUNG);
        assertThat(regelMango.get("openwrt").get("fassung").asText()).isNotBlank();
        assertThat(regelMango.get("edgeLight").has("wartungSha256")).isFalse();
        assertThat(send(HttpMethod.GET, ADMIN + "/regel?geraet=pi", admin, null).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
        JsonNode liste = json.readTree(send(HttpMethod.GET, ADMIN + "/freigaben", admin, null).getBody());
        assertThat(liste).isNotEmpty().allSatisfy(z -> {
            assertThat(z.get("boxArt").asText()).isEqualTo("mango");
            assertThat(z.get("openwrt").get("fassung").asText()).isNotBlank();
        });
        JsonNode listePfc = json.readTree(send(HttpMethod.GET, ADMIN + "/freigaben?geraet=pfc200", admin, null).getBody());
        assertThat(listePfc).hasSize(1);
        assertThat(listePfc.get(0).get("boxArt").asText()).isEqualTo("pfc200");
        assertThat(listePfc.get(0).get("openwrt").isNull()).isTrue();
        assertThat(listePfc.get(0).get("edgeLight").get("fassung").asText()).isEqualTo(INDUSTRIE);
    }

    @Test
    @Order(2)
    void vomCodeBisZurAbnahme() throws Exception {
        String dienst = dienstToken();
        String admin = token("admin", "admin");
        Box pfc = Box.neu(PFC_BOX);
        ResponseEntity<String> cr = send(HttpMethod.POST, DIENST + "/codes", dienst,
                Map.of("edgeRef", PFC_BOX, "tausch", false, "boxArt", "pfc200"));
        assertThat(cr.getStatusCode()).as(cr.getBody()).isEqualTo(HttpStatus.CREATED);
        JsonNode c = json.readTree(cr.getBody());
        assertThat(c.get("freigabe").asText()).contains("-pfc200-");
        // Im Register steht sie als Edge Industrie.
        JsonNode reg = json.readTree(send(HttpMethod.GET, ADMIN + "/boxen/" + PFC_BOX, admin, null).getBody());
        assertThat(reg.get("boxArt").asText()).isEqualTo("edge-industrie");
        // Dieselbe Box als Mango: kein Code.
        ResponseEntity<String> alsMango = send(HttpMethod.POST, DIENST + "/codes", dienst, Map.of("edgeRef", PFC_BOX));
        assertThat(alsMango.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(alsMango)).contains("edge-industrie");

        // Die Box meldet die Fassung der Mango, für die eine eigene Zeile läuft: abgelehnt. Mit ihrer eigenen: eingelöst.
        ResponseEntity<String> falsch = einloesen(pfc, c.get("code").asText(), FASSUNG, pfc.key());
        assertThat(falsch.getStatusCode()).as(falsch.getBody()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(message(falsch)).contains("meldet die Fassung " + FASSUNG).contains("-pfc200-");
        ResponseEntity<String> ok = einloesen(pfc, c.get("code").asText(), INDUSTRIE, pfc.key());
        assertThat(ok.getStatusCode()).as(ok.getBody()).isEqualTo(HttpStatus.OK);
        assertThat(adminJdbc.queryForObject("SELECT f.box_art FROM werkstatt_einloesung e JOIN werkstatt_freigabe f "
                + "ON f.id = e.freigabe_id WHERE e.edge_ref = ?", String.class, PFC_BOX)).isEqualTo("pfc200");
        JsonNode stand = json.readTree(send(HttpMethod.GET, DIENST + "/einloesungen/" + PFC_BOX, dienst, null).getBody());
        String fensterId = stand.get("einloesungen").get(0).get("fensterId").asText();
        assertThat(send(HttpMethod.POST, DIENST + "/fenster/" + fensterId + "/schliessen", dienst, null)
                .getStatusCode()).isEqualTo(HttpStatus.OK);

        String abnahme = DIENST + "/abnahmen/" + PFC_BOX;
        record Fall(String name, Map<String, Object> aenderung, HttpStatus status, String grund) {
        }
        Map<String, String> ohneNetze = new HashMap<>(belege(WerkstattPruefungen.PFC200));
        ohneNetze.remove("netze");
        Map<String, String> mitMango = new HashMap<>(belege(WerkstattPruefungen.PFC200));
        mitMango.put("root_passwort", "gesetzt");
        for (Fall f : List.of(
                new Fall("Beleg fehlt", Map.of("belege", ohneNetze), HttpStatus.UNPROCESSABLE_CONTENT, "netze"),
                // Eine Prüfung der Mango gibt es in der Liste des PFC200 nicht, auch nicht das Einrichtungs-WLAN.
                new Fall("Prüfung der Mango", Map.of("belege", mitMango), HttpStatus.BAD_REQUEST, "root_passwort"),
                new Fall("die Liste der Mango", Map.of("belege", belege(WerkstattPruefungen.ALLE)),
                        HttpStatus.BAD_REQUEST, "einrichtung_wlan_bereit"),
                new Fall("anderes Gerät genannt", Map.of("geraet", "mango"), HttpStatus.CONFLICT, "edge-industrie"),
                new Fall("Angabe zu lang", Map.of("angaben", Map.of("firmware", "x".repeat(201))),
                        HttpStatus.UNPROCESSABLE_CONTENT, "firmware"),
                new Fall("Angabe mit Schlüssel", Map.of("angaben", Map.of("firmware",
                        "-----BEGIN OPENSSH PRIVATE KEY-----")), HttpStatus.UNPROCESSABLE_CONTENT, "Schlüsselmaterial"),
                new Fall("Angabe ohne einfachen Namen", Map.of("angaben", Map.of("Firm Ware", "03.10.08")),
                        HttpStatus.UNPROCESSABLE_CONTENT, "einfachen Namen"),
                new Fall("andere Fassung", Map.of("fassung", FASSUNG), HttpStatus.CONFLICT, "Einlösen"))) {
            ResponseEntity<String> r = send(HttpMethod.POST, abnahme, dienst, abnahmeAntrag(pfc, f.aenderung()));
            assertThat(r.getStatusCode()).as(f.name() + ": " + r.getBody()).isEqualTo(f.status());
            assertThat(message(r)).as(f.name()).contains(f.grund());
        }
        // Von Hand (mit der Prüfliste der Mango) gibt es die Abnahme eines PFC200 nicht.
        ResponseEntity<String> vonHand = send(HttpMethod.POST, ADMIN + "/boxen/" + PFC_BOX + "/abnahme", admin,
                Map.of("hostSchluessel", pfc.host(), "fassung", INDUSTRIE, "pruefungen", WerkstattPruefungen.ALLE,
                        "probeFensterId", fensterId));
        assertThat(vonHand.getStatusCode()).as(vonHand.getBody()).isEqualTo(HttpStatus.UNPROCESSABLE_CONTENT);
        assertThat(message(vonHand)).contains("nur der Werkstatt-Dienst");
        assertThat(adminJdbc.queryForObject("SELECT count(*) FROM werkstatt_abnahme WHERE edge_ref = ?", Integer.class,
                PFC_BOX)).isZero();

        ResponseEntity<String> gut = send(HttpMethod.POST, abnahme, dienst, abnahmeAntrag(pfc, Map.of()));
        assertThat(gut.getStatusCode()).as(gut.getBody()).isEqualTo(HttpStatus.CREATED);
        JsonNode a = json.readTree(send(HttpMethod.GET, ADMIN + "/boxen/" + PFC_BOX, admin, null).getBody())
                .get("abnahmen").get(0);
        List<String> pruefungen = new ArrayList<>();
        a.get("pruefungen").forEach(p -> pruefungen.add(p.asText()));
        assertThat(pruefungen).isEqualTo(WerkstattPruefungen.PFC200);
        List<String> belegt = new ArrayList<>();
        a.get("belege").fieldNames().forEachRemaining(belegt::add);
        // jsonb hält keine Reihenfolge; die Reihenfolge der Regel trägt die Liste der Prüfungen.
        assertThat(belegt).containsExactlyInAnyOrderElementsOf(WerkstattPruefungen.PFC200);
        assertThat(a.get("fassung").asText()).isEqualTo(INDUSTRIE);
        assertThat(a.get("quelle").asText()).isEqualTo("dienst");
        // Dem PFC200 fehlt das Einrichtungs-WLAN nicht, er hat es nicht: keine Kennzeichnung „Dienst vor …“.
        assertThat(a.get("dienstFassungVorEinrichtungWlan").asBoolean()).isFalse();
        assertThat(a.get("angaben").get("firmware").asText()).isEqualTo("03.10.08(22)");
        assertThat(a.get("angaben").get("artikel").asText()).isEqualTo("750-8212");
        assertThat(a.get("passwortAge").asText()).startsWith("-----BEGIN AGE ENCRYPTED FILE-----");
        JsonNode danach = json.readTree(send(HttpMethod.GET, DIENST + "/einloesungen/" + PFC_BOX, dienst, null).getBody());
        assertThat(danach.get("abgenommen").asBoolean()).isTrue();
    }

    @Test
    @Order(3)
    void mangoDanebenWieBisher() throws Exception {
        String dienst = dienstToken();
        String admin = token("admin", "admin");
        Box box = Box.neu(BOX);
        JsonNode c = code(dienst, BOX, false);
        assertThat(c.get("freigabe").asText()).contains("-mango-");
        // Eine Mango löst keine Edge-Industrie-Fassung ein, auch wenn dafür eine Zeile läuft.
        ResponseEntity<String> falsch = einloesen(box, c.get("code").asText(), INDUSTRIE, box.key());
        assertThat(falsch.getStatusCode()).as(falsch.getBody()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(einloesen(box, c.get("code").asText(), FASSUNG, box.key()).getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode reg = json.readTree(send(HttpMethod.GET, ADMIN + "/boxen/" + BOX, admin, null).getBody());
        assertThat(reg.get("boxArt").asText()).isEqualTo("edge-light");
        // Als PFC200 bekommt die Mango keinen Code.
        ResponseEntity<String> alsPfc = send(HttpMethod.POST, DIENST + "/codes", dienst,
                Map.of("edgeRef", BOX, "boxArt", "pfc200"));
        assertThat(alsPfc.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

        // Die Abnahme einer Mango nimmt die Liste des PFC200 nicht, und ihre eigene ohne Angaben wie bisher.
        JsonNode stand = json.readTree(send(HttpMethod.GET, DIENST + "/einloesungen/" + BOX, dienst, null).getBody());
        assertThat(send(HttpMethod.POST, DIENST + "/fenster/" + stand.get("einloesungen").get(0).get("fensterId").asText()
                + "/schliessen", dienst, null).getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> antrag = new HashMap<>(abnahmeAntrag(box, Map.of()));
        antrag.put("fassung", FASSUNG);
        antrag.remove("geraet");
        antrag.remove("angaben");
        ResponseEntity<String> fremd = send(HttpMethod.POST, DIENST + "/abnahmen/" + BOX, dienst, antrag);
        assertThat(fremd.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(message(fremd)).contains("zugaenge");
        antrag.put("belege", belege(WerkstattPruefungen.ALLE));
        ResponseEntity<String> gut = send(HttpMethod.POST, DIENST + "/abnahmen/" + BOX, dienst, antrag);
        assertThat(gut.getStatusCode()).as(gut.getBody()).isEqualTo(HttpStatus.CREATED);
        JsonNode a = json.readTree(send(HttpMethod.GET, ADMIN + "/boxen/" + BOX, admin, null).getBody())
                .get("abnahmen").get(0);
        assertThat(a.get("pruefungen")).hasSize(WerkstattPruefungen.ALLE.size());
        assertThat(a.get("dienstFassungVorEinrichtungWlan").asBoolean()).isFalse();
        assertThat(a.has("angaben")).isFalse();

        // Anhalten gilt für die ganze Werkstatt: auch der PFC200 bekommt dann keine Freigabe.
        assertThat(send(HttpMethod.POST, ADMIN + "/anhalten", admin, Map.of("grund", "Test")).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        for (String pfad : List.of("/freigabe", "/freigabe?boxArt=pfc200")) {
            ResponseEntity<String> r = send(HttpMethod.GET, DIENST + pfad, dienst, null);
            assertThat(r.getStatusCode()).as(pfad).isEqualTo(HttpStatus.NOT_FOUND);
            assertThat(message(r)).as(pfad).contains("angehalten");
        }
        assertThat(json.readTree(send(HttpMethod.GET, ADMIN + "/regel?geraet=pfc200", admin, null).getBody())
                .get("zustand").asText()).isEqualTo("angehalten");
        assertThat(send(HttpMethod.POST, ADMIN + "/fortsetzen", admin, null).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(send(HttpMethod.GET, DIENST + "/freigabe?boxArt=pfc200", dienst, null).getStatusCode())
                .isEqualTo(HttpStatus.OK);

        // Die Tagesgrenze zählt beide Geräte zusammen: Zwei Boxen haben heute eingelöst.
        assertThat(json.readTree(send(HttpMethod.GET, ADMIN + "/regel?geraet=pfc200", admin, null).getBody())
                .get("heute").asInt()).isEqualTo(2);
        assertThat(json.readTree(send(HttpMethod.GET, ADMIN + "/regel", admin, null).getBody()).get("heute").asInt())
                .isEqualTo(2);
    }

    /** Die Tabelle hält die Regeln selbst: OpenWrt nur bei der Mango, das Tunnel-Programm nur beim PFC200. */
    @Test
    @Order(4)
    void tabelleHaeltDieRegelnJeGeraet() {
        String spalten = "(kennung, box_art, gueltig_ab, gueltig_bis, obergrenze, openwrt_fassung, openwrt_datei, "
                + "openwrt_sha256, openwrt_quelle, edge_fassung, edge_quelle, edge_programm_sha256, edge_skripte_sha256, "
                + "edge_wartung_sha256, erteilt_von, quelle, edge_release_seq) ";
        String sha = "'" + "0".repeat(64) + "'";
        String zeit = "now(), now() + interval '1 day', 1, ";
        String ow = "'25.12.5', 'openwrt-25.12.5-x-squashfs-sysupgrade.bin', " + sha + ", 'https://downloads.openwrt.org/'";
        String keins = "NULL, NULL, NULL, NULL";
        String industrie = ", 'edge-industrie-2026.11.0', 'https://x/', " + sha + ", " + sha + ", ";
        String light = ", 'edge-light-2026.11.0', 'https://x/', " + sha + ", " + sha + ", ";
        String ende = ", 't', 'regel', 1";
        record Zeile(String name, String werte, String constraint) {
        }
        for (Zeile z : List.of(
                new Zeile("PFC200 mit OpenWrt", "'t-1', 'pfc200', " + zeit + ow + industrie + sha + ende,
                        "werkstatt_freigabe_openwrt_chk"),
                new Zeile("PFC200 ohne Tunnel-Programm", "'t-2', 'pfc200', " + zeit + keins + industrie + "NULL" + ende,
                        "werkstatt_freigabe_edge_chk"),
                new Zeile("PFC200 mit Edge Light", "'t-3', 'pfc200', " + zeit + keins + light + sha + ende,
                        "werkstatt_freigabe_edge_chk"),
                new Zeile("Mango ohne OpenWrt", "'t-4', 'mango', " + zeit + keins + light + "NULL" + ende,
                        "werkstatt_freigabe_openwrt_chk"),
                new Zeile("Mango mit Tunnel-Programm", "'t-5', 'mango', " + zeit + ow + light + sha + ende,
                        "werkstatt_freigabe_edge_chk"),
                new Zeile("Mango mit Edge Industrie", "'t-6', 'mango', " + zeit + ow + industrie + "NULL" + ende,
                        "werkstatt_freigabe_edge_chk"),
                new Zeile("unbekanntes Gerät", "'t-7', 'pi', " + zeit + keins + industrie + sha + ende,
                        "werkstatt_freigabe_box_art_chk"))) {
            assertThatThrownBy(() -> eigentuemer().update("INSERT INTO werkstatt_freigabe " + spalten + "VALUES ("
                    + z.werte() + ")")).as(z.name()).rootCause().hasMessageContaining(z.constraint());
        }
        // Eine Zeile ändert sich nur an ihrem Ende, auch nicht am Tunnel-Programm.
        assertThatThrownBy(() -> eigentuemer().update("UPDATE werkstatt_freigabe SET edge_wartung_sha256 = " + sha
                + " WHERE box_art = 'pfc200'")).rootCause().hasMessageContaining("nur ihr Ende");
        // Eine Box im Register ist Edge Light, Edge App oder Edge Industrie, sonst nichts.
        assertThatThrownBy(() -> eigentuemer().update("UPDATE werkstatt_box SET box_art = 'pfc200' WHERE edge_ref = ?",
                PFC_BOX)).rootCause().hasMessageContaining("werkstatt_box_art_chk");
        // Angaben sind ein kleines Objekt, keine Ablage.
        assertThatThrownBy(() -> eigentuemer().update("UPDATE werkstatt_abnahme SET angaben = '[1]'::jsonb "
                + "WHERE edge_ref = ?", PFC_BOX)).rootCause().isNotNull();
    }

    private static Map<String, String> belege(List<String> pruefungen) {
        Map<String, String> b = new java.util.LinkedHashMap<>();
        for (String p : pruefungen) {
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

    /** Die Abnahme, wie der Dienst sie für einen PFC200 schickt (die Seriennummer ist erfunden). */
    private static Map<String, Object> abnahmeAntrag(Box box, Map<String, Object> aenderung) {
        Map<String, Object> a = new HashMap<>();
        a.put("fassung", INDUSTRIE);
        a.put("hostSchluessel", box.host());
        a.put("lanNetz", "10.213.0.1/24");
        a.put("belege", belege(WerkstattPruefungen.PFC200));
        a.put("passwortAge", ageText());
        a.put("geraet", "pfc200");
        a.put("angaben", Map.of("artikel", "750-8212", "firmware", "03.10.08(22)", "seriennummer", "SN-TEST-0001"));
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
