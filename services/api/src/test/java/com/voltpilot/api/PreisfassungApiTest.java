package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.assertj.core.data.Offset;
import org.junit.jupiter.api.Test;
import org.springframework.boot.resttestclient.TestRestTemplate;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureTestRestTemplate;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.beans.factory.annotation.Autowired;
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
 * PREISE AB EINEM TAG (vp-tarif-ab-tag) gegen echtes TimescaleDB + Keycloak: Tarif, Preisblatt und
 * Einspeisevergütung gelten ab dem Tag, den der Kunde nennt („Ab wann?“), und die Erlöse jeder
 * Viertelstunde rechnen mit dem Satz, der zu ihrer Zeit galt.
 *
 * <ol>
 *   <li>ein neuer Tarif ab Tag 2 lässt Tag 1 unverändert und bewertet Tag 2 und 3 neu;</li>
 *   <li>ein Preisblatt ab Tag 3 und eine eigene Einspeisevergütung ab Tag 3 ändern nur Tag 3;</li>
 *   <li>ohne Tag gilt heute - die Vergangenheit bleibt; ein künftiger oder unlesbarer Tag ist 400 und
 *       schreibt nichts; ein Voll-PUT mit gleichem Tarif zeichnet keine Fassung auf;</li>
 *   <li>„beginn“ berichtigt von Anfang an;</li>
 *   <li>die Fassungen sind lesbar, und eine fremde Anlage ist 404.</li>
 * </ol>
 */
@Testcontainers(disabledWithoutDocker = true)
@AutoConfigureTestRestTemplate
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class PreisfassungApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final Offset<Double> EPS = Offset.offset(1e-9);

    @Container
    static final TestDatenbank POSTGRES = new TestDatenbank();

    @Container
    static final TestKeycloak KEYCLOAK = new TestKeycloak();

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
    void preiseGeltenAbIhremTagUndBewertenNurDieEnergieDanach() {
        String demo = token("demo", "demo");
        LocalDate heute = LocalDate.now(BERLIN);
        LocalDate t1 = heute.minusDays(6);
        LocalDate t2 = heute.minusDays(5);
        LocalDate t3 = heute.minusDays(4);
        String site = createSite(demo, "Preisfassung Haus", "fest", "30");

        // Je Tag eine Viertelstunde um 10:00 Berlin: 1 kWh Bezug, 0,5 kWh Einspeisung, 100 EUR/MWh (CH).
        for (LocalDate d : List.of(t1, t2, t3)) {
            String ts = d.atTime(10, 0).atZone(BERLIN).toInstant().toString();
            exec("INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source)"
                    + " VALUES ('" + ts + "', 'CH', 'PT15M', 100.0, 'EUR', 'test') ON CONFLICT DO NOTHING");
            exec("INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, load_kwh, grid_import_kwh,"
                    + " grid_export_kwh, battery_charge_kwh, battery_discharge_kwh, n_samples) VALUES ('" + ts
                    + "', '" + TENANT_A + "', '" + site + "', 0.5, 1.0, 1.0, 0.5, 0.0, 0.0, 90)");
        }
        // Gründung: fest 30 ct von Anfang an; Einspeisung ohne Datum und ohne Angabe = Börsenpreis 10 ct.
        for (LocalDate d : List.of(t1, t2, t3)) {
            assertThat(num(tag(demo, site, d), "stromkostenEur")).isCloseTo(0.30, EPS);
            assertThat(num(tag(demo, site, d), "einspeiseErloesEur")).isCloseTo(0.05, EPS);
        }
        assertThat(fassungen(demo, site)).hasSize(1).first()
                .satisfies(f -> assertThat(f.get("gueltigAb")).isNull());

        // 1. Neuer Tarif ab Tag 2: Tag 1 bleibt, Tag 2 und 3 kosten 40 ct.
        assertThat(putSite(demo, site, "fest", "40", t2.toString()).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(num(tag(demo, site, t1), "stromkostenEur")).isCloseTo(0.30, EPS);
        assertThat(num(tag(demo, site, t2), "stromkostenEur")).isCloseTo(0.40, EPS);
        assertThat(num(tag(demo, site, t3), "stromkostenEur")).isCloseTo(0.40, EPS);

        // 2a. Eigene Einspeisevergütung 12 ct ab Tag 3 (kein Inbetriebnahmedatum: § 51a-Antwort Pflicht).
        Map<String, Object> verguetung = new HashMap<>();
        verguetung.put("satzCtKwh", 12);
        verguetung.put("inbetriebnahmeAbSolarspitzengesetz", false);
        verguetung.put("gueltigAb", t3.toString());
        assertThat(put(demo, "/api/v1/sites/" + site + "/einspeiseverguetung", verguetung).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(num(tag(demo, site, t2), "einspeiseErloesEur")).isCloseTo(0.05, EPS);
        assertThat(num(tag(demo, site, t3), "einspeiseErloesEur")).isCloseTo(0.06, EPS);

        // 2b. Ein Preisblatt ab Tag 3 an einer Anlage OHNE Tarif: nur Tag 3 wird teurer als der Börsenpreis.
        String ohne = createSite(demo, "Preisfassung Ohne Tarif", "ohne", null);
        for (LocalDate d : List.of(t1, t2, t3)) {
            String ts = d.atTime(10, 0).atZone(BERLIN).toInstant().toString();
            exec("INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, load_kwh, grid_import_kwh,"
                    + " grid_export_kwh, battery_charge_kwh, battery_discharge_kwh, n_samples) VALUES ('" + ts
                    + "', '" + TENANT_A + "', '" + ohne + "', 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 90)");
        }
        double vorherT2 = num(tag(demo, ohne, t2), "stromkostenEur");
        Map<String, Object> blatt = new HashMap<>();
        blatt.put("netzentgeltArbeitspreisCt", 10);
        blatt.put("ustPct", 19);
        blatt.put("gueltigAb", t3.toString());
        assertThat(put(demo, "/api/v1/sites/" + ohne + "/supply-price", blatt).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(num(tag(demo, ohne, t2), "stromkostenEur")).isCloseTo(vorherT2, EPS);
        // (10 ct Börse + 10 ct Netzentgelt) × 1,19 = 23,8 ct je kWh.
        assertThat(num(tag(demo, ohne, t3), "stromkostenEur")).isCloseTo(0.238, EPS);

        // 3. Ohne Tag gilt heute: die drei vergangenen Tage bleiben.
        assertThat(putSite(demo, site, "fest", "45", null).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(num(tag(demo, site, t3), "stromkostenEur")).isCloseTo(0.40, EPS);
        List<Map<String, Object>> stand = fassungen(demo, site);
        assertThat(stand).extracting(f -> f.get("gueltigAb"))
                .containsExactly(null, t2.toString(), t3.toString(), heute.toString());
        assertThat(stand.get(3)).containsEntry("tarifArt", "fest");
        assertThat(num(stand.get(3), "tarifParamCtKwh")).isCloseTo(45.0, EPS);
        assertThat(num(stand.get(2), "einspeiseverguetungCtKwh")).isCloseTo(12.0, EPS);
        // Künftig oder unlesbar: 400, nichts geschrieben.
        assertThat(putSite(demo, site, "fest", "99", heute.plusDays(1).toString()).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(putSite(demo, site, "fest", "99", "gestern").getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        Map<String, Object> kuenftig = new HashMap<>(blatt);
        kuenftig.put("gueltigAb", heute.plusDays(3).toString());
        assertThat(put(demo, "/api/v1/sites/" + ohne + "/supply-price", kuenftig).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
        // Derselbe Tarif im Voll-PUT (z. B. nur der Name ändert sich): keine neue Fassung.
        assertThat(putSite(demo, site, "fest", "45", t1.toString()).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(fassungen(demo, site)).hasSize(4);
        assertThat(num(tag(demo, site, t1), "stromkostenEur")).isCloseTo(0.30, EPS);

        // 4. „beginn“: der Tarif war schon immer falsch - jeder Tag kostet jetzt 50 ct, die Vergütung bleibt je Tag.
        assertThat(putSite(demo, site, "fest", "50", "beginn").getStatusCode()).isEqualTo(HttpStatus.OK);
        for (LocalDate d : List.of(t1, t2, t3)) {
            assertThat(num(tag(demo, site, d), "stromkostenEur")).isCloseTo(0.50, EPS);
        }
        assertThat(num(tag(demo, site, t2), "einspeiseErloesEur")).isCloseTo(0.05, EPS);
        assertThat(num(tag(demo, site, t3), "einspeiseErloesEur")).isCloseTo(0.06, EPS);

        // 5. Der Mandantenzaun.
        ResponseEntity<String> fremd = rest.exchange(url("/api/v1/sites/" + site + "/preisfassungen"),
                HttpMethod.GET, new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class);
        assertThat(fremd.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ------------------------------------------------------------------ helpers

    private Map<String, Object> tag(String token, String site, LocalDate d) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/sites/" + site + "/earnings?range=day&at=" + d), HttpMethod.GET,
                new HttpEntity<>(bearer(token)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    private List<Map<String, Object>> fassungen(String token, String site) {
        ResponseEntity<List<Map<String, Object>>> res = rest.exchange(
                url("/api/v1/sites/" + site + "/preisfassungen"), HttpMethod.GET,
                new HttpEntity<>(bearer(token)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    private ResponseEntity<String> putSite(String token, String site, String tarifArt, String param,
            String gueltigAb) {
        Map<String, Object> body = new HashMap<>();
        body.put("name", "Preisfassung Haus");
        body.put("biddingZone", "CH");
        body.put("plantKind", "eigenverbrauch");
        body.put("tarifArt", tarifArt);
        body.put("tarifParamCtKwh", param == null ? null : new java.math.BigDecimal(param));
        body.put("tarifGueltigAb", gueltigAb);
        return put(token, "/api/v1/sites/" + site, body);
    }

    private ResponseEntity<String> put(String token, String path, Map<String, Object> body) {
        return rest.exchange(url(path), HttpMethod.PUT, new HttpEntity<>(body, bearer(token)), String.class);
    }

    private String createSite(String token, String name, String tarifArt, String param) {
        Map<String, Object> payload = new HashMap<>(Map.of("name", name, "biddingZone", "CH",
                "plantKind", "eigenverbrauch", "tarifArt", tarifArt));
        if (param != null) {
            payload.put("tarifParamCtKwh", new java.math.BigDecimal(param));
        }
        ResponseEntity<Map<String, Object>> created = rest.exchange(url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(payload, bearer(token)), new ParameterizedTypeReference<>() {});
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return (String) created.getBody().get("id");
    }

    private static double num(Map<String, Object> obj, String key) {
        Object v = obj.get(key);
        assertThat(v).as(key).isInstanceOf(Number.class);
        return ((Number) v).doubleValue();
    }

    private static void exec(String sql) {
        try (Connection c = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                Statement st = c.createStatement()) {
            st.execute(sql);
        } catch (Exception e) {
            throw new IllegalStateException("seed failed: " + sql, e);
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
        @SuppressWarnings("unchecked")
        Map<String, Object> body = new TestRestTemplate().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).as("token response").containsKey("access_token");
        return (String) body.get("access_token");
    }
}
