package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * A tenant as seen by the platform-admin API. {@code betriebsart} is the stored
 * explicit override (null = automatic); {@code betriebsartEffective} is the
 * resolved U0 shell frame - the override when set, else {@code null} = unknown
 * (the portal then derives the shell from the site count, see
 * {@link com.voltpilot.api.tenant.Betriebsart}).
 */
public record TenantDto(UUID id, String name, String segment, String plan, String betriebsart,
        String betriebsartEffective, Instant createdAt) {
}
