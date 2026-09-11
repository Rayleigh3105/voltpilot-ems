package com.voltpilot.api.measurement;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.StreamSupport;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
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
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Das Messkanal-Read-Model (UEMS AP-04 IP-9) Ende zu Ende gegen echtes Keycloak + TimescaleDB.
 * Der Bestand ist das Referenzunternehmen ({@code docs/contracts/v2/uems-referenzunternehmen.json})
 * mit dessen Namen und Werten: Anlage AN-1, Box E-1, Netzzähler K-3 mit seinen drei Kanälen
 * über DQ-2 (Kadenz 10 s) und der Unterzähler K-4.
 *
 * <p>Bewiesen wird: K-3 hat genau drei Kanäle, jeder mit Richtung, Größe, Einheit und Wertart
 * aus dem Katalog; Selbstbau bleibt ohne Wertart/Größe/Richtung; Gerät und „speist“ sind bis
 * IP-10/IP-13 leer; eine fremde Komponente — anderer Kundenbereich, andere Anlage, unbekannt —
 * ist 404, nie 403.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class MesskanalApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path REPO = Path.of("..", "..");
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Container
    static final KeycloakContainer KEYCLOAK = new KeycloakContainer(
            "quay.io/keycloak/keycloak:26.0.5")
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

    private static JsonNode referenz;
    private static JdbcTemplate root;
    /** Der Bestand entsteht EINMAL: die Seriennummer der Box E-1 ist plattformweit eindeutig. */
    private static Bestand bestand;
    private static final Map<String, String> TOKENS = new ConcurrentHashMap<>();

    /** Die drei Kanäle von K-3 — ein SunSpec-Zweirichtungszähler (Modell 203) über DQ-2. */
    private static final List<String> K3_KANAELE = List.of(
            "sunspec.model_203.totwhexp", "sunspec.model_203.totwhimp", "sunspec.model_203.w");

    @BeforeAll
    static void ladeReferenz() throws IOException {
        referenz = MAPPER.readTree(REPO.resolve("docs/contracts/v2/uems-referenzunternehmen.json").toFile());
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    /** Kundenbereich, Anlagen AN-1/AN-2, Box E-1 und die Komponenten K-3/K-4 der Referenz. */
    private record Bestand(UUID tenant, UUID an1, UUID an2, UUID box, UUID k3, UUID k4) {}

    private static synchronized Bestand ahrenberg() {
        if (bestand == null) {
            bestand = anlegen();
        }
        return bestand;
    }

    private static Bestand anlegen() {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                referenz.at("/unternehmen/name").asText());
        UUID an1 = anlage(t, "AN-1");
        UUID an2 = anlage(t, "AN-2");
        JsonNode e1 = eintrag("boxen", "E-1");
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, kind, status) "
                + "VALUES (?, ?, ?, 'inverter', 'claimed') RETURNING id", UUID.class, t, an1,
                e1.get("seriennummer").asText());
        UUID k3 = komponente(t, an1, box, "K-3", "grid-meter");
        UUID k4 = komponente(t, an1, box, "K-4", "grid-meter");
        int kadenz = eintrag("datenquellen", "DQ-2").get("kadenz_s").asInt();
        assertThat(eintrag("datenquellen", "DQ-2").get("kanaele").asInt()).isEqualTo(K3_KANAELE.size());
        for (String kanal : K3_KANAELE) {
            auswahl(t, an1, box, k3, kanal, kadenz, null);
        }
        // K-4 liest seine „Wirkenergie Bezug“ über ein freies Register (Selbstbau).
        auswahl(t, an1, box, k4, "custom.modbus_holding.0x0048", 60,
                "{\"label\":\"Wirkenergie Bezug\",\"unit\":\"kWh\",\"cadenceS\":60}");
        return new Bestand(t, an1, an2, box, k3, k4);
    }

    private static UUID anlage(UUID tenant, String kennzeichen) {
        return root.queryForObject("INSERT INTO site (tenant_id, name, bidding_zone) VALUES (?, ?, 'DE-LU') "
                + "RETURNING id", UUID.class, tenant, eintrag("anlagen", kennzeichen).get("name").asText());
    }

    private static UUID komponente(UUID tenant, UUID site, UUID box, String kennzeichen, String rolle) {
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, device_id) "
                + "VALUES (?, ?, ?, ?, ?) RETURNING id", UUID.class, tenant, site, rolle,
                eintrag("komponenten", kennzeichen).get("name").asText(), box);
    }

    private static void auswahl(UUID tenant, UUID site, UUID box, UUID entity, String kanal, int kadenz,
            String selbstbau) {
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, "
                + "point_key, enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, "
                + "apply_status, custom_definition, retention_class, long_term_strategy) "
                + "VALUES (?, ?, ?, ?, ?, true, ?, 1, now(), '2026.08.26.3', 'test', 'pending_edge', "
                + "?::jsonb, 'energy_counter', 'fifteen_minute')",
                tenant, site, box, entity, kanal, kadenz, selbstbau);
    }

    private static JsonNode eintrag(String liste, String kennzeichen) {
        for (JsonNode n : referenz.get(liste)) {
            if (n.get("kennzeichen").asText().equals(kennzeichen)) {
                return n;
            }
        }
        throw new AssertionError("kein Eintrag " + liste + "/" + kennzeichen);
    }

    // ---- K-3: drei Kanäle mit Richtung ----------------------------------------------

    @Test
    void derNetzzaehlerK3HatDreiKanaeleMitRichtungGroesseEinheitUndWertart() throws IOException {
        Bestand b = ahrenberg();
        ResponseEntity<JsonNode> r = rufe(b.an1(), b.k3(), "admin", b.tenant());
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(200);
        JsonNode liste = r.getBody();
        assertThat(liste.get("site_id").asText()).isEqualTo(b.an1().toString());
        assertThat(liste.get("komponente").asText()).isEqualTo(b.k3().toString());
        assertThat(liste.get("inhaltsstand").asText()).isEqualTo(
                Files.readString(REPO.resolve("catalog/measurement-points/VERSION")).strip());

        List<JsonNode> kanaele = StreamSupport.stream(liste.get("messkanaele").spliterator(), false).toList();
        assertThat(kanaele).extracting(k -> k.get("kanal").asText()).containsExactlyElementsOf(K3_KANAELE);
        assertThat(kanaele).as("jeder Kanal von K-3 trägt eine Richtung")
                .allSatisfy(k -> assertThat(k.get("direction").isNull()).isFalse());

        int kadenz = eintrag("datenquellen", "DQ-2").get("kadenz_s").asInt();
        for (JsonNode k : kanaele) {
            assertThat(k.get("kadenz_s").asInt()).isEqualTo(kadenz);
            assertThat(k.get("aktiv").asBoolean()).isTrue();
            assertThat(k.get("lesende_box").asText()).isEqualTo(b.box().toString());
            assertThat(k.get("geraet").isNull()).as("Gerät kommt mit IP-10").isTrue();
            assertThat(k.get("speist").isArray() && k.get("speist").isEmpty()).as("speist kommt mit IP-13").isTrue();
        }
        // Wirkenergie Abgabe · Wirkenergie Bezug (Zählerstand) · Wirkleistung — wie die Referenz.
        kanal(kanaele.get(0), "Total Watt-hours Exported", "Wh", "counter", "Wirkenergie", "Abgabe",
                "active_energy", "export");
        kanal(kanaele.get(1), "Total Watt-hours Imported", "Wh", "counter", "Wirkenergie", "Bezug",
                "active_energy", "import");
        // Der Vorzeichen-Wert am Zählpunkt: Größe Wirkleistung, aber keine EINE Vertrags-Richtung.
        kanal(kanaele.get(2), "Wirkleistung", "W", "gauge", "Wirkleistung", null, "active_power",
                "import_export");
        assertThat(kanaele).extracting(k -> k.get("wertart").asText()).containsExactlyInAnyOrder(
                "counter", "counter", "gauge");
    }

    private static void kanal(JsonNode k, String anzeigename, String einheit, String wertart, String groesse,
            String richtung, String quantity, String direction) {
        assertThat(text(k.get("anzeigename"))).isEqualTo(anzeigename);
        assertThat(text(k.get("einheit"))).isEqualTo(einheit);
        assertThat(text(k.get("wertart"))).isEqualTo(wertart);
        assertThat(text(k.get("groesse"))).isEqualTo(groesse);
        assertThat(text(k.get("richtung"))).isEqualTo(richtung);
        assertThat(text(k.get("quantity"))).isEqualTo(quantity);
        assertThat(text(k.get("direction"))).isEqualTo(direction);
    }

    @Test
    void selbstbauTraegtNameUndEinheitAberKeineWertartGroesseOderRichtung() {
        Bestand b = ahrenberg();
        JsonNode k = rufe(b.an1(), b.k4(), "admin", b.tenant()).getBody().get("messkanaele").get(0);
        assertThat(k.get("kanal").asText()).isEqualTo("custom.modbus_holding.0x0048");
        assertThat(k.get("anzeigename").asText()).isEqualTo("Wirkenergie Bezug");
        assertThat(k.get("einheit").asText()).isEqualTo("kWh");
        for (String leer : List.of("wertart", "groesse", "richtung", "quantity", "direction", "geraet")) {
            assertThat(k.get(leer).isNull()).as(leer).isTrue();
        }
        assertThat(k.get("kadenz_s").asInt()).isEqualTo(60);
    }

    @Test
    void eineAbgewaehlteAuswahlBleibtAlsKanalSichtbar() {
        Bestand b = ahrenberg();
        root.update("UPDATE device_measurement_selection SET enabled = false, disabled_at = now() "
                + "WHERE entity_id = ? AND point_key = ?", b.k4(), "custom.modbus_holding.0x0048");
        JsonNode kanaele = rufe(b.an1(), b.k4(), "admin", b.tenant()).getBody().get("messkanaele");
        assertThat(kanaele).hasSize(1);
        assertThat(kanaele.get(0).get("aktiv").asBoolean()).isFalse();
        assertThat(kanaele.get(0).get("kadenz_s").asInt()).isEqualTo(60);
    }

    // ---- Der Zaun: fremd ist 404, nie 403 ------------------------------------------

    @Test
    void eineFremdeKomponenteIst404NieEine403() {
        Bestand b = ahrenberg();
        UUID fremd = root.queryForObject("INSERT INTO tenant (name) VALUES ('Fremder Kundenbereich') "
                + "RETURNING id", UUID.class);
        assertThat(status(rufe(b.an1(), b.k3(), "admin", fremd))).isEqualTo(404);
        assertThat(status(rufe(b.an1(), b.k3(), "demo", null))).isEqualTo(404);
        assertThat(status(rufe(b.an1(), b.k3(), "demo2", null))).isEqualTo(404);
        // Eine eigene Komponente unter einer ANDEREN eigenen Anlage gibt es dort nicht.
        assertThat(status(rufe(b.an2(), b.k3(), "admin", b.tenant()))).isEqualTo(404);
        assertThat(status(rufe(b.an1(), UUID.randomUUID(), "admin", b.tenant()))).isEqualTo(404);
        ResponseEntity<JsonNode> unbekannt = rufe(UUID.randomUUID(), b.k3(), "admin", b.tenant());
        assertThat(status(unbekannt)).isEqualTo(404);
        assertThat(unbekannt.getBody().get("message").asText()).isEqualTo("Komponente nicht gefunden.");
        assertThat(status(rufe(b.an1(), b.k3(), null, null))).isEqualTo(401);
    }

    // ---- Gerüst ------------------------------------------------------------------

    private ResponseEntity<JsonNode> rufe(UUID site, UUID komponente, String benutzer, UUID kundenbereich) {
        HttpHeaders headers = new HttpHeaders();
        if (benutzer != null) {
            headers.setBearerAuth(token(benutzer));
            if (kundenbereich != null) {
                headers.set("X-Tenant-Id", kundenbereich.toString());
            }
        }
        return rest.exchange("http://localhost:" + port + "/api/v1/sites/" + site + "/komponenten/"
                + komponente + "/messkanaele", HttpMethod.GET, new HttpEntity<>(headers), JsonNode.class);
    }

    private static int status(ResponseEntity<?> r) {
        return r.getStatusCode().value();
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
            Map<String, Object> body = new TestRestTemplate().postForObject(
                    KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                    new HttpEntity<>(form, headers), Map.class);
            assertThat(body).as("token response").containsKey("access_token");
            return (String) body.get("access_token");
        });
    }

    private static String text(JsonNode n) {
        return n == null || n.isNull() ? null : n.asText();
    }
}
