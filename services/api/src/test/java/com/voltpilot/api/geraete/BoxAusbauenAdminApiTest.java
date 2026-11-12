package com.voltpilot.api.geraete;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.TestKennung;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.TestRestTemplate;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureTestRestTemplate;
import org.springframework.boot.test.context.SpringBootTest;
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
 * "Box ausbauen" ohne Mandantensprung Ende zu Ende gegen echtes Keycloak + TimescaleDB
 * (vp-admin-box-ausbauen): derselbe Einstieg "Vom Kunden lösen" ({@code POST
 * /api/v1/admin/geraete/{ref}/ausbauen}) baut eine Box MIT Daten aus - wie der Kunde selbst
 * ({@code DELETE /api/v1/devices/{id}}), nur ohne Umweg über den Mandantensprung.
 *
 * <p>Bewiesen wird: der Glückspfad baut aus, der Datenbestand bleibt, das Protokoll trägt die
 * Kennung, der zweite POST antwortet idempotent; eine Box mit offener Zuständigkeit wird mit 409
 * {@code box_hat_zustaendigkeiten} abgelehnt und nichts ändert sich; eine unbekannte Referenz ist
 * 404; ein Kunden-Token bekommt 403; ein fehlender Anlass ist 400.
 */
@Testcontainers(disabledWithoutDocker = true)
@AutoConfigureTestRestTemplate
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class BoxAusbauenAdminApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";

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

    @Test
    void ausbauenBehaeltDenDatenbestandUndIstIdempotent() {
        HttpHeaders kunde = bearer(token("demo", "demo"));
        HttpHeaders admin = bearer(token("admin", "admin"));
        String ref = TestKennung.box("ausb-glueck-" + UUID.randomUUID());
        String deviceId = claim(kunde, ref);
        exec("INSERT INTO telemetry (time, tenant_id, site_id, device_id, pv_power_kw) VALUES "
                + "(now() - interval '1 hour', '" + TENANT_A + "', '" + BERLIN_SITE + "', '" + deviceId
                + "', 2.5)");

        ResponseEntity<JsonNode> erster = ausbauen(admin, ref);
        assertThat(erster.getStatusCode()).as(String.valueOf(erster.getBody())).isEqualTo(HttpStatus.OK);
        assertThat(erster.getBody().get("bereitsAusgebaut").asBoolean()).isFalse();
        assertThat(erster.getBody().get("deviceId").asText()).isEqualTo(deviceId);

        assertThat(queryLong("SELECT count(*) FROM device WHERE id = '" + deviceId
                + "' AND ausgebaut_am IS NOT NULL")).as("ausgebaut, nicht gelöscht").isOne();
        assertThat(queryLong("SELECT count(*) FROM telemetry WHERE device_id = '" + deviceId + "'"))
                .as("kein Datenbestand geht verloren").isOne();
        Map<String, Object> p = queryRow("SELECT tenant_id, external_ref, tenant_name, site_name, "
                + "ausgebaut_von_sub, anlass FROM box_ausbauen_protokoll WHERE device_id = '" + deviceId + "'");
        assertThat(p.get("external_ref")).isEqualTo(ref);
        assertThat(p.get("tenant_id").toString()).isEqualTo(TENANT_A);
        assertThat(p.get("ausgebaut_von_sub")).isNotNull();
        assertThat(p.get("anlass")).isEqualTo("fremder_kunde");

        // Idempotent: derselbe POST noch einmal (Doppelklick, Netz-Wiederholung) - 200 aus dem Protokoll.
        ResponseEntity<JsonNode> zweiter = ausbauen(admin, ref);
        assertThat(zweiter.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(zweiter.getBody().get("bereitsAusgebaut").asBoolean()).isTrue();
        assertThat(queryLong("SELECT count(*) FROM box_ausbauen_protokoll WHERE device_id = '" + deviceId + "'"))
                .as("nie ein zweiter Eintrag").isOne();

        // Die freie Kennung ist an einem zweiten Kunden wieder verbindbar.
        String neueDeviceId = claim(kunde, ref);
        assertThat(neueDeviceId).isNotEqualTo(deviceId);
    }

    @Test
    void eineBoxMitOffenerZustaendigkeitWirdMit409AbgelehntUndNichtsAendertSich() {
        HttpHeaders kunde = bearer(token("demo", "demo"));
        HttpHeaders admin = bearer(token("admin", "admin"));
        String ref = TestKennung.box("ausb-zust-" + UUID.randomUUID());
        String deviceId = claim(kunde, ref);
        UUID quelle = UUID.randomUUID();
        // data_source_kennzeichen_chk: nur A-Z0-9./- , höchstens 16 Zeichen.
        String kennzeichen = "DQ-" + Long.toHexString(quelle.getLeastSignificantBits() & 0xFFFFFFL).toUpperCase();
        exec("INSERT INTO data_source (id, tenant_id, site_id, kennzeichen, protokoll, adresse, kadenz_s) "
                + "VALUES ('" + quelle + "', '" + TENANT_A + "', '" + BERLIN_SITE + "', '" + kennzeichen
                + "', 'modbus_tcp', 'test-" + quelle + ":502', 60)");
        exec("INSERT INTO data_source_assignment (tenant_id, data_source_id, device_id, protokoll, adresse, "
                + "effective_from) VALUES ('" + TENANT_A + "', '" + quelle + "', '" + deviceId
                + "', 'modbus_tcp', 'test-" + quelle + ":502', date_trunc('minute', now()))");

        ResponseEntity<JsonNode> abgelehnt = ausbauen(admin, ref);
        assertThat(abgelehnt.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(abgelehnt.getBody().get("grund").asText()).isEqualTo("box_hat_zustaendigkeiten");

        assertThat(queryLong("SELECT count(*) FROM device WHERE id = '" + deviceId
                + "' AND ausgebaut_am IS NULL")).as("nichts geändert").isOne();
        assertThat(queryLong("SELECT count(*) FROM box_ausbauen_protokoll WHERE device_id = '" + deviceId + "'"))
                .isZero();
    }

    @Test
    void eineUnbekannteReferenzIst404() {
        HttpHeaders admin = bearer(token("admin", "admin"));
        assertThat(ausbauen(admin, "edge-unbekannt-" + UUID.randomUUID()).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    void einKundenTokenBekommt403() {
        HttpHeaders kunde = bearer(token("demo", "demo"));
        String ref = TestKennung.box("ausb-403-" + UUID.randomUUID());
        String deviceId = claim(kunde, ref);

        assertThat(ausbauen(kunde, ref).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(queryLong("SELECT count(*) FROM device WHERE id = '" + deviceId
                + "' AND ausgebaut_am IS NULL")).isOne();
    }

    @Test
    void einFehlenderAnlassIst400() {
        HttpHeaders admin = bearer(token("admin", "admin"));
        HttpHeaders kunde = bearer(token("demo", "demo"));
        String ref = TestKennung.box("ausb-anlass-" + UUID.randomUUID());
        claim(kunde, ref);

        ResponseEntity<JsonNode> r = rest.exchange(url(ausbauenPfad(ref)), HttpMethod.POST,
                new HttpEntity<>(Map.of(), admin), JsonNode.class);
        assertThat(r.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    // ---- helpers --------------------------------------------------------------

    private static String ausbauenPfad(String ref) {
        return "/api/v1/admin/geraete/" + ref + "/ausbauen";
    }

    private String claim(HttpHeaders kunde, String ref) {
        ResponseEntity<JsonNode> res = rest.exchange(url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", ref), kunde), JsonNode.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return res.getBody().get("id").asText();
    }

    private ResponseEntity<JsonNode> ausbauen(HttpHeaders admin, String ref) {
        return rest.exchange(url(ausbauenPfad(ref)), HttpMethod.POST,
                new HttpEntity<>(Map.of("anlass", "fremder_kunde"), admin), JsonNode.class);
    }

    /** Run a statement as the Postgres superuser (bypasses RLS) to seed/inspect rows. */
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
