package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.DeviceRepository;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
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
 * Der Anteils-Verlust über den echten Weg (UEMS AP-15 IP-22, E1 = A, R2): Herzschlag der Box mit
 * {@code gemeinsame_steuerung.anteil_verlust} → {@link DataSourceStatusListener} → {@code steuerungsverbund_anteil_verlust}
 * (V20260922050000) → Auskunft je Mitglied im {@code GET …/gemeinsame-steuerung}. Box Verwaltung (E-4, steuert mit)
 * meldet am Beispieltag 160,2 kWh in 9,1 h; Box Halle 1 (E-1, führt) meldet nichts.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class AnteilVerlustApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";

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

    @Autowired
    MockMvc mvc;

    @Autowired
    DeviceRepository devices;

    @Autowired
    DeviceDataSourceStatusRepository statuses;

    @Autowired
    BoxFaehigkeiten faehigkeiten;

    @Autowired
    AnteilVerlustAusHerzschlag empfang;

    /** Der Zuhörer ist im Testprofil abgeschaltet (kein Broker) — gebaut aus den echten Beans, wie im Betrieb. */
    private DataSourceStatusListener listener() {
        DataSourceStatusListener l = new DataSourceStatusListener("tcp://unused", "", "", devices, statuses,
                faehigkeiten);
        l.anteilVerlust(empfang);
        return l;
    }

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Welt(UUID mandant, UUID an1, UUID e1, UUID e4) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @Test
    void r2DieBoxMeldetDerTagSteigtNurUndDieAuskunftNenntHeuteUndMonat() throws Exception {
        Welt w = welt();
        LocalDate heute = LocalDate.now(AnteilVerlustAusHerzschlag.ZONE);
        LocalDate gestern = heute.minusDays(1);

        herzschlag(w, w.e4(), verlust(heute, "160.2", 32810, gestern, "12.5", 3600));
        // eine verspätete Nachricht mit kleinerem Stand senkt nichts
        herzschlag(w, w.e4(), verlust(heute, "100.0", 20000, null, null, 0));
        // die führende Box hält ein Dokument, meldet aber (noch) keinen Verlust: keine Zeile
        herzschlag(w, w.e1(), "{\"rolle\":\"fuehrt\",\"anteile_revision\":1,\"anteile_epoche\":1}");

        assertThat(root.queryForObject("SELECT count(*) FROM steuerungsverbund_anteil_verlust WHERE device_id = ?",
                Integer.class, w.e1())).isZero();
        JsonNode e4 = mitglied(lesen(w), w.e4()).get("anteil_verlust");
        assertThat(e4.get("heute").get("kwh").decimalValue()).isEqualByComparingTo("160.2");
        assertThat(e4.get("heute").get("gebunden_s").asLong()).isEqualTo(32810);
        assertThat(e4.get("heute").get("tage").asInt()).isEqualTo(1);
        boolean gleicherMonat = gestern.getMonth() == heute.getMonth();
        assertThat(e4.get("monat").get("kwh").decimalValue())
                .isEqualByComparingTo(gleicherMonat ? "172.7" : "160.2");
        assertThat(e4.get("monat").get("tage").asInt()).isEqualTo(gleicherMonat ? 2 : 1);
        assertThat(mitglied(lesen(w), w.e1()).get("anteil_verlust").isNull()).isTrue();

        // ein größerer Stand desselben Tages schreibt fort
        herzschlag(w, w.e4(), verlust(heute, "170.0", 33000, null, null, 0));
        assertThat(mitglied(lesen(w), w.e4()).get("anteil_verlust").get("heute").get("kwh").decimalValue())
                .isEqualByComparingTo("170.0");
    }

    @Test
    void mandantenzaunUndRechte() {
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                + "WHERE relname = 'steuerungsverbund_anteil_verlust'", Boolean.class)).isTrue();
        assertThat(root.queryForObject("SELECT has_table_privilege(?, 'steuerungsverbund_anteil_verlust', 'DELETE')",
                Boolean.class, APP_USER)).isFalse();
        assertThat(root.queryForObject("SELECT has_table_privilege(?, 'steuerungsverbund_anteil_verlust', 'UPDATE')",
                Boolean.class, APP_USER)).isTrue();
    }

    // ============================================================================ Aufbau

    private static String verlust(LocalDate tag, String kwh, int s, LocalDate vortag, String vkwh, int vs) {
        String v = vortag == null ? ""
                : ",\"vortag\":{\"tag\":\"" + vortag + "\",\"kwh\":" + vkwh + ",\"gebunden_s\":" + vs + "}";
        return "{\"rolle\":\"steuert_mit\",\"anteile_revision\":1,\"anteile_epoche\":1,\"anteile_kw\":{"
                + "\"einspeisung\":30.0,\"bezug\":0.0},\"anteil_verlust\":{\"tag\":\"" + tag + "\",\"kwh\":" + kwh
                + ",\"gebunden_s\":" + s + v + "}}";
    }

    private void herzschlag(Welt w, UUID box, String block) {
        String json = "{\"tenant_id\":\"" + w.mandant() + "\",\"site_id\":\"" + w.an1() + "\",\"device_id\":\"" + box
                + "\",\"ts\":\"2026-06-17T12:00:00Z\",\"gemeinsame_steuerung\":" + block + "}";
        listener().handle("ems/" + w.mandant() + "/" + w.an1() + "/" + box + "/status",
                json.getBytes(StandardCharsets.UTF_8));
    }

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "Anteils-Verlust #" + nr);
        root.update("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH', "
                + "'Europe/Berlin')", t);
        UUID an1 = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Werk Ahrenberg – Halle 1') "
                + "RETURNING id", UUID.class, t);
        UUID e1 = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, t, an1, "E-1-VERLUST-" + nr);
        UUID e4 = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, t, an1, "E-4-VERLUST-" + nr);
        UUID v = root.queryForObject("INSERT INTO steuerungsverbund (tenant_id, site_id, stufe, epoche, created_by) "
                + "VALUES (?, ?, 'anteile_aktiv', 1, 'test') RETURNING id", UUID.class, t, an1);
        // die führende Box misst den Netzanschluss (DQ-2)
        UUID dq2 = root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, protokoll, adresse, "
                + "geraete_ids, kadenz_s) VALUES (?, ?, 'DQ-2', 'modbus_tcp', '10.0.1.2:502', '{1}', 10) RETURNING id",
                UUID.class, t, an1);
        root.update("INSERT INTO data_source_assignment (tenant_id, data_source_id, device_id, protokoll, adresse, "
                + "effective_from) SELECT tenant_id, id, ?, protokoll, adresse, TIMESTAMPTZ '2026-01-01T00:00:00Z' "
                + "FROM data_source WHERE id = ?", e1, dq2);
        for (Object[] m : new Object[][] {{e1, "fuehrt", dq2}, {e4, "steuert_mit", null}}) {
            root.update("INSERT INTO steuerungsverbund_mitglied (tenant_id, steuerungsverbund_id, site_id, device_id, "
                    + "rolle, data_source_id, gueltig_ab, created_by) VALUES (?, ?, ?, ?, ?, ?, "
                    + "TIMESTAMPTZ '2026-01-01T00:00:00Z', 'test')", t, v, an1, m[0], m[1], m[2]);
        }
        return new Welt(t, an1, e1, e4);
    }

    private static JsonNode mitglied(JsonNode zustand, UUID box) {
        for (JsonNode m : zustand.get("mitglieder")) {
            if (box.toString().equals(m.get("box_id").asText())) {
                return m;
            }
        }
        throw new AssertionError("kein Mitglied " + box + ": " + zustand);
    }

    private JsonNode lesen(Welt w) throws Exception {
        MvcResult r = mvc.perform(get("/api/v1/sites/" + w.an1() + "/gemeinsame-steuerung").with(jwt().jwt(j -> {
            j.subject("sub-jonas-" + w.mandant());
            j.claim("preferred_username", "Jonas Wendlinger");
            j.claim("tenant_id", w.mandant().toString());
        }))).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(r.getResponse().getStatus()).as(text).isEqualTo(200);
        return MAPPER.readTree(text);
    }
}
