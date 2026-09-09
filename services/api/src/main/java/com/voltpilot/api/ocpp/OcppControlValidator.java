package com.voltpilot.api.ocpp;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Duration;
import java.time.Instant;
import java.util.HashSet;
import java.util.Set;
import org.springframework.stereotype.Component;

/** Mirrors internal/ocppcontrol; shared vectors pin both trust boundaries. */
@Component
public class OcppControlValidator {
    public void validate(JsonNode p) {
        check(p.isObject() && p.path("revision").isIntegralNumber() && p.path("revision").canConvertToLong() && p.path("revision").asLong() >= 1);
        fields(p, "revision", "enabled", "authorization", "electrical", "phase_limits_a", "limits", "test");
        check(!p.hasNonNull("enabled") || p.path("enabled").isBoolean());
        var auth = p.path("authorization");
        fields(auth, "mode", "allowed_tags");
        check(Set.of("free", "allowlist").contains(auth.path("mode").asText()));
        array(auth.path("allowed_tags"), 128);
        var tags = new HashSet<String>();
        for (var tag : auth.path("allowed_tags")) check(tag.isTextual() && tag.asText().matches("tagref_[0-9a-f]{24}") && tags.add(tag.asText()));
        var phaseLimits = p.path("phase_limits_a");
        array(phaseLimits, 3);
        check(phaseLimits.size() == 0 || phaseLimits.size() == 3);
        for (var amps : phaseLimits) number(amps, 0, 2000);
        var electrical = p.path("electrical");
        array(electrical, 2048);
        var targets = new HashSet<String>();
        for (var e : electrical) {
            fields(e, "charge_point_id", "connector_id", "voltage_v", "phases", "max_current_a");
            target(e); check(targets.add(key(e)));
            number(e.path("voltage_v"), 100, 300); number(e.path("max_current_a"), 1, 2000);
            var phases = e.path("phases"); array(phases, 3);
            check(!phases.isEmpty() && phaseLimits.size() == 3);
            var seen = new HashSet<Integer>();
            for (var phase : phases) check(phase.isIntegralNumber() && phase.asInt() >= 1 && phase.asInt() <= 3 && seen.add(phase.asInt()));
        }
        targets.clear();
        array(p.path("limits"), 2048);
        for (var l : p.path("limits")) {
            fields(l, "charge_point_id", "connector_id", "limit_kw", "requested_at", "expires_at");
            target(l); check(targets.add(key(l))); number(l.path("limit_kw"), 0, 1000);
            var start = instant(l.path("requested_at")); var end = instant(l.path("expires_at"));
            check(end.isAfter(start) && Duration.between(start, end).compareTo(Duration.ofHours(24)) <= 0);
        }
        if (p.hasNonNull("test")) {
            var t = p.path("test");
            fields(t, "charge_point_id", "connector_id", "limit_kw", "requested_at");
            target(t); number(t.path("limit_kw"), 0.1, 1000); instant(t.path("requested_at"));
        }
    }
    private static void target(JsonNode n) {
        check(n.path("charge_point_id").asText().matches("[A-Za-z0-9][A-Za-z0-9._-]{0,63}"));
        check(n.path("connector_id").isIntegralNumber() && n.path("connector_id").asInt() >= 1 && n.path("connector_id").asInt() <= 32);
    }
    private static String key(JsonNode n) { return n.path("charge_point_id").asText() + "#" + n.path("connector_id").asInt(); }
    private static void number(JsonNode n, double min, double max) { check(n.isNumber() && Double.isFinite(n.asDouble()) && n.asDouble() >= min && n.asDouble() <= max); }
    private static void array(JsonNode n, int max) { check(n.isMissingNode() || n.isNull() || (n.isArray() && n.size() <= max)); }
    private static Instant instant(JsonNode n) { try { check(n.isTextual()); return Instant.parse(n.asText()); } catch (RuntimeException e) { throw invalid(); } }
    private static void fields(JsonNode n, String... allowed) { check(n.isObject()); var keys = Set.of(allowed); n.fieldNames().forEachRemaining(k -> check(keys.contains(k))); }
    private static void check(boolean valid) { if (!valid) throw invalid(); }
    private static IllegalArgumentException invalid() { return new IllegalArgumentException("Ungültige OCPP-Steuerung: Freigabe, Phasen, Karten oder Zeitgrenzen prüfen"); }
}
