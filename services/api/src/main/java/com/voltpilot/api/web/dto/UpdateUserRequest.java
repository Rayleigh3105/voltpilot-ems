package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.Size;

/**
 * Platform-admin request to update a customer user's profile (email/name).
 * The username is the login identity and stays immutable, like a device's
 * external_ref.
 */
public record UpdateUserRequest(
        @Email String email,
        @Size(max = 120) String firstName,
        @Size(max = 120) String lastName) {
}
