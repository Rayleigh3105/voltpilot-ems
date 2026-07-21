package com.voltpilot.api.flows;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * The platform validator of flow-graph documents (contract
 * docs/contracts/v2/flow-graph.md §4, rules V-1..V-8) plus the structural
 * schema-shape checks JSON Schema would pin (rule id "schema"). The portal
 * runs the SAME rules client-side ({@code src/flows/validate.ts}); shared
 * test vectors keep the two in lockstep (the EdgeRef precedent). Output is
 * machine-readable findings with German customer-facing copy - the editor
 * highlights the named nodes/edges.
 *
 * <p>Entity knowledge is INJECTED per call: the site's v2 entity registry
 * capabilities (V-6) and the claims of the site's other ACTIVE flows (V-5
 * cross-flow) - the validator itself stays pure and unit-testable.
 */
@Component
public class FlowGraphValidator {

    /**
     * Capability view of one registry entity (measure channels / actuate
     * commands). {@code composed} = the entity's type is COMPOSED from v1
     * master data (battery-hybrid/producer/grid-meter per the entity-type
     * catalog) - a Modbus read must never map onto such an entity, because its
     * measured channels feed the guard chain (MB-M1 guard-integrity rule).
     */
    public record EntityCapabilities(Set<String> measure, Set<String> actuate, boolean composed) {

        public EntityCapabilities(Set<String> measure, Set<String> actuate) {
            this(measure, actuate, false);
        }
    }

    /** One claim held by ANOTHER active flow of the same site+runtime. */
    public record ForeignClaim(String entityId, UUID flowId, String flowName) {}

    private static final Pattern ID_PATTERN = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$");
    private static final Pattern PORT_PATTERN = Pattern.compile("^[a-z0-9][a-z0-9_]{0,63}$");
    private static final Pattern TIME_PATTERN = Pattern.compile("^([01]\\d|2[0-3]):[0-5]\\d$");
    /** The `host` param kind (MB-M1): IPv4 literal or RFC-1123 hostname, <= 253 chars. */
    private static final Pattern HOST_PATTERN = Pattern.compile(
            "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$",
            Pattern.CASE_INSENSITIVE);
    private static final Set<String> TRIGGER_KINDS =
            Set.of("interval", "value-change", "slot-boundary", "event");

    private final FlowCatalog catalog;

    public FlowGraphValidator(FlowCatalog catalog) {
        this.catalog = catalog;
    }

    /**
     * Validate one document. {@code entities} is the site's registry
     * capability view (empty = no v2 entities bootstrapped yet);
     * {@code foreignClaims} the claims of the site's OTHER active flows of the
     * same runtime (exclude the flow being validated - re-activation of a new
     * version must not conflict with itself).
     */
    public List<FlowValidationFinding> validate(JsonNode doc,
            Map<String, EntityCapabilities> entities, List<ForeignClaim> foreignClaims) {
        List<FlowValidationFinding> findings = new ArrayList<>();
        if (doc == null || !doc.isObject()) {
            findings.add(FlowValidationFinding.error("schema", List.of(), List.of(),
                    "Das Flow-Dokument ist kein JSON-Objekt."));
            return findings;
        }
        checkShape(doc, findings);

        Map<String, JsonNode> nodesById = new LinkedHashMap<>();
        checkNodes(doc, findings, nodesById);
        checkEdges(doc, findings, nodesById);
        checkRequiredInputs(doc, findings, nodesById);
        checkCycles(doc, findings, nodesById);
        checkTriggers(doc, findings, nodesById);
        checkClaims(doc, findings, nodesById, entities, foreignClaims);
        checkEntityReads(doc, findings, nodesById, entities);
        checkModbusReads(doc, findings, nodesById, entities);
        return findings;
    }

    /** True when no finding blocks activation. */
    public static boolean valid(List<FlowValidationFinding> findings) {
        return findings.stream().noneMatch(FlowValidationFinding::isError);
    }

    // -- schema shape ------------------------------------------------------

    private void checkShape(JsonNode doc, List<FlowValidationFinding> findings) {
        if (!"1.0".equals(doc.path("schema_version").asText())) {
            findings.add(FlowValidationFinding.error("schema", List.of(), List.of(),
                    "schema_version muss \"1.0\" sein."));
        }
        String runtime = doc.path("runtime").asText("");
        if (!"edge".equals(runtime) && !"cloud".equals(runtime)) {
            findings.add(FlowValidationFinding.error("schema", List.of(), List.of(),
                    "runtime muss \"edge\" oder \"cloud\" sein."));
        }
        if ("edge".equals(runtime) && doc.path("site_id").asText("").isEmpty()) {
            findings.add(FlowValidationFinding.error("schema", List.of(), List.of(),
                    "Ein Edge-Flow braucht eine site_id."));
        }
        if (doc.path("name").asText("").isBlank()) {
            findings.add(FlowValidationFinding.error("schema", List.of(), List.of(),
                    "Der Flow braucht einen Namen."));
        }
        if (!doc.path("nodes").isArray() || doc.path("nodes").isEmpty()) {
            findings.add(FlowValidationFinding.error("schema", List.of(), List.of(),
                    "Der Flow braucht mindestens einen Baustein."));
        }
    }

    // -- V-3 (ids/references) + V-4 (catalog) + V-8 (runtime) --------------

    private void checkNodes(JsonNode doc, List<FlowValidationFinding> findings,
            Map<String, JsonNode> nodesById) {
        String runtime = doc.path("runtime").asText("");
        for (JsonNode node : doc.path("nodes")) {
            String id = node.path("id").asText("");
            if (!ID_PATTERN.matcher(id).matches()) {
                findings.add(FlowValidationFinding.error("V-3", List.of(id), List.of(),
                        "Ungültige Baustein-ID \"" + id + "\"."));
                continue;
            }
            if (nodesById.putIfAbsent(id, node) != null) {
                findings.add(FlowValidationFinding.error("V-3", List.of(id), List.of(),
                        "Baustein-ID \"" + id + "\" ist doppelt vergeben."));
                continue;
            }
            String typeId = node.path("type").asText("");
            JsonNode type = catalog.type(typeId);
            if (type == null) {
                findings.add(FlowValidationFinding.error("V-4", List.of(id), List.of(),
                        "Unbekannter Baustein-Typ \"" + typeId + "\"."));
                continue;
            }
            String typeVersion = node.path("type_version").asText("");
            if (!catalog.supportsVersion(typeId, typeVersion)) {
                findings.add(FlowValidationFinding.error("V-4", List.of(id), List.of(),
                        "Baustein \"" + label(type) + "\": Version " + typeVersion
                                + " wird vom Katalog (" + type.path("type_version").asText()
                                + ") nicht unterstützt."));
            }
            boolean runtimeOk = false;
            for (JsonNode supported : type.path("runtimes")) {
                runtimeOk |= supported.asText().equals(runtime);
            }
            if (!runtimeOk && !runtime.isEmpty()) {
                findings.add(FlowValidationFinding.error("V-8", List.of(id), List.of(),
                        "Baustein \"" + label(type) + "\" ist in der Laufzeit \"" + runtime
                                + "\" nicht verfügbar."));
            }
            checkParameters(node, type, id, findings);
        }
    }

    private void checkParameters(JsonNode node, JsonNode type, String nodeId,
            List<FlowValidationFinding> findings) {
        JsonNode parameters = node.path("parameters");
        for (JsonNode spec : type.path("parameters")) {
            String name = spec.path("name").asText();
            JsonNode value = parameters.path(name);
            if (value.isMissingNode() || value.isNull()
                    || (value.isTextual() && value.asText().isBlank())) {
                if (spec.path("required").asBoolean(false)) {
                    findings.add(FlowValidationFinding.error("V-4", List.of(nodeId), List.of(),
                            "Baustein \"" + label(type) + "\": Parameter \""
                                    + spec.path("label").asText(name) + "\" fehlt."));
                }
                continue;
            }
            String kind = spec.path("kind").asText("string");
            switch (kind) {
                case "number" -> {
                    if (!value.isNumber()) {
                        findings.add(paramError(type, spec, nodeId, "muss eine Zahl sein"));
                    } else {
                        double v = value.asDouble();
                        if (spec.has("min") && v < spec.get("min").asDouble()) {
                            findings.add(paramError(type, spec, nodeId,
                                    "muss mindestens " + spec.get("min").asDouble() + " sein"));
                        }
                        if (spec.has("max") && v > spec.get("max").asDouble()) {
                            findings.add(paramError(type, spec, nodeId,
                                    "darf höchstens " + spec.get("max").asDouble() + " sein"));
                        }
                    }
                }
                case "enum" -> {
                    boolean known = false;
                    for (JsonNode option : spec.path("options")) {
                        known |= option.asText().equals(value.asText());
                    }
                    if (!known) {
                        findings.add(paramError(type, spec, nodeId,
                                "hat einen unbekannten Wert \"" + value.asText() + "\""));
                    }
                }
                case "time" -> {
                    if (!TIME_PATTERN.matcher(value.asText("")).matches()) {
                        findings.add(paramError(type, spec, nodeId,
                                "muss eine Uhrzeit im Format HH:MM sein"));
                    }
                }
                case "host" -> {
                    String host = value.asText("");
                    if (!value.isTextual() || host.length() > 253
                            || !HOST_PATTERN.matcher(host).matches()) {
                        findings.add(paramError(type, spec, nodeId,
                                "muss eine gültige IP-Adresse oder ein Hostname sein"));
                    }
                }
                default -> {
                    if (!value.isTextual()) {
                        findings.add(paramError(type, spec, nodeId, "muss ein Text sein"));
                    }
                }
            }
        }
    }

    private FlowValidationFinding paramError(JsonNode type, JsonNode spec, String nodeId,
            String problem) {
        return FlowValidationFinding.error("V-4", List.of(nodeId), List.of(),
                "Baustein \"" + label(type) + "\": Parameter \""
                        + spec.path("label").asText(spec.path("name").asText()) + "\" " + problem
                        + ".");
    }

    // -- V-1 (ports/compatibility) + V-3 (edge references) -----------------

    private void checkEdges(JsonNode doc, List<FlowValidationFinding> findings,
            Map<String, JsonNode> nodesById) {
        Set<String> edgeIds = new HashSet<>();
        Map<String, String> inputTaken = new HashMap<>();
        for (JsonNode edge : doc.path("edges")) {
            String id = edge.path("id").asText("");
            if (!ID_PATTERN.matcher(id).matches() || !edgeIds.add(id)) {
                findings.add(FlowValidationFinding.error("V-3", List.of(), List.of(id),
                        "Verbindungs-ID \"" + id + "\" fehlt oder ist doppelt."));
                continue;
            }
            JsonNode fromPort = resolvePort(edge.path("from"), "outputs", nodesById, findings, id);
            JsonNode toPort = resolvePort(edge.path("to"), "inputs", nodesById, findings, id);
            if (fromPort == null || toPort == null) {
                continue;
            }
            String fromType = fromPort.path("type").asText();
            String toType = toPort.path("type").asText();
            if (!FlowCatalog.compatible(fromType, toType)) {
                findings.add(FlowValidationFinding.error("V-1",
                        List.of(edge.path("from").path("node").asText(),
                                edge.path("to").path("node").asText()),
                        List.of(id),
                        "Verbindung nicht möglich: " + typeLabel(fromType) + " passt nicht auf "
                                + typeLabel(toType) + "."));
            }
            String inputKey = edge.path("to").path("node").asText() + "#"
                    + edge.path("to").path("port").asText();
            String previous = inputTaken.putIfAbsent(inputKey, id);
            if (previous != null) {
                findings.add(FlowValidationFinding.error("V-1",
                        List.of(edge.path("to").path("node").asText()), List.of(previous, id),
                        "In einen Eingang darf nur EINE Verbindung führen."));
            }
        }
    }

    /** Resolve a port_ref to its catalog port declaration (adds findings when broken). */
    private JsonNode resolvePort(JsonNode ref, String direction, Map<String, JsonNode> nodesById,
            List<FlowValidationFinding> findings, String edgeId) {
        String nodeId = ref.path("node").asText("");
        String portName = ref.path("port").asText("");
        JsonNode node = nodesById.get(nodeId);
        if (node == null) {
            findings.add(FlowValidationFinding.error("V-3", List.of(nodeId), List.of(edgeId),
                    "Verbindung verweist auf einen unbekannten Baustein \"" + nodeId + "\"."));
            return null;
        }
        if (!PORT_PATTERN.matcher(portName).matches()) {
            findings.add(FlowValidationFinding.error("V-3", List.of(nodeId), List.of(edgeId),
                    "Ungültiger Port-Name \"" + portName + "\"."));
            return null;
        }
        String typeId = node.path("type").asText();
        if (catalog.type(typeId) == null) {
            return null; // V-4 already reported the unknown type
        }
        JsonNode port = catalog.port(typeId, direction, portName);
        if (port == null) {
            findings.add(FlowValidationFinding.error("V-3", List.of(nodeId), List.of(edgeId),
                    "Baustein \"" + label(catalog.type(typeId)) + "\" hat keinen "
                            + ("outputs".equals(direction) ? "Ausgang" : "Eingang") + " \""
                            + portName + "\"."));
            return null;
        }
        return port;
    }

    private void checkRequiredInputs(JsonNode doc, List<FlowValidationFinding> findings,
            Map<String, JsonNode> nodesById) {
        Set<String> connected = new HashSet<>();
        for (JsonNode edge : doc.path("edges")) {
            connected.add(edge.path("to").path("node").asText() + "#"
                    + edge.path("to").path("port").asText());
        }
        for (Map.Entry<String, JsonNode> entry : nodesById.entrySet()) {
            JsonNode type = catalog.type(entry.getValue().path("type").asText());
            if (type == null) {
                continue;
            }
            for (JsonNode input : type.path("inputs")) {
                if (input.path("required").asBoolean(false)
                        && !connected.contains(entry.getKey() + "#" + input.path("name").asText())) {
                    findings.add(FlowValidationFinding.error("V-1", List.of(entry.getKey()),
                            List.of(),
                            "Baustein \"" + label(type) + "\": Eingang \""
                                    + input.path("label").asText(input.path("name").asText())
                                    + "\" muss verbunden sein."));
                }
            }
            if (type.has("requires_any_input")) {
                boolean any = false;
                for (JsonNode name : type.get("requires_any_input")) {
                    any |= connected.contains(entry.getKey() + "#" + name.asText());
                }
                if (!any) {
                    findings.add(FlowValidationFinding.error("V-1", List.of(entry.getKey()),
                            List.of(),
                            "Baustein \"" + label(type)
                                    + "\" braucht mindestens einen verbundenen Eingang."));
                }
            }
        }
    }

    // -- V-2 (acyclic modulo feedback) -------------------------------------

    private void checkCycles(JsonNode doc, List<FlowValidationFinding> findings,
            Map<String, JsonNode> nodesById) {
        Map<String, List<String>> adjacency = new HashMap<>();
        for (JsonNode edge : doc.path("edges")) {
            if (edge.path("feedback").asBoolean(false)) {
                continue;
            }
            String from = edge.path("from").path("node").asText();
            String to = edge.path("to").path("node").asText();
            if (nodesById.containsKey(from) && nodesById.containsKey(to)) {
                adjacency.computeIfAbsent(from, k -> new ArrayList<>()).add(to);
            }
        }
        Set<String> done = new HashSet<>();
        Set<String> inStack = new HashSet<>();
        for (String start : nodesById.keySet()) {
            List<String> cycle = findCycle(start, adjacency, done, inStack, new ArrayDeque<>());
            if (cycle != null) {
                findings.add(FlowValidationFinding.error("V-2", cycle, List.of(),
                        "Der Flow enthält einen Kreis (" + String.join(" → ", cycle)
                                + "). Beabsichtigte Rückkopplungen brauchen eine "
                                + "Feedback-Verbindung."));
                return; // one cycle finding is enough to act on
            }
        }
    }

    private List<String> findCycle(String node, Map<String, List<String>> adjacency,
            Set<String> done, Set<String> inStack, Deque<String> path) {
        if (inStack.contains(node)) {
            List<String> cycle = new ArrayList<>(path);
            cycle.add(node);
            return cycle.subList(cycle.indexOf(node), cycle.size());
        }
        if (!done.add(node)) {
            return null;
        }
        inStack.add(node);
        path.addLast(node);
        for (String next : adjacency.getOrDefault(node, List.of())) {
            List<String> cycle = findCycle(next, adjacency, done, inStack, path);
            if (cycle != null) {
                return cycle;
            }
        }
        inStack.remove(node);
        path.removeLast();
        return null;
    }

    // -- V-7 (triggers) ----------------------------------------------------

    private void checkTriggers(JsonNode doc, List<FlowValidationFinding> findings,
            Map<String, JsonNode> nodesById) {
        JsonNode triggers = doc.path("triggers");
        if (!triggers.isArray() || triggers.isEmpty()) {
            findings.add(FlowValidationFinding.error("V-7", List.of(), List.of(),
                    "Der Flow braucht mindestens einen Auslöser."));
            return;
        }
        Set<String> triggerIds = new HashSet<>();
        for (JsonNode trigger : triggers) {
            String id = trigger.path("id").asText("");
            if (!ID_PATTERN.matcher(id).matches() || !triggerIds.add(id)) {
                findings.add(FlowValidationFinding.error("V-3", List.of(), List.of(),
                        "Auslöser-ID \"" + id + "\" fehlt oder ist doppelt."));
            }
            String kind = trigger.path("kind").asText("");
            if (!TRIGGER_KINDS.contains(kind)) {
                findings.add(FlowValidationFinding.error("V-7", List.of(), List.of(),
                        "Unbekannte Auslöser-Art \"" + kind + "\"."));
                continue;
            }
            switch (kind) {
                case "interval" -> {
                    long everyS = trigger.path("every_s").asLong(0);
                    if (everyS < 1 || everyS > 86400) {
                        findings.add(FlowValidationFinding.error("V-7", List.of(), List.of(),
                                "Intervall-Auslöser: every_s muss zwischen 1 und 86400 liegen."));
                    }
                }
                case "value-change" -> {
                    JsonNode source = trigger.path("source");
                    String nodeId = source.path("node").asText("");
                    JsonNode node = nodesById.get(nodeId);
                    JsonNode port = node == null ? null
                            : catalog.port(node.path("type").asText(), "outputs",
                                    source.path("port").asText(""));
                    if (port == null) {
                        findings.add(FlowValidationFinding.error("V-7",
                                nodeId.isEmpty() ? List.of() : List.of(nodeId), List.of(),
                                "Wertänderungs-Auslöser: die beobachtete Quelle muss ein "
                                        + "vorhandener Ausgang sein."));
                    }
                    if (trigger.has("deadband") && trigger.get("deadband").asDouble() < 0) {
                        findings.add(FlowValidationFinding.error("V-7", List.of(), List.of(),
                                "Wertänderungs-Auslöser: deadband darf nicht negativ sein."));
                    }
                }
                case "event" -> {
                    if (trigger.path("event").asText("").isBlank()) {
                        findings.add(FlowValidationFinding.error("V-7", List.of(), List.of(),
                                "Ereignis-Auslöser: der Ereignisname fehlt."));
                    }
                }
                default -> {
                    // slot-boundary needs nothing further
                }
            }
        }
    }

    // -- V-5 (exclusive resources) + claim-derivation consistency ----------

    private void checkClaims(JsonNode doc, List<FlowValidationFinding> findings,
            Map<String, JsonNode> nodesById, Map<String, EntityCapabilities> entities,
            List<ForeignClaim> foreignClaims) {
        List<FlowClaims.DerivedClaim> derived = FlowClaims.derive(doc, catalog);

        // Derivation consistency: the document's stored claims must equal the
        // derivation (D-13: the editor fills claims; hand-edits cannot cheat).
        Set<String> stored = new TreeSet<>();
        for (JsonNode node : doc.path("nodes")) {
            for (JsonNode claim : node.path("claims")) {
                stored.add(claimKey(node.path("id").asText(), claim.path("entity_id").asText(),
                        commandsOf(claim), claim.path("delegated").asBoolean(false)));
            }
        }
        Set<String> expected = new TreeSet<>();
        for (FlowClaims.DerivedClaim claim : derived) {
            expected.add(claimKey(claim.nodeId(), claim.entityId(), claim.commands(),
                    claim.delegated()));
        }
        if (!stored.equals(expected)) {
            findings.add(FlowValidationFinding.error("V-5", List.of(), List.of(),
                    "Die hinterlegten Claims stimmen nicht mit den Bausteinen überein - "
                            + "bitte den Flow im Editor neu speichern."));
        }

        // Within-flow exclusivity (one controlling node per entity).
        Map<String, String> byEntity = new HashMap<>();
        for (FlowClaims.DerivedClaim claim : derived) {
            String previous = byEntity.putIfAbsent(claim.entityId(), claim.nodeId());
            if (previous != null && !previous.equals(claim.nodeId())) {
                findings.add(FlowValidationFinding.error("V-5",
                        List.of(previous, claim.nodeId()), List.of(),
                        "Zwei Bausteine steuern dieselbe Entität \""
                                + entityLabel(claim.entityId(), nodesById) + "\" - pro Entität "
                                + "darf nur EIN Baustein steuern."));
            }
        }

        // Cross-flow exclusivity against the site's other ACTIVE flows.
        for (FlowClaims.DerivedClaim claim : derived) {
            for (ForeignClaim foreign : foreignClaims) {
                if (foreign.entityId().equals(claim.entityId())) {
                    findings.add(FlowValidationFinding.error("V-5", List.of(claim.nodeId()),
                            List.of(),
                            "Die Entität \"" + entityLabel(claim.entityId(), nodesById)
                                    + "\" wird bereits vom aktiven Flow \"" + foreign.flowName()
                                    + "\" gesteuert."));
                }
            }
        }

        // V-6: every claim command must be an actuate capability.
        for (FlowClaims.DerivedClaim claim : derived) {
            EntityCapabilities caps = entities.get(claim.entityId());
            if (caps == null) {
                findings.add(FlowValidationFinding.error("V-6", List.of(claim.nodeId()), List.of(),
                        entities.isEmpty()
                                ? "Diese Anlage hat noch keine v2-Entitäten - bitte zuerst das "
                                        + "Entitäten-Bootstrap ausführen (Plattform → Anlage)."
                                : "Unbekannte Entität \"" + claim.entityId() + "\"."));
                continue;
            }
            for (String command : claim.commands()) {
                if (!caps.actuate().contains(command)) {
                    findings.add(FlowValidationFinding.error("V-6", List.of(claim.nodeId()),
                            List.of(),
                            "Die Entität \"" + claim.entityId() + "\" unterstützt das Kommando \""
                                    + command + "\" nicht."));
                }
            }
        }
    }

    /** V-6 for read nodes: the channel must be a measure capability. */
    private void checkEntityReads(JsonNode doc, List<FlowValidationFinding> findings,
            Map<String, JsonNode> nodesById, Map<String, EntityCapabilities> entities) {
        for (Map.Entry<String, JsonNode> entry : nodesById.entrySet()) {
            JsonNode node = entry.getValue();
            if (!"vp.entity.read".equals(node.path("type").asText())) {
                continue;
            }
            String entityId = node.path("parameters").path("entity_id").asText("");
            String channel = node.path("parameters").path("channel").asText("");
            if (entityId.isEmpty() || channel.isEmpty()) {
                continue; // V-4 reports the missing parameter
            }
            EntityCapabilities caps = entities.get(entityId);
            if (caps == null) {
                findings.add(FlowValidationFinding.error("V-6", List.of(entry.getKey()), List.of(),
                        entities.isEmpty()
                                ? "Diese Anlage hat noch keine v2-Entitäten - bitte zuerst das "
                                        + "Entitäten-Bootstrap ausführen (Plattform → Anlage)."
                                : "Unbekannte Entität \"" + entityId + "\"."));
            } else if (!caps.measure().contains(channel)) {
                findings.add(FlowValidationFinding.error("V-6", List.of(entry.getKey()), List.of(),
                        "Die Entität \"" + entityId + "\" misst den Kanal \"" + channel
                                + "\" nicht."));
            }
        }
    }

    /**
     * MB-M1 rules for {@code vp.modbus.read}'s optional entity mapping:
     * entity_id/channel are both-or-neither (V-4); a mapped read's entity must
     * exist and DECLARE the channel as a measure capability (V-6, the
     * entity-read rule applied to a second node type) and must NOT be of a
     * composed type - a customer flow must never inject readings into the
     * guard chain's inputs (battery SoC/PV feed D-8 and the clamps); two reads
     * mapping the same (entity, channel) in one flow clash (V-5).
     */
    private void checkModbusReads(JsonNode doc, List<FlowValidationFinding> findings,
            Map<String, JsonNode> nodesById, Map<String, EntityCapabilities> entities) {
        Map<String, String> mappedBy = new HashMap<>();
        for (Map.Entry<String, JsonNode> entry : nodesById.entrySet()) {
            JsonNode node = entry.getValue();
            if (!"vp.modbus.read".equals(node.path("type").asText())) {
                continue;
            }
            String entityId = node.path("parameters").path("entity_id").asText("");
            String channel = node.path("parameters").path("channel").asText("");
            if (entityId.isEmpty() && channel.isEmpty()) {
                continue; // unmapped read - legal, feeds the flow only
            }
            if (entityId.isEmpty() || channel.isEmpty()) {
                findings.add(FlowValidationFinding.error("V-4", List.of(entry.getKey()), List.of(),
                        "Baustein \"Modbus lesen\": Entität und Messkanal gehören zusammen - "
                                + "bitte beide angeben oder beide leer lassen."));
                continue;
            }
            EntityCapabilities caps = entities.get(entityId);
            if (caps == null) {
                findings.add(FlowValidationFinding.error("V-6", List.of(entry.getKey()), List.of(),
                        entities.isEmpty()
                                ? "Diese Anlage hat noch keine v2-Entitäten - bitte zuerst das "
                                        + "Entitäten-Bootstrap ausführen (Plattform → Anlage)."
                                : "Unbekannte Entität \"" + entityId + "\"."));
            } else if (caps.composed()) {
                findings.add(FlowValidationFinding.error("V-6", List.of(entry.getKey()), List.of(),
                        "Die Entität \"" + entityId + "\" wird aus den Stammdaten der Anlage "
                                + "abgeleitet - Messwerte können hier nicht per Modbus-Baustein "
                                + "eingespeist werden. Bitte eine generische Modbus-Entität "
                                + "verwenden."));
            } else if (!caps.measure().contains(channel)) {
                findings.add(FlowValidationFinding.error("V-6", List.of(entry.getKey()), List.of(),
                        "Die Entität \"" + entityId + "\" misst den Kanal \"" + channel
                                + "\" nicht."));
            }
            String previous = mappedBy.putIfAbsent(entityId + "#" + channel, entry.getKey());
            if (previous != null) {
                findings.add(FlowValidationFinding.error("V-5",
                        List.of(previous, entry.getKey()), List.of(),
                        "Zwei Modbus-Lesen-Bausteine zeichnen denselben Messkanal \"" + channel
                                + "\" der Entität \"" + entityId + "\" auf."));
            }
        }
    }

    // -- helpers -----------------------------------------------------------

    private static String claimKey(String nodeId, String entityId, List<String> commands,
            boolean delegated) {
        return nodeId + "|" + entityId + "|" + String.join(",", new TreeSet<>(commands)) + "|"
                + delegated;
    }

    private static List<String> commandsOf(JsonNode claim) {
        List<String> commands = new ArrayList<>();
        for (JsonNode command : claim.path("commands")) {
            commands.add(command.asText());
        }
        return commands;
    }

    private static String label(JsonNode type) {
        return type.path("label").asText(type.path("type").asText());
    }

    private static String entityLabel(String entityId, Map<String, JsonNode> nodesById) {
        return entityId;
    }

    private static String typeLabel(String portType) {
        return switch (portType) {
            case "price" -> "Preisreihe";
            case "timeseries" -> "Zeitreihe";
            case "number" -> "Zahl";
            case "bool" -> "Bedingung";
            case "event" -> "Ereignis";
            case "plan" -> "Wunsch/Plan";
            case "entityRef" -> "Entitäts-Referenz";
            default -> portType;
        };
    }
}
