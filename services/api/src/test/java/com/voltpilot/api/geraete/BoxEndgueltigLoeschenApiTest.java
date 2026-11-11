package com.voltpilot.api.geraete;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.TestKennung;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.util.List;
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
 * „Endgültig löschen" Ende zu Ende gegen echtes Keycloak + TimescaleDB (vp-box-endgueltig-loeschen):
 * der Kunde verbindet und baut aus ({@code DELETE /api/v1/devices/{id}}), der Plattform-Admin liest
 * den Befund und löscht ({@code GET/POST /api/v1/admin/geraete/{ref}/endgueltig-loeschen}).
 *
 * <p>Bewiesen wird: der Glückspfad entfernt die Zeile, schreibt das Protokoll und nimmt die Box aus
 * der Geräteliste; der zweite POST antwortet idempotent aus dem Protokoll; eine Box mit Messwert wird
 * mit 409 und der LISTE abgelehnt und nichts ändert sich; eine nicht ausgebaute Box bekommt
 * {@code nicht_ausgebaut}; ein Kunden-Token bekommt 403.
 */
@Testcontainers(disabledWithoutDocker = true)
@AutoConfigureTestRestTemplate
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class BoxEndgueltigLoeschenApiTest {

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
    void endgueltigLoeschenEntferntDieAusgebauteBoxAusDerListeUndIstIdempotent() {
        HttpHeaders kunde = bearer(token("demo", "demo"));
        HttpHeaders admin = bearer(token("admin", "admin"));
        String ref = TestKennung.box("endg-glueck-" + UUID.randomUUID());
        String deviceId = claim(kunde, ref);
        ausbauen(kunde, deviceId);

        // Der Befund der Akte: ausgebaut, nie Daten geliefert - löschbar, mit der Geräte-ID.
        ResponseEntity<JsonNode> befund = rest.exchange(url(befundPfad(ref)), HttpMethod.GET,
                new HttpEntity<>(admin), JsonNode.class);
        assertThat(befund.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(befund.getBody().get("loeschbar").asBoolean()).isTrue();
        assertThat(befund.getBody().get("daten")).isEmpty();
        assertThat(befund.getBody().get("deviceId").asText()).isEqualTo(deviceId);

        ResponseEntity<JsonNode> erster = loeschen(admin, ref, deviceId);
        assertThat(erster.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(erster.getBody().get("bereitsGeloescht").asBoolean()).isFalse();

        assertThat(queryLong("SELECT count(*) FROM device WHERE id = '" + deviceId + "'")).isZero();
        Map<String, Object> p = queryRow("SELECT tenant_id, external_ref, tenant_name, site_name, "
                + "geloescht_von_sub FROM box_endgueltig_geloescht_protokoll WHERE device_id = '"
                + deviceId + "'");
        assertThat(p.get("external_ref")).isEqualTo(ref);
        assertThat(p.get("tenant_id").toString()).isEqualTo(TENANT_A);
        assertThat(p.get("geloescht_von_sub")).isNotNull();

        // Aus der Geräteliste verschwunden: kein Eintrag dieser Kennung mehr (sie war nie gedruckt).
        ResponseEntity<JsonNode> liste = rest.exchange(url("/api/v1/admin/geraeteliste"), HttpMethod.GET,
                new HttpEntity<>(admin), JsonNode.class);
        assertThat(liste.getBody().get("geraete").findValuesAsText("externalRef")).doesNotContain(ref);

        // Idempotent: dieselbe Anfrage noch einmal (Doppelklick, Netz-Wiederholung) - 200 aus dem Protokoll.
        ResponseEntity<JsonNode> zweiter = loeschen(admin, ref, deviceId);
        assertThat(zweiter.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(zweiter.getBody().get("bereitsGeloescht").asBoolean()).isTrue();
        assertThat(queryLong("SELECT count(*) FROM box_endgueltig_geloescht_protokoll WHERE device_id = '"
                + deviceId + "'")).isOne();

        // Der Befund kennt die Referenz nicht mehr.
        assertThat(rest.exchange(url(befundPfad(ref)), HttpMethod.GET, new HttpEntity<>(admin),
                JsonNode.class).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    void eineAusgebauteBoxMitMesswertBleibtMitDerListeErklaert() {
        HttpHeaders kunde = bearer(token("demo", "demo"));
        HttpHeaders admin = bearer(token("admin", "admin"));
        String ref = TestKennung.box("endg-daten-" + UUID.randomUUID());
        String deviceId = claim(kunde, ref);
        exec("INSERT INTO telemetry (time, tenant_id, site_id, device_id, pv_power_kw) VALUES "
                + "(now() - interval '1 hour', '" + TENANT_A + "', '" + BERLIN_SITE + "', '" + deviceId
                + "', 2.5)");
        ausbauen(kunde, deviceId);

        ResponseEntity<JsonNode> befund = rest.exchange(url(befundPfad(ref)), HttpMethod.GET,
                new HttpEntity<>(admin), JsonNode.class);
        assertThat(befund.getBody().get("loeschbar").asBoolean()).isFalse();
        assertThat(befund.getBody().get("daten").toString()).contains("messwerte");

        ResponseEntity<JsonNode> abgelehnt = loeschen(admin, ref, deviceId);
        assertThat(abgelehnt.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(abgelehnt.getBody().get("code").asText()).isEqualTo("box_hat_daten");
        assertThat(abgelehnt.getBody().get("daten").toString()).contains("messwerte");

        assertThat(queryLong("SELECT count(*) FROM device WHERE id = '" + deviceId + "'"))
                .as("nichts geändert").isOne();
        assertThat(queryLong("SELECT count(*) FROM box_endgueltig_geloescht_protokoll WHERE device_id = '"
                + deviceId + "'")).isZero();
    }

    @Test
    void eineNichtAusgebauteBoxBekommtNichtAusgebaut() {
        HttpHeaders kunde = bearer(token("demo", "demo"));
        HttpHeaders admin = bearer(token("admin", "admin"));
        String ref = TestKennung.box("endg-aktiv-" + UUID.randomUUID());
        String deviceId = claim(kunde, ref);

        ResponseEntity<JsonNode> abgelehnt = loeschen(admin, ref, deviceId);
        assertThat(abgelehnt.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(abgelehnt.getBody().get("code").asText()).isEqualTo("nicht_ausgebaut");
        assertThat(queryLong("SELECT count(*) FROM device WHERE id = '" + deviceId + "'")).isOne();
    }

    @Test
    void einKundenTokenBekommt403() {
        HttpHeaders kunde = bearer(token("demo", "demo"));
        String ref = TestKennung.box("endg-403-" + UUID.randomUUID());
        String deviceId = claim(kunde, ref);
        ausbauen(kunde, deviceId);

        assertThat(rest.exchange(url(befundPfad(ref)), HttpMethod.GET, new HttpEntity<>(kunde),
                JsonNode.class).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(rest.exchange(url(befundPfad(ref)), HttpMethod.POST,
                new HttpEntity<>(Map.of("deviceId", deviceId), kunde), JsonNode.class)
                .getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(queryLong("SELECT count(*) FROM device WHERE id = '" + deviceId + "'")).isOne();
    }

    // ---- helpers --------------------------------------------------------------

    private static String befundPfad(String ref) {
        return "/api/v1/admin/geraete/" + ref + "/endgueltig-loeschen";
    }

    private String claim(HttpHeaders kunde, String ref) {
        ResponseEntity<JsonNode> res = rest.exchange(url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", ref), kunde), JsonNode.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return res.getBody().get("id").asText();
    }

    private void ausbauen(HttpHeaders kunde, String deviceId) {
        ResponseEntity<Void> res = rest.exchange(url("/api/v1/devices/" + deviceId), HttpMethod.DELETE,
                new HttpEntity<>(kunde), Void.class);
        assertThat(res.getStatusCode().is2xxSuccessful()).as("Ausbau (Gerät entfernen)").isTrue();
        assertThat(queryLong("SELECT count(*) FROM device WHERE id = '" + deviceId
                + "' AND ausgebaut_am IS NOT NULL")).isOne();
    }

    private ResponseEntity<JsonNode> loeschen(HttpHeaders admin, String ref, String deviceId) {
        return rest.exchange(url(befundPfad(ref)), HttpMethod.POST,
                new HttpEntity<>(Map.of("deviceId", deviceId), admin), JsonNode.class);
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
