package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.UUID;

/** A tenant as seen by the platform-admin API. */
public record TenantDto(UUID id, String name, String segment, String plan, Instant createdAt) {
}
