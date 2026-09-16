package com.voltpilot.api.history;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.BestandGeraeteCsvVergleich;
import com.voltpilot.api.measurement.MeasurementHistoryService;
import com.voltpilot.api.repo.HistoryRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.HistoryBucketDto;
import com.voltpilot.api.web.dto.HistoryTotalsDto;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ConditionEvaluationResult;
import org.junit.jupiter.api.extension.ExecutionCondition;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.extension.ExtensionContext;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.util.ReflectionTestUtils;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Abschluss-Bestandsschutz AP-10 IP-18: die sichtbare Quoten-Ableitung liegt
 * hinter dem Messwertkern. Sechs Rollups und der bestehende Geräte-Export
 * bleiben byte-gleich; plausible Antworten sind auch mit dem Rückbau-Schalter
 * byte-gleich.
 */
@Testcontainers
@ExtendWith(UemsBilanzenBestandsschutzTest.DockerPflicht.class)
@SpringBootTest
@ActiveProfiles("local")
class UemsBilanzenBestandsschutzTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ENERGIE = "sunspec.model_203.totwhimp";
    private static final String KATALOG = "2026.09.16.1";
    private static final LocalDate TAG = LocalDate.now(ZoneOffset.UTC).minusDays(20);
    private static final Instant VON = TAG.atTime(10, 0).toInstant(ZoneOffset.UTC);
    private static final Instant BIS = VON.plus(Duration.ofHours(2));
    private static final Clock UHR = Clock.fixed(TAG.plusDays(20).atStartOfDay().toInstant(ZoneOffset.UTC),
            ZoneOffset.UTC);
    private static final List<String> ROLLUPS = List.of("telemetry_rollup_15m", "telemetry_rollup_1h",
            "telemetry_rollup_1d", "telemetry_v2_rollup_15m", "device_measurement_rollup_5m",
            "device_measurement_rollup_15m");

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
        registry.add("voltpilot.security.oidc.enabled", () -> "false");
    }

    @Autowired
    MeasurementHistoryService verlauf;

    private static JdbcTemplate root;
    private Object uhrVorher;

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void festeUhr() {
        uhrVorher = ReflectionTestUtils.getField(verlauf, "uhr");
        ReflectionTestUtils.setField(verlauf, "uhr", UHR);
    }

    @AfterEach
    void aufraeumen() {
        ReflectionTestUtils.setField(verlauf, "uhr", uhrVorher);
        TenantContext.clear();
    }

    @Test
    void quotenLassenRollupsUndExportByteGleich() throws Exception {
        root.queryForList("SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs "
                + "WHERE job_id >= 1000");
        Welt w = welt();
        kern(w);
        Kernbild vorher = kernbild(w);
        for (String rollup : ROLLUPS) {
            assertThat(vorher.rollups().get(rollup)).as("der Aufbau fuellt " + rollup).isNotEqualTo("leer");
        }

        List<HistoryBucketDto> plausibel = List.of(bucket(10, 8, 4, 2));
        HistoryRepository.PlannedSavings ohnePlan = new HistoryRepository.PlannedSavings(null, null);
        byte[] an = JSON.writeValueAsBytes(HistoryService.totals(plausibel, ohnePlan, null, true));
        byte[] aus = JSON.writeValueAsBytes(HistoryService.totals(plausibel, ohnePlan, null, false));
        assertThat(an).as("Werte innerhalb der Klemmgrenze").containsExactly(aus);

        HistoryTotalsDto unplausibel = HistoryService.totals(
                List.of(bucket(10, 8, 12, 10)), ohnePlan, null, true);
        assertThat(unplausibel.autarkiePct()).isEqualTo(new BigDecimal("-20.0"));
        assertThat(unplausibel.eigenverbrauchPct()).isEqualTo(new BigDecimal("-25.0"));
        assertThat(unplausibel.autarkieUnplausibel()).isTrue();
        assertThat(unplausibel.eigenverbrauchUnplausibel()).isTrue();

        Kernbild nachher = kernbild(w);
        assertThat(nachher.rollups()).as("alle sechs Kern-Rollups").isEqualTo(vorher.rollups());
        assertThat(nachher.decoded()).as("bestehender Export decoded").containsExactly(vorher.decoded());
        assertThat(nachher.raw()).as("bestehender Export raw").containsExactly(vorher.raw());
    }

    private record Welt(UUID mandant, UUID site, UUID box, UUID entity, UUID box5m, UUID entity5m) {}
    private record Kernbild(Map<String, String> rollups, byte[] decoded, byte[] raw) {}

    private static Welt welt() {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES ('Bestandsschutz AP-10') RETURNING id", UUID.class);
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, 'Halle 2', ?) "
                + "RETURNING id", UUID.class, t, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
        UUID box = device(t, site, "VP-BESTAND-AP10");
        UUID entity = entity(t, site, box, "Bestandszaehler");
        auswahl(t, site, box, entity, 900);
        UUID box5m = device(t, site, "VP-BESTAND-AP10-5M");
        UUID entity5m = entity(t, site, box5m, "Bestandszaehler 5 Minuten");
        auswahl(t, site, box5m, entity5m, 300);
        return new Welt(t, site, box, entity, box5m, entity5m);
    }

    private static UUID device(UUID tenant, UUID site, String ref) {
        return root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) RETURNING id",
                UUID.class, tenant, site, ref + "-" + UUID.randomUUID());
    }

    private static UUID entity(UUID tenant, UUID site, UUID box, String label) {
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "device_id, communication, connection_json, created_at) VALUES (?, ?, 'modbus-generic', ?, "
                + "'modbus-generic', ?, 'modbus_tcp', '{\"unit_id\":1}'::jsonb, ?) RETURNING id", UUID.class, tenant,
                site, label, box, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
    }

    private static void auswahl(UUID tenant, UUID site, UUID box, UUID entity, int kadenz) {
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy, long_term_cadence_s) VALUES (?, ?, ?, ?, ?, true, 60, 1, "
                + "now(), ?, 'test', 'pending_edge', 'energy_counter', ?, ?)", tenant, site, box, entity, ENERGIE,
                KATALOG, kadenz == 300 ? "five_minute" : "fifteen_minute", kadenz);
    }

    private static void kern(Welt w) {
        for (int i = 0; i < 24; i++) {
            Timestamp zeit = Timestamp.from(VON.plus(Duration.ofMinutes(5L * i)));
            messwert(w, w.box5m(), w.entity5m(), zeit, 2_000_000.0 + i * 40, 20_000 + i, 300);
            root.update("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw, load_kw, pv_power_kw) "
                    + "VALUES (?, ?, ?, ?, ?, ?, 0)", zeit, w.mandant(), w.site(), w.box(), 2.0 + i / 10.0,
                    2.0 + i / 10.0);
            root.update("INSERT INTO telemetry_v2 (time, tenant_id, site_id, device_id, entity_id, channel, value) "
                    + "VALUES (?, ?, ?, ?, ?, 'active_power', ?)", zeit, w.mandant(), w.site(), w.box(),
                    w.entity().toString(), 1500.0 + i * 10);
            messwert(w, w.box(), w.entity(), zeit, 1_000_000.0 + i * 125, 10_000 + i, 900);
        }
        String seit = TAG.atStartOfDay().toInstant(ZoneOffset.UTC).toString();
        root.execute("CALL refresh_telemetry_rollups('" + seit + "')");
        root.execute("CALL refresh_telemetry_v2_rollups('" + seit + "')");
        root.execute("CALL refresh_device_measurement_rollup('device_measurement_rollup_5m'::regclass, "
                + "interval '5 minutes', '" + seit + "')");
        root.execute("CALL refresh_device_measurement_rollup('device_measurement_rollup_15m'::regclass, "
                + "interval '15 minutes', '" + seit + "')");
    }

    private static void messwert(Welt w, UUID box, UUID entity, Timestamp zeit, double wert, int folge, int kadenz) {
        root.update("INSERT INTO device_measurement_sample (time, tenant_id, site_id, device_id, point_key, raw_numeric, "
                + "decoded_numeric, quality, catalog_version, edge_sequence, aggregation_kind, long_term_cadence_s, "
                + "entity_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'good', ?, ?, 'counter', ?, ?)", zeit, w.mandant(),
                w.site(), box, ENERGIE, wert, wert, KATALOG, folge, kadenz, entity);
    }

    private Kernbild kernbild(Welt w) {
        Map<String, String> rollups = new LinkedHashMap<>();
        ROLLUPS.forEach(r -> rollups.put(r, inhalt(r)));
        return new Kernbild(rollups, export(w, "decoded"), export(w, "raw"));
    }

    private static String inhalt(String tabelle) {
        return root.queryForObject("SELECT coalesce(md5(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text)), "
                + "'leer') FROM " + tabelle + " t", String.class);
    }

    private byte[] export(Welt w, String darstellung) {
        TenantContext.set(w.mandant());
        try {
            return verlauf.csv(verlauf.history(w.box(), ENERGIE, "free", VON, BIS, darstellung, null, w.entity()),
                    BestandGeraeteCsvVergleich.erzeugung());
        } finally {
            TenantContext.clear();
        }
    }

    private static HistoryBucketDto bucket(double load, double pv, double imp, double exp) {
        return new HistoryBucketDto(VON, BigDecimal.valueOf(pv), BigDecimal.valueOf(load), BigDecimal.valueOf(imp),
                BigDecimal.valueOf(exp), null, null, null, null, null, null, null);
    }

    /** Ohne Docker ist der Abschlussnachweis nicht gruen, sondern nachweislich nicht gelaufen. */
    static final class DockerPflicht implements ExecutionCondition {
        @Override
        public ConditionEvaluationResult evaluateExecutionCondition(ExtensionContext context) {
            if (DockerClientFactory.instance().isDockerAvailable()) {
                return ConditionEvaluationResult.enabled("Docker ist da — der AP-10-Bestandsschutz laeuft");
            }
            String satz = "UEBERSPRUNGEN: " + context.getDisplayName()
                    + " — UEMS AP-10 IP-18 ist NICHT gelaufen, weil Docker fehlt.";
            System.err.println(satz);
            return ConditionEvaluationResult.disabled(satz);
        }
    }
}
