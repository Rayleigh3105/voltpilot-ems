package com.voltpilot.api.web.dto;

/** A customer (Portal-User) account as seen by the platform-admin API. */
public record AdminUserDto(String id, String username, String email, String firstName,
        String lastName, boolean enabled, String tenantId) {
}
