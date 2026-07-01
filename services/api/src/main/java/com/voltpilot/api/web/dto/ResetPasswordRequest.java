package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Support-driven password reset for a customer user. The platform has no SMTP
 * (and therefore no self-service reset), so this is the recovery path for a
 * customer who forgot their password.
 *
 * <p>{@code temporary} (default {@code true}) marks the password
 * must-change-on-next-login, so support can hand out a one-time password and
 * the customer immediately replaces it with their own. The length rule matches
 * self-registration.
 */
public record ResetPasswordRequest(
        @NotBlank @Size(min = 8, max = 128) String password,
        Boolean temporary) {

    public boolean temporaryOrDefault() {
        return temporary == null || temporary;
    }
}
