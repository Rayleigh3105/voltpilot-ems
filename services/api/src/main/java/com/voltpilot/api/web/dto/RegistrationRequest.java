package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Self-service registration: a new customer creates their own tenant + login in
 * one step. {@code name} is the person or company name and becomes the tenant's
 * display name; {@code email} doubles as the login username.
 */
public record RegistrationRequest(
        @NotBlank @Size(max = 200) String name,
        @NotBlank @Email @Size(max = 254) String email,
        @NotBlank @Size(min = 8, max = 128) String password) {
}
