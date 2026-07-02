package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.NotBlank;

/**
 * Confirmation body for tenant offboarding - the most destructive action on
 * the platform. The caller must type the tenant's exact name; a mismatch is
 * refused before anything is touched (fat-finger protection for an operation
 * that deletes sites, devices, all series data and the Keycloak logins).
 */
public record DeleteTenantRequest(@NotBlank String confirmName) {
}
