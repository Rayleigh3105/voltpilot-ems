package com.voltpilot.api.web;

import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakAdminException;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
import com.voltpilot.api.provisioning.ProvisioningPublisher;
import com.voltpilot.api.repo.AdminEnrollmentRepository;
import com.voltpilot.api.repo.AdminProvisionedDeviceRepository;
import com.voltpilot.api.repo.AdminSiteRepository;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.repo.TenantRepository.OffboardCounts;
import com.voltpilot.api.repo.TenantRepository.TenantDevice;
import com.voltpilot.api.web.dto.AdminUserDto;
import com.voltpilot.api.web.dto.CreateSiteRequest;
import com.voltpilot.api.web.dto.CreateTenantRequest;
import com.voltpilot.api.web.dto.CreateUserRequest;
import com.voltpilot.api.web.dto.DeleteTenantRequest;
import com.voltpilot.api.web.dto.PendingEnrollmentDto;
import com.voltpilot.api.web.dto.ProvisionDeviceRequest;
import com.voltpilot.api.web.dto.ProvisionedDeviceDto;
import com.voltpilot.api.web.dto.ResetPasswordRequest;
import com.voltpilot.api.web.dto.SiteDto;
import com.voltpilot.api.web.dto.TenantDto;
import com.voltpilot.api.web.dto.TenantOffboardingReportDto;
import com.voltpilot.api.web.dto.UpdateTenantRequest;
import com.voltpilot.api.web.dto.UpdateUserRequest;
import jakarta.validation.Valid;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
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

    private static final Logger log = LoggerFactory.getLogger(AdminController.class);

    private final TenantRepository tenants;
    private final AdminSiteRepository sites;
    private final AdminProvisionedDeviceRepository provisionedDevices;
    private final AdminEnrollmentRepository enrollments;
    private final KeycloakAdminClient keycloak;
    private final ObjectProvider<ProvisioningPublisher> provisioning;

    public AdminController(TenantRepository tenants, AdminSiteRepository sites,
            AdminProvisionedDeviceRepository provisionedDevices,
            AdminEnrollmentRepository enrollments, KeycloakAdminClient keycloak,
            ObjectProvider<ProvisioningPublisher> provisioning) {
        this.tenants = tenants;
        this.sites = sites;
        this.provisionedDevices = provisionedDevices;
        this.enrollments = enrollments;
        this.keycloak = keycloak;
        this.provisioning = provisioning;
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

    /** Update a tenant's master data (name/segment). */
    @PutMapping("/tenants/{tenantId}")
    public TenantDto updateTenant(@PathVariable UUID tenantId,
            @Valid @RequestBody UpdateTenantRequest request) {
        TenantDto updated = tenants.update(tenantId, request.name().trim(),
                request.segmentOrDefault());
        if (updated == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Tenant not found");
        }
        return updated;
    }

    /**
     * Offboard a tenant - the most destructive action on the platform, so it is
     * type-to-confirm: the body must carry the tenant's EXACT name or nothing
     * happens (400). The database cascade (sites, devices, assets, all series
     * data, the tenant row) runs in ONE transaction; the tenant's retained MQTT
     * topics and Keycloak users are then cleaned best-effort, and every user
     * whose deletion failed is reported by name - a partial directory failure
     * is visible, never silent.
     */
    @PostMapping("/tenants/{tenantId}/delete")
    public TenantOffboardingReportDto deleteTenant(@PathVariable UUID tenantId,
            @Valid @RequestBody DeleteTenantRequest request) {
        TenantDto tenant = tenants.findById(tenantId);
        if (tenant == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Tenant not found");
        }
        if (!tenant.name().equals(request.confirmName().trim())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "confirmName does not match the tenant name");
        }

        // Collected BEFORE the cascade: afterwards the rows are gone.
        List<TenantDevice> devices = tenants.devicesOfTenant(tenantId);
        List<KeycloakUser> users;
        try {
            users = keycloak.listUsersForTenant(tenantId);
        } catch (KeycloakAdminException ex) {
            // Refuse rather than orphan logins we could not even enumerate.
            throw toResponse(ex);
        }

        OffboardCounts counts = tenants.offboard(tenantId);

        // Broker cleanup (best-effort): clear each device's retained
        // provisioning config + schedule so the hardware falls back to its
        // watchdog default and the refs become claimable again.
        provisioning.ifAvailable(p -> devices.forEach(d ->
                p.clearRetained(d.externalRef(), tenantId, d.siteId(), d.id())));

        List<String> deletedUsers = new ArrayList<>();
        List<String> failedUsers = new ArrayList<>();
        for (KeycloakUser user : users) {
            try {
                keycloak.deleteUser(user.id());
                deletedUsers.add(user.username());
            } catch (RuntimeException ex) {
                log.warn("Offboarding tenant {}: could not delete Keycloak user '{}': {}",
                        tenantId, user.username(), ex.getMessage());
                failedUsers.add(user.username());
            }
        }
        log.info("Offboarded tenant {} ('{}'): {} sites, {} devices, {} telemetry rows, "
                + "{} users deleted, {} user deletions failed", tenantId, tenant.name(),
                counts.sites(), counts.devices(), counts.telemetryRows(),
                deletedUsers.size(), failedUsers.size());
        return new TenantOffboardingReportDto(tenantId, tenant.name(), counts.sites(),
                counts.devices(), counts.telemetryRows(), deletedUsers, failedUsers);
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
                request.biddingZoneOrDefault(), request.latitude(), request.longitude(),
                request.plantKindOrDefault(), request.anzulegenderWertCtKwh(),
                request.tarifArtOrDefault(), request.tarifParamOrNull(), request.netzladenErlaubt(),
                request.maxFeedInKw());
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

    // ---- enrollments (enrolled-but-unclaimed devices) ------------------------

    /**
     * Enrolled-but-unclaimed devices: a device uploaded a CSR and is polling for
     * its certificate, but no matching {@code device} row exists (the ref was
     * never claimed, or was unclaimed after issuance). This is the operator's
     * window onto the mistyped-reference dead-end - a device that "did its part"
     * while the customer typed a different ref, otherwise invisible on both
     * sides. Read-only; the device-facing poll stays opaque (no enumeration).
     */
    @GetMapping("/enrollments/pending")
    public List<PendingEnrollmentDto> listPendingEnrollments() {
        return enrollments.findPending();
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

    /** Update a customer user's profile (email/name; the username is immutable). */
    @PutMapping("/tenants/{tenantId}/users/{userId}")
    public AdminUserDto updateUser(@PathVariable UUID tenantId, @PathVariable String userId,
            @Valid @RequestBody UpdateUserRequest request) {
        requireTenant(tenantId);
        try {
            requireUserInTenant(tenantId, userId);
            return toDto(keycloak.updateProfile(userId, request.email(),
                    request.firstName(), request.lastName()));
        } catch (KeycloakAdminException ex) {
            throw toResponse(ex);
        }
    }

    @PostMapping("/tenants/{tenantId}/users/{userId}/disable")
    public AdminUserDto disableUser(@PathVariable UUID tenantId, @PathVariable String userId,
            @AuthenticationPrincipal Jwt caller) {
        requireNotSelf(caller, userId, "deaktivieren");
        requireTenant(tenantId);
        try {
            requireUserInTenant(tenantId, userId);
            return toDto(keycloak.setEnabled(userId, false));
        } catch (KeycloakAdminException ex) {
            throw toResponse(ex);
        }
    }

    /** Re-enable a disabled user (the counterpart to disable). */
    @PostMapping("/tenants/{tenantId}/users/{userId}/enable")
    public AdminUserDto enableUser(@PathVariable UUID tenantId, @PathVariable String userId) {
        requireTenant(tenantId);
        try {
            requireUserInTenant(tenantId, userId);
            return toDto(keycloak.setEnabled(userId, true));
        } catch (KeycloakAdminException ex) {
            throw toResponse(ex);
        }
    }

    /** Permanently delete a customer user's login. */
    @DeleteMapping("/tenants/{tenantId}/users/{userId}")
    public ResponseEntity<Void> deleteUser(@PathVariable UUID tenantId,
            @PathVariable String userId, @AuthenticationPrincipal Jwt caller) {
        requireNotSelf(caller, userId, "löschen");
        requireTenant(tenantId);
        try {
            requireUserInTenant(tenantId, userId);
            keycloak.deleteUser(userId);
            return ResponseEntity.noContent().build();
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

    /**
     * Remove a wrongly registered sticker Geräte-ID from the manufacturing
     * registry. Refused (409) while a customer's claim references it - the
     * device must be unclaimed first, so the registry can never contradict a
     * live device.
     */
    @DeleteMapping("/provisioned-devices/{externalRef}")
    public ResponseEntity<Void> deleteProvisionedDevice(@PathVariable String externalRef) {
        String canonical = DeviceController.canonicalExternalRef(externalRef);
        ProvisionedDeviceDto entry = provisionedDevices.find(canonical)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Provisioned device not found"));
        if (entry.claimed()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Geräte-ID '" + canonical + "' is claimed by a customer - unclaim the device first");
        }
        provisionedDevices.delete(canonical);
        return ResponseEntity.noContent().build();
    }

    // ---- helpers -------------------------------------------------------------

    /**
     * An admin must never disable or delete their OWN account - the platform
     * would lose its operator. Compared against the token's {@code sub} BEFORE
     * any tenant check, so the guard also fires when the admin addresses
     * themselves through an arbitrary tenant path.
     */
    private static void requireNotSelf(Jwt caller, String userId, String verb) {
        if (caller != null && userId.equals(caller.getSubject())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Sie können Ihr eigenes Konto nicht " + verb + ".");
        }
    }

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
        // Safe to pass through: KeycloakAdminException messages are FIXED
        // strings by contract - raw upstream Keycloak bodies stay in the
        // KeycloakAdminClient server log, never in the exception message.
        return new ResponseStatusException(status, ex.getMessage());
    }
}
