package com.voltpilot.api.web.dto;

import java.util.UUID;

/** Result of a successful self-registration: the new tenant and the login name. */
public record RegistrationResponse(UUID tenantId, String tenantName, String username) {
}
