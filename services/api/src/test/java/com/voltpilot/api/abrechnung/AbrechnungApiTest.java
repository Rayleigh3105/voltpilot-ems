package com.voltpilot.api.abrechnung;

import static org.assertj.core.api.Assertions.assertThat;

import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.TestRestTemplate;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureTestRestTemplate;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
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
 * Abrechnung prüfen (Bedienkonzept vp-privatkunde-bedienkonzept §9.3, Pakete R1-R3) Ende zu Ende gegen echtes
 * Keycloak + TimescaleDB:
 * <ul>
 *   <li><b>R1</b>: {@code /history?from=&to=} - ganze Tage, Eimer je Tag bis 92 Tage, darüber je Monat; ein
 *       Kalenderjahr als Zeitraum hat dieselben Summen wie {@code range=year};</li>
 *   <li><b>R2</b>: {@code /abrechnung} - Zählerfall (Stand am Vortag → Stand am letzten Tag, liest
 *       {@code energy_export_kwh}), Summe mit Lückentagen ohne Zähler, Messbeginn im Zeitraum, „nur
 *       Netzbezug";</li>
 *   <li><b>R3</b>: Prüfungen speichern, je Zeitraum eine Zeile, leeres Feld löscht, Liste; Tabelle mit RLS und
 *       FORCE; Mandant aus dem Token;</li>
 *   <li>der Mandantenzaun: fremd ist 404, nie 403 und nie fremde Zahlen.</li>
 * </ul>
 * Die Rolle ohne Schreibrecht ({@code einsicht}) prüft {@code RechtMatrixApiTest} für jede Schreibroute.
 */
@Testcontainers(disabledWithoutDocker = true)
@AutoConfigureTestRestTemplate
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class AbrechnungApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";

    /** Netz-Zähler mit Zählerständen (Bezug und Einspeisung) und Tageswerten. */
    private static final String SITE_ZAEHLER = "abcabc00-0000-0000-0000-000000000001";
    /** Keine Zählerstände, nur Tageswerte mit drei Lückentagen, nie Einspeisung oder Erzeugung. */
    private static final String SITE_SUMME = "abcabc00-0000-0000-0000-000000000002";
    /** Misst erst seit dem 07.09.2026. */
    private static final String SITE_SPAETER = "abcabc00-0000-0000-0000-000000000003";
    private static final String NETZ_ZAEHLER = "abcabc00-0000-0000-0000-0000000000f1";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
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

    @Autowired
    JdbcTemplate appJdbc;

    private static boolean gesaet;

    /** Sät einmal je Lauf (die Migrationen laufen erst mit dem Spring-Kontext). */
    private void saeen() {
        if (gesaet) {
            return;
        }
        JdbcTemplate su = superuser();
        for (String[] s : List.of(new String[] {SITE_ZAEHLER, "Haus Zähler"}, new String[] {SITE_SUMME, "Haus Summe"},
                new String[] {SITE_SPAETER, "Haus Später"})) {
            su.update("INSERT INTO site (id, tenant_id, name) VALUES (?::uuid, ?::uuid, ?) ON CONFLICT DO NOTHING",
                    s[0], TENANT_A, s[1]);
        }
        // Tageswerte (v1): 2025 ganz und September 2026; Bezug 10, Einspeisung 5, Erzeugung 20 kWh je Tag.
        tageswerte(su, SITE_ZAEHLER, "2025-01-01", "2025-12-31", "20", "5");
        tageswerte(su, SITE_ZAEHLER, "2026-08-31", "2026-09-30", "20", "5");
        // Zähler am Netzanschluss (v2-Tagesend-Stände): je Tag +10,5 kWh Bezug, +5 kWh Einspeisung.
        su.update("INSERT INTO measurement_point (id, tenant_id, site_id, role, label, entity_type) "
                + "VALUES (?::uuid, ?::uuid, ?::uuid, 'grid-meter', 'Netzanschluss', 'grid-meter') "
                + "ON CONFLICT DO NOTHING", NETZ_ZAEHLER, TENANT_A, SITE_ZAEHLER);
        zaehler(su, "energy_kwh", "12455.0", "10.5");
        zaehler(su, "energy_export_kwh", "30118.0", "5.0");

        // Summe ohne Zähler: September ohne den 12.–14., keine Einspeisung, keine Erzeugung.
        tageswerte(su, SITE_SUMME, "2026-09-01", "2026-09-30", "0", "0");
        su.update("DELETE FROM telemetry_rollup_1d WHERE site_id = ?::uuid AND bucket >= "
                + "('2026-09-12'::date::timestamp AT TIME ZONE 'Europe/Berlin') AND bucket < "
                + "('2026-09-15'::date::timestamp AT TIME ZONE 'Europe/Berlin')", SITE_SUMME);
        // Später Messbeginn.
        tageswerte(su, SITE_SPAETER, "2026-09-07", "2026-09-30", "20", "5");
        gesaet = true;
    }

    private static void tageswerte(JdbcTemplate su, String site, String von, String bis, String pv, String export) {
        su.update("INSERT INTO telemetry_rollup_1d (bucket, tenant_id, site_id, pv_kwh, load_kwh, grid_import_kwh, "
                + "grid_export_kwh, battery_charge_kwh, battery_discharge_kwh, n_samples) "
                + "SELECT (d::date::timestamp AT TIME ZONE 'Europe/Berlin'), ?::uuid, ?::uuid, " + pv + ", 25, 10, "
                + export + ", 0, 0, 96 FROM generate_series(?::date, ?::date, interval '1 day') d "
                + "ON CONFLICT DO NOTHING", TENANT_A, site, von, bis);
    }

    /** Ein Zähler: Stand {@code start} am Ende des 31.08.2026, danach je Tag {@code jeTag} mehr bis 30.09.2026. */
    private static void zaehler(JdbcTemplate su, String kanal, String start, String jeTag) {
        su.update("INSERT INTO telemetry_v2_rollup_1d (bucket, tenant_id, site_id, entity_id, channel, avg_value, "
                + "min_value, max_value, last_value, n_samples) "
                + "SELECT (d::date::timestamp AT TIME ZONE 'Europe/Berlin'), ?::uuid, ?::uuid, ?, ?, "
                + "s + " + jeTag + " / 2, s, s + " + jeTag + ", s + " + jeTag + ", 96 FROM ("
                + "  SELECT d, " + start + " - " + jeTag + " + " + jeTag + " * (d::date - '2026-08-31'::date) AS s "
                + "  FROM generate_series('2026-08-31'::date, '2026-09-30'::date, interval '1 day') d) x",
                TENANT_A, SITE_ZAEHLER, NETZ_ZAEHLER, kanal);
    }

    // ---- R1 ----------------------------------------------------------------------------------------------------

    @Test
    void zeitraumBis92TageHatTageseimer() {
        saeen();
        Map<String, Object> h = get("/api/v1/sites/" + SITE_ZAEHLER + "/history?from=2026-09-01&to=2026-09-30",
                token("demo"));
        assertThat(h.get("range")).isEqualTo("zeitraum");
        assertThat(h.get("bucketMinutes")).isEqualTo(1440);
        assertThat((List<?>) h.get("buckets")).hasSize(30);
        assertThat(String.valueOf(h.get("from"))).startsWith("2026-08-31T22:00");
        assertThat(String.valueOf(h.get("to"))).startsWith("2026-09-30T22:00");
        Map<?, ?> totals = (Map<?, ?>) h.get("totals");
        assertThat(((Number) totals.get("gridImportKwh")).doubleValue()).isEqualTo(300.0);
        assertThat((List<?>) h.get("protocol")).isEmpty();
    }

    @Test
    void einKalenderjahrAlsZeitraumIstDasJahr() {
        saeen();
        String t = token("demo");
        Map<String, Object> zeitraum = get("/api/v1/sites/" + SITE_ZAEHLER + "/history?from=2025-01-01&to=2025-12-31", t);
        Map<String, Object> jahr = get("/api/v1/sites/" + SITE_ZAEHLER + "/history?range=year&at=2025-06-15", t);
        assertThat(zeitraum.get("bucketMinutes")).isEqualTo(0);
        assertThat((List<?>) zeitraum.get("buckets")).hasSize(12);
        assertThat((List<?>) jahr.get("buckets")).hasSize(365);
        assertThat(zeitraum.get("totals")).isEqualTo(jahr.get("totals"));
        assertThat(zeitraum.get("from")).isEqualTo(jahr.get("from"));
        assertThat(zeitraum.get("to")).isEqualTo(jahr.get("to"));
        Map<?, ?> februar = (Map<?, ?>) ((List<?>) zeitraum.get("buckets")).get(1);
        assertThat(String.valueOf(februar.get("start"))).startsWith("2025-01-31T23:00");
        assertThat(((Number) februar.get("gridImportKwh")).doubleValue()).isEqualTo(280.0);
    }

    @Test
    void ungueltigerZeitraumIst400() {
        saeen();
        String t = token("demo");
        assertThat(status("/api/v1/sites/" + SITE_ZAEHLER + "/history?from=2026-09-30&to=2026-09-01", t))
                .isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(status("/api/v1/sites/" + SITE_ZAEHLER + "/history?from=2026-09-01", t))
                .isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(status("/api/v1/sites/" + SITE_ZAEHLER + "/history?from=2026-09-01&to=2099-01-01", t))
                .isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(status("/api/v1/sites/" + SITE_ZAEHLER + "/abrechnung?von=2020-01-01&bis=2026-09-01", t))
                .isEqualTo(HttpStatus.BAD_REQUEST);
    }

    // ---- R2 ----------------------------------------------------------------------------------------------------

    @Test
    void mitZaehlerStandAmVortagBisStandAmLetztenTag() {
        saeen();
        Map<String, Object> a = get("/api/v1/sites/" + SITE_ZAEHLER + "/abrechnung?von=2026-09-01&bis=2026-09-30",
                token("demo"));
        assertThat(a.get("tage")).isEqualTo(30);
        assertThat(a.get("messbeginn")).isEqualTo("2025-01-01");
        assertThat(a.get("tageVorMessbeginn")).isEqualTo(0);
        Map<?, ?> bezug = (Map<?, ?>) a.get("bezug");
        assertThat(bezug.get("herkunft")).isEqualTo("zaehler");
        assertThat(((Number) bezug.get("standVonKwh")).doubleValue()).isEqualTo(12455.0);
        assertThat(((Number) bezug.get("standBisKwh")).doubleValue()).isEqualTo(12770.0);
        assertThat(((Number) bezug.get("mengeKwh")).doubleValue()).isEqualTo(315.0);
        assertThat((List<?>) bezug.get("luecken")).isEmpty();
        // Der Einspeise-Zähler wird gelesen (energy_export_kwh).
        Map<?, ?> einspeisung = (Map<?, ?>) a.get("einspeisung");
        assertThat(einspeisung.get("herkunft")).isEqualTo("zaehler");
        assertThat(((Number) einspeisung.get("standVonKwh")).doubleValue()).isEqualTo(30118.0);
        assertThat(((Number) einspeisung.get("mengeKwh")).doubleValue()).isEqualTo(150.0);
        assertThat(a.get("rechnung")).isNull();
    }

    @Test
    @SuppressWarnings("unchecked")
    void ohneZaehlerDieSummeMitLueckentagenUndOhneEinspeisung() {
        saeen();
        Map<String, Object> a = get("/api/v1/sites/" + SITE_SUMME + "/abrechnung?von=2026-09-01&bis=2026-09-30",
                token("demo"));
        Map<?, ?> bezug = (Map<?, ?>) a.get("bezug");
        assertThat(bezug.get("herkunft")).isEqualTo("summe");
        assertThat(((Number) bezug.get("mengeKwh")).doubleValue()).isEqualTo(270.0);
        assertThat(bezug.get("standVonKwh")).isNull();
        assertThat(bezug.get("fehlendeTage")).isEqualTo(3);
        assertThat((List<Object>) bezug.get("luecken"))
                .containsExactly((Object) Map.of("von", "2026-09-12", "bis", "2026-09-14"));
        assertThat(a.get("einspeisung")).as("nur Netzbezug").isNull();
    }

    @Test
    void messbeginnImZeitraum() {
        saeen();
        Map<String, Object> a = get("/api/v1/sites/" + SITE_SPAETER + "/abrechnung?von=2026-09-01&bis=2026-09-30",
                token("demo"));
        assertThat(a.get("messbeginn")).isEqualTo("2026-09-07");
        assertThat(a.get("tageVorMessbeginn")).isEqualTo(6);
        Map<?, ?> bezug = (Map<?, ?>) a.get("bezug");
        assertThat(((Number) bezug.get("mengeKwh")).doubleValue()).isEqualTo(240.0);
        assertThat((List<?>) bezug.get("luecken")).as("vor dem Messbeginn ist keine Lücke").isEmpty();
    }

    // ---- R3 ----------------------------------------------------------------------------------------------------

    @Test
    void pruefungSpeichernJeZeitraumUndLeeresFeldLoescht() {
        saeen();
        String t = token("demo");
        String basis = "/api/v1/sites/" + SITE_ZAEHLER + "/abrechnung/pruefung";
        ResponseEntity<Map<String, Object>> put = put(basis + "?von=2026-09-01&bis=2026-09-30",
                Map.of("bezugKwh", 312.4), t);
        assertThat(put.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(((Number) put.getBody().get("bezugKwh")).doubleValue()).isEqualTo(312.4);
        assertThat(put.getBody().get("einspeisungKwh")).isNull();
        // Ein zweiter Zeitraum ist eine zweite Zeile.
        assertThat(put(basis + "?von=2025-01-01&bis=2025-12-31", Map.of("einspeisungKwh", 1800), t)
                .getStatusCode()).isEqualTo(HttpStatus.OK);

        List<Map<String, Object>> liste = list("/api/v1/sites/" + SITE_ZAEHLER + "/abrechnung/pruefungen", t);
        assertThat(liste).extracting(m -> m.get("von")).containsExactly("2026-09-01", "2025-01-01");

        Map<String, Object> a = get("/api/v1/sites/" + SITE_ZAEHLER + "/abrechnung?von=2026-09-01&bis=2026-09-30", t);
        assertThat(((Number) ((Map<?, ?>) a.get("rechnung")).get("bezugKwh")).doubleValue()).isEqualTo(312.4);

        // Mandant aus dem Token, Tabelle mit RLS und FORCE.
        JdbcTemplate su = superuser();
        assertThat(su.queryForObject("SELECT tenant_id::text FROM abrechnung_pruefung WHERE site_id = ?::uuid "
                + "AND von = '2026-09-01'", String.class, SITE_ZAEHLER)).isEqualTo(TENANT_A);
        assertThat(su.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                + "WHERE relname = 'abrechnung_pruefung'", Boolean.class)).isTrue();
        assertThat(appJdbc.queryForObject("SELECT count(*) FROM abrechnung_pruefung", Integer.class))
                .as("ohne Mandanten-Kontext sieht die App-Rolle nichts").isZero();

        // Beide Felder leer: die Prüfung verschwindet.
        Map<String, Object> leer = new java.util.HashMap<>();
        leer.put("bezugKwh", null);
        leer.put("einspeisungKwh", null);
        assertThat(put(basis + "?von=2026-09-01&bis=2026-09-30", leer, t).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(status(basis + "?von=2026-09-01&bis=2026-09-30", t)).isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(exchange(basis + "?von=2025-01-01&bis=2025-12-31", HttpMethod.DELETE, null, t).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(list("/api/v1/sites/" + SITE_ZAEHLER + "/abrechnung/pruefungen", t)).isEmpty();

        assertThat(put(basis + "?von=2026-09-01&bis=2026-09-30", Map.of("bezugKwh", -1), t).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
    }

    @Test
    void fremderMandantSiehtNichtsUndSchreibtNichts() {
        saeen();
        String fremd = token("demo2");
        assertThat(status("/api/v1/sites/" + SITE_ZAEHLER + "/abrechnung?von=2026-09-01&bis=2026-09-30", fremd))
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(status("/api/v1/sites/" + SITE_ZAEHLER + "/history?from=2026-09-01&to=2026-09-30", fremd))
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(status("/api/v1/sites/" + SITE_ZAEHLER + "/abrechnung/pruefungen", fremd))
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(put("/api/v1/sites/" + SITE_ZAEHLER + "/abrechnung/pruefung?von=2026-09-01&bis=2026-09-30",
                Map.of("bezugKwh", 1), fremd).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(superuser().queryForObject("SELECT count(*) FROM abrechnung_pruefung WHERE bezug_kwh = 1",
                Integer.class)).isZero();
    }

    // ---- Hilfen ------------------------------------------------------------------------------------------------

    private JdbcTemplate superuser() {
        return new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    private Map<String, Object> get(String path, String token) {
        ResponseEntity<Map<String, Object>> r = exchange(path, HttpMethod.GET, null, token);
        assertThat(r.getStatusCode()).as(path).isEqualTo(HttpStatus.OK);
        return r.getBody();
    }

    private List<Map<String, Object>> list(String path, String token) {
        ResponseEntity<List<Map<String, Object>>> r = rest.exchange(url(path), HttpMethod.GET,
                new HttpEntity<>(headers(token)), new ParameterizedTypeReference<>() { });
        assertThat(r.getStatusCode()).isEqualTo(HttpStatus.OK);
        return r.getBody();
    }

    private HttpStatus status(String path, String token) {
        return HttpStatus.valueOf(rest.exchange(url(path), HttpMethod.GET, new HttpEntity<>(headers(token)),
                String.class).getStatusCode().value());
    }

    private ResponseEntity<Map<String, Object>> put(String path, Map<String, Object> body, String token) {
        return exchange(path, HttpMethod.PUT, body, token);
    }

    private ResponseEntity<Map<String, Object>> exchange(String path, HttpMethod m, Object body, String token) {
        return rest.exchange(url(path), m, new HttpEntity<>(body, headers(token)),
                new ParameterizedTypeReference<>() { });
    }

    private static HttpHeaders headers(String token) {
        HttpHeaders h = new HttpHeaders();
        h.setBearerAuth(token);
        h.setContentType(MediaType.APPLICATION_JSON);
        return h;
    }

    private String url(String path) {
        return "http://localhost:" + port + path;
    }

    private String token(String user) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", "voltpilot-api");
        form.add("client_secret", "voltpilot-api-dev-secret");
        form.add("username", user);
        form.add("password", user);
        form.add("scope", "openid");
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        @SuppressWarnings("unchecked")
        Map<String, Object> body = new TestRestTemplate().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, h), Map.class);
        assertThat(body).containsKey("access_token");
        return (String) body.get("access_token");
    }
}
