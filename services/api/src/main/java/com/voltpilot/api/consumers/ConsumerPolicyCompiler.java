package com.voltpilot.api.consumers;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.consumers.ConsumerRepository.ConsumerRow;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * The consumer-policy compiler's EDGE half (docs/verbrauchssteuerung.md §13.2,
 * contract decision D-19): derives from one ACTIVE policy at most ONE generated
 * flow-graph document carrying exactly ONE {@code vp.consumer.reactive} node
 * with exactly ONE entity claim - so the existing V-5 exclusivity holds and the
 * EXISTING flowc/flow-deployment machinery rolls it out (never a second deploy
 * path). The solver half lives in the optimizer's {@code consumer_inputs.py}
 * (Inkrement 2); the split is the D1 rule: a reactive requirement whose
 * condition tree is PURE CLOUD (only market signals) is fully handled by the
 * market plan and compiles to NO artifact; a tree with at least one LOCAL
 * signal (which the solver skips wholesale) compiles here, with its cloud
 * leaves expanded to precomputed UTC windows.
 *
 * <p>DETERMINISM is load-bearing (the golden-artifact rule): the same policy +
 * the same window answers produce a BYTE-IDENTICAL document - object field
 * order is fixed, the flow_id derives from the entity id, the flow version IS
 * the policy version. Nothing here reads a clock or randomness; `now` and the
 * window source are inputs.
 *
 * <p>The OVERRIDE rule (§13.2): {@code must_run} is stamped per requirement
 * from the validated {@code enforcement=must_run} - the ONLY source of the
 * D-5 override on the edge. The catalog node {@code vp.entity.control} never
 * carries an override switch (refused by the validator twins + flowc).
 */
@Component
public class ConsumerPolicyCompiler {

    /** Desired TTL of the reactive wish - short and continuously renewed. */
    static final int TTL_S = 45;
    /** Renewal cadence = the generated interval trigger (must be <= TTL/2). */
    static final int RENEW_S = 15;
    /** Off-delay debounce on ending (§5.1 Ausschaltverzögerung). */
    static final int OFF_DELAY_S = 15;
    /** Freshness default for local signals whose policy leaf omits max_age_s. */
    static final int DEFAULT_MAX_AGE_S = 120;
    /** Forward horizon the cloud precomputes price windows for. */
    static final Duration WINDOW_HORIZON = Duration.ofHours(36);

    /** One precomputed UTC window where a cloud condition holds. */
    public record Window(Instant from, Instant to) {}

    /**
     * The price-window oracle: concrete UTC windows in {@code [from, to)} where
     * {@code <signal> <op> <value>} holds. Injected so the compiler stays pure
     * (production: {@link PriceWindowSource}; tests: fixtures).
     */
    public interface WindowSource {
        List<Window> windows(UUID siteId, String signal, String op, double value,
                Instant from, Instant to);
    }

    private final ConsumerSignalCatalog signals;
    private final ObjectMapper mapper;

    public ConsumerPolicyCompiler(ConsumerSignalCatalog signals, ObjectMapper mapper) {
        this.signals = signals;
        this.mapper = mapper;
    }

    /** The deterministic flow id of a consumer's ONE generated flow. */
    public static UUID generatedFlowId(UUID entityId) {
        return UUID.nameUUIDFromBytes(
                ("vp-consumer-policy:" + entityId).getBytes(StandardCharsets.UTF_8));
    }

    /** Does this policy need an edge artifact at all (any reactive-with-local part)? */
    public boolean needsArtifact(JsonNode policyDoc) {
        for (JsonNode req : policyDoc.path("requirements")) {
            if (isEdgeReactive(req)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Compile the generated flow-graph document, or {@code null} when the
     * policy has no reactive requirement with a local signal (the market plan
     * covers everything else). The caller owns validation - the policy passed
     * the {@link ConsumerPolicyValidator} before it could be activated.
     */
    public ObjectNode compile(JsonNode policyDoc, ConsumerRow profile, UUID siteId, UUID tenantId,
            UUID policyId, int policyVersion, WindowSource windows, Instant now) {
        List<JsonNode> reactive = new java.util.ArrayList<>();
        for (JsonNode req : policyDoc.path("requirements")) {
            if (isEdgeReactive(req)) {
                reactive.add(req);
            }
        }
        if (reactive.isEmpty()) {
            return null;
        }

        String command = commandFor(profile, reactive);
        UUID flowId = generatedFlowId(profile.entityId());

        ObjectNode doc = mapper.createObjectNode();
        doc.put("schema_version", "1.0");
        doc.put("flow_id", flowId.toString());
        doc.put("flow_version", policyVersion);
        doc.put("name", "Verbraucherregel: " + displayName(profile));
        doc.put("runtime", "edge");
        doc.put("site_id", siteId.toString());
        doc.put("tenant_id", tenantId.toString());
        ObjectNode origin = doc.putObject("origin");
        origin.put("kind", "consumer-policy");
        origin.put("policy_id", policyId.toString());
        origin.put("policy_version", policyVersion);
        origin.put("entity_id", profile.entityId().toString());

        ObjectNode node = doc.putArray("nodes").addObject();
        node.put("id", "reaktiv");
        node.put("type", "vp.consumer.reactive");
        node.put("type_version", "1.0.0");
        node.put("label", "Reaktive Regeln: " + displayName(profile));
        ObjectNode params = node.putObject("parameters");
        params.put("entity_id", profile.entityId().toString());
        params.put("command", command);
        params.put("ttl_s", TTL_S);
        params.put("renew_s", RENEW_S);
        params.put("off_delay_s", OFF_DELAY_S);
        ArrayNode reqs = params.putArray("requirements");
        for (JsonNode req : reactive) {
            ObjectNode out = reqs.addObject();
            out.put("id", req.path("id").asText());
            out.put("must_run", "must_run".equals(req.path("enforcement").asText()));
            putTargetValue(out, command, req.path("target"), profile);
            out.set("condition", compileCondition(req.path("condition"), profile, siteId,
                    windows, now));
        }
        ObjectNode claim = node.putArray("claims").addObject();
        claim.put("entity_id", profile.entityId().toString());
        claim.putArray("commands").add(command);

        doc.putArray("edges");
        ObjectNode trigger = doc.putArray("triggers").addObject();
        trigger.put("id", "tick");
        trigger.put("kind", "interval");
        trigger.put("every_s", RENEW_S);
        return doc;
    }

    // -- selection ----------------------------------------------------------

    /** reactive + active + at least one LOCAL signal in the tree (D1 split). */
    private boolean isEdgeReactive(JsonNode req) {
        if (!"reactive".equals(req.path("kind").asText())) {
            return false;
        }
        if (req.has("active") && !req.path("active").asBoolean(true)) {
            return false;
        }
        return hasLocalSignal(req.path("condition"));
    }

    private boolean hasLocalSignal(JsonNode cond) {
        if (cond == null || !cond.isObject()) {
            return false;
        }
        if (cond.has("all") || cond.has("any")) {
            for (JsonNode child : cond.path(cond.has("all") ? "all" : "any")) {
                if (hasLocalSignal(child)) {
                    return true;
                }
            }
            return false;
        }
        if (cond.has("not")) {
            return hasLocalSignal(cond.path("not"));
        }
        return cond.has("signal") && !signals.isCloud(cond.path("signal").asText());
    }

    // -- target mapping -----------------------------------------------------

    /**
     * The ONE edge command of the merged rule (§7: all requirements merge into
     * one target). on_off consumers switch; stepped/continuous consumers get a
     * setpoint (the edge consumer guard + power_ranges snapping bound it);
     * mode targets ride the mode command.
     */
    private String commandFor(ConsumerRow profile, List<JsonNode> reactive) {
        boolean allMode = reactive.stream()
                .allMatch(r -> "mode".equals(r.path("target").path("kind").asText()));
        if (allMode) {
            return "mode";
        }
        return "on_off".equals(profile.controlKind()) ? "on_off" : "setpoint_kw";
    }

    /**
     * The requirement's wished value under the chosen command. E8: percent
     * means percent of the EFFECTIVE maximum - the cloud's best knowledge is
     * the rated power; every guard downstream may only shrink it.
     */
    private void putTargetValue(ObjectNode out, String command, JsonNode target,
            ConsumerRow profile) {
        String kind = target.path("kind").asText();
        JsonNode value = target.path("value");
        switch (command) {
            case "on_off" -> out.put("value", !value.isBoolean() || value.asBoolean());
            case "mode" -> out.put("value", value.asText());
            default -> {
                double rated = profile.ratedPowerKw() == null ? 0.0
                        : profile.ratedPowerKw().doubleValue();
                double kw = switch (kind) {
                    case "percent" -> rated * value.asDouble() / 100.0;
                    case "kw" -> value.asDouble();
                    // on_off target on a modulating consumer: full effective power.
                    default -> rated;
                };
                out.put("value", BigDecimal.valueOf(Math.round(kw * 1000.0) / 1000.0));
            }
        }
    }

    // -- condition mapping --------------------------------------------------

    /** Policy signal name -> the edge evaluation source/channel. */
    private record LocalSignal(String source, String channel) {}

    private LocalSignal localSignal(String name, ConsumerRow profile) {
        return switch (name) {
            case "storage.soc_pct" -> new LocalSignal("site", "soc_pct");
            case "site.pv_surplus_kw" -> new LocalSignal("site", "pv_surplus_kw");
            case "site.grid_power_kw" -> new LocalSignal("site", "grid_power_kw");
            case "consumer.vehicle_connected" -> new LocalSignal("entity",
                    channelOr(profile, "vehicle_connected"));
            case "consumer.available" -> new LocalSignal("entity",
                    channelOr(profile, "available"));
            default -> null;
        };
    }

    private static String channelOr(ConsumerRow profile, String fallback) {
        String channel = profile.availabilityChannel();
        return channel == null || channel.isBlank() ? fallback : channel;
    }

    private ObjectNode compileCondition(JsonNode cond, ConsumerRow profile, UUID siteId,
            WindowSource windows, Instant now) {
        ObjectNode out = mapper.createObjectNode();
        if (cond.has("all") || cond.has("any")) {
            String key = cond.has("all") ? "all" : "any";
            ArrayNode list = out.putArray(key);
            for (JsonNode child : cond.path(key)) {
                list.add(compileCondition(child, profile, siteId, windows, now));
            }
            return out;
        }
        if (cond.has("not")) {
            out.set("not", compileCondition(cond.path("not"), profile, siteId, windows, now));
            return out;
        }

        String signal = cond.path("signal").asText();
        if (signals.isCloud(signal)) {
            // D1: the cloud prices, the edge limits - a price condition becomes
            // concrete UTC windows. No known window = an ALREADY-EXPIRED
            // sentinel, so the edge honestly reads `unknown` (never a guess).
            List<Window> list = windows.windows(siteId, signal, cond.path("operator").asText(),
                    cond.path("value").asDouble(), now, now.plus(WINDOW_HORIZON));
            ArrayNode arr = out.putArray("windows");
            if (list == null || list.isEmpty()) {
                ArrayNode sentinel = arr.addArray();
                sentinel.add(now.minusSeconds(7200).toString());
                sentinel.add(now.minusSeconds(3600).toString());
            } else {
                for (Window w : list) {
                    ArrayNode pair = arr.addArray();
                    pair.add(w.from().toString());
                    pair.add(w.to().toString());
                }
            }
            return out;
        }

        LocalSignal local = localSignal(signal, profile);
        out.put("signal", signal);
        out.put("source", local == null ? "site" : local.source());
        out.put("channel", local == null ? "unbekannt" : local.channel());
        out.put("op", cond.path("operator").asText());
        JsonNode value = cond.path("value");
        if (value.isBoolean()) {
            out.put("value", value.asBoolean() ? 1 : 0);
        } else {
            out.put("value", BigDecimal.valueOf(value.asDouble()));
        }
        if (cond.has("reset_value")) {
            out.put("reset_value", BigDecimal.valueOf(cond.path("reset_value").asDouble()));
        }
        out.put("max_age_s", cond.has("max_age_s")
                ? cond.path("max_age_s").asInt() : DEFAULT_MAX_AGE_S);
        return out;
    }

    private static String displayName(ConsumerRow profile) {
        return profile.label() == null || profile.label().isBlank()
                ? profile.entityId().toString() : profile.label();
    }
}
