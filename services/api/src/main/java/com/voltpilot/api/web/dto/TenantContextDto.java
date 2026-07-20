package com.voltpilot.api.web.dto;

import java.util.UUID;

/**
 * The caller's tenant context, echoed to the portal at login (the U0 bootstrap
 * read). {@code betriebsart} is the EFFECTIVE Kontotyp/Betriebsart frame
 * ('endkunde' | 'betreiber') - the explicit override when set, else derived
 * from the segment in the api's ONE authoritative place
 * ({@link com.voltpilot.api.tenant.Betriebsart}); the portal shell consumes it
 * as-is and never re-derives.
 */
public record TenantContextDto(UUID tenantId, String name, String segment, String betriebsart) {
}
