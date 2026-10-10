package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.chargers.ChargingConfigPublisher;
import com.voltpilot.api.chargers.ChargingConfigService;
import com.voltpilot.api.control.ControlCertificationPublisher;
import com.voltpilot.api.enrollment.EnrollmentService;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.flows.FlowActivationService;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import com.voltpilot.api.measurement.MeasurementConfigPublisher;
import com.voltpilot.api.measurement.MeasurementSelectionRepository.DeviceScope;
import com.voltpilot.api.measurement.MeasurementSelectionService;
import com.voltpilot.api.ota.OtaTargetPublisher;
import com.voltpilot.api.provisioning.ProvisioningPublisher;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.SteuerungsverbundZweischritt.Stand;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.*;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * AP-15 Folge zu IP-30 (Befund A14, R17, I3/I4): Box-Tausch in der Gemeinsamen Steuerung über die echte Tausch-Route
 * ({@code POST /api/v1/devices/{neu}/succeed/{alt}}) mit App-Rolle, RLS und Transaktion; gemockt sind nur die
 * Transporte. R17: E-4 → E-4′ in S3 — nichts geht verloren, der Anteil bleibt reserviert, der Betreiber bestätigt.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class GemeinsameSteuerungBoxTauschApiTest {
    @Container static final PostgreSQLContainer<?> DB = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    @DynamicPropertySource static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", DB::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "voltpilot_app_test_pw");
        r.add("spring.flyway.url", DB::getJdbcUrl);
        r.add("spring.flyway.user", DB::getUsername);
        r.add("spring.flyway.password", DB::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "voltpilot_app_test_pw");
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> "http://127.0.0.1:9/test");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri", () -> "http://127.0.0.1:9/test/jwks");
    }

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Autowired MockMvc mvc;
    @Autowired SteuerungsverbundAnteilDienst anteile;
    @Autowired SprungprobeDienst sprungproben;
    @MockBean VerbundAnteileVersand versand;
    @MockBean EnrollmentService enrollment;
    @MockBean ProvisioningPublisher provisioning;
    @MockBean EntityRegistryPublisher entities;
    @MockBean MeasurementConfigPublisher measurements;
    @MockBean MeasurementSelectionService selections;
    @MockBean ControlCertificationPublisher certification;
    @MockBean OtaTargetPublisher ota;
    @MockBean FlowDeploymentPublisher flows;
    @MockBean ChargingConfigPublisher charging;
    @MockBean FlowActivationService deployments;
    @MockBean ChargingConfigService chargingConfig;
    static JdbcTemplate root;

    @BeforeAll static void connection() {
        root = new JdbcTemplate(new DriverManagerDataSource(DB.getJdbcUrl(), DB.getUsername(), DB.getPassword()));
    }

    @BeforeEach void transports() {
        when(versand.senden(any(), any())).thenReturn(true);
        when(enrollment.blockSucceededDevice(any(), any())).thenReturn(true);
        when(provisioning.clearRetained(any(), any(), any(), any(), anyBoolean())).thenReturn(true);
        when(provisioning.publishConfig(any(), any(), any(), any())).thenReturn(true);
        when(entities.clearRegistry(any(), any(), any())).thenReturn(true);
        when(entities.publishRegistry(any(), any(), any(), any())).thenReturn(true);
        when(measurements.clear(any(), any(), any())).thenReturn(true);
        when(measurements.publish(any(), any())).thenReturn(true);
        when(selections.forPublishing(any())).thenReturn(mock(MeasurementSelectionService.State.class));
        when(certification.clear(any(), any(), any())).thenReturn(true);
        when(certification.publish(any(), any(), any(), anyBoolean(), any(), any())).thenReturn(true);
        when(ota.clearTarget(any(), any(), any())).thenReturn(true);
        when(flows.clearDeployment(any(), any(), any())).thenReturn(true);
        when(charging.clear(any(), any(), any())).thenReturn(true);
        when(deployments.republishForSite(any())).thenReturn(true);
        when(chargingConfig.republishForSite(any(), any())).thenReturn(true);
    }

    @AfterEach void context() { TenantContext.clear(); }

    // ------------------------------------------------------------------ R17: die mitsteuernde Box

    @Test void r17MitsteuerndeBoxNichtsGehtVerlorenAnteilReserviertBetreiberBestaetigt() throws Exception {
        Welt w = welt();
        UUID e4neu = box(w, "Verwaltung (neu)");
        String fuehrendVorher = mitgliedZeile(w, w.e1());
        long dokumenteVorher = zahl("SELECT count(*) FROM steuerungsverbund_anteile WHERE steuerungsverbund_id = ?", w.verbund());

        tauschen(w, e4neu, w.e4());

        // (1) Mitgliedschaft übertragen, alte zum Tauschzeitpunkt beendet, nichts gelöscht, wartet auf Bestätigung.
        var alt = root.queryForMap("SELECT gueltig_bis, aufgehoben_am, bestaetigt_am FROM steuerungsverbund_mitglied WHERE device_id = ?", w.e4());
        var neu = root.queryForMap("SELECT id, rolle, data_source_id, gueltig_ab, gueltig_bis, bestaetigt_am, vorgabe_signal, "
                + "vorgaenger_mitglied_id, anteil_kennung, gesendet_epoche, gesendet_revision FROM steuerungsverbund_mitglied WHERE device_id = ?", e4neu);
        assertThat(alt.get("gueltig_bis")).isNotNull().isEqualTo(neu.get("gueltig_ab"));
        assertThat(alt.get("aufgehoben_am")).isNull();
        assertThat(alt.get("bestaetigt_am")).as("die Vorgängerin bleibt, wie sie war").isNotNull();
        assertThat(neu.get("rolle")).isEqualTo("steuert_mit");
        assertThat(neu.get("data_source_id")).isEqualTo(w.dq10());
        assertThat(neu.get("gueltig_bis")).isNull();
        assertThat(neu.get("bestaetigt_am")).as("wartet auf Bestätigung (I4)").isNull();
        assertThat(neu.get("vorgabe_signal")).isEqualTo("nein");
        assertThat(neu.get("vorgaenger_mitglied_id")).isEqualTo(w.m4());
        assertThat(neu.get("anteil_kennung")).isEqualTo(w.e4());
        assertThat(zahl("SELECT count(*) FROM steuerungsverbund_mitglied WHERE steuerungsverbund_id = ?", w.verbund())).isEqualTo(3);
        // Die Geräte-Angaben reisen mit (aufheben statt ändern) — die nächste Ableitung rechnet sie der Nachfolgerin zu.
        assertThat(zahl("SELECT count(*) FROM steuerungsverbund_geraet WHERE device_id = ? AND aufgehoben_am IS NULL", e4neu)).isEqualTo(1);
        assertThat(zahl("SELECT count(*) FROM steuerungsverbund_geraet WHERE device_id = ? AND aufgehoben_am IS NOT NULL", w.e4())).isEqualTo(1);
        assertThat(root.queryForObject("SELECT neu->>'box_id' FROM steuerungsverbund_aenderung WHERE site_id = ? AND art = 'box_getauscht'", String.class, w.site()))
                .isEqualTo(e4neu.toString());

        // Das Dokument an E-4′: dieselbe Epoche/Revision, ihr Eintrag = der der Vorgängerin, dieselbe Summe.
        assertThat(neu.get("gesendet_epoche")).isEqualTo(1L);
        assertThat(neu.get("gesendet_revision")).isEqualTo(2L);
        ArgumentCaptor<String> topic = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<byte[]> nutzlast = ArgumentCaptor.forClass(byte[].class);
        verify(versand, times(1)).senden(topic.capture(), nutzlast.capture());
        assertThat(topic.getValue()).contains("/" + e4neu + "/v2/");
        JsonNode dok = MAPPER.readTree(new String(nutzlast.getValue(), StandardCharsets.UTF_8));
        assertThat(dok.path("device_id").asText()).isEqualTo(e4neu.toString());
        assertThat(dok.path("epoche").asLong()).isEqualTo(1);
        assertThat(dok.path("revision").asLong()).isEqualTo(2);
        assertThat(dok.path("rolle").asText()).isEqualTo("steuert_mit");
        assertThat(dok.path("anteile").path("einspeisung").path(e4neu.toString()).decimalValue()).isEqualByComparingTo("60.0");
        assertThat(dok.path("anteile").path("bezug").path(e4neu.toString()).decimalValue()).isEqualByComparingTo("77.0");
        assertThat(dok.path("anteile").path("einspeisung").has(w.e4().toString())).isFalse();
        assertThat(dok.path("anteile").path("einspeisung").path(w.e1().toString()).decimalValue()).isEqualByComparingTo("40.0");

        // (2) Keine Änderung der Anteile: kein neues Dokument, kein Zielstand, die führende Box unverändert, Stufe bleibt.
        assertThat(zahl("SELECT count(*) FROM steuerungsverbund_anteile WHERE steuerungsverbund_id = ?", w.verbund())).isEqualTo(dokumenteVorher);
        assertThat(mitgliedZeile(w, w.e1())).isEqualTo(fuehrendVorher);
        assertThat(root.queryForObject("SELECT stufe FROM steuerungsverbund WHERE id = ?", String.class, w.verbund())).isEqualTo("anteile_aktiv");
        assertThat(zahl("SELECT epoche FROM steuerungsverbund WHERE id = ?", w.verbund())).isEqualTo(1);

        // Die Quittung von E-4′ wird angenommen (dieselbe Revision).
        TenantContext.set(w.tenant());
        assertThat(anteile.quittungEmpfangen(w.site(), e4neu, new Stand(1, 2), true, null, new Stand(1, 2), Instant.now())).isTrue();
        TenantContext.clear();
        assertThat(zahl("SELECT quittiert_revision FROM steuerungsverbund_mitglied WHERE device_id = ?", e4neu)).isEqualTo(2);
        assertThat(zahl("SELECT count(*) FROM steuerungsverbund_anteile WHERE steuerungsverbund_id = ?", w.verbund())).isEqualTo(dokumenteVorher);

        // Planer-Eingang (der echte Ausdruck aus services/optimization verbund.py): E-4′ hält 60/77, unbestätigt = belegt.
        var planer = planerEingang(e4neu);
        assertThat(planer.get("bestaetigt_am")).isNull();
        assertThat(planer.get("einspeisung")).isEqualTo("60.0");
        assertThat(planer.get("bezug")).isEqualTo("77.0");

        // Kunden-GET: das Mitglied wartet auf Bestätigung und zeigt seinen (reservierten) Anteil.
        JsonNode z = MAPPER.readTree(kunde(w, get("/api/v1/sites/" + w.site() + "/gemeinsame-steuerung")));
        JsonNode m = mitglied(z, e4neu);
        assertThat(m.path("bestaetigt_am").isNull()).isTrue();
        assertThat(m.path("wirksame_anteile").path("einspeisung_kw").decimalValue()).isEqualByComparingTo("60.0");
        assertThat(mitglied(z, w.e4()).isMissingNode()).as("die ausgebaute Box ist kein Mitglied mehr").isTrue();

        // (3) Sprungprobe: die Nachfolgerin erbt das Protokoll ihrer Linie (Quellen unverändert, R17 Schritt 2).
        TenantContext.set(w.tenant());
        assertThat(sprungproben.gilt(w.verbund(), e4neu)).isTrue();
        TenantContext.clear();

        // Betreiber bestätigt → Planer-Eingang nicht mehr belegt (Plan wieder); nur einmal.
        mvc.perform(plattform(w, post("/api/v1/admin/sites/" + w.site() + "/gemeinsame-steuerung/mitglieder/" + e4neu + "/bestaetigen")))
                .andExpect(status().isOk());
        assertThat(planerEingang(e4neu).get("bestaetigt_am")).isNotNull();
        mvc.perform(plattform(w, post("/api/v1/admin/sites/" + w.site() + "/gemeinsame-steuerung/mitglieder/" + e4neu + "/bestaetigen")))
                .andExpect(status().isConflict());
    }

    // ------------------------------------------------------------------ die führende Box

    @Test void tauschDerFuehrendenBoxUebertraegtRolleUndLaesstDieMitsteuerndenUnberuehrt() throws Exception {
        Welt w = welt();
        UUID e1neu = box(w, "Halle 1 (neu)");
        String mitsteuerndVorher = mitgliedZeile(w, w.e4());

        tauschen(w, e1neu, w.e1());

        var neu = root.queryForMap("SELECT rolle, data_source_id, bestaetigt_am, anteil_kennung FROM steuerungsverbund_mitglied "
                + "WHERE device_id = ?", e1neu);
        assertThat(neu.get("rolle")).isEqualTo("fuehrt");
        assertThat(neu.get("data_source_id")).isEqualTo(w.dq2());
        assertThat(neu.get("bestaetigt_am")).isNull();
        assertThat(neu.get("anteil_kennung")).isEqualTo(w.e1());
        assertThat(root.queryForObject("SELECT lead_device_id FROM site WHERE id = ?", UUID.class, w.site())).isEqualTo(e1neu);
        // A2: die mitsteuernde hält ihren Anteil — kein Dokument an sie, ihre Zeile unverändert, kein neues Dokument.
        assertThat(mitgliedZeile(w, w.e4())).isEqualTo(mitsteuerndVorher);
        ArgumentCaptor<String> topic = ArgumentCaptor.forClass(String.class);
        verify(versand, times(1)).senden(topic.capture(), any());
        assertThat(topic.getValue()).contains("/" + e1neu + "/v2/");
        assertThat(zahl("SELECT count(*) FROM steuerungsverbund_anteile WHERE steuerungsverbund_id = ?", w.verbund())).isEqualTo(1);
        // Die Probe von E-4 gegen E-1 gilt für die Nachfolgerin der führenden Box weiter (dieselben Quellen).
        TenantContext.set(w.tenant());
        assertThat(sprungproben.gilt(w.verbund(), w.e4())).isTrue();
        TenantContext.clear();
        // Genau eine führt, auch über die Tauschminute hinweg (die Exklusion der Datenbank).
        assertThat(zahl("SELECT count(*) FROM steuerungsverbund_mitglied WHERE steuerungsverbund_id = ? AND rolle = 'fuehrt' "
                + "AND gueltig_bis IS NULL AND aufgehoben_am IS NULL", w.verbund())).isEqualTo(1);
    }

    // ------------------------------------------------------------------ ohne Gemeinsame Steuerung (I6)

    @Test void tauschOhneGemeinsameSteuerungLegtKeineVerbundZeileAn() throws Exception {
        UUID t = root.queryForObject("INSERT INTO tenant(name) VALUES ('Ahrenberg · Tausch ohne Verbund') RETURNING id", UUID.class);
        UUID s = root.queryForObject("INSERT INTO site(tenant_id,name) VALUES (?,'Halle 2') RETURNING id", UUID.class, t);
        UUID old = geraet(t, s, "Box Halle 2"), next = geraet(t, s, "Box Halle 2 (neu)");
        UUID q = quelle(t, s, "DQ-4", old);
        when(selections.requireDevice(next)).thenReturn(new DeviceScope(t, s, next));
        assertThat(verbundZeilen(t)).isZero();
        String antwort = mvc.perform(auth(post("/api/v1/devices/" + next + "/succeed/" + old), t)).andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(verbundZeilen(t)).isZero();
        assertThat(antwort).doesNotContain("gemeinsame_steuerung");
        assertThat(root.queryForObject("SELECT device_id FROM data_source_assignment WHERE data_source_id = ? AND effective_to IS NULL",
                UUID.class, q)).isEqualTo(next);
        verify(versand, never()).senden(any(), any());
    }

    // ------------------------------------------------------------------ Welt

    record Welt(UUID tenant, UUID site, UUID verbund, UUID e1, UUID e4, UUID m4, UUID dq2, UUID dq10) {}

    private Welt welt() {
        UUID t = root.queryForObject("INSERT INTO tenant(name) VALUES ('Kunststoffwerk Ahrenberg · R17') RETURNING id", UUID.class);
        UUID s = root.queryForObject("INSERT INTO site(tenant_id,name) VALUES (?,'Werk') RETURNING id", UUID.class, t);
        UUID e1 = geraet(t, s, "Halle 1"), e4 = geraet(t, s, "Verwaltung");
        root.update("UPDATE site SET lead_device_id = ? WHERE id = ?", e1, s);
        UUID dq2 = quelle(t, s, "DQ-2", e1), dq10 = quelle(t, s, "DQ-10", e4);
        UUID v = root.queryForObject("INSERT INTO steuerungsverbund (tenant_id, site_id, stufe, epoche, created_by) "
                + "VALUES (?,?,'anteile_aktiv',1,'test') RETURNING id", UUID.class, t, s);
        String ab = "date_trunc('minute', now()) - interval '1 day'";
        String anteileJson = "{\"einspeisung\":{\"" + e1 + "\":40.0,\"" + e4 + "\":60.0},\"bezug\":{\"" + e1 + "\":473.0,\"" + e4 + "\":77.0}}";
        root.update("INSERT INTO steuerungsverbund_anteile (tenant_id, steuerungsverbund_id, site_id, epoche, revision, schritt, "
                + "verteilbar_einspeisung_kw, verteilbar_bezug_kw, anteile, anlass, created_by) "
                + "VALUES (?,?,?,1,2,'ziel',100,550,?::jsonb,'zielstand','test')", t, v, s, anteileJson);
        UUID m1 = mitglied(t, v, s, e1, "fuehrt", dq2, ab);
        UUID m4 = mitglied(t, v, s, e4, "steuert_mit", dq10, ab);
        root.update("UPDATE steuerungsverbund_mitglied SET vorgabe_signal = 'nein', vorgabe_signal_am = now(), vorgabe_signal_von = 'test' WHERE id = ?", m4);
        root.update("INSERT INTO steuerungsverbund_geraet (tenant_id, steuerungsverbund_id, site_id, device_id, richtung, nenn_kw, "
                + "schreibfreigabe, created_by) VALUES (?,?,?,?,'bezug',20,false,'test')", t, v, s, e4);
        root.update("INSERT INTO steuerungsverbund_sprungprobe (tenant_id, steuerungsverbund_id, site_id, device_id, fuehrende_box_id, "
                + "art, sprung_kw, dauer_s, wiederholungen, ausgeloest_am, gueltig_bis, actor_name, actor_art, urteil, ausgewertet_am) "
                + "VALUES (?,?,?,?,?,'erzeugung_senken',10,30,2,now() - interval '2 hours',now() - interval '1 hour','test','voltpilot',"
                + "'bestanden',now() - interval '1 hour')", t, v, s, e4, e1);
        assertThat(m1).isNotNull();
        return new Welt(t, s, v, e1, e4, m4, dq2, dq10);
    }

    private static UUID mitglied(UUID t, UUID v, UUID s, UUID box, String rolle, UUID quelle, String ab) {
        return root.queryForObject("INSERT INTO steuerungsverbund_mitglied (tenant_id, steuerungsverbund_id, site_id, device_id, "
                + "rolle, data_source_id, gueltig_ab, created_by, gesendet_epoche, gesendet_revision, gesendet_am, quittiert_epoche, "
                + "quittiert_revision, quittiert_am, bestaetigt_am, bestaetigt_von) VALUES (?,?,?,?,?,?," + ab + ",'test',1,2,now(),1,2,now(),"
                + "now(),'VoltPilot Betrieb') RETURNING id", UUID.class, t, v, s, box, rolle, quelle);
    }

    private UUID box(Welt w, String name) {
        UUID b = geraet(w.tenant(), w.site(), name);
        when(selections.requireDevice(b)).thenReturn(new DeviceScope(w.tenant(), w.site(), b));
        return b;
    }

    private static UUID geraet(UUID t, UUID s, String name) {
        return root.queryForObject("INSERT INTO device(tenant_id,site_id,external_ref,name,status) VALUES (?,?,?,?,'claimed') RETURNING id",
                UUID.class, t, s, "VP-TEST-" + UUID.randomUUID(), name);
    }

    private static UUID quelle(UUID t, UUID s, String kennzeichen, UUID box) {
        String adresse = "10.2.0." + (Math.abs(kennzeichen.hashCode()) % 200 + 1) + ":502";
        UUID q = root.queryForObject("INSERT INTO data_source(tenant_id,site_id,kennzeichen,protokoll,adresse,kadenz_s) "
                + "VALUES (?,?,?,'modbus_tcp',?,60) RETURNING id", UUID.class, t, s, kennzeichen, adresse);
        root.update("INSERT INTO data_source_assignment(tenant_id,data_source_id,device_id,protokoll,adresse,effective_from) "
                + "VALUES (?,?,?,'modbus_tcp',?,date_trunc('minute',now())-interval '1 day')", t, q, box, adresse);
        return q;
    }

    private void tauschen(Welt w, UUID neu, UUID alt) throws Exception {
        mvc.perform(auth(post("/api/v1/devices/" + neu + "/succeed/" + alt), w.tenant())).andExpect(status().isOk());
    }

    private static String mitgliedZeile(Welt w, UUID box) {
        return root.queryForList("SELECT * FROM steuerungsverbund_mitglied WHERE steuerungsverbund_id = ? AND device_id = ? ORDER BY gueltig_ab",
                w.verbund(), box).toString();
    }

    private static long zahl(String sql, Object... args) {
        return root.queryForObject(sql, Long.class, args);
    }

    private static long verbundZeilen(UUID t) {
        long n = 0;
        for (String tabelle : List.of("steuerungsverbund", "steuerungsverbund_mitglied", "steuerungsverbund_aenderung",
                "steuerungsverbund_geraet", "steuerungsverbund_anteile", "steuerungsverbund_sprungprobe")) {
            n += zahl("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?", t);
        }
        return n;
    }

    /**
     * Der Planer-Eingang je Box, gerechnet mit dem ECHTEN Ausdruck {@code _UMSCHLUESSELN} aus
     * {@code services/optimization/voltpilot_optimization/verbund.py} (aus der Datei gelesen, nicht nachgebaut).
     */
    private static Map<String, Object> planerEingang(UUID box) throws Exception {
        String py = Files.readString(Path.of("../optimization/voltpilot_optimization/verbund.py"));
        Matcher m = Pattern.compile("_UMSCHLUESSELN = \"\"\"(.*?)\"\"\"", Pattern.DOTALL).matcher(py);
        assertThat(m.find()).as("_UMSCHLUESSELN in verbund.py").isTrue();
        // JDBC liest ein nacktes ? als Parameter — der jsonb-Operator wird für den Treiber verdoppelt.
        String ausdruck = m.group(1).replace("{d}", "q").replace(" ? ", " ?? ");
        return root.queryForMap("SELECT m.bestaetigt_am, (" + ausdruck + ")->'einspeisung'->>m.device_id::text AS einspeisung, "
                + "(" + ausdruck + ")->'bezug'->>m.device_id::text AS bezug FROM steuerungsverbund_mitglied m "
                + "JOIN steuerungsverbund v ON v.id = m.steuerungsverbund_id LEFT JOIN steuerungsverbund_anteile q "
                + "ON q.steuerungsverbund_id = v.id AND q.epoche = m.quittiert_epoche AND q.revision = m.quittiert_revision "
                + "WHERE m.device_id = ? AND m.gueltig_bis IS NULL", box);
    }

    private static JsonNode mitglied(JsonNode zustand, UUID box) {
        for (JsonNode m : zustand.path("mitglieder")) {
            if (m.path("box_id").asText().equals(box.toString())) {
                return m;
            }
        }
        return com.fasterxml.jackson.databind.node.MissingNode.getInstance();
    }

    private String kunde(Welt w, MockHttpServletRequestBuilder r) throws Exception {
        return mvc.perform(r.with(jwt().jwt(j -> {
            j.subject("sub-jonas-" + w.tenant());
            j.claim("preferred_username", "Jonas Wendlinger");
            j.claim("tenant_id", w.tenant().toString());
        })).contentType(MediaType.APPLICATION_JSON)).andExpect(status().isOk()).andReturn().getResponse()
                .getContentAsString(StandardCharsets.UTF_8);
    }

    private static MockHttpServletRequestBuilder plattform(Welt w, MockHttpServletRequestBuilder r) {
        return r.header("X-Tenant-Id", w.tenant().toString()).with(jwt().jwt(j -> {
            j.subject("sub-betrieb");
            j.claim("preferred_username", "VoltPilot Betrieb");
        }).authorities(new SimpleGrantedAuthority("ROLE_platform-admin"))).contentType(MediaType.APPLICATION_JSON);
    }

    private static MockHttpServletRequestBuilder auth(MockHttpServletRequestBuilder r, UUID tenant) {
        var token = new org.springframework.security.oauth2.jwt.Jwt("test", Instant.now(), Instant.now().plusSeconds(3600),
                Map.of("alg", "none"), Map.of("sub", "test-" + tenant, "tenant_id", tenant.toString(), "name", "Test",
                        "realm_access", Map.of("roles", List.of())));
        return r.with(authentication(new com.voltpilot.api.config.KeycloakRealmRoleConverter().convert(token)));
    }
}
