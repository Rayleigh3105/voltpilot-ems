package com.voltpilot.api.web.dto;

import java.util.List;
import java.util.UUID;

/**
 * Result of a tenant offboarding: what the transactional database cascade
 * removed, plus the best-effort Keycloak cleanup. The database part is
 * all-or-nothing; Keycloak deletions that failed are reported by username in
 * {@code failedUsers} so the operator can retry the cleanup route (accounts remain disabled) - a partial
 * failure never silently disappears.
 */
public record TenantOffboardingReportDto(
        UUID tenantId,
        String tenantName,
        int deletedSites,
        int deletedDevices,
        long deletedTelemetryRows,
        List<String> deletedUsers,
        List<String> failedUsers) {
}
