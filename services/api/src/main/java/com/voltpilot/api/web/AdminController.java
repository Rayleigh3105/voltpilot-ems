package com.voltpilot.api.web;

import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakAdminException;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.web.dto.AdminUserDto;
import com.voltpilot.api.web.dto.CreateTenantRequest;
import com.voltpilot.api.web.dto.CreateUserRequest;
import com.voltpilot.api.web.dto.TenantDto;
import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Platform-admin API: manage tenants and customer users across the whole
 * platform. Every method is gated by {@code hasRole('platform-admin')}, so a
 * Portal-User (customer, {@code operator}) calling any of these gets HTTP 403 -
 * the backend, not the UI, is the boundary between operators and customers.
 *
 * <p>Tenants are read/written through the {@code voltpilot_admin} BYPASSRLS
 * datasource ({@link TenantRepository}); users are provisioned in Keycloak
 * ({@link KeycloakAdminClient}) with the {@code tenant_id} attribute + customer
 * role, so the existing OIDC + RLS spine isolates them exactly like the seeded
 * demo tenants. Customer data endpoints (sites/telemetry) stay RLS-scoped and
 * untouched.
 */
@RestController
@RequestMapping("/api/v1/admin")
@PreAuthorize("hasRole('platform-admin')")
public class AdminController {

    private final TenantRepository tenants;
    private final KeycloakAdminClient keycloak;

    public AdminController(TenantRepository tenants, KeycloakAdminClient keycloak) {
        this.tenants = tenants;
        this.keycloak = keycloak;
    }

    // ---- tenants -------------------------------------------------------------

    @GetMapping("/tenants")
    public List<TenantDto> listTenants() {
        return tenants.findAll();
    }

    @PostMapping("/tenants")
    public ResponseEntity<TenantDto> createTenant(@Valid @RequestBody CreateTenantRequest request) {
        TenantDto created = tenants.create(request.name(), request.segmentOrDefault());
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    // ---- customer users ------------------------------------------------------

    @GetMapping("/tenants/{tenantId}/users")
    public List<AdminUserDto> listUsers(@PathVariable UUID tenantId) {
        requireTenant(tenantId);
        try {
            return keycloak.listUsersForTenant(tenantId).stream().map(AdminController::toDto).toList();
        } catch (KeycloakAdminException ex) {
            throw toResponse(ex);
        }
    }

    @PostMapping("/tenants/{tenantId}/users")
    public ResponseEntity<AdminUserDto> createUser(@PathVariable UUID tenantId,
            @Valid @RequestBody CreateUserRequest request) {
        requireTenant(tenantId);
        try {
            KeycloakUser user = keycloak.createCustomerUser(tenantId, request.username(),
                    request.email(), request.firstName(), request.lastName(),
                    request.password(), request.temporaryPassword());
            return ResponseEntity.status(HttpStatus.CREATED).body(toDto(user));
        } catch (KeycloakAdminException ex) {
            throw toResponse(ex);
        }
    }

    @PostMapping("/tenants/{tenantId}/users/{userId}/disable")
    public AdminUserDto disableUser(@PathVariable UUID tenantId, @PathVariable String userId) {
        requireTenant(tenantId);
        try {
            return toDto(keycloak.setEnabled(userId, false));
        } catch (KeycloakAdminException ex) {
            throw toResponse(ex);
        }
    }

    // ---- helpers -------------------------------------------------------------

    private void requireTenant(UUID tenantId) {
        if (!tenants.existsById(tenantId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Tenant not found");
        }
    }

    private static AdminUserDto toDto(KeycloakUser u) {
        return new AdminUserDto(u.id(), u.username(), u.email(), u.firstName(), u.lastName(),
                u.enabled(), u.tenantId());
    }

    private static ResponseStatusException toResponse(KeycloakAdminException ex) {
        HttpStatusCode status = HttpStatusCode.valueOf(
                ex.status() >= 400 && ex.status() < 600 ? ex.status() : 502);
        return new ResponseStatusException(status, ex.getMessage());
    }
}
