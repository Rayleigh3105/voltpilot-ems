package com.voltpilot.api.entities;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import java.math.BigDecimal;
import org.junit.jupiter.api.Test;

/**
 * The registry-push {@code flex_requirements} compose (Verbrauchssteuerung
 * Inkrement 6, D-20; pure, docker-free): ONLY active required_by_deadline
 * flexible tasks are pushed, the run power + D-14 command are resolved HERE
 * (the one cloud truth), and every unresolvable entry is refused - never
 * guessed. Price-conditioned/reactive/opportunistic requirements never reach
 * the edge fallback (§13.5: a price rule without a window is unknown and
 * stays off).
 */
class EntityRegistryFlexTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static JsonNode doc(String requirements) {
        try {
            return MAPPER.readTree("""
                    {
                      "schema_version": "1.0",
                      "entity_id": "pump-01",
                      "timezone": "Europe/Berlin",
                      "requirements": [%s]
                    }
                    """.formatted(requirements));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static final String PUMP = """
            { "id": "pump-daily-hour", "kind": "flexible_task",
              "enforcement": "required_by_deadline",
              "recurrence": { "days": "daily", "from": "00:00", "to": "24:00" },
              "demand": { "runtime_minutes": 60, "contiguous": true },
              "target": { "kind": "on_off", "value": true } }
            """;

    @Test
    void theDeadlineDutyIsComposedWithResolvedPowerAndCommand() {
        ArrayNode out = EntityRegistryService.flexRequirementsFor(
                doc(PUMP), new BigDecimal("2.2"), MAPPER);
        assertThat(out).isNotNull();
        assertThat(out).hasSize(1);
        JsonNode e = out.get(0);
        assertThat(e.path("id").asText()).isEqualTo("pump-daily-hour");
        assertThat(e.path("timezone").asText()).isEqualTo("Europe/Berlin");
        assertThat(e.path("days").asText()).isEqualTo("daily");
        assertThat(e.path("from").asText()).isEqualTo("00:00");
        assertThat(e.path("to").asText()).isEqualTo("24:00");
        assertThat(e.path("runtime_minutes").asInt()).isEqualTo(60);
        assertThat(e.path("contiguous").asBoolean()).isTrue();
        // on_off target: the run power IS the profile's rated power.
        assertThat(e.path("power_kw").asDouble()).isEqualTo(2.2);
        assertThat(e.path("command").asText()).isEqualTo("on_off");
        assertThat(e.has("energy_kwh")).isFalse();
    }

    @Test
    void percentAndKwTargetsResolveToSetpointCommands() {
        String pct = """
                { "id": "wb-daily", "kind": "flexible_task",
                  "enforcement": "required_by_deadline",
                  "recurrence": { "days": "weekdays", "from": "22:00", "to": "06:30" },
                  "demand": { "energy_kwh": 8 },
                  "target": { "kind": "percent", "value": 50 } }
                """;
        ArrayNode out = EntityRegistryService.flexRequirementsFor(
                doc(pct), new BigDecimal("11"), MAPPER);
        assertThat(out).isNotNull();
        JsonNode e = out.get(0);
        assertThat(e.path("power_kw").asDouble()).isEqualTo(5.5);
        assertThat(e.path("command").asText()).isEqualTo("setpoint_kw");
        assertThat(e.path("energy_kwh").asDouble()).isEqualTo(8.0);

        String kw = """
                { "id": "wb-kw", "kind": "flexible_task",
                  "enforcement": "required_by_deadline",
                  "recurrence": { "days": "daily", "from": "00:00", "to": "06:00" },
                  "demand": { "energy_kwh": 8 },
                  "target": { "kind": "kw", "value": 4.2 } }
                """;
        // A kw target carries its own power - NO rated power needed.
        out = EntityRegistryService.flexRequirementsFor(doc(kw), null, MAPPER);
        assertThat(out).isNotNull();
        assertThat(out.get(0).path("power_kw").asDouble()).isEqualTo(4.2);
    }

    @Test
    void onlyDeadlineDutiesArePushedNeverOtherKinds() {
        String reactive = """
                { "id": "r1", "kind": "reactive", "enforcement": "must_run",
                  "condition": { "signal": "consumer.vehicle_connected",
                    "operator": "eq", "value": 1, "max_age_s": 20 },
                  "target": { "kind": "on_off", "value": true } }
                """;
        String priceRule = """
                { "id": "p1", "kind": "reactive", "enforcement": "must_run",
                  "condition": { "signal": "market.spot_price_ct_kwh",
                    "operator": "lt", "value": 5 },
                  "target": { "kind": "on_off", "value": true } }
                """;
        String fixedWindow = """
                { "id": "f1", "kind": "fixed_window", "enforcement": "must_run",
                  "recurrence": { "days": "daily", "from": "13:00", "to": "14:00" },
                  "target": { "kind": "on_off", "value": true } }
                """;
        String opportunistic = """
                { "id": "o1", "kind": "opportunistic", "enforcement": "opportunistic",
                  "recurrence": { "days": "daily", "from": "00:00", "to": "24:00" },
                  "demand": { "runtime_minutes": 30 },
                  "target": { "kind": "on_off", "value": true } }
                """;
        ArrayNode out = EntityRegistryService.flexRequirementsFor(
                doc(String.join(",", reactive, priceRule, fixedWindow, opportunistic, PUMP)),
                new BigDecimal("2.2"), MAPPER);
        assertThat(out).isNotNull();
        assertThat(out).hasSize(1);
        assertThat(out.get(0).path("id").asText()).isEqualTo("pump-daily-hour");
    }

    @Test
    void unresolvableEntriesAreRefusedNeverGuessed() {
        // Inactive requirement.
        String inactive = PUMP.replace("\"kind\": \"flexible_task\"",
                "\"active\": false, \"kind\": \"flexible_task\"");
        assertThat(EntityRegistryService.flexRequirementsFor(
                doc(inactive), new BigDecimal("2.2"), MAPPER)).isNull();
        // No demand.
        String noDemand = """
                { "id": "x", "kind": "flexible_task", "enforcement": "required_by_deadline",
                  "recurrence": { "days": "daily", "from": "00:00", "to": "24:00" },
                  "target": { "kind": "on_off", "value": true } }
                """;
        assertThat(EntityRegistryService.flexRequirementsFor(
                doc(noDemand), new BigDecimal("2.2"), MAPPER)).isNull();
        // on_off target without a rated power: no resolvable run power.
        assertThat(EntityRegistryService.flexRequirementsFor(doc(PUMP), null, MAPPER)).isNull();
        // A mode target is not power-quantifiable.
        String mode = PUMP.replace("{ \"kind\": \"on_off\", \"value\": true }",
                "{ \"kind\": \"mode\", \"value\": \"eco\" }");
        assertThat(EntityRegistryService.flexRequirementsFor(
                doc(mode), new BigDecimal("2.2"), MAPPER)).isNull();
        // An OFF target is never a duty to run.
        String off = PUMP.replace("\"value\": true }", "\"value\": false }");
        assertThat(EntityRegistryService.flexRequirementsFor(
                doc(off), new BigDecimal("2.2"), MAPPER)).isNull();
        // Garbage documents compose nothing.
        assertThat(EntityRegistryService.flexRequirementsFor(null, null, MAPPER)).isNull();
    }
}
