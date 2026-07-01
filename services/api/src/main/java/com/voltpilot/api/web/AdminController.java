package com.voltpilot.api.web;

import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakAdminException;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
import com.voltpilot.api.repo.AdminProvisionedDeviceRepository;
import com.voltpilot.api.repo.AdminSiteRepository;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.web.dto.AdminUserDto;
import com.voltpilot.api.web.dto.CreateSiteRequest;
import com.voltpilot.api.web.dto.CreateTenantRequest;
import com.voltpilot.api.web.dto.CreateUserRequest;
import com.voltpilot.api.web.dto.ProvisionDeviceRequest;
import com.voltpilot.api.web.dto.ProvisionedDeviceDto;
import com.voltpilot.api.web.dto.ResetPasswordRequest;
import com.voltpilot.api.web.dto.SiteDto;
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
    private final AdminSiteRepository sites;
    private final AdminProvisionedDeviceRepository provisionedDevices;
    private final KeycloakAdminClient keycloak;

    public AdminController(TenantRepository tenants, AdminSiteRepository sites,
            AdminProvisionedDeviceRepository provisionedDevices, KeycloakAdminClient keycloak) {
        this.tenants = tenants;
        this.sites = sites;
        this.provisionedDevices = provisionedDevices;
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

    // ---- sites (cross-tenant) ------------------------------------------------

    @GetMapping("/tenants/{tenantId}/sites")
    public List<SiteDto> listSites(@PathVariable UUID tenantId) {
        requireTenant(tenantId);
        return sites.findByTenant(tenantId);
    }

    @PostMapping("/tenants/{tenantId}/sites")
    public ResponseEntity<SiteDto> createSite(@PathVariable UUID tenantId,
            @Valid @RequestBody CreateSiteRequest request) {
        requireTenant(tenantId);
        SiteDto created = sites.create(tenantId, request.name().trim(),
                request.biddingZoneOrDefault(), request.latitude(), request.longitude());
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    // ---- provisioned devices (manufacturing registry) -------------------------

    @GetMapping("/provisioned-devices")
    public List<ProvisionedDeviceDto> listProvisionedDevices() {
        return provisionedDevices.findAll();
    }

    /**
     * Register a manufactured sticker Geräte-ID so a customer can claim it.
     * Idempotent: re-registering (a re-run manufacturing batch) returns 200 with
     * the existing entry instead of an error.
     */
    @PostMapping("/provisioned-devices")
    public ResponseEntity<ProvisionedDeviceDto> provisionDevice(
            @Valid @RequestBody ProvisionDeviceRequest request) {
        String externalRef = DeviceController.canonicalExternalRef(request.externalRef());
        if (!externalRef.startsWith(DeviceController.STICKER_PREFIX)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Geräte-ID must use the sticker format (prefix "
                            + DeviceController.STICKER_PREFIX + ")");
        }
        String note = request.note() == null || request.note().isBlank()
                ? null : request.note().trim();
        return provisionedDevices.insertIfAbsent(externalRef, request.kindOrDefault(), note)
                .map(created -> ResponseEntity.status(HttpStatus.CREATED).body(created))
                .orElseGet(() -> ResponseEntity.ok(provisionedDevices.find(externalRef).orElseThrow()));
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
            requireUserInTenant(tenantId, userId);
            return toDto(keycloak.setEnabled(userId, false));
        } catch (KeycloakAdminException ex) {
            throw toResponse(ex);
        }
    }

    /**
     * Support-driven password reset: without SMTP there is no self-service
     * reset, so this is how a customer who forgot their password (or locked
     * themselves out guessing) gets back in. Sets the new password (temporary by
     * default: must change on next login) and lifts any brute-force lockout so
     * it works immediately.
     */
    @PostMapping("/tenants/{tenantId}/users/{userId}/reset-password")
    public AdminUserDto resetPassword(@PathVariable UUID tenantId, @PathVariable String userId,
            @Valid @RequestBody ResetPasswordRequest request) {
        requireTenant(tenantId);
        try {
            KeycloakUser user = requireUserInTenant(tenantId, userId);
            keycloak.resetPassword(userId, request.password(), request.temporaryOrDefault());
            return toDto(user);
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

    /**
     * A user addressed under a tenant path must actually carry that tenant -
     * a user reached through the wrong tenant's path is "not found", never
     * acted on.
     */
    private KeycloakUser requireUserInTenant(UUID tenantId, String userId) {
        KeycloakUser user = keycloak.getUser(userId);
        if (!tenantId.toString().equals(user.tenantId())) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found in this tenant");
        }
        return user;
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
