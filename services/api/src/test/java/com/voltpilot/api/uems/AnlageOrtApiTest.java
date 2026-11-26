package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.TestDatenbank;
import com.voltpilot.api.TestKeycloak;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureTestRestTemplate;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.boot.resttestclient.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
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
 * „Ort berichtigen" ({@link AnlageOrtController}, vp-standort-konzept §6.1/§6.6, B1/B3/B6) Ende
 * zu Ende gegen echtes Keycloak + TimescaleDB: EIN Schreibweg setzt Adresse und Lage des
 * Standorts, den Punkt der Anlage und die vom Land abgeleitete Gebotszone — und zieht die
 * Geschwister-Anlagen eines Standorts nach der Regel aus §6.6 mit (oder eben nicht).
 */
@Testcontainers(disabledWithoutDocker = true)
@AutoConfigureTestRestTemplate
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class AnlageOrtApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";

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

    @MockitoBean FlowDeploymentPublisher flowDeploymentPublisher;

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    private static JdbcTemplate root;
    private static final Map<String, String> TOKENS = new ConcurrentHashMap<>();

    private record Anrufer(String benutzer, UUID kundenbereich) {}

    private static final Anrufer ADMIN_OHNE_KUNDENBEREICH = new Anrufer("admin", null);

    @BeforeAll
    static void verbinden() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    @BeforeEach
    void mockVorbereiten() {
        when(flowDeploymentPublisher.publishDeployment(any(), any(), any(), any())).thenReturn(true);
    }

    // ---- Eine Anlage, ein Standort ------------------------------------------------------------

    @Test
    void berichtigtAdresseUndPinInEinemZugUndBautDieBoxNeu() {
        Welt w = ahrenberg();
        String anlage = anlage(w.wer(), "Halle 1", w.standort(), "48.950000", "10.920000");
        gatewayAnlegen(w.tenant(), anlage);

        ResponseEntity<JsonNode> r = rufe(HttpMethod.PUT, "/sites/" + anlage + "/ort", w.wer(), Map.of(
                "adresse", Map.of("strasse", "Hauptplatz 1", "ort", "Wien", "land", "AT"),
                "lage", Map.of("breitengrad", "48.208500", "laengengrad", "16.373800")));
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(200);
        JsonNode body = r.getBody();
        assertThat(body.at("/standort/adresse/ort").asText()).isEqualTo("Wien");
        assertThat(body.at("/standort/adresse/land").asText()).isEqualTo("AT");
        assertThat(body.at("/standort/lage/breitengrad").decimalValue()).isEqualByComparingTo("48.208500");
        assertThat(body.at("/site/latitude").decimalValue()).isEqualByComparingTo("48.208500");
        assertThat(body.at("/site/longitude").decimalValue()).isEqualByComparingTo("16.373800");
        // B6: die Gebotszone folgt dem Land, niemand trägt sie von Hand ein.
        assertThat(body.at("/site/biddingZone").asText()).isEqualTo("AT");
        assertThat(body.get("boxZugestellt").asBoolean()).as("Gateway vorhanden, Bündel wird zugestellt").isTrue();
        assertThat(body.get("wetterNachholungAngestossen").asBoolean())
                .as("Wien liegt weit vom alten Punkt (B1-Fall)").isTrue();
        assertThat(offeneWetterNachholung(anlage)).isEqualTo(1);

        // Die Datenbank zeigt EINEN Punkt - kein Auseinanderlaufen mehr (B3).
        BigDecimal standortBreite = root.queryForObject(
                "SELECT lage_breitengrad FROM standort WHERE id = (SELECT standort_id FROM anlage_standort "
                        + "WHERE site_id = ?::uuid AND aufgehoben_am IS NULL)", BigDecimal.class, anlage);
        BigDecimal siteBreite = root.queryForObject("SELECT latitude FROM site WHERE id = ?::uuid",
                BigDecimal.class, anlage);
        assertThat(siteBreite).isEqualTo(standortBreite);
    }

    @Test
    void ohneLageWirdAbgelehntUndSchreibtNichts() {
        Welt w = ahrenberg();
        String anlage = anlage(w.wer(), "Halle 2", w.standort(), "48.950000", "10.920000");
        BigDecimal vorher = root.queryForObject("SELECT latitude FROM site WHERE id = ?::uuid", BigDecimal.class,
                anlage);

        ResponseEntity<JsonNode> r = rufe(HttpMethod.PUT, "/sites/" + anlage + "/ort", w.wer(),
                Map.of("adresse", Map.of("strasse", "Hauptplatz 1", "ort", "Wien", "land", "AT")));
        assertThat(r.getStatusCode().value()).isEqualTo(400);
        assertThat(r.getBody().get("code").asText()).isEqualTo("anfrage_ungueltig");
        assertThat(r.getBody().get("feld").asText()).isEqualTo("lage");

        BigDecimal nachher = root.queryForObject("SELECT latitude FROM site WHERE id = ?::uuid", BigDecimal.class,
                anlage);
        assertThat(nachher).isEqualTo(vorher);
    }

    @Test
    void fremdeAnlageIst404() {
        ResponseEntity<JsonNode> r = rufe(HttpMethod.PUT, "/sites/" + UUID.randomUUID() + "/ort",
                ADMIN_OHNE_KUNDENBEREICH, Map.of("adresse", Map.of("strasse", "X 1", "ort", "Y", "land", "DE"),
                        "lage", Map.of("breitengrad", "48.0", "laengengrad", "10.0")));
        assertThat(r.getStatusCode().value()).isEqualTo(404);
    }

    // ---- Mehrere Anlagen an einem Standort (§6.6) ---------------------------------------------

    @Test
    void unterZweiKilometernZiehtNurDieAnlageAufDemAltenStandortpunktMit() {
        Welt w = ahrenberg();
        // AN-A wird berichtigt; AN-B liegt noch genau auf dem Standortpunkt (zieht mit);
        // AN-C wurde früher auf einen eigenen Punkt gezogen (bleibt stehen).
        String anA = anlage(w.wer(), "Halle A", w.standort(), "48.950000", "10.920000");
        String anB = anlage(w.wer(), "Halle B", w.standort(), "48.950000", "10.920000");
        String anC = anlage(w.wer(), "Halle C", w.standort(), "48.950000", "10.920000");
        root.update("UPDATE site SET latitude = '48.951200', longitude = '10.921500' WHERE id = ?::uuid", anC);

        ResponseEntity<JsonNode> r = rufe(HttpMethod.PUT, "/sites/" + anA + "/ort", w.wer(), Map.of(
                "adresse", Map.of("strasse", "Gewerbering 9", "ort", "Ahrenberg", "land", "DE"),
                "lage", Map.of("breitengrad", "48.951000", "laengengrad", "10.921000")));
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(200);
        assertThat(r.getBody().get("wetterNachholungAngestossen").asBoolean()).isFalse();

        erwartePunkt(punkt(anA), bd("48.951000"), bd("10.921000"));
        erwartePunkt(punkt(anB), bd("48.951000"), bd("10.921000"));
        erwartePunkt(punkt(anC), bd("48.951200"), bd("10.921500"));
        assertThat(offeneWetterNachholung(anA) + offeneWetterNachholung(anB) + offeneWetterNachholung(anC))
                .as("unter 2 km: kein Wetter wird verworfen").isZero();
    }

    @Test
    void mehrAlsZweiKilometerZiehtJedeAnlageMitDerselbenVerschiebungMit() {
        Welt w = ahrenberg();
        String anA = anlage(w.wer(), "Halle A", w.standort(), "48.950000", "10.920000");
        String anB = anlage(w.wer(), "Halle B", w.standort(), "48.950000", "10.920000");
        String anC = anlage(w.wer(), "Halle C", w.standort(), "48.950000", "10.920000");
        root.update("UPDATE site SET latitude = '48.951200', longitude = '10.921500' WHERE id = ?::uuid", anC);

        // Neuer Punkt > 2 km vom alten Standortpunkt (48.950000, 10.920000) entfernt.
        ResponseEntity<JsonNode> r = rufe(HttpMethod.PUT, "/sites/" + anA + "/ort", w.wer(), Map.of(
                "adresse", Map.of("strasse", "Lindenweg 54", "ort", "Treuchtlingen", "land", "DE"),
                "lage", Map.of("breitengrad", "48.970000", "laengengrad", "10.940000")));
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(200);
        assertThat(r.getBody().get("wetterNachholungAngestossen").asBoolean()).isTrue();

        BigDecimal deltaBreite = bd("48.970000").subtract(bd("48.950000"));
        BigDecimal deltaLaenge = bd("10.940000").subtract(bd("10.920000"));
        erwartePunkt(punkt(anA), bd("48.970000"), bd("10.940000"));
        erwartePunkt(punkt(anB), bd("48.950000").add(deltaBreite), bd("10.920000").add(deltaLaenge));
        erwartePunkt(punkt(anC), bd("48.951200").add(deltaBreite), bd("10.921500").add(deltaLaenge));
        assertThat(offeneWetterNachholung(anA)).isEqualTo(1);
        assertThat(offeneWetterNachholung(anB)).isEqualTo(1);
        assertThat(offeneWetterNachholung(anC)).isEqualTo(1);
    }

    // ---- Gerüst --------------------------------------------------------------------------------

    private record Welt(UUID tenant, Anrufer wer, String standort) {}

    private Welt ahrenberg() {
        ResponseEntity<JsonNode> t = rufe(HttpMethod.POST, "/admin/tenants", ADMIN_OHNE_KUNDENBEREICH,
                Map.of("name", "Kunststoffwerk Ahrenberg GmbH"));
        assertThat(t.getStatusCode().value()).as(String.valueOf(t.getBody())).isEqualTo(201);
        UUID tenant = UUID.fromString(t.getBody().get("id").asText());
        Anrufer wer = new Anrufer("admin", tenant);
        ResponseEntity<JsonNode> s = rufe(HttpMethod.POST, "/standorte", wer,
                Map.of("name", "Werk Ahrenberg", "zeitzone", "Europe/Berlin",
                        "adresse", Map.of("strasse", "Gewerbering 7", "ort", "Ahrenberg", "land", "DE"),
                        "lage", Map.of("breitengrad", "48.950000", "laengengrad", "10.920000")));
        assertThat(s.getStatusCode().value()).as(String.valueOf(s.getBody())).isEqualTo(201);
        return new Welt(tenant, wer, s.getBody().get("id").asText());
    }

    private String anlage(Anrufer wer, String name, String standortId, String breite, String laenge) {
        ResponseEntity<JsonNode> r = rufe(HttpMethod.POST, "/sites", wer,
                Map.of("name", name, "standortId", standortId));
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(201);
        String id = r.getBody().get("id").asText();
        root.update("UPDATE site SET latitude = ?::numeric, longitude = ?::numeric WHERE id = ?::uuid",
                breite, laenge, id);
        return id;
    }

    private void gatewayAnlegen(UUID tenant, String anlage) {
        root.update("INSERT INTO device (tenant_id, site_id, external_ref, kind, status) VALUES (?,?,?,?,?)",
                tenant, UUID.fromString(anlage), "VP-GW-" + tenant.toString().substring(0, 8), "gateway", "claimed");
    }

    private static BigDecimal bd(String s) {
        return new BigDecimal(s);
    }

    /** Scale-unabhängig (NUMERIC(9,6) rundet ohnehin) - der Vergleich ist numerisch, nicht textuell. */
    private List<BigDecimal> punkt(String siteId) {
        return root.queryForObject("SELECT latitude, longitude FROM site WHERE id = ?::uuid",
                (rs, n) -> List.of(rs.getBigDecimal(1), rs.getBigDecimal(2)), siteId);
    }

    private static void erwartePunkt(List<BigDecimal> tatsaechlich, BigDecimal breite, BigDecimal laenge) {
        assertThat(tatsaechlich).hasSize(2);
        assertThat(tatsaechlich.get(0)).isEqualByComparingTo(breite);
        assertThat(tatsaechlich.get(1)).isEqualByComparingTo(laenge);
    }

    private int offeneWetterNachholung(String siteId) {
        Integer n = root.queryForObject("SELECT count(*) FROM ort_wetter_nachholung "
                + "WHERE site_id = ?::uuid AND erledigt_am IS NULL", Integer.class, siteId);
        return n == null ? 0 : n;
    }

    private ResponseEntity<JsonNode> rufe(HttpMethod methode, String pfad, Anrufer wer, Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token(wer.benutzer()));
        if (wer.kundenbereich() != null) {
            headers.set("X-Tenant-Id", wer.kundenbereich().toString());
        }
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<?> entity = body == null ? new HttpEntity<>(headers) : new HttpEntity<>(body, headers);
        return rest.exchange("http://localhost:" + port + "/api/v1" + pfad, methode, entity, JsonNode.class);
    }

    private String token(String benutzer) {
        return TOKENS.computeIfAbsent(benutzer, b -> {
            MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
            form.add("grant_type", "password");
            form.add("client_id", "voltpilot-api");
            form.add("client_secret", "voltpilot-api-dev-secret");
            form.add("username", b);
            form.add("password", b);
            form.add("scope", "openid");
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
            @SuppressWarnings("unchecked")
            Map<String, Object> antwort = new TestRestTemplate().postForObject(
                    KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                    new HttpEntity<>(form, headers), Map.class);
            assertThat(antwort).as("token response").containsKey("access_token");
            return (String) antwort.get("access_token");
        });
    }
}
