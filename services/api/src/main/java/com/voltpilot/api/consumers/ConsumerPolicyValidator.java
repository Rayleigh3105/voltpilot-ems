package com.voltpilot.api.consumers;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * The semantic validator of a consumer-policy document (contract
 * docs/contracts/v2/consumer-policy.schema.json + §9.2/§10). It enforces the
 * rules JSON Schema cannot express: kind/enforcement coherence, {@code must_run}
 * ⇒ grid allow, condition-tree depth/size, cloud-vs-local signal hysteresis
 * (D1), catalog signal names, target value coherence, recurrence windows, the
 * D4 {@code power_ranges_kw} disjointness and the levels/min/resolution rules.
 *
 * <p>The portal runs the SAME rules client-side
 * ({@code frontend/portal/src/consumers/validate.ts}); the shared vectors
 * ({@code docs/contracts/v2/consumer-policy-vectors.json}) keep the two in
 * lockstep (the FlowGraphValidator / EdgeRef precedent). The validator is pure -
 * signal knowledge is the injected {@link ConsumerSignalCatalog}, effective
 * rated power is read from the document's own {@code control_profile} snapshot.
 * Output is machine-readable {@link ConsumerFinding}s with German copy.
 */
@Component
public class ConsumerPolicyValidator {

    static final int MAX_REQUIREMENTS = 32;
    static final int MAX_TREE_DEPTH = 4;
    static final int MAX_TREE_NODES = 24;

    private static final Pattern ID_PATTERN = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
    private static final Pattern TIME_PATTERN = Pattern.compile("^([01][0-9]|2[0-3]):[0-5][0-9]$");
    /** The open v2 channel vocabulary (CHANNEL_RE) - availability/confirmation channels. */
    static final Pattern CHANNEL_PATTERN = Pattern.compile("^[a-z][a-z0-9_]{0,63}$");

    private static final Set<String> KINDS =
            Set.of("reactive", "fixed_window", "flexible_task", "opportunistic");
    private static final Set<String> ENFORCEMENTS =
            Set.of("must_run", "required_by_deadline", "opportunistic");
    private static final Set<String> OPERATORS = Set.of("lt", "lte", "gt", "gte", "eq", "ne");
    private static final Set<String> TARGET_KINDS = Set.of("on_off", "percent", "kw", "mode");
    private static final Set<String> GRID_POLICIES = Set.of("allow", "avoid", "forbid");
    private static final Set<String> DAYS = Set.of("daily", "weekdays", "weekend");
    private static final Set<String> CONTROL_KINDS = Set.of("on_off", "stepped", "continuous");

    private final ConsumerSignalCatalog signals;

    public ConsumerPolicyValidator(ConsumerSignalCatalog signals) {
        this.signals = signals;
    }

    /** Validate a full policy document. Never throws; unparseable = one `schema` error. */
    public List<ConsumerFinding> validate(JsonNode doc) {
        List<ConsumerFinding> out = new ArrayList<>();
        if (doc == null || !doc.isObject()) {
            out.add(ConsumerFinding.error("schema", "$", "Das Regeldokument ist leer oder ungültig."));
            return out;
        }
        if (!"1.0".equals(doc.path("schema_version").asText(null))) {
            out.add(ConsumerFinding.error("schema", "$.schema_version",
                    "Unbekannte Schemaversion."));
        }
        if (doc.path("entity_id").asText("").isBlank()) {
            out.add(ConsumerFinding.error("schema", "$.entity_id", "entity_id fehlt."));
        }

        if (doc.has("control_profile")) {
            validateControlProfile(doc.get("control_profile"), "$.control_profile", out);
        }

        JsonNode reqs = doc.get("requirements");
        if (reqs == null || !reqs.isArray() || reqs.isEmpty()) {
            out.add(ConsumerFinding.error("empty_requirements", "$.requirements",
                    "Es muss mindestens eine Regel oder Aufgabe geben."));
            return out;
        }
        if (reqs.size() > MAX_REQUIREMENTS) {
            out.add(ConsumerFinding.error("too_many_requirements", "$.requirements",
                    "Zu viele Regeln für einen Verbraucher."));
        }
        Set<String> ids = new HashSet<>();
        for (int i = 0; i < reqs.size(); i++) {
            validateRequirement(reqs.get(i), "$.requirements[" + i + "]", ids, out);
        }
        return out;
    }

    /**
     * Validate ONLY a control-profile object (the Stammdaten path - the consumer
     * profile write goes through the same rules as the policy's snapshot).
     */
    public List<ConsumerFinding> validateControlProfile(JsonNode profile) {
        List<ConsumerFinding> out = new ArrayList<>();
        validateControlProfile(profile, "$", out);
        return out;
    }

    private void validateRequirement(JsonNode r, String path, Set<String> ids,
            List<ConsumerFinding> out) {
        if (r == null || !r.isObject()) {
            out.add(ConsumerFinding.error("schema", path, "Ungültige Regel."));
            return;
        }
        String id = r.path("id").asText("");
        if (!ID_PATTERN.matcher(id).matches()) {
            out.add(ConsumerFinding.error("schema", path + ".id", "Ungültige Regel-Kennung."));
        } else if (!ids.add(id)) {
            out.add(ConsumerFinding.error("duplicate_requirement_id", path + ".id",
                    "Zwei Regeln tragen dieselbe Kennung."));
        }

        String kind = r.path("kind").asText("");
        if (!KINDS.contains(kind)) {
            out.add(ConsumerFinding.error("invalid_kind", path + ".kind", "Unbekannte Regelart."));
            return;
        }
        String enforcement = r.path("enforcement").asText("");
        if (!ENFORCEMENTS.contains(enforcement)) {
            out.add(ConsumerFinding.error("invalid_enforcement", path + ".enforcement",
                    "Unbekannte Verbindlichkeit."));
            return;
        }

        validateTarget(r.get("target"), path + ".target", out);

        boolean hasCondition = r.has("condition");
        boolean hasDemand = r.has("demand");
        boolean hasRecurrence = r.has("recurrence");

        switch (kind) {
            case "reactive" -> {
                if (!hasCondition) {
                    out.add(ConsumerFinding.error("reactive_needs_condition", path + ".condition",
                            "Eine Sofort-Regel braucht eine Bedingung."));
                }
                if (hasDemand) {
                    out.add(ConsumerFinding.error("field_foreign_to_kind", path + ".demand",
                            "Eine Sofort-Regel hat keine Aufgabe mit Menge."));
                }
                if (!("must_run".equals(enforcement) || "opportunistic".equals(enforcement))) {
                    out.add(ConsumerFinding.error("enforcement_kind_mismatch", path + ".enforcement",
                            "Diese Verbindlichkeit passt nicht zur Sofort-Regel."));
                }
            }
            case "fixed_window" -> {
                if (!hasRecurrence) {
                    out.add(ConsumerFinding.error("fixed_window_needs_recurrence",
                            path + ".recurrence", "Eine Zeitregel braucht ein Zeitfenster."));
                }
                if (hasCondition || hasDemand) {
                    out.add(ConsumerFinding.error("field_foreign_to_kind", path,
                            "Eine Zeitregel trägt weder Bedingung noch Aufgabenmenge."));
                }
                if (!("must_run".equals(enforcement) || "opportunistic".equals(enforcement))) {
                    out.add(ConsumerFinding.error("enforcement_kind_mismatch", path + ".enforcement",
                            "Diese Verbindlichkeit passt nicht zur Zeitregel."));
                }
            }
            case "flexible_task" -> {
                if (!"required_by_deadline".equals(enforcement)) {
                    out.add(ConsumerFinding.error("enforcement_kind_mismatch", path + ".enforcement",
                            "Eine flexible Aufgabe ist bis zu einer Frist zu erledigen."));
                }
                if (hasCondition) {
                    out.add(ConsumerFinding.error("field_foreign_to_kind", path + ".condition",
                            "Eine flexible Aufgabe trägt keine Bedingung."));
                }
                if (!hasDemand) {
                    out.add(ConsumerFinding.error("flexible_needs_demand", path + ".demand",
                            "Eine flexible Aufgabe braucht eine Menge oder Laufzeit."));
                }
            }
            case "opportunistic" -> {
                if (!"opportunistic".equals(enforcement)) {
                    out.add(ConsumerFinding.error("enforcement_kind_mismatch", path + ".enforcement",
                            "Ein Gelegenheitsbetrieb hat keine Pflicht."));
                }
                if (hasDemand) {
                    out.add(ConsumerFinding.error("field_foreign_to_kind", path + ".demand",
                            "Ein Gelegenheitsbetrieb trägt keine Aufgabenmenge."));
                }
            }
            default -> { }
        }

        JsonNode grid = r.get("grid_energy_policy");
        if (grid != null && !grid.isNull()) {
            String policy = grid.asText("");
            if (!GRID_POLICIES.contains(policy)) {
                out.add(ConsumerFinding.error("schema", path + ".grid_energy_policy",
                        "Unbekannte Netzstrom-Einstellung."));
            } else if ("must_run".equals(enforcement) && !"allow".equals(policy)) {
                out.add(ConsumerFinding.error("must_run_grid_conflict", path + ".grid_energy_policy",
                        "Ein Pflichtlauf erlaubt Netzstrom automatisch und kann ihn nicht "
                                + "verbieten."));
            }
        }

        if (hasCondition) {
            validateCondition(r.get("condition"), path + ".condition", 1, new int[] {0}, out);
        }
        if (hasRecurrence) {
            validateRecurrence(r.get("recurrence"), path + ".recurrence", out);
        }
        if (hasDemand) {
            validateDemand(r.get("demand"), path + ".demand", out);
        }
    }

    private void validateTarget(JsonNode t, String path, List<ConsumerFinding> out) {
        if (t == null || !t.isObject()) {
            out.add(ConsumerFinding.error("schema", path, "Das Ziel fehlt."));
            return;
        }
        String kind = t.path("kind").asText("");
        if (!TARGET_KINDS.contains(kind)) {
            out.add(ConsumerFinding.error("schema", path + ".kind", "Unbekannte Zielart."));
            return;
        }
        JsonNode v = t.get("value");
        boolean ok = switch (kind) {
            case "on_off" -> v != null && v.isBoolean();
            case "percent" -> v != null && v.isNumber() && v.asDouble() >= 0 && v.asDouble() <= 100;
            case "kw" -> v != null && v.isNumber() && v.asDouble() >= 0;
            case "mode" -> v != null && v.isTextual() && !v.asText().isBlank();
            default -> false;
        };
        if (!ok) {
            out.add(ConsumerFinding.error("target_value_type", path + ".value",
                    "Der Zielwert passt nicht zur Zielart."));
        }
    }

    private void validateCondition(JsonNode c, String path, int depth, int[] nodeCount,
            List<ConsumerFinding> out) {
        if (c == null || !c.isObject()) {
            out.add(ConsumerFinding.error("schema", path, "Ungültige Bedingung."));
            return;
        }
        if (depth > MAX_TREE_DEPTH) {
            out.add(ConsumerFinding.error("condition_tree_too_deep", path,
                    "Die Bedingung ist zu tief verschachtelt."));
            return;
        }
        if (++nodeCount[0] > MAX_TREE_NODES) {
            out.add(ConsumerFinding.error("condition_tree_too_large", path,
                    "Die Bedingung hat zu viele Teile."));
            return;
        }
        if (c.has("any") || c.has("all")) {
            JsonNode group = c.has("any") ? c.get("any") : c.get("all");
            if (group == null || !group.isArray() || group.isEmpty()) {
                out.add(ConsumerFinding.error("schema", path, "Eine Gruppe braucht Bedingungen."));
                return;
            }
            for (int i = 0; i < group.size(); i++) {
                validateCondition(group.get(i), path + "[" + i + "]", depth + 1, nodeCount, out);
            }
            return;
        }
        if (c.has("not")) {
            validateCondition(c.get("not"), path + ".not", depth + 1, nodeCount, out);
            return;
        }
        // Leaf.
        String signal = c.path("signal").asText("");
        ConsumerSignalCatalog.Signal sig = signals.find(signal);
        if (sig == null) {
            out.add(ConsumerFinding.error("unknown_signal", path + ".signal",
                    "Dieses Signal kennt VoltPilot nicht."));
            return;
        }
        if (!OPERATORS.contains(c.path("operator").asText(""))) {
            out.add(ConsumerFinding.error("schema", path + ".operator", "Unbekannter Vergleich."));
        }
        JsonNode value = c.get("value");
        boolean valueOk = ConsumerSignalCatalog.VALUE_BOOLEAN.equals(sig.valueType())
                ? value != null && value.isBoolean()
                : value != null && value.isNumber();
        if (!valueOk) {
            out.add(ConsumerFinding.error("signal_value_type", path + ".value",
                    "Der Vergleichswert passt nicht zum Signal."));
        }
        boolean hasHysteresis = c.has("reset_value") || c.has("max_age_s");
        if (hasHysteresis && ConsumerSignalCatalog.CLASS_CLOUD.equals(sig.signalClass())) {
            out.add(ConsumerFinding.error("cloud_signal_hysteresis", path,
                    "Preis- und Zeitbedingungen werden vorausberechnet und brauchen keine "
                            + "Hysterese."));
        }
    }

    private void validateRecurrence(JsonNode rec, String path, List<ConsumerFinding> out) {
        if (rec == null || !rec.isObject()) {
            out.add(ConsumerFinding.error("schema", path, "Ungültiges Zeitfenster."));
            return;
        }
        if (!DAYS.contains(rec.path("days").asText(""))) {
            out.add(ConsumerFinding.error("schema", path + ".days", "Unbekannter Tagesbezug."));
        }
        String from = rec.path("from").asText("");
        String to = rec.path("to").asText("");
        boolean fromOk = TIME_PATTERN.matcher(from).matches();
        boolean toOk = TIME_PATTERN.matcher(to).matches() || "24:00".equals(to);
        if (!fromOk || !toOk) {
            out.add(ConsumerFinding.error("schema", path, "Ungültige Uhrzeit im Zeitfenster."));
            return;
        }
        // 24:00 normalises to the next day's 00:00; a zero-length window (from == to,
        // and not the full-day 00:00..24:00) is empty and rejected. from > to is a
        // legitimate overnight window.
        String normalizedTo = "24:00".equals(to) ? "24:00" : to;
        if (from.equals(normalizedTo)) {
            out.add(ConsumerFinding.error("recurrence_invalid_window", path,
                    "Anfang und Ende des Zeitfensters sind gleich."));
        }
    }

    private void validateDemand(JsonNode d, String path, List<ConsumerFinding> out) {
        if (d == null || !d.isObject()) {
            out.add(ConsumerFinding.error("schema", path, "Ungültige Aufgabe."));
            return;
        }
        boolean hasRuntime = d.has("runtime_minutes") && d.get("runtime_minutes").isNumber()
                && d.get("runtime_minutes").asDouble() > 0;
        boolean hasEnergy = d.has("energy_kwh") && d.get("energy_kwh").isNumber()
                && d.get("energy_kwh").asDouble() > 0;
        if (!hasRuntime && !hasEnergy) {
            out.add(ConsumerFinding.error("demand_empty", path,
                    "Eine Aufgabe braucht eine Laufzeit oder eine Energiemenge."));
        }
        if (d.path("contiguous").isBoolean() && !hasRuntime) {
            out.add(ConsumerFinding.error("contiguous_without_runtime", path + ".contiguous",
                    "Zusammenhängend/aufteilbar gilt nur für eine Laufzeitaufgabe."));
        }
    }

    private void validateControlProfile(JsonNode p, String path, List<ConsumerFinding> out) {
        if (p == null || !p.isObject()) {
            out.add(ConsumerFinding.error("schema", path, "Ungültiges Steuerprofil."));
            return;
        }
        String kind = p.path("control_kind").asText("");
        if (!CONTROL_KINDS.contains(kind)) {
            out.add(ConsumerFinding.error("schema", path + ".control_kind",
                    "Unbekannte Regelart."));
            return;
        }
        JsonNode ratedNode = p.get("rated_power_kw");
        if (ratedNode == null || !ratedNode.isNumber() || ratedNode.asDouble() <= 0) {
            out.add(ConsumerFinding.error("schema", path + ".rated_power_kw",
                    "Die Nennleistung muss größer als 0 sein."));
            return;
        }
        double rated = ratedNode.asDouble();

        boolean hasLevels = p.has("levels_kw");
        boolean hasRanges = p.has("power_ranges_kw");
        boolean hasContinuousFields = p.has("min_power_kw") || p.has("resolution_kw");

        switch (kind) {
            case "on_off" -> {
                if (hasContinuousFields || hasLevels) {
                    out.add(ConsumerFinding.error("profile_field_wrong_kind", path,
                            "Ein Ein/Aus-Verbraucher hat keine Stufen oder Leistungsgrenzen."));
                }
                if (hasRanges) {
                    out.add(ConsumerFinding.error("power_ranges_only_continuous",
                            path + ".power_ranges_kw",
                            "Leistungsbereiche gibt es nur bei stufenloser Regelung."));
                }
            }
            case "stepped" -> {
                if (hasContinuousFields) {
                    out.add(ConsumerFinding.error("profile_field_wrong_kind", path,
                            "Feste Stufen haben keine Mindestleistung oder Auflösung."));
                }
                if (hasRanges) {
                    out.add(ConsumerFinding.error("power_ranges_only_continuous",
                            path + ".power_ranges_kw",
                            "Leistungsbereiche gibt es nur bei stufenloser Regelung."));
                }
                validateLevels(p.get("levels_kw"), rated, path + ".levels_kw", out);
            }
            case "continuous" -> {
                if (hasLevels) {
                    out.add(ConsumerFinding.error("profile_field_wrong_kind", path + ".levels_kw",
                            "Stufenlose Regelung hat keine feste Stufenliste."));
                }
                if (hasRanges) {
                    validatePowerRanges(p.get("power_ranges_kw"), rated, path + ".power_ranges_kw",
                            out);
                }
            }
            default -> { }
        }
    }

    private void validateLevels(JsonNode levels, double rated, String path,
            List<ConsumerFinding> out) {
        if (levels == null || !levels.isArray() || levels.size() < 2) {
            out.add(ConsumerFinding.error("schema", path, "Es fehlen die Leistungsstufen."));
            return;
        }
        boolean hasZero = false;
        double prev = Double.NEGATIVE_INFINITY;
        for (JsonNode l : levels) {
            if (!l.isNumber()) {
                out.add(ConsumerFinding.error("schema", path, "Eine Stufe ist keine Zahl."));
                return;
            }
            double v = l.asDouble();
            if (v == 0.0) {
                hasZero = true;
            }
            if (v <= prev) {
                out.add(ConsumerFinding.error("levels_not_ascending", path,
                        "Die Leistungsstufen müssen streng aufsteigen."));
                return;
            }
            if (v > rated + 1e-9) {
                out.add(ConsumerFinding.error("levels_exceed_rated", path,
                        "Eine Stufe ist größer als die Nennleistung."));
                return;
            }
            prev = v;
        }
        if (!hasZero) {
            out.add(ConsumerFinding.error("levels_need_zero", path,
                    "Die Stufenliste muss die Stufe 0 (Aus) enthalten."));
        }
    }

    private void validatePowerRanges(JsonNode ranges, double rated, String path,
            List<ConsumerFinding> out) {
        if (ranges == null || !ranges.isArray() || ranges.isEmpty()) {
            out.add(ConsumerFinding.error("schema", path, "Ungültige Leistungsbereiche."));
            return;
        }
        double prevMax = Double.NEGATIVE_INFINITY;
        for (JsonNode range : ranges) {
            if (!range.isArray() || range.size() != 2
                    || !range.get(0).isNumber() || !range.get(1).isNumber()) {
                out.add(ConsumerFinding.error("schema", path,
                        "Ein Leistungsbereich braucht genau [min, max]."));
                return;
            }
            double min = range.get(0).asDouble();
            double max = range.get(1).asDouble();
            if (min < 0 || max <= min || min <= prevMax) {
                out.add(ConsumerFinding.error("power_ranges_not_ascending", path,
                        "Die Leistungsbereiche müssen aufsteigend und überschneidungsfrei sein."));
                return;
            }
            if (max > rated + 1e-9) {
                out.add(ConsumerFinding.error("power_ranges_exceed_rated", path,
                        "Ein Leistungsbereich ist größer als die Nennleistung."));
                return;
            }
            prevMax = max;
        }
    }
}
