package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementBudget;
import com.voltpilot.api.measurement.MeasurementBudget.SourceCandidate;
import com.voltpilot.api.measurement.MeasurementBudget.SourceRequest;
import java.io.IOException;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/** A6/A10 gegen dieselben Zahlen wie AP-06 {@code k_budget.py}. */
class DatenquelleBudgetTest {

    private static JsonNode fixture;

    @BeforeAll
    static void laden() throws IOException {
        fixture = new ObjectMapper().readTree(Path.of("..", "..", "docs", "contracts", "v2",
                "data-source-budget-vectors.json").toFile());
    }

    @TestFactory
    Stream<DynamicTest> a6SzenarienS1BisS7() {
        List<JsonNode> cases = StreamSupport.stream(fixture.get("cases").spliterator(), false).toList();
        assertThat(cases).hasSize(7);
        return cases.stream().map(c -> DynamicTest.dynamicTest(c.get("name").asText(), () -> {
            JsonNode in = c.get("input");
            var estimate = MeasurementBudget.estimateSources(List.of(source("S", in)));
            JsonNode expected = c.get("expected");
            assertThat(estimate.samplesPerMinute()).isEqualTo(expected.get("samples_per_minute").asDouble());
            assertThat(estimate.requestsPerMinute()).isEqualTo(expected.get("requests_per_minute").asDouble());
            assertThat(estimate.dutyCyclePercent()).isEqualTo(expected.get("duty_cycle_percent").asDouble());
            assertThat(estimate.softWarning()).isEqualTo(expected.get("soft_warning").asBoolean());
            assertThat(estimate.hardRejected()).isEqualTo(expected.get("hard_rejected").asBoolean());
        }));
    }

    @Test
    void a10NenntTakt60UndBoxMit29FreienAnfragenOhneDenBestandZuAendern() {
        JsonNode a10 = fixture.get("a10");
        UUID e1 = UUID.randomUUID();
        UUID e2 = UUID.randomUUID();
        SourceCandidate bestandE1 = source("bestand-e1", a10.get("target_before"), 60, 22, 400, 66);
        SourceCandidate bestandE2 = source("bestand-e2", null, 60, 1, 400, 3);
        SourceCandidate dq3 = source("DQ-3", a10.get("source"));
        List<SourceCandidate> vorherE1 = List.of(bestandE1);
        List<SourceCandidate> vorherE2 = List.of(bestandE2);

        DatenquelleBudget.Ablehnung ab = DatenquelleBudget.pruefe("DQ-3", dq3, e1, List.of(
                new DatenquelleBudget.BoxStand(e1, "Box Halle 1", vorherE1),
                new DatenquelleBudget.BoxStand(e2, "Box Halle 2", vorherE2)));

        assertThat(ab).isNotNull();
        assertThat(ab.boxNachher().requestsPerMinute()).isEqualTo(46);
        assertThat(ab.auswege().taktS()).isEqualTo(a10.get("expected_cadence_s").asInt());
        assertThat(ab.auswege().takt()).isEqualTo("Takt 60 s wählen");
        assertThat(ab.auswege().boxen()).singleElement().satisfies(box -> {
            assertThat(box.name()).isEqualTo("Box Halle 2");
            assertThat(box.frei().requestsPerMinute())
                    .isEqualTo(a10.get("other_box_free_requests_per_minute").asDouble());
        });
        assertThat(ab.auswege().andereBox()).isEqualTo("Box Halle 2 wählen (29 Anfragen/min frei)");
        assertThat(vorherE1).containsExactly(bestandE1);
        assertThat(vorherE2).containsExactly(bestandE2);
    }

    @Test
    void kostenBleibenDieHeutigeJavaTabelleOhneEdgeVertrag() {
        assertThat(MeasurementBudget.requestCostMsForProtocol("modbus_tcp")).isEqualTo(400);
        assertThat(MeasurementBudget.requestCostMsForProtocol("sunspec_modbus")).isEqualTo(400);
        assertThat(MeasurementBudget.requestCostMsForProtocol("http")).isEqualTo(250);
        assertThat(MeasurementBudget.requestCostMsForProtocol("mqtt")).isEqualTo(250);
        assertThat(MeasurementBudget.requestCostMsForProtocol("solarman_v5")).isEqualTo(250);
        assertThat(MeasurementBudget.requestCostMsForProtocol("ocpp")).isZero();
        assertThat(MeasurementBudget.customRegisterRequestCostMs()).isEqualTo(2_000);
    }

    /**
     * ⚠ Berichtigt mit AP-05 IP-6 (Befund 10): der Messbudget-Vertrag führte
     * {@code wago_registerbild} mit fünf Energiekarten je Anfrage. Fünf Karten sind 222 Wörter
     * (12 + 42 · K) und passen in kein Modbus-Telegramm; der Registerbild-Vertrag §7 erlaubt
     * höchstens 120 Wörter je Anfrage und teilt einen Karten-Block nie. Also zwei Karten je
     * Anfrage, für 25 Karten dreizehn Blöcke statt fünf.
     *
     * <p>Damit nennt der S1-Fall in {@code data-source-budget-vectors.json} (AP-06 §4.6) mit
     * {@code requests_per_cadence: 20} nicht mehr die Zahl, die der Planer für 100 Karten an
     * vier Steuerungen ausrechnet — es wären 52. Die Rechnung, die der Fall prüft, stimmt
     * weiterhin, und sein Urteil ändert sich nicht (schon über der Proben-Grenze). Das
     * Nachziehen des AP-06-Szenarios gehört nicht in dieses Paket.
     */
    @Test
    void s1VierWagoSteuerungenMitJe25KartenSindDreizehnBloeckeJeTakt() {
        assertThat(DatenquelleBudgetService.wagoBloecke(25)).isEqualTo(13);
        assertThat(4 * DatenquelleBudgetService.wagoBloecke(25)).isEqualTo(52);
        // Die Tabelle aus dem Registerbild-Vertrag §7, Karte für Karte.
        assertThat(DatenquelleBudgetService.wagoBloecke(1)).isEqualTo(1);
        assertThat(DatenquelleBudgetService.wagoBloecke(2)).isEqualTo(1);
        assertThat(DatenquelleBudgetService.wagoBloecke(3)).isEqualTo(2);
        assertThat(DatenquelleBudgetService.wagoBloecke(4)).isEqualTo(2);
        assertThat(DatenquelleBudgetService.wagoBloecke(5)).isEqualTo(3);
    }

    private static SourceCandidate source(String name, JsonNode n) {
        return source(name, n, n.get("cadence_s").asInt(), n.get("requests_per_cadence").asInt(),
                n.get("request_cost_ms").asInt(), n.get("channels").asInt());
    }

    private static SourceCandidate source(String name, JsonNode ignored, int cadence, int requests,
            int cost, int channels) {
        return new SourceCandidate(name, cost == 2_000 ? "frei" : "modbus_tcp", channels, cadence,
                List.of(new SourceRequest(requests, cost)));
    }
}
