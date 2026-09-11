package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.StreamSupport;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
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
import org.yaml.snakeyaml.Yaml;

/**
 * Die Geräte-Schnittstelle (UEMS AP-04 IP-10) Ende zu Ende gegen echtes Keycloak + TimescaleDB.
 * Die Eingänge sind die Geräte des Referenzunternehmens — mit deren Kennzeichen und Werten.
 *
 * <p>Bewiesen wird:
 * <ul>
 *   <li>die Vorgänger-Liste am MS-06-Fall: GR-4 mit Z-5a (4471023, bis 18.11.2026 10:40) und
 *       Z-5b (88231, ab 18.11.2026 10:40) — Z-5b nennt Z-5a, die Speisung von K-5 wechselt
 *       genau dort;</li>
 *   <li>die Anlagen-Liste: jeder Einbau, und jede Komponente hat genau ein laufendes Gerät —
 *       die abgeleiteten GR-1 … GR-6 der Bestands-Komponenten von AN-1;</li>
 *   <li>GR-7 „WAGO-Controller C-1" mit EK-1 … EK-4 auf den Steckplätzen 2 … 5, je Karte eine
 *       Komponente;</li>
 *   <li>die Antwort trägt genau die Felder der OpenAPI; ein fremdes Gerät und eine fremde Anlage
 *       sind 404, nie 403.</li>
 * </ul>
 * Den Zählerwechsel selbst schreibt hier die Datenbank von Hand, so wie ihn IP-17 schreiben
 * wird — eine Schreib-Route gibt es in diesem Paket nicht.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class GeraetApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path CONTRACTS = Path.of("..", "..", "docs", "contracts");
    /** Der Kundenbereich des Benutzers {@code demo} (Test-Realm). */
    private static final UUID DEMO_KUNDENBEREICH = UUID.fromString("00000000-0000-0000-0000-000000000001");

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

    /** Wer ruft: ein Benutzer des Test-Realms, der Plattform-Admin mit gewähltem Kundenbereich. */
    private record Anrufer(String benutzer, UUID kundenbereich) {}

    private record Token(String wert, long geholt) {}

    private static final Anrufer DEMO = new Anrufer("demo", null);
    private static final Anrufer DEMO2 = new Anrufer("demo2", null);
    private static final Anrufer ADMIN_OHNE_KUNDENBEREICH = new Anrufer("admin", null);
    private static final Map<String, Token> TOKENS = new ConcurrentHashMap<>();

    private static JsonNode referenz;
    private static Map<String, Object> schemas;
    private static JdbcTemplate root;

    private static UUID ahrenberg;
    private static Anrufer ahrenbergAdmin;
    private static final Map<String, UUID> ANLAGEN = new LinkedHashMap<>();
    private static final Map<String, UUID> KOMPONENTEN = new LinkedHashMap<>();
    private static final Map<String, UUID> EINBAUTEN = new LinkedHashMap<>();
    private static UUID demoGeraet;
    private static UUID demoAnlage;

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void ladeVertrag() throws IOException {
        referenz = MAPPER.readTree(CONTRACTS.resolve("v2").resolve("uems-referenzunternehmen.json").toFile());
        try (InputStream in = Files.newInputStream(CONTRACTS.resolve("openapi.yaml"))) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
        }
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    /** Einmal je Klasse, sobald der Spring-Kontext (und mit ihm Flyway) steht. */
    @BeforeEach
    void saeEinmal() {
        synchronized (GeraetApiTest.class) {
            if (ahrenberg == null) {
                saeReferenz();
            }
        }
    }

    // ---- Die Vorgänger-Liste: der MS-06-Fall ------------------------------------------

    @Test
    void zFuenfBNenntZFuenfAAlsVorgaengerUndDieSpeisungVonKFuenfWechseltGenauDort() {
        JsonNode gr4 = element(referenz.get("geraete"), "GR-4");
        JsonNode z5a = element(gr4.get("einbauten"), "Z-5a");
        JsonNode z5b = element(gr4.get("einbauten"), "Z-5b");

        JsonNode neu = ok(rufe("/api/v1/geraete/" + EINBAUTEN.get("Z-5b"), ahrenbergAdmin));
        assertThat(neu.get("kennzeichen").asText()).isEqualTo("GR-4");
        assertThat(neu.get("einbau_kennzeichen").asText()).isEqualTo("Z-5b");
        assertThat(neu.get("seriennummer").asText()).isEqualTo(z5b.get("seriennummer").asText());
        assertThat(neu.get("geraeteart").asText()).isEqualTo("zaehler");
        assertThat(neu.get("geraete_id").asInt()).isEqualTo(gr4.get("modbus_geraete_id").asInt());
        assertThat(neu.get("eingebaut_am").asText()).isEqualTo(z5b.get("gueltig_ab").asText());
        assertThat(neu.get("ausgebaut_am").isNull()).isTrue();
        assertThat(neu.get("aus_bestand").asBoolean()).isFalse();
        assertThat(neu.get("site_id").asText()).isEqualTo(ANLAGEN.get("AN-1").toString());
        assertThat(neu.get("komponenten")).hasSize(1);
        assertThat(neu.at("/komponenten/0/entity_id").asText()).isEqualTo(KOMPONENTEN.get("K-5").toString());
        assertThat(neu.at("/komponenten/0/gueltig_ab").asText()).isEqualTo(z5b.get("gueltig_ab").asText());
        assertThat(neu.at("/komponenten/0/gueltig_bis").isNull()).isTrue();

        assertThat(neu.get("vorgaenger")).hasSize(1);
        JsonNode vorgaenger = neu.at("/vorgaenger/0");
        assertThat(vorgaenger.get("id").asText()).isEqualTo(EINBAUTEN.get("Z-5a").toString());
        assertThat(vorgaenger.get("einbau_kennzeichen").asText()).isEqualTo("Z-5a");
        assertThat(vorgaenger.get("seriennummer").asText()).isEqualTo(z5a.get("seriennummer").asText());
        assertThat(vorgaenger.get("eingebaut_am").asText()).isEqualTo(z5a.get("gueltig_ab").asText());
        assertThat(vorgaenger.get("ausgebaut_am").asText()).isEqualTo(z5a.get("gueltig_bis").asText());

        // Z-5a selbst hat keinen Vorgänger; seine Speisung von K-5 endet, wo die neue beginnt.
        JsonNode alt = ok(rufe("/api/v1/geraete/" + EINBAUTEN.get("Z-5a"), ahrenbergAdmin));
        assertThat(alt.get("vorgaenger")).isEmpty();
        assertThat(alt.get("ausgebaut_am").asText()).isEqualTo(z5a.get("gueltig_bis").asText());
        assertThat(alt.get("aus_bestand").asBoolean()).as("aus der Bestands-Komponente abgeleitet").isTrue();
        assertThat(alt.at("/komponenten/0/gueltig_ab").asText()).isEqualTo(z5a.get("gueltig_ab").asText());
        assertThat(alt.at("/komponenten/0/gueltig_bis").asText()).isEqualTo(z5a.get("gueltig_bis").asText());
    }

    // ---- Die Anlagen-Liste -----------------------------------------------------------

    @Test
    void dieAnlageListetJedenEinbauUndJedeKomponenteHatGenauEinLaufendesGeraet() {
        JsonNode liste = ok(rufe("/api/v1/sites/" + ANLAGEN.get("AN-1") + "/geraete", ahrenbergAdmin));
        List<String> einbauten = new ArrayList<>();
        Map<String, Integer> laufend = new LinkedHashMap<>();
        for (JsonNode g : liste.get("geraete")) {
            einbauten.add(g.get("kennzeichen").asText() + "/" + g.get("einbau_kennzeichen").asText());
            for (JsonNode k : g.get("komponenten")) {
                if (k.get("gueltig_bis").isNull()) {
                    laufend.merge(k.get("entity_id").asText(), 1, Integer::sum);
                }
            }
        }
        assertThat(einbauten).containsExactly("GR-1/GR-1", "GR-2/GR-2", "GR-3/GR-3", "GR-4/Z-5a",
                "GR-4/Z-5b", "GR-5/GR-5", "GR-6/GR-6");
        assertThat(laufend.keySet()).containsExactlyInAnyOrderElementsOf(List.of("K-1", "K-3", "K-4", "K-5",
                "K-6", "K-7").stream().map(k -> KOMPONENTEN.get(k).toString()).toList());
        assertThat(laufend.values()).containsOnly(1);
        // Auch in der Liste nennt Z-5b seinen Vorgänger.
        JsonNode z5b = StreamSupport.stream(liste.get("geraete").spliterator(), false)
                .filter(g -> g.get("einbau_kennzeichen").asText().equals("Z-5b")).findFirst().orElseThrow();
        assertThat(z5b.at("/vorgaenger/0/einbau_kennzeichen").asText()).isEqualTo("Z-5a");

        JsonNode an2 = ok(rufe("/api/v1/sites/" + ANLAGEN.get("AN-2") + "/geraete", ahrenbergAdmin));
        assertThat(an2.get("geraete")).extracting(g -> g.get("kennzeichen").asText()).containsExactly("GR-7");
    }

    // ---- Der Controller mit seinen Karten --------------------------------------------------

    @Test
    void derControllerZeigtSeineVierKartenInDenSteckplaetzenUndJeKarteEineKomponente() {
        JsonNode gr7 = element(referenz.get("geraete"), "GR-7");
        JsonNode c1 = ok(rufe("/api/v1/geraete/" + EINBAUTEN.get("C-1"), ahrenbergAdmin));
        assertThat(c1.get("kennzeichen").asText()).isEqualTo("GR-7");
        assertThat(c1.get("einbau_kennzeichen").asText()).isEqualTo(gr7.at("/einbauten/0/kennzeichen").asText());
        assertThat(c1.get("geraeteart").asText()).isEqualTo("controller");
        assertThat(c1.get("hersteller").asText()).isEqualTo(gr7.get("hersteller").asText());
        assertThat(c1.get("typ").asText()).isEqualTo(gr7.get("typ").asText());
        assertThat(c1.get("eingebaut_am").asText()).isEqualTo(gr7.at("/einbauten/0/gueltig_ab").asText());

        List<String> karten = List.of("K-8.1", "K-8.2", "K-8.3", "K-8.4");
        assertThat(c1.get("teile")).hasSize(4);
        assertThat(c1.get("komponenten")).hasSize(4);
        Map<String, String> karteZuSteckplatz = new LinkedHashMap<>();
        for (int i = 0; i < karten.size(); i++) {
            JsonNode komponente = element(referenz.get("komponenten"), karten.get(i));
            JsonNode teil = c1.get("teile").get(i);
            assertThat(teil.get("teilart").asText()).isEqualTo("energiekarte");
            assertThat(teil.get("steckplatz").asInt()).isEqualTo(komponente.get("steckplatz").asInt());
            assertThat(teil.get("bezeichnung").asText()).isEqualTo("EK-" + (i + 1));
            assertThat(teil.get("typ").asText()).isEqualTo(komponente.get("kartentyp").asText());
            karteZuSteckplatz.put(teil.get("id").asText(), teil.get("steckplatz").asText());
        }
        for (JsonNode k : c1.get("komponenten")) {
            assertThat(karteZuSteckplatz).containsEntry(k.get("teil_id").asText(), k.get("steckplatz").asText());
        }
        assertThat(c1.get("komponenten")).extracting(k -> k.get("entity_id").asText())
                .containsExactlyInAnyOrderElementsOf(karten.stream().map(k -> KOMPONENTEN.get(k).toString()).toList());
    }

    // ---- Die Form und der Zaun ----------------------------------------------------------

    @Test
    void dieAntwortTraegtGenauDieFelderDerOpenApi() {
        JsonNode c1 = ok(rufe("/api/v1/geraete/" + EINBAUTEN.get("C-1"), ahrenbergAdmin));
        JsonNode z5b = ok(rufe("/api/v1/geraete/" + EINBAUTEN.get("Z-5b"), ahrenbergAdmin));
        assertThat(felder(z5b)).containsExactlyInAnyOrderElementsOf(eigenschaften("Geraet"));
        assertThat(felder(c1.at("/komponenten/0"))).containsExactlyInAnyOrderElementsOf(eigenschaften("GeraetKomponente"));
        assertThat(felder(c1.at("/teile/0"))).containsExactlyInAnyOrderElementsOf(eigenschaften("GeraetTeil"));
        assertThat(felder(z5b.at("/vorgaenger/0"))).containsExactlyInAnyOrderElementsOf(eigenschaften("GeraetVorgaenger"));
    }

    @Test
    void einFremdesGeraetUndEineFremdeAnlageSind404NieDer403() {
        String z5b = "/api/v1/geraete/" + EINBAUTEN.get("Z-5b");
        String an1 = "/api/v1/sites/" + ANLAGEN.get("AN-1") + "/geraete";

        // Der Kunde sieht sein Gerät …
        assertThat(ok(rufe("/api/v1/geraete/" + demoGeraet, DEMO)).get("id").asText())
                .isEqualTo(demoGeraet.toString());
        assertThat(ok(rufe("/api/v1/sites/" + demoAnlage + "/geraete", DEMO)).get("geraete")).hasSize(1);
        // … und nie ein fremdes.
        for (Anrufer fremd : List.of(DEMO, DEMO2, ADMIN_OHNE_KUNDENBEREICH, admin(DEMO_KUNDENBEREICH))) {
            assertThat(rufe(z5b, fremd).getStatusCode().value()).as(fremd.toString()).isEqualTo(404);
            assertThat(rufe(an1, fremd).getStatusCode().value()).as(fremd.toString()).isEqualTo(404);
        }
        assertThat(rufe("/api/v1/geraete/" + demoGeraet, DEMO2).getStatusCode().value()).isEqualTo(404);
        assertThat(rufe("/api/v1/geraete/" + UUID.randomUUID(), ahrenbergAdmin).getStatusCode().value())
                .isEqualTo(404);
        assertThat(rufe(z5b, null).getStatusCode().value()).isEqualTo(401);
    }

    // ---- Gerüst: der Bestand der Referenzdatei ---------------------------------------------

    /**
     * AN-1 mit den Bestands-Komponenten K-1, K-3 … K-7 (Verbindung aus DQ-1 … DQ-3), abgeleitet
     * wie die Migration es tut; dann der Zählerwechsel Z-5a → Z-5b so, wie IP-17 ihn schreiben
     * wird; dazu AN-2 mit GR-7 und seinen vier Karten.
     */
    private static void saeReferenz() {
        ahrenberg = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                referenz.at("/unternehmen/name").asText());
        ahrenbergAdmin = admin(ahrenberg);
        for (String a : List.of("AN-1", "AN-2")) {
            JsonNode anlage = element(referenz.get("anlagen"), a);
            ANLAGEN.put(a, root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) "
                    + "RETURNING id", UUID.class, ahrenberg, anlage.get("name").asText(), zeit(anlage.get("seit"))));
        }
        Map<String, UUID> boxen = new LinkedHashMap<>();
        for (String b : List.of("E-1", "E-2")) {
            JsonNode box = element(referenz.get("boxen"), b);
            boxen.put(b, root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, created_at) "
                    + "VALUES (?, ?, ?, ?) RETURNING id", UUID.class, ahrenberg,
                    ANLAGEN.get(box.get("heimat_anlage").asText()), box.get("seriennummer").asText(),
                    zeit(box.get("in_betrieb_ab"))));
        }

        int n = 0;
        for (String k : List.of("K-1", "K-3", "K-4", "K-5", "K-6", "K-7")) {
            JsonNode komponente = element(referenz.get("komponenten"), k);
            JsonNode geraet = element(referenz.get("geraete"), komponente.get("geraet").asText());
            JsonNode quelle = element(referenz.get("datenquellen"), geraet.get("datenquelle").asText());
            ObjectNode verbindung = MAPPER.createObjectNode().put("ip", quelle.get("adresse").asText())
                    .put("port", quelle.get("port").asInt()).put("unit_id", geraet.get("modbus_geraete_id").asInt());
            String art = "K-1".equals(k) ? "battery-hybrid" : "K-3".equals(k) ? "grid-meter" : "modbus-generic";
            UUID id = UUID.fromString(String.format("4e0b0000-0000-0000-0001-%012d", ++n));
            root.update("INSERT INTO measurement_point (id, tenant_id, site_id, role, label, entity_type, "
                    + "device_id, control, communication, connection_json, created_at) "
                    + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)", id, ahrenberg, ANLAGEN.get("AN-1"), art,
                    komponente.get("name").asText(), art, boxen.get("E-1"), "battery-hybrid".equals(art),
                    "K-1".equals(k) ? "sunspec_tcp" : "modbus_tcp", verbindung.toString(),
                    zeit(komponente.get("in_betrieb_ab")));
            KOMPONENTEN.put(k, id);
        }
        // Dieselbe Ableitung wie die Migration — für die Komponenten, die NACH ihr entstanden sind.
        root.queryForObject("SELECT uems_geraete_ableiten()", Integer.class);
        assertThat(root.queryForList("SELECT kennzeichen FROM geraet WHERE tenant_id = ? ORDER BY "
                + "length(kennzeichen), kennzeichen", String.class, ahrenberg))
                .containsExactly("GR-1", "GR-2", "GR-3", "GR-4", "GR-5", "GR-6");

        // Der Zählerwechsel an K-5 (MS-06): Z-5a endet, Z-5b beginnt — genau zum selben Zeitpunkt.
        JsonNode gr4 = element(referenz.get("geraete"), "GR-4");
        JsonNode z5a = element(gr4.get("einbauten"), "Z-5a");
        JsonNode z5b = element(gr4.get("einbauten"), "Z-5b");
        Timestamp wechsel = zeit(z5a.get("gueltig_bis"));
        UUID alt = root.queryForObject("SELECT id FROM geraet WHERE tenant_id = ? AND kennzeichen = 'GR-4'",
                UUID.class, ahrenberg);
        root.update("UPDATE geraet SET einbau_kennzeichen = ?, seriennummer = ?, ausgebaut_am = ? WHERE id = ?",
                z5a.get("kennzeichen").asText(), z5a.get("seriennummer").asText(), wechsel, alt);
        root.update("UPDATE geraet_komponente SET gueltig_bis = ? WHERE geraet_id = ?", wechsel, alt);
        UUID neu = root.queryForObject("INSERT INTO geraet (tenant_id, site_id, kennzeichen, einbau_kennzeichen, "
                + "geraeteart, seriennummer, geraete_id, eingebaut_am) VALUES (?, ?, 'GR-4', ?, 'zaehler', ?, ?, ?) "
                + "RETURNING id", UUID.class, ahrenberg, ANLAGEN.get("AN-1"), z5b.get("kennzeichen").asText(),
                z5b.get("seriennummer").asText(), gr4.get("modbus_geraete_id").asInt(), zeit(z5b.get("gueltig_ab")));
        root.update("INSERT INTO geraet_komponente (tenant_id, geraet_id, entity_id, gueltig_ab) VALUES (?, ?, ?, ?)",
                ahrenberg, neu, KOMPONENTEN.get("K-5"), zeit(z5b.get("gueltig_ab")));
        EINBAUTEN.put("Z-5a", alt);
        EINBAUTEN.put("Z-5b", neu);

        // GR-7: der WAGO-Controller C-1 mit EK-1 … EK-4 — wie AP-05 ihn anlegen wird.
        JsonNode gr7 = element(referenz.get("geraete"), "GR-7");
        Timestamp ab = zeit(gr7.at("/einbauten/0/gueltig_ab"));
        UUID c1 = root.queryForObject("INSERT INTO geraet (tenant_id, site_id, kennzeichen, einbau_kennzeichen, "
                + "geraeteart, hersteller, typ, geraete_id, eingebaut_am) VALUES (?, ?, uems_geraet_kennzeichen(?), "
                + "?, 'controller', ?, ?, ?, ?) RETURNING id", UUID.class, ahrenberg, ANLAGEN.get("AN-2"), ahrenberg,
                gr7.at("/einbauten/0/kennzeichen").asText(), gr7.get("hersteller").asText(),
                gr7.get("typ").asText(), gr7.get("modbus_geraete_id").asInt(), ab);
        EINBAUTEN.put("C-1", c1);
        int ek = 0;
        for (String k : List.of("K-8.1", "K-8.2", "K-8.3", "K-8.4")) {
            JsonNode komponente = element(referenz.get("komponenten"), k);
            UUID id = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                    + "entity_type, device_id, created_at) VALUES (?, ?, 'modbus-generic', ?, 'modbus-generic', ?, ?) "
                    + "RETURNING id", UUID.class, ahrenberg, ANLAGEN.get("AN-2"), komponente.get("name").asText(),
                    boxen.get("E-2"), zeit(komponente.get("in_betrieb_ab")));
            KOMPONENTEN.put(k, id);
            UUID karte = root.queryForObject("INSERT INTO geraet_teil (tenant_id, geraet_id, steckplatz, bezeichnung, "
                    + "typ, eingebaut_am) VALUES (?, ?, ?, ?, ?, ?) RETURNING id", UUID.class, ahrenberg, c1,
                    komponente.get("steckplatz").asInt(), "EK-" + (++ek), komponente.get("kartentyp").asText(), ab);
            root.update("INSERT INTO geraet_komponente (tenant_id, geraet_id, entity_id, teil_id, gueltig_ab) "
                    + "VALUES (?, ?, ?, ?, ?)", ahrenberg, c1, id, karte, ab);
        }

        // Ein Gerät im Kundenbereich des Benutzers demo — für den Blick mit dem Kunden-Token.
        demoAnlage = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Geräte-Probe') "
                + "RETURNING id", UUID.class, DEMO_KUNDENBEREICH);
        UUID k = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, entity_type, "
                + "connection_json) VALUES (?, ?, 'modbus-generic', 'modbus-generic', '{\"unit_id\":5}'::jsonb) "
                + "RETURNING id", UUID.class, DEMO_KUNDENBEREICH, demoAnlage);
        root.queryForObject("SELECT uems_geraete_ableiten()", Integer.class);
        demoGeraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ?", UUID.class, k);
    }

    // ---- Gerüst: Schnittstelle ------------------------------------------------------------

    private static Anrufer admin(UUID kundenbereich) {
        return new Anrufer("admin", kundenbereich);
    }

    private ResponseEntity<JsonNode> rufe(String pfad, Anrufer wer) {
        HttpHeaders headers = new HttpHeaders();
        if (wer != null) {
            headers.setBearerAuth(token(wer.benutzer()));
            if (wer.kundenbereich() != null) {
                headers.set("X-Tenant-Id", wer.kundenbereich().toString());
            }
        }
        return rest.exchange("http://localhost:" + port + pfad, HttpMethod.GET, new HttpEntity<>(headers),
                JsonNode.class);
    }

    private static JsonNode ok(ResponseEntity<JsonNode> r) {
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(200);
        return r.getBody();
    }

    private String token(String benutzer) {
        Token t = TOKENS.get(benutzer);
        if (t != null && System.currentTimeMillis() - t.geholt() < 5 * 60_000) {
            return t.wert();
        }
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", "voltpilot-api");
        form.add("client_secret", "voltpilot-api-dev-secret");
        form.add("username", benutzer);
        form.add("password", benutzer);
        form.add("scope", "openid");
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        @SuppressWarnings("unchecked")
        Map<String, Object> body = new TestRestTemplate().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).as("token response").containsKey("access_token");
        String wert = (String) body.get("access_token");
        TOKENS.put(benutzer, new Token(wert, System.currentTimeMillis()));
        return wert;
    }

    // ---- Gerüst: Vertrag -------------------------------------------------------------------

    @SuppressWarnings("unchecked")
    private static List<String> eigenschaften(String schema) {
        Map<String, Object> s = (Map<String, Object>) schemas.get(schema);
        assertThat(s).as(schema).isNotNull();
        return new ArrayList<>(((Map<String, Object>) s.get("properties")).keySet());
    }

    private static List<String> felder(JsonNode n) {
        List<String> f = new ArrayList<>();
        n.fieldNames().forEachRemaining(f::add);
        return f;
    }

    private static JsonNode element(JsonNode liste, String kennzeichen) {
        for (JsonNode e : liste) {
            if (kennzeichen.equals(e.get("kennzeichen").asText())) {
                return e;
            }
        }
        throw new AssertionError("nicht in der Referenzdatei: " + kennzeichen);
    }

    private static Timestamp zeit(JsonNode n) {
        return Timestamp.from(OffsetDateTime.parse(n.asText()).toInstant());
    }
}
