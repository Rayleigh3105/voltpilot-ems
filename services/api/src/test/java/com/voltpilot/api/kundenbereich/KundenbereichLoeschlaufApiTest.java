package com.voltpilot.api.kundenbereich;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.Statement;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der Löschzug als serverseitiger Auftrag (vp-kunde-loeschen-504): das Löschen hängt an keinem
 * HTTP-Request mehr, der Lauf sagt ehrlich, was geschah.
 *
 * <ul>
 *   <li><b>Scheitern ist ehrlich und wiederholbar:</b> rollt der Abbau zurück, steht der Lauf auf
 *       „gescheitert" mit „es wurde nichts gelöscht" - der Bereich ist unversehrt, der nächste
 *       Versuch startet einen NEUEN Lauf und löscht.</li>
 *   <li><b>Kein zweiter Zug:</b> ein zweiter POST während eines laufenden Zugs bekommt denselben
 *       Lauf zurück (Doppelklick, zweiter Browser-Tab).</li>
 *   <li><b>Verwaiste Läufe lösen sich ehrlich auf:</b> ein Absturz hinterlässt „laeuft" mit
 *       verhungertem Herzschlag; der Statusweg macht daraus „gescheitert - nichts gelöscht"
 *       (Mandant noch da) oder „fertig" (Mandant weg, Bericht verloren).</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class KundenbereichLoeschlaufApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String BETREIBER = "betrieb-voss";

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
    @MockitoBean KeycloakAdminClient keycloak;

    private JdbcTemplate root;

    @BeforeEach
    void verbinden() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    /** Scheitert der Abbau, sagt der Lauf es ehrlich - und der nächste Versuch löscht wirklich. */
    @Test
    void einGescheiterterZugIstEhrlichUndWiederholbar() throws Exception {
        Kunde kunde = kunde();
        root.execute("CREATE OR REPLACE FUNCTION loeschlauf_probe_sperrt() RETURNS trigger LANGUAGE plpgsql AS"
                + " $$ BEGIN RAISE EXCEPTION 'probe: Abbau verweigert'; END $$");
        root.execute("CREATE TRIGGER loeschlauf_probe_sperrt BEFORE DELETE ON tenant FOR EACH ROW"
                + " WHEN (OLD.id = '" + kunde.id() + "'::uuid) EXECUTE FUNCTION loeschlauf_probe_sperrt()");
        try {
            JsonNode gescheitert = laufAbwarten(kunde.id(), starten(kunde));
            assertThat(gescheitert.get("stand").asText()).isEqualTo("gescheitert");
            assertThat(gescheitert.get("fehler").asText()).contains("nichts gelöscht");
            assertThat(gescheitert.get("bericht").isNull()).isTrue();
            assertThat(root.queryForObject("SELECT count(*) FROM tenant WHERE id = ?", Long.class, kunde.id()))
                    .as("Rollback: der Bereich ist unversehrt").isOne();
            assertThat(root.queryForObject("SELECT count(*) FROM mandant_loeschnachweis WHERE kundenbereich = ?",
                    Long.class, kunde.id())).isZero();

            root.execute("DROP TRIGGER loeschlauf_probe_sperrt ON tenant");
            JsonNode zweiter = laufAbwarten(kunde.id(), starten(kunde));
            assertThat(zweiter.get("laufId").asText()).isNotEqualTo(gescheitert.get("laufId").asText());
            assertThat(zweiter.get("stand").asText()).as(zweiter.toString()).isEqualTo("fertig");
            assertThat(root.queryForObject("SELECT count(*) FROM tenant WHERE id = ?", Long.class, kunde.id()))
                    .isZero();
        } finally {
            root.execute("DROP TRIGGER IF EXISTS loeschlauf_probe_sperrt ON tenant");
            root.execute("DROP FUNCTION loeschlauf_probe_sperrt()");
        }
    }

    /** Doppelklick/zweiter Tab: solange ein Zug läuft, startet kein zweiter - es ist derselbe Lauf. */
    @Test
    void einZweiterVersuchWaehrendDesLaufsBekommtDenselbenLauf() throws Exception {
        Kunde kunde = kunde();
        try (Connection sperre = POSTGRES.createConnection("")) {
            sperre.setAutoCommit(false);
            try (Statement st = sperre.createStatement()) {
                // Dieselbe erste Sperre wie der Abbau (TenantRepository.offboard): der Zug wartet hier.
                st.executeQuery("SELECT pg_advisory_xact_lock(hashtext('uems-benutzerverwaltung:"
                        + kunde.id() + "'))").close();
            }
            try {
                JsonNode erster = starten(kunde);
                JsonNode zweiter = starten(kunde);
                assertThat(zweiter.get("laufId").asText()).as("derselbe Lauf, kein zweiter Zug")
                        .isEqualTo(erster.get("laufId").asText());
                assertThat(zweiter.get("stand").asText()).isEqualTo("laeuft");
                JsonNode stand = stand(kunde.id());
                assertThat(stand.get("stand").asText()).isEqualTo("laeuft");
            } finally {
                sperre.rollback();
            }
        }
        JsonNode fertig = laufAbwarten(kunde.id(), stand(kunde.id()));
        assertThat(fertig.get("stand").asText()).as(fertig.toString()).isEqualTo("fertig");
        assertThat(root.queryForObject("SELECT count(*) FROM tenant WHERE id = ?", Long.class, kunde.id())).isZero();
    }

    /** Ein Absturz hinterlässt „laeuft" mit verhungertem Herzschlag; der Statusweg macht es ehrlich. */
    @Test
    void einVerwaisterLaufWirdBeimHinsehenEhrlich() throws Exception {
        // Mandant noch da -> die Transaktion ist zurückgerollt: „gescheitert - nichts gelöscht".
        Kunde kunde = kunde();
        root.update("INSERT INTO kundenbereich_loeschlauf (kundenbereich, name, gestartet_von_sub,"
                + " gestartet_von_name, gestartet_am, herzschlag_am) VALUES (?, ?, ?, ?,"
                + " now() - interval '10 minutes', now() - interval '10 minutes')",
                kunde.id(), kunde.name(), BETREIBER, BETREIBER);
        JsonNode gescheitert = stand(kunde.id());
        assertThat(gescheitert.get("stand").asText()).isEqualTo("gescheitert");
        assertThat(gescheitert.get("fehler").asText()).contains("unterbrochen").contains("nichts gelöscht");

        // Mandant weg -> der Abbau hatte committet: „fertig", nur der Bericht fehlt.
        UUID geloescht = UUID.randomUUID();
        root.update("INSERT INTO kundenbereich_loeschlauf (kundenbereich, name, gestartet_von_sub,"
                + " gestartet_von_name, gestartet_am, herzschlag_am) VALUES (?, 'Weg Gmbh', ?, ?,"
                + " now() - interval '10 minutes', now() - interval '10 minutes')",
                geloescht, BETREIBER, BETREIBER);
        JsonNode fertig = stand(geloescht);
        assertThat(fertig.get("stand").asText()).isEqualTo("fertig");
        assertThat(fertig.get("bericht").isNull()).isTrue();
    }

    /** Ohne je einen Lauf antwortet der Statusweg 404. */
    @Test
    void ohneLaufAntwortetDerStatusweg404() throws Exception {
        MvcResult r = mvc.perform(get("/api/v1/admin/tenants/" + UUID.randomUUID() + "/loeschlauf")
                .with(authentication(plattform()))).andReturn();
        assertThat(r.getResponse().getStatus()).isEqualTo(404);
    }

    // ------------------------------------------------------------------ Gerüst

    private record Kunde(UUID id, String name) {}

    private Kunde kunde() throws Exception {
        String name = "Löschlauf-Probe " + UUID.randomUUID().toString().substring(0, 8);
        MvcResult angelegt = mvc.perform(post("/api/v1/admin/tenants").contentType(MediaType.APPLICATION_JSON)
                .content(JSON.writeValueAsString(Map.of("name", name))).with(authentication(plattform()))).andReturn();
        assertThat(angelegt.getResponse().getStatus()).isEqualTo(201);
        return new Kunde(UUID.fromString(json(angelegt).get("id").asText()), name);
    }

    private JsonNode starten(Kunde kunde) throws Exception {
        MvcResult start = mvc.perform(post("/api/v1/admin/tenants/" + kunde.id() + "/delete")
                .contentType(MediaType.APPLICATION_JSON)
                .content(JSON.writeValueAsString(Map.of("confirmName", kunde.name())))
                .with(authentication(plattform()))).andReturn();
        assertThat(start.getResponse().getStatus()).as(text(start)).isEqualTo(202);
        return json(start);
    }

    private JsonNode stand(UUID kunde) throws Exception {
        MvcResult stand = mvc.perform(get("/api/v1/admin/tenants/" + kunde + "/loeschlauf")
                .with(authentication(plattform()))).andReturn();
        assertThat(stand.getResponse().getStatus()).as(text(stand)).isEqualTo(200);
        return json(stand);
    }

    /** Fragt den Statusweg wie das Portal, bis der Lauf terminal ist (bei „fertig" samt Bericht). */
    private JsonNode laufAbwarten(UUID kunde, JsonNode lauf) throws Exception {
        long frist = System.nanoTime() + TimeUnit.SECONDS.toNanos(120);
        while (true) {
            boolean laeuft = "laeuft".equals(lauf.get("stand").asText());
            boolean berichtFehlt = "fertig".equals(lauf.get("stand").asText()) && lauf.get("bericht").isNull();
            if (!laeuft && !berichtFehlt) {
                return lauf;
            }
            assertThat(System.nanoTime()).as("Löschzug wird nicht fertig: " + lauf).isLessThan(frist);
            Thread.sleep(100);
            lauf = stand(kunde);
        }
    }

    private static JsonNode json(MvcResult r) throws Exception {
        return JSON.readTree(text(r));
    }

    private static String text(MvcResult r) throws Exception {
        return r.getResponse().getContentAsString(StandardCharsets.UTF_8);
    }

    private static Authentication plattform() {
        Map<String, Object> claims = new HashMap<>();
        claims.put("sub", BETREIBER);
        claims.put("preferred_username", BETREIBER);
        claims.put("realm_access", Map.of("roles", List.of("platform-admin")));
        return new KeycloakRealmRoleConverter().convert(new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600),
                Map.of("alg", "none"), claims));
    }
}
