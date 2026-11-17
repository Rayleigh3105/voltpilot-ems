package com.voltpilot.api.enrollment;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.TestDatenbank;
import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
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
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * Befund D1 (vp-kunde-loeschen-grant-entziehen): Beim Löschen eines Kunden mit einer Box, die sich schon
 * gemeldet hat, ging die Box über die Kaskade - ihr Broker-Grant blieb in {@code acl.conf}, und der
 * Start-Selbstheiler hielt Grants ohne Gerätezeile. Die alte Box konnte so weiter unter den Topics des
 * gelöschten Kunden senden. Jetzt entzieht der Löschweg den Grant bestätigt (wie „Vom Kunden lösen":
 * ohne bestätigten Entzug nichts gelöscht), und der Selbstheiler räumt Grants ohne aktive Gerätezeile.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class KundeLoeschenGrantApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String BETREIBER = "betrieb-voss";

    @Container
    static final TestDatenbank POSTGRES = new TestDatenbank();

    static final Path PKI_DIR = pkiDir();
    static final Path ACL_FILE = PKI_DIR.resolve("acl.conf");

    private static Path pkiDir() {
        try {
            Path dir = Files.createTempDirectory("voltpilot-kunde-loeschen-grant");
            TestPki.writeCa(dir.resolve("ca"));
            Files.writeString(dir.resolve("acl.conf"), """
                    {allow, {username, "vp-internal"}, all, ["#"]}.
                    %%<<BEGIN GENERATED DEVICE GRANTS>>
                    %%<<END GENERATED DEVICE GRANTS>>
                    {allow, all}.
                    """, StandardCharsets.UTF_8);
            return dir;
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

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
        registry.add("voltpilot.enrollment.enabled", () -> "true");
        registry.add("voltpilot.enrollment.ca-dir", () -> PKI_DIR.resolve("ca").toString());
        registry.add("voltpilot.enrollment.acl-file", () -> ACL_FILE.toString());
        registry.add("voltpilot.enrollment.mqtt-host", () -> "mqtt.example.com");
        registry.add("voltpilot.enrollment.mqtt-port", () -> "8883");
    }

    @Autowired MockMvc mvc;
    @Autowired EnrollmentService enrollment;
    @MockitoBean KeycloakAdminClient keycloak;
    /** Der Broker: bestätigt den Reload oder nicht - die eine Stelle, an der der Entzug scheitern kann. */
    @MockitoBean BrokerAuthzReloader reloader;

    private JdbcTemplate root;

    @BeforeEach
    void datenbank() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        root.queryForList("SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs"
                + " WHERE proc_name = 'schedule_savings_1d_job'");
    }

    @Test
    void kundeMitGemeldeterBoxLoeschenEntziehtDenGrantBestaetigt() throws Exception {
        when(reloader.reloadNowBlocking(anyInt(), any())).thenReturn(true);
        Kunde kunde = kundeMitGemeldeterBox();
        assertThat(Files.readString(ACL_FILE)).as("Ausgangslage: die Box hat ihren Grant")
                .contains("%%<<device " + kunde.box() + " ");

        JsonNode lauf = json(loeschen(kunde));

        assertThat(lauf.get("stand").asText()).as(lauf.toString()).isEqualTo("fertig");
        assertThat(root.queryForObject("SELECT count(*) FROM device WHERE id = ?", Long.class, kunde.box()))
                .as("die Box ging über die Kaskade (gemeldet, nicht über „Lösen\")").isZero();
        assertThat(Files.readString(ACL_FILE)).as("der Grant der gemeldeten Box ist entzogen")
                .doesNotContain(kunde.box().toString());
        verify(reloader).reloadNowBlocking(1, Duration.ZERO);

        // Neustart: der Selbstheiler stellt den Grant nicht wieder her (keine Gerätezeile mehr).
        enrollment.selfHealBrokerAclOnStartup();
        assertThat(Files.readString(ACL_FILE)).doesNotContain(kunde.box().toString());
    }

    @Test
    void ohneBestaetigtenEntzugWirdNichtsGeloescht() throws Exception {
        when(reloader.reloadNowBlocking(anyInt(), any())).thenReturn(false);
        Kunde kunde = kundeMitGemeldeterBox();

        JsonNode lauf = json(loeschen(kunde));

        assertThat(lauf.get("stand").asText()).as(lauf.toString()).isEqualTo("gescheitert");
        assertThat(lauf.get("fehler").asText()).contains("nichts gelöscht");
        assertThat(root.queryForObject("SELECT count(*) FROM tenant WHERE id = ?", Long.class, kunde.id()))
                .as("der Kunde bleibt").isOne();
        assertThat(root.queryForObject("SELECT count(*) FROM device WHERE id = ?", Long.class, kunde.box()))
                .as("die Box bleibt").isOne();
    }

    @Test
    void derStartSelbstheilerEntferntWaisenGrantsUndBehaeltAktiveBoxen() throws Exception {
        when(reloader.reloadNowBlocking(anyInt(), any())).thenReturn(true);
        Kunde kunde = kundeMitGemeldeterBox();
        // Eine aktive Box ohne Zertifikat aus der Plattform (z. B. über tools/pki eingerichtet): ihr Grant bleibt.
        UUID ohneZertifikat = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref)"
                + " VALUES (?, ?, ?) RETURNING id", UUID.class, kunde.id(), kunde.site(), "grant-pki-" + nr());
        AclGrantWriter acl = new AclGrantWriter(ACL_FILE);
        acl.writeGrant(kunde.id(), kunde.site(), ohneZertifikat);
        // Die Waise: Grant einer Box, deren Gerätezeile mit einem früheren Kunden gelöscht wurde.
        UUID waise = UUID.randomUUID();
        acl.writeGrant(UUID.randomUUID(), UUID.randomUUID(), waise);

        enrollment.selfHealBrokerAclOnStartup();

        String datei = Files.readString(ACL_FILE);
        assertThat(datei).as("der Waisen-Grant ist entfernt").doesNotContain(waise.toString());
        assertThat(datei).as("die aktive, eingeschriebene Box behält ihren Grant")
                .contains("%%<<device " + kunde.box() + " ");
        assertThat(datei).as("die aktive Box ohne Plattform-Zertifikat behält ihren Grant")
                .contains("%%<<device " + ohneZertifikat + " ");
    }

    // --- Aufbau ---------------------------------------------------------------

    private record Kunde(UUID id, String name, UUID site, UUID box) {}

    /** Ein Kunde mit einer Box, die ihr Zertifikat abgeholt und sich gemeldet hat (Herzschlag), samt Grant. */
    private Kunde kundeMitGemeldeterBox() throws Exception {
        String nr = nr();
        String name = "Gießerei Ahrenberg " + nr;
        MvcResult angelegt = ruf(post("/api/v1/admin/tenants").contentType(MediaType.APPLICATION_JSON)
                .content(JSON.writeValueAsString(Map.of("name", name))));
        assertThat(angelegt.getResponse().getStatus()).isEqualTo(201);
        UUID tenant = UUID.fromString(json(angelegt).get("id").asText());
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name, bidding_zone) VALUES (?, 'Werk', 'DE-LU')"
                + " RETURNING id", UUID.class, tenant);
        String ref = "grant-loeschen-" + nr;
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref,"
                + " device_status_seen_at) VALUES (?, ?, ?, now()) RETURNING id", UUID.class, tenant, site, ref);
        root.update("INSERT INTO device_enrollment (external_ref, csr_pem, device_id, cert_pem, cert_serial,"
                + " issued_at) VALUES (?, 'csr', ?, 'cert', ?, now())", ref, box, nr);
        new AclGrantWriter(ACL_FILE).writeGrant(tenant, site, box);
        return new Kunde(tenant, name, site, box);
    }

    private static String nr() {
        return UUID.randomUUID().toString().substring(0, 8);
    }

    /** POST startet den Lauf (202); der Stand kommt vom Statusweg, bis er nicht mehr läuft. */
    private MvcResult loeschen(Kunde kunde) throws Exception {
        MvcResult start = ruf(post("/api/v1/admin/tenants/" + kunde.id() + "/delete")
                .contentType(MediaType.APPLICATION_JSON)
                .content(JSON.writeValueAsString(Map.of("confirmName", kunde.name()))));
        assertThat(start.getResponse().getStatus()).as(text(start)).isEqualTo(202);
        long frist = System.nanoTime() + Duration.ofSeconds(120).toNanos();
        while (true) {
            MvcResult stand = ruf(get("/api/v1/admin/tenants/" + kunde.id() + "/loeschlauf"));
            assertThat(stand.getResponse().getStatus()).as(text(stand)).isEqualTo(200);
            JsonNode lauf = json(stand);
            boolean laeuft = "laeuft".equals(lauf.get("stand").asText());
            boolean berichtFehlt = "fertig".equals(lauf.get("stand").asText()) && lauf.get("bericht").isNull();
            if (!laeuft && !berichtFehlt) {
                return stand;
            }
            assertThat(System.nanoTime()).as("Löschzug wird nicht fertig").isLessThan(frist);
            Thread.sleep(100);
        }
    }

    private MvcResult ruf(MockHttpServletRequestBuilder anfrage) throws Exception {
        return mvc.perform(anfrage.with(authentication(plattform()))).andReturn();
    }

    private static Authentication plattform() {
        Map<String, Object> claims = new HashMap<>();
        claims.put("sub", BETREIBER);
        claims.put("preferred_username", BETREIBER);
        claims.put("realm_access", Map.of("roles", List.of("platform-admin")));
        return new KeycloakRealmRoleConverter().convert(new Jwt("token", Instant.now(),
                Instant.now().plusSeconds(3600), Map.of("alg", "none"), claims));
    }

    private static JsonNode json(MvcResult r) throws Exception {
        return JSON.readTree(text(r));
    }

    private static String text(MvcResult r) throws Exception {
        return r.getResponse().getContentAsString(StandardCharsets.UTF_8);
    }
}
