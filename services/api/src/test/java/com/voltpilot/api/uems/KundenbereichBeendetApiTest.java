package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.kundenbereich.KundenbereichEndeFilter;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * NW-5 für UEMS AP-20 IP-16 (E10 = A, BT4, RF-08): der beendete Kundenbereich.
 *
 * <ul>
 *   <li><b>Jeder Schreibweg 409</b> — die Routen kommen aus dem Routen-Verzeichnis der laufenden Anwendung
 *       ({@link RequestMappingHandlerMapping}), keine Liste von Hand: jede Kundenroute mit POST/PUT/PATCH/DELETE
 *       und jede Plattform-Schreibroute, die einen Kundenbereich im Pfad trägt, antwortet
 *       {@code 409 kundenbereich_beendet}; der Fingerabdruck der ganzen Datenbank ist danach unverändert.
 *       Von Hand stehen nur die Ausnahmen — und sie sind genau (ein Eintrag ohne Route ist rot).</li>
 *   <li><b>Lesen für den Kundenadministrator</b> — er liest weiter, eine Leserin nicht mehr; beide sehen den
 *       Zustand in {@code /me}.</li>
 *   <li><b>Wiederaufnahme</b> — derselbe Kundenbereich schreibt wieder; beide Übergänge stehen im Protokoll, jeder
 *       einmalig.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class KundenbereichBeendetApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String BETREIBER = "betrieb-voss";
    private static final String NAME = "Kunststoffwerk Ahrenberg";
    private static final Pattern VARIABLE = Pattern.compile("\\{([^}:]+)(?::[^}]*)?}");

    /**
     * Plattform-Schreibrouten ohne Kundenbereich im Pfad — sie gehören keinem Kundenbereich und bleiben offen.
     * Schlüssel „METHODE pfad" wie im Routen-Verzeichnis. Genau: jede Route hier muss es geben.
     */
    private static final Map<String, String> OHNE_KUNDENBEREICH = ohneKundenbereich();

    private static Map<String, String> ohneKundenbereich() {
        Map<String, String> m = new TreeMap<>();
        m.put("POST /api/v1/admin/tenants", "legt einen neuen Kundenbereich an");
        m.put("POST /api/v1/admin/provisioned-devices", "vorregistrierte Box, noch in keinem Kundenbereich");
        m.put("DELETE /api/v1/admin/provisioned-devices/{externalRef}", "vorregistrierte Box, noch in keinem Kundenbereich");
        m.put("POST /api/v1/admin/forecast-models", "Plattform-Modell");
        m.put("POST /api/v1/admin/simulation", "Plattform-Simulation ohne Kundendaten");
        m.put("POST /api/v1/admin/edge-releases", "Box-Software der Plattform");
        m.put("POST /api/v1/admin/rollouts", "Flotten-Rollout — Befund im PR: er erreicht auch Boxen beendeter Bereiche");
        m.put("POST /api/v1/admin/control-certifications", "Freigaben je Gerätemodell, nicht je Kundenbereich");
        m.put("DELETE /api/v1/admin/control-certifications", "Freigaben je Gerätemodell, nicht je Kundenbereich");
        m.put("PUT /api/v1/admin/edge-trust-set", "Vertrauensanker der Box-Software der Plattform");
        m.put("POST /api/v1/admin/component-templates", "Vorlagen-Katalog der Plattform");
        m.put("POST /api/v1/admin/component-templates/{templateRef}/versions", "Vorlagen-Katalog der Plattform");
        m.put("POST /api/v1/admin/component-templates/{templateRef}/versions/{version}/withdraw",
                "Vorlagen-Katalog der Plattform");
        m.put("POST /api/v1/admin/component-templates/{templateRef}/versions/{version}/restore",
                "Vorlagen-Katalog der Plattform");
        return m;
    }

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", () -> APP_USER);
        registry.add("spring.datasource.password", () -> APP_PW);
        registry.add("voltpilot.admin-datasource.url", POSTGRES::getJdbcUrl);
        registry.add("voltpilot.admin-datasource.username", () -> "voltpilot_admin");
        registry.add("voltpilot.admin-datasource.password", () -> "voltpilot_admin_test_pw");
        registry.add("spring.flyway.placeholders.adminDbUser", () -> "voltpilot_admin");
        registry.add("spring.flyway.placeholders.adminDbPassword", () -> "voltpilot_admin_test_pw");
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
        registry.add("spring.flyway.placeholders.appDbUser", () -> APP_USER);
        registry.add("spring.flyway.placeholders.appDbPassword", () -> APP_PW);
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot");
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot/protocol/openid-connect/certs");
    }

    @Autowired MockMvc mvc;
    @Autowired @Qualifier("requestMappingHandlerMapping") RequestMappingHandlerMapping routen;
    @MockBean KeycloakAdminClient keycloak;

    private JdbcTemplate root;
    private UUID tenant;
    private UUID site;
    private UUID box;
    private String kundenadmin;
    private String leserin;

    @BeforeEach
    void seed() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        String nr = UUID.randomUUID().toString().substring(0, 8);
        tenant = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, NAME + " " + nr);
        UUID unternehmen = root.queryForObject("INSERT INTO unternehmen (tenant_id, name) VALUES (?, 'Ahrenberg') "
                + "RETURNING id", UUID.class, tenant);
        UUID standort = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone,"
                + " zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class,
                tenant, unternehmen);
        site = root.queryForObject("INSERT INTO site (tenant_id, name, bidding_zone) VALUES (?, 'Werk', 'DE-LU') "
                + "RETURNING id", UUID.class, tenant);
        box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) RETURNING id",
                UUID.class, tenant, site, "kb-ende-" + nr);
        kundenadmin = "jw-" + nr;
        leserin = "berger-" + nr;
        spiegel(kundenadmin);
        spiegel(leserin);
        zuweisung(kundenadmin, "kundenadministrator", null);
        zuweisung(leserin, "leser", standort);
    }

    /** NW-5: jeder Schreibweg aus dem Routen-Verzeichnis antwortet 409 — und die Datenbank bleibt, wie sie war. */
    @Test
    void jederSchreibwegDesBeendetenKundenbereichsIst409UndNichtsWirdGeschrieben() throws Exception {
        beenden(tenant);
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());

        List<String> befunde = new ArrayList<>();
        Set<String> ohne = new TreeSet<>();
        int kunde = 0;
        int plattform = 0;
        for (Map.Entry<RequestMappingInfo, ?> e : routen.getHandlerMethods().entrySet()) {
            Set<RequestMethod> methoden = e.getKey().getMethodsCondition().getMethods();
            Set<RequestMethod> schreibend = new TreeSet<>();
            for (RequestMethod m : methoden.isEmpty() ? Set.of(RequestMethod.POST) : methoden) {
                if (m == RequestMethod.POST || m == RequestMethod.PUT || m == RequestMethod.PATCH
                        || m == RequestMethod.DELETE) {
                    schreibend.add(m);
                }
            }
            for (String muster : e.getKey().getPatternValues()) {
                if (muster.equals("/error")) {
                    continue; // die Fehlerseite des Frameworks (BasicErrorController) — kein Schreibweg
                }
                if (!muster.startsWith("/api/v1/")) {
                    befunde.add(muster + ": Route außerhalb von /api/v1/ — der Filter kennt sie nicht");
                    continue;
                }
                for (RequestMethod m : schreibend) {
                    String schluessel = m + " " + muster;
                    boolean admin = muster.startsWith("/api/v1/admin/");
                    if (admin && ausnahme(muster)) {
                        continue;
                    }
                    if (admin && !muster.contains("{tenantId}") && !muster.contains("{siteId}")
                            && !muster.contains("{deviceId}")) {
                        ohne.add(schluessel);
                        continue;
                    }
                    MvcResult r = mvc.perform(request(HttpMethod.valueOf(m.name()), pfad(muster))
                            .contentType(MediaType.APPLICATION_JSON).content("{}")
                            .with(authentication(admin ? plattform() : konto(kundenadmin)))).andReturn();
                    String code = r.getResponse().getContentAsString(StandardCharsets.UTF_8).contains("\"code\"")
                            ? JSON.readTree(r.getResponse().getContentAsString(StandardCharsets.UTF_8)).path("code").asText() : "";
                    if (r.getResponse().getStatus() != 409 || !"kundenbereich_beendet".equals(code)) {
                        befunde.add(schluessel + ": " + r.getResponse().getStatus() + " " + code);
                    }
                    if (admin) {
                        plattform++;
                    } else {
                        kunde++;
                    }
                }
            }
        }
        System.out.printf("NW-5: %d Kunden-Schreibwege und %d Plattform-Schreibwege je 409 kundenbereich_beendet, "
                + "%d Plattform-Schreibwege ohne Kundenbereich%n", kunde, plattform, ohne.size());
        assertThat(befunde).as("Schreibwege ohne 409").isEmpty();
        assertThat(ohne).as("Plattform-Schreibwege ohne Kundenbereich = die Liste, genau")
                .containsExactlyInAnyOrderElementsOf(OHNE_KUNDENBEREICH.keySet());
        assertThat(kunde).as("Kunden-Schreibwege — ein kaputter Sucher fiele auf").isGreaterThanOrEqualTo(298);
        assertThat(plattform).as("Plattform-Schreibwege mit Kundenbereich").isGreaterThanOrEqualTo(44);
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of())))
                .as("kein Schreibweg hat etwas geschrieben").isEmpty();
    }

    /** NW-5: der Kundenadministrator liest weiter, eine Leserin nicht; beide sehen den Zustand und /me. */
    @Test
    void lesenBleibtNurFuerDenKundenadministrator() throws Exception {
        beenden(tenant);

        assertThat(ruf(get("/api/v1/sites"), konto(kundenadmin)).getResponse().getStatus()).isEqualTo(200);
        assertThat(ruf(get("/api/v1/unternehmen"), konto(kundenadmin)).getResponse().getStatus()).isEqualTo(200);

        MvcResult gesperrt = ruf(get("/api/v1/sites"), konto(leserin));
        assertThat(gesperrt.getResponse().getStatus()).isEqualTo(409);
        JsonNode koerper = JSON.readTree(gesperrt.getResponse().getContentAsString(StandardCharsets.UTF_8));
        assertThat(koerper.path("code").asText()).isEqualTo("kundenbereich_beendet");
        assertThat(koerper.path("message").asText()).contains("Nur Ihr Kundenadministrator");

        JsonNode endeAdmin = JSON.readTree(ruf(get("/api/v1/me"), konto(kundenadmin))
                .getResponse().getContentAsString(StandardCharsets.UTF_8)).path("kundenbereich").path("beendet");
        assertThat(endeAdmin.path("liest").asBoolean()).isTrue();
        assertThat(endeAdmin.path("loeschung_fruehestens").asText()).isNotBlank();
        assertThat(endeAdmin.path("text").asText()).startsWith("Ihr Vertrag ist am ")
                .contains("nur noch lesen").contains("frühestens am");
        MvcResult meLeserin = ruf(get("/api/v1/me"), konto(leserin));
        assertThat(meLeserin.getResponse().getStatus()).as("die Selbstauskunft erreicht jede Person").isEqualTo(200);
        JsonNode endeLeserin = JSON.readTree(meLeserin.getResponse().getContentAsString(StandardCharsets.UTF_8))
                .path("kundenbereich").path("beendet");
        assertThat(endeLeserin.path("liest").asBoolean()).isFalse();
        assertThat(endeLeserin.path("text").asText()).contains("Nur Ihr Kundenadministrator");

        // Der Umschalter der Plattform liest einen beendeten Bereich nicht als Kunde; die Plattform-Liste bleibt.
        assertThat(ruf(get("/api/v1/sites").header("X-Tenant-Id", tenant.toString()), plattform())
                .getResponse().getStatus()).isEqualTo(409);
        assertThat(ruf(get("/api/v1/admin/tenants"), plattform()).getResponse().getStatus()).isEqualTo(200);
        // Ein Kundenkonto erfährt über eine Plattform-Route nichts über den Zustand: dort gilt weiter 403.
        assertThat(ruf(post("/api/v1/admin/tenants/" + tenant + "/users").contentType(MediaType.APPLICATION_JSON)
                .content("{}"), konto(kundenadmin)).getResponse().getStatus()).isEqualTo(403);
    }

    /** NW-5: Wiederaufnahme gibt alles frei; jeder Übergang ist einmalig und steht im Plattform-Protokoll. */
    @Test
    void wiederaufnahmeGibtFreiUndJederUebergangIstEinmaligImProtokoll() throws Exception {
        MvcResult falscherName = ruf(post("/api/v1/admin/tenants/" + tenant + "/beenden")
                .contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(Map.of("auftrag", "Kündigung",
                        "begruendung", "Vertragsende", "confirmName", "Falscher Name"))), plattform());
        assertThat(falscherName.getResponse().getStatus()).isEqualTo(400);
        assertThat(zustandSpalte()).isNull();

        JsonNode beendet = beenden(tenant);
        assertThat(beendet.path("frist_tage").asInt()).isEqualTo(90);
        assertThat(ruf(post("/api/v1/admin/tenants/" + tenant + "/beenden").contentType(MediaType.APPLICATION_JSON)
                .content(beendenKoerper()), plattform()).getResponse().getStatus()).as("einmalig").isEqualTo(409);
        assertThat(ruf(get("/api/v1/sites"), konto(leserin)).getResponse().getStatus()).isEqualTo(409);

        MvcResult zurueck = ruf(post("/api/v1/admin/tenants/" + tenant + "/wiederaufnehmen")
                .contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(Map.of(
                        "auftrag", "Rücknahme der Kündigung", "begruendung", "Kunde verlängert"))), plattform());
        assertThat(zurueck.getResponse().getStatus()).isEqualTo(200);
        assertThat(ruf(post("/api/v1/admin/tenants/" + tenant + "/wiederaufnehmen").contentType(MediaType.APPLICATION_JSON)
                .content(JSON.writeValueAsString(Map.of("auftrag", "a", "begruendung", "b"))), plattform())
                .getResponse().getStatus()).as("einmalig").isEqualTo(409);

        assertThat(zustandSpalte()).isNull();
        assertThat(ruf(get("/api/v1/sites"), konto(leserin)).getResponse().getStatus()).isEqualTo(200);
        MvcResult schreiben = ruf(post("/api/v1/sites").contentType(MediaType.APPLICATION_JSON).content("{}"),
                konto(kundenadmin));
        assertThat(schreiben.getResponse().getContentAsString(StandardCharsets.UTF_8)).doesNotContain("kundenbereich_beendet");
        assertThat(JSON.readTree(ruf(get("/api/v1/me"), konto(leserin)).getResponse()
                .getContentAsString(StandardCharsets.UTF_8)).path("kundenbereich").path("beendet").isNull())
                .as("aktiv: beendet ist null").isTrue();

        List<Map<String, Object>> protokoll = root.queryForList("SELECT von, nach, auftrag, frist_tage, akteur_sub,"
                + " akteur_name FROM kundenbereich_uebergang WHERE tenant_id = ? ORDER BY id", tenant);
        assertThat(protokoll).hasSize(2);
        assertThat(protokoll.get(0)).containsEntry("von", "aktiv").containsEntry("nach", "beendet")
                .containsEntry("frist_tage", 90).containsEntry("akteur_sub", BETREIBER);
        assertThat(protokoll.get(1)).containsEntry("von", "beendet").containsEntry("nach", "aktiv")
                .containsEntry("auftrag", "Rücknahme der Kündigung");
    }

    /** Die Datenbank hält die Regeln auch ohne die Routen: nie umgeschrieben, nie durch die App-Rolle. */
    @Test
    void dieDatenbankHaeltEinmaligUndNurBetrieb() throws Exception {
        beenden(tenant);
        assertThatThrownBy(() -> root.update("UPDATE tenant SET beendet_frist_tage = 30 WHERE id = ?", tenant))
                .hasStackTraceContaining("nicht umgeschrieben");
        JdbcTemplate app = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), APP_USER, APP_PW));
        assertThatThrownBy(() -> app.execute((java.sql.Connection c) -> {
            try (var s = c.createStatement()) {
                s.execute("SELECT set_config('app.tenant_id', '" + tenant + "', false)");
                s.executeUpdate("UPDATE tenant SET beendet_am = NULL, beendet_frist_tage = NULL, beendet_von = NULL");
            }
            return null;
        })).hasStackTraceContaining("nur der Betrieb");
        assertThatThrownBy(() -> app.queryForList("SELECT * FROM kundenbereich_uebergang"))
                .hasStackTraceContaining("permission denied");
    }

    private boolean ausnahme(String muster) {
        Matcher m = Pattern.compile("^/api/v1/admin/tenants/\\{tenantId}(/.*)$").matcher(muster);
        if (!m.matches()) {
            return false;
        }
        String rest = m.group(1).replaceAll("\\{[^}]+}", "x");
        return KundenbereichEndeFilter.ADMIN_AUSNAHMEN.stream().anyMatch(a -> a.matcher(rest).matches());
    }

    /** Die Ausnahmen der Plattform sind genau: jede trifft eine Route. */
    @Test
    void jedeAusnahmeDerPlattformHatIhreRoute() {
        Set<String> admin = new TreeSet<>();
        routen.getHandlerMethods().keySet().forEach(i -> admin.addAll(i.getPatternValues()));
        for (Pattern a : KundenbereichEndeFilter.ADMIN_AUSNAHMEN) {
            assertThat(admin.stream().filter(p -> p.startsWith("/api/v1/admin/tenants/{tenantId}/"))
                    .map(p -> p.substring("/api/v1/admin/tenants/{tenantId}".length()).replaceAll("\\{[^}]+}", "x"))
                    .anyMatch(rest -> a.matcher(rest).matches())).as(a.pattern()).isTrue();
        }
    }

    private String pfad(String muster) {
        Matcher m = VARIABLE.matcher(muster.replace("/**", "/x"));
        StringBuilder aus = new StringBuilder();
        while (m.find()) {
            String name = m.group(1);
            String wert = switch (name) {
                case "tenantId" -> tenant.toString();
                case "siteId" -> site.toString();
                case "deviceId" -> box.toString();
                default -> name.toLowerCase().endsWith("id") ? UUID.randomUUID().toString() : "x";
            };
            m.appendReplacement(aus, Matcher.quoteReplacement(wert));
        }
        m.appendTail(aus);
        return aus.toString();
    }

    private JsonNode beenden(UUID kunde) throws Exception {
        MvcResult r = ruf(post("/api/v1/admin/tenants/" + kunde + "/beenden").contentType(MediaType.APPLICATION_JSON)
                .content(beendenKoerper()), plattform());
        assertThat(r.getResponse().getStatus()).as(r.getResponse().getContentAsString(StandardCharsets.UTF_8)).isEqualTo(200);
        return JSON.readTree(r.getResponse().getContentAsString(StandardCharsets.UTF_8));
    }

    private String beendenKoerper() throws Exception {
        String name = root.queryForObject("SELECT name FROM tenant WHERE id = ?", String.class, tenant);
        return JSON.writeValueAsString(Map.of("auftrag", "Kündigung zum 30.06.2029 (Annahme)", "begruendung",
                "Vertragsende RF-08", "confirmName", name));
    }

    private Object zustandSpalte() {
        return root.queryForObject("SELECT beendet_am FROM tenant WHERE id = ?", Object.class, tenant);
    }

    private void spiegel(String wer) {
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', ?, 'aktiv')",
                tenant, wer, wer);
    }

    private void zuweisung(String wer, String rolle, UUID ort) {
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, ?, ?, '2024-01-01T00:00:00Z', 'Europe/Berlin')", tenant, wer, rolle, ort);
    }

    private MvcResult ruf(MockHttpServletRequestBuilder anfrage, Authentication auth) throws Exception {
        return mvc.perform(anfrage.with(authentication(auth))).andReturn();
    }

    private Authentication konto(String wer) {
        return auth(wer, tenant, false);
    }

    private static Authentication plattform() {
        return auth(BETREIBER, null, true);
    }

    private static Authentication auth(String wer, UUID kunde, boolean plattform) {
        Map<String, Object> claims = new HashMap<>();
        claims.put("sub", wer);
        claims.put("preferred_username", wer);
        claims.put("realm_access", Map.of("roles", plattform ? List.of("platform-admin") : List.of()));
        if (kunde != null) {
            claims.put("tenant_id", kunde.toString());
        }
        return new KeycloakRealmRoleConverter().convert(new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600),
                Map.of("alg", "none"), claims));
    }
}
