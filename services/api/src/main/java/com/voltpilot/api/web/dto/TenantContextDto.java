package com.voltpilot.api.web.dto;

import java.util.UUID;

/**
 * The caller's tenant context, echoed to the portal at login (the U0 bootstrap
 * read). {@code betriebsart} is the EFFECTIVE Kontotyp/Betriebsart frame
 * ('endkunde' | 'betreiber' | null = unknown) - the explicit override when set,
 * resolved in the api's ONE authoritative place
 * ({@link com.voltpilot.api.tenant.Betriebsart}); the portal shell consumes it
 * as-is and never re-derives, falling back to the site-count heuristic on null.
 */
public record TenantContextDto(UUID tenantId, String name, String segment, String betriebsart) {
}
