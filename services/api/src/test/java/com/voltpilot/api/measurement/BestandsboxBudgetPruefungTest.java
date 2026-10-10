package com.voltpilot.api.measurement;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.StreamSupport;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/** AP-14 U12 and the X5 fleet audit against seeded plans in a disposable database. */
@Testcontainers(disabledWithoutDocker = true)
class BestandsboxBudgetPruefungTest {

    private static final UUID TENANT = UUID.fromString("17000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("17000000-0000-0000-0000-000000000002");
    private static final UUID OHNE_PLAN = UUID.fromString("17000000-0000-0000-0000-000000000003");
    private static final UUID U12_FUENF = UUID.fromString("17000000-0000-0000-0000-000000000005");
    private static final UUID U12_ZEHN = UUID.fromString("17000000-0000-0000-0000-000000000010");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("uems")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw")
            .withCommand("postgres", "-c", "timescaledb.max_background_workers=0");

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static DriverManagerDataSource dataSource;
    private static MeasurementCatalog catalog;

    @BeforeAll
    static void schemaUndPlaene() throws Exception {
        Flyway.configure().dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .placeholders(Map.of("appDbUser", "voltpilot_app", "appDbPassword", "pw_app",
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "pw_admin"))
                .load().migrate();
        dataSource = new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword());
        catalog = new MeasurementCatalog(MAPPER);
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        jdbc.update("INSERT INTO tenant(id,name,segment) VALUES (?,?,?)", TENANT,
                "Budgetprüfung", "CI");
        jdbc.update("INSERT INTO site(id,tenant_id,name,bidding_zone) VALUES (?,?,?,?)", SITE,
                TENANT, "Nur Test", "DE-LU");
        for (UUID device : List.of(OHNE_PLAN, U12_FUENF, U12_ZEHN)) {
            jdbc.update("INSERT INTO device(id,tenant_id,site_id,external_ref,kind,status) "
                    + "VALUES (?,?,?,?,?,?)", device, TENANT, SITE, "budget-" + device,
                    "inverter", "claimed");
        }
        plan(jdbc, U12_FUENF, 5, 5);
        plan(jdbc, U12_ZEHN, 10, 10);
    }

    @Test
    void u12FuenfSekundenAbgelehntUndZehnSekundenEinschliesslichAngenommen() {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        var result = BestandsboxBudgetPruefung.run(dataSource,
                new PrintStream(bytes, true, StandardCharsets.UTF_8));

        assertThat(result.boxenGesamt()).isEqualTo(3);
        assertThat(result.plaeneGeprueft()).isEqualTo(2);
        assertThat(result.angenommen()).isEqualTo(1);
        assertThat(result.abgelehnt()).singleElement().satisfies(rejected -> {
            assertThat(rejected.box().deviceId()).isEqualTo(U12_FUENF);
            assertThat(rejected.estimate().dutyCyclePercent()).isEqualTo(40.0);
            assertThat(rejected.kleinsterAusweg()).contains("5 s → 10 s", "20,0 %");
        });

        String output = bytes.toString(StandardCharsets.UTF_8);
        String teilAc = output.substring(0, output.indexOf("TEIL D"));
        assertThat(teilAc).doesNotContain(TENANT.toString(), SITE.toString(),
                OHNE_PLAN.toString(), U12_FUENF.toString(), U12_ZEHN.toString());
        assertThat(output.substring(output.indexOf("TEIL D"))).contains(U12_FUENF.toString());
    }

    @Test
    void jederFreeRegisterDutyVektorHatDasselbeUrteilWieDasWerkzeug() throws Exception {
        JsonNode cases = MAPPER.readTree(Path.of("../../docs/contracts/v2/measurement-budget-vectors.json")
                .toFile()).required("cases");
        var vectors = StreamSupport.stream(cases.spliterator(), false)
                .filter(c -> c.required("id").asText().startsWith("free-register-duty-"))
                .toList();
        assertThat(vectors).extracting(c -> c.required("id").asText())
                .containsExactly("free-register-duty-boundary", "free-register-duty-exceeded");
        for (JsonNode vector : vectors) {
            int cadence = vector.required("sources").get(0).required("cadence_s").asInt();
            var estimate = BestandsboxBudgetPruefung.pruefePlan(
                    List.of(custom("custom.vector", 42, cadence)), catalog, MAPPER);
            assertThat(estimate.hardRejected()).as(vector.required("id").asText())
                    .isEqualTo(vector.required("expected").required("hard_rejected").asBoolean());
            assertThat(estimate.dutyCyclePercent())
                    .isEqualTo(vector.required("expected").required("duty_cycle_percent").asDouble());
        }
    }

    @Test
    void knappUnterAufUndUeberJederGrenze() {
        assertThat(estimate(unknown(1, 2, 3, 10, 20)).samplesPerMinute()).isEqualTo(119.0);
        assertThat(estimate(unknown(1, 2, 3, 10, 20)).softWarning()).isFalse();
        assertThat(estimate(unknown(1, 1)).samplesPerMinute()).isEqualTo(120.0);
        assertThat(estimate(unknown(1, 1)).softWarning()).isTrue(); // einschließlich Warnung
        assertThat(estimate(unknown(1, 2, 3, 10, 20, 30)).samplesPerMinute()).isEqualTo(121.0);
        assertThat(estimate(unknown(1, 2, 3, 10, 20, 30)).softWarning()).isTrue();

        List<MeasurementPlan.Entry> samples599 = unknown(1, 1, 1, 1, 1, 1, 1, 1, 1,
                2, 3, 10, 20);
        assertThat(estimate(samples599).samplesPerMinute()).isEqualTo(599.0);
        assertThat(estimate(samples599).hardRejected()).isFalse();
        assertThat(estimate(unknown(1, 1, 1, 1, 1, 1, 1, 1, 1, 1)).hardRejected())
                .isFalse(); // 600 einschließlich erlaubt
        List<MeasurementPlan.Entry> samples601 = unknown(1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
                60);
        assertThat(estimate(samples601).samplesPerMinute()).isEqualTo(601.0);
        assertThat(estimate(samples601).hardRejected()).isTrue();

        assertThat(estimate(http(3, 10, 20)).requestsPerMinute()).isEqualTo(29.0);
        assertThat(estimate(http(3, 10, 20)).hardRejected()).isFalse();
        assertThat(estimate(http(2)).requestsPerMinute()).isEqualTo(30.0);
        assertThat(estimate(http(2)).hardRejected()).isFalse(); // 30 einschließlich erlaubt
        assertThat(estimate(http(2, 60)).requestsPerMinute()).isEqualTo(31.0);
        assertThat(estimate(http(2, 60)).hardRejected()).isTrue();

        assertThat(estimate(List.of(custom("custom.unter", 1, 11))).hardRejected()).isFalse();
        assertThat(estimate(List.of(custom("custom.auf", 2, 10))).hardRejected()).isFalse();
        assertThat(estimate(List.of(custom("custom.ueber", 3, 9))).hardRejected()).isTrue();
    }

    @Test
    void schreibversuchScheitertInDerselbenReadOnlyKlammer() {
        assertThatThrownBy(() -> BestandsboxBudgetPruefung.readOnly(dataSource, jdbc -> {
            jdbc.update("UPDATE device SET status='offline' WHERE id=?", OHNE_PLAN);
            return null;
        })).hasRootCauseMessage("ERROR: cannot execute UPDATE in a read-only transaction");
    }

    private static MeasurementBudget.Estimate estimate(List<MeasurementPlan.Entry> entries) {
        return BestandsboxBudgetPruefung.pruefePlan(entries, catalog, MAPPER);
    }

    private static List<MeasurementPlan.Entry> unknown(int... cadences) {
        List<MeasurementPlan.Entry> entries = new ArrayList<>();
        for (int i = 0; i < cadences.length; i++) {
            entries.add(entry("unknown." + i, cadences[i], null));
        }
        return entries;
    }

    private static List<MeasurementPlan.Entry> http(int... cadences) {
        List<String> keys = List.of("fronius_solar_api.battery-soc", "kaco_http.ac-power",
                "kaco_http.grid-power");
        List<MeasurementPlan.Entry> entries = new ArrayList<>();
        for (int i = 0; i < cadences.length; i++) {
            entries.add(entry(keys.get(i), cadences[i], null));
        }
        return entries;
    }

    private static MeasurementPlan.Entry custom(String key, int address, int cadence) {
        return entry(key, cadence, customJson(address, cadence));
    }

    private static MeasurementPlan.Entry entry(String key, int cadence, JsonNode custom) {
        return new MeasurementPlan.Entry(null, key, cadence, custom, "thermal_bms", 90, 900,
                "fifteen_minute");
    }

    private static JsonNode customJson(int address, int cadence) {
        return MAPPER.valueToTree(new CustomMeasurementPoint.Canonical("Register " + address,
                "modbus_holding", address, String.format("holding:0x%04x", address), "uint16",
                16, false, "big", java.math.BigDecimal.ONE, "kW", cadence, "thermal_bms", true,
                MeasurementBudget.customRegisterRequestCostMs()));
    }

    private static void plan(JdbcTemplate jdbc, UUID device, int address, int cadence) {
        String json = customJson(address, cadence).toString();
        jdbc.update("""
                INSERT INTO device_measurement_selection
                    (tenant_id,site_id,device_id,point_key,enabled,cadence_s,desired_revision,
                     enabled_at,catalog_version,changed_by,apply_status,custom_definition,
                     retention_class,raw_retention_days,long_term_cadence_s,long_term_strategy)
                VALUES (?,?,?,?,true,?,1,now(),?,'test','pending_edge',?::jsonb,'thermal_bms',90,900,
                        'fifteen_minute')
                """, TENANT, SITE, device, "custom." + address, cadence, catalog.version(), json);
    }
}
