package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.components.ComponentConnectionReceipts;
import com.voltpilot.api.components.SelfBuildComponentService;
import com.voltpilot.api.components.SelfBuildDefinition;
import com.voltpilot.api.flows.FlowCompilerHttp;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
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
 * Einheitsmodell Stufe 6 gegen echtes TimescaleDB + Keycloak.
 *
 * <p>Was hier bewiesen wird:
 * <ol>
 *   <li><b>Eine geprüfte Vorlage entsteht als DATENSATZ</b> - anlegen,
 *       versionieren, zurückziehen, wieder freigeben; die AUSWAHL des
 *       Assistenten folgt sofort, ohne Software-Auslieferung.</li>
 *   <li><b>Zurückziehen bricht KEINE Komponente</b> - der Fassungs-Schnappschuss
 *       an der Anlage bleibt gültig, und die Rücknahme fällt auf die vorherige
 *       Fassung ZURÜCK statt die Vorlage verschwinden zu lassen.</li>
 *   <li><b>Eingebaute Vorlagen sind nicht editierbar</b>, und die Ablehnung
 *       sagt WARUM (der Start-Abgleich würde es überschreiben).</li>
 *   <li><b>Private Vorlagen</b> - duplizieren OHNE die Adresse des Originals,
 *       umbenennen, löschen; alles hinter dem Besitzer-Zaun.</li>
 *   <li><b>Die Flotten-Sicht</b> ist mandantenübergreifend, read-only und
 *       rollen-gefenced.</li>
 * </ol>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class ComponentTemplateAdminApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_BASE = "/api/v1/admin/component-templates";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Container
    static final KeycloakContainer KEYCLOAK =
            new KeycloakContainer("quay.io/keycloak/keycloak:26.0.5")
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

    /** Die flowc-Naht offline - der Selbstbau-Pfad braucht sie zum Anlegen. */
    @TestConfiguration
    static class Fakes {
        @Bean
        FlowCompilerHttp flowCompilerHttp() throws IOException {
            String artifact = Files.readString(Path.of("..", "..", "docs", "contracts", "v2",
                    "examples", "flow-artifact.valid.artifact.json"));
            return (uri, body) -> new FlowCompilerHttp.Response(200, artifact);
        }
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Autowired
    ComponentConnectionReceipts receipts;

    private final ObjectMapper json = new ObjectMapper();

    // ── 1. Die Reise einer geprüften Vorlage ───────────────────────────────

    /**
     * Anlegen → in der Auswahl → neue Fassung → Rücknahme fällt auf die
     * VORHERIGE Fassung zurück → alle Fassungen zurück heißt „nicht mehr
     * wählbar" → Freigabe holt sie zurück.
     *
     * <p>Die Rücknahme-auf-die-Vorgänger-Fassung ist der Kern: sie ist die
     * Handlung, die man nach einem Fehler braucht, und sie funktioniert nur,
     * weil der Filter INNERHALB der Fassungs-Auswahl steht.
     */
    @Test
    void aCertifiedTemplateIsCreatedVersionedWithdrawnAndRestored() throws Exception {
        String admin = token("admin", "admin");
        String customer = token("demo", "demo");
        String ref = "certified:acmetest:relais_a";
        cleanTemplate(ref);
        try {
            ResponseEntity<String> created = post(ADMIN_BASE, admin, template("relais_a", "Erste Fassung"));
            assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
            JsonNode v1 = json.readTree(created.getBody());
            assertThat(v1.path("templateRef").asText()).isEqualTo(ref);
            assertThat(v1.path("version").asInt()).isEqualTo(1);
            assertThat(v1.path("kind").asText()).isEqualTo("certified");
            assertThat(v1.path("createdBy").asText()).isNotBlank();
            assertThat(v1.path("withdrawnAt").isNull())
                    .as("frisch angelegt ist nicht zurückgezogen").isTrue();
            // Die Ehrlichkeitsregel reist bis in die Antwort.
            assertThat(v1.path("channels").isNull()).isTrue();
            assertThat(v1.path("writes").isArray()).isTrue();

            // Der KUNDE sieht sie sofort im Assistenten - ohne Auslieferung.
            assertThat(publicVersion(customer, ref)).isEqualTo(1);

            // Fassung 2.
            ResponseEntity<String> v2 = post(ADMIN_BASE + "/" + ref + "/versions", admin,
                    template("relais_a", "Zweite Fassung"));
            assertThat(v2.getStatusCode()).isEqualTo(HttpStatus.CREATED);
            assertThat(json.readTree(v2.getBody()).path("version").asInt()).isEqualTo(2);
            assertThat(publicVersion(customer, ref)).isEqualTo(2);

            // ⚠ Rücknahme der Fassung 2 fällt auf Fassung 1 ZURÜCK.
            ResponseEntity<String> withdrawn =
                    post(ADMIN_BASE + "/" + ref + "/versions/2/withdraw", admin, null);
            assertThat(withdrawn.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(json.readTree(withdrawn.getBody()).path("withdrawnAt").asText())
                    .isNotBlank();
            assertThat(json.readTree(withdrawn.getBody()).path("withdrawnBy").asText())
                    .isNotBlank();
            assertThat(publicVersion(customer, ref)).isEqualTo(1);

            // Alle Fassungen zurückgezogen = nicht mehr wählbar.
            post(ADMIN_BASE + "/" + ref + "/versions/1/withdraw", admin, null);
            assertThat(publicRefs(customer)).doesNotContain(ref);

            // Aber die Verwaltung sieht die Historie unverändert.
            List<JsonNode> all = adminVersions(admin, ref);
            assertThat(all).hasSize(2);

            // Freigabe holt sie zurück.
            assertThat(post(ADMIN_BASE + "/" + ref + "/versions/2/restore", admin, null)
                    .getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(publicVersion(customer, ref)).isEqualTo(2);
        } finally {
            cleanTemplate(ref);
        }
    }

    /**
     * ⚠ Zurückziehen ist KEIN Löschen: eine Komponente, die auf der Fassung
     * steht, behält ihren Schnappschuss - und die Verwaltung SIEHT, wie viele
     * es sind, bevor jemand zurückzieht.
     */
    @Test
    void aWithdrawnTemplateNeverBreaksTheComponentsThatUseIt() throws Exception {
        String admin = token("admin", "admin");
        String customer = token("demo", "demo");
        String ref = "certified:acmetest:relais_b";
        cleanTemplate(ref);
        UUID site = createSite(customer, "Vorlagen-Schnappschuss");
        try {
            post(ADMIN_BASE, admin, template("relais_b", "Fassung"));

            // Eine Komponente trägt den Schnappschuss (Schlüssel + Fassung).
            UUID entity = insertComponentOn(site, ref, 1);

            JsonNode row = adminVersions(admin, ref).get(0);
            assertThat(row.path("usedByComponents").asInt())
                    .as("die Verwaltung zeigt die Nutzung VOR der Rücknahme").isEqualTo(1);

            post(ADMIN_BASE + "/" + ref + "/versions/1/withdraw", admin, null);

            // Die Komponente ist unverändert - Schlüssel und Fassung stehen noch.
            assertThat(scalar("SELECT template_ref FROM measurement_point WHERE id = '"
                    + entity + "'")).isEqualTo(ref);
            assertThat(scalar("SELECT template_version FROM measurement_point WHERE id = '"
                    + entity + "'")).isEqualTo("1");
            // Und die Fassung selbst existiert weiter - nur nicht mehr wählbar.
            assertThat(adminVersions(admin, ref)).hasSize(1);
            assertThat(publicRefs(customer)).doesNotContain(ref);
        } finally {
            deleteSite(site);
            cleanTemplate(ref);
        }
    }

    // ── 2. Grenzen ────────────────────────────────────────────────────────

    /**
     * ⚠ Eingebaute Vorlagen gehören dem Start-Abgleich. Eine Handänderung wäre
     * beim nächsten Neustart lautlos weg - also wird sie abgelehnt UND
     * begründet.
     */
    @Test
    void builtinTemplatesAreNotEditableAndTheRefusalSaysWhy() throws Exception {
        String admin = token("admin", "admin");
        String builtinRef = "builtin:deye:sun-30k-sg01hp3";

        ResponseEntity<String> version = post(ADMIN_BASE + "/" + builtinRef + "/versions", admin,
                template("relais_x", "Handänderung"));
        assertThat(version.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        String reason = json.readTree(version.getBody()).path("message").asText();
        assertThat(reason).contains("Eingebaute Vorlagen");
        assertThat(reason).contains("Neustart");

        assertThat(post(ADMIN_BASE + "/" + builtinRef + "/versions/1/withdraw", admin, null)
                .getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

        // Und die eingebaute Vorlage steht unverändert in der Auswahl.
        assertThat(publicVersion(token("demo", "demo"), builtinRef)).isEqualTo(1);
    }

    /** Jede Ablehnung nennt ihren deutschen Grund - und nichts wird geschrieben. */
    @Test
    void everyRefusalNamesItsReasonAndNothingIsWritten() throws Exception {
        String admin = token("admin", "admin");
        String ref = "certified:acmetest:relais_c";
        cleanTemplate(ref);
        try {
            // Eine LEERE Liste behauptet „es gibt keine" - abgelehnt.
            Map<String, Object> emptyChannels = template("relais_c", "Leer");
            emptyChannels.put("channels", List.of());
            assertThat(message(post(ADMIN_BASE, admin, emptyChannels), HttpStatus.BAD_REQUEST))
                    .contains("liefert keine Messwerte");

            // Ein Schreibweg ohne Sicherheitswert.
            Map<String, Object> unsafe = template("relais_c", "Ohne Sicherheitswert");
            unsafe.put("writes", List.of(writeWithout("safe_value")));
            assertThat(message(post(ADMIN_BASE, admin, unsafe), HttpStatus.BAD_REQUEST))
                    .contains("Sicherheitswert fehlt");

            // Ein Schreibweg an einer ungeprüften Vorlage.
            Map<String, Object> unchecked = template("relais_c", "Ungeprüft");
            unchecked.put("certificationStatus", "in_certification");
            assertThat(message(post(ADMIN_BASE, admin, unchecked), HttpStatus.BAD_REQUEST))
                    .contains("certified");

            assertThat(adminVersions(admin, ref)).as("keine der Ablehnungen hat geschrieben")
                    .isEmpty();

            // Erst jetzt eine gültige - und ein zweites Mal ist ein 409 mit Weg.
            assertThat(post(ADMIN_BASE, admin, template("relais_c", "Gültig")).getStatusCode())
                    .isEqualTo(HttpStatus.CREATED);
            assertThat(message(post(ADMIN_BASE, admin, template("relais_c", "Nochmal")), HttpStatus.CONFLICT))
                    .contains("neue Fassung");

            // Eine unbekannte Fassung ist 404, keine stille 200.
            assertThat(post(ADMIN_BASE + "/" + ref + "/versions/9/withdraw", admin, null)
                    .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        } finally {
            cleanTemplate(ref);
        }
    }

    /** Die Verwaltung ist Betreiber-Sache: ein Kunde bekommt 403, anonym 401. */
    @Test
    void theTemplateRegisterAndTheFleetViewAreAdminOnly() {
        String customer = token("demo", "demo");
        for (String path : List.of(ADMIN_BASE, "/api/v1/admin/component-fleet")) {
            assertThat(get(path, customer).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
            assertThat(rest.exchange(url(path), HttpMethod.GET,
                    new HttpEntity<>(new HttpHeaders()), String.class).getStatusCode())
                    .isEqualTo(HttpStatus.UNAUTHORIZED);
        }
        assertThat(post(ADMIN_BASE, customer, template("relais_z", "Kunde")).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
    }

    // ── 3. Private Vorlagen ───────────────────────────────────────────────

    /**
     * Der Lebenszyklus einer PRIVATEN Vorlage: duplizieren (ohne die Adresse
     * des Originals), umbenennen, löschen - und der Besitzer-Zaun hält auf
     * jedem dieser Wege.
     */
    @Test
    void aPrivateTemplateIsDuplicatedRenamedAndDeletedBehindItsOwnerFence() throws Exception {
        String customer = token("demo", "demo");
        String stranger = token("demo2", "demo2");
        UUID site = createSiteWithDevice(customer, "Vorlagen-Pflege", "sb-pflege-01");
        try {
            UUID entity = createCustomComponent(customer, site, "Wärmepumpe");

            JsonNode after = json.readTree(post("/api/v1/sites/" + site
                    + "/components/custom/" + entity + "/duplicate", customer, Map.of()).getBody());
            assertThat(after).hasSize(1);
            String ref = after.get(0).path("templateRef").asText();
            assertThat(after.get(0).path("label").asText()).isEqualTo("Wärmepumpe (Vorlage)");
            // ⚠ Eine Vorlage beschreibt einen GERÄTETYP, kein Exemplar.
            assertThat(after.get(0).path("connection").has("host")).isFalse();

            // Umbenennen samt Notiz.
            String path = "/api/v1/sites/" + site + "/component-templates/" + ref;
            JsonNode renamed = json.readTree(put(path, customer,
                    Map.of("label", "Wärmepumpe Keller", "note", "Zwei Stück im Haus")).getBody());
            assertThat(renamed.get(0).path("label").asText()).isEqualTo("Wärmepumpe Keller");
            assertThat(renamed.get(0).path("note").asText()).isEqualTo("Zwei Stück im Haus");

            // Eine leere Notiz LÖSCHT sie, ein leerer Name wird abgelehnt.
            JsonNode cleared = json.readTree(
                    put(path, customer, Map.of("label", "Wärmepumpe Keller")).getBody());
            assertThat(cleared.get(0).has("note")).isFalse();
            assertThat(message(put(path, customer, Map.of("label", "  ")),
                    HttpStatus.BAD_REQUEST)).contains("Namen");

            // Der Besitzer-Zaun: ein fremder Mandant erreicht nichts davon.
            assertThat(put(path.replace(site.toString(), site.toString()), stranger,
                    Map.of("label", "Geklaut")).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

            // Löschen - und das Gerät, das daraus entstand, bleibt.
            assertThat(json.readTree(delete(path, customer).getBody())).isEmpty();
            assertThat(scalar("SELECT count(*) FROM measurement_point WHERE id = '" + entity
                    + "'")).isEqualTo("1");
            assertThat(delete(path, customer).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        } finally {
            deleteSite(site);
        }
    }

    // ── 4. Die Flotten-Sicht ──────────────────────────────────────────────

    /**
     * Die Betriebs-Sicht spannt über die Mandanten: sie nennt je Anlage den
     * Pflege-Ort, die Herkunft der Komponenten und den Soll/Ist-Stand - und
     * behauptet nichts, wo die Box nichts gemeldet hat.
     */
    @Test
    void theComponentFleetSpansEveryTenantAndClaimsNothingUnmeasured() throws Exception {
        String admin = token("admin", "admin");
        UUID a = createSiteWithDevice(token("demo", "demo"), "Flotte A", "cf-a-01");
        UUID b = createSiteWithDevice(token("demo2", "demo2"), "Flotte B", "cf-b-01");
        try {
            JsonNode sites = json.readTree(get("/api/v1/admin/component-fleet", admin).getBody())
                    .path("sites");

            JsonNode rowA = siteRow(sites, a);
            JsonNode rowB = siteRow(sites, b);
            assertThat(rowA.path("tenantId").asText())
                    .isNotEqualTo(rowB.path("tenantId").asText());

            // Eine seit Stufe 1 im Portal entstandene Anlage ist portal-verwaltet.
            assertThat(rowA.path("componentAuthority").asText()).isEqualTo("portal");
            // Der Claim komponiert das Anlagen-Modell automatisch.
            assertThat(rowA.path("componentCount").asInt()).isGreaterThan(0);
            assertThat(rowA.path("sources").path("composed").asInt()).isGreaterThan(0);

            // ⚠ Keine Box hat gemeldet, also ist der Stand ehrlich „unreported"
            // - nie „angekommen", nie „verloren".
            assertThat(rowA.path("syncStatus").asText()).isEqualTo("unreported");
            assertThat(rowA.has("appliedAt")).isFalse();
            assertThat(rowA.path("write").has("certSource"))
                    .as("eine Freigabe-Herkunft, die niemand gemeldet hat, wird nicht erfunden")
                    .isFalse();
            assertThat(rowA.path("write").path("platformActivated").asInt()).isZero();

            // Jede Anlage der Plattform ist dabei, auch die Demo-Flotte.
            assertThat(sites.size()).isGreaterThanOrEqualTo(3);
        } finally {
            deleteSite(a);
            deleteSite(b);
        }
    }

    // ── Hilfen ────────────────────────────────────────────────────────────

    /**
     * ⚠ Das MODELL ist Teil des abgeleiteten Schlüssels, also besitzt jeder
     * Test sein eigenes - sonst räumte der eine die Vorlage des anderen ab
     * (das Register ist global, die Testreihenfolge nicht garantiert).
     */
    private static Map<String, Object> template(String model, String note) {
        Map<String, Object> t = new LinkedHashMap<>();
        t.put("brand", "acmetest");
        t.put("brandLabel", "ACME Prüfstand");
        t.put("model", model);
        t.put("modelLabel", "ACME Relais " + model);
        t.put("communication", "modbus_tcp");
        t.put("communicationLabel", "Modbus TCP");
        t.put("transportSchema", List.of(
                Map.of("key", "ip", "label", "IP-Adresse", "type", "text", "required", true),
                Map.of("key", "port", "label", "Port", "type", "number", "default", 502)));
        t.put("writes", List.of(write()));
        t.put("ratedKw", 3.5);
        t.put("controlTier", 1);
        t.put("certificationStatus", "certified");
        t.put("certificationNote", "Am Prüfstand gemessen");
        t.put("note", note);
        return t;
    }

    private static Map<String, Object> write() {
        Map<String, Object> w = new LinkedHashMap<>();
        w.put("key", "schalter");
        w.put("label", "Heizstab schalten");
        w.put("kind", "on_off");
        w.put("register", Map.of("fc", 6, "address", 50, "data_type", "u16"));
        w.put("on_value", 1);
        w.put("off_value", 0);
        w.put("safe_value", 0);
        return w;
    }

    private static Map<String, Object> writeWithout(String field) {
        Map<String, Object> w = write();
        w.remove(field);
        return w;
    }

    /** Die Fassung, die der ASSISTENT eines Kunden gerade anbietet. */
    private int publicVersion(String customerToken, String ref) throws Exception {
        ResponseEntity<String> res = get("/api/v1/component-templates/" + ref, customerToken);
        assertThat(res.getStatusCode()).as("Vorlage %s im Assistenten", ref)
                .isEqualTo(HttpStatus.OK);
        return json.readTree(res.getBody()).path("version").asInt();
    }

    private List<String> publicRefs(String customerToken) throws Exception {
        List<String> refs = new ArrayList<>();
        for (JsonNode t : json.readTree(get("/api/v1/component-templates", customerToken)
                .getBody())) {
            refs.add(t.path("templateRef").asText());
        }
        return refs;
    }

    private List<JsonNode> adminVersions(String adminToken, String ref) throws Exception {
        List<JsonNode> out = new ArrayList<>();
        for (JsonNode t : json.readTree(get(ADMIN_BASE, adminToken).getBody())) {
            if (ref.equals(t.path("templateRef").asText())) {
                out.add(t);
            }
        }
        return out;
    }

    private static JsonNode siteRow(JsonNode sites, UUID siteId) {
        for (JsonNode s : sites) {
            if (siteId.toString().equals(s.path("siteId").asText())) {
                return s;
            }
        }
        throw new AssertionError("Anlage " + siteId + " fehlt in der Flotten-Sicht");
    }

    private String message(ResponseEntity<String> res, HttpStatus expected) throws Exception {
        assertThat(res.getStatusCode()).isEqualTo(expected);
        return json.readTree(res.getBody()).path("message").asText();
    }

    /**
     * Eine Komponente MIT Vorlagen-Schnappschuss, per Superuser gesetzt - der
     * Anlege-Weg über die Vorlage bräuchte eine echte Box, und geprüft wird
     * hier die WIRKUNG der Rücknahme, nicht der Anlege-Weg.
     */
    private UUID insertComponentOn(UUID site, String ref, int version) {
        UUID id = UUID.randomUUID();
        exec("INSERT INTO measurement_point (id, tenant_id, site_id, role, label, entity_type, "
                + "source_kind, template_ref, template_version) SELECT '" + id + "', tenant_id, id,"
                + " 'consumer', 'Prüf-Komponente', 'modbus-generic', 'certified', '" + ref + "', "
                + version + " FROM site WHERE id = '" + site + "'");
        return id;
    }

    private UUID createCustomComponent(String token, UUID site, String label) throws Exception {
        receipts.record(site, SelfBuildComponentService.RECEIPT_REF,
                SelfBuildComponentService.receiptFields(
                        new SelfBuildDefinition.Transport("192.168.1.50", 502, 1)));
        Map<String, Object> channel = new LinkedHashMap<>();
        channel.put("label", "Vorlauf");
        channel.put("unit", "°C");
        channel.put("registerKind", "holding");
        channel.put("address", 100);
        channel.put("dataType", "s16");
        channel.put("wordOrder", "big");
        channel.put("scale", 0.1);
        channel.put("offset", 0.0);
        channel.put("minReadIntervalS", 10);

        ResponseEntity<String> res = post("/api/v1/sites/" + site + "/components/custom", token,
                Map.of("label", label,
                        "connection", Map.of("host", "192.168.1.50", "port", 502, "unitId", 1),
                        "channels", List.of(channel)));
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        for (JsonNode row : json.readTree(res.getBody()).path("components")) {
            if (label.equals(row.path("label").asText())) {
                return UUID.fromString(row.path("id").asText());
            }
        }
        throw new AssertionError("Komponente " + label + " fehlt");
    }

    private UUID createSiteWithDevice(String customerToken, String name, String ref) {
        UUID site = createSite(customerToken, name);
        assertThat(post("/api/v1/devices/claim", customerToken,
                Map.of("externalRef", ref, "siteId", site.toString(), "kind", "inverter"))
                .getStatusCode()).isIn(HttpStatus.OK, HttpStatus.CREATED);
        return site;
    }

    private UUID createSite(String customerToken, String name) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(url("/api/v1/sites"),
                HttpMethod.POST, new HttpEntity<>(Map.of("name", name), bearer(customerToken)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return UUID.fromString((String) res.getBody().get("id"));
    }

    private void deleteSite(UUID siteId) {
        exec("DELETE FROM site WHERE id = '" + siteId + "'");
    }

    /** Testvorlagen räumen sich selbst ab - das Register ist global. */
    private void cleanTemplate(String ref) {
        exec("DELETE FROM component_template WHERE template_ref = '" + ref + "'");
    }

    private void exec(String sql) {
        try (Connection c = superuser(); Statement st = c.createStatement()) {
            st.execute(sql);
        } catch (SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    private String scalar(String sql) {
        try (Connection c = superuser(); Statement st = c.createStatement();
                ResultSet rs = st.executeQuery(sql)) {
            return rs.next() ? rs.getString(1) : null;
        } catch (SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    private Connection superuser() throws SQLException {
        return java.sql.DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword());
    }

    private ResponseEntity<String> post(String path, String token, Object body) {
        return rest.exchange(url(path), HttpMethod.POST, new HttpEntity<>(body, bearer(token)),
                String.class);
    }

    private ResponseEntity<String> put(String path, String token, Object body) {
        return rest.exchange(url(path), HttpMethod.PUT, new HttpEntity<>(body, bearer(token)),
                String.class);
    }

    private ResponseEntity<String> get(String path, String token) {
        return rest.exchange(url(path), HttpMethod.GET, new HttpEntity<>(bearer(token)),
                String.class);
    }

    private ResponseEntity<String> delete(String path, String token) {
        return rest.exchange(url(path), HttpMethod.DELETE, new HttpEntity<>(bearer(token)),
                String.class);
    }

    private String url(String path) {
        return "http://localhost:" + port + path;
    }

    private static HttpHeaders bearer(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return headers;
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
        return (String) body.get("access_token");
    }
}
