package com.voltpilot.api.probe;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/**
 * The device's answer to one probe, as the portal receives it (contract
 * {@code docs/contracts/mqtt-probe.schema.json}, {@code probe_result}).
 *
 * <p>Nothing here is stored - it is the reply to a question asked seconds ago.
 *
 * <p>The honesty rules the contract states are carried by the TYPES: {@code raw}
 * and {@code value} are boxed and {@code NON_NULL}, so a failed line simply has
 * no number rather than a 0 that reads like a measurement, and {@code raw} and
 * {@code value} always travel together - that pair is what makes a scaling
 * mistake visible at a glance.
 *
 * @param errorCode set only on a WHOLE-request refusal (the box was throttled);
 *     {@code results} is then empty and the reason is stated once.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ProbeResult(String requestId, String errorCode, String message,
        List<OpResult> results) {

    /**
     * One answered step. {@code registers} carries the raw 16-bit words so a
     * wrong word order is visible and not merely wrong.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record OpResult(String id, boolean ok, Double raw, List<Integer> registers,
            Double value, String errorCode, String message, Reading reading, Switched switched,
            Finding finding) {

        /** The register-read shape (no {@code reading}, no {@code switched}). */
        public OpResult(String id, boolean ok, Double raw, List<Integer> registers,
                Double value, String errorCode, String message) {
            this(id, ok, raw, registers, value, errorCode, message, null, null, null);
        }

        /** The connection-test shape. */
        public OpResult(String id, boolean ok, Double raw, List<Integer> registers,
                Double value, String errorCode, String message, Reading reading) {
            this(id, ok, raw, registers, value, errorCode, message, reading, null, null);
        }

        /** The connection-test shape with a plausibility finding. */
        public OpResult(String id, boolean ok, Double raw, List<Integer> registers,
                Double value, String errorCode, String message, Reading reading, Finding finding) {
            this(id, ok, raw, registers, value, errorCode, message, reading, null, finding);
        }

        /** The switch shape. */
        public OpResult(String id, boolean ok, Double raw, List<Integer> registers,
                Double value, String errorCode, String message, Reading reading,
                Switched switched) {
            this(id, ok, raw, registers, value, errorCode, message, reading, switched, null);
        }
    }

    /**
     * The outcome of a {@code switch_test} / {@code switch_cancel} op
     * (Einheitsmodell Stufe 4). Its OWN block, never {@code raw}/{@code value}:
     * those are reserved for a READING, and a write dressed up as a measurement
     * is the ambiguity false confirmations grow out of.
     *
     * <p>{@code readback}/{@code readbackMatches} travel together and are
     * boxed: a readback that was not performed is ABSENT, never a "does not
     * match".
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Switched(Integer written, Integer offAfterS, Integer readback,
            Boolean readbackMatches) {
    }

    /**
     * The decoded snapshot of a {@code test_connection} op (Einheitsmodell
     * Stufe 1) - the four channels the local test surfaces.
     *
     * <p>Every field is boxed and {@code NON_NULL}: a channel this device does
     * NOT report is ABSENT, never a 0 that reads like a measurement.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Reading(Double pvKw, Double loadKw, Double gridKw, Double socPct) {

        /** Whether the device reported anything at all. */
        public boolean any() {
            return pvKw != null || loadKw != null || gridKw != null || socPct != null;
        }
    }

    /**
     * WHICH channel of a {@code test_connection} read violated WHICH
     * plausibility rule (contract {@code op_result.finding}).
     *
     * <p>It exists so no surface has to search a German sentence for keywords -
     * the house rule that put {@code target_verdict} NEXT TO {@code state}. The
     * sentence belongs to the portal; the fact belongs here.
     *
     * <p>The rules are deliberately three, not one, because they demand
     * different actions: {@link #RULE_MISSING} is a demonstrably LIVE register
     * block whose channel reads an exact 0 - a battery whose BMS is not coupled
     * to the inverter, and the ONLY case an operator may knowingly run a plant
     * with. {@link #RULE_OUT_OF_RANGE} (a broken/shifted frame) and
     * {@link #RULE_NO_ANSWER} (the logger's all-zero empty answer) are evidence
     * that the READ is untrustworthy and may never be waved through.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Finding(String channel, String rule, Double raw, Double value) {

        public static final String CHANNEL_SOC = "soc_pct";
        public static final String RULE_MISSING = "missing";
        public static final String RULE_OUT_OF_RANGE = "out_of_range";
        public static final String RULE_NO_ANSWER = "no_answer";

        /**
         * Whether this finding describes a channel a plant may knowingly run
         * WITHOUT. Everything else - an unknown word included - is a no.
         */
        public boolean overridable() {
            return CHANNEL_SOC.equals(channel) && RULE_MISSING.equals(rule);
        }
    }
}
