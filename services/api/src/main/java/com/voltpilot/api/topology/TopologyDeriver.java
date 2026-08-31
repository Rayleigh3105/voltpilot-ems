package com.voltpilot.api.topology;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The Java twin of the shared topology derivation (contract
 * docs/contracts/v2/topology-read-model.md): turns {resolved capabilities +
 * live values} into the role-grouped hub topology. Pinned to the SAME shared
 * vectors (docs/contracts/v2/topology-vectors.json) as the Go copy
 * (edge-app/core/internal/topology) and the TS copy
 * (frontend/portal/src/topology.ts) - the three produce the same node set. Pure
 * + stateless; the {@link TopologyService} resolves default/override roles and
 * feeds this the {@link Input}.
 */
public final class TopologyDeriver {

    /** The topology read-model schema version. */
    public static final String SCHEMA_VERSION = "1.0";

    /** Below this magnitude a spoke is idle (the live.ts 0.05 kW deadband). */
    public static final double DEADBAND_KW = 0.05;

    public static final String ROLE_PV = "pv";
    public static final String ROLE_STORAGE = "storage";
    public static final String ROLE_CONSUMER = "consumer";
    public static final String ROLE_GRID = "grid";
    /**
     * Charge points BEHIND the house connection: their kilowatts are already
     * inside the house-load measurement, so the node is a BRANCH off the
     * consumer node and the house sum stays "everything behind the connection
     * point" (concept vp-verbraucher-cockpit-k1 §6, E3).
     */
    public static final String ROLE_CHARGING = "charging";
    /**
     * Charge points on their OWN grid connection / meter: NOT inside the house
     * measurement, so the node hangs at the hub NEXT TO the house and the house
     * never contains them. Two roles, not one node with two attachments - the
     * two sums are measured at two DIFFERENT connection points, and adding them
     * would be one number with two meanings.
     */
    public static final String ROLE_CHARGING_OWN = "charging-own";

    /**
     * The deterministic node emission order. The charging roles are APPENDED on
     * purpose: every vector authored before them stays byte-identical, because
     * a site without a charge point emits neither node.
     */
    private static final List<String> CANONICAL_ROLE_ORDER = List.of(ROLE_PV, ROLE_STORAGE,
            ROLE_CONSUMER, ROLE_GRID, ROLE_CHARGING, ROLE_CHARGING_OWN);

    private static final String SOC_CHANNEL = "soc_pct";

    /** The entity TYPES that are charge points. */
    public static final String TYPE_EV_CHARGER = "ev-charger";
    public static final String TYPE_WALLBOX = "wallbox";

    /**
     * The entity TYPES a customer DEFINED THEMSELVES in the portal
     * (Einheitsmodell Stufe 3/4): a free Modbus sensor and - once the guided
     * switch test passed - a free Modbus switching device. Their measure
     * channels are named by the CUSTOMER, not by a driver we wrote.
     */
    public static final String TYPE_MODBUS_GENERIC = "modbus-generic";
    public static final String TYPE_MODBUS_LOAD = "modbus-load";

    /**
     * WHERE a charge point hangs (Cockpit Phase 1 / C1). {@code null}/blank =
     * the portal never said - read as haus, the safe direction: the house
     * measurement is assumed to contain it, exactly what the box's budget law
     * already assumes.
     */
    public static final String CONNECTION_HAUS = "haus";
    public static final String CONNECTION_EIGEN = "eigen";

    private TopologyDeriver() {}

    // ---- shared I/O shapes ---------------------------------------------------

    /** One resolved capability: channel, assigned role ("" = skip), maßgeblich, value. */
    public record CapabilityInput(String channel, String role, boolean primary, Double value) {}

    /** One entity with its resolved capabilities. */
    public record EntityInput(String id, String type, String label, String category, String health,
            List<CapabilityInput> capabilities) {}

    /** The whole site as an entity graph. */
    public record Input(List<EntityInput> entities) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record FlowMember(@JsonProperty("entity_id") String entityId, String label,
            boolean primary, @JsonProperty("value_kw") Double valueKw) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record FlowNode(String role, @JsonProperty("value_kw") Double valueKw,
            @JsonProperty("soc_pct") Double socPct, @JsonProperty("flow_active") boolean flowActive,
            String direction, List<FlowMember> members) {}

    public record Topology(@JsonProperty("schema_version") String schemaVersion,
            List<FlowNode> nodes) {}

    // ---- default role mapping (shared) --------------------------------------

    /**
     * Is this entity TYPE a charge point? The distinction cannot be made on the
     * category: ev-charger and wallbox are both category "consumer" in the type
     * catalog, exactly like a heating rod.
     */
    public static boolean isChargingType(String entityType) {
        return TYPE_EV_CHARGER.equals(entityType) || TYPE_WALLBOX.equals(entityType);
    }

    /**
     * Is this entity TYPE self-built by the customer? Like the charge point
     * above, the category cannot answer it: a modbus-generic is category
     * "meter" (it declares no actuate capability) and a modbus-load is
     * "consumer" - exactly like a grid meter and a heating rod.
     */
    public static boolean isSelfBuiltType(String entityType) {
        return TYPE_MODBUS_GENERIC.equals(entityType) || TYPE_MODBUS_LOAD.equals(entityType);
    }

    /**
     * Default role for an entity TYPE + category + measure channel +
     * charge-point connection (overridable). See topology-read-model.md;
     * "measure-only" aliases "meter"; connection is only consulted for charge
     * points (blank = haus).
     *
     * <p><b>⚠ The TYPE is checked FIRST, and that is the whole point of the
     * parameter:</b> a charge point is category "consumer", so without it its
     * power would sum into the house node it is already measured inside, and
     * its soc_pct would fall through to the storage rule below and start
     * filling in the HOUSE battery's state of charge (the reason the edge
     * deliberately never publishes it). Both are wrong about a customer's
     * plant, so they are answered here rather than left to the restraint of
     * every producer.
     */
    public static String defaultRole(String entityType, String category, String channel,
            String connection) {
        if (channel == null) {
            return "";
        }
        // ⚠ A SELF-BUILT device NEVER gets an energy-flow role - not even for a
        // channel it happens to have named "power_kw". Two independent reasons,
        // and the first one is a promise the platform already printed:
        //
        //  1. Bilanz-Ehrlichkeit (Einheitsmodell Stufe 3): "ein Selbstbau-Sensor
        //     ist ein Topologie-Knoten mit eigenen Messwerten und geht NICHT in
        //     die Energiebilanz ein" - the assistant says exactly that while the
        //     customer defines the device.
        //  2. Without this branch the CATEGORY decided, and a modbus-generic is
        //     "meter" - so a channel merely NAMED power_kw fell into the meter
        //     rule and the customer's cistern/heat-pump sensor was rendered AS
        //     THE GRID CONNECTION POINT (scout vp-portal-box-spiegel-s2, L5).
        //     The grid node may only ever be built from a real grid meter. A
        //     modbus-load is "consumer" and would double-count into the house
        //     node it is already measured inside - the identical argument that
        //     moved charge points out of the consumer role.
        //
        // The channels are not lost: they keep their own per-entity
        // measurements. Only the energy BALANCE stays untouched.
        //
        // ⚠ This is the DEFAULT; an explicit stored assignment still wins over
        // it (Befund L4) - deliberately: the override exists for exactly "the
        // platform's default is wrong for MY plant". L5 was about the default
        // being a falsehood on its own.
        if (isSelfBuiltType(entityType)) {
            return "";
        }
        if (isChargingType(entityType)) {
            switch (channel) {
                case "power_kw":
                    return CONNECTION_EIGEN.equals(connection) ? ROLE_CHARGING_OWN : ROLE_CHARGING;
                case SOC_CHANNEL:
                    // The CAR's state of charge, not the station's and not the
                    // house battery's. Never a flow member, never another
                    // node's SoC.
                    return "";
                default:
                    return "";
            }
        }
        switch (channel) {
            case "pv_power_kw":
                return ROLE_PV;
            case "battery_power_kw":
            case SOC_CHANNEL:
                return ROLE_STORAGE;
            case "power_kw":
                if (category == null) {
                    return "";
                }
                switch (category) {
                    case "storage":
                        return ROLE_STORAGE;
                    case "producer":
                        return ROLE_PV;
                    case "consumer":
                        return ROLE_CONSUMER;
                    case "meter":
                    case "measure-only":
                        return ROLE_GRID;
                    default:
                        return "";
                }
            default:
                return "";
        }
    }

    // ---- derivation ----------------------------------------------------------

    private record RoleCap(EntityInput entity, CapabilityInput cap) {}

    /**
     * Derive the hub topology: roles in canonical order, members in input order,
     * kW rounded to 3 decimals, an absent value never coerced to 0.
     */
    public static Topology derive(Input input) {
        Map<String, List<RoleCap>> buckets = new LinkedHashMap<>();
        for (EntityInput e : input.entities()) {
            for (CapabilityInput c : e.capabilities()) {
                if (c.role() == null || c.role().isEmpty()) {
                    continue;
                }
                buckets.computeIfAbsent(c.role(), k -> new ArrayList<>()).add(new RoleCap(e, c));
            }
        }
        List<FlowNode> nodes = new ArrayList<>();
        for (String role : CANONICAL_ROLE_ORDER) {
            List<RoleCap> caps = buckets.get(role);
            if (caps == null) {
                continue;
            }
            nodes.add(switch (role) {
                case ROLE_GRID -> gridNode(role, caps);
                case ROLE_STORAGE -> storageNode(role, caps);
                default -> sumNode(role, caps);
            });
        }
        return new Topology(SCHEMA_VERSION, nodes);
    }

    private static FlowNode sumNode(String role, List<RoleCap> caps) {
        List<FlowMember> members = new ArrayList<>();
        double sum = 0;
        boolean hasValue = false;
        for (RoleCap rc : caps) {
            if (SOC_CHANNEL.equals(rc.cap().channel())) {
                continue;
            }
            members.add(member(rc));
            if (rc.cap().value() != null) {
                sum += rc.cap().value();
                hasValue = true;
            }
        }
        if (!hasValue) {
            return new FlowNode(role, null, null, false, null, members);
        }
        double mag = round3(Math.abs(sum));
        boolean active = mag > DEADBAND_KW;
        String dir = active ? (isConsuming(role) ? "out" : "in") : null;
        return new FlowNode(role, mag, null, active, dir, members);
    }

    private static FlowNode storageNode(String role, List<RoleCap> caps) {
        List<FlowMember> members = new ArrayList<>();
        double sum = 0;
        boolean hasValue = false;
        Double soc = null;
        boolean socPrimary = false;
        for (RoleCap rc : caps) {
            if (SOC_CHANNEL.equals(rc.cap().channel())) {
                if (rc.cap().value() == null) {
                    continue;
                }
                if (soc == null || (rc.cap().primary() && !socPrimary)) {
                    soc = round3(rc.cap().value());
                    socPrimary = rc.cap().primary();
                }
                continue;
            }
            members.add(member(rc));
            if (rc.cap().value() != null) {
                sum += rc.cap().value();
                hasValue = true;
            }
        }
        if (!hasValue) {
            return new FlowNode(role, null, soc, false, null, members);
        }
        double mag = round3(Math.abs(sum));
        boolean active = mag > DEADBAND_KW;
        // charge (+) -> hub->battery (out), discharge (-) -> battery->hub (in).
        String dir = active ? (sum > 0 ? "out" : "in") : null;
        return new FlowNode(role, mag, soc, active, dir, members);
    }

    private static FlowNode gridNode(String role, List<RoleCap> caps) {
        List<FlowMember> members = new ArrayList<>();
        int primaryIdx = -1;
        for (int i = 0; i < caps.size(); i++) {
            members.add(member(caps.get(i)));
            if (primaryIdx == -1 && caps.get(i).cap().primary()) {
                primaryIdx = i;
            }
        }
        if (primaryIdx == -1 && !caps.isEmpty()) {
            primaryIdx = 0;
        }
        if (primaryIdx == -1) {
            return new FlowNode(role, null, null, false, null, members);
        }
        Double v = caps.get(primaryIdx).cap().value();
        if (v == null) {
            return new FlowNode(role, null, null, false, null, members);
        }
        double mag = round3(Math.abs(v));
        boolean active = mag > DEADBAND_KW;
        // import (Bezug, +) -> in, export (-) -> out.
        String dir = active ? (v > 0 ? "in" : "out") : null;
        return new FlowNode(role, mag, null, active, dir, members);
    }

    private static FlowMember member(RoleCap rc) {
        Double v = rc.cap().value() == null ? null : round3(rc.cap().value());
        return new FlowMember(rc.entity().id(), rc.entity().label(), rc.cap().primary(), v);
    }

    /**
     * Does this summed role draw FROM the hub (direction "out")? The house and
     * both charging roles.
     */
    private static boolean isConsuming(String role) {
        return ROLE_CONSUMER.equals(role) || ROLE_CHARGING.equals(role)
                || ROLE_CHARGING_OWN.equals(role);
    }

    private static double round3(double v) {
        return Math.round(v * 1000.0) / 1000.0;
    }
}
