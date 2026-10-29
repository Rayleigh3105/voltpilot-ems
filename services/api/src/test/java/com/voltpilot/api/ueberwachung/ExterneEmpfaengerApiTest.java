package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.zugriff.ZugriffKontextLader;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
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
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der Vertrag von {@code GET /api/v1/meldungen/regeln/{id}/externe-empfaenger} (Alerting Scheibe 6, Entscheid 11B)
 * über HTTP: die Liste der freien externen Empfänger einer Überwachung.
 *
 * <ul>
 *   <li><b>Mit Recht {@code ueberwachung.verwalten}</b> (Kundenadministrator): 200 mit den Empfängern der Regel.</li>
 *   <li><b>Kein Existenz-Leck:</b> eine unbekannte Regel, die Regel eines anderen Kundenbereichs und eine Regel hinter
 *       dem Standort-Zaun ({@code site_scope} auf {@code ueberwachung}) antworten mit demselben 404.</li>
 *   <li><b>Sichtbar, aber ohne Recht</b> (Leserin am Standort der Regel): 403 {@code recht_fehlt}.</li>
 *   <li><b>Die Plattform im Mandantensprung</b> (Zugang {@code umschalter}): 200 wie der Kundenadministrator —
 *       {@code RechtPruefung.aufrufer()} ist dort sein Recht (Auftrag vom 29.10.2026), nicht mehr leer (403).</li>
 * </ul>
 *
 * <p>Die Route gab es vor UEMS AP-03 IP-4 nicht, und ihr Dienst spricht sein Urteil über den Aufrufer selbst
 * ({@code RechtPruefung.aufrufer()}). Der Bestandsvergleich in {@code ZugriffZaunApiTest} nimmt sie darum aus und
 * verweist mit {@link #PROBE} auf diese Klasse: dort trifft die Probe die Regel {@link #REGEL} des Demo-Kundenbereichs.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
public class ExterneEmpfaengerApiTest {

    /** Die Regel der Probe - hier im eigenen Kundenbereich, in {@code ZugriffZaunApiTest} im Demo-Kundenbereich. */
    public static final UUID REGEL = UUID.fromString("0a1e0000-0000-4000-8000-00000000e301");
    /** Der Aufruf, den {@code ZugriffZaunApiTest} als Probe dieser Route nennt (wörtlich, er sucht ihn hier). */
    public static final String PROBE =
            "/api/v1/meldungen/regeln/0a1e0000-0000-4000-8000-00000000e301/externe-empfaenger";

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();

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
    @MockBean KeycloakAdminClient keycloak;

    // Die Welt entsteht einmal: REGEL ist eine feste Kennung (die Probe des Zauns).
    private static JdbcTemplate root;
    private static UUID tenant;
    private static UUID fremdeRegel;
    private static UUID regelAnderswo;

    @BeforeEach
    void welt() {
        if (root != null) {
            return;
        }
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        tenant = root.queryForObject("INSERT INTO tenant (name) VALUES ('Kunststoffwerk Ahrenberg') RETURNING id",
                UUID.class);
        UUID unternehmen = root.queryForObject("INSERT INTO unternehmen (tenant_id, name) VALUES (?, 'Ahrenberg') "
                + "RETURNING id", UUID.class, tenant);
        UUID st1 = standort(tenant, unternehmen, "Werk Ahrenberg", "ST-1");
        UUID st2 = standort(tenant, unternehmen, "Lager Ostheim", "ST-2");
        regel(REGEL, tenant, st1, "Netzbezug Halle 1");
        regelAnderswo = regel(UUID.randomUUID(), tenant, st2, "Netzbezug Lager");
        root.update("INSERT INTO ueberwachung_externer_empfaenger (tenant_id, ueberwachung_id, email, "
                + "abbestellen_token, hinzugefuegt_von) VALUES (?, ?, 'hausmeister@example.test', ?, 'jw')", tenant,
                REGEL, UUID.randomUUID().toString());
        person("jw", "kundenadministrator", null);
        person("berger", "leser", st1);
        person("ost", "leser", st2);

        UUID andererKunde = root.queryForObject("INSERT INTO tenant (name) VALUES ('Nordwind') RETURNING id",
                UUID.class);
        UUID nordwind = root.queryForObject("INSERT INTO unternehmen (tenant_id, name) VALUES (?, 'Nordwind') "
                + "RETURNING id", UUID.class, andererKunde);
        fremdeRegel = regel(UUID.randomUUID(), andererKunde, standort(andererKunde, nordwind, "Hafen", "ST-1"),
                "Netzbezug Hafen");
    }

    @Test
    void derKundenadministratorSiehtDieExternenEmpfaengerDerRegel() throws Exception {
        MvcResult a = ruf(get(PROBE), konto("jw"));

        assertThat(a.getResponse().getStatus()).as(koerper(a)).isEqualTo(200);
        JsonNode liste = JSON.readTree(koerper(a));
        assertThat(liste).hasSize(1);
        assertThat(liste.get(0).path("email").asText()).isEqualTo("hausmeister@example.test");
        assertThat(liste.get(0).path("bestaetigt").asBoolean()).isFalse();
    }

    @Test
    void unbekanntFremdUndUmzaeuntAntwortenGleich404() throws Exception {
        MvcResult unbekannt = ruf(get(pfad(UUID.randomUUID())), konto("jw"));
        assertThat(unbekannt.getResponse().getStatus()).isEqualTo(404);

        Map<String, MvcResult> faelle = Map.of(
                "Regel eines anderen Kundenbereichs", ruf(get(pfad(fremdeRegel)), konto("jw")),
                "Regel am Standort, den die Leserin nicht hat", ruf(get(pfad(regelAnderswo)), konto("berger")),
                "Regel der Probe für die Leserin an ST-2", ruf(get(PROBE), konto("ost")));
        for (Map.Entry<String, MvcResult> f : faelle.entrySet()) {
            assertThat(f.getValue().getResponse().getStatus()).as(f.getKey()).isEqualTo(404);
            assertThat(koerper(f.getValue())).as(f.getKey() + ": derselbe Körper wie unbekannt")
                    .isEqualTo(koerper(unbekannt));
        }
    }

    @Test
    void sichtbarAberOhneRechtVerwaltenIst403() throws Exception {
        MvcResult a = ruf(get(PROBE), konto("berger"));

        assertThat(a.getResponse().getStatus()).as(koerper(a)).isEqualTo(403);
        JsonNode k = JSON.readTree(koerper(a));
        assertThat(k.path("code").asText()).isEqualTo("recht_fehlt");
        assertThat(k.path("recht").asText()).isEqualTo("ueberwachung.verwalten");
    }

    @Test
    void imMandantensprungSiehtDiePlattformSieWieDerKundenadministrator() throws Exception {
        MvcResult a = ruf(get(PROBE).header("X-Tenant-Id", tenant.toString()),
                auth("betrieb-voss", null, "platform-admin"));

        assertThat(a.getResponse().getStatus()).as(koerper(a)).isEqualTo(200);
        assertThat(JSON.readTree(koerper(a)).get(0).path("email").asText()).isEqualTo("hausmeister@example.test");
    }

    /**
     * Der Mandantensprung (Auftrag vom 29.10.2026): die Plattform-Administration legt eine Überwachung an wie der
     * Kundenadministrator — über {@code X-Kundenbereich} ohne Unterstützung. Bis dahin war
     * {@code RechtPruefung.aufrufer()} dort leer, und {@code POST /api/v1/meldungen/regeln} sagte 403, während die
     * Oberfläche den Knopf zeigte. Die Regel steht unter der Kennung der Plattform-Person.
     */
    @Test
    void imMandantensprungLegtDiePlattformEineUeberwachungAn() throws Exception {
        UUID st1 = root.queryForObject("SELECT id FROM standort WHERE tenant_id = ? AND kurzzeichen = 'ST-1'",
                UUID.class, tenant);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, bidding_zone) "
                + "VALUES (?, 'Halle Sprung', 'DE-LU') RETURNING id", UUID.class, tenant);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, '2026-01-01')", tenant, anlage, st1);
        String anfrage = JSON.writeValueAsString(Map.of("wertart", "box.erreichbar",
                "bezug", Map.of("anlage", anlage.toString()),
                "bedingung", Map.of("art", "zustand", "ziel", List.of("nicht_erreichbar")),
                "schwere", "warnung", "name", "Box im Sprung"));

        MvcResult a = ruf(post("/api/v1/meldungen/regeln")
                .header(ZugriffKontextLader.KUNDENBEREICH_HEADER, tenant.toString())
                .contentType(MediaType.APPLICATION_JSON).content(anfrage), auth("betrieb-voss", null, "platform-admin"));

        assertThat(a.getResponse().getStatus()).as(koerper(a)).isEqualTo(201);
        UUID id = UUID.fromString(JSON.readTree(koerper(a)).path("id").asText());
        assertThat(root.queryForObject("SELECT angelegt_von FROM ueberwachung WHERE id = ?", String.class, id))
                .isEqualTo("betrieb-voss");
    }

    private static UUID standort(UUID kunde, UUID unternehmen, String name, String kurzzeichen) {
        return root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, kunde,
                unternehmen, name, kurzzeichen);
    }

    private static UUID regel(UUID id, UUID kunde, UUID standort, String name) {
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, bidding_zone) VALUES (?, ?, 'DE-LU') "
                + "RETURNING id", UUID.class, kunde, name);
        root.update("""
                INSERT INTO ueberwachung (id, tenant_id, standort_id, name, wertart, bezug, bedingung, schwere,
                       empfaenger, herkunft, aktiv, angelegt_von)
                VALUES (?, ?, ?, ?, 'anlage.netz.leistung', ?::jsonb, '{"art":"ueber","schwelle":120}'::jsonb,
                       'warnung', '[]'::jsonb, 'eigen', true, 'jw')
                """, id, kunde, standort, name, "{\"anlage\":\"" + anlage + "\"}");
        return id;
    }

    private static void person(String wer, String rolle, UUID ort) {
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', ?, "
                + "'aktiv')", tenant, wer, wer);
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, ?, ?, '2024-01-01T00:00:00Z', 'Europe/Berlin')", tenant, wer, rolle, ort);
    }

    private static String pfad(UUID regel) {
        return "/api/v1/meldungen/regeln/" + regel + "/externe-empfaenger";
    }

    private static String koerper(MvcResult a) throws Exception {
        return a.getResponse().getContentAsString(StandardCharsets.UTF_8);
    }

    private MvcResult ruf(MockHttpServletRequestBuilder anfrage, Authentication auth) throws Exception {
        return mvc.perform(anfrage.with(authentication(auth))).andReturn();
    }

    private Authentication konto(String wer) {
        return auth(wer, tenant, null);
    }

    private static Authentication auth(String wer, UUID kunde, String realmRolle) {
        Map<String, Object> claims = new HashMap<>();
        claims.put("sub", wer);
        claims.put("preferred_username", wer);
        claims.put("realm_access", Map.of("roles", realmRolle == null ? List.of() : List.of(realmRolle)));
        if (kunde != null) {
            claims.put("tenant_id", kunde.toString());
        }
        return new KeycloakRealmRoleConverter().convert(new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600),
                Map.of("alg", "none"), claims));
    }
}
