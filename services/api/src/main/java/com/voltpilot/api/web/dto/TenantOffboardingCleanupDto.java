package com.voltpilot.api.web.dto;

import java.util.List;
import java.util.UUID;

/** Repeatable directory cleanup after tenant removal; failures always leave disabled accounts. */
public record TenantOffboardingCleanupDto(UUID tenantId, List<String> deletedUsers, List<String> failedUsers) {}
