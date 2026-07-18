package com.voltpilot.api.flows;

import java.util.List;

/**
 * One machine-readable validator finding (flow-graph contract §4: "the
 * validator's output is part of the editor UX contract"): the V-rule id, the
 * offending node/edge ids (so the editor highlights them), and the German
 * customer-facing message. severity 'error' blocks activation; 'warning' is
 * advisory (draft saves keep all findings advisory per contract §5).
 */
public record FlowValidationFinding(String rule, String severity, List<String> nodeIds,
        List<String> edgeIds, String message) {

    public static FlowValidationFinding error(String rule, List<String> nodeIds,
            List<String> edgeIds, String message) {
        return new FlowValidationFinding(rule, "error", nodeIds, edgeIds, message);
    }

    public static FlowValidationFinding warning(String rule, List<String> nodeIds,
            List<String> edgeIds, String message) {
        return new FlowValidationFinding(rule, "warning", nodeIds, edgeIds, message);
    }

    public boolean isError() {
        return "error".equals(severity);
    }
}
