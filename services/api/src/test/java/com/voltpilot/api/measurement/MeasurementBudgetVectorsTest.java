package com.voltpilot.api.measurement;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

class MeasurementBudgetVectorsTest {
    private static final Path CONTRACT = Path.of("../../docs/contracts/v2/measurement-budget-vectors.json");

    @Test
    void packagedContractIsExactlyTheCanonicalFile() throws Exception {
        try (var resource = getClass().getResourceAsStream("/uems/measurement-budget-vectors.json")) {
            assertThat(resource).isNotNull();
            assertThat(resource.readAllBytes()).isEqualTo(Files.readAllBytes(CONTRACT));
        }
    }

    @Test
    void releasedRuntimeCatalogKeepsEveryCloudCostAndVersion() throws Exception {
        var catalog = new ObjectMapper().readTree(Path.of("../../edge-app/nodered/measurements/catalog.json").toFile());
        assertThat(catalog.required("catalog_version").asText()).isEqualTo("2026.09.23.3");
        for (var p : catalog.required("points")) {
            String kind = p.required("source_kind").asText();
            // Die WAGO-Karten kamen mit 2026.09.23.3 an die Box (UEMS AP-05 IP-6b): kein früherer Preis,
            // der gemeinsame Vertrag nennt ihn.
            int before = "wago_registerbild".equals(kind)
                    ? new ObjectMapper().readTree(CONTRACT.toFile()).at("/families/wago_registerbild/request_cost_ms").asInt()
                    : "ocpp_sampled_value".equals(kind) ? 1
                    : kind.startsWith("modbus") || "sunspec_model".equals(kind) ? 400 : 250;
            assertThat(MeasurementBudget.requestCostMs(kind, p.required("family").asText()))
                    .as(p.required("point_key").asText()).isEqualTo(before);
        }
    }

    @TestFactory
    Stream<DynamicTest> sameA16VectorsAsNodeRedIncludingAhrenbergAnd25Cards() throws Exception {
        JsonNode cases = new ObjectMapper().readTree(CONTRACT.toFile()).required("cases");
        assertThat(cases.size()).isGreaterThanOrEqualTo(22);
        return StreamSupport.stream(cases.spliterator(), false).map(c ->
                DynamicTest.dynamicTest(c.required("id").asText(), () -> {
                    var sources = new ArrayList<MeasurementBudget.SourceCandidate>();
                    for (var s : c.required("sources")) {
                        var requests = new ArrayList<MeasurementBudget.SourceRequest>();
                        for (var b : s.required("blocks")) {
                            String family = b.path("family").asText(null);
                            String kind = b.required("source_kind").asText();
                            requests.add(new MeasurementBudget.SourceRequest(
                                    MeasurementBudget.requestsForUnits(family, kind, b.required("units").asInt()),
                                    MeasurementBudget.requestCostMsForFamily(family, kind)));
                        }
                        sources.add(new MeasurementBudget.SourceCandidate(c.required("id").asText(),
                                "contract", s.required("channels").asInt(), s.required("cadence_s").asInt(), requests));
                    }
                    var result = MeasurementBudget.estimateSources(sources);
                    var expected = c.required("expected");
                    assertThat(result.samplesPerMinute()).isEqualTo(expected.required("samples_per_minute").asDouble());
                    assertThat(result.requestsPerMinute()).isEqualTo(expected.required("requests_per_minute").asDouble());
                    assertThat(result.dutyCyclePercent()).isEqualTo(expected.required("duty_cycle_percent").asDouble());
                    assertThat(result.softWarning()).isEqualTo(expected.required("soft_warning").asBoolean());
                    assertThat(result.hardRejected()).isEqualTo(expected.required("hard_rejected").asBoolean());
                }));
    }

    @Test
    void unbenchedRegisterAtFiveSecondsWasAlreadyRejectedByTheCloud() {
        var retention = new MeasurementRetention("thermal_bms", 90, 900, "fifteen_minute");
        var result = MeasurementBudget.estimate(List.of(new MeasurementBudget.Candidate(
                "custom.42", true, 5, "custom:modbus_holding:42",
                MeasurementBudget.customRegisterRequestCostMs(), retention, "custom")));
        assertThat(result.dutyCyclePercent()).isEqualTo(40);
        assertThat(result.hardRejected()).isTrue();
    }
}
