package com.voltpilot.api.benutzer;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.admin.KeycloakAdminClient;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/** Echte Keycloak-Required-Action, echte RLS-Rolle und DEBUG-Logprüfung ohne Geheimnisse in Testausgaben. */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class BenutzerStartpasswortApiTest {
    @Container static final PostgreSQLContainer<?> DB = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");
    @Container static final KeycloakContainer KC = new KeycloakContainer("quay.io/keycloak/keycloak:26.0.5")
            .withRealmImportFile("keycloak/voltpilot-realm.json");

    @DynamicPropertySource static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", DB::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "voltpilot_app_test_pw");
        r.add("voltpilot.admin-datasource.url", DB::getJdbcUrl);
        r.add("voltpilot.admin-datasource.username", () -> "voltpilot_admin");
        r.add("voltpilot.admin-datasource.password", () -> "voltpilot_admin_test_pw");
        r.add("spring.flyway.url", DB::getJdbcUrl);
        r.add("spring.flyway.user", DB::getUsername);
        r.add("spring.flyway.password", DB::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "voltpilot_app_test_pw");
        r.add("spring.flyway.placeholders.adminDbUser", () -> "voltpilot_admin");
        r.add("spring.flyway.placeholders.adminDbPassword", () -> "voltpilot_admin_test_pw");
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> KC.getAuthServerUrl() + "/realms/voltpilot");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri", () -> KC.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/certs");
        r.add("voltpilot.keycloak.admin.base-url", KC::getAuthServerUrl);
        r.add("voltpilot.keycloak.admin.client-id", () -> "voltpilot-api");
        r.add("voltpilot.keycloak.admin.client-secret", () -> "voltpilot-api-dev-secret");
    }

    @LocalServerPort int port;
    @Autowired KeycloakAdminClient keycloak;
    static final ObjectMapper JSON = new ObjectMapper();
    static final HttpClient HTTP = HttpClient.newHttpClient();
    // Sämtliche Antworten des Ablaufs erfassen, auch Token- und Fehlerantworten; niemals ausgeben.
    static final List<String> HTTP_ANTWORTEN = new ArrayList<>();
    record Antwort(int status, String body, String cache) {
        JsonNode json() throws Exception { return JSON.readTree(body); }
        @Override public String toString() { return "Antwort[status=" + status + "]"; }
    }

    @Test void pflichtwechselEinmaligeAntwortNeuvergabeUndErsteAnmeldungMitZaun() throws Exception {
        Logger root = (Logger) LoggerFactory.getLogger(Logger.ROOT_LOGGER_NAME);
        List<ch.qos.logback.core.Appender<ILoggingEvent>> ausgaben = new ArrayList<>();
        root.iteratorForAppenders().forEachRemaining(ausgaben::add);
        ausgaben.forEach(root::detachAppender);
        ListAppender<ILoggingEvent> logs = new ListAppender<>(); logs.start(); root.addAppender(logs);
        List<Logger> debug = List.of((Logger) LoggerFactory.getLogger("org.springframework.web.client"),
                (Logger) LoggerFactory.getLogger("org.springframework.web.servlet.mvc.method.annotation"),
                (Logger) LoggerFactory.getLogger("com.voltpilot"));
        List<Level> vorher = debug.stream().map(Logger::getLevel).toList();
        debug.forEach(l -> l.setLevel(Level.DEBUG));
        List<String> geheimnisse = new ArrayList<>();
        List<String> sonstigeAntworten = new ArrayList<>();
        try {
            String plattform = token("admin", "admin");
            String tenant = api("POST", "/api/v1/admin/tenants", plattform,
                    Map.of("name", "Kunststoffwerk Ahrenberg", "segment", "CI")).json().path("id").asText();
            String basis = "/api/v1/admin/tenants/" + tenant + "/users";
            Antwort erster = api("POST", basis, plattform, Map.of("username", "ip14-jonas", "email", "jonas@ip14.example"));
            assertThat(erster.status()).isEqualTo(201);
            String adminSub = erster.json().path("benutzer").path("sub").asText();
            String adminPasswort = einmal(erster, geheimnisse);
            keinTokenOhneWechsel("ip14-jonas", adminPasswort);
            keycloak.resetPassword(adminSub, "Eigenes-Jonas-Passwort-24!", false);
            String jonas = token("ip14-jonas", "Eigenes-Jonas-Passwort-24!");
            Antwort me = api("GET", "/api/v1/me", jonas, null);
            assertThat(me.json().path("zustand").asText()).isEqualTo("aktiv");
            sonstigeAntworten.add(me.body());
            Antwort zweitePlattform = api("POST", basis, plattform, Map.of("username", "ip14-zweiter", "email", "zweiter@ip14.example"));
            assertThat(zweitePlattform.status()).isEqualTo(403);
            assertThat(zweitePlattform.json().path("code").asText()).isEqualTo("recht_fehlt");
            sonstigeAntworten.add(zweitePlattform.body());

            // A9: Standortrolle verlangt einen Standort; mit zwei Standorten bleibt die Auswahl ausdrücklich.
            Antwort ohneStandort = api("POST", "/api/v1/benutzer", jonas, Map.of("username", "ip13-claudia",
                    "email", "claudia@ip13.example", "rolle", "leser", "standorte", List.of()));
            assertThat(ohneStandort.status()).isEqualTo(422);
            assertThat(ohneStandort.json().path("code").asText()).isEqualTo("standort_fehlt");
            UUID unternehmen = rootDb().queryForObject("SELECT id FROM unternehmen WHERE tenant_id = ?::uuid", UUID.class, tenant);
            UUID st1 = rootDb().queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                    + "VALUES (?::uuid, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, tenant, unternehmen);
            UUID st2 = rootDb().queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                    + "VALUES (?::uuid, ?, 'Werk Lindach', 'ST-2', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, tenant, unternehmen);
            Antwort claudia = api("POST", "/api/v1/benutzer", jonas, Map.of("username", "ip13-claudia",
                    "email", "claudia@ip13.example", "rolle", "leser", "standorte", List.of(st1, st2)));
            assertThat(claudia.status()).isEqualTo(201);
            String claudiaSub = claudia.json().path("benutzer").path("sub").asText();
            keinTokenOhneWechsel("ip13-claudia", einmal(claudia, geheimnisse));
            keycloak.resetPassword(claudiaSub, "Eigenes-Claudia-Passwort-24!", false);
            Antwort claudiaMe = api("GET", "/api/v1/me", token("ip13-claudia", "Eigenes-Claudia-Passwort-24!"), null);
            assertThat(claudiaMe.json().path("standorte").size()).isEqualTo(2);
            keycloak.createCustomerUser(UUID.fromString("10000000-0000-0000-0000-000000000001"), "ip13-fremd",
                    "fremd@ip13.example", null, null, "Fremdes-Testpasswort-24!", true);
            Antwort emailFremd = api("POST", "/api/v1/benutzer", jonas, Map.of("username", "anderer-name", "email", "fremd@ip13.example",
                    "rolle", "energiemanager", "standorte", List.of()));
            assertThat(emailFremd.status()).isEqualTo(409);
            assertThat(emailFremd.json().path("code").asText()).isEqualTo("email_fremder_kundenbereich");

            Antwort erstellt = api("POST", "/api/v1/benutzer", jonas, Map.of("username", "ip14-ines", "email", "ines@ip14.example",
                    "vorname", "Ines", "nachname", "Kaltenbach", "rolle", "energiemanager", "standorte", List.of(),
                    "tenant_id", "10000000-0000-0000-0000-000000000001"));
            assertThat(erstellt.status()).isEqualTo(201);
            String sub = erstellt.json().path("benutzer").path("sub").asText();
            String passwort = einmal(erstellt, geheimnisse);
            assertThat(keycloak.getUser(sub).tenantId()).isEqualTo(tenant);
            assertThat(zustand(tenant, sub)).isEqualTo("angelegt");
            keinTokenOhneWechsel("ip14-ines", passwort);
            keycloak.resetPassword(sub, "Eigenes-Ines-Passwort-24!", false);
            String ines = token("ip14-ines", "Eigenes-Ines-Passwort-24!");
            Antwort aktiv = api("GET", "/api/v1/me", ines, null);
            assertThat(aktiv.json().path("zustand").asText()).isEqualTo("aktiv");
            sonstigeAntworten.add(aktiv.body());
            sonstigeAntworten.add(api("GET", "/api/v1/me", ines, null).body());
            assertThat(protokoll(tenant, sub, "erste_anmeldung")).isEqualTo(1);

            Antwort verweigert = api("POST", "/api/v1/benutzer/" + adminSub + "/startpasswort", ines, null);
            assertThat(verweigert.status()).isEqualTo(403);
            assertThat(verweigert.json().path("code").asText()).isEqualTo("recht_fehlt");
            sonstigeAntworten.add(verweigert.body());
            Antwort fremd = api("POST", "/api/v1/benutzer/" + sub + "/startpasswort", token("demo2", "demo2"), null);
            assertThat(fremd.status()).isEqualTo(404);
            sonstigeAntworten.add(fremd.body());
            Antwort support = api("POST", basis + "/" + sub + "/reset-password", plattform, Map.of("password", "Ignoriert"));
            assertThat(support.status()).isEqualTo(403); sonstigeAntworten.add(support.body());

            Antwort neu = api("POST", "/api/v1/benutzer/" + sub + "/startpasswort", jonas, null);
            assertThat(neu.status()).isEqualTo(200);
            String neuesPasswort = einmal(neu, geheimnisse);
            assertThat(!neuesPasswort.equals(passwort)).isTrue();
            assertThat(protokoll(tenant, sub, "startpasswort_neu")).isEqualTo(1);
            keinTokenOhneWechsel("ip14-ines", neuesPasswort);
            assertThat(zustand(tenant, sub)).isEqualTo("aktiv");
            sonstigeAntworten.add(api("GET", basis, plattform, null).body());
            sonstigeAntworten.add(api("GET", "/api/v1/zugriffe?benutzer=" + sub, jonas, null).body());
            sonstigeAntworten.add(rootDb().queryForList("SELECT row_to_json(p)::text FROM zugriff_protokoll p WHERE tenant_id = ?::uuid", String.class, tenant).toString());
            sonstigeAntworten.add(rootDb().queryForList("SELECT row_to_json(b)::text FROM benutzer b WHERE tenant_id = ?::uuid", String.class, tenant).toString());
            for (String geheimnis : geheimnisse) {
                // Absichtlich nur booleans prüfen: auch ein Fehlschlag darf kein Passwort drucken.
                assertThat(HTTP_ANTWORTEN.stream().filter(a -> a.contains(geheimnis)).count())
                        .as("genau eine HTTP-Antwort enthält das Startpasswort").isEqualTo(1);
                assertThat(sonstigeAntworten.stream().noneMatch(a -> a.contains(geheimnis))).as("keine weitere Antwort oder DB-Zeile enthält das Passwort").isTrue();
                assertThat(logs.list.stream().noneMatch(l -> (l.getFormattedMessage()
                        + (l.getThrowableProxy() == null ? "" : ch.qos.logback.classic.spi.ThrowableProxyUtil.asString(l.getThrowableProxy())))
                        .contains(geheimnis))).as("auch DEBUG und Exception-Stacks protokollieren kein Startpasswort").isTrue();
            }
        } finally {
            root.detachAppender(logs);
            ausgaben.forEach(root::addAppender);
            for (int i = 0; i < debug.size(); i++) debug.get(i).setLevel(vorher.get(i));
        }
    }

    @Test void partnerNutztDenselbenPflichtwechselUndRealmPolicyGiltServerseitig() throws Exception {
        UUID tenant = UUID.fromString("00000000-0000-0000-0000-000000000001");
        UUID unternehmen = rootDb().queryForList("SELECT id FROM unternehmen WHERE tenant_id = ?", UUID.class, tenant)
                .stream().findFirst().orElseGet(() -> rootDb().queryForObject("INSERT INTO unternehmen (tenant_id, name) "
                        + "VALUES (?, 'Kunststoffwerk Ahrenberg GmbH') RETURNING id", UUID.class, tenant));
        UUID standort = rootDb().queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, "
                + "zeitzone, zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-IP14', 'Europe/Berlin', 'aktiv') RETURNING id",
                UUID.class, tenant, unternehmen);
        Antwort gewaehren = api("POST", "/api/v1/unterstuetzung", token("demo", "demo"), Map.of("art", "installateur",
                "email", "brunner@ip14.example", "standorte", List.of(standort.toString()), "umfang", "einrichten",
                "gueltig_bis", java.time.LocalDate.now().plusDays(7).toString()));
        assertThat(gewaehren.status()).isEqualTo(201);
        String pw = gewaehren.json().path("startpasswort").asText();
        var partner = keycloak.findByEmail("brunner@ip14.example").orElseThrow();
        assertThat(partner.tenantId()).isNull();
        assertThat(zustand(tenant.toString(), partner.id())).isEqualTo("angelegt");
        keinTokenOhneWechsel("brunner@ip14.example", pw);
        keycloak.resetPassword(partner.id(), "Eigenes-Brunner-Passwort-24!", false);
        String partnerToken = token("brunner@ip14.example", "Eigenes-Brunner-Passwort-24!");
        HttpRequest me = HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/v1/me"))
                .header("Authorization", "Bearer " + partnerToken).header("X-Kundenbereich", tenant.toString()).GET().build();
        assertThat(send(me).status()).isEqualTo(200);
        assertThat(zustand(tenant.toString(), partner.id())).isEqualTo("aktiv");
        assertThat(protokoll(tenant.toString(), partner.id(), "erste_anmeldung")).isEqualTo(1);
        assertThat(api("GET", "/api/v1/unterstuetzung", token("demo", "demo"), null).body().contains(pw)).isFalse();
        String master = form(KC.getAuthServerUrl() + "/realms/master/protocol/openid-connect/token",
                Map.of("grant_type", "password", "client_id", "admin-cli", "username", KC.getAdminUsername(), "password", KC.getAdminPassword())).json().path("access_token").asText();
        String realm = KC.getAuthServerUrl() + "/admin/realms/voltpilot";
        Antwort vorher = http("GET", realm, master, null);
        try {
            assertThat(http("PUT", realm, master, Map.of("passwordPolicy", "length(100)")).status()).isEqualTo(204);
            boolean abgelehnt = false;
            try { new StartpasswortKonten(keycloak).partner("policy@ip14.example"); }
            catch (KeycloakAdminClient.KeycloakAdminException e) { abgelehnt = e.status() == 400; }
            assertThat(abgelehnt).as("Keycloak wendet die Realm-Passwortregeln an").isTrue();
            assertThat(keycloak.findByEmail("policy@ip14.example").isEmpty()).isTrue();
        } finally {
            http("PUT", realm, master, Map.of("passwordPolicy", vorher.json().path("passwordPolicy").asText("")));
        }
        assertThat(HTTP_ANTWORTEN.stream().filter(a -> a.contains(pw)).count()).isEqualTo(1);
    }

    private String einmal(Antwort a, List<String> geheimnisse) throws Exception {
        String pw = a.json().path("startpasswort").asText();
        assertThat(pw.length()).isEqualTo(24);
        assertThat(a.body().indexOf(pw) == a.body().lastIndexOf(pw)).isTrue();
        assertThat(a.cache()).contains("no-store"); geheimnisse.add(pw); return pw;
    }
    private void keinTokenOhneWechsel(String username, String pw) throws Exception {
        for (int i = 0; i < 2; i++) {
            Antwort a = login(username, pw);
            assertThat(a.status()).isEqualTo(400);
            assertThat(a.json().has("access_token")).isFalse();
            assertThat(a.json().path("error").asText()).isEqualTo("invalid_grant");
        }
    }
    private String zustand(String tenant, String sub) { return rootDb().queryForObject("SELECT zustand FROM benutzer WHERE tenant_id = ?::uuid AND sub = ?", String.class, tenant, sub); }
    private int protokoll(String tenant, String sub, String aktion) { return rootDb().queryForObject("SELECT count(*) FROM zugriff_protokoll WHERE tenant_id = ?::uuid AND betroffener_sub = ? AND aktion = ?", Integer.class, tenant, sub, aktion); }
    private JdbcTemplate rootDb() { return new JdbcTemplate(new DriverManagerDataSource(DB.getJdbcUrl(), DB.getUsername(), DB.getPassword())); }
    private Antwort api(String method, String path, String token, Object body) throws Exception { return http(method, "http://localhost:" + port + path, token, body); }
    private static String token(String username, String password) throws Exception {
        Antwort a = login(username, password); assertThat(a.status()).isEqualTo(200); return a.json().path("access_token").asText();
    }
    private static Antwort login(String username, String password) throws Exception { return form(KC.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token", Map.of("grant_type", "password", "client_id", "voltpilot-api", "client_secret", "voltpilot-api-dev-secret", "scope", "openid", "username", username, "password", password)); }
    private static Antwort form(String url, Map<String, String> body) throws Exception {
        String form = body.entrySet().stream().map(e -> e.getKey() + "=" + URLEncoder.encode(e.getValue(), StandardCharsets.UTF_8)).collect(java.util.stream.Collectors.joining("&"));
        return send(HttpRequest.newBuilder(URI.create(url)).header("Content-Type", "application/x-www-form-urlencoded").POST(HttpRequest.BodyPublishers.ofString(form)).build());
    }
    private static Antwort http(String method, String url, String token, Object body) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url)).header("Authorization", "Bearer " + token).header("Content-Type", "application/json");
        return send(b.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body))).build());
    }
    private static Antwort send(HttpRequest req) throws Exception {
        HttpResponse<String> r = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
        HTTP_ANTWORTEN.add(r.body());
        return new Antwort(r.statusCode(), r.body(), r.headers().firstValue("cache-control").orElse(""));
    }
}
