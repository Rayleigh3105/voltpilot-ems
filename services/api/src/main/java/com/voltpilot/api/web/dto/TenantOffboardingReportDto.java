package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Result of a tenant offboarding: what the transactional database cascade
 * removed, plus the best-effort Keycloak cleanup. The database part is
 * all-or-nothing; Keycloak deletions that failed are reported by username in
 * {@code failedUsers} so the operator can retry the cleanup route (accounts remain disabled) - a partial
 * failure never silently disappears. {@code loeschnachweis} (UEMS AP-20 IP-18) is the deletion record written in
 * the same transaction - it stays after the tenant is gone.
 */
public record TenantOffboardingReportDto(
        UUID tenantId,
        String tenantName,
        int deletedSites,
        int deletedDevices,
        long deletedTelemetryRows,
        List<String> deletedUsers,
        List<String> failedUsers,
        Loeschnachweis loeschnachweis) {

    /** The row of {@code mandant_loeschnachweis}: no personal data of the customer, the tenant only by its id. */
    public record Loeschnachweis(String kennzeichen, Instant geloeschtAm, Map<String, Long> zaehlungen,
            Map<String, Long> verblieben, String abzugSha256) {
    }
}
