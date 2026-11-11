package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.Size;

/**
 * Platform-admin request to update a customer user's profile (name, email,
 * and - P3 - the username). {@code username} null or unchanged leaves the
 * login identity as it is; its character/length rule lives server-side
 * ({@code BenutzerService.anmeldenamePruefen}, N4), not as a bean validation
 * annotation, so the error message can name the actual rule.
 */
public record UpdateUserRequest(
        String username,
        @Email String email,
        @Size(max = 120) String firstName,
        @Size(max = 120) String lastName) {
}
