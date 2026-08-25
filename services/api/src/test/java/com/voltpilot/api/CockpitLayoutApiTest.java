package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
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
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der LAYOUT-Speicher des Cockpits (Anwendungs-Programm Stufe 3) end to end
 * gegen echtes Keycloak + TimescaleDB.
 *
 * <p>Die Beweis-Matrix (Captain-Entscheide E1/E2):
 * <ul>
 *   <li><b>Bestand:</b> eine Anlage ohne Zeile antwortet mit lauter leeren
 *       Schichten — die Fläche fällt damit auf den Katalog-Standard, also auf
 *       das Verhalten vor dieser Stufe;</li>
 *   <li><b>Eigen &gt; Vorgabe:</b> der Kunde schreibt seine Schicht, der Admin
 *       die Vorgabe, und beide stehen NEBENEINANDER in der Antwort — nur so
 *       kann die Fläche sagen, worauf ein „Zurücksetzen" fällt;</li>
 *   <li><b>Reset ist ein DELETE:</b> die eigene Schicht verschwindet, die
 *       Vorgabe bleibt;</li>
 *   <li><b>der Kunde kann keine Vorgabe schreiben</b> (403), und ein Admin
 *       erreicht sie nur über den Mandanten-Umschalter;</li>
 *   <li><b>die Form-Prüfung:</b> unbekannter Baustein, Pflicht-Baustein in
 *       {@code hidden}, ein erfundener Lead und eine unbekannte Schicht sind je
 *       ein 400 mit deutschem Grund — und schreiben NICHTS;</li>
 *   <li><b>ein Baustein, den die Anlage gerade nicht hat, wird ausdrücklich
 *       NICHT abgelehnt</b> (die Präferenz muss ein Ab- und Wiedereinschalten
 *       einer Anwendung überleben);</li>
 *   <li><b>RLS:</b> eine fremde Anlage ist 404, nie 403.</li>
 * </ul>
 *
 * <p>Dazu die EIGENEN Auswertungen (Stufe 5): sie leben im selben Dokument,
 * werden vom selben Schreibpfad geprüft und von einer eigenen, schmalen
 * Lese-Route beziffert — siehe
 * {@link #dieEigeneAuswertungLebtImLayoutUndIhreKennzahlBleibtEhrlich()}.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class CockpitLayoutApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";
    private static final String HAMBURG_SITE = "10000000-0000-0000-0000-000000000002";
    private static final String DEMO_DEVICE = "00000000-0000-0000-0000-000000000003";
    /** Die Komponente, an der die eigenen Auswertungen dieses Tests hängen. */
    private static final String WP_ENTITY = "dddddddd-0000-0000-0000-000000000005";

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

    @Test
    void theCustomerArrangesTheirCockpitAndTheAdminsVorgabeStaysBesideIt() {
        String demo = token("demo", "demo");
        String admin = token("admin", "admin");

        // -- 1. Bestand: keine Zeile, keine Aussage --------------------------
        JsonNode leer = customer(path(BERLIN_SITE), HttpMethod.GET, demo, null).getBody();
        assertThat(leer.path("surface").asText()).isEqualTo("cockpit");
        assertThat(leer.path("eigen").isNull()).as("keine Zeile = kein Wille").isTrue();
        assertThat(leer.path("siteVorgabe").isNull()).isTrue();
        assertThat(leer.path("tenantVorgabe").isNull()).isTrue();
        assertThat(leer.path("darfVorgabe").asBoolean()).as("ein Kunde ist kein Betreiber")
                .isFalse();
        // Der Baustein-Katalog reist mit — die Fläche braucht Labels und die
        // Pflicht-Regel, ohne sie ein zweites Mal aufzuschreiben.
        assertThat(bausteinIds(leer)).contains("status", "energiefluss", "geld", "kacheln",
                "komponenten", "zustand");
        assertThat(baustein(leer, "zustand").path("pflicht").asBoolean()).isTrue();
        assertThat(baustein(leer, "kacheln").path("pflicht").asBoolean()).isFalse();
        assertThat(baustein(leer, "energiefluss").path("beweglich").asBoolean())
                .as("die Bühne bleibt die Bühne").isFalse();
        assertThat(baustein(leer, "geld").path("leadBlock").asText())
                .isEqualTo("erloes-komposition");
        // „Beigesteuert von" ist ABGELEITET, nie eine zweite Liste.
        assertThat(strings(baustein(leer, "kacheln").path("beigesteuertVon")))
                .contains("marktvermarktung", "lastspitzenkappung");
        assertThat(strings(baustein(leer, "komponenten").path("beigesteuertVon")))
                .as("Grundausstattung hat keinen Beisteuerer").isEmpty();

        // -- 2. Der Kunde ordnet an ------------------------------------------
        JsonNode gespeichert = customer(path(BERLIN_SITE), HttpMethod.PUT, demo,
                Map.of("order", List.of("status", "energiefluss", "geld", "steuerung", "fahrplan",
                        "kacheln", "strompreis", "komponenten", "zustand"),
                        "hidden", List.of("strompreis"), "shown", List.of(), "lead",
                        "energiefluss"))
                .getBody();
        assertThat(gespeichert.path("eigen").path("document").path("hidden").get(0).asText())
                .isEqualTo("strompreis");
        assertThat(gespeichert.path("eigen").path("document").path("lead").asText())
                .isEqualTo("energiefluss");
        // Die Papier-Spur: WER hat das gemacht (das JWT-Subject).
        assertThat(gespeichert.path("eigen").path("updatedBy").asText()).isNotBlank();
        // Der Wille überlebt einen frischen Abruf.
        assertThat(customer(path(BERLIN_SITE), HttpMethod.GET, demo, null).getBody()
                .path("eigen").path("document").path("order").size()).isEqualTo(9);

        // -- 3. Der Kunde kann KEINE Vorgabe schreiben (E2) --------------------
        ResponseEntity<JsonNode> verboten = customer(path(BERLIN_SITE) + "?layer=vorgabe",
                HttpMethod.PUT, demo, Map.of("hidden", List.of("kacheln")));
        assertThat(verboten.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(verboten.getBody().path("message").asText()).contains("VoltPilot");

        // -- 4. Der Admin gestaltet die Vorgabe über den Umschalter ------------
        JsonNode mitVorgabe = exchange(path(BERLIN_SITE) + "?layer=vorgabe", HttpMethod.PUT, admin,
                TENANT_A, Map.of("hidden", List.of("kacheln"), "lead", "erloes-komposition"))
                .getBody();
        assertThat(mitVorgabe.path("darfVorgabe").asBoolean()).isTrue();
        assertThat(mitVorgabe.path("siteVorgabe").path("document").path("hidden").get(0).asText())
                .isEqualTo("kacheln");
        // BEIDE Schichten stehen nebeneinander — der Kunde gewinnt erst in der
        // Auflösung, und die Fläche braucht die Vorgabe für ihre Ansage.
        assertThat(mitVorgabe.path("eigen").path("document").path("hidden").get(0).asText())
                .isEqualTo("strompreis");

        // -- 5. Die kunden-weite Vorgabe (E1) ---------------------------------
        exchange("/api/v1/tenant/cockpit-layout?layer=vorgabe", HttpMethod.PUT, admin, TENANT_A,
                Map.of("hidden", List.of("fahrplan")));
        JsonNode mitBeiden = customer(path(BERLIN_SITE), HttpMethod.GET, demo, null).getBody();
        assertThat(mitBeiden.path("tenantVorgabe").path("document").path("hidden").get(0).asText())
                .isEqualTo("fahrplan");
        // Sie gilt für JEDE Anlage des Kunden — auch für eine, die selbst keine
        // Anlagen-Vorgabe hat.
        assertThat(customer("/api/v1/tenant/cockpit-layout", HttpMethod.GET, demo, null).getBody()
                .path("tenantVorgabe").path("document").path("hidden").get(0).asText())
                .isEqualTo("fahrplan");

        // -- 6. Reset = DELETE genau EINER Schicht ----------------------------
        JsonNode nachReset = customer(path(BERLIN_SITE), HttpMethod.DELETE, demo, null).getBody();
        assertThat(nachReset.path("eigen").isNull()).as("der eigene Wille ist weg").isTrue();
        assertThat(nachReset.path("siteVorgabe").isNull())
                .as("die Vorgabe bleibt — genau darauf fällt der Reset").isFalse();
        // Ein zweiter Reset ist ein harmloses No-op, kein 404.
        assertThat(customer(path(BERLIN_SITE), HttpMethod.DELETE, demo, null).getStatusCode())
                .isEqualTo(HttpStatus.OK);
    }

    @Test
    void everyRefusalNamesItsReasonInGermanAndWritesNothing() {
        String demo = token("demo", "demo");
        String pfad = path(BERLIN_SITE);

        // (a) ein Baustein, den VoltPilot nicht kennt
        ResponseEntity<JsonNode> unbekannt = customer(pfad, HttpMethod.PUT, demo,
                Map.of("order", List.of("gibtsnicht")));
        assertThat(unbekannt.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(unbekannt.getBody().path("message").asText()).contains("kein Baustein");

        // (b) ein Pflicht-Baustein lässt sich nicht ausblenden (E2)
        ResponseEntity<JsonNode> pflicht = customer(pfad, HttpMethod.PUT, demo,
                Map.of("hidden", List.of("zustand")));
        assertThat(pflicht.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(pflicht.getBody().path("message").asText()).contains("Grundausstattung");

        // (c) ein erfundener Lead
        ResponseEntity<JsonNode> lead = customer(pfad, HttpMethod.PUT, demo,
                Map.of("lead", "gibtsnicht"));
        assertThat(lead.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(lead.getBody().path("message").asText()).contains("hervorheben");

        // (d) eine unbekannte Schicht — nie ein stiller Rückfall auf „eigen"
        ResponseEntity<JsonNode> schicht = customer(pfad + "?layer=irgendwas", HttpMethod.PUT,
                demo, Map.of());
        assertThat(schicht.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(schicht.getBody().path("message").asText()).contains("Schicht");

        // Nach VIER Ablehnungen steht immer noch keine Zeile.
        assertThat(customer(pfad, HttpMethod.GET, demo, null).getBody().path("eigen").isNull())
                .as("eine Ablehnung schreibt nichts").isTrue();

        // (e) ein Baustein, den DIESE Anlage gerade nicht hat, ist AUSDRÜCKLICH
        // keine Ablehnung: die Präferenz muss ein Ab- und Wiedereinschalten
        // einer Anwendung überleben (§3.2 E) — der Server kann und darf nicht
        // wissen, was die Fläche gerade rendert.
        assertThat(customer(pfad, HttpMethod.PUT, demo,
                Map.of("hidden", List.of("kacheln", "geld"))).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        customer(pfad, HttpMethod.DELETE, demo, null);
    }

    /**
     * Anwendungs-Programm Stufe 5: die eigene Auswertung — vom Anlegen über die
     * Kennzahl bis zur Ablehnung einer unehrlichen Kombination.
     *
     * <p>Der Beweis hat FÜNF Teile, und der wichtigste ist der dritte: die
     * Kennzahl eines ENERGIE-Kanals ist sein ZUWACHS ({@code max − min}), nie
     * die Summe seiner Messwerte — ein kWh-Kanal meldet hier einen
     * Zählerstand, und ihn zu addieren ergäbe das Vielfache des Zählerstands.
     */
    @Test
    void dieEigeneAuswertungLebtImLayoutUndIhreKennzahlBleibtEhrlich() {
        String demo = token("demo", "demo");
        String pfad = path(BERLIN_SITE);
        seedWaermepumpe();
        try {
            // -- 1. Der Katalog liefert die ARTEN mit -------------------------
            JsonNode leer = customer(pfad, HttpMethod.GET, demo, null).getBody();
            assertThat(vorlagenIds(leer)).containsExactly("eigene-kachel", "eigener-chart");
            assertThat(vorlage(leer, "eigener-chart").path("darstellung").asText())
                    .isEqualTo("chart");
            assertThat(vorlage(leer, "eigene-kachel").path("nach").asText()).isEqualTo("kacheln");
            // Ohne Zeile trägt das Dokument keine einzige eigene Auswertung.
            assertThat(customer(werte(BERLIN_SITE), HttpMethod.GET, demo, null).getBody()
                    .path("werte")).isEmpty();

            // -- 2. Der Kunde legt eine Kachel UND ein Chart an ---------------
            Map<String, Object> kachel = Map.of("id", "eigen:wp-jetzt", "titel",
                    "Wärmepumpe jetzt", "darstellung", "kachel", "entityId", WP_ENTITY,
                    "channel", "power_kw", "aggregat", "jetzt");
            Map<String, Object> chart = Map.of("id", "eigen:wp-verlauf", "titel",
                    "Wärmepumpe im Tagesverlauf", "darstellung", "chart", "entityId", WP_ENTITY,
                    "channel", "power_kw", "aggregat", "tagesmax");
            Map<String, Object> energie = Map.of("id", "eigen:wp-energie", "titel",
                    "Wärmepumpe heute", "darstellung", "kachel", "entityId", WP_ENTITY,
                    "channel", "energy_kwh", "aggregat", "tagessumme");
            Map<String, Object> zurueck = Map.of("id", "eigen:wp-reset", "titel",
                    "Zähler heute", "darstellung", "kachel", "entityId", WP_ENTITY,
                    "channel", "zaehler_kwh", "aggregat", "tagessumme");
            JsonNode gespeichert = customer(pfad, HttpMethod.PUT, demo, Map.of(
                    "order", List.of("status", "energiefluss", "eigen:wp-jetzt",
                            "eigen:wp-energie", "eigen:wp-verlauf", "komponenten", "zustand"),
                    "hidden", List.of(), "shown", List.of(),
                    "custom", List.of(kachel, chart, energie, zurueck))).getBody();
            JsonNode custom = gespeichert.path("eigen").path("document").path("custom");
            assertThat(custom.size()).isEqualTo(4);
            assertThat(custom.get(0).path("titel").asText()).isEqualTo("Wärmepumpe jetzt");
            assertThat(custom.get(2).path("aggregat").asText()).isEqualTo("tagessumme");
            // Der Schlüssel steht ZUSÄTZLICH in der Reihenfolge — er wird
            // angeordnet wie jeder andere Baustein.
            assertThat(strings(gespeichert.path("eigen").path("document").path("order")))
                    .contains("eigen:wp-jetzt", "eigen:wp-verlauf");

            // -- 3. Die Kennzahlen, von Hand gerechnet ------------------------
            JsonNode w = customer(werte(BERLIN_SITE), HttpMethod.GET, demo, null).getBody();
            assertThat(w.path("bucketMinutes").asInt()).isEqualTo(15);
            JsonNode jetzt = wert(w, "eigen:wp-jetzt");
            // Der jüngste gemeldete Wert der Reihe.
            assertThat(jetzt.path("wert").asDouble()).isEqualTo(3.0);
            assertThat(jetzt.path("kanalart").asText()).isEqualTo("leistung");
            assertThat(jetzt.path("komponente").asText()).isEqualTo("Wärmepumpe");
            assertThat(jetzt.path("verlauf")).as("eine Kachel zeigt EINE Zahl").isEmpty();

            JsonNode max = wert(w, "eigen:wp-verlauf");
            assertThat(max.path("wert").asDouble()).isEqualTo(9.0);
            assertThat(max.path("verlauf")).as("ein Chart bekommt seine Kurve").isNotEmpty();

            // Der ZUWACHS des Zählers: 140,5 − 100,0 = 40,5 kWh. Die SUMME
            // seiner vier Messwerte wäre 100 + 110 + 130,25 + 140,5 = 480,75 -
            // das Vielfache des Zählerstands, also genau die Zahl, die hier
            // nie herauskommen darf.
            assertThat(wert(w, "eigen:wp-energie").path("wert").asDouble()).isEqualTo(40.5);
            assertThat(wert(w, "eigen:wp-energie").path("kanalart").asText()).isEqualTo("energie");

            // ⚠ Ein zurückgesetzter Zähler ergibt KEINE Zahl - und sagt warum.
            // `max − min` wäre hier 950 − 5 = 945 kWh, also eine Zahl, die
            // physikalisch nie geflossen ist (wirklich waren es ~57). Genau
            // deshalb prüft der Server die Reihe auf Monotonie, statt sich auf
            // ein negatives Vorzeichen zu verlassen, das nie auftreten kann.
            JsonNode kaputt = wert(w, "eigen:wp-reset");
            assertThat(kaputt.path("wert").isNull()).isTrue();
            assertThat(kaputt.path("hinweis").asText()).contains("nicht durchgehend gestiegen");

            // Ein Tag ohne Messwerte behauptet keine 0, sondern sagt es.
            JsonNode gestern = customer(werte(BERLIN_SITE) + "?at=2020-01-01", HttpMethod.GET,
                    demo, null).getBody();
            assertThat(wert(gestern, "eigen:wp-jetzt").path("wert").isNull()).isTrue();
            assertThat(wert(gestern, "eigen:wp-jetzt").path("hinweis").asText())
                    .contains("keine Messwerte");

            // -- 4. Jede unehrliche Kombination ist ein 400 MIT Grund ---------
            record Fall(Object def, String enthaelt) {}
            List<Fall> faelle = List.of(
                    new Fall(Map.of("id", "eigen:x", "titel", "T", "darstellung", "kachel",
                            "entityId", WP_ENTITY, "channel", "power_kw", "aggregat",
                            "tagessumme"), "nicht zu einer Tagessumme"),
                    new Fall(Map.of("id", "eigen:x", "titel", "T", "darstellung", "kachel",
                            "entityId", WP_ENTITY, "channel", "energy_kwh", "aggregat",
                            "tagesmittel"), "Z\u00e4hlerstand"),
                    new Fall(Map.of("id", "eigen:x", "titel", "T", "darstellung", "kachel",
                            "entityId", WP_ENTITY, "channel", "gibtsnicht", "aggregat", "jetzt"),
                            "meldet diesen Messwert nicht"),
                    new Fall(Map.of("id", "eigen:x", "titel", "T", "darstellung", "kachel",
                            "entityId", "cccccccc-9999-9999-9999-999999999999", "channel",
                            "power_kw", "aggregat", "jetzt"), "geh\u00f6rt nicht zu dieser Anlage"),
                    new Fall(Map.of("id", "kacheln", "titel", "T", "darstellung", "kachel",
                            "entityId", WP_ENTITY, "channel", "power_kw", "aggregat", "jetzt"),
                            "beginnt mit"),
                    new Fall(Map.of("id", "eigen:x", "titel", "T", "darstellung", "torte",
                            "entityId", WP_ENTITY, "channel", "power_kw", "aggregat", "jetzt"),
                            "Unbekannte Darstellung"));
            for (Fall f : faelle) {
                ResponseEntity<JsonNode> r = customer(pfad, HttpMethod.PUT, demo,
                        Map.of("custom", List.of(f.def())));
                assertThat(r.getStatusCode()).as(f.enthaelt()).isEqualTo(HttpStatus.BAD_REQUEST);
                assertThat(r.getBody().path("message").asText()).contains(f.enthaelt());
            }
            // Ein Schlüssel in der Reihenfolge, den KEINE Definition trägt.
            ResponseEntity<JsonNode> geist = customer(pfad, HttpMethod.PUT, demo,
                    Map.of("order", List.of("eigen:geist")));
            assertThat(geist.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(geist.getBody().path("message").asText()).contains("keine eigene Auswertung");
            // Nach SIEBEN Ablehnungen stehen immer noch die vier von oben.
            assertThat(customer(pfad, HttpMethod.GET, demo, null).getBody().path("eigen")
                    .path("document").path("custom").size())
                    .as("eine Ablehnung schreibt nichts").isEqualTo(4);

            // -- 5. Das Portfolio traegt keine eigenen Auswertungen -----------
            // Es hängt am KUNDEN und hat keine einzelne Komponente, gegen die
            // ein Kanal zu prüfen wäre - eine Kachel dort wäre eine Zusage über
            // Messwerte, die je Anlage verschieden sind. (Der Portfolio-Weg
            // schreibt per Vorgabe die VORGABE-Schicht, also fährt ihn hier der
            // Admin über den Umschalter.)
            String admin = token("admin", "admin");
            ResponseEntity<JsonNode> portfolio = exchange(
                    "/api/v1/tenant/cockpit-layout?surface=portfolio", HttpMethod.PUT, admin,
                    TENANT_A, Map.of("custom", List.of(kachel)));
            assertThat(portfolio.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(portfolio.getBody().path("message").asText()).contains("nur auf dem Cockpit");

            // -- 6. Der Mandanten-Zaun gilt auch fuer die Werte-Route ---------
            assertThat(customer(werte(HAMBURG_SITE), HttpMethod.GET, demo, null).getStatusCode())
                    .isEqualTo(HttpStatus.NOT_FOUND);
            HttpEntity<Void> anon = new HttpEntity<>(new HttpHeaders());
            assertThat(rest.exchange("http://localhost:" + port + werte(BERLIN_SITE),
                    HttpMethod.GET, anon, new ParameterizedTypeReference<JsonNode>() {})
                    .getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        } finally {
            customer(pfad, HttpMethod.DELETE, demo, null);
            exec("DELETE FROM telemetry_v2 WHERE entity_id = '" + WP_ENTITY + "'");
            exec("DELETE FROM measurement_point WHERE id = '" + WP_ENTITY + "'");
        }
    }

    @Test
    void aForeignSiteIs404NotForbiddenAndAnAnonymousCallerGetsNothing() {
        String demo = token("demo", "demo");
        // Hamburg gehört Mandant B — RLS macht sie unsichtbar, also 404.
        assertThat(customer(path(HAMBURG_SITE), HttpMethod.GET, demo, null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(customer(path(HAMBURG_SITE), HttpMethod.PUT, demo, Map.of()).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(customer(path(HAMBURG_SITE), HttpMethod.DELETE, demo, null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        HttpEntity<Void> anon = new HttpEntity<>(new HttpHeaders());
        assertThat(rest.exchange("http://localhost:" + port + path(BERLIN_SITE), HttpMethod.GET,
                anon, new ParameterizedTypeReference<JsonNode>() {}).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    // -- Helfer --------------------------------------------------------------

    private static String path(String siteId) {
        return "/api/v1/sites/" + siteId + "/cockpit-layout";
    }

    private static String werte(String siteId) {
        return "/api/v1/sites/" + siteId + "/eigene-auswertung";
    }

    private static List<String> vorlagenIds(JsonNode dto) {
        List<String> out = new ArrayList<>();
        for (JsonNode v : dto.path("vorlagen")) {
            out.add(v.path("id").asText());
        }
        return out;
    }

    private static JsonNode vorlage(JsonNode dto, String id) {
        for (JsonNode v : dto.path("vorlagen")) {
            if (id.equals(v.path("id").asText())) {
                return v;
            }
        }
        throw new AssertionError("Vorlage fehlt: " + id);
    }

    private static JsonNode wert(JsonNode dto, String id) {
        for (JsonNode w : dto.path("werte")) {
            if (id.equals(w.path("id").asText())) {
                return w;
            }
        }
        throw new AssertionError("Wert fehlt: " + id);
    }

    /**
     * Eine Wärmepumpe mit vier Viertelstunden von HEUTE — als Superuser, also
     * an RLS vorbei, wie jeder andere Seed dieser Suite.
     *
     * <p>Die Messwerte sind so gewählt, dass jede der vier Kennzahlen eine
     * ANDERE Zahl ergibt: Leistung 1/5/9/3 (jetzt 3, max 9), und ein
     * ZÄHLERSTAND 100 → 140,5 (Zuwachs 40,5; die Summe wäre 480,75).
     */
    private void seedWaermepumpe() {
        exec("DELETE FROM telemetry_v2 WHERE entity_id = '" + WP_ENTITY + "'");
        exec("DELETE FROM measurement_point WHERE id = '" + WP_ENTITY + "'");
        exec("INSERT INTO measurement_point (id, tenant_id, site_id, device_id, role, label, "
                + "control, entity_type, capabilities, guard_config) VALUES ('" + WP_ENTITY
                + "', '" + TENANT_A + "', '" + BERLIN_SITE + "', '" + DEMO_DEVICE
                + "', 'consumer', 'Wärmepumpe', FALSE, 'heating-rod', "
                + "'{\"measure\":[{\"channel\":\"power_kw\",\"unit\":\"kW\"},"
                + "{\"channel\":\"energy_kwh\",\"unit\":\"kWh\"},"
                + "{\"channel\":\"zaehler_kwh\",\"unit\":\"kWh\"}]}'::jsonb, "
                + "'{\"failsafe\":{\"behavior\":\"off\"}}'::jsonb)");
        // Vier Viertelstunden ab Mitternacht Berliner Zeit von HEUTE - so liegt
        // der Seed immer im Standard-Fenster der Route (`at` = heute).
        Instant mitternacht = LocalDate.now(ZoneId.of("Europe/Berlin"))
                .atStartOfDay(ZoneId.of("Europe/Berlin")).toInstant();
        double[] kw = {1.0, 5.0, 9.0, 3.0};
        double[] kwh = {100.0, 110.0, 130.25, 140.5};
        // Ein Zähler, der MITTEN am Tag zurückgesetzt wurde (Gerätetausch):
        // sein „Zuwachs" wäre negativ und ist damit keine Energie.
        double[] reset = {900.0, 950.0, 5.0, 12.0};
        StringBuilder rows = new StringBuilder();
        for (int i = 0; i < kw.length; i++) {
            String t = mitternacht.plusSeconds(i * 900L).toString();
            if (i > 0) {
                rows.append(", ");
            }
            rows.append("('").append(t).append("','").append(t).append("','").append(TENANT_A)
                    .append("','").append(BERLIN_SITE).append("','").append(DEMO_DEVICE)
                    .append("','").append(WP_ENTITY).append("','power_kw',").append(kw[i])
                    .append("), ('").append(t).append("','").append(t).append("','")
                    .append(TENANT_A).append("','").append(BERLIN_SITE).append("','")
                    .append(DEMO_DEVICE).append("','").append(WP_ENTITY).append("','energy_kwh',")
                    .append(kwh[i]).append("), ('").append(t).append("','").append(t)
                    .append("','").append(TENANT_A).append("','").append(BERLIN_SITE)
                    .append("','").append(DEMO_DEVICE).append("','").append(WP_ENTITY)
                    .append("','zaehler_kwh',").append(reset[i]).append(")");
        }
        exec("INSERT INTO telemetry_v2 (time, received_at, tenant_id, site_id, device_id, "
                + "entity_id, channel, value) VALUES " + rows);
    }

    /** Ein Statement als Superuser (Seed/Aufräumen — an RLS vorbei). */
    private static void exec(String sql) {
        try (Connection c = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword());
                Statement st = c.createStatement()) {
            st.execute(sql);
        } catch (Exception e) {
            throw new IllegalStateException("seed failed: " + sql, e);
        }
    }

    private static List<String> bausteinIds(JsonNode dto) {
        List<String> out = new ArrayList<>();
        for (JsonNode b : dto.path("bausteine")) {
            out.add(b.path("id").asText());
        }
        return out;
    }

    private static JsonNode baustein(JsonNode dto, String id) {
        for (JsonNode b : dto.path("bausteine")) {
            if (id.equals(b.path("id").asText())) {
                return b;
            }
        }
        throw new AssertionError("Baustein fehlt: " + id);
    }

    private static List<String> strings(JsonNode array) {
        List<String> out = new ArrayList<>();
        for (JsonNode n : array) {
            out.add(n.asText());
        }
        return out;
    }

    private ResponseEntity<JsonNode> customer(String path, HttpMethod method, String token,
            Object body) {
        return exchange(path, method, token, null, body);
    }

    private ResponseEntity<JsonNode> exchange(String path, HttpMethod method, String token,
            String tenantHeader, Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        if (tenantHeader != null) {
            headers.add("X-Tenant-Id", tenantHeader);
        }
        HttpEntity<?> entity = body != null ? new HttpEntity<>(body, headers)
                : new HttpEntity<>(headers);
        return rest.exchange("http://localhost:" + port + path, method, entity,
                new ParameterizedTypeReference<JsonNode>() {
                });
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
