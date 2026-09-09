package com.voltpilot.api.topology;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * The Java twin's contract: {@link TopologyDeriver#derive} matches the committed
 * expected topology for every case in the ONE shared vector file
 * (docs/contracts/v2/topology-vectors.json), the same file the Go twin
 * (edge-app/core/internal/topology/topology_test.go) and the TS twin
 * (frontend/portal/src/topology.test.ts) run - so all three produce the same
 * node set. Pure; always runs (no Docker).
 */
class TopologyDeriverTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    // Working dir is services/api; the repo root is two levels up.
    private static final Path VECTORS =
            Path.of("..", "..", "docs", "contracts", "v2", "topology-vectors.json");

    @TestFactory
    List<DynamicTest> deriveMatchesSharedVectors() throws Exception {
        JsonNode root = MAPPER.readTree(Files.readString(VECTORS));
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : root.path("cases")) {
            String name = c.path("name").asText();
            TopologyDeriver.Input input =
                    MAPPER.treeToValue(c.path("input"), TopologyDeriver.Input.class);
            TopologyDeriver.Topology expected =
                    MAPPER.treeToValue(c.path("expected"), TopologyDeriver.Topology.class);
            tests.add(DynamicTest.dynamicTest(name,
                    () -> assertThat(TopologyDeriver.derive(input)).isEqualTo(expected)));
        }
        assertThat(tests).isNotEmpty();
        return tests;
    }

    /**
     * The MAPPING itself, pinned across the three twins. The derive cases cannot
     * cover it - they carry roles that are ALREADY resolved - and it is exactly
     * where the copies drift: a charge point is category "consumer", so only
     * the TYPE keeps it out of the house node (Cockpit Phase 1 / C2).
     */
    @TestFactory
    List<DynamicTest> defaultRoleMatchesSharedVectors() throws Exception {
        JsonNode root = MAPPER.readTree(Files.readString(VECTORS));
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : root.path("default_role_cases")) {
            String name = c.path("name").asText();
            String type = c.path("type").asText("");
            String category = c.path("category").asText("");
            String channel = c.path("channel").asText("");
            String connection = c.path("connection").asText("");
            String expected = c.path("expected").asText("");
            tests.add(DynamicTest.dynamicTest(name, () -> assertThat(
                    TopologyDeriver.defaultRole(type, category, channel, connection))
                            .isEqualTo(expected)));
        }
        assertThat(tests).isNotEmpty();
        return tests;
    }

    /**
     * The charging roles sit at the END of the canonical order, so every case
     * authored before them emits exactly the nodes it always did.
     */
    @Test
    void chargingRolesAreAppendedSoOlderVectorsStayByteIdentical() {
        // Deliberately shuffled input: the output follows the canonical order.
        TopologyDeriver.Input in = new TopologyDeriver.Input(List.of(
                entity("C", "charging-own"), entity("G", "grid"), entity("W", "charging"),
                entity("H", "consumer"), entity("S", "storage"), entity("P", "pv")));
        assertThat(TopologyDeriver.derive(in).nodes().stream().map(TopologyDeriver.FlowNode::role))
                .containsExactly("pv", "storage", "consumer", "grid", "charging", "charging-own");
    }

    /** Laden IS consumption: both charging roles flow OUT of the hub. */
    @Test
    void bothChargingRolesFlowOutOfTheHub() {
        TopologyDeriver.Input in = new TopologyDeriver.Input(
                List.of(entity("W", "charging"), entity("C", "charging-own")));
        assertThat(TopologyDeriver.derive(in).nodes())
                .allMatch(n -> "out".equals(n.direction()) && n.flowActive());
    }

    // ---- P6 Speiser-Bindung -------------------------------------------------

    /**
     * Der Kern des Pakets: die gebundene Batterie liefert Ladestand, Grenzen und
     * Freigaben, der Wechselrichter die LEISTUNG - und {@code soc_source} sagt,
     * wessen Prozentzahl dort steht. Ohne diesen Satz stünde eine Zahl an der
     * Speicher-Kachel, für die niemand geradesteht.
     */
    @Test
    void derSpeicherKnotenNenntDieQuelleSeinesLadestands() {
        TopologyDeriver.Topology topo = TopologyDeriver.derive(new TopologyDeriver.Input(List.of(
                new TopologyDeriver.EntityInput("A", "battery-hybrid", "Deye SUN-30K", "storage",
                        "ok", List.of(cap("battery_power_kw", "storage", true, -4.2))),
                new TopologyDeriver.EntityInput("B", "user-defined-battery", "DIY-Speicher",
                        "storage", "ok", List.of(
                                cap("soc_pct", "storage", true, 7.4),
                                cap("charge_limit_a", "storage", true, 22.0),
                                cap("discharge_allowed", "storage", true, 0.0))))));
        TopologyDeriver.FlowNode storage = node(topo, "storage");
        assertThat(storage.socPct()).isEqualTo(7.4);
        assertThat(storage.socSource())
                .isEqualTo(new TopologyDeriver.NodeSource("B", "DIY-Speicher"));
        // Die LEISTUNG bleibt beim Wechselrichter - die Batterie ist kein
        // Fluss-Mitglied, sonst zählten dieselben Kilowatt zweimal.
        assertThat(storage.members()).extracting(TopologyDeriver.FlowMember::entityId)
                .containsExactly("A");
        assertThat(storage.valueKw()).isEqualTo(4.2);
    }

    /**
     * ⚠ Die Grenz-Kanäle sind Speicher-EIGENSCHAFTEN, nie Fluss-Mitglieder: 22 A
     * in {@code value_kw} zu summieren machte aus der Speichen-Breite eine Zahl
     * mit zwei Bedeutungen - und aus einem ruhenden Speicher einen laufenden.
     */
    @Test
    void grenzenSindKeineKilowatt() {
        TopologyDeriver.Topology topo = TopologyDeriver.derive(new TopologyDeriver.Input(List.of(
                new TopologyDeriver.EntityInput("B", "user-defined-battery", "DIY", "storage", "ok",
                        List.of(cap("soc_pct", "storage", true, 50.0),
                                cap("charge_limit_a", "storage", true, 270.0))))));
        TopologyDeriver.FlowNode storage = node(topo, "storage");
        assertThat(storage.valueKw()).isNull();
        assertThat(storage.flowActive()).isFalse();
        assertThat(storage.members()).isEmpty();
        assertThat(storage.limits().chargeLimitA()).isEqualTo(270.0);
    }

    /**
     * Eine Freigabe reist als ZAHL (der Telemetrie-Vertrag kennt nur Zahlen):
     * 0 heißt „nein", alles andere „ja". Ein ABWESENDER Kanal heißt weder das
     * eine noch das andere - er fehlt, und „erlaubt" hinzuschreiben wäre eine
     * Freigabe, die niemand gegeben hat.
     */
    @Test
    void eineFehlendeFreigabeIstKeineErlaubnis() {
        TopologyDeriver.Topology topo = TopologyDeriver.derive(new TopologyDeriver.Input(List.of(
                new TopologyDeriver.EntityInput("B", "user-defined-battery", "DIY", "storage", "ok",
                        List.of(cap("charge_allowed", "storage", true, 1.0),
                                cap("discharge_allowed", "storage", true, 0.0))))));
        TopologyDeriver.NodeLimits l = node(topo, "storage").limits();
        assertThat(l.chargeAllowed()).isTrue();
        assertThat(l.dischargeAllowed()).isFalse();
        assertThat(l.chargeLimitA()).isNull();
        assertThat(l.dischargeLimitA()).isNull();
    }

    /**
     * Zwei BMS, deren Kappen sich zu einem Block mischen, beschrieben eine
     * Hülle, die keines von beiden hat: die Grenzen kommen deshalb aus GENAU
     * EINER Entität - der maßgeblichen.
     */
    @Test
    void dieGrenzenKommenAusEinerEinzigenEntitaet() {
        TopologyDeriver.Topology topo = TopologyDeriver.derive(new TopologyDeriver.Input(List.of(
                new TopologyDeriver.EntityInput("X", "user-defined-battery", "Erste", "storage",
                        "ok", List.of(cap("charge_limit_a", "storage", false, 10.0))),
                new TopologyDeriver.EntityInput("Y", "user-defined-battery", "Zweite", "storage",
                        "ok", List.of(cap("charge_limit_a", "storage", true, 40.0),
                                cap("discharge_limit_a", "storage", true, 74.0))))));
        TopologyDeriver.NodeLimits l = node(topo, "storage").limits();
        assertThat(l.source().entityId()).isEqualTo("Y");
        assertThat(l.chargeLimitA()).isEqualTo(40.0);
        assertThat(l.dischargeLimitA()).isEqualTo(74.0);
    }

    /**
     * Ohne Bindung geschieht NICHTS (Captain-Entscheid E6): eine selbst
     * angebundene Batterie ist Kategorie {@code storage}, ihre Kanäle liefen
     * also ohne diese Regel von selbst in den Speicher-Knoten - eine
     * automatische Bindung per Kanalname.
     */
    @Test
    void ohneAusdrueckchlicheBindungBleibtDieBatterieAusDerBilanz() {
        assertThat(TopologyDeriver.defaultRole("user-defined-battery", "storage", "soc_pct", ""))
                .isEmpty();
        assertThat(TopologyDeriver.defaultRole("user-defined-battery", "storage", "power_kw", ""))
                .isEmpty();
        assertThat(TopologyDeriver.isSelfBuiltType("user-defined-battery")).isTrue();
    }

    private static TopologyDeriver.CapabilityInput cap(String channel, String role, boolean primary,
            Double value) {
        return new TopologyDeriver.CapabilityInput(channel, role, primary, value);
    }

    private static TopologyDeriver.FlowNode node(TopologyDeriver.Topology topo, String role) {
        return topo.nodes().stream().filter(n -> role.equals(n.role())).findFirst().orElseThrow();
    }

    private static TopologyDeriver.EntityInput entity(String id, String role) {
        return new TopologyDeriver.EntityInput(id, id, id, "consumer", "ok",
                List.of(new TopologyDeriver.CapabilityInput("power_kw", role, true, 1.0)));
    }
}
