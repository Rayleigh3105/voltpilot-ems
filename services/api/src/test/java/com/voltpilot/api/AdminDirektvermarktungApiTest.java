package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Connection;
import java.sql.DriverManager;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureTestRestTemplate;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.resttestclient.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.core.ParameterizedTypeReference;
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
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * Die Plattform-Sicht der Direktvermarktung (Konzept vp-direktvermarktung-konzept d2 §7.7):
 * {@code GET /api/v1/admin/direktvermarktung} (Plattform-Liste), {@code .../{siteId}} (Geräteakte ›
 * Verbindung) und {@code .../{siteId}/protokoll} (Ereignisse) - platform-admin geschützt wie jedes
 * andere Lesemodell (403 für den Kunden-Operator {@code demo}), nie Chiffrat/Nonce/Passwort.
 */
@Testcontainers(disabledWithoutDocker = true)
@AutoConfigureTestRestTemplate
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class AdminDirektvermarktungApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

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
        registry.add("voltpilot.keycloak.admin.base-url", KEYCLOAK::getAuthServerUrl);
        registry.add("voltpilot.keycloak.admin.realm", () -> "voltpilot");
        registry.add("voltpilot.keycloak.admin.client-id", () -> "voltpilot-api");
        registry.add("voltpilot.keycloak.admin.client-secret", () -> "voltpilot-api-dev-secret");
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Test
    void platformListeAkteUndProtokollZeigenDenAnschlussNieDasSchluesselmaterial() {
        UUID tenant = UUID.randomUUID();
        UUID site = UUID.randomUUID();
        UUID dv = UUID.randomUUID();
        UUID device = UUID.randomUUID();
        exec("INSERT INTO tenant (id, name) VALUES ('" + tenant + "', 'Admin-DV-Probe " + tenant + "')");
        exec("INSERT INTO site (id, tenant_id, name) VALUES ('" + site + "', '" + tenant + "', 'Werk')");
        exec("INSERT INTO device (id, tenant_id, site_id, external_ref, kind, status) VALUES ('" + device + "', '"
                + tenant + "', '" + site + "', 'VP-ADMIN-DV-" + device + "', 'inverter', 'claimed')");
        exec("UPDATE site SET lead_device_id = '" + device + "' WHERE id = '" + site + "'");
        exec("INSERT INTO direktvermarktung (id, tenant_id, site_id, partner, zustand, zustimmung_am, "
                + "zustimmung_von, zustimmung_rolle, startdatum) VALUES ('" + dv + "', '" + tenant + "', '" + site
                + "', 'luox', 'verbunden', now(), 'kunde', 'kundenadministrator', CURRENT_DATE)");
        exec("INSERT INTO direktvermarktung_stand (site_id, tenant_id, handshake_am, letzte_abfrage_am, "
                + "abfragen_je_minute, vorgabe_pct, lebenszeichen_am, einspeisung_w, erzeugung_w) VALUES ('"
                + site + "', '" + tenant + "', now(), now(), 4, 100, now(), 12000, 14000)");
        exec("INSERT INTO direktvermarktung_zugang (id, tenant_id, site_id, direktvermarktung_id, chiffrat, "
                + "nonce, fingerabdruck, gueltig_bis, hochgeladen_von) VALUES (gen_random_uuid(), '" + tenant
                + "', '" + site + "', '" + dv + "', '\\xDEAD', '\\xBEEF', 'ab:cd:ef', now() + interval '10 days', "
                + "'kunde@example.test')");
        exec("INSERT INTO direktvermarktung_protokoll (tenant_id, site_id, direktvermarktung_id, ereignis, von, "
                + "rolle) VALUES ('" + tenant + "', '" + site + "', '" + dv
                + "', 'zugestimmt', 'kunde@example.test', 'kundenadministrator')");

        String admin = token("admin", "admin");

        ResponseEntity<List<Map<String, Object>>> liste = rest.exchange(
                url("/api/v1/admin/direktvermarktung"), HttpMethod.GET, new HttpEntity<>(bearer(admin)),
                new ParameterizedTypeReference<List<Map<String, Object>>>() {});
        assertThat(liste.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> zeile = liste.getBody().stream()
                .filter(z -> site.toString().equals(z.get("siteId"))).findFirst().orElseThrow();
        assertThat(zeile.get("partner")).isEqualTo("luox");
        assertThat(zeile.get("zustand")).isEqualTo("verbunden");
        assertThat(zeile.get("zugangGueltigBis")).as("die Plattform-Liste zeigt die Gültigkeit, nie das Zertifikat")
                .isNotNull();
        assertThat(zeile.get("leadDeviceRef")).as("die Geräteakte-Route braucht die Leitbox-Kennung")
                .isEqualTo("VP-ADMIN-DV-" + device);
        assertThat(zeile).as("Chiffrat/Nonce/Passwort verlassen diese Route nie")
                .doesNotContainKeys("chiffrat", "nonce", "passwort");

        ResponseEntity<Map<String, Object>> akte = rest.exchange(
                url("/api/v1/admin/direktvermarktung/" + site), HttpMethod.GET, new HttpEntity<>(bearer(admin)),
                new ParameterizedTypeReference<Map<String, Object>>() {});
        assertThat(akte.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(akte.getBody().get("partner")).isEqualTo("luox");
        assertThat(akte.getBody().get("abfragenJeMinute")).isEqualTo(4.0);
        assertThat(akte.getBody().get("einspeisungW")).isEqualTo(12000);
        assertThat(akte.getBody().get("zugangFingerabdruck")).isEqualTo("ab:cd:ef");
        assertThat(akte.getBody()).as("die Geräteakte zeigt den Fingerabdruck, nie das Chiffrat selbst")
                .doesNotContainKeys("chiffrat", "nonce");

        ResponseEntity<List<Map<String, Object>>> protokoll = rest.exchange(
                url("/api/v1/admin/direktvermarktung/" + site + "/protokoll"), HttpMethod.GET,
                new HttpEntity<>(bearer(admin)), new ParameterizedTypeReference<List<Map<String, Object>>>() {});
        assertThat(protokoll.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(protokoll.getBody()).extracting(e -> e.get("ereignis")).contains("zugestimmt");

        // Eine Anlage ohne jeden Anschluss ist 404, nicht leer behauptet.
        ResponseEntity<String> keine = rest.exchange(
                url("/api/v1/admin/direktvermarktung/" + UUID.randomUUID()), HttpMethod.GET,
                new HttpEntity<>(bearer(admin)), String.class);
        assertThat(keine.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // Der Kunden-Operator demo ist kein platform-admin.
        String demo = token("demo", "demo");
        assertThat(rest.exchange(url("/api/v1/admin/direktvermarktung"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), String.class).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(rest.exchange(url("/api/v1/admin/direktvermarktung/" + site), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), String.class).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
    }

    /**
     * EZ-8-Abgleich (kein Datenbezug, keine Sperre): die Plattform-Liste und die
     * Geräteakte nennen zusätzlich den Namen des älteren, hardwaregestützten Felds der
     * Anlagensteuerung, wenn die Anlage eines trägt - rein gelesen, kein Schreibzugriff, das EZ-8-Feld
     * selbst bleibt unverändert.
     */
    @Test
    void platformListeUndAkteNennenDenEz8DirektvermarkterWennGesetzt() {
        UUID tenant = UUID.randomUUID();
        UUID site = UUID.randomUUID();
        UUID dv = UUID.randomUUID();
        exec("INSERT INTO tenant (id, name) VALUES ('" + tenant + "', 'Admin-DV-EZ8-Probe " + tenant + "')");
        exec("INSERT INTO site (id, tenant_id, name) VALUES ('" + site + "', '" + tenant + "', 'Werk EZ-8')");
        exec("INSERT INTO direktvermarktung (id, tenant_id, site_id, partner, zustand, zustimmung_am, "
                + "zustimmung_von, zustimmung_rolle, startdatum) VALUES ('" + dv + "', '" + tenant + "', '" + site
                + "', 'luox', 'verbunden', now(), 'kunde', 'kundenadministrator', CURRENT_DATE)");
        exec("INSERT INTO anlage_netz_vermarktung (site_id, tenant_id, direktvermarkter, direktvermarkter_kanal) "
                + "VALUES ('" + site + "', '" + tenant + "', 'Stadtwerke Nord', 'relais_ma')");

        String admin = token("admin", "admin");

        ResponseEntity<List<Map<String, Object>>> liste = rest.exchange(
                url("/api/v1/admin/direktvermarktung"), HttpMethod.GET, new HttpEntity<>(bearer(admin)),
                new ParameterizedTypeReference<List<Map<String, Object>>>() {});
        Map<String, Object> zeile = liste.getBody().stream()
                .filter(z -> site.toString().equals(z.get("siteId"))).findFirst().orElseThrow();
        assertThat(zeile.get("ez8Direktvermarkter")).isEqualTo("Stadtwerke Nord");

        ResponseEntity<Map<String, Object>> akte = rest.exchange(
                url("/api/v1/admin/direktvermarktung/" + site), HttpMethod.GET, new HttpEntity<>(bearer(admin)),
                new ParameterizedTypeReference<Map<String, Object>>() {});
        assertThat(akte.getBody().get("ez8Direktvermarkter")).isEqualTo("Stadtwerke Nord");
    }

    /** Ein Kanal "keiner" (nicht erhoben) zeigt sich NICHT als EZ-8-Direktvermarkter, auch mit einem Namen. */
    @Test
    void ez8DirektvermarkterBleibtLeerOhneEchtenKanal() {
        UUID tenant = UUID.randomUUID();
        UUID site = UUID.randomUUID();
        UUID dv = UUID.randomUUID();
        exec("INSERT INTO tenant (id, name) VALUES ('" + tenant + "', 'Admin-DV-EZ8-Ohne-Probe " + tenant + "')");
        exec("INSERT INTO site (id, tenant_id, name) VALUES ('" + site + "', '" + tenant + "', 'Werk ohne EZ-8')");
        exec("INSERT INTO direktvermarktung (id, tenant_id, site_id, partner, zustand, zustimmung_am, "
                + "zustimmung_von, zustimmung_rolle, startdatum) VALUES ('" + dv + "', '" + tenant + "', '" + site
                + "', 'luox', 'verbunden', now(), 'kunde', 'kundenadministrator', CURRENT_DATE)");
        exec("INSERT INTO anlage_netz_vermarktung (site_id, tenant_id, direktvermarkter, direktvermarkter_kanal) "
                + "VALUES ('" + site + "', '" + tenant + "', 'Alter Name ohne Kanal', 'keiner')");

        String admin = token("admin", "admin");
        ResponseEntity<List<Map<String, Object>>> liste = rest.exchange(
                url("/api/v1/admin/direktvermarktung"), HttpMethod.GET, new HttpEntity<>(bearer(admin)),
                new ParameterizedTypeReference<List<Map<String, Object>>>() {});
        Map<String, Object> zeile = liste.getBody().stream()
                .filter(z -> site.toString().equals(z.get("siteId"))).findFirst().orElseThrow();
        assertThat(zeile.get("ez8Direktvermarkter")).isNull();
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

    private static void exec(String sql) {
        try (Connection c = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                java.sql.Statement st = c.createStatement()) {
            st.execute(sql);
        } catch (Exception e) {
            throw new IllegalStateException("seed failed: " + sql, e);
        }
    }
}
