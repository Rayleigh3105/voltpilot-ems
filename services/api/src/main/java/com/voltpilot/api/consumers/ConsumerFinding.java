package com.voltpilot.api.consumers;

/**
 * One machine-readable finding of the {@link ConsumerPolicyValidator}: the stable
 * rule id (shared with the TS twin + the cross-language vectors), a severity, a
 * JSON path pointing at the offending element and the German customer-facing
 * message. {@code error} blocks activation/save; {@code warning} is advisory.
 * The {@code rule} codes are the contract between the two validators - see
 * docs/contracts/v2/consumer-policy-vectors.json.
 */
public record ConsumerFinding(String rule, String severity, String path, String message) {

    public static ConsumerFinding error(String rule, String path, String message) {
        return new ConsumerFinding(rule, "error", path, message);
    }

    public boolean isError() {
        return "error".equals(severity);
    }
}
