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

    private static final List<String> CANONICAL_ROLE_ORDER =
            List.of(ROLE_PV, ROLE_STORAGE, ROLE_CONSUMER, ROLE_GRID);

    private static final String SOC_CHANNEL = "soc_pct";

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
     * Default role for a measure channel + entity category (overridable). See
     * topology-read-model.md; "measure-only" aliases "meter".
     */
    public static String defaultRole(String category, String channel) {
        if (channel == null) {
            return "";
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
        String dir = active ? (ROLE_CONSUMER.equals(role) ? "out" : "in") : null;
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

    private static double round3(double v) {
        return Math.round(v * 1000.0) / 1000.0;
    }
}
