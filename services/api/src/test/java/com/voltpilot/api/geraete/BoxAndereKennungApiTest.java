package com.voltpilot.api.geraete;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.TestKennung;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
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
 * Box verbinden S4 ("Andere Kennung", Konzept vp-plattform-admin-box-benutzer-konzept Abschnitt 3.5;
 * Captain-Entscheid E4 = A vom 10.11.2026) Ende zu Ende gegen echtes Keycloak + TimescaleDB:
 * {@code POST /api/v1/devices/claim} mit {@code ersetzt} löst die alte Box (die sich nie gemeldet
 * hat) und verbindet die neue Kennung in EINER Transaktion ({@link DeviceController}, wiederverwendet
 * {@link BoxLoesenRegel} mit {@code adminWeg = false}).
 *
 * <p>Bewiesen wird: der Glückspfad löscht die alte Verknüpfung und schreibt
 * {@code box_loesen_protokoll} ({@code geloest_art = 'kunde'}); jede der drei Bedingungen aus der
 * Regel (Herzschlag, abgeholter Schlüssel, fremde/nicht sichtbare Geräte-ID) lehnt mit 409 ab und
 * ändert nichts; ein Tippfehler in der NEUEN Kennung (422) lässt die alte Box unberührt, weil das
 * Lösen erst NACH dem erfolgreichen Verbinden läuft.
 */
@Testcontainers(disabledWithoutDocker = true)
@AutoConfigureTestRestTemplate
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class BoxAndereKennungApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";
    private static final String TENANT_B = "10000000-0000-0000-0000-000000000001";

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
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
        registry.add("spring.flyway.placeholders.appDbUser", () -> APP_USER);
        registry.add("spring.flyway.placeholders.appDbPassword", () -> APP_PW);

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

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void andereKennungLoestDieNieGemeldeteBoxUndSchreibtDasProtokoll() {
        HttpHeaders customer = bearer(token("demo", "demo"));
        String alteRef = TestKennung.box("s4-glueck-alt-" + UUID.randomUUID());
        String neueRef = TestKennung.box("s4-glueck-neu-" + UUID.randomUUID());

        ResponseEntity<Map<String, Object>> altClaim = claim(customer, BERLIN_SITE, alteRef, null);
        assertThat(altClaim.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String alteId = (String) altClaim.getBody().get("id");

        ResponseEntity<Map<String, Object>> neuClaim = claim(customer, BERLIN_SITE, neueRef, alteId);
        assertThat(neuClaim.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(neuClaim.getBody()).containsEntry("externalRef", neueRef);
        String neueId = (String) neuClaim.getBody().get("id");
        assertThat(neueId).isNotEqualTo(alteId);

        // Die alte Verknüpfung ist weg, als wäre sie nie gewesen (B1 = A) - die Kennung ist wieder frei.
        assertThat(queryLong("SELECT count(*) FROM device WHERE id = '" + alteId + "'")).isZero();

        // Das Protokoll (L1-Tabelle, Kunden-Weg): geloest_art = 'kunde', Anlass 'andere_kennung'.
        Map<String, Object> eintrag = queryRow("SELECT tenant_id, site_id, device_id, external_ref, "
                + "geloest_art, anlass, geloest_von_sub FROM box_loesen_protokoll WHERE device_id = '"
                + alteId + "'");
        assertThat(eintrag.get("geloest_art")).isEqualTo("kunde");
        assertThat(eintrag.get("anlass")).isEqualTo("andere_kennung");
        assertThat(eintrag.get("external_ref")).isEqualTo(alteRef);
        assertThat(eintrag.get("tenant_id").toString()).isEqualTo(TENANT_A);
        assertThat(eintrag.get("geloest_von_sub")).isNotNull();

        // Die Anlage heilt wie nach jedem Verbinden: genau eine Box übrig, die neue.
        assertThat(queryLong("SELECT count(*) FROM device WHERE site_id = '" + BERLIN_SITE
                + "' AND external_ref = '" + neueRef + "' AND ausgebaut_am IS NULL")).isEqualTo(1);
    }

    @Test
    void andereKennungLehntAbWennDieAlteBoxSchonEinenHerzschlagHat() {
        HttpHeaders customer = bearer(token("demo", "demo"));
        String alteRef = TestKennung.box("s4-herzschlag-alt-" + UUID.randomUUID());
        String neueRef = TestKennung.box("s4-herzschlag-neu-" + UUID.randomUUID());

        String alteId = (String) claim(customer, BERLIN_SITE, alteRef, null).getBody().get("id");
        exec("UPDATE device SET device_status_seen_at = now() WHERE id = '" + alteId + "'");

        ResponseEntity<JsonNode> abgelehnt = claimJson(customer, BERLIN_SITE, neueRef, alteId);
        assertThat(abgelehnt.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(abgelehnt.getBody().get("grund").asText()).isEqualTo("box_hat_sich_gemeldet");
        assertThat(abgelehnt.getBody().get("gruende").toString()).contains("herzschlag");

        // Nichts geändert: die alte Box lebt weiter, die neue Kennung wurde nicht verbunden.
        assertThat(queryLong("SELECT count(*) FROM device WHERE id = '" + alteId
                + "' AND ausgebaut_am IS NULL")).isEqualTo(1);
        assertThat(queryLong("SELECT count(*) FROM device WHERE external_ref = '" + neueRef + "'")).isZero();
    }

    @Test
    void andereKennungLehntAbWennDerSchluesselSchonAbgeholtWurde() {
        HttpHeaders customer = bearer(token("demo", "demo"));
        String alteRef = TestKennung.box("s4-schluessel-alt-" + UUID.randomUUID());
        String neueRef = TestKennung.box("s4-schluessel-neu-" + UUID.randomUUID());

        String alteId = (String) claim(customer, BERLIN_SITE, alteRef, null).getBody().get("id");
        // Simuliert eine Box, die ihren Schlüssel abgeholt hat, sich aber nie gemeldet hat (anders
        // als beim Admin-Weg B2 = A blockiert das den Kunden-Weg IMMER).
        exec("INSERT INTO device_enrollment (external_ref, csr_pem, device_id, cert_pem, cert_serial, "
                + "issued_at) VALUES ('" + alteRef + "', 'dummy-csr', '" + alteId
                + "', 'dummy-cert', 'dummy-serial', now())");

        ResponseEntity<JsonNode> abgelehnt = claimJson(customer, BERLIN_SITE, neueRef, alteId);
        assertThat(abgelehnt.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(abgelehnt.getBody().get("gruende").toString()).contains("angemeldet");

        assertThat(queryLong("SELECT count(*) FROM device WHERE id = '" + alteId
                + "' AND ausgebaut_am IS NULL")).isEqualTo(1);
        assertThat(queryLong("SELECT count(*) FROM device WHERE external_ref = '" + neueRef + "'")).isZero();
    }

    @Test
    void andereKennungMitEinerFremdenGeraeteIdLoestNieEineFremdeBox() {
        HttpHeaders customer = bearer(token("demo", "demo"));
        String neueRef = TestKennung.box("s4-fremd-neu-" + UUID.randomUUID());

        // Eine Box eines ANDEREN Mandanten, direkt gesät (als Superuser, an RLS vorbei) - ein
        // gefälschter Pfad, den der Kunde nie sehen sollte.
        UUID fremdeId = UUID.randomUUID();
        String fremdeRef = TestKennung.box("s4-fremd-alt-" + UUID.randomUUID());
        exec("INSERT INTO device (id, tenant_id, site_id, external_ref, kind, status) VALUES ('"
                + fremdeId + "', '" + TENANT_B + "', (SELECT id FROM site WHERE tenant_id = '" + TENANT_B
                + "' LIMIT 1), '" + fremdeRef + "', 'inverter', 'claimed')");

        ResponseEntity<JsonNode> abgelehnt = claimJson(customer, BERLIN_SITE, neueRef, fremdeId.toString());
        assertThat(abgelehnt.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(abgelehnt.getBody().get("grund").asText()).isEqualTo("box_hat_sich_gemeldet");
        assertThat(abgelehnt.getBody().get("gruende").toString()).contains("verbund");

        // Die fremde Box lebt unverändert weiter, die neue Kennung wurde nicht verbunden.
        assertThat(queryLong("SELECT count(*) FROM device WHERE id = '" + fremdeId
                + "' AND ausgebaut_am IS NULL")).isEqualTo(1);
        assertThat(queryLong("SELECT count(*) FROM device WHERE external_ref = '" + neueRef + "'")).isZero();
    }

    @Test
    void einTippfehlerInDerNeuenKennungLaesstDieAlteBoxVoelligUnberuehrt() {
        HttpHeaders customer = bearer(token("demo", "demo"));
        String alteRef = TestKennung.box("s4-tippfehler-alt-" + UUID.randomUUID());
        String gueltigeNeueRef = TestKennung.box("s4-tippfehler-neu-" + UUID.randomUUID());
        // Ein Zeichen verändert, das Prüfzeichen passt nicht mehr (EdgeRef.isValid).
        String tippfehlerRef = gueltigeNeueRef.substring(0, gueltigeNeueRef.length() - 1)
                + (gueltigeNeueRef.endsWith("a") ? "b" : "a");

        String alteId = (String) claim(customer, BERLIN_SITE, alteRef, null).getBody().get("id");

        ResponseEntity<JsonNode> abgelehnt = claimJson(customer, BERLIN_SITE, tippfehlerRef, alteId);
        assertThat(abgelehnt.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_CONTENT);

        // Das Lösen läuft NACH dem erfolgreichen Verbinden der neuen Kennung (nie vorher): die alte
        // Box ist unberührt, kein box_loesen_protokoll-Eintrag, die Tippfehler-Kennung existiert nicht.
        assertThat(queryLong("SELECT count(*) FROM device WHERE id = '" + alteId
                + "' AND ausgebaut_am IS NULL")).isEqualTo(1);
        assertThat(queryLong("SELECT count(*) FROM box_loesen_protokoll WHERE device_id = '"
                + alteId + "'")).isZero();
        assertThat(queryLong("SELECT count(*) FROM device WHERE external_ref = '" + tippfehlerRef + "'"))
                .isZero();
    }

    // ---- helpers --------------------------------------------------------------

    private ResponseEntity<Map<String, Object>> claim(HttpHeaders headers, String siteId, String ref,
            String ersetzt) {
        Map<String, Object> body = ersetzt == null
                ? Map.of("siteId", siteId, "externalRef", ref)
                : Map.of("siteId", siteId, "externalRef", ref, "ersetzt", ersetzt);
        return rest.exchange(url("/api/v1/devices/claim"), HttpMethod.POST, new HttpEntity<>(body, headers),
                new org.springframework.core.ParameterizedTypeReference<>() {});
    }

    private ResponseEntity<JsonNode> claimJson(HttpHeaders headers, String siteId, String ref, String ersetzt) {
        Map<String, Object> body = ersetzt == null
                ? Map.of("siteId", siteId, "externalRef", ref)
                : Map.of("siteId", siteId, "externalRef", ref, "ersetzt", ersetzt);
        return rest.exchange(url("/api/v1/devices/claim"), HttpMethod.POST, new HttpEntity<>(body, headers),
                JsonNode.class);
    }

    /** Run a statement as the Postgres superuser (bypasses RLS) to seed/mutate rows. */
    private static void exec(String sql) {
        try (java.sql.Connection c = java.sql.DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                java.sql.Statement st = c.createStatement()) {
            st.execute(sql);
        } catch (Exception e) {
            throw new IllegalStateException("seed failed: " + sql, e);
        }
    }

    private static long queryLong(String sql) {
        try (java.sql.Connection c = java.sql.DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                java.sql.Statement st = c.createStatement();
                java.sql.ResultSet rs = st.executeQuery(sql)) {
            rs.next();
            return rs.getLong(1);
        } catch (Exception e) {
            throw new IllegalStateException("query failed: " + sql, e);
        }
    }

    private static Map<String, Object> queryRow(String sql) {
        try (java.sql.Connection c = java.sql.DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                java.sql.Statement st = c.createStatement();
                java.sql.ResultSet rs = st.executeQuery(sql)) {
            assertThat(rs.next()).as("row for: " + sql).isTrue();
            java.util.LinkedHashMap<String, Object> row = new java.util.LinkedHashMap<>();
            for (int i = 1; i <= rs.getMetaData().getColumnCount(); i++) {
                row.put(rs.getMetaData().getColumnName(i), rs.getObject(i));
            }
            return row;
        } catch (Exception e) {
            throw new IllegalStateException("query failed: " + sql, e);
        }
    }

    private String url(String path) {
        return "http://localhost:" + port + path;
    }

    private static HttpHeaders bearer(String token) {
        HttpHeaders h = new HttpHeaders();
        h.setBearerAuth(token);
        h.setContentType(MediaType.APPLICATION_JSON);
        return h;
    }

    private String token(String username, String password) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", "voltpilot-api");
        form.add("client_secret", "voltpilot-api-dev-secret");
        form.add("username", username);
        form.add("password", password);
        form.add("scope", "openid");

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        Map<String, Object> body = new TestRestTemplate().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).as("token response").containsKey("access_token");
        return (String) body.get("access_token");
    }
}
