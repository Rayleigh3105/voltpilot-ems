package com.voltpilot.api.flows;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.flows.FlowGraphValidator.EntityCapabilities;
import com.voltpilot.api.flows.FlowGraphValidator.ForeignClaim;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * The platform validator, rule by rule (flow-graph contract §4). The contract
 * example fixtures are the executable contract check (the E1a fixture
 * discipline - moving docs/contracts/v2/examples breaks this deliberately),
 * and the broken-flow vectors here are MIRRORED in the portal's
 * src/flows/validate.test.ts so client and server stay in lockstep (the
 * EdgeRef shared-vector precedent).
 */
class FlowGraphValidatorTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final FlowCatalog catalog = new FlowCatalog(MAPPER);
    private final FlowGraphValidator validator = new FlowGraphValidator(catalog);

    /** Capabilities matching the contract fixtures' entities. */
    private static final Map<String, EntityCapabilities> FIXTURE_ENTITIES = Map.of(
            "batt-main", new EntityCapabilities(Set.of("soc_pct", "battery_power_kw"),
                    Set.of("setpoint_kw", "limit_kw"), true),
            "grid-meter-1", new EntityCapabilities(Set.of("power_kw"), Set.of(), true),
            "heatrod-cellar", new EntityCapabilities(Set.of(), Set.of("on_off")),
            "wallbox-1", new EntityCapabilities(Set.of("power_kw"), Set.of("on_off", "setpoint_kw")),
            "pv-roof-east", new EntityCapabilities(Set.of("pv_power_kw"), Set.of("limit_pct"), true),
            "modbus-meter-1", new EntityCapabilities(Set.of("leistung_kw"), Set.of()),
            // Einheitsmodell Stufe 4: the released self-built switch of the
            // flow-graph.valid.modbus-switch fixture.
            "9c1e5d70-4a2b-4c8f-b3d1-fedcba987654", new EntityCapabilities(
                    Set.of("wassertemperatur_speicher_oben", "aufnahmeleistung"),
                    Set.of("on_off")));

    private static JsonNode fixture(String name) throws IOException {
        return MAPPER.readTree(Files.readString(
                Path.of("..", "..", "docs", "contracts", "v2", "examples", name)));
    }

    private List<FlowValidationFinding> validate(JsonNode doc) {
        return validator.validate(doc, FIXTURE_ENTITIES, List.of());
    }

    private static List<String> errors(List<FlowValidationFinding> findings) {
        return findings.stream().filter(FlowValidationFinding::isError)
                .map(FlowValidationFinding::rule).toList();
    }

    // ---- contract fixtures are the executable contract ---------------------

    @Test
    void marketBatteryFixtureValidatesClean() throws IOException {
        List<FlowValidationFinding> findings = validate(fixture(
                "flow-graph.valid.market-battery.json"));
        assertThat(errors(findings)).isEmpty();
    }

    @Test
    void pvSurplusHeatrodFixtureValidatesClean() throws IOException {
        List<FlowValidationFinding> findings = validate(fixture(
                "flow-graph.valid.pv-surplus-heatrod.json"));
        assertThat(errors(findings)).isEmpty();
    }

    @Test
    void notifyThresholdFixtureValidatesClean() throws IOException {
        // #518: Schwellwert -> Wenn/Dann-gate -> Benachrichtigung. The editor +
        // server accept it (catalog-driven), so it reaches activation - where it
        // used to die because flowc lacked the gate compile entry (now fixed).
        List<FlowValidationFinding> findings = validate(fixture(
                "flow-graph.valid.notify-threshold.json"));
        assertThat(errors(findings)).isEmpty();
    }

    @Test
    void compoundWallboxFixtureValidatesClean() throws IOException {
        // U3: "PV-Überschuss UND Zeitfenster -> Wallbox" - the boolean
        // combinator vp.logic.and joins a threshold + schedule condition.
        List<FlowValidationFinding> findings = validate(fixture(
                "flow-graph.valid.compound-wallbox.json"));
        assertThat(errors(findings)).isEmpty();
    }

    @Test
    void priceWallboxFixtureValidatesClean() throws IOException {
        // U3: "Börsenpreis < 10 ct -> Wallbox" - the vp.price.current data node
        // feeds a threshold as a number.
        List<FlowValidationFinding> findings = validate(fixture(
                "flow-graph.valid.price-wallbox.json"));
        assertThat(errors(findings)).isEmpty();
    }

    @Test
    void consumerReactiveFixtureValidatesCleanOnlyWithItsOrigin() throws IOException {
        // D-19: the GENERATED consumer-policy flow (origin marker + one
        // vp.consumer.reactive node) validates clean...
        assertThat(errors(validate(fixture("flow-graph.valid.consumer-reactive.json")))).isEmpty();

        // ...while the SAME node without the server-stamped origin is refused -
        // the generated-only type never validates in a customer document.
        List<FlowValidationFinding> findings = validate(fixture(
                "flow-graph.invalid.reactive-without-origin.json"));
        assertThat(errors(findings)).contains("V-4");
        assertThat(findings.stream().map(FlowValidationFinding::message))
                .anyMatch(m -> m.contains("generierten Verbraucherregel vorbehalten"));
    }

    @Test
    void modbusSwitchFixtureValidatesCleanOnlyWithItsOwnOrigin() throws IOException {
        // Einheitsmodell Stufe 4: the SECOND generated-only type. Its origin
        // kind is `modbus-device`, NOT `consumer-policy` - a validator that
        // hardcodes the consumer-policy origin refuses this perfectly valid
        // document, and one that hardcodes nothing lets the switch into any
        // flow. The refusal must NAME which generated flow owns the block.
        ObjectNode doc = (ObjectNode) fixture("flow-graph.valid.modbus-switch.json");
        assertThat(errors(validate(doc))).isEmpty();

        ObjectNode noOrigin = (ObjectNode) fixture("flow-graph.valid.modbus-switch.json");
        noOrigin.remove("origin");
        List<FlowValidationFinding> findings = validate(noOrigin);
        assertThat(errors(findings)).contains("V-4");
        assertThat(findings.stream().map(FlowValidationFinding::message))
                .anyMatch(m -> m.contains("generierten Ger\u00e4te-Flow vorbehalten"));

        // ...and the two origin kinds are NOT interchangeable: a switch
        // smuggled into a consumer-policy document is refused as well.
        ObjectNode foreign = (ObjectNode) fixture("flow-graph.valid.modbus-switch.json");
        foreign.putObject("origin").put("kind", "consumer-policy");
        assertThat(errors(validate(foreign))).contains("V-4");
    }

    @Test
    void overrideOnEntityControlIsReservedForTheGeneratedArtifact() throws IOException {
        // D-19: whatever the value, a vp.entity.control carrying `override` is
        // refused - no catalog flow may claim the D-5 plan-override lever.
        ObjectNode doc = (ObjectNode) fixture("flow-graph.valid.price-wallbox.json");
        ObjectNode control = (ObjectNode) doc.path("nodes").get(2);
        ((ObjectNode) control.path("parameters")).put("override", true);
        List<FlowValidationFinding> findings = validate(doc);
        assertThat(findings.stream().map(FlowValidationFinding::message))
                .anyMatch(m -> m.contains("override ist der generierten Verbraucherregel"));

        ((ObjectNode) control.path("parameters")).put("override", false);
        assertThat(validate(doc).stream().map(FlowValidationFinding::message))
                .anyMatch(m -> m.contains("override ist der generierten Verbraucherregel"));
    }

    @Test
    void unknownTriggerFixtureFailsExactlyOnV7() throws IOException {
        List<FlowValidationFinding> findings = validate(fixture(
                "flow-graph.invalid.unknown-trigger.json"));
        assertThat(errors(findings)).containsExactly("V-7");
        assertThat(findings.get(0).message()).contains("cron");
    }

    // ---- the pilot flow (acceptance chain) ---------------------------------

    @Test
    void pilotFlowValidatesCleanWithOneDelegatedClaim() {
        JsonNode doc = pilotFlow("batt-main");
        assertThat(errors(validate(doc))).isEmpty();
        List<FlowClaims.DerivedClaim> claims = FlowClaims.derive(doc, catalog);
        assertThat(claims).hasSize(1);
        assertThat(claims.get(0).nodeId()).isEqualTo("strat1");
        assertThat(claims.get(0).entityId()).isEqualTo("batt-main");
        assertThat(claims.get(0).delegated()).isTrue();
        assertThat(claims.get(0).commands()).containsExactly("setpoint_kw");
    }

    // ---- V-1 port compatibility + required inputs --------------------------

    @Test
    void incompatiblePortTypesAreRefused() {
        // bool (threshold result) → number (threshold input) is no widening.
        ObjectNode doc = flowShell();
        addNode(doc, "r1", "vp.entity.read", "1.0.0",
                Map.of("entity_id", "grid-meter-1", "channel", "power_kw"));
        addNode(doc, "t1n", "vp.logic.threshold", "1.1.0", Map.of("threshold", 3.0));
        addNode(doc, "t2n", "vp.logic.threshold", "1.1.0", Map.of("threshold", 5.0));
        addEdge(doc, "e1", "r1", "value", "t1n", "input");
        addEdge(doc, "e2", "t1n", "result", "t2n", "input");
        assertThat(errors(validate(doc))).containsExactly("V-1");
    }

    @Test
    void requiredInputMustBeConnectedAndOnlyOnce() {
        ObjectNode doc = flowShell();
        addNode(doc, "t1n", "vp.logic.threshold", "1.1.0", Map.of("threshold", 3.0));
        // required 'input' unconnected → V-1
        assertThat(errors(validate(doc))).contains("V-1");

        // two edges into ONE input → V-1
        ObjectNode doc2 = flowShell();
        addNode(doc2, "r1", "vp.entity.read", "1.0.0",
                Map.of("entity_id", "grid-meter-1", "channel", "power_kw"));
        addNode(doc2, "r2", "vp.entity.read", "1.0.0",
                Map.of("entity_id", "grid-meter-1", "channel", "power_kw"));
        addNode(doc2, "t1n", "vp.logic.threshold", "1.1.0", Map.of("threshold", 3.0));
        addEdge(doc2, "e1", "r1", "value", "t1n", "input");
        addEdge(doc2, "e2", "r2", "value", "t1n", "input");
        assertThat(errors(validate(doc2))).containsExactly("V-1");
    }

    @Test
    void entityControlNeedsAtLeastOneInput() {
        ObjectNode doc = flowShell();
        addNode(doc, "c1", "vp.entity.control", "1.0.0",
                Map.of("entity_id", "heatrod-cellar", "command", "on_off"));
        setClaims(doc, "c1", "heatrod-cellar", List.of("on_off"), false);
        assertThat(errors(validate(doc))).containsExactly("V-1");
    }

    @Test
    void numberWidensToTimeseriesAndPriceToTimeseries() {
        ObjectNode doc = flowShell();
        addNode(doc, "p1", "vp.price.dayahead", "1.0.0", Map.of());
        addNode(doc, "r1", "vp.entity.read", "1.0.0",
                Map.of("entity_id", "batt-main", "channel", "soc_pct"));
        addNode(doc, "s1", "vp.strategy.market", "1.0.0", Map.of("entity_id", "batt-main"));
        setClaims(doc, "s1", "batt-main", List.of("setpoint_kw"), true);
        addEdge(doc, "e1", "p1", "prices", "s1", "price_in");
        addEdge(doc, "e2", "r1", "value", "s1", "soc");
        addEdge(doc, "e3", "p1", "prices", "s1", "pv_forecast"); // price → timeseries
        assertThat(errors(validate(doc))).isEmpty();
    }

    @Test
    void booleanCombinatorJoinsTwoConditionsIntoOne() {
        // U3: the AND combinator lets a compound condition be wired (each of its
        // two bool inputs takes ONE edge, so V-1's one-per-input rule holds).
        ObjectNode doc = flowShell();
        addNode(doc, "r1", "vp.entity.read", "1.0.0",
                Map.of("entity_id", "grid-meter-1", "channel", "power_kw"));
        addNode(doc, "t1", "vp.logic.threshold", "1.1.0",
                Map.of("threshold", -2.0, "direction", "below"));
        addNode(doc, "z1", "vp.schedule.window", "1.0.0",
                Map.of("from", "11:00", "to", "15:00", "days", "alle"));
        addNode(doc, "and1", "vp.logic.and", "1.0.0", Map.of());
        addNode(doc, "c1", "vp.entity.control", "1.0.0",
                Map.of("entity_id", "wallbox-1", "command", "on_off", "ttl_s", 300.0));
        setClaims(doc, "c1", "wallbox-1", List.of("on_off"), false);
        addEdge(doc, "e1", "r1", "value", "t1", "input");
        addEdge(doc, "e2", "t1", "result", "and1", "a");
        addEdge(doc, "e3", "z1", "active", "and1", "b");
        addEdge(doc, "e4", "and1", "result", "c1", "value");
        assertThat(errors(validate(doc))).isEmpty();
    }

    @Test
    void priceConditionFeedsAThresholdAsANumber() {
        // U3: vp.price.current outputs a number, so it feeds a threshold
        // directly ("wenn Börsenpreis unter 10 ct").
        ObjectNode doc = flowShell();
        addNode(doc, "p1", "vp.price.current", "1.0.0", Map.of());
        addNode(doc, "t1", "vp.logic.threshold", "1.1.0",
                Map.of("threshold", 10.0, "direction", "below"));
        addNode(doc, "c1", "vp.entity.control", "1.0.0",
                Map.of("entity_id", "wallbox-1", "command", "on_off", "ttl_s", 600.0));
        setClaims(doc, "c1", "wallbox-1", List.of("on_off"), false);
        addEdge(doc, "e1", "p1", "value", "t1", "input");
        addEdge(doc, "e2", "t1", "result", "c1", "value");
        assertThat(errors(validate(doc))).isEmpty();
    }

    // ---- V-2 cycles --------------------------------------------------------

    @Test
    void cyclesAreRefusedUnlessDeclaredFeedback() {
        ObjectNode doc = flowShell();
        addNode(doc, "a", "vp.logic.threshold", "1.1.0", Map.of("threshold", 1.0));
        addNode(doc, "b", "vp.logic.gate", "1.0.0", Map.of());
        addEdge(doc, "e1", "a", "result", "b", "wenn");
        // gate has no numeric output; wire an artificial back-edge b→a to form
        // the cycle (port type errors accompany, but V-2 must fire).
        addEdge(doc, "e2", "b", "dann", "a", "input");
        assertThat(errors(validate(doc))).contains("V-2");

        // The same edge declared feedback: no V-2 anymore.
        ObjectNode feedback = flowShell();
        addNode(feedback, "a", "vp.logic.threshold", "1.1.0", Map.of("threshold", 1.0));
        addNode(feedback, "b", "vp.logic.gate", "1.0.0", Map.of());
        addEdge(feedback, "e1", "a", "result", "b", "wenn");
        ObjectNode back = addEdge(feedback, "e2", "b", "dann", "a", "input");
        back.put("feedback", true);
        assertThat(errors(validate(feedback))).doesNotContain("V-2");
    }

    // ---- V-3 ids/references ------------------------------------------------

    @Test
    void duplicateAndDanglingIdsAreRefused() {
        ObjectNode doc = flowShell();
        addNode(doc, "n1", "vp.price.dayahead", "1.0.0", Map.of());
        addNode(doc, "n1", "vp.price.dayahead", "1.0.0", Map.of());
        addEdge(doc, "e1", "ghost", "prices", "n1", "nope");
        List<String> rules = errors(validate(doc));
        assertThat(rules).contains("V-3");
    }

    @Test
    void unknownPortOnKnownNodeIsRefused() {
        ObjectNode doc = flowShell();
        addNode(doc, "p1", "vp.price.dayahead", "1.0.0", Map.of());
        addNode(doc, "s1", "vp.strategy.market", "1.0.0", Map.of("entity_id", "batt-main"));
        setClaims(doc, "s1", "batt-main", List.of("setpoint_kw"), true);
        addEdge(doc, "e1", "p1", "tarife", "s1", "price_in");
        assertThat(errors(validate(doc))).contains("V-3");
    }

    // ---- V-4 catalog resolution -------------------------------------------

    @Test
    void unknownTypeAndUnsupportedVersionAreRefused() {
        ObjectNode doc = flowShell();
        addNode(doc, "x1", "vp.magic.wand", "1.0.0", Map.of());
        addNode(doc, "p1", "vp.price.dayahead", "9.0.0", Map.of());
        assertThat(errors(validate(doc))).containsExactlyInAnyOrder("V-4", "V-4");
    }

    @Test
    void parameterValidationCoversRequiredEnumAndBounds() {
        ObjectNode doc = flowShell();
        // missing required threshold
        addNode(doc, "t1n", "vp.logic.threshold", "1.1.0", Map.of());
        // enum garbage
        addNode(doc, "t2n", "vp.logic.threshold", "1.1.0",
                Map.of("threshold", 1.0, "direction", "sideways"));
        // number out of bounds
        addNode(doc, "c1", "vp.entity.control", "1.0.0",
                Map.of("entity_id", "heatrod-cellar", "command", "on_off", "ttl_s", 5.0));
        setClaims(doc, "c1", "heatrod-cellar", List.of("on_off"), false);
        List<String> rules = errors(validate(doc));
        assertThat(rules.stream().filter("V-4"::equals)).hasSize(3);
    }

    // ---- V-5 exclusive resources + claim derivation ------------------------

    @Test
    void twoClaimsOnOneEntityConflict() {
        ObjectNode doc = flowShell();
        addNode(doc, "s1", "vp.strategy.market", "1.0.0", Map.of("entity_id", "batt-main"));
        addNode(doc, "p1", "vp.price.dayahead", "1.0.0", Map.of());
        addEdge(doc, "e0", "p1", "prices", "s1", "price_in");
        setClaims(doc, "s1", "batt-main", List.of("setpoint_kw"), true);
        // a DIRECT control claim on the same entity (no plan feed) conflicts
        addNode(doc, "r1", "vp.entity.read", "1.0.0",
                Map.of("entity_id", "grid-meter-1", "channel", "power_kw"));
        addNode(doc, "t1n", "vp.logic.threshold", "1.1.0", Map.of("threshold", 0.0));
        addNode(doc, "c1", "vp.entity.control", "1.0.0",
                Map.of("entity_id", "batt-main", "command", "setpoint_kw"));
        addEdge(doc, "e1", "r1", "value", "t1n", "input");
        addEdge(doc, "e2", "t1n", "result", "c1", "value");
        setClaims(doc, "c1", "batt-main", List.of("setpoint_kw"), false);
        assertThat(errors(validate(doc))).contains("V-5");
    }

    @Test
    void handEditedClaimsThatDisagreeWithDerivationAreRefused() {
        JsonNode base = pilotFlow("batt-main");
        ObjectNode doc = base.deepCopy();
        // drop the strategy's claim - the derivation disagrees now
        ((ObjectNode) doc.path("nodes").get(3)).remove("claims");
        assertThat(errors(validator.validate(doc, FIXTURE_ENTITIES, List.of())))
                .contains("V-5");
    }

    @Test
    void foreignActiveFlowClaimConflicts() {
        JsonNode doc = pilotFlow("batt-main");
        List<FlowValidationFinding> findings = validator.validate(doc, FIXTURE_ENTITIES,
                List.of(new ForeignClaim("batt-main", UUID.randomUUID(), "Anderer Flow")));
        assertThat(errors(findings)).contains("V-5");
        assertThat(findings.stream().filter(f -> "V-5".equals(f.rule())).findFirst().get()
                .message()).contains("Anderer Flow");
    }

    // ---- V-6 capability match ---------------------------------------------

    @Test
    void unknownEntityAndUnsupportedCommandAndChannelAreRefused() {
        ObjectNode doc = flowShell();
        addNode(doc, "p1", "vp.price.dayahead", "1.0.0", Map.of());
        addNode(doc, "s1", "vp.strategy.market", "1.0.0", Map.of("entity_id", "nirvana"));
        addEdge(doc, "e0", "p1", "prices", "s1", "price_in");
        setClaims(doc, "s1", "nirvana", List.of("setpoint_kw"), true);
        // grid meter has no actuate at all → command unsupported
        addNode(doc, "r1", "vp.entity.read", "1.0.0",
                Map.of("entity_id", "batt-main", "channel", "geheimkanal"));
        List<String> rules = errors(validate(doc));
        assertThat(rules.stream().filter("V-6"::equals)).hasSize(2);
    }

    @Test
    void emptyRegistryGetsTheBootstrapHint() {
        JsonNode doc = pilotFlow("batt-main");
        List<FlowValidationFinding> findings = validator.validate(doc, Map.of(), List.of());
        assertThat(findings.stream().anyMatch(f -> f.message().contains("Bootstrap"))).isTrue();
    }

    // ---- V-7 trigger sanity ------------------------------------------------

    @Test
    void triggerBoundsAndSourcesAreChecked() {
        ObjectNode doc = flowShell();
        addNode(doc, "p1", "vp.price.dayahead", "1.0.0", Map.of());
        ArrayNode triggers = (ArrayNode) doc.path("triggers");
        triggers.removeAll();
        ObjectNode interval = triggers.addObject();
        interval.put("id", "t1");
        interval.put("kind", "interval");
        interval.put("every_s", 0);
        ObjectNode change = triggers.addObject();
        change.put("id", "t2");
        change.put("kind", "value-change");
        ObjectNode source = change.putObject("source");
        source.put("node", "p1");
        source.put("port", "nope");
        List<String> rules = errors(validate(doc));
        assertThat(rules.stream().filter("V-7"::equals)).hasSize(2);
    }

    // ---- V-8 runtime whitelist --------------------------------------------

    @Test
    void cloudFlowMayNotUseEdgeOnlyNodes() {
        ObjectNode doc = flowShell();
        doc.put("runtime", "cloud");
        doc.remove("site_id");
        addNode(doc, "r1", "vp.entity.read", "1.0.0",
                Map.of("entity_id", "grid-meter-1", "channel", "power_kw"));
        assertThat(errors(validate(doc))).contains("V-8");
    }

    // ---- Portal v3 M5: the sandboxed code node (D-16), mirrored in TS -------

    @Test
    void codeNodeFixtureValidatesCleanAndItsSourceIsLengthCapped() throws IOException {
        assertThat(errors(validate(fixture("flow-graph.valid.function-node.json")))).isEmpty();

        ObjectNode empty = flowShell();
        addNode(empty, "code1", "vp.logic.function", "1.0.0", Map.of("code", "   "));
        assertThat(errors(validate(empty))).contains("V-4");

        ObjectNode tooLong = flowShell();
        addNode(tooLong, "code1", "vp.logic.function", "1.0.0",
                Map.of("code", "x".repeat(4001)));
        assertThat(errors(validate(tooLong))).contains("V-4");

        // (a bare code node without its connected input is a normal V-1 - the
        // fixture above is the wired, clean case.)
    }

    @Test
    void codeNodeIsEdgeOnly() {
        // D-16: customer code runs ONLY on the customer's own device - the cloud
        // never executes it, so a cloud flow may not carry the node at all.
        ObjectNode doc = flowShell();
        doc.put("runtime", "cloud");
        doc.remove("site_id");
        addNode(doc, "code1", "vp.logic.function", "1.0.0", Map.of("code", "return wert;"));
        assertThat(errors(validate(doc))).contains("V-8");
    }

    // ---- MB-M1 vp.modbus.read (mirrored in src/flows/validate.test.ts) -----

    @Test
    void modbusReadFixtureValidatesClean() throws IOException {
        List<FlowValidationFinding> findings = validate(fixture(
                "flow-graph.valid.modbus-read.json"));
        assertThat(errors(findings)).isEmpty();
    }

    private ObjectNode modbusFlow(Map<String, Object> params) {
        ObjectNode doc = flowShell();
        addNode(doc, "mb1", "vp.modbus.read", "1.0.0", params);
        return doc;
    }

    @Test
    void modbusHostKindIsValidated() {
        assertThat(errors(validate(modbusFlow(
                Map.of("host", "192.168.40.17", "address", 100))))).isEmpty();
        assertThat(errors(validate(modbusFlow(
                Map.of("host", "zaehler.keller.local", "address", 0))))).isEmpty();
        assertThat(errors(validate(modbusFlow(
                Map.of("host", "kein host!", "address", 0))))).containsExactly("V-4");
        assertThat(errors(validate(modbusFlow(
                Map.of("host", "-bad.example", "address", 0))))).containsExactly("V-4");
        assertThat(errors(validate(modbusFlow(Map.of("address", 0))))).containsExactly("V-4");
    }

    @Test
    void modbusMappingIsBothOrNeither() {
        assertThat(errors(validate(modbusFlow(Map.of(
                "host", "192.168.40.17", "address", 100,
                "channel", "leistung_kw"))))).containsExactly("V-4");
        assertThat(errors(validate(modbusFlow(Map.of(
                "host", "192.168.40.17", "address", 100,
                "entity_id", "modbus-meter-1"))))).containsExactly("V-4");
        assertThat(errors(validate(modbusFlow(Map.of(
                "host", "192.168.40.17", "address", 100,
                "entity_id", "modbus-meter-1", "channel", "leistung_kw"))))).isEmpty();
    }

    @Test
    void modbusMappingOntoComposedEntityIsRefused() {
        // Guard integrity: the battery's measured channels feed the guard
        // chain (SoC/PV, D-8) - a customer flow must never inject them.
        List<FlowValidationFinding> findings = validate(modbusFlow(Map.of(
                "host", "192.168.40.17", "address", 100,
                "entity_id", "batt-main", "channel", "soc_pct")));
        assertThat(errors(findings)).containsExactly("V-6");
        assertThat(findings.get(0).message()).contains("Stammdaten");
    }

    @Test
    void modbusMappingChecksChannelAndEntity() {
        assertThat(errors(validate(modbusFlow(Map.of(
                "host", "192.168.40.17", "address", 100,
                "entity_id", "modbus-meter-1", "channel", "geheimkanal")))))
                .containsExactly("V-6");
        assertThat(errors(validate(modbusFlow(Map.of(
                "host", "192.168.40.17", "address", 100,
                "entity_id", "nirvana", "channel", "leistung_kw")))))
                .containsExactly("V-6");
    }

    @Test
    void duplicateModbusMappingIsRefused() {
        ObjectNode doc = modbusFlow(Map.of(
                "host", "192.168.40.17", "address", 100,
                "entity_id", "modbus-meter-1", "channel", "leistung_kw"));
        addNode(doc, "mb2", "vp.modbus.read", "1.0.0", Map.of(
                "host", "other.local", "address", 7,
                "entity_id", "modbus-meter-1", "channel", "leistung_kw"));
        List<FlowValidationFinding> findings = validate(doc);
        assertThat(errors(findings)).containsExactly("V-5");
        assertThat(findings.get(0).nodeIds()).containsExactly("mb1", "mb2");
    }

    // ---- helpers (mirrored in src/flows/validate.test.ts) ------------------

    static ObjectNode flowShell() {
        ObjectNode doc = MAPPER.createObjectNode();
        doc.put("schema_version", "1.0");
        doc.put("flow_id", "b2a4d6c8-1032-4f5e-9a7b-8c9d0e1f2a3b");
        doc.put("flow_version", 1);
        doc.put("name", "Testflow");
        doc.put("runtime", "edge");
        doc.put("site_id", "00000000-0000-0000-0000-000000000002");
        doc.putArray("nodes");
        doc.putArray("edges");
        ObjectNode trigger = doc.putArray("triggers").addObject();
        trigger.put("id", "trig1");
        trigger.put("kind", "slot-boundary");
        return doc;
    }

    static ObjectNode addNode(ObjectNode doc, String id, String type, String version,
            Map<String, Object> parameters) {
        ObjectNode node = ((ArrayNode) doc.path("nodes")).addObject();
        node.put("id", id);
        node.put("type", type);
        node.put("type_version", version);
        ObjectNode params = node.putObject("parameters");
        parameters.forEach((k, v) -> {
            if (v instanceof Number n) {
                params.put(k, n.doubleValue());
            } else {
                params.put(k, String.valueOf(v));
            }
        });
        return node;
    }

    static ObjectNode addEdge(ObjectNode doc, String id, String fromNode, String fromPort,
            String toNode, String toPort) {
        ObjectNode edge = ((ArrayNode) doc.path("edges")).addObject();
        edge.put("id", id);
        ObjectNode from = edge.putObject("from");
        from.put("node", fromNode);
        from.put("port", fromPort);
        ObjectNode to = edge.putObject("to");
        to.put("node", toNode);
        to.put("port", toPort);
        return edge;
    }

    static void setClaims(ObjectNode doc, String nodeId, String entityId, List<String> commands,
            boolean delegated) {
        for (JsonNode node : doc.path("nodes")) {
            if (node.path("id").asText().equals(nodeId)) {
                ObjectNode claim = ((ObjectNode) node).putArray("claims").addObject();
                claim.put("entity_id", entityId);
                ArrayNode cmds = claim.putArray("commands");
                commands.forEach(cmds::add);
                if (delegated) {
                    claim.put("delegated", true);
                }
            }
        }
    }

    /**
     * The PILOT flow (acceptance chain): Preis + PV-Prognose + Speicher lesen
     * → Marktoptimierung → Speicher steuern. The control node derives NO own
     * claim (plan-fed by the delegated strategy) - kept in lockstep with the
     * portal's pilot template (src/flows/templates.ts).
     */
    static ObjectNode pilotFlow(String batteryEntity) {
        ObjectNode doc = flowShell();
        addNode(doc, "price1", "vp.price.dayahead", "1.0.0", Map.of());
        addNode(doc, "pv1", "vp.forecast.pv", "1.0.0", Map.of());
        addNode(doc, "soc1", "vp.entity.read", "1.0.0",
                Map.of("entity_id", batteryEntity, "channel", "soc_pct"));
        addNode(doc, "strat1", "vp.strategy.market", "1.0.0",
                Map.of("entity_id", batteryEntity, "speicherschonung", "ausgewogen"));
        addNode(doc, "ctl1", "vp.entity.control", "1.0.0",
                Map.of("entity_id", batteryEntity, "command", "setpoint_kw", "ttl_s", 180.0));
        setClaims(doc, "strat1", batteryEntity, List.of("setpoint_kw"), true);
        addEdge(doc, "e1", "price1", "prices", "strat1", "price_in");
        addEdge(doc, "e2", "pv1", "forecast", "strat1", "pv_forecast");
        addEdge(doc, "e3", "soc1", "value", "strat1", "soc");
        addEdge(doc, "e4", "strat1", "wunsch", "ctl1", "plan");
        return doc;
    }
}
