package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
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
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * MiSpeL MP-2: der Ausschließlichkeits-Prüfer über die Admin-Route — gespeicherte Viertelstunden
 * ({@code telemetry_rollup_15m}) einer Anlage in einem fremden Mandanten, gelesen nur von platform-admin, ohne
 * Live-Daten. Die Zahlen der ersten Viertelstunde sind die Beispielrechnung 1 der BNetzA (A1 S. 15).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class AusschliesslichkeitsPruefungApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String PFAD = "/api/v1/admin/mispel/ausschliesslichkeit";

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

    private JdbcTemplate root;

    @BeforeEach
    void verbinden() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    private record Anlage(UUID tenant, UUID site) {}

    private Anlage anlage(String name, boolean speicher) {
        UUID tenant = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                name + " " + UUID.randomUUID().toString().substring(0, 8));
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name, bidding_zone) VALUES (?, ?, 'DE-LU')"
                + " RETURNING id", UUID.class, tenant, name);
        if (speicher) {
            root.update("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh) VALUES (?, ?, 'battery', 200)",
                    tenant, site);
        }
        return new Anlage(tenant, site);
    }

    /** Eine verdichtete Viertelstunde; {@code null} = Kanal fehlt. */
    private void viertelstunde(Anlage a, String beginn, Double bezug, Double einspeisung, Double laden,
            Double entladen) {
        root.update("INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, load_kwh, grid_import_kwh,"
                        + " grid_export_kwh, battery_charge_kwh, battery_discharge_kwh, n_samples)"
                        + " VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, 15)",
                Timestamp.from(OffsetDateTime.parse(beginn).toInstant()), a.tenant(), a.site(), bezug, einspeisung,
                laden, entladen);
    }

    @Test
    void eineAnlageJeMonatUndJahr() throws Exception {
        Anlage werk = anlage("Kunststoffwerk Ahrenberg", true);
        // Beispielrechnung 1 (A1 S. 15): 130 kWh Netzbezug, 100 kWh Speicherverbrauch -> (1)¼ = 100.
        viertelstunde(werk, "2025-03-10T12:00:00+01:00", 130.0, 0.0, 100.0, 0.0);
        // Beispielrechnung 2 (A1 S. 16): 100 kWh Speichererzeugung, 80 kWh Einspeisung -> (2)¼ = 80.
        viertelstunde(werk, "2025-03-10T19:00:00+01:00", 0.0, 80.0, 0.0, 100.0);
        // Laden aus Überschuss ohne Netzbezug: kein Netzstrom im Speicher.
        viertelstunde(werk, "2025-06-01T12:00:00+02:00", 0.0, 4.0, 3.0, 0.0);
        // Kanal fehlt: Lücke, nie Null.
        viertelstunde(werk, "2025-06-01T12:15:00+02:00", 2.0, 0.0, null, null);

        MvcResult r = mvc.perform(get(PFAD + "/" + werk.site()).param("jahr", "2025").with(authentication(admin())))
                .andReturn();
        assertThat(r.getResponse().getStatus()).as(text(r)).isEqualTo(200);
        JsonNode body = json(r);
        assertThat(body.at("/anlage/site_id").asText()).isEqualTo(werk.site().toString());
        assertThat(body.at("/anlage/speicher_erfasst").asBoolean()).isTrue();
        assertThat(body.at("/anlage/netzladen_erlaubt").asBoolean()).isFalse();
        assertThat(body.at("/werte").asText()).isEqualTo("geraetewerte_vorlaeufig");
        assertThat(body.at("/monate")).hasSize(12);

        JsonNode maerz = body.at("/monate/2");
        assertThat(maerz.at("/monat").asText()).isEqualTo("2025-03");
        assertThat(maerz.at("/formeln/(9)").decimalValue()).isEqualByComparingTo("100");
        assertThat(maerz.at("/formeln/(11)").decimalValue()).isEqualByComparingTo("80");
        assertThat(maerz.at("/formeln/(10)").decimalValue()).isEqualByComparingTo("0");
        assertThat(maerz.at("/viertelstunden_netzstrom_im_speicher").asInt()).isEqualTo(1);
        assertThat(maerz.at("/viertelstunden_mit_werten").asInt()).isEqualTo(2);
        assertThat(maerz.at("/viertelstunden_soll").asInt()).isEqualTo(31 * 96 - 4);

        JsonNode juni = body.at("/monate/5");
        assertThat(juni.at("/viertelstunden_mit_werten").asInt()).isEqualTo(1);
        assertThat(juni.at("/formeln/(3)").decimalValue()).isEqualByComparingTo("0");
        assertThat(juni.at("/formeln/(10)").decimalValue()).isEqualByComparingTo("3");

        JsonNode jahr = body.at("/ergebnis_jahr");
        assertThat(jahr.at("/netzstrom_im_speicher").asBoolean()).isTrue();
        assertThat(jahr.at("/monate_mit_netzstrom_im_speicher").asInt()).isEqualTo(1);
        assertThat(jahr.at("/formeln/(9)").decimalValue()).isEqualByComparingTo("100");
        assertThat(jahr.at("/formeln/(11)").decimalValue()).isEqualByComparingTo("80");
        assertThat(jahr.at("/viertelstunden_soll").asInt()).isEqualTo(365 * 96);
        assertThat(jahr.at("/toleranz_staffel/0/schwelle_kwh").decimalValue()).isEqualByComparingTo("0.01");
        assertThat(body.at("/offene_fragen")).extracting(f -> f.at("/frage").asText())
                .containsExactly("toleranz", "speichervorrang_ausschliesslichkeit", "rechtsfolge", "messwerte");
    }

    @Test
    void flotteNurAnlagenMitSpeicher() throws Exception {
        Anlage mit = anlage("Speicherhof", true);
        Anlage ohne = anlage("Nur PV", false);
        viertelstunde(mit, "2025-08-01T10:00:00+02:00", 5.0, 0.0, 2.0, 0.0);
        viertelstunde(ohne, "2025-08-01T10:00:00+02:00", 5.0, 0.0, 2.0, 0.0);

        MvcResult r = mvc.perform(get(PFAD).param("jahr", "2025").with(authentication(admin()))).andReturn();
        assertThat(r.getResponse().getStatus()).as(text(r)).isEqualTo(200);
        JsonNode anlagen = json(r).at("/anlagen");
        List<String> sites = anlagen.findValuesAsText("site_id");
        assertThat(sites).contains(mit.site().toString()).doesNotContain(ohne.site().toString());
        for (JsonNode z : anlagen) {
            if (z.at("/anlage/site_id").asText().equals(mit.site().toString())) {
                assertThat(z.at("/ergebnis_jahr/formeln/(9)").decimalValue()).isEqualByComparingTo("2");
                assertThat(z.at("/ergebnis_jahr/netzstrom_im_speicher").asBoolean()).isTrue();
            }
        }
    }

    @Test
    void nurPlatformAdminUndSaubereFehler() throws Exception {
        Anlage werk = anlage("Kunde", true);
        assertThat(mvc.perform(get(PFAD + "/" + werk.site()).with(authentication(kunde(werk.tenant()))))
                .andReturn().getResponse().getStatus()).isEqualTo(403);
        assertThat(mvc.perform(get(PFAD).with(authentication(kunde(werk.tenant()))))
                .andReturn().getResponse().getStatus()).isEqualTo(403);

        MvcResult fremd = mvc.perform(get(PFAD + "/" + UUID.randomUUID()).with(authentication(admin()))).andReturn();
        assertThat(fremd.getResponse().getStatus()).isEqualTo(404);
        assertThat(json(fremd).at("/message").asText()).isEqualTo("Anlage nicht gefunden.");

        MvcResult zukunft = mvc.perform(get(PFAD + "/" + werk.site()).param("jahr", "2999")
                .with(authentication(admin()))).andReturn();
        assertThat(zukunft.getResponse().getStatus()).isEqualTo(400);

        // Ohne Jahr: laufendes Kalenderjahr, Monate nur bis jetzt.
        MvcResult laufend = mvc.perform(get(PFAD + "/" + werk.site()).with(authentication(admin()))).andReturn();
        assertThat(laufend.getResponse().getStatus()).as(text(laufend)).isEqualTo(200);
        assertThat(json(laufend).at("/monate").size()).isBetween(1, 12);
    }

    private static JsonNode json(MvcResult r) throws Exception {
        return JSON.readTree(text(r));
    }

    private static String text(MvcResult r) throws Exception {
        return r.getResponse().getContentAsString(StandardCharsets.UTF_8);
    }

    private static Authentication admin() {
        return token("betrieb-voss", Map.of("realm_access", Map.of("roles", List.of("platform-admin"))));
    }

    private static Authentication kunde(UUID tenant) {
        return token("kunde-" + tenant, Map.of("tenant_id", tenant.toString(),
                "realm_access", Map.of("roles", List.of("tenant-admin"))));
    }

    private static Authentication token(String sub, Map<String, Object> mehr) {
        Map<String, Object> claims = new HashMap<>(mehr);
        claims.put("sub", sub);
        claims.put("preferred_username", sub);
        return new KeycloakRealmRoleConverter().convert(new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600),
                Map.of("alg", "none"), claims));
    }
}
