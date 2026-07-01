package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;

/**
 * Request to provision a customer user (Portal-User) into a tenant.
 *
 * <p>If {@code password} is given it is set directly; {@code temporaryPassword}
 * (default false) marks it must-change-on-first-login for an invite-style flow.
 * If no password is given the account is created disabled-for-login until an
 * admin sets one - the create path stays valid either way.
 */
public record CreateUserRequest(
        @NotBlank String username,
        @Email String email,
        String firstName,
        String lastName,
        String password,
        boolean temporaryPassword) {
}
